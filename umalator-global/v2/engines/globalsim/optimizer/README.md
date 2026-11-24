# Skill optimizer (GlobalSim)

SP-budgeted skill-build search for one uma against a strong 9-runner field
(SKILL-OPTIMIZER-PLAN, approved 2026-11-15). Decisions come from simulation
(P1). Screening only decides *what to simulate next*. Search and verification
seeds are disjoint (P3), ties are reported honestly (P4), and the run is anytime
(P5). Every random choice is seeded, so with no time limit (Custom at 0
minutes, or Until stopped up to the moment it is stopped) the same inputs repeat
a run exactly (P6). The race climb
shares a time limit out by the clock, so a Quick, Standard or Thorough run also
moves with machine speed and load.

## Layout

- `config.ts`: every tunable, one object per effort preset (§11)
- `types.ts`: shared vocabulary (SeedValue/SeedSlot, objectives, results)
- `space.ts`: purchasable options, with skillGroups chains, tier-walk costs
  (`calculateSkillCost`), locks, purple exclusion and simulation identity
- `knapsack.ts`: multiple-choice DP + top-K restart points
- `cache.ts`: transposition table, position-indexed seed slots, LRU + pins
- `evaluator.ts`: the only engine path, with seed lists (search ∩ verify = ∅),
  missing-seed scheduling through `pool.ts`, SeedValue folding and paired stats
- `bandit.ts`: LUCB seed allocation vs the incumbent (§9), with exponential
  chunk growth (×1.5), a top-UCB rival and an alive-count cap. A candidate
  is retired once its best lower bound still trails every rival's worst upper
  bound. Every measured Δ (survivors *and* eliminations) is returned for the
  Stage D/F knapsack re-solve
