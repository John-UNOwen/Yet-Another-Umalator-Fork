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
 *  - noise calibration (§7.3) feeding seed budgets, the time estimate and the
 *    unit tests.
 */

import { Map as ImmMap } from 'immutable';
import type { HorseState } from '../../../../../components/HorseDefTypes';
import skillmeta from '../../../../../skill_meta.json';
import { buildGlobalsimChartJobs } from '../chart';
import { globalsimSeedList } from '../compare';
import { ci95, leadMarginL, SeedCompactRecord } from '../metrics';
import { createGlobalsimPool, GlobalsimPool, PoolJob, resolveThreadCount, WorkerFactory } from '../pool';
import { CACHE_CAP_BYTES, EffortConfig, VERIFY_SALT } from './config';
import { EvalCache, NS_SEARCH, NS_VERIFY } from './cache';
import { BuildSpace } from './space';
import {
	BuildStats, MeanSem, NoiseInfo, ObjectiveKind, ScenarioSpec, SeedSlot, SeedValue,
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
	threads?: number;
	space: BuildSpace;
	baseHorse: HorseState;
	scenarios: ScenarioSpec[];
	baseSeed: number;
	/** Merged skill table (engine skillData) — one table for the whole run. */
	skillData?: unknown;
	/** Transposition-table budget (defaults to config CACHE_CAP_BYTES). */
	cacheCapBytes?: number;
}

export interface EnsureReq {
	/** NS_SEARCH / NS_VERIFY. */
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
	/** Run all missing slots across the requests in ONE pool batch. */
	ensure(reqs: EnsureReq[]): Promise<{ jobErrors: Array<{ jobId: string; error: string }> }>;
	/** Cached seed slots for a build/scenario ([] when unknown). */
	slots(ns: string, scenarioIdx: number, identity: string): SeedSlot[];
	/** Races dispatched so far (progress). */
	racesRun(): number;
	stats(ns: string, scenarioIdx: number, build: BuildRefLite): BuildStats | null;
	paired(ns: string, scenarioIdx: number, a: BuildRefLite, b: BuildRefLite, pick: (v: SeedValue) => number | null): PairedDiff | null;
	/** Objective value + CI of one build (§6.1; meanPlacing sign-flipped;
	 *  gainVsCurrent pairs against `vs`). */
	objective(ns: string, scenarioIdx: number, build: BuildRefLite, obj: ObjectiveKind, vs?: BuildRefLite): MeanSem | null;
	/** Release anything external (pool/threads). Cache semantics end here. */
	dispose(): void;
}

export interface Evaluator extends SearchEvaluator {
	seedPosition(ns: string, scenarioIdx: number, seed: number): number;
	cacheStats(): ReturnType<EvalCache['stats']>;
	/** Free the pool (Stop). The cache survives; the next ensure starts fresh workers. */
	abort(): void;
}

/** Deterministic per-scenario salt (scenario 0 keeps the raw base seed). */
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
 *  never refetched, never counted in statistics. */
