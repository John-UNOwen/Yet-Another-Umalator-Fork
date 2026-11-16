/**
 * GlobalSim skill-chart runner (Phase 5 of the integration plan, §5).
 *
 * Same job topology as compare.ts, but the "UMA 2" of every pair is the
 * tested uma with ONE candidate skill swapped in:
 *
 *   Race A (baseline) = the tested uma exactly as configured, vs the mob
 *     field — computed ONCE for the whole seed list and reused by EVERY
 *     skill (plan §4.1: "The baseline per seed is shared by all skills, so
 *     run it once").
 *   Race B (variant)  = the same uma with the candidate swapped in, same
 *     seed ⇒ same mob field and same tested-uma gate (buildMobField with
 *     identical inputs ⇒ identical field — Phase 3 guarantee).
 *
 * Swap semantics MIRROR the classic chart worker exactly (simulator.worker.ts
 * runChartRound:159-179): drop every owned skill whose skill_meta groupId
 * equals the candidate's groupId, then set(groupId → candidate). So an owned
 * white being tested against its gold candidate measures the SWAP, and
 * re-testing the exact owned skill reproduces the baseline (margin ≡ 0 by
 * engine determinism). The baseline keeps the owned skill (classic parity).
 *
 * Margin sign = metrics.pairMargin's convention: positive = race B (the
 * runner WITH the candidate) ahead, in lengths (1 L = 2.5 m). Per-skill
 * aggregates (mean + 95% CI, median, min, max, win/loss/tie rates) reuse
 * metrics.ts's CompareAggregate unchanged — a skill's round-2 chunks simply
 * addPair more seeds onto the same aggregate (order-independent merge).
 *
 * Two-round sampling (plan §4.1, "keep today's two-round filter"): round 1
 * runs CHART_ROUND1_SEEDS seeds per skill; skills with max > 0.1 L and
 * spread > 0.1 L (classic filter, simulator.worker.ts:259-262) get the
 * remaining seeds added; fast mode = one CHART_FAST_SEEDS round, no filter.
 *
 * Preparation affinity: jobs are emitted grouped by skill (all chunks of one
 * skill's gate group adjacent), and a survivor's round-2 jobs share the
 * round-1 setupKey ⇒ a worker that just ran the skill re-uses its preparation.
 *
 * Streaming: throttled (100 ms, like compare.ts) partial per-skill rows
 * through onProgress; the classic pane paints them as they arrive. Memory:
 * compact records only — B records are paired into the aggregate and dropped
 * (only the baseline per-seed records stay cached for pairing; ~41 tail
 * samples each). No representative-frame re-runs for the chart.
 *
 * Cancellation: optional AbortSignal wired to pool.abort() — live workers
 * terminate, queued work is dropped without requeue, the promise rejects.
 */

import { Map as ImmMap } from 'immutable';
import type { HorseState } from '../../../../components/HorseDefTypes';
import { GroundCondition, Weather, Season, Time, Grade } from '../../../../uma-skill-tools/RaceParameters';
import skillmeta from '../../../../skill_meta.json';
import { buildGlobalSimRequest, AdapterConfig } from './adapter';
import { buildMobField, deriveGate, MobPreset, MobError } from './mobs';
import { createGlobalsimPool, GlobalsimPool, PoolJob, WorkerFactory, resolveThreadCount } from './pool';
import { DEFAULT_CHUNK_SIZE, globalsimSeedList, hashString64, mergeCanonicalField, streamModeTag } from './compare';
import { SeedCompactRecord, CompareAggregate, newAggregate, addPair, summarizeAggregate } from './metrics';
import type { SkillChartResult, SkillChartGlobalsim } from '../../skill-chart-types';