- `surrogate.ts`: Bayesian ridge on cached build ℓ, with per-option indicators +
  pair-interaction terms (co-occurring ≥ m builds, capped by |coef|), closed-form
  posterior, weighted 5-fold holdout R², synergy flags (§8 E). It drives Stage D/F
  move ordering (acquisition gain + κ·SE), and below the R²=0.3 gate it falls back to
  in-context values. It only ever decides what to simulate (P1) and what order to
  screen it in. §C removed its bound-pruning from the Stage-F move space (a move
  may only die to the indifference zone or §I.5's certified Δ-SE prior)
- `search.ts`: Stages A–F + G orchestration (anytime). Opening-book starts,
  chart-parity screening, MCKP restarts, in-context drop/add/replace/pair moves
  with bandit allocation and knapsack re-solve (the search currency, §6.1 + §F:
  ℓ, clipped to ±2.5 measured σ(ℓ) for the win-rate objectives because past
  that a bigger lead moves P(1st) by under a point. The lower edge sits one
  clip width below the base build's mean ℓ when the base is behind the field,
  so a uma that never wins still has a lead to climb. When every verified
  build's rate is 0, Stage G orders, ties and resolves them by ℓ and the result
  sets `rankedByLead`),
  Stage F = §C local search: every round enumerates the full feasible
  N1 (drop, add, swap/tier-move, 2-for-1 incl. upgrade-and-sell, 1-for-2, with no
  caps and no estimate pruning) and screens it in waves of 128 in the move
  order. Two climbs share that frame (`SearchInput.climb`):
  - `race` (the default, `bandit.ts` raceWave): a move whose sequential lower
    bound clears 0 is re-tested on positions it has not raced, and the first
    one that passes again is adopted on the spot. A move is set aside under a
    target gain g (the gain a no-gain move falls under after ~400 seeds at the
    noise the wave measured, never below δ_min) or at a seed cap. A climb that
    cannot afford the rest of its neighbourhood stops after 2 empty waves in a
    row, settled at g, and kicks from there. A settled climb with room left
    halves g and looks again, the near misses of the coarser pass first, in
    waves that halve with g, down to δ_min, where an empty full pass is the
    same certificate as before. With a time limit the restarts share 75% of
    it (the time left over the restarts left, so unused time carries over),
    each restart's Stage D stops at half of its slice so its climb gets the
    other half, and the rest polishes the best restart end at finer targets. The result
    carries `climbStats`. Measured design record below ("Race climb").
  - `certify` (the previous climb, kept as the A/B arm): the waves run the
    bandit's indifference zone (rival cut off, alive cap raised to the wave,
    the ladder capped at the measured σΔ's δ-resolve count). A round adopts the
    best significant improver after the whole wave, certifies the peak (every
    UCB < δ_min) or reports the zone stopped resolving.
  After a certified (or, on the race climb, settled) peak, ILS kicks in (Quick 0, Standard 4,
  Thorough 10, untilStopped unbounded, k = 2–4 random feasible swaps biased to
  low in-build value), the re-climbs are accepted only on a significantly better
  paired Δ, and the final peak is screened against N2 (2-for-2, 8 lowest-value
  owned × 8 best free). There is no round cap, the preset time budget and the
  per-restart climbRaces race budget bound it, and the result carries
  `certified1MovePeak` / `certified2MovePeak`. Then fresh-seed Stage G
  verification with honest ties. Across a scenario set (§6.3) a mean aggregation
  searches each scenario independently and re-verifies the merged shortlist
  across all of them. A maximin or blend run does ONE search on the aggregated
  objective instead (`aggregatedEvaluator`: every candidate is simulated in every
  scenario and adopted on the combined value, so a compromise that is top-5 in no
  single scenario can still win. §E telemetry pools over the set, and that
  search's own per-scenario champions join Stage G's pool at no race cost).
  Either way the ranking is mean / maximin / blend (aggregateValues, §6.4) with
  conservative (all-scenarios-must-agree) ties
- `book.ts`: opening book in localStorage (`umalator_v2_optimizer_book`),
  prior strong builds keyed by a coarse (course · distance band · strategy ·
  mob preset · ground) fingerprint, best-effort (never fatal), and only ever
  used as restart seeds when still affordable and one-per-group (§8 A)

Outside this directory only three things changed: `workerCore.ts` compact
records carry `bestRivalFinishTimeRaw` (both the JS and the wasm
`run_compact` paths, bit-identical, see `compact-parity.test.ts`),
`metrics.ts` gained `leadMarginL` (ℓ in lengths,
`(bestRivalT − ownT) × finish speed / 2.5`), and the app shell gained the
Optimize tab (its pane runs one scenario, the race as set up, with mean
aggregation: the multi-scenario search has no control in the pane yet. It
carries the opening-book toggle, the recommended build's in-build skill list, and an
"Open in Compare" button that loads the build onto a copy of the current uma as
Uma 2).

## Race climb (measured 2026-11-17)

Setup: a real career dump (Hachimi-Edge, 22 skills bought by the climb, 2,941
SP, 54 options) on CM 22 (course 10611, Tokyo dirt 1600, soft, snowy,
winter), Standard, objective Margin vs winner, full default field. Every race
the certify climb asked for was logged, then 128 of its moves in its own order
and 128 drawn uniformly from its N1 (9,743 moves) were raced on the same
2,000 search seeds each. A replay resampled those per-seed leads with the seed
index shared by every build, and ran each round policy 200 to 300 times.

| Number | Value |
|---|---|
| paired σΔ(ℓ) at the climb's build (median) | 2.5 L (startup calibration on single adds: 0.80 L) |
| seed correlation of a move with the incumbent (median) | 0.76 |
| significant improvers in the climb's first wave | 52 of 128, best +0.76 L, 15 above +0.3 L |
| improvers among random N1 moves | 7 of 128, best +0.24 L |
| share of Δ > 0 in the first 32 moves of the order / random | 69% / 12% |
| the certify climb's one wave | 285,689 races (86% of the run), 1 adoption, cut by the time limit at 2,915 seeds a move |

Why the certify wave could not end: with the rival cut off, a wave stops only
when its leader's lower bound clears every rival's upper bound, and with dozens
of close improvers that never happens, so every move ladders to the ceiling
(686k races for the wave in the replay, uncut).

Replay, races per wave and the true gain adopted per 100k races:

| Wave | certify | first improvement | race (first improvement + confirm) |
|---|---|---|---|
| the climb's own first wave | 686k · 0.11 L | 10k · 5.4 L | 10k · 5.8 L |
| random N1 moves | 166k · 0.14 L | 26k · 0.68 L | 16k · 1.10 L |
| nothing to gain (every Δ ≤ 0) | 177k, 9% no-gain adoptions | 115k, 37% no-gain adoptions | 20k, 2% no-gain adoptions |

The confirm step is what makes first improvement safe: testing 128 moves at
every rung picks up noise.

Engine A/B, same dump, Standard (5 min), Margin vs winner, four run seeds per
climb, each recommendation scored on 4,000 held-out seeds from another base
seed (paired race − certify, 95% interval):

| Run seed | certify ℓ | race ℓ | race − certify |
|---|---|---|---|
| 20261118 | −6.14 L | −4.93 L | +1.21 [1.11, 1.31] |
| 20261119 | −4.85 L | −4.93 L | −0.08 [−0.17, 0.01] |
| 20261120 | −5.38 L | −5.06 L | +0.32 [0.26, 0.38] |
| 20261121 | −5.25 L | −5.23 L | +0.03 [−0.06, 0.11] |
| mean, spread | −5.40, 1.29 L | −5.04, 0.30 L | +0.37 |

The certify runs took 306–362 s (its wave overran the limit) and climbed in one
restart. The race runs took 296–302 s and climbed in all three. Before Stage D
was held to half of each slice, three Stage Ds took 266 s of one race run and
that seed lost by 0.54 L.

The race column is the code after the review fixes of 2026-11-18 (the noise
estimate leaves out moves that change no race, among others). The runs before
those fixes, on the same seeds, gave −5.00, −5.01, −5.19 and −4.84 L, a mean of
+0.40 L over certify. The race climb slices its time limit, so a run also moves
with machine speed and load, and one seed's result is not repeatable: seed
20261121 went from +0.41 to +0.03 L. The mean is the number to compare.

## Noise calibration record (§7.3, measured 2026-11-15)

Setup: course 10504 (2000 m), mob preset `default`, gate fixed, skill-less
base horse (40 seeds × 3 builds, node + real wasm via the worker pool):

| Number | Value |
|---|---|
| σ(ℓ) of the base build | ≈ 1.61 L |
| paired σΔ(ℓ) (single-skill adds vs base) | ≈ 1.89 L |
| base P(1st) | 0 (deliberately under-statted horse) |

Seed-budget implication: a paired comparison needs
`n ≈ (2·1.96·σΔ/δ)²` ≈ 6.6k seeds to resolve δ = 0.03 L. The §11 Stage G
seed counts were sized for this band (the 2026-11-16 paired block below
replaces that sizing), and screening therefore ranks by
ℓ differences with bandit allocation instead of raw win/lose (§6.1).

Throughput (globalsim-wasm/README.md): 6.3–9.4 ms per 9-runner race in Chrome,
about ~1,000 races/s at 8 threads, and a Standard run is ~110–180k races ≈ 2–3 min
(§10). The calibration smoke test in `npm run test:optimizer` prints 40-seed
numbers on a skill-less base: it proves the plumbing, not this record (the
paired block below was re-measured on the native engine, as described there).
In §C, measured 2026-11-16 on the realistic instances, a
full certified climb re-screens the whole feasible N1, 1,000–3,700 candidates
at those sizes with ~100–250k races per certification round, so a Standard-scale
run with ILS lands near 1–2M races, well over the §10 band (which predates the
full N1). The preset budgets are the control: `climbRaces` per restart bounds
the climb, `timeBudgetMs` bounds the run, and the anytime rule keeps the best
so far valid when either ends it mid-climb (that round just is not certified).

Paired-mode re-measurement (2026-11-16, §J.3: the realistic build the record
should read). Setup: native `race_engine_rs_v2.exe`, one JSON request per
stdin line, the v77 example request (course 10504, its 9-runner field and
fixed gates). The base is 17 one-per-group options, 7 of them gold (mixed
tiers, the shape the optimizer space actually offers). The adds are 12
single-skill options from groups the base does not own. 1000 seeds per arm,
the same seed list in both stream modes. The lead is in lengths at the mean
race speed (`distance / ownT`), because the native replies were read without
the tail grid. That is not the app's unit: compact records always carry a tail
and `leadMarginL` uses the finish speed `tail[0]`, which measured 1.166× the
mean speed on course 10504 (24.14 vs 20.70 m/s, 120 paired seeds). Multiply
every ℓ figure in this table by ~1.17 for the currency the search decides on
(live paired σΔ in that unit: 0.205 L where this form reads 0.176 L). The fixed
20 m/s factor this block first used reads ~3.5 % low at 2000 m. Medians over the 10 (retail) / 6 (paired) adds that move at all:

| Number | Retail | Paired |
|---|---|---|
| σ(ℓ) of one build | 0.84 L | 0.78 L |
| median σΔ(ℓ), with median ρ | 1.08 L, ρ 0.111 | 0.17 L, ρ 0.979 |
| seed-shared (race) part, √(ρ·σA·σB) | 0.27 L | 0.76 L |
| per-arm (build draws) part, σΔ/√2 | 0.76 L | 0.12 L |
| adds with Δ exactly 0 on every seed | 2 of 12 | 6 of 12 |
| base P(1st) | 0.987 | 0.984 |

Split-half σΔ is stable (paired halves 0.171 / 0.182, retail halves
1.137 / 1.024). Paired keys replay the field for a shared seed (ρ 0.979), so
the 0.76 L race part cancels and only the 0.12 L per-arm build draws survive.
In retail mode the field does not replay across builds of one seed (ρ 0.111),
so seed-pairing there cancels almost nothing and σΔ stays near √2·σ(ℓ). Seed
budget: `n ≈ (2·1.96·σΔ/δ)²`. δ = 0.03 L costs ~470 paired seeds where
retail needs ~19.9k. At the 20 m/s factor the paired median reads 0.161 L,
which is the 0.16 L the `config.ts` sizing comments quote (and 500 gSeeds
still covers the app-unit 472). The `config.ts` presets are sized from the
paired column, since Stage A-G and the Skill Chart run paired. The retail
column is what Compare traffic still runs on until the user switches on
"Paired seeds (lower noise)".

## Prerequisite skills spend SP and measure as free

A handful of conditions depend on earlier activations: `activate_count_start`,
`_middle`, `_end_after`, `_all`, `_heal`, `_later_half`. The engine models them
faithfully (`activate_count_start` checks `activate_count[0]`,
`activation_conditions.rs:1224`, and the counter is bumped per activation per
phase, `race_solver.rs:2663`). Groundwork (201601, `activate_count_start>=3`) is
why the gate activation pass runs twice at t=0 (`race_solver.rs:1009-1022`).

The search is not fooled by these skills: it scores whole builds, so an effect
that never turns on earns no credit. The gap is that it earns no *penalty*
either. With Δ = 0 and a near-saturated budget the shortlist is choosing between
fillers, so an unfeedable skill survives into the recommendation, and nothing in
the results table shows it.

Live case, an imported career on a mile course (the build carries Mile Maven and
Mile Corners, `distance_type==2`): the recommendation kept Groundwork at 90 SP
while the build could feed it twice. Opening-phase activations come from skills
already true at the gate, and here that is Pace Chaser Savvy ○ (201532,
`running_style==2`) and, on wet ground only, Wet Conditions ○ (200162,
`ground_condition==2@3@4`). Straightaway Adept (200362, `straight_random==1`) is
a random-gold draw. Two certain feeds against a requirement of three.

Unfixed. The options weighed: flag `activate_count_*` options whose prerequisite
the current build cannot meet (a static check over six condition names), break
CI-overlapping ties toward less SP and fewer skills, which drops dead filler
without touching the search, or report per-skill activation rates, which needs
engine work, since GlobalSim keeps per-phase aggregates only
(`race_solver_retail.rs:226-231`) and the submodule now carries this fork's
paired-draws work.

## Paired-draws mode (engine fork)

The submodule points at the fork's `paired-draws` branch. Its `pairedRandomStreams` request
flag keys the in-race stream by (seed, runner) and each skill's initialization windows and
wisdom lottery by (seed, runner, skill), so a skill change no longer reshuffles another
runner's draws. Measured on the native binary,
300 seeds, course 10504, a 15-skill base: median ρ 0.103 to 0.974, median paired σΔ(ℓ) 1.10
to 0.18 L, and skills that never fire score Δ exactly 0 (13/13, against 6/6 in retail mode).
Requests without the flag stay byte-identical to upstream v77, checked against a build of the
pinned commit.

σΔ is not a course constant, it tracks how large the effects being measured are. Re-measured at
600 seeds on a 15-skill base, a 12-candidate slice gives 0.162 L at course 10504 and 0.320 L at
10810, where an earlier 24-candidate slice at 300 seeds gave 0.971 L at 10810. Units are not the
explanation: the field's average finish speed is 20.72 m/s at 2000 m and 19.75 m/s at 3000 m, so
the fixed 20 m/s conversion is a few percent off either way (0.316 L against 0.320 L at 10810).
The 0.25 L target is a mile number. On the long course, adding skills that actually bite, expect
a few times that.

Paired mode does not move the outcome distribution: on 20 000 races per arm (course 10504,
15-skill base, seeds disjoint from retail) every runner's finish-rank marginal, finish-time
marginal and the field margin match retail at 1 % (Holm, χ² and tie-corrected KS, with a
retail-vs-retail control arm). Finish times tie in 6 of 40 000 retail races and 14 of 40 000
paired, so index tie-breaking is not a channel between the modes.

Stage A-G runs paired, and so does the Skill Chart. Compare stays retail until the "Paired
seeds (lower noise)" switch is on. `cache.ts` namespaces search and verify per mode
(`nsWithMode`), so a value measured one way is never folded into a stat from the other, and
setupKeys carry the mode so a prepared worker is not reused across modes. Seed lists stay
mode-independent, so search and verify seeds remain disjoint (P3). Config
sizing comes from the paired record above. The arithmetic is in the
`config.ts` preset comments.

## Tests

- `npm run test:optimizer` runs the pure units (space/knapsack/cache/stats), the
  live-engine evaluator integration (40 seeds, seconds), the surrogate units, the
  opening-book units and the synthetic oracle:
  - `surrogate.test.ts`: additive recovery, planted-synergy lift, noise fails the
    R² gate, inverse-variance weighting, graceful degradation
  - `book.test.ts`: key fingerprinting, best-effort storage, the
    affordable/one-per-group seed filter
  - `search.oracle.test.ts`: 100 small instances fully enumerated, the
    recommendation must be the optimum, within δ_min, or a statistical tie (gate
    ≥95%). 5 medium 30–40-option instances vs a random-restart + exhaustive
    hill-climb baseline. The surrogate on/off race comparison. The §6.4 scenario
    set (`aggregateValues` formulas plus a two-scenario maximin-vs-mean run whose
    optimum moves between scenarios). The §F currency's shape plus a 24-instance
    hard-P(1st) A/B of the clipped lead against the ℓ search, printed per instance,
    where a gap inside what the run's own verification seeds resolve counts as a
    tie. The §G one-aggregated-search vs searched-apart comparison for maximin and
    blend.
  Gaussian noise is calibrated to the σ table
  above: a shared field term that cancels in pairing + a per-build term that
  survives it, CRN per position. The oracle's second-scenario weight is derived
  from the pair ids, not the RNG, so scenario 0 stays byte-identical to the
  single-scenario run (its 95% gate is unaffected by the scenario work).
- `search.realistic.test.ts`: the §C acceptance gate on 12 realistic instances
  (~30 families, budget ≈ 20 skills, exact reference optimum from annealing +
  full 1+2-move ascent). At post-fix (paired) noise: mean gap ≤ 0.02 L, ≥90%
  within δ_min, no certified peak with an improvement ≥ δ_min left, and every
  run inside the preset-derived race budget. Peak status asserts at δ_min
  resolution (an improving move counts only if its gain > δ_min): the strict
  "no improving move at all" reading is not achievable at any finite budget.
  At σΔ ≈ 0.21 L the indifference zone drops a gain Δ at n ≈ 1.96·σΔ·√300/
  (δ_min−Δ) seeds, before its significance test at n = (1.96·σΔ/Δ)² could
  resolve it, so every strict miss measured so far is a sub-δ_min gain (the
  table prints both readings and the largest miss). The today-noise setting
  (σΔ ≈ 1.1 L) is reported for the record with regression floors: certifying a
  full N1 there needs ~20k seeds per candidate, far past any sane budget, so
  the climb stops uncertified and ILS never starts.

Surrogate race findings (measured, in-suite): the cut is confidence-gated. At
the engine's real noise band the §I prior + value provider shave little off
the search bill (search-only on/off ratio 0.88 on the noisy medium pool,
fewer on 7 of 8) while the acquisition reshuffles the path-dependent search.
The plan's ≤70%-of-Phase-3 target does not hold there. Where the model is
identifiable (exact-lead, additive-only instances) the same machinery is a
race saver: search-only ratio 0.23 with μ never worse, and with stage
attribution Stage D, the bulk of the bill, −23 %, all races −37 % (§I test
gates ≤0.85 / ≤0.70). §C removed the additive-estimate bound-prune from the
Stage-F move space. The bound-based retire that stays is §I.5's certified
Δ-SE prior (a wave candidate the model certifies hopeless never races).

- `npm run test:optimizer:slow`: real-engine exhaustive check, 3 setups ×
  ~12 purchasable options, every affordable build enumerated on the same
  held-out verify seeds. The recommendation must be the exhaustive best or tie
  it (paired ℓ CI straddles 0). Objective is meanLead (P(1st) is degenerate
  for a skill-less base vs the strong default field). Cold-start bound: default
  1 setup / 9 options / 400 seeds (~4 min, worker_threads). `SLOW_FULL=1` runs
  the full §13.2 sizing.
- `npm run test:globalsim-compact`: the record the optimizer reads is
  bit-identical between the wasm and JS extraction paths.
