/**
 * The evaluation engine (SKILL-OPTIMIZER-PLAN §7, §12 evaluator.ts) — the
 * optimizer's ONLY path to the race engine (P7: a client of pool.ts + the
 * chart's job builder; nothing forked).
 *
 * Responsibilities:
 *  - seed lists per scenario, search and verification namespaces, provably
 *    disjoint (P3): the verify list is the salted base list FILTERED through
 *    the search seed set — deterministic and disjoint by construction;
 *  - ensure(build, scenario, positions): run only the missing seed slots,
 *    scheduled through one pool batch (setupKey affinity keeps a worker on
 *    one build across its chunks);
 *  - fold SeedCompactRecord → SeedValue (lead via metrics.leadMarginL, then
 *    the tail grid is dropped, §7.1) into the transposition table, INDEXED BY
 *    SEED POSITION so merging is arrival-order independent (§13.4 determinism);
 *  - paired statistics (§6.2): differences over common seed positions, SE and
 *    ci95 via metrics — the only comparisons the pipeline ever makes;
 *  - objective math (§6.1): meanPlacing is sign-flipped so "bigger objective
 *    value = better build" holds everywhere above it;
 *  - noise calibration (§7.3): σ(ℓ) of the base sizes the §F lead clip, the
 *    measured σΔ caps the §C climb's ladder growth (§D.4); the pair is
 *    reported with the result and exercised by the unit tests.
 */

import { Map as ImmMap } from 'immutable';
import type { HorseState } from '../../../../../components/HorseDefTypes';
import skillmeta from '../../../../../skill_meta.json';
import { buildGlobalsimChartJobs } from '../chart';
import { globalsimSeedList } from '../compare';
import { ci95, leadMarginL, SeedCompactRecord } from '../metrics';
import { createGlobalsimPool, GlobalsimPool, PoolJob, PoolTiming, resolveThreadCount, WorkerFactory } from '../pool';
import { CACHE_CAP_BYTES, CACHE_PIN_TOP, EffortConfig, SEED_LIST_SIZE, VERIFY_SALT } from './config';
import { EvalCache, NS_SEARCH, NS_VERIFY, nsWithMode } from './cache';
import { BuildSpace, forcedOptions } from './space';
import {
	ActivationTelemetry, BuildStats, MeanSem, NoiseInfo, ObjectiveKind, ScenarioSpec, SeedSlot, SeedValue,
} from './types';

const metaGroup = (id: string): string | undefined => (skillmeta as Record<string, { groupId?: string }>)[id]?.groupId;

export interface BuildRefLite {
	/** Simulation identity (sorted simulated ids joined). */
	id: string;
	selection: readonly string[];
}

export interface PairedDiff {
	mean: number;
	sem: number;
	n: number;
	ci95: [number, number];
}

export interface EvaluatorOptions {
	workerFactory: WorkerFactory;
	/** CPU-lane factory for the pool's gpu fallback reruns. Required only when workerFactory can hand out gpu workers. */
	cpuFactory?: WorkerFactory;
	/** The extra gpu lane's factory, passed only when the server reports a
	 *  usable GPU. Absent keeps the evaluator's pool all-CPU. */
	gpuFactory?: WorkerFactory;
	/**
	 * A factory that yields gpu sessions for the background branch's own pool.
	 * When set, `ensureBackground` runs a whole batch from another search
	 * branch on the device while the foreground pool keeps the CPU lanes on
	 * the current batch, so a 2 to 5 s launch costs no barrier. The foreground
	 * pool then takes no lane: the device belongs to the branch pool.
	 */
	gpuBranchFactory?: WorkerFactory;
	/** Workers in the background gpu pool (default 1: one device pass). */
	gpuBranchThreads?: number;
	/**
	 * Foreground jobs as per-gate requests instead of one gated batch. The
	 * device lane has no gated entry, so it can only take the split form.
	 * Defaults to true exactly when the foreground pool has a lane.
	 */
	gateSplit?: boolean;
	threads?: number;
	space: BuildSpace;
	baseHorse: HorseState;
	scenarios: ScenarioSpec[];
	baseSeed: number;
	/** Merged skill table (engine skillData) — one table for the whole run. */
	skillData?: unknown;
	/**
	 * Random-stream mode for EVERY race this evaluator runs (Stages A–G).
	 * Default TRUE (paired): the optimizer is a chain of paired comparisons,
	 * and paired draws cut σΔ(ℓ) ~10× at zero cost (see AdapterConfig.paired).
	 * The value also namespaces the transposition table (nsWithMode), so a
	 * slot measured in one mode can never fold into a statistic of the other.
	 */
	paired?: boolean;
	/** Transposition-table budget (defaults to config CACHE_CAP_BYTES). */
	cacheCapBytes?: number;
}

