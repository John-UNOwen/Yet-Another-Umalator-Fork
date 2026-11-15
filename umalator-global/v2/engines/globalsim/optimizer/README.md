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
- `search.ts` — Stages B–F + G orchestration (anytime): chart-parity screening,
  MCKP restarts, in-context drop/add/replace/pair moves with bandit allocation
  and knapsack re-solve (ℓ is the search currency, §6.1), a Stage-F local
  search over richer 1-1/1-2/2-1/pair moves (history heuristic, budget-feasible
  neighbourhood, adopt-only-significant, surrogate-ordered, beam-capable),
  fresh-seed Stage G verification with honest ties
- `book.ts` — opening book (localStorage `umalator_v2_optimizer_book`) — Phase 5, not yet present

Outside this directory only three things changed: `workerCore.ts` compact
records carry `bestRivalFinishTimeRaw` (both the JS and the wasm
`run_compact` paths, bit-identical — `compact-parity.test.ts`),
`metrics.ts` gained `leadMarginL` (ℓ in lengths,
`(bestRivalT − ownT) × finish speed / 2.5`), and the app shell gained the
Optimize tab.

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

## Tests

- `npm run test:optimizer` — pure units (space/knapsack/cache/stats) + the
  live-engine evaluator integration (40 seeds; seconds) + the surrogate units
  (`surrogate.test.ts`: additive recovery, planted-synergy lift, noise fails the
  R² gate, inverse-variance weighting, graceful degradation) + the synthetic
  oracle (`search.oracle.test.ts`: 100 small instances fully enumerated,
  recommendation must be the optimum, within δ_min, or a statistical tie —
  gate ≥95%; 5 medium 30–40-option instances vs a random-restart + exhaustive
  hill-climb baseline; a Stage-F beam check; and the surrogate on/off race
  comparison; Gaussian noise calibrated to the σ table above — a shared field
  term that cancels in pairing + a per-build term that survives it, CRN per
  position).

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
