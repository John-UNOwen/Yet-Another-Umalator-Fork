/**
 * Skill-optimizer tunables (SKILL-OPTIMIZER-PLAN §11) — one config object per
 * effort preset. Everything the search pipeline sizes itself with lives here;
 * stages read config, never magic numbers.
 *
 * Effort presets (plan §11 table; G seeds and batch cap re-sized from the
 * paired noise record, README.md 2026-11-16 — the presets run paired):
 *
 * |              | Quick        | Standard (default) | Thorough           |
 * | δ_min (L)    | 0.05         | 0.03               | 0.02               |
 * | K restarts   | 1            | 3                  | 5                  |
 * | D_MAX_ITERS  | 1            | 4                  | 6                  |
 * | ILS kicks    | 0            | 4                  | 10                 |
 * | G seeds      | 200 / 800    | 500 / 2,000        | 1,000 / 4,000      |
 * | batch cap    | 400          | 1,000              | 2,000              |
 * | surrogate    | off          | on                 | on                 |
 *
 * The §C certified local search has no round cap: a restart's climb runs until
 * every N1 move's upper bound sits under δ_min (or the indifference zone stops
 * resolving at this noise), then ILS kicks re-climb. What bounds it instead is
 * the preset time budget and the per-restart climbRaces budget (§C: "keep race
 * budgets instead").
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
	/** ILS kicks per restart after a certified peak (§C). 0 = climb only,
	 *  Infinity = kick until Stop / the time budget ends it (untilStopped). */
	kicks: number;
	/** Race budget for one restart's certified local search + ILS (§C: "keep
	 *  race budgets instead" of a round cap). The climb stops and keeps its best
	 *  (un-certified) build once the restart's search races exceed this. */
	climbRaces: number;
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
	/** User settings (applyTuning), absent on the presets. Each one falls back
	 *  to the constant named in its comment. */
	/** Kicks per visit to a start (KICKS_PER_VISIT on Until stopped, `kicks` otherwise). */
	kicksPerVisit?: number;
	/** Wider search: failed kicks in a row before the kick grows (KICK_GROW_AFTER). */
	kickGrowAfter?: number;
	/** Wider search: picks two starts must differ by (knapsack SPREAD_MIN_DIFF_PICKS). */
	spreadMinDiff?: number;
	/** Wider search: noise on the shuffled starts' values (knapsack SPREAD_NOISE). */
	spreadNoise?: number;
	/** Races each "worth if dropped" number rests on (CONTRIB_SEEDS). */
	contribSeeds?: number;
	/** Builds verified and reported (5, or 3 after Stop). */
	shortlistSize?: number;
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
	deltaMinL: 0.05, restarts: 1, dMaxIters: 1, kicks: 0, climbRaces: 40_000,
	// climbRaces (§C): the per-restart race budget for the certified climb +
	// ILS (the "race budgets instead of a round cap" control). Sized per
	// preset from the wall-clock budget at ~1,000 races/s (8 threads): Quick
	// 60 s ≈ 60k races, ~40k to one climb. A realistic-size N1 (1–3.7k
	// candidates) needs ~100–250k per certification round alone, so Quick only
	// certifies small pools — the anytime rule returns the best so far and the
	// cert flags say so honestly.
	// Paired record σΔ = 0.16 L: (2·1.96·0.16/0.05)² = 158 seeds resolve δ_min,
	// rounded up to 200; the cap is 4× (resolves δ_min/2), batchCap 2× per
	// candidate for multiple-comparison slack.
	gSeedsMin: 200, gSeedsCap: 800, batchCap: 400, surrogate: false,
	timeBudgetMs: 60_000, ...SCREEN_COMMON,
};

export const STANDARD: EffortConfig = {
	preset: 'standard',
	deltaMinL: 0.03, restarts: 3, dMaxIters: 4, kicks: 4, climbRaces: 80_000,
	// Same sizing as Quick at δ_min = 0.03: (2·1.96·0.16/0.03)² = 437, rounded
	// up to 500; cap 4× (0.014 L), batchCap 2×. climbRaces 80k × 3 restarts ≈
	// 240k of the ~300k budget at 5 min; a full certified climb + 4 ILS kicks
	// measures 450–700k per restart on realistic pools, so Standard certifies
	// small/medium pools and returns an honest uncertified best (with the
	// best-so-far guarantee) on large ones. Thorough runs the full loop.
	gSeedsMin: 500, gSeedsCap: 2000, batchCap: 1000, surrogate: true,
	timeBudgetMs: 5 * 60_000, ...SCREEN_COMMON,
};