export function seedValueOf(rec: SeedCompactRecord, distanceM: number): SeedSlot {
	if (rec.error) return 'err';
	const placing = typeof rec.finishOrder === 'number' ? rec.finishOrder : NaN;
	if (!Number.isFinite(placing)) return 'err';
	return {
		lead: leadMarginL(rec, distanceM),
		win: placing === 1 ? 1 : 0,
		top3: placing <= 3 ? 1 : 0,
		placing,
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

/** Seed slot position cap (verify lists slice below this). */
const SEED_LIST_SIZE = 20000;

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
	const horses = new Map<string, HorseState>();   // identity → prepared horse
	const lists = new Map<string, number[]>();       // `${ns}|${si}` → seed list
	const indexes = new Map<string, Map<number, number>>();
	let pool: GlobalsimPool | null = null;
	let races = 0;
	// The pool takes onChunk at CREATION; each ensure() swaps in its mapping
	// through this hop (one batch runs at a time — runJobs enforces it).
	let currentChunk: ((job: PoolJob, records: unknown[]) => void) | null = null;

	const listKey = (ns: string, si: number) => `${ns}|${si}`;
	const sid = (si: number) => String(si);

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
	 *  ride along untouched (fixed skills are never bought). */
	function applySelection(selection: readonly string[]): HorseState {
		let sk = o.baseHorse.get('skills') as unknown as ImmMap<string, string>;
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
				threads: o.threads ?? resolveThreadCount(),
				skillData: o.skillData,
				onChunk: (job, records) => currentChunk?.(job, records as unknown[]),
				onJobError: () => { /* recorded in runJobs' errors; nothing else to do */ },
			});
		}
		return pool;
	}

	function statsFor(ns: string, si: number, build: BuildRefLite): BuildStats | null {
		const e = cache.peek(ns, sid(si), build.id);
		if (!e || e.filled === 0) return null;
		return statsOf(e.values);
	}

	function pairedFor(ns: string, si: number, a: BuildRefLite, b: BuildRefLite, pick: (v: SeedValue) => number | null): PairedDiff | null {
		// shared implementation (synthetic evaluators reuse pairedOf verbatim)
		return pairedOf(cache.peek(ns, sid(si), a.id)?.values ?? [], cache.peek(ns, sid(si), b.id)?.values ?? [], pick);
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
			const jobs: PoolJob[] = [];
			const jobReq = new Map<string, { req: EnsureReq; seeds: number[] }>();
			for (const req of reqs) {
				const list = getList(req.ns, req.scenarioIdx);
				let maxPos = -1;
				for (const p of req.positions) if (p > maxPos) maxPos = p;
				if (maxPos >= list.length) throw new Error(`optimizer: position ${maxPos} beyond ${req.ns} list`);
				const entry = cache.ensure(req.ns, sid(req.scenarioIdx), req.build.id, maxPos + 1);
				const missing = req.positions.filter(p => entry.values[p] === null);
				if (!missing.length) continue;
				let horse = horses.get(req.build.id);
				if (!horse) { horse = applySelection(req.build.selection); horses.set(req.build.id, horse); }
				const seeds = missing.map(p => list[p]);
				// Job ids must be unique per (ns, scenario, identity, gate, chunk):
				// variantKey carries ns + scenario; the builder appends gate/chunk.
				const variantKey = `${req.ns}${req.scenarioIdx}|${req.build.id}`;
				const built = buildGlobalsimChartJobs(o.scenarios[req.scenarioIdx].conds, variantKey, horse, seeds);
				if (built.errors.length) throw new Error(`optimizer job build failed: ${built.errors.join('; ')}`);
				for (const job of built.jobs) {
					jobs.push(job);
					jobReq.set(job.id, { req, seeds: job.seeds });
				}
			}
			if (!jobs.length) return { jobErrors: [] };
			// Feed the pool grouped by setupKey so workers reuse preparations.
			jobs.sort((a, b) => (a.setupKey < b.setupKey ? -1 : a.setupKey > b.setupKey ? 1 : 0));
			const p = ensurePool();
			currentChunk = (job: PoolJob, records: unknown[]) => {
				const m = jobReq.get(job.id);
				if (!m) return;
				const { req } = m;
				const entry = cache.ensure(req.ns, sid(req.scenarioIdx), req.build.id, 0);
				const idx = indexes.get(listKey(req.ns, req.scenarioIdx))!;
				const distance = o.scenarios[req.scenarioIdx].conds.distance;
				for (const raw of records) {
					const rec = raw as SeedCompactRecord;
					const pos = idx.get(rec.seed);
					if (pos === undefined) continue;
					const v = seedValueOf(rec, distance);
					if (entry.values[pos] === null) races++;
					cache.set(req.ns, sid(req.scenarioIdx), req.build.id, pos, v);
				}
			};
			let res: { errors: Array<{ jobId: string; error: string }> };
			try {
				res = await p.runJobs(jobs);
			} finally {
				currentChunk = null;
			}
			// A failed job's remaining holes are deterministic failures — mark
			// them 'err' so later passes never refetch (and never count them).
			for (const { jobId } of res.errors) {
				const m = jobReq.get(jobId);
				if (!m) continue;
				const idx = indexes.get(listKey(m.req.ns, m.req.scenarioIdx))!;
				for (const s of m.seeds) {
					const pos = idx.get(s);
					if (pos === undefined) continue;
					if (cache.peek(m.req.ns, sid(m.req.scenarioIdx), m.req.build.id)?.values[pos] === null) {
						cache.set(m.req.ns, sid(m.req.scenarioIdx), m.req.build.id, pos, 'err');
					}
				}
			}
			// Keep the table bounded; the search pins its own top builds elsewhere.
			cache.evict(new Set());
			return { jobErrors: res.errors };
		},
		slots(ns, si, identity) {
			return cache.peek(ns, sid(si), identity)?.values ?? [];
		},
		racesRun() { return races; },
		cacheStats: () => cache.stats(),
		stats: statsFor,
		paired: pairedFor,
		objective(ns, si, build, obj, vs) {
			const st = statsFor(ns, si, build);
			if (!st) return null;
			const gain = obj === 'gainVsCurrent' && vs ? pairedFor(ns, si, build, vs, v => v.lead) : null;
			return objectiveOf(st, obj, gain);
		},
		abort() { if (pool) { pool.abort(); pool = null; } }, // terminal for the pool; cache survives
		dispose() { if (pool) { pool.dispose(); pool = null; } },
	};
}

/**
 * §7.3 noise calibration: base build + a few single adds on `cfg.noiseSeeds`
 * seeds → σ(ℓ) of the base and the PAIRED σ of ℓ differences (the number seed
 * budgets scale from). Runs in the SEARCH namespace — the screening stage
 * reuses these seeds from cache (never wasted).
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
	const deltas: number[] = [];
	for (const v of all) {
		const vals = ev.slots(NS_SEARCH, si, v.id);
		const isBase = v.id === base.id;
		for (let i = 0; i < n; i++) {
			const a = vals[i];
			if (a == null || a === 'err' || a.lead == null) continue;
			if (isBase) { leads.push(a.lead); continue; }
			const b = baseVals[i];
			if (b == null || b === 'err' || b.lead == null) continue;
			deltas.push(a.lead - b.lead);
		}
	}
	const st = statsOf(baseVals);
	const sigmaDelta = sd(deltas) || sd(leads) || NaN;
	// The 95% band half-width a paired comparison resolves at gSeedsMin seeds:
	const resolvedDeltaL = (2 * 1.96 * sigmaDelta) / Math.sqrt(Math.max(1, cfg.gSeedsMin));
	return { sigmaLead: sd(leads), sigmaDeltaLead: sigmaDelta, baseP1: st.win.mean, nSeeds: n, resolvedDeltaL };
}
