/**
 * Skill-optimizer shared vocabulary (SKILL-OPTIMIZER-PLAN §12). Types only —
 * no stage logic, so every module (and the UI) can import this leaf.
 */

import type { ChartRaceConditions } from '../chart';
import type { MobPreset } from '../mobs';

export type ObjectiveKind =
	/** P(1st) — mean of 1[ℓ > 0]. Default. */
	| 'p1'
	/** Mean lead margin ℓ (lengths). */
	| 'meanLead'
	/** P(top 3) — the engine's finishOrder is 0-based (winner = 0, and
	 *  compact-parity pins the sign of ℓ against finishOrder === 0), so
	 *  top-3 is finishOrder ≤ 2. */
	| 'pTop3'
	/** Mean placing, LOWER is better (sign-flipped when ranking). */
	| 'meanPlacing'
	/** Mean length gain vs the user's current build (paired ℓ difference). */
	| 'gainVsCurrent';

export type AggregationKind = 'mean' | 'maximin' | 'blend';

export type EffortPreset = 'quick' | 'standard' | 'thorough' | 'untilStopped';

/** A scenario = one (mob preset, ground, weather, …) race setup (§6.3). */
export interface ScenarioSpec {
	id: string;
	label: string;
	conds: ChartRaceConditions;
	mobPreset: MobPreset;
}

/**
 * Per-seed, per-build measured value — what the transposition table stores
 * (~40 B; the full SeedCompactRecord's tail grid is consumed by leadMarginL
 * and dropped, §7.1). Null seed = the seed errored on the engine side.
 */
export interface SeedValue {
	/** Lead margin ℓ in lengths (metrics.leadMarginL); null when the record
	 *  predates bestRivalFinishTimeRaw — such seeds are unusable and dropped
	 *  from ℓ statistics (never coerced to 0). Win/top3/placing stay valid. */
	lead: number | null;
	/** 1 when finishOrder === 0 — the engine's finishOrder is 0-based (winner = 0). */
	win: 0 | 1;
	/** 1 when finishOrder ≤ 2 (0-based finishOrder ⇒ top-3). */
	top3: 0 | 1;
	/** Human placing, 1-based (engine finishOrder + 1 ⇒ a win places 1, never 0). */
	placing: number;
	hpEmpty: 0 | 1;
	rushed: 0 | 1;
}

export interface MeanSem {
	mean: number;
	/** Standard error of the mean (sd/√n); NaN when n < 2. */
	sem: number;
	n: number;
}

/**
 * Cache slot state: measured value, 'err' (engine-errored on this seed —
 * deterministic, never refetched), or null (not evaluated yet).
 */
export type SeedSlot = SeedValue | 'err' | null;

export interface BuildStats {
	n: number;
	lead: MeanSem;
	win: MeanSem;
	top3: MeanSem;
	placing: MeanSem;
	hpEmpty: MeanSem;
	rushed: MeanSem;
}

/** A resolved candidate build: the skill ids SELECTED from the purchasable
 *  space (owned + fixed skills are implicit, space.ts owns the expansion). */
export type Selection = readonly string[];

export interface BuildRef {
	/** Simulation identity = sorted simulated skill ids joined (cache key core;
	 *  hints/costs never appear, §5). */
	id: string;
	selection: Selection;
}

/** Result row for one build, aggregated per the chosen objective/aggregation. */
export interface ScoredBuild {
	build: BuildRef;
	/** SP spent and left over (budget invariant: leftover ≥ 0). */
	sp: number;
	leftover: number;
	skillCount: number;
	/** Objective value on VERIFICATION seeds (final rows) or search seeds
	 *  (provisional rows) — the row says which via `provisional`. */
	obj: MeanSem;
	/** Secondary metrics (verification seeds on final rows). */
	stats?: BuildStats;
	/** Per-scenario objective values before aggregation (maximin bookkeeping). */
	perScenario?: { id: string; obj: MeanSem }[];
	provisional: boolean;
	/** Stage G tie flag vs the recommended build (CI of the pair diff contains 0). */
	tiedWithBest?: boolean;
}

/** Live progress events for the anytime UI (P5). */
export interface OptimizerProgress {
	stage: 'noise' | 'screen' | 'knapsack' | 'incontext' | 'local' | 'verify' | 'done' | 'stopped';
	racesRun: number;
	racesPlanned: number;
	/** Current best (search seeds, provisional) — visible within ~20 s and ever-improving. */
	best?: ScoredBuild;
	elapsedMs: number;
	etaMs?: number;
	note?: string;
}

/** Final outcome of one optimization run. */
export interface OptimizerResult {
	/** Recommended build (tie-break: most SP left, then fewer skills, §G). */
	best: ScoredBuild;
	/** Top builds incl. best, each with CIs and `tiedWithBest`. */
	shortlist: ScoredBuild[];
	noise: NoiseInfo;
	/** How many verification seeds actually ran (per scenario). */
	verificationSeeds: number;
	/** Seeds used by the search (reported honestly, never in the numbers). */
	searchSeedsPerScenario: number;
	/** True when Stop truncated the run (results are the short Stage G). */
	stoppedEarly: boolean;
	/** §C certificate: every feasible N1 move (drop, add, swap, 2-for-1, 1-for-2)
	 *  had its upper confidence bound on Δ vs the recommendation below δ_min. */
	certified1MovePeak: boolean;
	/** §C certificate: the N2 screen (2-for-2 swaps among the 8 lowest-value owned
	 *  × the 8 best free options) was also screened clean. */
	certified2MovePeak: boolean;
	/** ℓ-rank vs P(1st)-rank agreement on the shortlist (plan §6.1 debug log). */
	orderingCorrelation?: number;
}

/** §7.3 noise calibration output. */
export interface NoiseInfo {
	/** sd of per-seed ℓ of the base build. */
	sigmaLead: number;
	/** Paired sd of ℓ differences (base vs single-skill variants) — the number
	 *  seed budgets scale from. */
	sigmaDeltaLead: number;
	baseP1: number;
	nSeeds: number;
	/** Smallest difference worth chasing that this σ resolves at the preset's
	 *  verification seed count (δ_min check, §7.3). */
	resolvedDeltaL: number;
}
