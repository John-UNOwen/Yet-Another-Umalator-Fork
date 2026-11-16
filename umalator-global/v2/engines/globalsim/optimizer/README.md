# Skill optimizer (GlobalSim)

SP-budgeted skill-build search for one uma against a strong 9-runner field
(SKILL-OPTIMIZER-PLAN, approved 2026-11-15). Decisions come from simulation
(P1); screening only decides *what to simulate next*. Search and verification
seeds are disjoint (P3); ties are reported honestly (P4); the run is anytime
(P5) and deterministic for fixed inputs (P6).

## Layout

- `config.ts` — every tunable, one object per effort preset (§11)
- `types.ts` — shared vocabulary (SeedValue/SeedSlot, objectives, results)
- `space.ts` — purchasable options: skillGroups chains, tier-walk costs
  (`calculateSkillCost`), locks, purple exclusion, simulation identity
- `knapsack.ts` — multiple-choice DP + top-K restart points
- `cache.ts` — transposition table, position-indexed seed slots, LRU + pins
- `evaluator.ts` — the only engine path: seed lists (search ∩ verify = ∅),
  missing-seed scheduling through `pool.ts`, SeedValue folding, paired stats
- `bandit.ts` — LUCB seed allocation vs the incumbent (§9): exponential
  chunk growth (×1.5) with a top-UCB rival and an alive-count cap; a candidate
  is retired once its best lower bound still trails every rival's worst upper
  bound. Every measured Δ (survivors *and* eliminations) is returned for the
  Stage D/F knapsack re-solve
- `surrogate.ts` — Bayesian ridge on cached build ℓ: per-option indicators +
  pair-interaction terms (co-occurring ≥ m builds, capped by |coef|), closed-form
  posterior, weighted 5-fold holdout R², synergy flags (§8 E). Drives Stage D/F
  move ordering (acquisition gain + κ·SE); below the R²=0.3 gate it falls back to
  in-context values; it only ever decides what to simulate (P1) and what order to
  screen it in — §C removed its bound-pruning from the Stage-F move space (a move
  may only die to the indifference zone; the Δ-SE bound prune is §I work)