/** Plan §4.1 round sizes (classic parity): 25 + 175 = 200 seeds, fast 50. */
export const CHART_ROUND1_SEEDS = 25;
export const CHART_FAST_SEEDS = 50;
export const CHART_DEFAULT_SEEDS = 200;
/** Classic round-1 keep filter (simulator.worker.ts:259-262), in lengths. */
export const CHART_FILTER_MAX_L = 0.1;
export const CHART_FILTER_SPREAD_L = 0.1;
/**
 * Hard ceiling on the chart's per-skill seed count. The classic chart ignores
 * the UI Samples field (fixed 25 + 175 = 200, or 50 fast), but app-v2 wires the
 * GlobalSim chart to the shared *compare* Samples setting, which clamps to
 * 1..10000 — so an unguarded sampleCount lets a 10000-sample compare setting
 * size the chart into an hours-long run (baseline over 10000 seeds, round 2
 * adding ~9975 more per surviving skill). Cap the chart at 1000 seeds/skill;
 * the compare runner keeps its own (uncapped) sampleCount, unchanged.
 */
export const CHART_MAX_SEEDS = 1000;

/**
 * Resolve the chart's per-skill seed count from the caller's sampleCount.
 * Mirrors the former inline resolution exactly (default CHART_DEFAULT_SEEDS,
 * round, floor 1) and adds the CHART_MAX_SEEDS ceiling. Pure and exported so
 * the ceiling is unit-testable without running wasm.
 */
export function resolveChartSeedCount(sampleCount?: number): number {
	return Math.min(CHART_MAX_SEEDS, Math.max(1, Math.round(sampleCount ?? CHART_DEFAULT_SEEDS)));
}

export interface ChartRaceConditions {
	courseId: string | number;
	/** Race distance in metres (margins are lengths, 1 L = 2.5 m). */
	distance: number;
	ground: GroundCondition;
	weather: Weather;
	season: Season;
	time: Time;
	grade?: Grade;
	/** Active GlobalSim skill table keys — the adapter's coverage gate (D5). */
	knownSkillIds?: ReadonlySet<string>;
	/** Merged active skill table (engine skillData) — see GlobalsimCompareInput. */
	skillData?: Record<string, unknown>;
	courseIds: ReadonlySet<string> | readonly string[];
	mobPreset: MobPreset;
	fixedGate?: number;
	chunkSize?: number;
	/**
	 * Paired random streams (engine pairedRandomStreams — see AdapterConfig.paired).
	 * The chart resolves this per call: default TRUE (Skill Chart mode), and
	 * the optimizer evaluator pins it explicitly for its own runs.
	 */
	paired?: boolean;
}

export interface GlobalsimSkillChartInput extends ChartRaceConditions {
	/** The uma being charted, exactly as configured (baseline side). */
	uma: HorseState;
	/** Candidate skill ids (the app pre-filters: activateable + coverage, Phase 2b). */
	skills: readonly string[];
	/** User-visible base seed; the seed list is globalsimSeedList(seedBase, n). */
	seedBase: number;
	/** Total paired seeds per surviving skill (default 200 = 25 + 175;
	 *  clamped to [1, CHART_MAX_SEEDS] — see resolveChartSeedCount). */
	sampleCount?: number;
	/** Fast mode: single CHART_FAST_SEEDS round, no round-2 filter. */
	fastMode?: boolean;
	threads?: number;
	workerFactory: WorkerFactory;
	/** Throttled partial rows (full current snapshot of every painted skill). */
	onProgress?: (rows: SkillChartResult[]) => void;
	/** Chart round changes for the existing progress plumbing ({round,total}). */
	onRound?: (round: number, total: number) => void;
	/** Cancellation (Stop): aborting rejects the promise; workers terminate. */
	signal?: AbortSignal;
}

/**
 * The classic worker's skill swap (runChartRound parity): remove every skill
 * of the candidate's group, then add the candidate at its groupId key.
 */
export function withSkillSwappedIn(horse: HorseState, skill: string): HorseState {
	const gid = (skillmeta as Record<string, { groupId?: string }>)[skill]?.groupId;
	// Loose typing on purpose: HorseState.skills is Immutable Map<groupId,
	// skillId-literal>; the candidate is a plain string here (same as the
	// classic chart worker, which receives untyped HorseState JSON).
	let sk = horse.get('skills') as unknown as ImmMap<string, string>;
	if (gid) sk = sk.filter((existingId: string) => (skillmeta as Record<string, { groupId?: string }>)[existingId]?.groupId !== gid);
	sk = sk.set(gid as string, skill);
	return horse.set('skills', sk as never);
}

