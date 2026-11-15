/**
 * Skill-optimizer tunables (SKILL-OPTIMIZER-PLAN §11) — one config object per
 * effort preset. Everything the search pipeline sizes itself with lives here;
 * stages read config, never magic numbers.
 *
 * Effort presets (plan §11 table, verbatim):
 *
 * |              | Quick          | Standard (default)   | Thorough            |
 * | δ_min (L)    | 0.05           | 0.03                 | 0.02                |
 * | K restarts   | 1              | 3                    | 5                   |
 * | D_MAX_ITERS  | 1              | 4                    | 6                   |
 * | Beam B       | —              | —                    | 6                   |
 * | G seeds      | 1,000 / 2,000  | 3,000 / 10,000       | 5,000 / 20,000      |
 * | batch cap    | 2,000          | 5,000                | 10,000              |
 * | surrogate    | off            | on                   | on                  |
 *
 * `untilStopped` runs at Thorough sizes with no wall-clock deadline: the loop
 * keeps iterating local search and extends Stage G verification up to
 * gSeedsCap while Stop has not been pressed (P5 anytime + the user's
 * "refine for longer if the user waits" goal).
 */

import type { AggregationKind, EffortPreset, ObjectiveKind } from './types';

export interface EffortConfig {
	preset: EffortPreset;
	/** Smallest improvement worth chasing / reporting as not-a-tie, in lengths. */
	deltaMinL: number;
	/** Stage C restart points (K near-optimal knapsack starts). */
	restarts: number;
	/** Stage D re-pick rounds. */
	dMaxIters: number;
	/** Stage F local-search rounds per restart (0 = Stage F off, as in Quick). */
	fMaxRounds: number;
	/** Stage F beam width (0 = plain hill climb). */
	beam: number;
	/** Stage G verification seeds: minimum per scenario, then hard cap. */
	gSeedsMin: number;
	gSeedsCap: number;
	/** Per-batch (bandit) seed cap per candidate group. */
	batchCap: number;
	/** Stage E surrogate on/off (plan: off for Quick). */
	surrogate: boolean;
	/** Wall-clock guidance in ms (Infinity for untilStopped). The pipeline
	 *  prefers finishing a stage over hard-cancelling mid-comparison. */
	timeBudgetMs: number;
	/** Stage B screening (chart-parity two-round sizes). */
	screenRound1Seeds: number;
	screenRound2Seeds: number;
	/** Round-1 keep filter, chart-parity (lengths). */
	screenFilterMaxL: number;
	screenFilterSpreadL: number;
	/** §7.3 noise calibration seeds (base + ~4 variants → ~2k races). */
	noiseSeeds: number;
	noiseVariants: number;
}

const SCREEN_COMMON = {
	// Chart-parity (§8 Stage B reuses the chart's two-round filter): 25 + 175.
	screenRound1Seeds: 25,
	screenRound2Seeds: 175,
	screenFilterMaxL: 0.1,
	screenFilterSpreadL: 0.1,
	noiseSeeds: 400,
	noiseVariants: 4,
};

export const QUICK: EffortConfig = {
	preset: 'quick',
	deltaMinL: 0.05, restarts: 1, dMaxIters: 1, fMaxRounds: 0, beam: 0,
	gSeedsMin: 1000, gSeedsCap: 2000, batchCap: 2000, surrogate: false,
	timeBudgetMs: 60_000, ...SCREEN_COMMON,
};

export const STANDARD: EffortConfig = {
	preset: 'standard',
	deltaMinL: 0.03, restarts: 3, dMaxIters: 4, fMaxRounds: 3, beam: 0,
	gSeedsMin: 3000, gSeedsCap: 10000, batchCap: 5000, surrogate: true,
	timeBudgetMs: 5 * 60_000, ...SCREEN_COMMON,
};

export const THOROUGH: EffortConfig = {
	preset: 'thorough',
	deltaMinL: 0.02, restarts: 5, dMaxIters: 6, fMaxRounds: 4, beam: 6,
	gSeedsMin: 5000, gSeedsCap: 20000, batchCap: 10000, surrogate: true,
	timeBudgetMs: 20 * 60_000, ...SCREEN_COMMON,
};

/** Thorough sizes, no deadline, verification grows to the cap. */
export const UNTIL_STOPPED: EffortConfig = {
	preset: 'untilStopped',
	deltaMinL: 0.02, restarts: 5, dMaxIters: 6, fMaxRounds: 4, beam: 6,
	gSeedsMin: 5000, gSeedsCap: 20000, batchCap: 10000, surrogate: true,
	timeBudgetMs: Infinity, ...SCREEN_COMMON,
};

export function effortConfig(preset: EffortPreset): EffortConfig {
	switch (preset) {
		case 'quick': return QUICK;
		case 'thorough': return THOROUGH;
		case 'untilStopped': return UNTIL_STOPPED;
		case 'standard':
		default: return STANDARD;
	}
}

// ── global tunables (§11, bottom line) ───────────────────────────────────────

/** Pool chunk size for bulk stages (DEFAULT_CHUNK_SIZE parity). */
export const CHUNK_SIZE = 25;
/** Finer chunks inside bandit batches (§7.2: "can drop to 10"). */
export const BANDIT_CHUNK_SIZE = 10;
/** Bandit first allocation per candidate (§9: "start each candidate at 50 seeds"). */
export const BANDIT_START_SEEDS = 50;
/** Successive-halving ladder inside bandit batches (§9). */
export const BANDIT_LADDER = [50, 100, 200, 400, 800, 1600, 3200];
/** Stage E acquisition κ (predicted gain + κ·SE). */
export const KAPPA = 1.5;
/** Pruning optimism factor (alpha-beta cutoff with error bars). */
export const PRUNE_KAPPA = 2;
/** Blend aggregation λ: (1−λ)·mean + λ·min. */
export const LAMBDA_MAXIMIN = 0.3;
/** Transposition-table byte budget (§7.1: ~100 MB, ~50 B/seed-record). */
export const CACHE_CAP_BYTES = 100 * 1024 * 1024;
/** Eviction exempt: the current top-N build keys stay cached. */
export const CACHE_PIN_TOP = 50;
/** Stage E: refit the surrogate every N new evaluated builds. */
export const SURROGATE_REFIT_EVERY = 20;
/** Stage E: min co-occurrences in cache before a pair term is considered. */
export const SURROGATE_PAIR_MIN_COOC = 8;
/** Stage E: pair-term cap (~300, plan). */
export const SURROGATE_PAIR_CAP = 300;
/** Stage E: below this holdout R² the surrogate stops driving ordering. */
export const SURROGATE_MIN_R2 = 0.3;
/** Verification-seed disjointness margin check (P3) — overlap assert helper. */
export const VERIFY_SALT = 0x51ed27e1;
/** localStorage key: opening book (Stage A). */
export const BOOK_STORAGE_KEY = 'umalator_v2_optimizer_book';

/** Defaults the pane pre-selects (plan: default objective P(1st), mean aggregation). */
export const DEFAULT_OBJECTIVE: ObjectiveKind = 'p1';
export const DEFAULT_AGGREGATION: AggregationKind = 'mean';
export const DEFAULT_EFFORT: EffortPreset = 'standard';
