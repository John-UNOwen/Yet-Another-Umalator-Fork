/**
 * GlobalSim Web Worker core (Phase 4).
 *
 * The message-handling logic of globalsim.worker.ts, extracted as an
 * environment-agnostic factory so that:
 *   - globalsim.worker.ts stays a thin Web Worker entry (self wiring + wasm
 *     fetch from the deployed /uma-tools/globalsim/wasm/ path), and
 *   - node tests can drive the REAL worker logic against the REAL wasm pkg by
 *     injecting a postMessage sink plus a disk-backed loadWasm/fetchText
 *     (globalsim-wasm/pkg/ works in node — see compare.acceptance.test.ts).
 *
 * ## Message protocol (main ⇄ worker)
 *
 *   → {type:'skillData', skillData}                     (once per worker,
 *     first message; injected into prepare requests that omit skillData)
 *
 *   → {type:'prepare', id, setupKey, request, trackSkillId?}
 *     request = the full GlobalSim race request from adapter.ts (profile +
 *     9 runners; the seed field is a placeholder — PreparedRace.run overrides
 *     it per seed). trackSkillId (Phase 5 chart): count the player's
 *     activations of that one skill in each compact record.
 *     secondPlayerIndex (head-to-head compare): also extract that runner's
 *     finish data (+ frames in full mode) into the record's `opp` field.
 *     ← {type:'prepared', id, setupKey, ok, error?, dead?, prepareMs, held}
 *     dead:true means the wasm handle/instance may be poisoned (engine panic)
 *     and the pool should recreate the worker. prepareMs times the
 *     PreparedRace construction itself (the engine-side prepare the §H
 *     prepare-share acceptance measures). `held` is the worker's current
 *     preparation LRU (MRU first): the pool mirrors it for key-affine
 *     scheduling instead of assuming a single preparation per worker.
 *     A failed prepare touches NO other entry (only the re-prepared key is
 *     dropped, since replacing an entry frees its old handle first).
 *
 *   → {type:'run', jobId, setupKey?, seeds:number[], mode:'compact'|'full'}
 *     setupKey picks which held preparation runs the job; a worker holds up
 *     to PREPARED_LRU of them (§H). Omitted (legacy/manual callers): the most
 *     recently prepared race answers. A key the worker does not hold is a
 *     chunk failure — the pool mirrors `held` and never sends one.
 *     compact: per-seed SeedCompactRecord (finish metadata + the tail sample
 *       grid; frames dropped). On newer pkg builds wasm run_compact()
 *       computes this engine-side and never serializes frames at all; the
 *       JS extractCompact + metrics.samplePlayerTail path stays as fallback
 *       for older pkg — both must stay in lockstep (parity-tested).
 *     full: per-seed FullRunData (player frame arrays + skill events) for the
 *       representative runs.
 *     ← {type:'chunk', jobId, mode, ok:true, records:[...], runMs}
 *       runMs times the whole per-seed loop (engine run + reply parse), the
 *       denominator of the §H prepare-share ratio.
 *       A per-seed engine error is a record with {seed, error} — the chunk
 *       (and the handle) survive. An engine PANIC kills the handle:
 *     ← {type:'chunk', jobId, mode, ok:false, dead:true, error, processed}
 *       The pool then terminates + recreates the worker and requeues the
 *       in-flight chunk exactly once.
 *
 * Course geometry: the WORKER fetches it itself from
 * `${geometryBase}${courseId}.json` (default '/uma-tools/globalsim/wasm/…'
 * sibling 'globalsim/geometry/') once per course per worker and registers it
 * with register_geometry; the main thread never ships 275 KB payloads per
 * worker. Fetch failures surface as prepare errors (→ job error), which is
 * also what keeps an unknown course from reaching the engine (panic risk:
 * get_course aborts on unknown ids — INTERFACE.md).
 */

import { SeedCompactRecord, FullRunData, samplePlayerTail, spurtPlanPoint } from './metrics';
import { BASE_PATH } from '../../../../components/base-path';

/** One live wasm preparation handle (globalsim-wasm/src/lib.rs PreparedRace). */
export interface PreparedRaceInstance {
	run(seed: number): string;
	/** Compact-mode run (newer pkg): returns the extractCompact record JSON
	 *  directly — frames never serialize. Absent on older pkg builds; the
	 *  worker then falls back to run() + JS extractCompact. */
	run_compact?(seed: number, trackSkillId: string, secondPlayerIndex: number, distance: number): string;
	free(): void;
}