/**
 * Per (variant, gate) chunk jobs for a set of seeds — the same construction
 * compare.ts uses (gate groups → one preparation per gate → ≤chunkSize
 * chunks), exposed for the chart rounds and the scheduler tests.
 */
export function buildGlobalsimChartJobs(
	conds: ChartRaceConditions,
	variantKey: string,            // 'base' | 'k<skillId>'
	horse: HorseState,
	seeds: number[],
	options: { trackSkillId?: string; idTag?: string } = {},
): { jobs: PoolJob[]; errors: string[] } {
	const chunkSize = conds.chunkSize ?? DEFAULT_CHUNK_SIZE;
	// Skill Chart mode is paired: a caller that wants retail draws must pass
	// paired: false explicitly (the optimizer evaluator pins its own mode).
	const paired = conds.paired !== false;
	const modeTag = streamModeTag(paired);
	const groups = new Map<number, number[]>();
	for (const s of seeds) {
		const g = conds.fixedGate ?? deriveGate(s);
		const arr = groups.get(g);
		if (arr) arr.push(s); else groups.set(g, [s]);
	}
	const jobs: PoolJob[] = [];
	const errors: string[] = [];
	const config: AdapterConfig = { courseIds: conds.courseIds, knownSkillIds: conds.knownSkillIds, skillData: conds.skillData ? null : undefined, paired };
	for (const [gate, groupSeeds] of groups) {
		const { mobs, errors: mobErrors } = buildMobField(conds.mobPreset, 0, { fixedGate: gate });
		if (mobErrors.length) {
			errors.push(...mobErrors.map((e: MobError) => `mob field gate ${gate}: ${e.field} ${e.message}`));
			continue;
		}
		const res = buildGlobalSimRequest({
			courseId: conds.courseId,
			groundCondition: conds.ground, weather: conds.weather, season: conds.season, time: conds.time,
			grade: conds.grade,
			seed: groupSeeds[0],           // placeholder; run(seed) overrides per seed
			runners: [{ horse, gateIndex: gate, isPlayer: true }],
		}, config);
		if (res.ok !== true) {
			errors.push(`gate ${gate} variant ${variantKey}: ${res.errors.map(e => `${e.field}: ${e.message}`).join('; ')}`);
			continue;
		}
		const player = (res.value as any).horses[0];
		const merged = mergeCanonicalField(player, gate, mobs);
		const request = { ...(res.value as any), horses: merged.horses, playerHorseIndex: merged.playerIndex };
		const setupKey = `gs|chart|${variantKey}|c${conds.courseId}|g${gate}|${modeTag}|${hashString64(JSON.stringify({ g: conds.ground, w: conds.weather, s: conds.season, t: conds.time, gr: conds.grade ?? null, h: request.horses }))}`;
		for (let c = 0; c < groupSeeds.length; c += chunkSize) {
			jobs.push({
				id: `${variantKey}|g${gate}|${options.idTag ?? ''}${c}`,
				setupKey,
				request,
				seeds: groupSeeds.slice(c, c + chunkSize),
				mode: 'compact',
				trackSkillId: options.trackSkillId,
			});
		}
	}
	return { jobs, errors };
}

// ── streaming per-skill collector (pure; unit-tested offline) ────────────────

interface SkillState {
	agg: CompareAggregate;
	/** B records waiting for their baseline seed (compare.ts's pending pattern). */
	pending: Map<number, SeedCompactRecord>;
	actSum: number; actN: number; actPositive: number;
	round: number;
}

export interface ChartCollector {
	addBaseline(seed: number, rec: SeedCompactRecord): void;
	addVariant(skill: string, seed: number, rec: SeedCompactRecord): void;
	markRound(skill: string, round: number): void;
	/** Rows for every skill with ≥1 paired margin (streaming snapshot). */
	rows(): SkillChartResult[];
	totalPairs(): number;
}

