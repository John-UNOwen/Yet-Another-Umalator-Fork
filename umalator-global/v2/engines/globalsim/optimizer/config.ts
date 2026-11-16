/**
 * Skill-optimizer tunables (SKILL-OPTIMIZER-PLAN §11) — one config object per
 * effort preset. Everything the search pipeline sizes itself with lives here;
 * stages read config, never magic numbers.
 *
 * Effort presets (plan §11 table; G seeds and batch cap re-sized from the
 * paired noise record, README.md 2026-11-16 — the presets run paired):
 *
 * |              | Quick        | Standard (default) | Thorough          |
 * | δ_min (L)    | 0.05         | 0.03               | 0.02              |
 * | K restarts   | 1            | 3                  | 5                 |
 * | D_MAX_ITERS  | 1            | 4                  | 6                 |
 * | Beam B       | —            | —                  | 6                 |
 * | G seeds      | 200 / 800    | 500 / 2,000        | 1,000 / 4,000     |
 * | batch cap    | 400          | 1,000              | 2,000             |
 * | surrogate    | off          | on                 | on                |
 *
 * `untilStopped` runs at Thorough sizes with no wall-clock deadline: the loop
 * keeps iterating local search and extends Stage G verification up to
 * gSeedsCap while Stop has not been pressed (P5 anytime + the user's
 * "refine for longer if the user waits" goal).
 */

import type { AggregationKind, EffortPreset, ObjectiveKind } from './types';

export interface EffortConfig {
	preset: EffortPreset;
	/** Smallest improvement worth chasing / reporting as not-a-tie, in lengths.
	 *  A judgment floor, not a noise size, so the paired re-size left it alone. */
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
	// Kept for chart parity; at the paired σΔ = 0.16 L the round-1 SE is
	// 0.16/√25 = 0.032 L, already at the Standard δ_min.
	screenRound1Seeds: 25,
	screenRound2Seeds: 175,
	// Round-1 keep filter, chart-parity (lengths). Paired measurement (README
	// 2026-11-16): never-firing adds have σΔ exactly 0 (6/12), so the 0.1 L sd
	// floor filters them while active adds (σΔ = 0.16 L) pass.
	screenFilterMaxL: 0.1,
	screenFilterSpreadL: 0.1,
	// §7.3 noise calibration seeds (base + ~4 variants → ~2k races). Kept at
	// 400: σ̂ carries ~3.5% relative error (1/√2n) at any σ, and the seeds are
	// reused from cache by Stage B.
	noiseSeeds: 400,
	noiseVariants: 4,
};

export const QUICK: EffortConfig = {
	preset: 'quick',
	deltaMinL: 0.05, restarts: 1, dMaxIters: 1, fMaxRounds: 0, beam: 0,
	// Paired record σΔ = 0.16 L: (2·1.96·0.16/0.05)² = 158 seeds resolve δ_min,
	// rounded up to 200; the cap is 4× (resolves δ_min/2), batchCap 2× per
	// candidate for multiple-comparison slack.
	gSeedsMin: 200, gSeedsCap: 800, batchCap: 400, surrogate: false,
	timeBudgetMs: 60_000, ...SCREEN_COMMON,
};

export const STANDARD: EffortConfig = {
	preset: 'standard',
	deltaMinL: 0.03, restarts: 3, dMaxIters: 4, fMaxRounds: 3, beam: 0,
	// Same sizing as Quick at δ_min = 0.03: (2·1.96·0.16/0.03)² = 437, rounded
	// up to 500; cap 4× (0.014 L), batchCap 2×.
	gSeedsMin: 500, gSeedsCap: 2000, batchCap: 1000, surrogate: true,
	timeBudgetMs: 5 * 60_000, ...SCREEN_COMMON,
};

export const THOROUGH: EffortConfig = {
	preset: 'thorough',
	deltaMinL: 0.02, restarts: 5, dMaxIters: 6, fMaxRounds: 4, beam: 6,
	// Same sizing at δ_min = 0.02: (2·1.96·0.16/0.02)² = 983, rounded up to
	// 1000; cap 4× (0.010 L), batchCap 2×.
	gSeedsMin: 1000, gSeedsCap: 4000, batchCap: 2000, surrogate: true,
	timeBudgetMs: 20 * 60_000, ...SCREEN_COMMON,
};

/** Thorough sizes, no deadline, verification grows to the cap. */
export const UNTIL_STOPPED: EffortConfig = {
	preset: 'untilStopped',
	deltaMinL: 0.02, restarts: 5, dMaxIters: 6, fMaxRounds: 4, beam: 6,
	// THOROUGH's sizes (paired record, see its comment), unbounded in time.
	gSeedsMin: 1000, gSeedsCap: 4000, batchCap: 2000, surrogate: true,
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
/** Bandit alive cap (§D.4). A backstop, not the sizing: the indifference
 *  zone (§D.1) drops every candidate whose UCB on Δ vs the incumbent falls
 *  under δ_min, and that is what bounds the alive set. Sized on the paired
 *  record (README 2026-11-16: σΔ = 0.16 L, race part 0.76 L cancels): an
 *  unimproving candidate stays alive while β·σΔ/√n > δ_min, that is until
 *  n ≈ 1.96·√300·0.16/δ_min ≈ 181 seeds at δ_min = 0.03 L. So a full
 *  40-alive batch spends at most 40 × 181 ≈ 7.2k seeds on dead moves plus
 *  ~440 seeds ((2·1.96·0.16/0.03)², the δ_min resolve count) per survivor
 *  and for the incumbent: a batch of the whole alive set converges for
 *  well under 10k seeds. A batch that ends at the cap would spend
 *  40 × batchCap (41k at Standard) with no resolution, so bandit.ts
 *  reports it (capCut) and search.ts logs it: a capped batch means the
 *  indifference zone stopped separating this neighbourhood. */
export const BANDIT_MAX_ALIVE = 40;
/** Floor on one candidate's growth per bandit round (§D.2): 8 threads (the
 *  8-core sizing machine of the presets) × the pool chunk (CHUNK_SIZE = 25),
 *  so a growth batch hands every worker at least one full chunk even with a
 *  single survivor. */
export const BANDIT_RUNG_MIN_SEEDS = 8 * CHUNK_SIZE;
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
/** Stage E: ridge penalty on the option/pair coefficients (intercept unpenalized). */
export const SURROGATE_LAMBDA = 0.5;
/** Stage E: minimum labeled builds before the surrogate can drive ordering. */
export const SURROGATE_MIN_FIT = 12;
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