/**
 * §H: a worker keeps a small LRU of prepared races (setupKey → handle)
 * instead of one. A setup's prepare costs 4.5–12.8 ms (globalsim-wasm
 * README) against ~7–9 ms per seed, so re-preparing between the small
 * per-gate seed blocks of a search batch is pure loss; an LRU turns the
 * second and later rungs of a build into pure run time. The cap bounds
 * memory: one held PreparedRace measured ≈1.1 MB of wasm heap (real 351 KB
 * request), so a full LRU is ≈11 MB per worker.
 *
 * 10 = one build's whole gate set plus one: with the gate on "auto" a build
 * fans out over up to FIELD_SIZE = 9 gates (mobs.ts), and at 8 no worker could
 * hold them all, so key affinity missed on every gate switch and the short
 * rounds re-prepared ~3× as often.
 */
export const PREPARED_LRU = 10;

/** The wasm-bindgen surface globalsim-wasm/src/lib.rs exposes. */
export interface WasmApi {
	register_geometry(courseId: number, jsonText: string): void;
	PreparedRace: new (requestJson: string) => PreparedRaceInstance;
}

export interface WorkerCoreDeps {
	/** Sink for every worker → main message (worker: self.postMessage). */
	postMessage(msg: unknown): void;
	/** Load the wasm module (once per worker; cached by the core). */
	loadWasm(): Promise<WasmApi>;
	/** Fetch a text asset (worker: fetch; node test: fs.readFile). */
	fetchText(url: string): Promise<string>;
	/** Base URL for /globalsim/geometry/ files (worker: '/uma-tools/globalsim/geometry/'). */
	geometryBase?: string;
}

export interface PrepareMsg {
	type: 'prepare';
	id: string;
	setupKey: string;
	request: unknown;
	/**
	 * Optional (Phase 5 chart): count the PLAYER's activations of this one
	 * skill in every compact record of the preparation (skillEvents are in
	 * the engine reply; counting a single id keeps the compact payload small).
	 */
	trackSkillId?: string;
	/**
	 * Optional (head-to-head layout): post-sort index of the SECOND player in
	 * the same race. The compact/full records then carry that runner's finish
	 * data (and frames, in full mode) under `opp`.
	 */
	secondPlayerIndex?: number;
	/**
	 * Optional: the course length in metres. Compact records then carry the
	 * player's position and HP on the tick the engine plans the last spurt
	 * (spurtPlanPoint), which compare uses to judge the full spurt. The h2h
	 * opp block has no skill activations to judge with, so it gets none.
	 */
	distance?: number;
}
/**
 * One-time engine skillData injection (sent by the pool right after worker
 * creation): the merged active skill table. handlePrepare injects it into
 * requests that omit skillData (adapter config.skillData === null), so big
 * charts never re-ship the ~350 KB table per preparation.
 */
export interface SkillDataMsg { type: 'skillData'; skillData: unknown }
export interface RunMsg { type: 'run'; jobId: string; setupKey?: string; seeds: number[]; mode: 'compact' | 'full' }
export type WorkerInMsg = PrepareMsg | RunMsg | SkillDataMsg;

/** True for errors that poison the wasm handle/instance (panic, dead handle). */
export function isDeadlyError(text: string): boolean {
	return text.startsWith('engine panic') || text.startsWith('handle is dead');
}

interface HeldPrep {
	setupKey: string;
	race: PreparedRaceInstance;
	canCompact: boolean;
	trackSkillId?: string;
	secondPlayerIndex?: number;
	distance?: number;
}