export function createChartCollector(distanceM: number, skills: readonly string[]): ChartCollector {
	const baseBySeed = new Map<number, SeedCompactRecord>();
	const state = new Map<string, SkillState>();
	for (const id of skills) {
		state.set(id, { agg: newAggregate(), pending: new Map(), actSum: 0, actN: 0, actPositive: 0, round: 1 });
	}

	const pair = (sk: SkillState, seed: number, b: SeedCompactRecord) => {
		const a = baseBySeed.get(seed) as SeedCompactRecord;
		addPair(sk.agg, a, b, distanceM);
		if (!b.error && typeof b.activations === 'number') {
			sk.actN += 1;
			sk.actSum += b.activations;
			if (b.activations > 0) sk.actPositive += 1;
		}
		sk.pending.delete(seed);
	};

	return {
		addBaseline(seed, rec) {
			baseBySeed.set(seed, rec);
			for (const sk of state.values()) if (sk.pending.has(seed)) pair(sk, seed, sk.pending.get(seed) as SeedCompactRecord);
		},
		addVariant(skill, seed, rec) {
			const sk = state.get(skill);
			if (!sk) return;
			if (baseBySeed.has(seed)) pair(sk, seed, rec);
			else sk.pending.set(seed, rec);
		},
		markRound(skill, round) {
			const sk = state.get(skill);
			if (sk) sk.round = round;
		},
		rows() {
			const out: SkillChartResult[] = [];
			for (const [id, sk] of state) {
				if (sk.agg.n === 0) continue;
				const s = summarizeAggregate(sk.agg);
				const gs: SkillChartGlobalsim = {
					n: s.n,
					ci95: s.ci95,
					winRate: s.winRateUma2,     // margin > 0 ⇒ the skill side ahead
					lossRate: s.winRateUma1,
					tieRate: s.tieRate,
					seedErrors: s.seedErrors,
					round: sk.round,
				};
				if (sk.actN > 0) {
					gs.activationMean = sk.actSum / sk.actN;
					gs.activationRate = sk.actPositive / sk.actN;
				}
				out.push({ id, min: s.min, max: s.max, mean: s.mean, median: s.median, results: [], sampleCount: s.n, globalsim: gs, runData: null as any });
			}
			return out;
		},
		totalPairs() {
			let n = 0;
			for (const sk of state.values()) n += sk.agg.n;
			return n;
		},
	};
}

// ── the runner ───────────────────────────────────────────────────────────────

const BASE_KEY = 'base';

