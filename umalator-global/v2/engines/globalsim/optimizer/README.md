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
- `bandit.ts` — successive-halving seed allocation vs the incumbent (§9):
  every candidate's last Δ (eliminated included) is returned for the Stage D
  re-solve; LUCB plugs in behind the same result shape (Phase 3)
- `surrogate.ts` — ridge+pair-feature model for move ordering (§8 E) — Phase 4, not yet present
- `search.ts` — Stages B–D + G orchestration (anytime): chart-parity screening,
  MCKP restarts, in-context drop/add/replace/pair moves with bandit allocation
  and knapsack re-solve (ℓ is the search currency, §6.1), fresh-seed Stage G
  verification with honest ties
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
  live-engine evaluator integration (40 seeds; seconds) + the synthetic
  oracle (`search.oracle.test.ts`: 100 small instances fully enumerated,
  recommendation must be the optimum, within δ_min, or a statistical tie —
  gate ≥95%; Gaussian noise calibrated to the σ table above, CRN shared field
  noise + per-build term).
- `npm run test:optimizer:slow` — Phase-3 real-engine exhaustive check (planned, not yet wired): 3
  setups × ~12 options fully enumerated (minutes, node).
- `npm run test:globalsim-compact` — the record the optimizer reads is
  bit-identical between the wasm and JS extraction paths.
