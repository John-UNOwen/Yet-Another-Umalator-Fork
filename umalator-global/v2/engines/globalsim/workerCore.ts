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
 *     ← {type:'prepared', id, setupKey, ok, error?, dead?, prepareMs, held, multi}
 *     dead:true means the wasm handle/instance may be poisoned (engine panic)
 *     and the pool should recreate the worker. prepareMs times the
 *     PreparedRace construction itself (the engine-side prepare the §H
 *     prepare-share acceptance measures). `held` is the worker's current
 *     preparation LRU (MRU first): the pool mirrors it for key-affine
 *     scheduling instead of assuming a single preparation per worker.
 *     `multi` says this backend answers a whole multi-preparation chunk in
 *     one call (the gpu group lane), so the pool may pack compatible queued
 *     setups together.
 *     A failed prepare touches NO other entry (only the re-prepared key is
 *     dropped, since replacing an entry frees its old handle first).
 *
 *   → {type:'run', jobId, setupKey?, seeds:number[], mode:'compact'|'full'}
 *     setupKey picks which held preparation runs the job; a worker holds up
 *     to PREPARED_LRU of them (§H). Omitted (legacy/manual callers): the most
 *     recently prepared race answers. A key the worker does not hold is a
 *     chunk failure — the pool mirrors `held` and never sends one.
 *     parts:[{setupKey, request, seeds, trackSkillId?, secondPlayerIndex?,
 *       distance?}] is the multi-preparation form the pool packs when the gpu
 *       lane reports `multi` (see below): one addon call answers every part in
 *       group order, or the worker runs the parts one by one on a lane without
 *       the group entry. The reply stays ONE chunk message, so the pool splits
 *       it back to the original jobs positionally.
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
	/**
	 * Gated compact run: the handle prepared the gate-0 field (position k rides
	 * gate k, player at index 0), so `gate` picks the field this seed rides.
	 * Byte-identical to run_compact from a preparation built for that gate.
	 * Absent on older pkg builds and on the gpu lane.
	 */
	run_compact_gated?(seed: number, gate: number, trackSkillId: string, secondPlayerIndex: number, distance: number): string;
	/**
	 * Batch compact lane (sim-server gpu backend): one facade call runs the whole
	 * seed chunk. Returns a JSON array of the same records run_compact returns, in
	 * seed order (refused seeds as {seed, gpuFallback}). Absent elsewhere, the
	 * worker keeps the per-seed loop.
	 */
	run_compact_batch?(seeds: number[], trackSkillId: string, secondPlayerIndex: number, distance: number): string;
	/**
	 * Multi-request compact lane (sim-server gpu backend): one call runs several
	 * prepared requests' seed chunks in one launch. The payload is
	 * {requests, groups} as sim-server's gpuRunCompactGroups reads it, and the
	 * answer is a JSON array of the same records run_compact_batch returns, in
	 * group order. Absent elsewhere, the worker runs a multi chunk per part.
	 */
	run_compact_groups?(payload: string): string;
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
	/** Register the session skill table once. Optional: a backend without it
	 *  keeps the table in every request. */
	setSkillTable?(jsonText: string): void;
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
/**
 * One setup's slice of a multi-preparation run message. The pool packs queued
 * chunks of compatible setup keys into one call, and every part carries its own
 * request text and fold options so the worker can name each group exactly.
 */
export interface RunPart {
	setupKey: string;
	request: unknown;
	seeds: number[];
	/** Per-seed gate for a gate-batched build (seed i rides gates[i]). */
	gates?: number[];
	trackSkillId?: string;
	secondPlayerIndex?: number;
	distance?: number;
}
export interface RunMsg {
	type: 'run'; jobId: string; setupKey?: string; seeds: number[]; mode: 'compact' | 'full'; parts?: RunPart[];
	/** Per-seed gate for a gate-batched build. The setup's request is the
	 *  gate-0 field, so one preparation serves every gate. */
	gates?: number[];
	/** A pipelined job: prepare this setup inline, then run it, one reply in total. */
	request?: Record<string, unknown>; trackSkillId?: string; secondPlayerIndex?: number; distance?: number;
}
/** Open the engine once so the session's first job pays no device or module
 *  load. The gpu backend's loader opens the device here. */