export const THOROUGH: EffortConfig = {
	preset: 'thorough',
	deltaMinL: 0.02, restarts: 5, dMaxIters: 6, kicks: 10, climbRaces: 180_000,
	// Same sizing at δ_min = 0.02: (2·1.96·0.16/0.02)² = 983, rounded up to
	// 1000; cap 4× (0.010 L), batchCap 2×. climbRaces 180k × 5 restarts ≈ 900k
	// of the ~1.2M budget at 20 min — enough for a certification round plus a
	// few ILS re-climbs per restart at realistic sizes (measured §C numbers in
	// the README; the acceptance run itself is budget-unbounded).
	gSeedsMin: 1000, gSeedsCap: 4000, batchCap: 2000, surrogate: true,
	timeBudgetMs: 20 * 60_000, ...SCREEN_COMMON,
};

/** Until stopped: kicks per visit to one starting build before the next start
 *  gets its turn (Thorough's count). The search then loops over the peaks it
 *  reached, so every start is explored before any one of them is kicked again. */
export const KICKS_PER_VISIT = 10;

/** Wider search: failed kicks in a row before the kick grows one level. */
export const KICK_GROW_AFTER = 3;
/** Wider search: the largest kick level (6 to 8 swaps). */
export const KICK_MAX_LEVEL = 2;
/** Kick level after `failed` kicks in a row (wider search only). */
export function kickLevelOf(failed: number, growAfter: number = KICK_GROW_AFTER): number {
	return Math.min(KICK_MAX_LEVEL, Math.floor(Math.max(0, failed) / Math.max(1, growAfter)));
}
/** Swaps one kick makes at a level: 2 to 4 at level 0 (the default kick),
 *  then 4 to 6, then 6 to 8. A build with fewer skills stops at what it owns. */
export function kickSizeRange(level: number): [number, number] {
	return [2 + 2 * level, 4 + 2 * level];
}

/** Thorough sizes, no deadline, verification grows to the cap. */
export const UNTIL_STOPPED: EffortConfig = {
	preset: 'untilStopped',
	deltaMinL: 0.02, restarts: 5, dMaxIters: 6, kicks: Infinity, climbRaces: Infinity,
	// THOROUGH's sizes (paired record, see its comment), unbounded in time.
	gSeedsMin: 1000, gSeedsCap: 4000, batchCap: 2000, surrogate: true,
	timeBudgetMs: Infinity, ...SCREEN_COMMON,
};

/** Custom effort: Thorough's sizes with the user's starting-build count and
 *  time limit. A limit of 0 minutes means none: the run ends when every
 *  starting build has had its climb and kicks. */
export interface CustomEffort {
	/** Starting builds (Stage C restarts), 1 to CUSTOM_STARTS_MAX. */
	starts: number;
	/** Time limit in minutes, 0 for none. */
	minutes: number;
}
export const CUSTOM_STARTS_MAX = 50;
export const DEFAULT_CUSTOM: CustomEffort = { starts: 10, minutes: 40 };

export function customEffortConfig(c: CustomEffort): EffortConfig {
	const starts = Math.max(1, Math.min(CUSTOM_STARTS_MAX, Math.round(Number(c.starts) || 1)));
	const minutes = Math.max(0, Number(c.minutes) || 0);
	return { ...THOROUGH, preset: 'custom', restarts: starts, timeBudgetMs: minutes > 0 ? minutes * 60_000 : Infinity };
}

export function effortConfig(preset: EffortPreset, custom: CustomEffort = DEFAULT_CUSTOM): EffortConfig {
	switch (preset) {
		case 'custom': return customEffortConfig(custom);
		case 'quick': return QUICK;
		case 'thorough': return THOROUGH;
		case 'untilStopped': return UNTIL_STOPPED;
		case 'standard':
		default: return STANDARD;
	}
}

/**
 * Settings the user can change on top of an effort preset. A missing field
 * keeps the preset's value. The statistical internals (adoption threshold,
 * bandit ladder, surrogate, cache) are not here on purpose: they are what
 * keeps the search from adopting a change that only looked good by luck.
 */
export interface SearchTuning {
	/** Smallest gain worth chasing, in lengths. */
	deltaMinL?: number;
	/** Verification races per build (the cap grows to 4×). */
	verifySeeds?: number;
	/** Races behind each "worth if dropped" number. */
	contribSeeds?: number;
	/** Builds verified and reported. */
	buildsShown?: number;
	/** Kicks per starting build (per visit on Until stopped). */
	kicksPerStart?: number;
	/** Wider search: failed kicks in a row before the kick grows. */
	kickGrowAfter?: number;
	/** Wider search: skills two starting builds must differ by. */
	spreadMinDiff?: number;
	/** Wider search: noise on the shuffled starts, in median skill values. */
	spreadNoise?: number;
}