export interface EnsureReq {
	/** NS_SEARCH / NS_VERIFY (the evaluator adds the stream-mode namespace
	 *  internally — callers pass the plain namespace). */
	ns: string;
	scenarioIdx: number;
	build: BuildRefLite;
	/** Seed LIST POSITIONS to make sure are evaluated (not raw seeds). */
	positions: number[];
}

/**
 * The narrow surface the pipeline (bandit/search/tests with synthetic
 * evaluators) needs. createEvaluator returns the full Evaluator, so the real
 * engine path satisfies this by construction; a fake only implements these.
 */
export interface SearchEvaluator {
	/** First n seeds of one namespace/scenario list (deterministic; lists are
	 *  fixed-size per scenario, so prefixes are stable forever). */
	seeds(ns: string, scenarioIdx: number, n: number): number[];
	/** Run all missing slots across the requests in ONE pool batch. Concurrent
	 *  calls queue in order: the pool runs one batch at a time, so a restart's
	 *  batch never rejects another's. */
	ensure(reqs: EnsureReq[]): Promise<{ jobErrors: Array<{ jobId: string; error: string }> }>;
	/** `ensure` on the background gpu pool, concurrent with a foreground batch.
	 *  A slot's value is a pure function of build and seed position, so where it
	 *  was measured never changes the result. */
	ensureBackground?(reqs: EnsureReq[]): Promise<{ jobErrors: Array<{ jobId: string; error: string }> }>;
	/** Cached seed slots for a build/scenario ([] when unknown). */
	slots(ns: string, scenarioIdx: number, identity: string): SeedSlot[];
	/** Races dispatched so far (progress). `route` narrows it to one pool, so
	 *  a concurrent restart's race budget counts only its own work. */
	racesRun(route?: 'foreground' | 'background'): number;
	stats(ns: string, scenarioIdx: number, build: BuildRefLite): BuildStats | null;
	paired(ns: string, scenarioIdx: number, a: BuildRefLite, b: BuildRefLite, pick: (v: SeedValue) => number | null): PairedDiff | null;
	/** Objective value + CI of one build (§6.1; meanPlacing sign-flipped;
	 *  gainVsCurrent pairs against `vs`). */
	objective(ns: string, scenarioIdx: number, build: BuildRefLite, obj: ObjectiveKind, vs?: BuildRefLite): MeanSem | null;
	/**
	 * §E per-build activation telemetry folded from the compact records
	 * (cache.ts); null while no measured seed of this build carried
	 * activation counts. Synthetic evaluators may omit the method: the
	 * search's §E rules then stand down (no telemetry, no claims).
	 */
	activations?(ns: string, scenarioIdx: number, identity: string): ActivationTelemetry | null;
	/**
	 * §K: exempt this (namespace, scenario)'s builds' cache entries from LRU
	 * eviction (what a long untilStopped run must not lose: the incumbent the
	 * bandit compares every rung against, the restart ends the shortlist is
	 * built from, and the shortlist Stage G grows). Each call REPLACES that
	 * scope's pin set (stale pins become evictable again); other scopes keep
	 * theirs. At most CACHE_PIN_TOP identities per scope stay pinned. The
	 * synthetic evaluators of the search tests may omit the method.
	 */
	pinBuilds?(ns: string, scenarioIdx: number, identities: readonly string[]): void;
	/** Release anything external (pool/threads). Cache semantics end here. */
	dispose(): void;
}