export async function runGlobalsimSkillChart(input: GlobalsimSkillChartInput): Promise<SkillChartResult[]> {
	const startedAt = Date.now();
	const threads = input.threads ?? resolveThreadCount();
	const fast = input.fastMode === true;
	const total = resolveChartSeedCount(input.sampleCount);
	const round1N = Math.min(fast ? CHART_FAST_SEEDS : CHART_ROUND1_SEEDS, total);
	const seeds = globalsimSeedList(input.seedBase, total);
	const seeds1 = seeds.slice(0, round1N);
	const seeds2 = seeds.slice(round1N);
	const rounds = fast || !seeds2.length ? 1 : 2;

	const collector = createChartCollector(input.distance, input.skills);
	const buildErrors: string[] = [];

	// Baseline for the FULL seed list, once (shared by every skill and round).
	const baseBuild = buildGlobalsimChartJobs(input, BASE_KEY, input.uma, seeds);
	buildErrors.push(...baseBuild.errors);
	if (!baseBuild.jobs.length) throw new Error(`GlobalSim chart baseline setup failed: ${buildErrors.join('; ') || 'no seeds'}`);

	// Per-skill variants (classic swap semantics) — one preparation each (×gate).
	const variants = input.skills
		.map(skill => ({ key: `k${skill}`, skill, horse: withSkillSwappedIn(input.uma, skill) }))
		.filter(v => {
			// A candidate the adapter rejects (coverage miss, bad build) drops out.
			if (!v.skill || !/^\d+$/.test(v.skill)) { buildErrors.push(`bad candidate ${v.skill}`); return false; }
			return true;
		});

	// ── streaming merge ─────────────────────────────────────────────────────
	const jobErrors: Array<{ jobId: string; error: string }> = [];
	let lastPaintAt = 0;
	const paint = (force: boolean) => {
		const now = Date.now();
		if (!force && now - lastPaintAt < 100) return;
		lastPaintAt = now;
		input.onProgress?.(collector.rows());
	};
	const onChunk = (job: PoolJob, records: any[]) => {
		const head = job.id.split('|')[0];
		if (head === BASE_KEY) {
			for (const r of records as SeedCompactRecord[]) collector.addBaseline(r.seed, r);
		} else {
			const skill = head.slice(1);
			for (const r of records as SeedCompactRecord[]) collector.addVariant(skill, r.seed, r);
		}
		paint(false);
	};

	const pool: GlobalsimPool = createGlobalsimPool({ factory: input.workerFactory, threads, skillData: input.skillData, onChunk });
	const abortHandler = () => pool.abort();
	if (input.signal) {
		if (input.signal.aborted) { pool.dispose(); throw abortError(); }
		input.signal.addEventListener('abort', abortHandler);
	}

	const runBatch = async (jobs: PoolJob[]): Promise<boolean> => {
		try {
			const res = await pool.runJobs(jobs);
			jobErrors.push(...res.errors);
			return true;
		} catch (e) {
			if (input.signal?.aborted) throw abortError();
			throw e;
		}
	};

	try {
		input.onRound?.(1, rounds);
		const r1Jobs: PoolJob[] = [];
		const round1Variants: typeof variants = [];
		for (const v of variants) {
			const built = buildGlobalsimChartJobs(input, v.key, v.horse, seeds1, { trackSkillId: v.skill });
			if (built.errors.length) { buildErrors.push(...built.errors); continue; }
			if (!built.jobs.length) continue;
			r1Jobs.push(...built.jobs);
			round1Variants.push(v);
		}
		if (!r1Jobs.length) throw new Error(`GlobalSim chart produced no variant jobs: ${buildErrors.join('; ') || 'no candidates'}`);

		// Baseline jobs first: pairing buffers tolerate any order, but leading
		// with the shared preparation warms gate groups before the fan-out.
		await runBatch([...baseBuild.jobs, ...r1Jobs]);
		paint(true);

		if (rounds === 2) {
			// Classic round-1 filter (v2-variance strategy).
			const rows = new Map(collector.rows().map(r => [r.id, r]));
			const survivors = round1Variants.filter(v => {
				const r = rows.get(v.skill);
				return !!r && r.max > CHART_FILTER_MAX_L && Math.abs(r.max - r.min) > CHART_FILTER_SPREAD_L;
			});
			if (survivors.length) {
				for (const v of survivors) collector.markRound(v.skill, 2);
				input.onRound?.(2, 2);
				const r2Jobs: PoolJob[] = [];
				for (const v of survivors) {
					const built = buildGlobalsimChartJobs(input, v.key, v.horse, seeds2, { trackSkillId: v.skill, idTag: 'r2.' });
					if (built.errors.length) { buildErrors.push(...built.errors); continue; }
					r2Jobs.push(...built.jobs);
				}
				if (r2Jobs.length) await runBatch(r2Jobs);
			}
		}
	} finally {
		if (input.signal) input.signal.removeEventListener('abort', abortHandler);
		pool.dispose();
	}

	if (collector.totalPairs() === 0) {
		const detail = jobErrors.slice(0, 3).map(e => `${e.jobId}: ${e.error}`).join(' | ');
		throw new Error(`GlobalSim skill chart produced no results (${detail || buildErrors.join('; ') || 'no pairs'})`);
	}
	if (buildErrors.length) console.warn('[GlobalSim] chart skill(s) dropped:', buildErrors);
	if (jobErrors.length) console.warn('[GlobalSim] chart chunk errors:', jobErrors);
	const rows = collector.rows();
	input.onProgress?.(rows);   // final paint (rows complete at this point)
	const elapsed = Date.now() - startedAt;
	console.log(`[GlobalSim] skill chart: ${rows.length} skills, ${collector.totalPairs()} paired races, ${threads} threads, ${(elapsed / 1000).toFixed(1)}s`);
	return rows;
}

function abortError(): Error {
	const e = new Error('GlobalSim skill chart aborted');
	e.name = 'AbortError';
	return e;
}