/** Bounds the pane's inputs share with applyTuning, so both clamp alike. */
export const TUNING_LIMITS = {
	deltaMinL: { min: 0.005, max: 1 },
	verifySeeds: { min: 100, max: 15_000 },
	contribSeeds: { min: 50, max: 5_000 },
	buildsShown: { min: 1, max: 15 },
	kicksPerStart: { min: 0, max: 100 },
	kickGrowAfter: { min: 1, max: 20 },
	spreadMinDiff: { min: 2, max: 20 },
	spreadNoise: { min: 0, max: 5 },
} as const;

const clampTo = (v: number, lim: { min: number; max: number }): number => Math.min(lim.max, Math.max(lim.min, v));
const given = (v: number | undefined): v is number => v != null && Number.isFinite(v);

/** The preset with the user's settings applied. With no settings it returns
 *  the preset unchanged, so a run without them behaves exactly as before. */
export function applyTuning(cfg: EffortConfig, t: SearchTuning = {}): EffortConfig {
	const L = TUNING_LIMITS;
	const out: EffortConfig = { ...cfg };
	if (given(t.deltaMinL)) out.deltaMinL = clampTo(t.deltaMinL, L.deltaMinL);
	if (given(t.verifySeeds)) {
		const n = Math.round(clampTo(t.verifySeeds, L.verifySeeds));
		// Tie growth can never pass the verify list, which holds SEED_LIST_SIZE
		// positions (it is drawn from 3 × that many seeds, then cut back).
		out.gSeedsMin = n;
		out.gSeedsCap = Math.min(SEED_LIST_SIZE, 4 * n);
	}
	if (given(t.contribSeeds)) out.contribSeeds = Math.round(clampTo(t.contribSeeds, L.contribSeeds));
	if (given(t.buildsShown)) out.shortlistSize = Math.round(clampTo(t.buildsShown, L.buildsShown));
	if (given(t.kicksPerStart)) {
		const k = Math.round(clampTo(t.kicksPerStart, L.kicksPerStart));
		// Until stopped keeps kicking pass after pass, so the setting is the
		// count per visit. Every other preset kicks one visit per start.
		if (Number.isFinite(cfg.kicks)) out.kicks = k;
		else out.kicksPerVisit = Math.max(1, k);
	}
	if (given(t.kickGrowAfter)) out.kickGrowAfter = Math.round(clampTo(t.kickGrowAfter, L.kickGrowAfter));
	if (given(t.spreadMinDiff)) out.spreadMinDiff = Math.round(clampTo(t.spreadMinDiff, L.spreadMinDiff));
	if (given(t.spreadNoise)) out.spreadNoise = clampTo(t.spreadNoise, L.spreadNoise);
	return out;
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
/** §C: candidates screened per bandit batch in the certified climb. The batch's
 *  alive cap is raised to the wave size, so the indifference zone alone sizes
 *  the alive set, capCut stays 0, and a wave ending with all survivors
 *  zone-dropped really certifies its candidates. */
export const CLIMB_WAVE = 128;
/**
 * The race climb (search.ts `climb: 'race'`, bandit.ts raceWave). Measured on a
 * career dump (Tokyo dirt 1600, full field, paired σΔ ≈ 2.5 L at the climb's
 * build) and replayed on 2,000 shared seeds per move:
 *  - CLIMB_PATIENCE: empty waves in a row before a climb that cannot afford
 *    the rest of its neighbourhood stops and hands over to the kicks. The
 *    climb's own order put 69% improvers in its first 32 moves and 12% among
 *    random ones, so the moves past two empty waves are the least promising.
 *  - CLIMB_CONFIRM_START / _PARALLEL: a move that passes the sequential test
 *    is re-tested on positions it has not raced, from 100 seeds up, at most
 *    4 at a time. Without that, testing 128 moves at every rung adopted a
 *    no-gain move in 25–37% of waves that held none (2% with it).
 *  - CLIMB_TARGET_SEEDS: the first target gain g is the gain a no-gain move
 *    is set aside under after about 400 seeds, SEQ_ADOPT_Z·σ/√400 (0.3 L at
 *    that noise, never below δ_min). A settled climb halves g and screens
 *    again while it has room, down to δ_min, so small gains that add up are
 *    still taken. The cache keeps every seed already raced.
 *  - CLIMB_NMAX_FACTOR: a move is set aside at 8 × (SEQ_ADOPT_Z·σ/g)² seeds,
 *    twice the count that shows a gain of g (3,200 seeds at the first g).
 *  - CLIMB_POLISH_SHARE: with kicks to run, they stop when a quarter of the
 *    restart's room is left, and that quarter refines the final peak.
 *  - CLIMB_STAGE_D_SHARE: with a time limit, a restart's Stage D (the
 *    in-context rounds) may use half of the restart's slice, so its climb
 *    always gets the other half. Unbounded, three Stage Ds took 266 s of a
 *    300 s Standard run on the career dump and left the climbs nothing.
 *  - CLIMB_POLISH_LEVELS: with no time or race limit at all (Until stopped),
 *    a visit refines at most this many halvings per pass it has had, so one
 *    start cannot keep the others waiting.
 */
export const CLIMB_PATIENCE = 2;
export const CLIMB_CONFIRM_START = 100;
export const CLIMB_CONFIRM_PARALLEL = 4;
export const CLIMB_TARGET_SEEDS = 400;
export const CLIMB_NMAX_FACTOR = 8;
export const CLIMB_POLISH_SHARE = 0.25;
export const CLIMB_STAGE_D_SHARE = 0.5;
export const CLIMB_POLISH_LEVELS = 2;
/** Floor on one candidate's growth per bandit round (§D.2): 8 threads (the
 *  8-core sizing machine of the presets) × the pool chunk (CHUNK_SIZE = 25),
 *  so a growth batch hands every worker at least one full chunk even with a
 *  single survivor. */
export const BANDIT_RUNG_MIN_SEEDS = 8 * CHUNK_SIZE;
/** Sequential adoption boundary (§D.3): Stage D's adoption test and the ILS
 *  acceptance test look at a growing sample up to ~3 times and stop at the
 *  first significant look, so a fixed 1.96 adopted a zero-gain build ~5–6% of
 *  the time instead of 2.5%. 2.4 (a Pocock-style constant boundary, Monte
 *  Carlo on the real rung schedule 150 → 350 → 550 → 825 → batchCap with
 *  σΔ 0.17–0.205 L) brings it back to 1.9–2.4%, power at δ_min ≈ 94%. */
export const SEQ_ADOPT_Z = 2.4;
/** Successive-halving ladder inside bandit batches (§9). */
export const BANDIT_LADDER = [50, 100, 200, 400, 800, 1600, 3200];
/** Stage E acquisition κ (predicted gain + κ·SE). */
export const KAPPA = 1.5;
/** Pruning optimism factor (alpha-beta cutoff with error bars). */
export const PRUNE_KAPPA = 2;
/** Blend aggregation λ: (1−λ)·mean + λ·min. */
export const LAMBDA_MAXIMIN = 0.3;
/** Transposition-table byte budget: real heap, ≈96 B per cached seed slot
 *  (cache.ts SLOT_BYTES), so 100 MB ≈ 1M seed slots. */
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
/** §I: pair columns take this multiple of the ridge penalty. They are the
 *  widest coefficients in the design (only their co-occurrences stand behind
 *  them), so the prior must be strongest exactly there. 10× the option λ. */
export const SURROGATE_PAIR_PRIOR = 10;
/** Stage E: below this holdout R² the surrogate stops driving ordering. */
export const SURROGATE_MIN_R2 = 0.3;
/** Verification-seed disjointness margin check (P3) — overlap assert helper. */
export const VERIFY_SALT = 0x51ed27e1;
/** Seeds per (namespace, scenario) list, the most positions any ladder or
 *  verification can ask for (evaluator.ts builds every list at this length). */
export const SEED_LIST_SIZE = 20000;
/**
 * §E: telemetry seeds needed before "this skill never activated" is read as
 * never (handoff §E: a 0/200 activation counts as never; a skill that fires
 * on 1 in 200+ seeds must not be declared dead on a short read). Below this
 * many measured seeds the dead-skill rules simply do not fire.
 */
export const DEAD_SKILL_MIN_SEEDS = 200;

/** Seeds the per-skill worth report races for a drop the cache no longer holds
 *  (evicted on a long run) or never raced (the recommendation was not a climb
 *  end). 200 paired seeds resolve about 0.04 L at the measured σΔ, and a
 *  20-skill build costs at most 4,000 races, a few seconds. */
export const CONTRIB_SEEDS = 200;
/** localStorage key: opening book (Stage A). */
export const BOOK_STORAGE_KEY = 'umalator_v2_optimizer_book';

/** Defaults the pane pre-selects (plan: default objective P(1st), mean aggregation). */
export const DEFAULT_OBJECTIVE: ObjectiveKind = 'p1';
export const DEFAULT_AGGREGATION: AggregationKind = 'mean';
export const DEFAULT_EFFORT: EffortPreset = 'standard';
