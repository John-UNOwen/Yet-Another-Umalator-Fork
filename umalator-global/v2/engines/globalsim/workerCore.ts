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
 *     ← {type:'prepared', id, setupKey, ok, error?, dead?}
 *     dead:true means the wasm handle/instance may be poisoned (engine panic)
 *     and the pool should recreate the worker.
 *
 *   → {type:'run', jobId, seeds:number[], mode:'compact'|'full'}
 *     compact: per-seed SeedCompactRecord (finish metadata + the tail sample
 *       grid from metrics.samplePlayerTail; frames dropped) — small payload.
 *     full: per-seed FullRunData (player frame arrays + skill events) for the
 *       representative runs.
 *     ← {type:'chunk', jobId, mode, ok:true, records:[...]}
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

import { SeedCompactRecord, FullRunData, samplePlayerTail } from './metrics';

/** One live wasm preparation handle (globalsim-wasm/src/lib.rs PreparedRace). */
export interface PreparedRaceInstance { run(seed: number): string; free(): void }

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
}
/**
 * One-time engine skillData injection (sent by the pool right after worker
 * creation): the merged active skill table. handlePrepare injects it into
 * requests that omit skillData (adapter config.skillData === null), so big
 * charts never re-ship the ~350 KB table per preparation.
 */
export interface SkillDataMsg { type: 'skillData'; skillData: unknown }
export interface RunMsg { type: 'run'; jobId: string; seeds: number[]; mode: 'compact' | 'full' }
export type WorkerInMsg = PrepareMsg | RunMsg | SkillDataMsg;

/** True for errors that poison the wasm handle/instance (panic, dead handle). */
export function isDeadlyError(text: string): boolean {
	return text.startsWith('engine panic') || text.startsWith('handle is dead');
}

export function createGlobalsimWorkerCore(deps: WorkerCoreDeps) {
	const geometryBase = deps.geometryBase ?? '/uma-tools/globalsim/geometry/';
	let wasm: WasmApi | null = null;
	let wasmLoading: Promise<WasmApi> | null = null;
	const geometryRegistered = new Set<number>();
	let prepared: { setupKey: string; race: PreparedRaceInstance; trackSkillId?: string } | null = null;
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

	function extractCompact(reply: any, seed: number, trackSkillId?: string): SeedCompactRecord {
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
	function extractFull(reply: any, seed: number): FullRunData {
		const pi = reply.playerHorseIndex as number;
		const res = reply.results && reply.results[pi];
		if (!res || typeof res.finishTimeRaw !== 'number') {
			return { seed, error: 'reply has no player finishTimeRaw' };
		}
		const frames = Array.isArray(reply.frames) ? reply.frames : [];
		const t: number[] = [], pos: number[] = [], speed: number[] = [], hp: number[] = [];
		for (let i = 0; i < frames.length; i++) {
			const h = frames[i].horses && frames[i].horses[pi];
			if (!h) break;
			t.push(frames[i].t); pos.push(h.pos); speed.push(h.speed); hp.push(h.hp);
			if (frames[i].t >= res.finishTimeRaw) break;
		}
		const skillEvents = (Array.isArray(reply.skillEvents) ? reply.skillEvents : [])
			.filter((e: any) => e.horseIndex === pi && typeof e.skillId === 'number')
			.map((e: any) => ({ skillId: String(e.skillId), t: e.t, duration: e.duration }));
		return {
			seed,
			finishTimeRaw: res.finishTimeRaw,
			finishOrder: res.finishOrder,
			hpEmptyOnRace: res.hpEmptyOnRace ?? null,
			startDelayTime: res.startDelayTime ?? 0,
			t, pos, speed, hp, skillEvents,
		};
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
			// Free the previous preparation before building the next one (a
			// worker keeps at most one PreparedRace — memory bound).
			if (prepared) { try { prepared.race.free(); } catch { /* already dead */ } prepared = null; }
			const race = new w.PreparedRace(json);
			prepared = { setupKey: m.setupKey, race, trackSkillId: m.trackSkillId };
			deps.postMessage({ type: 'prepared', id: m.id, setupKey: m.setupKey, ok: true });
		} catch (e: any) {
			const msg = String(e && e.message || e);
			// A panic during construction may have poisoned the wasm instance.
			deps.postMessage({ type: 'prepared', id: m.id, setupKey: m.setupKey, ok: false, error: msg, dead: isDeadlyError(msg) });
		}
	}

	function handleRun(m: RunMsg): void {
		if (!prepared) {
			deps.postMessage({ type: 'chunk', jobId: m.jobId, mode: m.mode, ok: false, dead: false, error: `no preparation for job ${m.jobId}` });
			return;
		}
		const records: (SeedCompactRecord | FullRunData)[] = [];
		for (let i = 0; i < m.seeds.length; i++) {
			const seed = m.seeds[i];
			let text: string;
			try {
				text = prepared.race.run(seed);
			} catch (e: any) {
				const msg = String(e && e.message || e);
				if (isDeadlyError(msg)) {
					// The handle is dead — report the chunk as a worker failure
					// with how many seeds completed, and drop the preparation.
					prepared = null;
					deps.postMessage({ type: 'chunk', jobId: m.jobId, mode: m.mode, ok: false, dead: true, error: msg, processed: i, records });
					return;
				}
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
			records.push(m.mode === 'full' ? extractFull(reply, seed) : extractCompact(reply, seed, prepared.trackSkillId));
		}
		deps.postMessage({ type: 'chunk', jobId: m.jobId, mode: m.mode, ok: true, records });
	}

	return {
		/** Entry point: wire the host's message events into this. */
		onMessage(msg: WorkerInMsg): void {
			if (!msg || typeof msg !== 'object') return;
			if (msg.type === 'skillData') { heldSkillData = (msg as SkillDataMsg).skillData; return; }
			if (msg.type === 'prepare') void handlePrepare(msg as PrepareMsg);
			else if (msg.type === 'run') handleRun(msg as RunMsg);
		},
		/** Test/host hook: whether a preparation is currently held (affinity assertions). */
		get preparedKey(): string | null { return prepared ? prepared.setupKey : null; },
	};
}
