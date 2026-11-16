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
  move ordering (acquisition gain + κ·SE) and α/β-with-error-bars pruning
  below the R²=0.3 gate it falls back to in-context values; it only ever
  decides what to simulate (P1) and never prunes an option it hasn't learned
- `search.ts` — Stages A–F + G orchestration (anytime): opening-book starts,
  chart-parity screening, MCKP restarts, in-context drop/add/replace/pair moves
  with bandit allocation and knapsack re-solve (ℓ is the search currency, §6.1),
  a Stage-F local search over richer 1-1/1-2/2-1/pair moves (history heuristic,
  budget-feasible neighbourhood, adopt-only-significant, surrogate-ordered,
  beam-capable), fresh-seed Stage G verification with honest ties. Across a
  scenario set (§6.3) it searches each scenario independently then re-verifies
  the merged shortlist across all of them, ranked by mean / maximin / blend
  (aggregateValues, §6.4) with conservative (all-scenarios-must-agree) ties
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
seed counts are sized exactly for this band, and screening therefore ranks by
ℓ differences with bandit allocation instead of raw win/lose (§6.1).

Throughput (globalsim-wasm/README.md): 6.3–9.4 ms per 9-runner race in Chrome
→ ~1,000 races/s at 8 threads; a Standard run is ~110–180k races ≈ 2–3 min
(§10). Recompute with `npm run test:optimizer` (the calibration test prints
fresh numbers).

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
flag takes every skill's and runner's draws from a stream keyed by (seed, runner, skill), so
adding one skill no longer reshuffles the rest of the race. Measured on the native binary,
300 seeds, course 10504, a 15-skill base: median ρ 0.103 to 0.974, median paired σΔ(ℓ) 1.10
to 0.18 L, and skills that never fire score Δ exactly 0 (13/13, against 6/6 in retail mode).
Requests without the flag stay byte-identical to upstream v77, checked against a build of the
pinned commit. On the 3000 m course (10810) ρ reaches 0.909 but σΔ stays near 1 L.

Stage A-G runs paired, and so does the Skill Chart; Compare stays retail until the "Paired
seeds (lower noise)" switch is on. `cache.ts` namespaces search and verify per mode
(`nsWithMode`), so a value measured one way is never folded into a stat from the other, and
setupKeys carry the mode so a prepared worker is not reused across modes. Seed lists stay
mode-independent, so search and verify seeds remain disjoint (P3). Config sizing still comes
from the retail-mode noise record below and needs re-deriving from paired noise (§J.3).

## Tests

- `npm run test:optimizer` — pure units (space/knapsack/cache/stats) + the
  live-engine evaluator integration (40 seeds; seconds) + the surrogate units
  (`surrogate.test.ts`: additive recovery, planted-synergy lift, noise fails the
  R² gate, inverse-variance weighting, graceful degradation) + the opening-book
  units (`book.test.ts`: key fingerprinting, best-effort storage, the
  affordable/one-per-group seed filter) + the synthetic oracle
  (`search.oracle.test.ts`: 100 small instances fully enumerated, recommendation
  must be the optimum, within δ_min, or a statistical tie — gate ≥95%; 5 medium
  30–40-option instances vs a random-restart + exhaustive hill-climb baseline; a
  Stage-F beam check; the surrogate on/off race comparison; and the §6.4 scenario
  set — `aggregateValues` formulas plus a two-scenario maximin-vs-mean run whose
  optimum moves between scenarios). Gaussian noise is calibrated to the σ table
  above — a shared field term that cancels in pairing + a per-build term that
  survives it, CRN per position. The oracle's second-scenario weight is derived
  from the pair ids, not the RNG, so scenario 0 stays byte-identical to the
  single-scenario run (its 95% gate is unaffected by the scenario work).

Surrogate race findings (measured, in-suite): at the engine's real noise band the
posterior SE is too wide to certify any move hopeless, so the surrogate is
quality-safe but race-neutral (its acquisition only reshuffles the search).
Once the model is trustworthy (large cache / low variance) its α/β pruning cuts
~20% of search races with zero quality loss. The plan's ≤70%-of-Phase-3 target is
production-scale (a real Standard run is Stage-D+F-bound); this harness's fixed
Stage-B screening and the bandit's per-candidate seed floor hold the synthetic
ratio above it — the assertion pins the always-holds property (real cut, no
quality loss), not the aspiration.

- `npm run test:optimizer:slow` — real-engine exhaustive check: 3 setups ×
  ~12 purchasable options, every affordable build enumerated on the SAME
  held-out verify seeds; the recommendation must BE the exhaustive best or tie
  it (paired ℓ CI straddles 0). Objective is meanLead (P(1st) is degenerate
  for a skill-less base vs the strong default field). Cold-start bound: default
  1 setup / 9 options / 400 seeds (~4 min, worker_threads); `SLOW_FULL=1` runs
  the full §13.2 sizing.
- `npm run test:globalsim-compact` — the record the optimizer reads is
  bit-identical between the wasm and JS extraction paths.