export interface Evaluator extends SearchEvaluator {
	seedPosition(ns: string, scenarioIdx: number, seed: number): number;
	cacheStats(): ReturnType<EvalCache['stats']>;
	/** §H: the pool's worker-reported prepare/run timing ledger (zeros before
	 *  the first ensure; re-zeroed when a new pool is created after abort()). */
	poolTiming(): PoolTiming;
	/** Engine/worker job failures so far, one row per distinct message (the
	 *  search ignores them; the pane shows them so a failure is never silent). */
	jobErrorLog(): Array<{ error: string; count: number }>;
	/** Free the pool (Stop). The cache survives; the next ensure starts fresh workers. */
	abort(): void;
}

/** Deterministic per-scenario salt. Every scenario is salted, scenario 0 too,
 *  so no scenario's list starts from the raw base seed. */
function scenarioSalt(i: number): number {
	return Math.imul(i + 1, 0x62a9d9ed);
}

function meanSem(xs: number[]): MeanSem {
	const n = xs.length;
	if (n === 0) return { mean: NaN, sem: NaN, n: 0 };
	const mean = xs.reduce((a, b) => a + b, 0) / n;
	if (n < 2) return { mean, sem: NaN, n };
	const varSum = xs.reduce((a, x) => a + (x - mean) * (x - mean), 0) / (n - 1);
	return { mean, sem: Math.sqrt(varSum / n), n };
}

export function emptyStats(): BuildStats {
	const z: MeanSem = { mean: NaN, sem: NaN, n: 0 };
	return { n: 0, lead: { ...z }, win: { ...z }, top3: { ...z }, placing: { ...z }, hpEmpty: { ...z }, rushed: { ...z } };
}

/** Fold a raw compact record to SeedValue (lead computed, tail dropped).
 *  'err' = engine error on this seed OR unreadable placing — deterministic,
 *  never refetched, never counted in statistics.
 *
 *  The engine's finishOrder is 0-BASED: vendor/GlobalSim/src/lib.rs fills
 *  order_index from `order.iter().enumerate()` over finish times sorted
 *  ascending, so the winner is 0 — and both wasm run_compact and the JS
 *  extractCompact fallback pass it through verbatim. Hence win ⇔
 *  finishOrder === 0, top-3 ⇔ finishOrder ≤ 2, and the human-facing /
 *  ranked `placing` is finishOrder + 1 (1st place reports as 1, never 0). */
export function seedValueOf(rec: SeedCompactRecord, distanceM: number): SeedSlot {
	if (rec.error) return 'err';
	const order = typeof rec.finishOrder === 'number' ? rec.finishOrder : NaN;
	if (!Number.isFinite(order)) return 'err';
	return {
		lead: leadMarginL(rec, distanceM),
		win: order === 0 ? 1 : 0,
		top3: order <= 2 ? 1 : 0,
		placing: order + 1,
		hpEmpty: rec.hpEmptyOnRace ? 1 : 0,
		rushed: (rec.rushingStartCount ?? 0) > 0 ? 1 : 0,
	};
}

/** Aggregate cache slots into per-metric means/SEs (null/'err' excluded; null
 *  leads excluded from ℓ statistics only, §7.1 — never coerced to 0). */
export function statsOf(values: SeedSlot[]): BuildStats {
	const st = emptyStats();
	const lead: number[] = [];
	const win: number[] = [];
	const top3: number[] = [];
	const placing: number[] = [];
	const hp: number[] = [];
	const rush: number[] = [];
	for (const v of values) {
		if (v == null || v === 'err') continue;
		if (v.lead != null) lead.push(v.lead);
		win.push(v.win); top3.push(v.top3); placing.push(v.placing); hp.push(v.hpEmpty); rush.push(v.rushed);
	}
	st.n = placing.length;
	st.lead = meanSem(lead); st.win = meanSem(win); st.top3 = meanSem(top3);
	st.placing = meanSem(placing); st.hpEmpty = meanSem(hp); st.rushed = meanSem(rush);
	return st;
}

/** Seeds per (namespace, scenario) list (config.ts, so applyTuning can cap by it). */
export { SEED_LIST_SIZE };
/** Failed jobs a seed survives as a retryable hole before it becomes 'err'. */
const JOB_FAIL_ATTEMPTS = 3;