- `search.ts` — Stages A–F + G orchestration (anytime): opening-book starts,
  chart-parity screening, MCKP restarts, in-context drop/add/replace/pair moves
  with bandit allocation and knapsack re-solve (ℓ is the search currency, §6.1),
  Stage F = §C certified local search: every round enumerates the full feasible
  N1 (drop, add, swap/tier-move, 2-for-1 incl. upgrade-and-sell, 1-for-2 — no
  caps, no estimate pruning) and screens the waves with the bandit's
  indifference zone (rival cut off, alive cap raised to the wave, the ladder
  capped at the measured σΔ's δ-resolve count); a round adopts one significant
  improver or certifies the peak (every UCB < δ_min) or reports the zone
  stopped resolving; after a certified peak, ILS kicks (Quick 0, Standard 4,
  Thorough 10, untilStopped unbounded; k = 2–4 random feasible swaps biased to
  low in-build value) re-climb and are accepted only on a significantly better
  paired Δ; the final peak is screened against N2 (2-for-2, 8 lowest-value
  owned × 8 best free). No round cap — the preset time budget and the
  per-restart climbRaces race budget bound it, and the result carries
  `certified1MovePeak` / `certified2MovePeak`. Then fresh-seed Stage G
  verification with honest ties. Across a scenario set (§6.3) it searches each
  scenario independently then re-verifies the merged shortlist across all of
  them, ranked by mean / maximin / blend (aggregateValues, §6.4) with
  conservative (all-scenarios-must-agree) ties
- `book.ts` — opening book in localStorage (`umalator_v2_optimizer_book`):
  prior strong builds keyed by a coarse (course · distance band · strategy ·
  mob preset · ground) fingerprint, best-effort (never fatal), and only ever
  used as restart seeds when still affordable and one-per-group (§8 A)

Outside this directory only three things changed: `workerCore.ts` compact
records carry `bestRivalFinishTimeRaw` (both the JS and the wasm
`run_compact` paths, bit-identical — `compact-parity.test.ts`),
`metrics.ts` gained `leadMarginL` (ℓ in lengths,
`(bestRivalT − ownT) × finish speed / 2.5`), and the app shell gained the
Optimize tab (its pane carries the scenario/robustness + aggregation controls,
the opening-book toggle, the recommended build's in-build skill list, and an
"Open in Compare" button that loads the build onto a copy of the current uma as
Uma 2).

## Noise calibration record (§7.3, measured 2026-11-15)

Setup: course 10504 (2000 m), mob preset `default`, gate fixed, skill-less
base horse (40 seeds × 3 builds, node + real wasm via the worker pool):

| Number | Value |
|---|---|
| σ(ℓ) of the base build | ≈ 1.61 L |
| paired σΔ(ℓ) (single-skill adds vs base) | ≈ 1.89 L |
| base P(1st) | 0 (deliberately under-statted horse) |

Seed-budget implication: a paired comparison needs
`n ≈ (2·1.96·σΔ/δ)²` ≈ 6.6k seeds to resolve δ = 0.03 L — the §11 Stage G
seed counts were sized for this band (the 2026-11-16 paired block below
replaces that sizing), and screening therefore ranks by
ℓ differences with bandit allocation instead of raw win/lose (§6.1).

Throughput (globalsim-wasm/README.md): 6.3–9.4 ms per 9-runner race in Chrome
→ ~1,000 races/s at 8 threads; a Standard run is ~110–180k races ≈ 2–3 min
(§10). Recompute with `npm run test:optimizer` (the calibration test prints
fresh numbers). Note (§C, measured 2026-12-05 on the realistic instances): a
full certified climb re-screens the whole feasible N1 — 1,000–3,700 candidates
at those sizes, ~100–250k races per certification round — so a Standard-scale
run with ILS lands near 1–2M races, well over the §10 band (which predates the
full N1). The preset budgets are the control: `climbRaces` per restart bounds
the climb, `timeBudgetMs` bounds the run, and the anytime rule keeps the best
so far valid when either ends it mid-climb (that round just is not certified).

Paired-mode re-measurement (2026-11-16, native `race_engine_rs_v2.exe`, same
course and mob field, 15-skill base + 12 single-skill adds, 1000 seeds per
arm, both stream modes over the same seed list, lead in lengths at 20 m/s):

| Number | Retail | Paired |
|---|---|---|
| σ(ℓ) of one build | 0.82 L | 0.77 L |
| median σΔ(ℓ) of active adds | 1.07 L | 0.16 L |
| median ρ of the two arms on shared seeds | 0.115 | 0.980 |
| seed-shared (race) part, √(ρ·σA·σB) | 0.27 L | 0.76 L |
| per-arm (build draws) part, σΔ/√2 | 0.75 L | 0.11 L |
| adds with Δ exactly 0 | 1 of 12 | 6 of 12 |

Split-half σΔ is stable (paired halves 0.154 / 0.147, retail halves
1.064 / 1.071). Paired keys replay the field for a shared seed (ρ 0.980), so
the 0.76 L race part cancels and only the 0.11 L per-arm build draws survive;
in retail mode the field does not replay across builds of one seed (ρ 0.115),
so seed-pairing there cancels almost nothing and σΔ stays near √2·σ(ℓ). Seed
budget: `n ≈ (2·1.96·σΔ/δ)²` — δ = 0.03 L costs ~440 paired seeds where
retail needs ~19.5k. The `config.ts` presets are sized from the paired
column, since Stage A-G and the Skill Chart run paired; the retail column is
what Compare traffic still runs on until the user switches on "Paired seeds
(lower noise)".

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
the current build cannot meet (a static check over six condition names); break
CI-overlapping ties toward less SP and fewer skills, which drops dead filler
without touching the search; or report per-skill activation rates, which needs
engine work, since GlobalSim keeps per-phase aggregates only
(`race_solver_retail.rs:226-231`); the submodule now carries this fork's paired-draws work.

## Paired-draws mode (engine fork)

The submodule points at the fork's `paired-draws` branch. Its `pairedRandomStreams` request
flag keys the in-race stream by (seed, runner) and each skill's initialization windows and
wisdom lottery by (seed, runner, skill), so a skill change no longer reshuffles another
runner's draws. Measured on the native binary,
300 seeds, course 10504, a 15-skill base: median ρ 0.103 to 0.974, median paired σΔ(ℓ) 1.10
to 0.18 L, and skills that never fire score Δ exactly 0 (13/13, against 6/6 in retail mode).
Requests without the flag stay byte-identical to upstream v77, checked against a build of the
pinned commit. On the 3000 m course (10810) ρ reaches 0.909 but σΔ stays near 1 L; the length
conversion there is still the mile one, so that figure is in the wrong units.

Paired mode does not move the outcome distribution: on 20 000 races per arm (course 10504,
15-skill base, seeds disjoint from retail) every runner's finish-rank marginal, finish-time
marginal and the field margin match retail at 1 % (Holm, χ² and tie-corrected KS, with a
retail-vs-retail control arm); finish times tie in 6 of 40 000 retail races and 14 of 40 000
paired, so index tie-breaking is not a channel between the modes.

Stage A-G runs paired, and so does the Skill Chart; Compare stays retail until the "Paired
seeds (lower noise)" switch is on. `cache.ts` namespaces search and verify per mode
(`nsWithMode`), so a value measured one way is never folded into a stat from the other, and
setupKeys carry the mode so a prepared worker is not reused across modes. Seed lists stay
mode-independent, so search and verify seeds remain disjoint (P3). Config
sizing comes from the paired record above; the arithmetic is in the
`config.ts` preset comments.

## Tests

- `npm run test:optimizer` — pure units (space/knapsack/cache/stats) + the
  live-engine evaluator integration (40 seeds; seconds) + the surrogate units
  (`surrogate.test.ts`: additive recovery, planted-synergy lift, noise fails the
  R² gate, inverse-variance weighting, graceful degradation) + the opening-book
  units (`book.test.ts`: key fingerprinting, best-effort storage, the
  affordable/one-per-group seed filter) + the synthetic oracle
  (`search.oracle.test.ts`: 100 small instances fully enumerated, recommendation
  must be the optimum, within δ_min, or a statistical tie — gate ≥95%; 5 medium
  30–40-option instances vs a random-restart + exhaustive hill-climb baseline;
  the surrogate on/off race comparison; and the §6.4 scenario
  set — `aggregateValues` formulas plus a two-scenario maximin-vs-mean run whose
  optimum moves between scenarios). Gaussian noise is calibrated to the σ table
  above — a shared field term that cancels in pairing + a per-build term that
  survives it, CRN per position. The oracle's second-scenario weight is derived
  from the pair ids, not the RNG, so scenario 0 stays byte-identical to the
  single-scenario run (its 95% gate is unaffected by the scenario work).
- `search.realistic.test.ts` — the §C acceptance gate on 12 realistic instances
  (~30 families, budget ≈ 20 skills, exact reference optimum from annealing +
  full 1+2-move ascent): at post-fix (paired) noise — mean gap ≤ 0.02 L, ≥90%
  within δ_min, no certified peak with an improvement ≥ δ_min left, and every
  run inside the preset-derived race budget. Peak status asserts at δ_min
  resolution (an improving move counts only if its gain > δ_min): the strict
  "no improving move at all" reading is not achievable at any finite budget —
  at σΔ ≈ 0.21 L the indifference zone drops a gain Δ at n ≈ 1.96·σΔ·√300/
  (δ_min−Δ) seeds, before its significance test at n = (1.96·σΔ/Δ)² could
  resolve it, so every strict miss measured so far is a sub-δ_min gain (the
  table prints both readings and the largest miss). The today-noise setting
  (σΔ ≈ 1.1 L) is reported for the record with regression floors: certifying a
  full N1 there needs ~20k seeds per candidate, far past any sane budget, so
  the climb stops uncertified and ILS never starts.

Surrogate race findings (measured, in-suite): at the engine's real noise band the
posterior SE is too wide to certify any move hopeless, so the surrogate is
quality-safe but race-neutral (its acquisition only reshuffles the search; the
on/off ratio measures 0.98). §C removed bound-pruning from the Stage-F move
space (only the indifference zone may retire a move), so today the surrogate
orders waves but cuts nothing; the future race lever is §I's certified Δ-SE
bound. The plan's ≤70%-of-Phase-3 target stays production-scale.

- `npm run test:optimizer:slow` — real-engine exhaustive check: 3 setups ×
  ~12 purchasable options, every affordable build enumerated on the SAME
  held-out verify seeds; the recommendation must BE the exhaustive best or tie
  it (paired ℓ CI straddles 0). Objective is meanLead (P(1st) is degenerate
  for a skill-less base vs the strong default field). Cold-start bound: default
  1 setup / 9 options / 400 seeds (~4 min, worker_threads); `SLOW_FULL=1` runs
  the full §13.2 sizing.
- `npm run test:globalsim-compact` — the record the optimizer reads is
  bit-identical between the wasm and JS extraction paths.
