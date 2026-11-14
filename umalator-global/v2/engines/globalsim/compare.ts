/**
 * GlobalSim compare-mode runner (Phase 4 core integration).
 *
 * Wires adapter.ts (HorseState → request), mobs.ts (9-runner field, per-seed
 * gate) and pool.ts (chunked, preparation-affine scheduling over N workers)
 * into the classic v2 compare flow. When engine==='globalsim',
 * app-v2.handleRunSimulation routes BOTH sides of the compare through here
 * instead of simulator.worker.ts:
 *
 *   Race A = field(seed s) with UMA 1 at the seed's gate
 *   Race B = the SAME field with UMA 2 at the SAME gate (same pairing seed)
 *
 * The mob field for a gate is built once per (variant, gate) pair — the
 * adapter validates it once and each worker prepares it once and streams
 * ≤chunkSize seeds per chunk (jobs are grouped by gate so a worker's
 * preparation changes at most 9× per variant in auto-gate mode, and 1× in
 * fixed-gate mode).
 *
 * ## Seeds (§6.3)
 *
 * `seedBase` is the user-visible 0..0xFFFFFFFF seed state; seed i is
 * `(seedBase + i · 0x9E3779B9) | 0` — signed 32-bit, deterministic, spread
 * across the range (golden-ratio stride, no clustering of neighbouring seeds).
 *
 * ## Results shape
 *
 * The returned object matches the classic CompareResults the existing
 * results pane consumes (results = sorted margin array in lengths, positive =
 * UMA 2 ahead — the umalator/compare.ts sign; runData = the four
 * representative frame-bearing snapshots) plus an additive `globalsim`
 * extension block the pane renders only for this engine (win rates, ties,
 * 95% CI, placing histograms, HP-empty/rushing rates, engine version line).
 * Panes with no GlobalSim source (stamina survival, pacer gap, posKeep/duel/
 * spot telemetry) stay in the existing per-engine unavailable state — the
 * same treatment engine v1 gets (em-dashes / frequency-gated hides).
 */

import type { HorseState } from '../../../../components/HorseDefTypes';
import { GroundCondition, Weather, Season, Time, Grade } from '../../../../uma-skill-tools/RaceParameters';
import { buildGlobalSimRequest, AdapterConfig } from './adapter';
import { buildMobField, deriveGate, MobPreset, MobError } from './mobs';
import { createGlobalsimPool, PoolJob, WorkerFactory, resolveThreadCount } from './pool';
import {
	SeedCompactRecord, FullRunData, CompareAggregate, newAggregate, addPair,
	summarizeAggregate, CompareSummary, representativeSeeds, buildSnapshotHalf,
} from './metrics';

export const GLOBALSIM_ENGINE_VERSION = 'v77';
/** GlobalSim's validated table size (vendor/GlobalSim/data/v70-skill-data.json). */
export const V70_SKILL_TABLE_SIZE = 730;
/** §4.1: jobs split into ~25-seed chunks. */
export const DEFAULT_CHUNK_SIZE = 25;

/** "GlobalSim v77 · skill table v70 + 21 supplement" (N = coverage set − 730). */
export function globalsimEngineLine(coverageSetSize?: number): string {
	const suffix = typeof coverageSetSize === 'number' && coverageSetSize >= V70_SKILL_TABLE_SIZE
		? ` + ${coverageSetSize - V70_SKILL_TABLE_SIZE} supplement` : '';
	return `GlobalSim ${GLOBALSIM_ENGINE_VERSION} · skill table v70${suffix}`;
}

/** Deterministic signed-32-bit seed list from the user-visible base (§6.3). */
export function globalsimSeedList(baseSeed: number, count: number): number[] {
	const base = baseSeed >>> 0;
	const out = new Array<number>(count);
	for (let i = 0; i < count; i++) out[i] = (base + Math.imul(i, 0x9E3779B9)) | 0;
	return out;
}

/** FNV-1a hash (base36) — shared with chart.ts for setupKey building. */
export function hashString(s: string): string {
	let h = 0x811C9DC5;
	for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
	return (h >>> 0).toString(36);
}