export interface WarmMsg { type: 'warm' }

export type WorkerInMsg = PrepareMsg | RunMsg | SkillDataMsg | WarmMsg;

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
	// Handlers await the wasm load and the geometry fetch, so messages run one at
	// a time in arrival order: a run that prepares inline cannot interleave.
	let tail: Promise<void> = Promise.resolve();
	let heldSkillData: unknown = null;
	// True once the engine holds the table per session (the gpu lane): requests
	// then omit skillData, so a packed part carries its own fields only.
	let engineHoldsSkill = false;

	/** Hand the table to an engine that holds one per session, if it can. */
	function installHeldTable(w: WasmApi | null): void {
		if (!w || heldSkillData == null) return;
		const setTable = w.setSkillTable;
		if (typeof setTable !== 'function') return;
		try {
			// The engine keeps it in the worker's thread-local table and answers
			// requests that omit skillData from it.
			setTable.call(w, JSON.stringify(heldSkillData));
			engineHoldsSkill = true;
		} catch { engineHoldsSkill = false; }
	}

	async function ensureWasm(): Promise<WasmApi> {
		if (wasm) return wasm;
		if (!wasmLoading) {
			wasmLoading = deps.loadWasm().then(w => { wasm = w; installHeldTable(w); return w; },
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
		// -1 is the engine's "no second player" value, so negative reads as absent.
		if (secondPlayerIndex != null && secondPlayerIndex >= 0) {
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
		// -1 is the engine's "no second player" value, so negative reads as absent.
		if (secondPlayerIndex != null && secondPlayerIndex >= 0) {
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
		const r = await prepareSetup(m);
		if (r.ok) {
			// pipelined: this core answers a cold `run` carrying its request in
			// one message, so the pool may skip the separate prepare round trip.
			deps.postMessage({ type: 'prepared', id: m.id, setupKey: m.setupKey, ok: true, prepareMs: r.prepareMs, held: heldKeys(), multi: typeof r.prep.race.run_compact_groups === 'function', pipelined: true });
		} else {
			deps.postMessage({ type: 'prepared', id: m.id, setupKey: m.setupKey, ok: false, error: r.error, dead: r.dead, held: heldKeys() });
		}
	}

	/** Prepare one setup into the LRU. Prepared request work lives here so a
	 *  combined run can prepare inline and still report the held keys. */
	async function prepareSetup(m: { setupKey: string; request: Record<string, unknown>; trackSkillId?: string; secondPlayerIndex?: number; distance?: number }): Promise<{ ok: true; prep: HeldPrep; prepareMs: number } | { ok: false; error: string; dead: boolean }> {
		try {
			const w = await ensureWasm();
			const courseId = Number((m.request as any).courseId);
			if (!Number.isFinite(courseId)) throw new Error('prepare request has no numeric courseId');
			await ensureGeometry(w, courseId);
			// skillData-omitting requests get the table this worker was given
			// once (adapter config.skillData === null path).
			const requestObj = m.request as Record<string, unknown>;
			const requestFinal = heldSkillData != null && !engineHoldsSkill && requestObj && requestObj.skillData == null
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
			const prep: HeldPrep = { setupKey: m.setupKey, race, canCompact: typeof race.run_compact === 'function', trackSkillId: m.trackSkillId, secondPlayerIndex: m.secondPlayerIndex, distance: m.distance };
			prepared.set(m.setupKey, prep);
			// Bound memory: evict the least-recently-used preparations.
			while (prepared.size > PREPARED_LRU) {
				const oldestKey = prepared.keys().next().value as string;
				freePrep(prepared.get(oldestKey)!);
				prepared.delete(oldestKey);
			}
			return { ok: true, prep, prepareMs };
		} catch (e: any) {
			const msg = String(e && e.message || e);
			return { ok: false, error: msg, dead: isDeadlyError(msg) };
		}
	}

	/**
	 * One preparation's seeds into `records`. `compact` is the caller's decision
	 * (mode compact and the handle answers run_compact). Returns a deadly
	 * (handle-poisoning) error text, else null with the records pushed.
	 */
	/** Load the engine and report how long the session paid for it. The pool
	 *  uses the figure as a cold lane's startup cost. */
	async function handleWarm(): Promise<void> {
		const t0 = nowMs();
		try {
			await ensureWasm();
			deps.postMessage({ type: 'warm', ok: true, openMs: nowMs() - t0 });
		} catch (e: any) {
			deps.postMessage({ type: 'warm', ok: false, error: String(e && e.message || e) });
		}
	}

	function runOneChunk(race: PreparedRaceInstance, seeds: number[], full: boolean, compact: boolean, trackSkillId: string, secondPlayerIndex: number, distance: number, records: any[], gates?: number[]): string | null {
		// Gated arm: one gate-0 preparation runs every seed at its own gate. The
		// per-seed call is the only shape the wrapper exposes, so the batch seam
		// below is skipped. A missing entry fails the chunk loudly: the gate-0
		// field would answer for a gate the caller did not ask to race.
		if (gates) {
			if (!compact || secondPlayerIndex >= 0 || typeof race.run_compact_gated !== 'function') {
				for (const seed of seeds) records.push({ seed, error: 'gated run needs the gated compact entry and no second player' });
				return null;
			}
			for (let i = 0; i < seeds.length; i++) {
				const seed = seeds[i];
				if (!(seed >= -2147483648 && seed <= 2147483647)) {
					records.push({ seed, error: 'gated run seed outside the signed 32-bit range' });
					continue;
				}
				let text: string;
				try {
					text = race.run_compact_gated(seed, gates[i], trackSkillId, secondPlayerIndex, distance);
				} catch (e: any) {
					const msg = String(e && e.message || e);
					if (isDeadlyError(msg)) return msg;
					records.push({ seed, error: msg });
					continue;
				}
				let rec: any;
				try { rec = JSON.parse(text); } catch (e: any) {
					records.push({ seed, error: `reply parse failed: ${String(e && e.message || e)}` });
					continue;
				}
				records.push(rec && typeof rec === 'object' ? rec : { seed, error: 'compact reply not an object' });
			}
			return null;
		}
		// Batch seam: a backend that answers the whole compact chunk in one call (gpu's
		// gpuRunCompactBatch) replaces the per-seed loop when every seed is i32-range.
		// A non-deadly throw or malformed answer falls through to the per-seed loop.
		if (compact && seeds.length > 0 && typeof race.run_compact_batch === 'function'
			&& seeds.every((seed) => seed >= -2147483648 && seed <= 2147483647)) {
			let text: string | null = null;
			try {
				text = race.run_compact_batch(seeds, trackSkillId, secondPlayerIndex, distance);
			} catch (e: any) {
				const msg = String(e && e.message || e);
				if (isDeadlyError(msg)) return msg;
			}
			if (text != null) {
				let recs: unknown;
				try { recs = JSON.parse(text); } catch { recs = null; }
				if (Array.isArray(recs) && recs.length === seeds.length && recs.every((r) => r && typeof r === 'object')) {
					records.push(...(recs as any[]));
					return null;
				}
			}
		}
		for (let i = 0; i < seeds.length; i++) {
			const seed = seeds[i];
			if (compact && seed >= -2147483648 && seed <= 2147483647) {
				let text: string;
				try {
					text = race.run_compact!(seed, trackSkillId, secondPlayerIndex, distance);
				} catch (e: any) {
					const msg = String(e && e.message || e);
					if (isDeadlyError(msg)) return msg;
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
				text = race.run(seed);
			} catch (e: any) {
				const msg = String(e && e.message || e);
				if (isDeadlyError(msg)) return msg;
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
			records.push(full ? extractFull(reply, seed, secondPlayerIndex) : extractCompact(reply, seed, trackSkillId, secondPlayerIndex, distance));
		}
		return null;
	}

	/** The multi lane's payload: request texts deduped by content, one group per part. */
	function multiPayload(parts: RunPart[]): string {
		const requests: string[] = [];
		const requestIndex = new Map<string, number>();
		const textByKey = new Map<string, string>();
		const groups = parts.map((part) => {
			let text = textByKey.get(part.setupKey);
			if (text === undefined) {
				const requestObj = part.request as Record<string, unknown>;
				const requestFinal = heldSkillData != null && !engineHoldsSkill && requestObj && requestObj.skillData == null
					? { ...requestObj, skillData: heldSkillData }
					: requestObj;
				text = JSON.stringify(requestFinal);
				textByKey.set(part.setupKey, text);
			}
			let r = requestIndex.get(text);
			if (r === undefined) { requests.push(text); r = requests.length - 1; requestIndex.set(text, r); }
			return {
				r,
				seeds: part.seeds,
				trackSkillId: part.trackSkillId ?? '',
				secondPlayerIndex: part.secondPlayerIndex ?? -1,
				distance: part.distance ?? 0,
			};
		});
		return JSON.stringify({ requests, groups });
	}

	async function handleRun(m: RunMsg): Promise<void> {
		// setupKey picks the held preparation; without one (manual/legacy
		// callers) the most recently prepared race answers.
		const newest = prepared.size ? Array.from(prepared.keys()).pop()! : null;
		let prep = m.setupKey != null ? prepared.get(m.setupKey) ?? null : (newest != null ? prepared.get(newest) ?? null : null);
		let inlineMs: number | null = null;
		// A pipelined job carries its request, so a cold setup prepares here and
		// one chunk reply answers both round trips.
		if ((!prep || (m.setupKey != null && !prepared.has(m.setupKey))) && m.request != null && m.setupKey != null) {
			const made = await prepareSetup({ setupKey: m.setupKey, request: m.request, trackSkillId: m.trackSkillId, secondPlayerIndex: m.secondPlayerIndex, distance: m.distance });
			if (!made.ok) {
				deps.postMessage({ type: 'chunk', jobId: m.jobId, mode: m.mode, ok: false, dead: made.dead, error: `prepare failed: ${made.error}`, held: heldKeys(), processed: 0, records: [] });
				return;
			}
			prep = made.prep;
			inlineMs = made.prepareMs;
		}
		if (!prep || (m.setupKey != null && !prepared.has(m.setupKey))) {
			deps.postMessage({ type: 'chunk', jobId: m.jobId, mode: m.mode, ok: false, dead: false, error: `no preparation for job ${m.jobId}` });
			return;
		}
		// Run touch: the used preparation becomes the most-recently-used one.
		if (m.setupKey != null) { prepared.delete(m.setupKey); prepared.set(m.setupKey, prep); }
		const records: (SeedCompactRecord | FullRunData)[] = [];
		const t0 = nowMs();
		const full = m.mode === 'full';
		const parts = m.parts && m.parts.length > 1 ? m.parts : null;
		if (parts) {
			// Multi-request seam: one call answers every part from one launch.
			const total = parts.reduce((n, part) => n + part.seeds.length, 0);
			const allI32 = parts.every((part) => part.seeds.every((seed) => seed >= -2147483648 && seed <= 2147483647));
			const groupsCall = prep.race.run_compact_groups;
			if (m.mode === 'compact' && allI32 && typeof groupsCall === 'function' && !parts.some((part) => part.gates != null)) {
				try {
					const text = groupsCall.call(prep.race, multiPayload(parts));
					let recs: unknown;
					try { recs = JSON.parse(text); } catch { recs = null; }
					if (Array.isArray(recs) && recs.length === total && recs.every((r) => r && typeof r === 'object')) {
						deps.postMessage({ type: 'chunk', jobId: m.jobId, mode: m.mode, ok: true, records: recs, runMs: nowMs() - t0 });
						return;
					}
				} catch (e: any) {
					const msg = String(e && e.message || e);
					if (isDeadlyError(msg)) {
						prepared.delete(prep.setupKey);
						deps.postMessage({ type: 'chunk', jobId: m.jobId, mode: m.mode, ok: false, dead: true, error: msg, processed: 0, records });
						return;
					}
					// Non-deadly: run the parts one by one below, which is also
					// what a lane without the group entry does.
				}
			}
			for (const part of parts) {
				const held = prepared.get(part.setupKey) ?? null;
				let transient: PreparedRaceInstance | null = null;
				if (held == null) {
					const w = wasm;
					if (!w) {
						records.push(...part.seeds.map((seed) => ({ seed, error: 'multi chunk without a wasm module' })));
						continue;
					}
					try {
						const requestObj = part.request as Record<string, unknown>;
						const requestFinal = heldSkillData != null && !engineHoldsSkill && requestObj && requestObj.skillData == null
							? { ...requestObj, skillData: heldSkillData }
							: requestObj;
						transient = new w.PreparedRace(JSON.stringify(requestFinal));
					} catch (e: any) {
						records.push(...part.seeds.map((seed) => ({ seed, error: String(e && e.message || e) })));
						continue;
					}
				}
				const race = held ? held.race : transient!;
				const compact = m.mode === 'compact' && (held ? held.canCompact : typeof race.run_compact === 'function');
				const dead = runOneChunk(
					race,
					part.seeds,
					full,
					compact,
					part.trackSkillId ?? '',
					part.secondPlayerIndex ?? -1,
					part.distance ?? 0,
					records,
					part.gates,
				);
				if (transient) { try { transient.free(); } catch { /* already gone */ } }
				if (dead) {
					if (held) prepared.delete(held.setupKey);
					deps.postMessage({ type: 'chunk', jobId: m.jobId, mode: m.mode, ok: false, dead: true, error: dead, processed: records.length, records });
					return;
				}
			}
			deps.postMessage({ type: 'chunk', jobId: m.jobId, mode: m.mode, ok: true, records, runMs: nowMs() - t0 });
			return;
		}
		const compact = m.mode === 'compact' && prep.canCompact;
		const dead = runOneChunk(
			prep.race,
			m.seeds,
			full,
			compact,
			prep.trackSkillId ?? '',
			prep.secondPlayerIndex ?? -1,
			prep.distance ?? 0,
			records,
					m.gates,
		);
		if (dead) {
			prepared.delete(prep.setupKey);
			deps.postMessage({ type: 'chunk', jobId: m.jobId, mode: m.mode, ok: false, dead: true, error: dead, processed: records.length, records });
			return;
		}
		deps.postMessage({
			type: 'chunk', jobId: m.jobId, mode: m.mode, ok: true, records, runMs: nowMs() - t0,
			// Inline preparation metadata: the pool mirrors the worker's LRU from it.
			...(inlineMs != null ? { prepareMs: inlineMs, held: heldKeys(), multi: typeof prep.race.run_compact_groups === 'function' } : {}),
		});
	}

	return {
		/** Entry point: wire the host's message events into this. */
		onMessage(msg: WorkerInMsg): void {
			if (!msg || typeof msg !== 'object') return;
			if (msg.type === 'skillData') { heldSkillData = (msg as SkillDataMsg).skillData; installHeldTable(wasm); return; }
			if (msg.type === 'prepare') tail = tail.then(() => handlePrepare(msg as PrepareMsg)).catch(() => { /* handler reports */ });
			else if (msg.type === 'run') tail = tail.then(() => handleRun(msg as RunMsg)).catch(() => { /* handler reports */ });
			else if (msg.type === 'warm') tail = tail.then(() => handleWarm()).catch(() => { /* handler reports */ });
		},
		/** Test/host hook: the most-recently-used held preparation (affinity assertions). */
		get preparedKey(): string | null { return prepared.size ? Array.from(prepared.keys()).pop()! : null; },
		/** Test/host hook: every held setupKey, most-recently-used first. */
		get heldKeys(): string[] { return heldKeys(); },
	};
}