/** Paired diff over two slot arrays (§6.2, shared with synthetic evaluators). */
export function pairedOf(a: SeedSlot[], b: SeedSlot[], pick: (v: SeedValue) => number | null): PairedDiff | null {
	const d: number[] = [];
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		const x = a[i], y = b[i];
		if (x == null || x === 'err' || y == null || y === 'err') continue;
		const px = pick(x), py = pick(y);
		if (px == null || py == null) continue;
		d.push(px - py);
	}
	if (!d.length) return null;
	const ms = meanSem(d);
	// metrics.ci95 takes the STANDARD DEVIATION (it divides by √n itself).
	const sd = ms.sem * Math.sqrt(ms.n);
	return { mean: ms.mean, sem: ms.sem, n: ms.n, ci95: ci95(ms.mean, sd, ms.n) };
}

/** §6.1 objective from measured stats (bigger = better everywhere);
 *  gainVsCurrent needs the caller's paired diff vs the reference build. */
export function objectiveOf(st: BuildStats, obj: ObjectiveKind, gain: PairedDiff | null): MeanSem | null {
	switch (obj) {
		case 'p1': return st.win;
		case 'meanLead': return st.lead;
		case 'pTop3': return st.top3;
		// LOWER placing is better ⇒ sign-flip so bigger objective = better.
		case 'meanPlacing':
			return { mean: isFinite(st.placing.mean) ? -st.placing.mean : NaN, sem: st.placing.sem, n: st.placing.n };
		case 'gainVsCurrent':
			return gain ? { mean: gain.mean, sem: gain.sem, n: gain.n } : { mean: NaN, sem: NaN, n: 0 };
		default: return null;
	}
}

