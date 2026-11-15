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
 * Head-to-head layout (input.fieldLayout === 'h2h'): both umas share ONE
 * race against the preset's first 7 mobs, on the seed's adjacent gate pair
 * (g, g+1) — race A with UMA 1 at g, race B mirrored with UMA 2 at g. The
 * per-seed margin is the average of the two races' margins, so stall residue
 * cancels and every interference (debuffs, blocking, duels) between the two
 * builds is inside the measurement. 2 races per seed.
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
 * results pane consumes (results = the margin array in lengths, appended in
 * chunk-arrival order — unsorted; consumers such as the results pane re-sort
 * it; positive = UMA 2 ahead — the umalator/compare.ts sign; runData = the
 * four representative frame-bearing snapshots) plus an additive `globalsim`
 * extension block the pane renders only for this engine (win rates, ties,
 * 95% CI, placing histograms, HP-empty/rushing rates, engine version line).
 * Panes with no GlobalSim source (stamina survival, pacer gap, posKeep/duel/
 * spot telemetry) stay in the existing per-engine unavailable state — the
 * same treatment engine v1 gets (em-dashes / frequency-gated hides).
 */

import type { HorseState } from '../../../../components/HorseDefTypes';
import { GroundCondition, Weather, Season, Time, Grade } from '../../../../uma-skill-tools/RaceParameters';
import { buildGlobalSimRequest, toGlobalSimRunner, AdapterConfig } from './adapter';
import { buildMobField, buildH2hMobField, deriveGate, deriveGatePair, FIELD_SIZE, MobPreset, MobError } from './mobs';
import { createGlobalsimPool, PoolJob, WorkerFactory, resolveThreadCount } from './pool';
import {
	SeedCompactRecord, FullRunData, CompareAggregate, newAggregate, addPair, addPairH2H,
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

/**
 * FNV-1a hash (base36). Kept exported unchanged (seed pairing never used
 * it — globalsimSeedList derives the seed list). The setupKey identity uses
 * hashString64 below.
 */
export function hashString(s: string): string {
	let h = 0x811C9DC5;
	for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
	return (h >>> 0).toString(36);
}

/**
 * 64-bit-equivalent preparation fingerprint for setupKey identity (base36).
 *
 * pool.ts dispatch (pool.ts:250/254) reuses a worker's live preparation on
 * setupKey equality ALONE, so the hash must be collision-free at chart
 * scale: a big chart is ~2700 distinct preparations, and a bare 32-bit key
 * collides with birthday probability ~2700²/2³³ ≈ 8.5e-4 per run — one
 * skill's seeds would silently run on another preparation's field. This
 * computes a second FNV-1a over the same string with a different offset
 * basis (the FNV-1 basis 0xCBF43926, same prime), and returns both hashes
 * as fixed-width zero-padded base36 concatenated (7 chars ≥ 36⁷ > 2³², so
 * the pair is unambiguously recoverable from the string). Same canonical
 * string in, same fingerprint out — determinism preserved.
 */
export function hashString64(s: string): string {
	let h1 = 0x811C9DC5, h2 = 0xCBF43926;
	for (let i = 0; i < s.length; i++) {
		h1 ^= s.charCodeAt(i); h1 = Math.imul(h1, 0x01000193);
		h2 ^= s.charCodeAt(i); h2 = Math.imul(h2, 0x01000193);
	}
	return (h1 >>> 0).toString(36).padStart(7, '0') + (h2 >>> 0).toString(36).padStart(7, '0');
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
	/**
	 * Compare field layout:
	 *   'mob' (default) — each uma runs isolated against the full 8-mob field;
	 *   'h2h'          — UMA 1 and UMA 2 share every race against 7 mobs, on
	 *     mirrored adjacent-gate pairs (2 races per seed, averaged margin) so
	 *     they can genuinely interfere (debuffs, blocking, duels).
	 */
	fieldLayout?: GlobalsimFieldLayout;
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
	fieldLayout: GlobalsimFieldLayout;
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

export type GlobalsimFieldLayout = 'mob' | 'h2h';

/**
 * Gate pair for one seed under the head-to-head layout: the base gate from
 * the seed (or the fixed gate) plus the adjacent gate. fixedGate semantics:
 * with a fixed gate g, race A always starts UMA 1 at g and UMA 2 at g+1
 * (mod 9), and race B swaps them.
 */
function h2hGates(seed: number, fixedGate: number | undefined): [number, number] {
	if (fixedGate !== undefined) return [fixedGate, (fixedGate + 1) % FIELD_SIZE];
	return deriveGatePair(seed);
}

/**
 * Player + player + 7 mobs in canonical ascending-gateIndex order. Returns
 * the post-sort indices of the primary and secondary player.
 */
export function mergeH2hField(
	primary: any, secondary: any, mobs: any[],
): { horses: any[]; playerIndex: number; secondPlayerIndex: number } {
	const rows = [...mobs, primary, secondary];
	rows.sort((a: any, b: any) => a.gateIndex - b.gateIndex);
	return {
		horses: rows,
		playerIndex: rows.indexOf(primary),
		secondPlayerIndex: rows.indexOf(secondary),
	};
}

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
	const layout: GlobalsimFieldLayout = input.fieldLayout ?? 'mob';
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
		for (const [gate, groupSeeds] of groups) {
			if (layout === 'h2h') {
				// Head-to-head race: variant 0 = UMA 1 @ g, UMA 2 @ g+1;
				// variant 1 = the mirrored gate swap. Same seed ⇒ same pair,
				// so the two races of a seed differ ONLY in who holds which
				// adjacent stall.
				const [gA, gB] = h2hGates(groupSeeds[0], input.fixedGate);
				const primaryHorse = variant === 0 ? input.uma1 : input.uma2;
				const secondaryHorse = variant === 0 ? input.uma2 : input.uma1;
				const { mobs, errors: mobErrors } = buildH2hMobField(input.mobPreset, gA, gB);
				if (mobErrors.length) {
					errors.push(...mobErrors.map((e: MobError) => `h2h field gates ${gA}/${gB}: ${e.field} ${e.message}`));
					continue;
				}
				const res = buildGlobalSimRequest({
					courseId: input.courseId,
					groundCondition: input.ground, weather: input.weather, season: input.season, time: input.time,
					grade: input.grade,
					seed: groupSeeds[0],
					runners: [{ horse: primaryHorse, gateIndex: gA, isPlayer: true }],
				}, config);
				if (res.ok !== true) {
					errors.push(`gates ${gA}/${gB} variant ${variant + 1}: ${res.errors.map(e => `${e.field}: ${e.message}`).join('; ')}`);
					continue;
				}
				const secondaryRes = toGlobalSimRunner(secondaryHorse, gB, config, 'secondaryPlayer');
				if (secondaryRes.ok !== true) {
					errors.push(`gates ${gA}/${gB} variant ${variant + 1}: ${secondaryRes.errors.map(e => `${e.field}: ${e.message}`).join('; ')}`);
					continue;
				}
				const primary = (res.value as any).horses[0];
				const merged = mergeH2hField(primary, secondaryRes.value, mobs);
				const request = {
					...(res.value as any),
					horses: merged.horses,
					playerHorseIndex: merged.playerIndex,
				};
				const setupKey = `gs|${mode}|h2h|v${variant}|c${input.courseId}|g${gA}+${gB}|${hashString64(JSON.stringify({ g: input.ground, w: input.weather, s: input.season, t: input.time, gr: input.grade ?? null, h: request.horses }))}`;
				for (let c = 0; c < groupSeeds.length; c += chunkSize) {
					jobs.push({
						id: `${variant}|${gate}|${c}`,
						setupKey,
						request,
						seeds: groupSeeds.slice(c, c + chunkSize),
						mode,
						secondPlayerIndex: merged.secondPlayerIndex,
					});
				}
				continue;
			}
			const horse = variant === 0 ? input.uma1 : input.uma2;
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
			const setupKey = `gs|${mode}|v${variant}|c${input.courseId}|g${gate}|${hashString64(JSON.stringify({ g: input.ground, w: input.weather, s: input.season, t: input.time, gr: input.grade ?? null, h: request.horses }))}`;
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
			fieldLayout: input.fieldLayout ?? 'mob',
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
	const layout: GlobalsimFieldLayout = input.fieldLayout ?? 'mob';

	// ── sampling pass (compact per-seed records) ─────────────────────────────
	const { jobs, errors: buildErrors } = buildCompareJobs(input, seeds, 'compact');
	if (buildErrors.length) throw new Error(buildErrors.join('\n'));

	const agg = newAggregate();
	const marginBySeed = new Map<number, number>();       // seed → its pair margin (lengths)
	const margins: number[] = [];
	const pending = new Map<number, { a?: SeedCompactRecord; b?: SeedCompactRecord }>();
	let lastPaintAt = 0;

	const paint = (jobErrors: Array<{ jobId: string; error: string }>, runData: { min: unknown | null; max: unknown | null; mean: unknown | null; median: null | unknown }, elapsed: number) => {
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
		if (layout === 'h2h') {
			// Race A: primary = UMA 1, opp = UMA 2. Race B (mirrored gates):
			// primary = UMA 2, opp = UMA 1. addPairH2H reshapes per-race error
			// counting itself.
			const a2: SeedCompactRecord = a.opp ? { seed, ...a.opp } : { seed, error: 'race A reply missing second player' };
			const b1: SeedCompactRecord = b.opp ? { seed, ...b.opp } : { seed, error: 'race B reply missing second player' };
			const nBefore = agg.n;
			addPairH2H(agg, [a, a2], [b1, b], input.distance);
			if (agg.n > nBefore) {
				const m = agg.margins[agg.margins.length - 1];
				marginBySeed.set(seed, m);
				margins.push(m);
			}
			return;
		}
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
	const repJobsAll = buildCompareJobs(input, repSeeds, 'full').jobs;
	// Head-to-head race A already holds BOTH players' frames — only the
	// variant-0 (unmirrored) job is needed for the snapshot.
	const repJobs = layout === 'h2h' ? repJobsAll.filter(j => !j.id.startsWith('1|')) : repJobsAll;
	const fullA = new Map<number, FullRunData>();
	const fullB = new Map<number, FullRunData>();
	if (repJobs.length) {
		const repPool = createGlobalsimPool({
			factory: input.workerFactory,
			threads,
			// Same table injection as the sampling pool: these requests also
			// omit skillData (buildCompareJobs config.skillData === null), so a
			// rep worker without the injection silently falls back to the
			// engine's legacy bundled table (diverged finishes; prepare fails
			// 'Missing retail initialization field' on supplement ids).
			skillData: input.skillData,
			onChunk: (job, records) => {
				const target = job.id.startsWith('1|') ? fullB : fullA;
				for (const r of records as FullRunData[]) if (!r.error) target.set(r.seed, r);
			},
		});
		try {
			const repErrors = await repPool.runJobs(repJobs);
			if (repErrors.errors.length) console.warn('[GlobalSim] representative runs failed (check the rep pool skill-table injection):', repErrors.errors);
		} finally { repPool.dispose(); }
	}
	const snapshotFor = (seed: number): unknown | null => {
		const a = fullA.get(seed);
		if (layout === 'h2h') {
			// One race, both players: UMA 1 is the primary, UMA 2 the opp.
			return a && a.opp ? combineSnapshot(a, { seed, ...a.opp }, input.distance) : null;
		}
		const b = fullB.get(seed);
		return a && b ? combineSnapshot(a, b, input.distance) : null;
	};
	const runData = {
		min: snapshotFor(reps.min), max: snapshotFor(reps.max),
		mean: snapshotFor(reps.mean), median: snapshotFor(reps.median),
	};

	return paint(jobErrors, runData, Date.now() - startedAt);
}