export interface GlobalsimCompareInput {
	uma1: HorseState;
	uma2: HorseState;
	courseId: string | number;
	/** Race distance in metres (margin = metres / 2.5, the classic unit). */
	distance: number;
	ground: GroundCondition;
	weather: Weather;
	season: Season;
	time: Time;
	grade?: Grade;
	/** Active GlobalSim skill table keys — the adapter's coverage gate (D5). */
	knownSkillIds?: ReadonlySet<string>;
	/**
	 * Merged active skill table (engine skillData, from /uma-tools/globalsim/
	 * skills.json). When set, requests omit the table and the pool injects it
	 * once per worker — required for the batch-1 supplement skills to
	 * initialize in the engine (profile-v77's own skillData is v70-only).
	 */
	skillData?: Record<string, unknown>;
	/** Valid engine course ids (courses.ts loader). */
	courseIds: ReadonlySet<string> | readonly string[];
	mobPreset: MobPreset;
	/** Force every seed's tested-uma gate; omit for the seed-derived draw. */
	fixedGate?: number;
	seedBase: number;
	sampleCount: number;
	threads?: number;
	chunkSize?: number;
	/** Worker factory — app-v2 provides the bundler-resolved worker URL. */
	workerFactory: WorkerFactory;
	/** Called with a classic-shaped partial result after every chunk. */
	onProgress?: (partial: GlobalsimCompareResults) => void;
}

/** The `globalsim` extension block (rendered by results-pane when present). */
export interface GlobalsimStatsBlock {
	engineLine: string;
	ci95: [number, number];
	winRateUma1: number; winRateUma2: number; tieRate: number;
	placing1: number[]; placing2: number[];
	hpEmptyRate1: number; hpEmptyRate2: number;
	rushingRate1: number; rushingRate2: number;
	methodCounts: CompareAggregate['methodCounts'];
	seedErrors: number;
	jobErrors: Array<{ jobId: string; error: string }>;
	threads: number;
	elapsedMs: number;
	distanceM: number;
	sampleCount: number;   // target
	doneSeeds: number;     // paired so far
}

/** Classic CompareResults shape + the additive globalsim block (see file header). */
export interface GlobalsimCompareResults {
	results: number[];                       // sorted margins, lengths, positive = UMA 2 ahead
	runData: {
		minrun: unknown | null; maxrun: unknown | null; meanrun: unknown | null; medianrun: unknown | null;
		allruns?: unknown;
	};
	staminaStats?: unknown;                  // undefined → em-dashes (v1 precedent)
	firstUmaStats?: unknown;
	globalsim: GlobalsimStatsBlock;
}

export interface BuiltJobs { jobs: PoolJob[]; errors: string[] }

/**
 * Gate groups → per-variant chunk jobs (mode 'compact' for sampling, 'full'
 * for the representative runs). Exported for the pool scheduler tests. A
 * setupKey covers everything a preparation depends on (roster/skills/course/
 * gate + conditions); the request's large skillData block is a build constant
 * derived from the mode, so hashing conditions + the emitted horses array is
 * sufficient and cheap.
 */
export function buildCompareJobs(
	input: GlobalsimCompareInput,
	seeds: number[],
	mode: 'compact' | 'full',
): BuiltJobs {
	const chunkSize = input.chunkSize ?? DEFAULT_CHUNK_SIZE;
	const groups = new Map<number, number[]>();
	for (const s of seeds) {
		const g = input.fixedGate ?? deriveGate(s);
		const arr = groups.get(g);
		if (arr) arr.push(s); else groups.set(g, [s]);
	}
	const jobs: PoolJob[] = [];
	const errors: string[] = [];
	const config: AdapterConfig = { courseIds: input.courseIds, knownSkillIds: input.knownSkillIds, skillData: input.skillData ? null : undefined };
	for (const variant of [0, 1] as const) {
		const horse = variant === 0 ? input.uma1 : input.uma2;
		for (const [gate, groupSeeds] of groups) {
			const { mobs, errors: mobErrors } = buildMobField(input.mobPreset, 0, { fixedGate: gate });
			if (mobErrors.length) {
				errors.push(...mobErrors.map((e: MobError) => `mob field gate ${gate}: ${e.field} ${e.message}`));
				continue;
			}
			// The adapter takes ONE HorseState per player; mobs are already
			// GlobalSimRunner objects, so we bypass the HorseState path for them
			// by handing the player through toGlobalSimRequest and splicing the
			// mobs into canonical order afterwards. To keep determinism we let
			// the adapter emit the player (gate g) and re-order with the mobs by
			// ascending gateIndex (matching adapter's canonical field order).
			const res = buildGlobalSimRequest({
				courseId: input.courseId,
				groundCondition: input.ground, weather: input.weather, season: input.season, time: input.time,
				grade: input.grade,
				seed: groupSeeds[0],           // placeholder; run(seed) overrides per seed
				// Only the player is a HorseState here; mobs ride in raw (they
				// already satisfy the runner contract). buildGlobalSimRequest
				// validates the player; mobs were validated by buildMobField.
				runners: [{ horse, gateIndex: gate, isPlayer: true }],
			}, config);
			if (res.ok !== true) {
				errors.push(`gate ${gate} variant ${variant + 1}: ${res.errors.map(e => `${e.field}: ${e.message}`).join('; ')}`);
				continue;
			}
			const player = (res.value as any).horses[0];
			const merged = mergeCanonicalField(player, gate, mobs);
			const request = { ...(res.value as any), horses: merged.horses, playerHorseIndex: merged.playerIndex };
			const setupKey = `gs|${mode}|v${variant}|c${input.courseId}|g${gate}|${hashString(JSON.stringify({ g: input.ground, w: input.weather, s: input.season, t: input.time, gr: input.grade ?? null, h: request.horses }))}`;
			for (let c = 0; c < groupSeeds.length; c += chunkSize) {
				jobs.push({
					id: `${variant}|${gate}|${c}`,
					setupKey,
					request,
					seeds: groupSeeds.slice(c, c + chunkSize),
					mode,
				});
			}
		}
	}
	return { jobs, errors };
}

