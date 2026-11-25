# Yet-Another-Umalator-Fork

[![Deploy site to GitHub Pages](https://github.com/John-UNOwen/Yet-Another-Umalator-Fork/actions/workflows/pages.yml/badge.svg)](https://github.com/John-UNOwen/Yet-Another-Umalator-Fork/actions/workflows/pages.yml)
[![CI](https://github.com/John-UNOwen/Yet-Another-Umalator-Fork/actions/workflows/ci.yml/badge.svg)](https://github.com/John-UNOwen/Yet-Another-Umalator-Fork/actions/workflows/ci.yml)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-green)](uma-skill-tools/LICENSE)

Live: **https://john-unowen.github.io/Yet-Another-Umalator-Fork/**

A personal fork of [TheCing/uma-tools](https://github.com/TheCing/uma-tools) (Moomoolator), which itself is a hybrid fork of [alpha123/umalator](https://github.com/alpha123/umalator) and [kachi-dev/umalator](https://github.com/kachi-dev/umalator). All three modes (Compare, Skill and Optimizer) run [GlobalSim](https://github.com/daftuyda/GlobalSim), a full-field Rust race engine, in place of the idealized single-uma solver. The classic TypeScript engine and the JP and HP-calculator apps are gone. GlobalSim is vendored as a git submodule at upstream v77 (`27a4d13`) plus three commits on this fork's `paired-draws` branch, and compiled to WebAssembly that runs in browser Web Workers. [docs/globalsim-upgrade.md](docs/globalsim-upgrade.md) describes the branch and its acceptance numbers.

![Umalator Skill mode](docs/screenshot.png)

## The live site

The Pages deployment serves the v2 Global simulator at the site root. The repository's other tools (event tracker, skill visualizers, mechanics explorer, team trials, release timeline) are present in the source tree but not deployed here. The JP simulator and HP calculator were removed. The upstream project hosts its own set of tools at [umalator.app](https://umalator.app/).

GitHub Pages has no server components, so two upstream features change. Screenshot OCR import needs your own Gemini API key (the shared proxy does not exist here), and the feedback form is hidden. Everything else runs client-side.

## What runs where

There is one engine and no engine selector: GlobalSim runs every mode. The classic v1/v2 engines this fork descended from are gone.

GlobalSim mode changes what Compare and the skill chart measure:

- Every simulated race carries nine runners: the tested uma plus eight mobs from a fixed preset (`umalator-global/v2/engines/globalsim/mob-presets.json`). Compare races both builds over paired seeds and reports the full-field finish difference, win rate, ties, HP-out and rushing rates, and min/max/mean/median snapshots with representative replays.
- The skill chart reports, per skill, the mean margin with a 95% CI against the baseline build, how often the skill fired, and `vs Base`: the paired ahead-share as signed points around the 50% neutral point (ties counted against).
- Race outcomes come from the engine's own frame data, so position, speed and HP curves in the track overlay are real full-field traces.
- Skills are gated to the engine's skill table: 751 entries (730 validated against engine v70 plus 21 supplemented, see `globalsim/skills-supplement.json`). Uncovered skills, outfits and awakenings are hidden in GlobalSim mode, and the settings panel shows how many of your skills are not yet covered.
- The Simulation threads setting sizes the worker pool (1-32, or auto). Auto uses one fewer core than your machine reports, capped at 32.

## Reading the numbers

Margins are horse lengths (bashin), 1 length = 2.5 meters. Positive means Uma 2 finishes ahead, which matches the classic CLI tool's `posDifference` sign convention. The 95% CI reflects how much the sampled seeds scatter. A CI that crosses zero means the margin is within seed noise at that sample size.

## Development

Prerequisites: Node.js 20+ (CI uses 22). Rust stable, the `wasm32-unknown-unknown` target and `wasm-pack` 0.15.1 are needed only when rebuilding the engine from the submodule.

```bash
npm install

# develop the app
cd umalator-global && node build.mjs --serve    # http://localhost:8000/umalator-global/v2/
npm run dev:v2                                  # the same app through the Vite dev server

# build
node umalator-global/build.mjs                  # esbuild bundles + globalsim assets
npm run build:v2                                # Vite production build to umalator-global/v2/dist

# rebuild the engine wasm (needs Rust + wasm-pack)
git submodule update --init --recursive
cd globalsim-wasm && wasm-pack build --target web --release --out-dir pkg
cd .. && node umalator-global/build.mjs         # copies pkg, geometry and the merged skill table into globalsim/
```

The asset prefix defaults to `/uma-tools`. Set `CC_BASE_PATH` at build time to change it. An empty string serves assets from the site root. Every build script, the Vite configs and the dev servers honor it, and the Pages workflow fills it in from the repository name, so renaming or moving the deployment needs no code change.

### Tests

CI runs these on every push (`.github/workflows/ci.yml`):

```bash
npm run test:globalsim            # adapter goldens, byte-identical request building
npm run test:globalsim-metrics    # margin math, tail grid, aggregates, CI
npm run test:globalsim-pool       # worker pool scheduling, crash and abort policy
npm run test:globalsim-mobs       # field construction, seed-derived gates
npm run test:globalsim-compact    # wasm compact telemetry vs the JS extraction path
npm run test:globalsim-spurt      # the full-spurt judge
npm run test:globalsim-simserver  # local sim server: token gate, HTTP parity, child crash
npm run test:globalsim-skills     # skill table coverage against the native engine
npm run test:globalsim-skilldata  # per-worker table injection, engine fallback guard
npm run test:globalsim-compare    # end-to-end compare through the real wasm
npm run test:globalsim-h2h        # both umas plus 7 mobs, mirrored gate pairs
npm run test:globalsim-chart      # end-to-end chart through the real wasm
npm run globalsim:coverage        # skill coverage gate over the engine skill table
npm run typecheck:roster          # scoped tsc over umalator-global/v2/roster/
npm run test:optimizer            # search space, knapsack costs, cache, evaluator, surrogate, book, bandit, oracle and realistic suites
npm run test:career-import        # career import reader (Hachimi dump, umadump snapshot)
npm run test:skill-hints          # hint discounts and skill cost walks
npm run test:skill-drift          # the drift checker's own tests
npm run test:skill-data-fields    # skill_data.json field shape
npm run test:mechanics            # mechanics-explorer formulas
npm run test:base-path            # asset prefix resolution
npm run test:ocr                  # screenshot reader
node globalsim-wasm/test/phase0.mjs --seeds 25   # wasm vs native byte parity
```

These are local-only:

```bash
npm run test:globalsim-backend-gpu # gpu session parity + CPU rerun (skips when no gated GPU)
npm run test:optimizer:slow       # exhaustive search cross-check, several minutes
npm run test:roster               # roster decoder and storage
npm run check:skill-drift         # compare skill_data.json against docs/master.mdb
```

CI also runs the engine's own `cargo test --release` and both app builds.

### Enable the GPU lane

Optional and off by default: the sim server can run compact seed chunks on an OpenCL GPU through the engine fork's `gpu` crate, alongside the CPU lanes. The app only touches the lane when `SIM_SERVER_BACKENDS` names `gpu` or a session asks for `engine:"gpu"`.

Prerequisites:

- Windows with Node 20+, the MSVC toolchain and Rust 1.100+ (`%USERPROFILE%\.cargo\bin` on PATH), plus Intel oneAPI: its `lib` dir supplies `OpenCL.lib` at link time.
- A GPU that passes the kernel's exactness gate. Verified on Intel Arc B580. The gate refuses other devices and names the reason.

The engine and its GPU crate ship in the same vendored tree (`vendor/GlobalSim`, pinned to the merged engine commit), so there is no second checkout to manage.

One script does the setup, no prompts and no arguments:

```powershell
node tools/setup-gpu-lane.mjs
```

It checks the toolchain, builds the addon with `--features gpu`, runs the device gate, and prints the three commands that turn the lane on.

What stays safe on a fresh clone with nothing set:

- `globalsim_native.node` is gitignored, and the sim server with `NATIVE_ENGINE` unset loads only the wasm pkg. It never needs the addon to exist.
- The cargo `gpu` feature stays off by default, so CI never links OpenCL. The gpu path dep points inside the vendored engine tree, so a cargo command inside `globalsim-native/` needs nothing outside the repo.
- A session with no explicit engine gets wasm. `gpu` enters rotation only when `SIM_SERVER_BACKENDS` names it, and an unavailable gpu (missing addon or gate refusal) is filtered out at startup with the log line `[sim-server] gpu backend unavailable (...) — rotating CPU backends only`.
- `POST /session` with `{"engine":"gpu"}` answers 503 with the probe's reason while the gate refuses.

A compact seed chunk goes to one `gpuRunCompactBatch` facade call. Each launch pays about 430 ms of race-kernel device time for the v77 1461-tick field, so bigger same-setup chunks amortize that floor (measured 10.8 ms/seed at 96-seed chunks). `SIM_SERVER_GPU_BATCH=0` opts back to one call per seed.

Seeds the kernel gate refuses answer `{"seed":…,"gpuFallback":"<reason>"}`. The pool re-runs those seeds on one dedicated CPU worker. Callers that hand out gpu workers pass a `cpuFactory` for it (the chart and the optimizer evaluator accept one). A pool without it turns refusals into seed-error slots. The pool reports per-job `gpuFallbacks` tallies and logs `[globalsim-pool] job <id>: gpu races N, fallbacks {reason: n}, rerun failures N`.

`npm run test:globalsim-backend-gpu` proves the lane end to end and skips with a printed reason when the device gate refuses. Current kernel and skill coverage lives in `vendor/GlobalSim/gpu/SKILLS_DESIGN.md`.

### Layout

```
globalsim-wasm/                    wasm-bindgen wrapper around the engine
globalsim-native/                  napi addon: the sim server's native engine backend,
                                   and the gpu lane behind --features gpu
                                   (see its README for the sibling-checkout and LIB needs)
vendor/GlobalSim/                  the engine submodule (fork branch paired-draws
                                   on upstream v77)
umalator-global/v2/                the simulator app
  engines/globalsim/               adapter, worker core, pool, compare, chart, metrics
globalsim/                         deploy assets; skills-supplement.json is committed,
                                   wasm/ geometry/ skills.json are generated
tools/globalsim-coverage.mjs       skill coverage gate and merged table generator
docs/globalsim-upgrade.md          engine upgrade runbook
.github/workflows/                 pages.yml (deploy), ci.yml, sync-upstream-data.yml
```

## Deployment and data flow

- `pages.yml` builds the wasm, the app and the runtime assets, then deploys to GitHub Pages on every push to master.
- `sync-upstream-data.yml` runs daily, pulls alpha123's Global game data, verifies the build, and opens a pull request against master. Merging is what deploys new data. If a brand-new skill has no engine definition yet, the coverage gate step fails on the PR. `docs/globalsim-upgrade.md` describes adding a supplement entry.
- Engine version bumps follow the same runbook: bump the submodule, re-copy the request profile, rerun parity and coverage, update the version label.

## Credits

- **alpha123/umalator** by alpha123 & pecan, and **kachi-dev/umalator (VFalator)** by kachi & Jecht, for the simulator this fork builds on
- **daftuyda/GlobalSim** for the full-field race engine (the submodule sits on this fork's `paired-draws` branch, based on upstream v77. Upstream ships no license declaration, so it is vendored unaffiliated)
- **Skill data** from [GameTora](https://gametora.com/umamusume)
- **Game**: Uma Musume: Pretty Derby, (C) Cygames
- **Community**: [Moomoo Discord](https://discord.gg/moomoocows)

## License

GPL-3.0-or-later, see [LICENSE](uma-skill-tools/LICENSE), for this repository's code.