/** ms since (monotonic where the host gives it, else wall clock). */
const nowMs = (): number => (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();

export function createGlobalsimWorkerCore(deps: WorkerCoreDeps) {
	const geometryBase = deps.geometryBase ?? `${BASE_PATH}/globalsim/geometry/`;
	let wasm: WasmApi | null = null;
	let wasmLoading: Promise<WasmApi> | null = null;
	const geometryRegistered = new Set<number>();
	// §H: the preparation LRU — Map insertion order IS the LRU order (oldest
	// first; a run touch deletes + re-inserts to mark most-recently-used).
	const prepared = new Map<string, HeldPrep>();
	let heldSkillData: unknown = null;

	async function ensureWasm(): Promise<WasmApi> {
		if (wasm) return wasm;
		if (!wasmLoading) {
			wasmLoading = deps.loadWasm().then(w => { wasm = w; return w; },
				e => { wasmLoading = null; throw e; });
		}
		return wasmLoading;
	}

	async function ensureGeometry(w: WasmApi, courseId: number): Promise<void> {
		if (geometryRegistered.has(courseId)) return;
		const text = await deps.fetchText(`${geometryBase}${courseId}.json`);
		w.register_geometry(courseId, text);
		geometryRegistered.add(courseId);
	}

	function extractCompact(reply: any, seed: number, trackSkillId?: string, secondPlayerIndex?: number, distance?: number): SeedCompactRecord {
		const pi = reply.playerHorseIndex as number;
		const res = reply.results && reply.results[pi];
		if (!res || typeof res.finishTimeRaw !== 'number') {
			return { seed, error: 'reply has no player finishTimeRaw' };
		}
		const frames = Array.isArray(reply.frames) ? reply.frames : null;
		const tail = frames ? samplePlayerTail(frames, pi, res.finishTimeRaw) : null;
		const rec: SeedCompactRecord = {
			seed,
			finishTimeRaw: res.finishTimeRaw,
			finishOrder: res.finishOrder,
			hpEmptyOnRace: res.hpEmptyOnRace ?? null,
			rushingStartCount: res.rushingStartCount ?? 0,
			rushingPenaltyCount: res.rushingPenaltyCount ?? 0,
			lastSpurtStartDistance: res.lastSpurtStartDistance ?? null,
			startDelayTime: res.startDelayTime ?? 0,
			tail: tail && tail.length ? tail : null,
		};
		const plan = frames ? spurtPlanPoint(frames, pi, distance) : null;
		if (plan) {
			rec.spurtPlanPos = plan.pos; rec.spurtPlanHp = plan.hp;
			if (plan.heals.length) { rec.spurtHeals = plan.heals; rec.spurtMaxHp = plan.maxHp; }
		}
		// Lead-margin proxy field (metrics.leadMarginL; optimizer screening):
		// rival = every field runner except the player. Key presence must match
		// wasm run_compact exactly (compact-parity pins the two paths).
		if (Array.isArray(reply.results)) {
			let bestRival: number | undefined;
			for (let i = 0; i < reply.results.length; i++) {
				if (i === pi) continue;
				const t = reply.results[i] && reply.results[i].finishTimeRaw;
				if (typeof t === 'number' && Number.isFinite(t) && (bestRival === undefined || t < bestRival)) bestRival = t;
			}
			if (bestRival !== undefined) rec.bestRivalFinishTimeRaw = bestRival;
		}
		// Head-to-head layout: the other player's finish metadata + own tail
		// from the SAME race (pairMargin needs the loser's tail whichever
		// player loses). A missing second player errors only this seed.
		if (secondPlayerIndex != null) {
			const res2 = reply.results && reply.results[secondPlayerIndex];
			if (!res2 || typeof res2.finishTimeRaw !== 'number') {
				return { seed, error: 'reply has no second player finishTimeRaw' };
			}
			rec.opp = {
				finishTimeRaw: res2.finishTimeRaw,
				finishOrder: res2.finishOrder,
				hpEmptyOnRace: res2.hpEmptyOnRace ?? null,
				rushingStartCount: res2.rushingStartCount ?? 0,
				rushingPenaltyCount: res2.rushingPenaltyCount ?? 0,
				lastSpurtStartDistance: res2.lastSpurtStartDistance ?? null,
				startDelayTime: res2.startDelayTime ?? 0,
				tail: frames ? samplePlayerTail(frames, secondPlayerIndex, res2.finishTimeRaw) : null,
			};
			if (!rec.opp.tail?.length) rec.opp.tail = null;
		}
		// §E per-skill activation counts for the player runner, folded by the
		// optimizer cache into a per-build activation report (activation rates
		// from the races already run). Counted from the reply's skillEvents
		// (player runner only), for every skill id it sees.
		if (Array.isArray(reply.skillEvents)) {
			const bySkill: Record<string, number> = {};
			for (const ev of reply.skillEvents) {
				if (!ev || ev.horseIndex !== pi) continue;
				const raw = ev.skillId ?? ev.id;
				if (raw == null) continue;
				const k = String(raw);
				bySkill[k] = (bySkill[k] ?? 0) + 1;
			}
			rec.skillActivations = bySkill;
		}
		// Phase 5 chart: the worker-side activation count of the ONE tracked
		// skill (player runner only). Numeric + string skillIds both match —
		// write_json emits numeric ids, tests may feed strings.
		if (trackSkillId && Array.isArray(reply.skillEvents)) {
			let n = 0;
			for (const ev of reply.skillEvents) {
				if (ev && ev.horseIndex === pi && String(ev.skillId ?? ev.id) === trackSkillId) n++;
			}
			rec.activations = n;
		}
		return rec;
	}

	/** Player frames truncated at the first frame whose t ≥ finishTimeRaw (classic arrays end at the finish). */
	function extractFull(reply: any, seed: number, secondPlayerIndex?: number): FullRunData {
		const pi = reply.playerHorseIndex as number;
		const res = reply.results && reply.results[pi];
		if (!res || typeof res.finishTimeRaw !== 'number') {
			return { seed, error: 'reply has no player finishTimeRaw' };
		}
		const frames = Array.isArray(reply.frames) ? reply.frames : [];
		const half = (idx: number, finish: number) => {
			const t: number[] = [], pos: number[] = [], speed: number[] = [], hp: number[] = [];
			for (let i = 0; i < frames.length; i++) {
				const h = frames[i].horses && frames[i].horses[idx];
				if (!h) break;
				t.push(frames[i].t); pos.push(h.pos); speed.push(h.speed); hp.push(h.hp);
				if (frames[i].t >= finish) break;
			}
			return { t, pos, speed, hp };
		};
		const own = half(pi, res.finishTimeRaw);
		const skillEvents = (Array.isArray(reply.skillEvents) ? reply.skillEvents : [])
			.filter((e: any) => e.horseIndex === pi && typeof e.skillId === 'number')
			.map((e: any) => ({ skillId: String(e.skillId), t: e.t, duration: e.duration }));
		const rec: FullRunData = {
			seed,
			finishTimeRaw: res.finishTimeRaw,
			finishOrder: res.finishOrder,
			hpEmptyOnRace: res.hpEmptyOnRace ?? null,
			startDelayTime: res.startDelayTime ?? 0,
			...own,
			skillEvents,
		};
		if (secondPlayerIndex != null) {
			const res2 = reply.results && reply.results[secondPlayerIndex];
			if (!res2 || typeof res2.finishTimeRaw !== 'number') {
				return { seed, error: 'reply has no second player finishTimeRaw' };
			}
			rec.opp = {
				finishTimeRaw: res2.finishTimeRaw,
				finishOrder: res2.finishOrder,
				hpEmptyOnRace: res2.hpEmptyOnRace ?? null,
				startDelayTime: res2.startDelayTime ?? 0,
				...half(secondPlayerIndex, res2.finishTimeRaw),
				skillEvents: (Array.isArray(reply.skillEvents) ? reply.skillEvents : [])
					.filter((e: any) => e.horseIndex === secondPlayerIndex && typeof e.skillId === 'number')
					.map((e: any) => ({ skillId: String(e.skillId), t: e.t, duration: e.duration })),
			};
		}
		return rec;
	}

	/** Held keys, most-recently-used first (what the pool mirrors). */
	const heldKeys = (): string[] => Array.from(prepared.keys()).reverse();

	function freePrep(p: HeldPrep): void {
		try { p.race.free(); } catch { /* already dead */ }
	}

	async function handlePrepare(m: PrepareMsg): Promise<void> {
		try {
			const w = await ensureWasm();
			const courseId = Number((m.request as any).courseId);
			if (!Number.isFinite(courseId)) throw new Error('prepare request has no numeric courseId');
			await ensureGeometry(w, courseId);
			// skillData-omitting requests get the table this worker was given
			// once (adapter config.skillData === null path).
			const requestObj = m.request as Record<string, unknown>;
			const requestFinal = heldSkillData != null && requestObj && requestObj.skillData == null
				? { ...requestObj, skillData: heldSkillData }
				: requestObj;
			const json = JSON.stringify(requestFinal);
			// §H: a re-prepare of a held key replaces that entry (old handle
			// freed first, one entry's worth of memory at a time); the other
			// entries survive, and a failed prepare does not touch them.
			const stale = prepared.get(m.setupKey);
			if (stale) { freePrep(stale); prepared.delete(m.setupKey); }
			const t0 = nowMs();
			const race = new w.PreparedRace(json);
			const prepareMs = nowMs() - t0;
			prepared.set(m.setupKey, { setupKey: m.setupKey, race, canCompact: typeof race.run_compact === 'function', trackSkillId: m.trackSkillId, secondPlayerIndex: m.secondPlayerIndex, distance: m.distance });
			// Bound memory: evict the least-recently-used preparations.
			while (prepared.size > PREPARED_LRU) {
				const oldestKey = prepared.keys().next().value as string;
				freePrep(prepared.get(oldestKey)!);
				prepared.delete(oldestKey);
			}
			deps.postMessage({ type: 'prepared', id: m.id, setupKey: m.setupKey, ok: true, prepareMs, held: heldKeys() });
		} catch (e: any) {
			const msg = String(e && e.message || e);
			// A panic during construction may have poisoned the wasm instance.
			deps.postMessage({ type: 'prepared', id: m.id, setupKey: m.setupKey, ok: false, error: msg, dead: isDeadlyError(msg), held: heldKeys() });
		}
	}

	function handleRun(m: RunMsg): void {
		// setupKey picks the held preparation; without one (manual/legacy
		// callers) the most recently prepared race answers.
		const newest = prepared.size ? Array.from(prepared.keys()).pop()! : null;
		const prep = m.setupKey != null ? prepared.get(m.setupKey) ?? null : (newest != null ? prepared.get(newest) ?? null : null);
		if (!prep || (m.setupKey != null && !prepared.has(m.setupKey))) {
			deps.postMessage({ type: 'chunk', jobId: m.jobId, mode: m.mode, ok: false, dead: false, error: `no preparation for job ${m.jobId}` });
			return;
		}
		// Run touch: the used preparation becomes the most-recently-used one.
		if (m.setupKey != null) { prepared.delete(m.setupKey); prepared.set(m.setupKey, prep); }
		const records: (SeedCompactRecord | FullRunData)[] = [];
		/** Deadly (handle-poisoning) error: report the chunk as a worker failure. */
		const deadly = (msg: string, i: number): void => {
			prepared.delete(prep.setupKey);
			deps.postMessage({ type: 'chunk', jobId: m.jobId, mode: m.mode, ok: false, dead: true, error: msg, processed: i, records });
		};
		const t0 = nowMs();
		// wasm run_compact (newer pkg): the compact record comes back from the
		// engine directly (~1 KB/seed instead of ~2 MB of frames parsed here).
		// i32-range seeds only: beyond that wasm-bindgen's i32 coercion would
		// change the seed echoed in the record, so those seeds keep the old path.
		const useCompact = m.mode === 'compact' && prep.canCompact;
		for (let i = 0; i < m.seeds.length; i++) {
			const seed = m.seeds[i];
			if (useCompact && seed >= -2147483648 && seed <= 2147483647) {
				let text: string;
				try {
					text = prep.race.run_compact!(seed, prep.trackSkillId ?? '', prep.secondPlayerIndex ?? -1, prep.distance ?? 0);
				} catch (e: any) {
					const msg = String(e && e.message || e);
					if (isDeadlyError(msg)) { deadly(msg, i); return; }
					records.push({ seed, error: msg });
					continue;
				}
				let rec: any;
				try { rec = JSON.parse(text); } catch (e: any) {
					records.push({ seed, error: `reply parse failed: ${String(e && e.message || e)}` });
					continue;
				}
				// run_compact already produced the SeedCompactRecord (its own
				// {seed, error} shape included) — pass it through untouched.
				records.push(rec && typeof rec === 'object' ? rec : { seed, error: 'compact reply not an object' });
				continue;
			}
			let text: string;
			try {
				text = prep.race.run(seed);
			} catch (e: any) {
				const msg = String(e && e.message || e);
				if (isDeadlyError(msg)) { deadly(msg, i); return; }
				// Recoverable engine error for THIS seed only — keep the chunk going.
				records.push({ seed, error: msg });
				continue;
			}
			// The seed_sampling contract also encodes some failures as an
			// {"error":...} reply body — treat those as per-seed errors too.
			if (typeof text === 'string' && text.startsWith('{"error"')) {
				let err = 'engine error reply';
				try { err = JSON.parse(text).error || err; } catch { /* keep generic */ }
				records.push({ seed, error: err });
				continue;
			}
			let reply: any;
			try {
				reply = JSON.parse(text);
			} catch (e: any) {
				records.push({ seed, error: `reply parse failed: ${String(e && e.message || e)}` });
				continue;
			}
			records.push(m.mode === 'full' ? extractFull(reply, seed, prep.secondPlayerIndex) : extractCompact(reply, seed, prep.trackSkillId, prep.secondPlayerIndex, prep.distance));
		}
		deps.postMessage({ type: 'chunk', jobId: m.jobId, mode: m.mode, ok: true, records, runMs: nowMs() - t0 });
	}

	return {
		/** Entry point: wire the host's message events into this. */
		onMessage(msg: WorkerInMsg): void {
			if (!msg || typeof msg !== 'object') return;
			if (msg.type === 'skillData') { heldSkillData = (msg as SkillDataMsg).skillData; return; }
			if (msg.type === 'prepare') void handlePrepare(msg as PrepareMsg);
			else if (msg.type === 'run') handleRun(msg as RunMsg);
		},
		/** Test/host hook: the most-recently-used held preparation (affinity assertions). */
		get preparedKey(): string | null { return prepared.size ? Array.from(prepared.keys()).pop()! : null; },
		/** Test/host hook: every held setupKey, most-recently-used first. */
		get heldKeys(): string[] { return heldKeys(); },
	};
}