/** Player + mobs in canonical ascending-gateIndex order (adapter's rule, §6.1). */
export function mergeCanonicalField(player: any, playerGate: number, mobs: any[]): { horses: any[]; playerIndex: number } {
	const rows = [{ ...player, gateIndex: playerGate }, ...mobs];
	rows.sort((a, b) => a.gateIndex - b.gateIndex);
	return { horses: rows, playerIndex: rows.findIndex(r => r.gateIndex === playerGate) };
}

/** Combine the two races' player frame arrays into the classic pair snapshot. */
function combineSnapshot(a: FullRunData, b: FullRunData, distanceM: number): unknown {
	const ha = buildSnapshotHalf(a, distanceM);
	const hb = buildSnapshotHalf(b, distanceM);
	// The classic RaceSnapshot (results-pane.tsx): per-runner index arrays.
	// Index 0 = UMA 1 (race A frames), index 1 = UMA 2 (race B frames);
	// velocity-overlay scales/paths each index independently. Telemetry with
	// no GlobalSim source is empty so frequency-gated sections hide (v1
	// precedent).
	return {
		t: [ha.t, hb.t],
		p: [ha.p, hb.p],
		v: [ha.v, hb.v],
		hp: [ha.hp, hb.hp],
		sk: [ha.sk, hb.sk],
		sdly: [ha.sdly, hb.sdly],
		rushed: [[], []],
		posKeep: [[], []],
		competeFight: [[0, 0], [0, 0]],
		leadCompetition: [[0, 0], [0, 0]],
		downhillActivations: [[], []],
	};
}

/** Build a classic-shaped result (partial during the run, final at the end). */
function buildResults(
	margins: number[],
	s: CompareSummary,
	input: GlobalsimCompareInput,
	runData: { min: unknown | null; max: unknown | null; mean: unknown | null; median: unknown | null },
	jobErrors: Array<{ jobId: string; error: string }>,
	elapsedMs: number,
	doneSeeds: number,
): GlobalsimCompareResults {
	return {
		// results-pane computes its own min/max/mean/median from this array
		// (calcStats sorts defensively — order-independent, matching how the
		// classic progressive results arrive).
		results: margins,
		runData: {
			minrun: runData.min, maxrun: runData.max, meanrun: runData.mean, medianrun: runData.median,
		},
		staminaStats: undefined,
		firstUmaStats: undefined,
		globalsim: {
			engineLine: globalsimEngineLine(input.knownSkillIds ? input.knownSkillIds.size : undefined),
			ci95: s.ci95,
			winRateUma1: s.winRateUma1, winRateUma2: s.winRateUma2, tieRate: s.tieRate,
			placing1: s.placing1, placing2: s.placing2,
			hpEmptyRate1: s.hpEmptyRate1, hpEmptyRate2: s.hpEmptyRate2,
			rushingRate1: s.rushingRate1, rushingRate2: s.rushingRate2,
			methodCounts: s.methodCounts,
			seedErrors: s.seedErrors,
			jobErrors,
			threads: input.threads ?? 0,
			elapsedMs,
			distanceM: input.distance,
			sampleCount: input.sampleCount,
			doneSeeds,
		},
	};
}

/**
 * The runner. Streams classic-shaped partial results via onProgress (so the
 * EXISTING pane keeps painting during the run with the running 95% CI), then
 * re-runs the min / median / mean / max margin seeds with frames for the
 * track + velocity/HP overlay, and resolves the final result.
 */