export function createEvaluator(o: EvaluatorOptions): Evaluator {
	const cache = new EvalCache(o.cacheCapBytes ?? CACHE_CAP_BYTES);
	// Stream mode for every race (default paired — see EvaluatorOptions.paired).
	// It pins the request flag AND namespaces the cache: measurements from the
	// two modes never share a key. Seed LISTS are mode-independent (pure seed
	// arithmetic), so only cache keys carry the mode.
	const paired = o.paired !== false;
	const gateSplit = o.gateSplit ?? (o.gpuFactory != null && o.gpuBranchFactory == null);
	const cns = (ns: string): string => nsWithMode(ns, paired);
	// "Must include" locks (space.ts): implicit in every identity, never in a
	// selection — the horse must carry them regardless of what is searched.
	const lockedIds = forcedOptions(o.space).map((f) => f.id);
	const horses = new Map<string, HorseState>();   // identity → prepared horse
	const lists = new Map<string, number[]>();       // `${ns}|${si}` → seed list
	const indexes = new Map<string, Map<number, number>>();
	let pool: GlobalsimPool | null = null;
	let branchPool: GlobalsimPool | null = null;
	let races = 0;
	let racesFg = 0;
	let racesBg = 0;
	// Job-level failures (worker crash, dead handle, failed prepare/geometry
	// fetch, lost preparation) are not proven deterministic, so a failed
	// seed stays a hole and is retried by later ensure() passes; only after
	// JOB_FAIL_ATTEMPTS failed jobs does it become a permanent 'err'.
	const failCount = new Map<string, number>(); // `${cacheKey}#${pos}` → failed jobs
	const errorLog = new Map<string, number>();   // message → occurrences
	// The pool takes onChunk at CREATION; each ensure() swaps in its mapping
	// through this hop (one batch runs at a time per pool). The background
	// branch has its own hop and pool, so it never waits on the CPU batch.
	let currentChunk: ((job: PoolJob, records: unknown[]) => void) | null = null;
	let currentBranchChunk: ((job: PoolJob, records: unknown[]) => void) | null = null;
	// Concurrent ensure() calls queue per pool instead of rejecting.
	let fgChain: Promise<unknown> = Promise.resolve();
	let bgChain: Promise<unknown> = Promise.resolve();

	const listKey = (ns: string, si: number) => `${ns}|${si}`;
	const sid = (si: number) => String(si);

	// §K: what cache.evict must never touch, registered through pinBuilds and
	// composed through keyFor (the cache keys carry the stream-mode namespace,
	// so the pin is registered in the same mode the data was measured in).
	// Keyed per (ns, scenario) scope: a pin call replaces its own scope only.
	const pinScopes = new Map<string, Set<string>>();
	const pinKeys = new Set<string>();
	function setPins(ns: string, si: number, identities: readonly string[]): void {
		const scope = listKey(ns, si);
		for (const k of pinScopes.get(scope) ?? []) pinKeys.delete(k);
		const keys = new Set<string>();
		for (const id of identities) {
			if (keys.size >= CACHE_PIN_TOP) break; // the top-N stay; the rest are evictable
			keys.add(cache.keyFor(cns(ns), sid(si), id));
		}
		pinScopes.set(scope, keys);
		for (const k of keys) pinKeys.add(k);
	}

	/** Search list: globalsimSeedList over a scenario-salted base. */
	function getList(ns: string, si: number): number[] {
		const k = listKey(ns, si);
		let l = lists.get(k);
		if (!l) {
			if (ns === NS_VERIFY) {
				// P3 disjointness: salted base FILTERED through the search set;
				// deterministic ⇒ prefixes stable, no seed can ever appear in
				// both lists of one scenario.
				const taken = new Set(getList(NS_SEARCH, si));
				l = globalsimSeedList((o.baseSeed + VERIFY_SALT + scenarioSalt(si)) | 0, SEED_LIST_SIZE * 3)
					.filter(s => !taken.has(s))
					.slice(0, SEED_LIST_SIZE);
			} else {
				l = globalsimSeedList((o.baseSeed + scenarioSalt(si)) | 0, SEED_LIST_SIZE);
			}
			lists.set(k, l);
			indexes.set(k, new Map(l.map((s, i) => [s, i] as [number, number])));
		}
		return l;
	}

	/** withSkillSwappedIn parity in bulk: for each selected option, drop every
	 *  skill of its group, then set groupId → option id. Uniques/other groups
	 *  ride along untouched (fixed skills are never bought). "Must include"
	 *  locks are never in `selection` (they are implicit in fixedIds/identity),
	 *  so they are applied first — every simulated build carries them. */
	function applySelection(selection: readonly string[]): HorseState {
		let sk = o.baseHorse.get('skills') as unknown as ImmMap<string, string>;
		for (const id of lockedIds) {
			const gid = metaGroup(id);
			if (!gid) continue;
			sk = sk.filter((existing: string) => metaGroup(existing) !== gid) as ImmMap<string, string>;
			sk = sk.set(gid, id);
		}
		for (const id of selection) {
			const gid = metaGroup(id);
			if (!gid) continue;
			sk = sk.filter((existing: string) => metaGroup(existing) !== gid) as ImmMap<string, string>;
			sk = sk.set(gid, id);
		}
		return o.baseHorse.set('skills', sk as never);
	}

	function ensurePool(): GlobalsimPool {
		if (!pool) {
			pool = createGlobalsimPool({
				factory: o.workerFactory,
				cpuFactory: o.cpuFactory,
				// The branch pool owns the device when one is configured: an extra
				// lane here would compete with it for the same session.
				gpuFactory: o.gpuBranchFactory ? undefined : o.gpuFactory,
				threads: o.threads ?? resolveThreadCount(),
				skillData: o.skillData,
				// The optimizer runs an evaluation per batch, so the pool opens
				// the extra lane on the first batch whose drain can pay for it.
				gpuLane: 'eager',
				onChunk: (job, records) => currentChunk?.(job, records as unknown[]),
				onJobError: () => { /* recorded in runJobs' errors; nothing else to do */ },
			});
		}
		return pool;
	}

	function ensureBranchPool(): GlobalsimPool {
		if (!branchPool) {
			const factory = o.gpuBranchFactory;
			if (!factory) throw new Error('optimizer: this evaluator has no background gpu branch');
			branchPool = createGlobalsimPool({
				factory,
				cpuFactory: o.cpuFactory,   // kernel refusals rerun on the CPU lanes
				threads: o.gpuBranchThreads ?? 1,
				skillData: o.skillData,
				gpuLane: 'off',
				onChunk: (job, records) => currentBranchChunk?.(job, records as unknown[]),
				onJobError: () => { /* recorded in runJobs' errors */ },
			});
		}
		return branchPool;
	}

	function statsFor(ns: string, si: number, build: BuildRefLite): BuildStats | null {
		const e = cache.peek(cns(ns), sid(si), build.id);
		if (!e || e.filled === 0) return null;
		return statsOf(e.values);
	}

	function pairedFor(ns: string, si: number, a: BuildRefLite, b: BuildRefLite, pick: (v: SeedValue) => number | null): PairedDiff | null {
		// shared implementation (synthetic evaluators reuse pairedOf verbatim)
		return pairedOf(cache.peek(cns(ns), sid(si), a.id)?.values ?? [], cache.peek(cns(ns), sid(si), b.id)?.values ?? [], pick);
	}

	/** Queue one batch behind the route's previous one. A failed batch keeps the
	 *  chain alive: the next call still runs. */
	function serialized<T>(route: 'foreground' | 'background', run: () => Promise<T>): Promise<T> {
		const tail = route === 'background' ? bgChain : fgChain;
		const next = tail.then(run, run);
		const settled = next.then(() => undefined, () => undefined);
		if (route === 'background') bgChain = settled; else fgChain = settled;
		return next;
	}

	/** The one batch body: build the missing jobs, run them on the route's pool,
	 *  fold records into the shared cache and retry the holes. */
	async function runEnsure(reqs: EnsureReq[], route: 'foreground' | 'background'): Promise<{ jobErrors: Array<{ jobId: string; error: string }> }> {
		const jobs: PoolJob[] = [];
		const jobReq = new Map<string, { req: EnsureReq; seeds: number[] }>();
		for (const req of reqs) {
			const list = getList(req.ns, req.scenarioIdx);
			let maxPos = -1;
			for (const p of req.positions) if (p > maxPos) maxPos = p;
			if (maxPos >= list.length) throw new Error(`optimizer: position ${maxPos} beyond ${req.ns} list`);
			const entry = cache.ensure(cns(req.ns), sid(req.scenarioIdx), req.build.id, maxPos + 1);
			const missing = req.positions.filter(p => entry.values[p] === null);
			if (!missing.length) continue;
			let horse = horses.get(req.build.id);
			if (!horse) { horse = applySelection(req.build.selection); horses.set(req.build.id, horse); }
			const seeds = missing.map(p => list[p]);
			// Job ids must be unique per (ns, scenario, identity, gate, chunk):
			// variantKey carries ns + scenario; the builder appends gate/chunk.
			const variantKey = `${req.ns}${req.scenarioIdx}|${req.build.id}`;
			// The evaluator's stream mode pins the request flag on every race
			// (its setupKey also carries the mode tag, so a mode never reuses another).
			// A foreground batch prepares one gate-0 field per build and runs
			// every seed at its own gate. The background branch stays gate-split,
			// since the device lane merges request texts rather than seed gates.
			const built = buildGlobalsimChartJobs({ ...o.scenarios[req.scenarioIdx].conds, paired, gateBatch: route === 'foreground' && !gateSplit }, variantKey, horse, seeds);
			if (built.errors.length) throw new Error(`optimizer job build failed: ${built.errors.join('; ')}`);
			for (const job of built.jobs) {
				jobs.push(job);
				jobReq.set(job.id, { req, seeds: job.seeds });
			}
		}
		if (!jobs.length) return { jobErrors: [] };
		// Feed the pool grouped by setupKey so workers reuse preparations.
		jobs.sort((a, b) => (a.setupKey < b.setupKey ? -1 : a.setupKey > b.setupKey ? 1 : 0));
		const p = route === 'background' ? ensureBranchPool() : ensurePool();
		const chunk = (job: PoolJob, records: unknown[]) => {
			const m = jobReq.get(job.id);
			if (!m) return;
			const { req } = m;
			const entry = cache.ensure(cns(req.ns), sid(req.scenarioIdx), req.build.id, 0);
			const idx = indexes.get(listKey(req.ns, req.scenarioIdx))!;
			const distance = o.scenarios[req.scenarioIdx].conds.distance;
			for (const raw of records) {
				const rec = raw as SeedCompactRecord;
				const pos = idx.get(rec.seed);
				if (pos === undefined) continue;
				const wasMissing = entry.values[pos] === null;
				const v = seedValueOf(rec, distance);
				if (wasMissing) { races++; if (route === 'background') racesBg++; else racesFg++; }
				cache.set(cns(req.ns), sid(req.scenarioIdx), req.build.id, pos, v);
				// §E: fold the seed's per-skill activation counts once, on
				// first fill of the slot, never on a re-delivered chunk and
				// never for an errored seed.
				if (wasMissing && v !== 'err' && rec.skillActivations) {
					cache.foldActivations(cns(req.ns), sid(req.scenarioIdx), req.build.id, rec.skillActivations);
				}
			}
		};
		if (route === 'background') currentBranchChunk = chunk; else currentChunk = chunk;
		let res: { errors: Array<{ jobId: string; error: string }> };
		try {
			res = await p.runJobs(jobs);
		} finally {
			if (route === 'background') currentBranchChunk = null; else currentChunk = null;
		}
		// A failed job's holes stay null (retried next pass) until the same
		// seed has failed JOB_FAIL_ATTEMPTS times, only then is it 'err'
		// (never refetched, never counted). Per-seed engine errors inside a
		// successful chunk are already 'err' via seedValueOf.
		for (const { jobId, error } of res.errors) {
			errorLog.set(error, (errorLog.get(error) ?? 0) + 1);
			const m = jobReq.get(jobId);
			if (!m) continue;
			const idx = indexes.get(listKey(m.req.ns, m.req.scenarioIdx))!;
			const ck = cache.keyFor(cns(m.req.ns), sid(m.req.scenarioIdx), m.req.build.id);
			for (const s of m.seeds) {
				const pos = idx.get(s);
				if (pos === undefined) continue;
				if (cache.peek(cns(m.req.ns), sid(m.req.scenarioIdx), m.req.build.id)?.values[pos] !== null) continue;
				const fk = `${ck}#${pos}`;
				const n = (failCount.get(fk) ?? 0) + 1;
				if (n >= JOB_FAIL_ATTEMPTS) {
					failCount.delete(fk);
					cache.set(cns(m.req.ns), sid(m.req.scenarioIdx), m.req.build.id, pos, 'err');
				} else {
					failCount.set(fk, n);
				}
			}
		}
		// Keep the table bounded; the search pins what it must not evict
		// (incumbent, restart ends, shortlist — §K). Nor may this pass
		// evict what this batch was asked for: its caller reads those slots
		// next (a bandit rung pairs every candidate). An entry gone
		// before that read looks unmeasured, so a candidate died of cache
		// pressure and the run's answer depended on the cache cap. The cap
		// can be passed for one batch, as pins already allow.
		const keep = new Set(pinKeys);
		for (const req of reqs) keep.add(cache.keyFor(cns(req.ns), sid(req.scenarioIdx), req.build.id));
		cache.evict(keep);
		return { jobErrors: res.errors };
	}

	return {
		seeds(ns, si, n) {
			const l = getList(ns, si);
			if (n > l.length) throw new Error(`optimizer: ${ns} seed list exhausted for scenario ${si} (${n} > ${l.length})`);
			return l.slice(0, n);
		},
		seedPosition(ns, si, seed) {
			const idx = indexes.get(listKey(ns, si))?.get(seed);
			if (idx === undefined) throw new Error(`optimizer: seed ${seed} not in ${ns} list of scenario ${si}`);
			return idx;
		},
		async ensure(reqs) {
			return serialized('foreground', () => runEnsure(reqs, 'foreground'));
		},
		async ensureBackground(reqs) {
			if (!o.gpuBranchFactory) throw new Error('optimizer: this evaluator has no background gpu branch');
			return serialized('background', () => runEnsure(reqs, 'background'));
		},
		slots(ns, si, identity) {
			return cache.peek(cns(ns), sid(si), identity)?.values ?? [];
		},
		activations(ns, si, identity) {
			return cache.activationOf(cns(ns), sid(si), identity);
		},
		pinBuilds(ns, si, identities) { setPins(ns, si, identities); },
		racesRun(route) { return route === 'foreground' ? racesFg : route === 'background' ? racesBg : races; },
		cacheStats: () => cache.stats(),
		jobErrorLog: () => [...errorLog].map(([error, count]) => ({ error, count })),
		poolTiming: () => pool?.timing() ?? { prepares: 0, prepareMs: 0, chunks: 0, runMs: 0, records: 0 },
		stats: statsFor,
		paired: pairedFor,
		objective(ns, si, build, obj, vs) {
			const st = statsFor(ns, si, build);
			if (!st) return null;
			const gain = obj === 'gainVsCurrent' && vs ? pairedFor(ns, si, build, vs, v => v.lead) : null;
			return objectiveOf(st, obj, gain);
		},
		abort() {
			if (pool) { pool.abort(); pool = null; }
			if (branchPool) { branchPool.abort(); branchPool = null; }
		}, // terminal for both pools, the cache survives
		dispose() {
			if (pool) { pool.dispose(); pool = null; }
			if (branchPool) { branchPool.dispose(); branchPool = null; }
		},
	};
}