export async function runGlobalsimCompare(input: GlobalsimCompareInput): Promise<GlobalsimCompareResults> {
	const startedAt = Date.now();
	const seeds = globalsimSeedList(input.seedBase, input.sampleCount);
	const threads = input.threads ?? resolveThreadCount();
	input = { ...input, threads };

	// ── sampling pass (compact per-seed records) ─────────────────────────────
	const { jobs, errors: buildErrors } = buildCompareJobs(input, seeds, 'compact');
	if (buildErrors.length) throw new Error(buildErrors.join('\n'));

	const agg = newAggregate();
	const marginBySeed = new Map<number, number>();       // seed → its pair margin (lengths)
	const margins: number[] = [];
	const pending = new Map<number, { a?: SeedCompactRecord; b?: SeedCompactRecord }>();
	let lastPaintAt = 0;

	const paint = (jobErrors: Array<{ jobId: string; error: string }>, runData: { min: unknown | null; max: unknown | null; mean: unknown | null; median: unknown | null }, elapsed: number) => {
		const s = summarizeAggregate(agg);
		const partial = buildResults(margins, s, input, runData, jobErrors, elapsed, margins.length);
		input.onProgress?.(partial);
		return partial;
	};

	const pairIfReady = (seed: number) => {
		const slot = pending.get(seed);
		if (!slot || !slot.a || !slot.b) return;
		pending.delete(seed);
		const a = slot.a, b = slot.b;
		if (a.error || b.error) { addPair(agg, a, b, input.distance); return; }
		addPair(agg, a, b, input.distance);
		const m = agg.margins[agg.margins.length - 1];
		marginBySeed.set(seed, m);
		margins.push(m);
	};
	const onRecord = (job: PoolJob, records: any[]) => {
		const side = job.id.startsWith('1|') ? 'b' : 'a';
		for (const r of records as SeedCompactRecord[]) {
			const slot = pending.get(r.seed) || {};
			slot[side] = r;
			pending.set(r.seed, slot);
			pairIfReady(r.seed);
		}
		// Streaming paint (plan §4.1): the pane re-renders with the running
		// aggregates as chunks land, throttled so JSON work never dominates.
		const now = Date.now();
		if (margins.length > 0 && now - lastPaintAt >= 100) {
			lastPaintAt = now;
			paint([], { min: null, max: null, mean: null, median: null }, now - startedAt);
		}
	};

	const pool = createGlobalsimPool({
		factory: input.workerFactory,
		threads,
		skillData: input.skillData,
		onChunk: onRecord,
	});
	let jobErrors: Array<{ jobId: string; error: string }> = [];
	try {
		const res = await pool.runJobs(jobs);
		jobErrors = res.errors;
	} finally {
		pool.dispose();
	}
	if (agg.n === 0) {
		const detail = jobErrors.slice(0, 3).map(e => `${e.jobId}: ${e.error}`).join(' | ');
		throw new Error(`GlobalSim sampling produced no results (${agg.seedErrors} seed errors${detail ? `; ${detail}` : ''})`);
	}
	paint(jobErrors, { min: null, max: null, mean: null, median: null }, Date.now() - startedAt);

	// ── representative runs (frame-bearing, for track + velocity/HP overlay) ─
	const reps = representativeSeeds(marginBySeed);
	const repSeeds = [...new Set(Object.values(reps).filter(s => Number.isFinite(s)))];
	const repJobs = buildCompareJobs(input, repSeeds, 'full').jobs;
	const fullA = new Map<number, FullRunData>();
	const fullB = new Map<number, FullRunData>();
	if (repJobs.length) {
		const repPool = createGlobalsimPool({
			factory: input.workerFactory,
			threads,
			onChunk: (job, records) => {
				const target = job.id.startsWith('1|') ? fullB : fullA;
				for (const r of records as FullRunData[]) if (!r.error) target.set(r.seed, r);
			},
		});
		try {
			const repErrors = await repPool.runJobs(repJobs);
			if (repErrors.errors.length) console.warn('[GlobalSim] representative runs failed:', repErrors.errors);
		} finally { repPool.dispose(); }
	}
	const snapshotFor = (seed: number): unknown | null => {
		const a = fullA.get(seed), b = fullB.get(seed);
		return a && b ? combineSnapshot(a, b, input.distance) : null;
	};
	const runData = {
		min: snapshotFor(reps.min), max: snapshotFor(reps.max),
		mean: snapshotFor(reps.mean), median: snapshotFor(reps.median),
	};

	return paint(jobErrors, runData, Date.now() - startedAt);
}