/**
 * §7.3 noise calibration: base build + a few single adds on `cfg.noiseSeeds`
 * seeds → σ(ℓ) of the base and the PAIRED σΔ of ℓ differences. Both size the
 * search (search.ts: σ(ℓ) the §F lead clip, σΔ the §C climb's ladder ceiling),
 * and the pair ships in the result for the pane. The presets' seed counts are
 * not sized here; those come from the paired calibration record in README.md.
 * Runs in the SEARCH namespace — the screening stage reuses these seeds from
 * cache (never wasted).
 */
export async function calibrateNoise(
	ev: SearchEvaluator, cfg: EffortConfig, si: number,
	base: BuildRefLite, variants: BuildRefLite[],
): Promise<NoiseInfo> {
	const n = Math.min(cfg.noiseSeeds, SEED_LIST_SIZE);
	const all = [base, ...variants];
	const positions = Array.from({ length: n }, (_, i) => i);
	await ev.ensure(all.map(b => ({ ns: NS_SEARCH, scenarioIdx: si, build: b, positions })));
	const baseVals = ev.slots(NS_SEARCH, si, base.id);
	const sd = (xs: number[]) => {
		if (xs.length < 2) return NaN;
		const m = xs.reduce((a, b) => a + b, 0) / xs.length;
		return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1));
	};
	const leads: number[] = [];
	// Each variant's deltas are centred on that variant's own mean before
	// pooling: the variants are different skills with different true effects,
	// and pooling raw deltas counted the spread of those effects as noise.
	const deltas: number[] = [];
	let nVar = 0; // variants that contributed centred deltas
	for (const v of all) {
		const vals = ev.slots(NS_SEARCH, si, v.id);
		const isBase = v.id === base.id;
		const own: number[] = [];
		for (let i = 0; i < n; i++) {
			const a = vals[i];
			if (a == null || a === 'err' || a.lead == null) continue;
			if (isBase) { leads.push(a.lead); continue; }
			const b = baseVals[i];
			if (b == null || b === 'err' || b.lead == null) continue;
			own.push(a.lead - b.lead);
		}
		if (isBase) continue;
		if (own.length < 2) continue;
		// A skill that never fires leaves every paired delta at exactly 0. That
		// says nothing about the noise, so it is left out like a variant with
		// too few seeds.
		if (own.every(d => d === 0)) continue;
		const m = own.reduce((x, y) => x + y, 0) / own.length;
		for (const d of own) deltas.push(d - m);
		nVar++;
	}
	const st = statsOf(baseVals);
	// Centred deltas have zero mean per variant: the pooled SD divides by
	// (count − #variants) for the means it spent.
	const sdCentred = (xs: number[]) => {
		const dof = xs.length - nVar;
		if (dof < 1) return NaN;
		return Math.sqrt(xs.reduce((a, x) => a + x * x, 0) / dof);
	};
	// With no variant to pair, the single-seed spread is the only figure there
	// is. With variants that all said nothing, it is about 10x the paired one,
	// so report none rather than a wrong one.
	const sigmaDelta = nVar ? sdCentred(deltas) || NaN : variants.length ? NaN : sd(leads);
	// The 95% band half-width a paired comparison resolves at gSeedsMin seeds:
	const resolvedDeltaL = (2 * 1.96 * sigmaDelta) / Math.sqrt(Math.max(1, cfg.gSeedsMin));
	const baseLead = leads.length ? leads.reduce((a, b) => a + b, 0) / leads.length : NaN;
	return { sigmaLead: sd(leads), baseLead, sigmaDeltaLead: sigmaDelta, baseP1: st.win.mean, nSeeds: n, resolvedDeltaL };
}
