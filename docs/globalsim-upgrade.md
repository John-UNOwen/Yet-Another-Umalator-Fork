# GlobalSim engine upgrade runbook

How to bump the vendored engine (`vendor/GlobalSim` submodule) from one release
to the next (currently **v77**, commit `27a4d13`). Every step has a Windows
PowerShell form and a Linux/CI form; run one form or the other, not both.

The invariants this runbook protects (integration plan §7): the pinned submodule
is consumed unmodified, the validated runtime profile is copied verbatim from
the example, and every layer below it (goldens, acceptance suites, coverage
gate) is re-verified against the new engine before the fork ships it.

Work on a branch (e.g. `globalsim-v78`), one commit per numbered step.

## 0. Prerequisites

A Rust stable toolchain (native builds), Node 22+, and — for step 6 — wasm-pack
0.15.1 + the wasm32 target:

```powershell
wasm-pack --version                      # must be 0.15.1
rustup target add wasm32-unknown-unknown
```

```sh
wasm-pack --version
rustup target add wasm32-unknown-unknown
```

## 1. Bump the submodule and record the pin

```powershell
git -C vendor/GlobalSim fetch --tags
git -C vendor/GlobalSim checkout v78     # the new tag
git add vendor/GlobalSim
git commit -m "chore: bump GlobalSim submodule to v78"
```

```sh
git -C vendor/GlobalSim fetch --tags
git -C vendor/GlobalSim checkout v78
git add vendor/GlobalSim
git commit -m "chore: bump GlobalSim submodule to v78"
```

(`git submodule update --remote vendor/GlobalSim` also moves it to the default
branch tip — prefer the explicit tag checkout; never track a branch.)

Record the new commit hash in `globalsim-wasm/README.md` (line: "tag **vNN**,
commit `xxxxxxx`") — that file is the pin's human-readable home.

Run the engine's own (unchanged upstream) tests on the new commit:

```powershell
cargo test --release            # run from vendor/GlobalSim
cargo build --release --no-default-features   # stdin worker (mimalloc off)
```

```sh
(cd vendor/GlobalSim && cargo test --release)
(cd vendor/GlobalSim && cargo build --release --no-default-features)
```

## 2. Re-copy the validated runtime profile

The adapter merges `profile-v77.json` into every request
(`umalator-global/v2/engines/globalsim/adapter.ts`). It must stay a **verbatim
copy of the non-race keys** of the new `examples/vNN-race.jsonl`. The example
line is one JSON object; the race keys the app supplies per run are exactly:

`seed, courseId, groundCondition, weather, season, horses`

Everything else is the profile — currently these 12 keys, in this order:

`laneSelectionVersion, raceInitializationVersion, positionKeepVersion,
skillValueVersion, raceContextVersion, experimentalRetailInitialization,
experimentalRetailSections, experimentalRetailRuntime, experimentalRetailGeometry,
retainAllFrames, dataSignature, skillData`

New releases may add or rename switches — diff the key sets; a profile key the
new engine no longer mentions should be re-read against the new
`docs/ARCHITECTURE.md` "Numerical reproducibility" section before dropping it.
Never hand-edit values.

```powershell
node -e "const fs=require('fs');const ex=JSON.parse(fs.readFileSync('vendor/GlobalSim/examples/v78-race.jsonl','utf8').split('\n')[0]);const RACE=new Set(['seed','courseId','groundCondition','weather','season','horses']);const profile={};for(const[k,v]of Object.entries(ex))if(!RACE.has(k))profile[k]=v;fs.writeFileSync('umalator-global/v2/engines/globalsim/profile-v78.json',JSON.stringify(profile))"
git rm umalator-global/v2/engines/globalsim/profile-v77.json   # the rename lands with step 3's commit
```

```sh
node -e "const fs=require('fs');const ex=JSON.parse(fs.readFileSync('vendor/GlobalSim/examples/v78-race.jsonl','utf8').split('\n')[0]);const RACE=new Set(['seed','courseId','groundCondition','weather','season','horses']);const profile={};for(const[k,v]of Object.entries(ex))if(!RACE.has(k))profile[k]=v;fs.writeFileSync('umalator-global/v2/engines/globalsim/profile-v78.json',JSON.stringify(profile))"
```

(The `skillData` key of the profile is the engine's bundled legacy table; the
app does not use it as-is — step 4's merged-table injection overrides it. It is
still copied verbatim so the profile stays a faithful settings block.)

Rename + rewire (then commit):

- rename `profile-v77.json` → `profile-vNN.json` and update its import in
  `adapter.ts` (`import profileV77 from './profile-v77.json'`) plus the comment
  lines naming it,
- `grep -rn v77 --include='*.ts' --include='*.mjs' --include='*.md' umalator-global globalsim-wasm tools` and
  update the mentions that are about the PIN (profile name, golden name,
  comments, README) — not the ones that are historical notes ("captured from
  examples/v77-race.jsonl") until the golden itself is regenerated (step 5).

## 3. Bump the version strings

- `umalator-global/v2/engines/globalsim/compare.ts`:
  `export const GLOBALSIM_ENGINE_VERSION = 'v77'` → `'vNN'`.
  The UI line ("GlobalSim vNN · skill table v70 + N supplement", shown in
  results and asserted by `compare.acceptance.test.ts`) derives from it — plus
  the acceptance test's own `startsWith('GlobalSim v77 · ...')` literal.
- `globalsim-wasm/README.md` tag/commit line (step 1).
- The plan/upgrade-doc mentions are historical; leave them.

## 4. Re-validate the skill supplement against the new engine

`globalsim/skills-supplement.json` (the fork's batch-1 ported skills) must
still prepare inside the new engine. Run the merged-table build + coverage:

```powershell
npm run globalsim:coverage:write    # regenerates the tracked globalsim/coverage-report.md
npm run globalsim:coverage          # the gate: exit 1 on an uncovered live skill, writes nothing
npm run test:globalsim-skilldata    # merged table -> globalsim/skills.json, injected into the real (wasm) engine
npm run test:globalsim-skills       # merged table -> globalsim/skills.merged.json; every supplement entry prepares AND activates (stdin worker)
```

```sh
npm run globalsim:coverage:write
npm run globalsim:coverage
npm run test:globalsim-skilldata
npm run test:globalsim-skills
```

`globalsim:coverage:write` is `node tools/globalsim-coverage.mjs --write`; the bare
`globalsim:coverage` (and `globalsim:coverage:merged`, which writes only
`globalsim/skills.merged.json`) is the same tool without `--write`, so it prints the
report to stdout and **writes no files** — regenerating the tracked report needs the
`:write` form. The merged tables the suites load (`globalsim/skills.json`,
`globalsim/skills.merged.json`, both gitignored) are written by the `--out` flag that
the two suite scripts pass themselves.

Known failure signature: the engine rejects an entry at prepare with
**`Missing retail initialization field`** when its condition/field vocabulary
outpaces what the new engine's retail initialization recognizes. That is a
supplement-entry problem, not a wrapper problem. The app path that keeps batch-1
skills alive is the **merged-table injection**: `tools/globalsim-coverage.mjs`
merges `v70-skill-data.json` + the supplement, `pool.ts` sends that table to
every worker once (`{type:'skillData'}`) and the adapter passes it as the
request's `skillData` — replacing profile-vNN's pure v70 table
(`skilldata.acceptance.test.ts` pins exactly this: v70-only prepare fails for
supplement IDs, merged-table prepare succeeds). Re-port the failing entry
against the new engine's docs/SKILLS.md (conditions must parse AND the skill
must activate — `test:globalsim-skills` checks both), or, if it cannot be
ported cleanly, drop it from the supplement and let the coverage gate hide the
skill again. Re-run this step until green. Commit the regenerated
`globalsim/coverage-report.md` (tracked) — it is only ever refreshed by
`globalsim:coverage:write`, never by the gate run, so check it is not stale
(`git --no-pager diff --stat globalsim/coverage-report.md`) before committing.

Also refresh the committed `globalsim/courses.json` on every engine bump — it is
the app's course-id validation set, copied from the engine's own
`vendor/GlobalSim/data/course_data.json` (STRING keys, in `Object.keys` order;
the app gate does `Set(ids).has(String(courseId))`, so numeric ids would reject
every course). `npm run build:global` regenerates it from the new submodule pin
(`generateGlobalsimAssets()` in `umalator-global/build.mjs`) — commit the file
whenever it changes, because the Pages deploy serves the **committed** copy and a
stale set silently rejects courses the new engine supports.

## 5. Rebuild wasm and regenerate the vNN goldens

```powershell
cd globalsim-wasm
wasm-pack build --target web --release --out-dir pkg   # the pkg the acceptance suites load
cargo build --release --examples                        # native_ref (parity twin)
cd ..
node globalsim-wasm/test/phase0.mjs --seeds 25          # wasm-vs-native byte parity, 3 courses
npm run test:globalsim                                  # adapter + goldens (expected RED here)
```

```sh
(cd globalsim-wasm && wasm-pack build --target web --release --out-dir pkg)
(cd globalsim-wasm && cargo build --release --examples)
node globalsim-wasm/test/phase0.mjs --seeds 25
npm run test:globalsim
```

The goldens (`umalator-global/v2/engines/globalsim/v77-golden.json`) pin the
engine's exact replies for 5 seeds. If the engine's numbers legitimately moved,
regenerate them with `native_ref` — the capture procedure from the golden file's
own header ("request + geometry, seeds on stdin"):

There is no committed regen script; the capture is
`native_ref <request.json> <geometry.json>` with one seed per stdin line, where
request.json is the raw new `examples/vNN-race.jsonl` line and geometry is
`vendor/GlobalSim/data/course_geometry/<golden.courseId>.json`. Rebuild the
JSON with the golden's shape — `{ courseId, seeds, replies: [{ sha256,
finishTimeRaw, finishOrder, playerLastSpurtTime }] }` — e.g.:

```sh
node -e "
const {spawnSync}=require('child_process'),fs=require('fs'),crypto=require('crypto');
const ex=fs.readFileSync('vendor/GlobalSim/examples/v78-race.jsonl','utf8').split('\n')[0];
fs.writeFileSync('/tmp/req.json',ex);
const seeds=[/* the 5 seeds from the old golden */];
const r=spawnSync(process.platform==='win32'?'globalsim-wasm/target/release/examples/native_ref.exe':'globalsim-wasm/target/release/examples/native_ref',
  ['/tmp/req.json','vendor/GlobalSim/data/course_geometry/'+/*golden.courseId*/+'.json'],
  {input:seeds.join('\n')+'\n',maxBuffer:4e9,encoding:'utf8'});
if(r.status!==0)throw new Error(r.stderr);
const replies=r.stdout.split('\n').filter(Boolean).map(l=>{const v=JSON.parse(l);
  return {sha256:crypto.createHash('sha256').update(l,'utf8').digest('hex'),
          finishTimeRaw:v.results.map(x=>x.finishTimeRaw),
          finishOrder:v.results.map(x=>x.finishOrder),
          playerLastSpurtTime:v.playerLastSpurtTime};});
fs.writeFileSync('umalator-global/v2/engines/globalsim/v78-golden.json',
  JSON.stringify({_comment:'<update the header text: new tag + same capture procedure>',courseId:/*same courseId unless the example changed it*/,seeds,replies},null,1));
"
```

Then rename `v77-golden.json` → `vNN-golden.json`, update the `require` in
`adapter.test.ts` (and its comment), and re-run:

```sh
npm run test:globalsim
```

**Only regenerate goldens when the engine change is understood and intended** —
compare old vs new `finishTimeRaw`/`finishOrder` deltas first; an unexplained
golden change is a regression signal, not a chore.

## 6. Run the whole fork suite + builds

CI (`.github/workflows/ci.yml`) runs exactly this list — reproduce any failure
locally with it:

```sh
npm run test:globalsim          # adapter + goldens
npm run test:globalsim-mobs     # 9-runner field determinism
npm run test:globalsim-metrics  # margins / win rate / placings
npm run test:globalsim-pool     # scheduler / crash recovery
npm run test:globalsim-skilldata
npm run test:globalsim-compare  # full compare pipeline vs real wasm
npm run test:globalsim-chart
npm run test:globalsim-skills
npm run globalsim:coverage      # the gate — prints the report, writes nothing
npm run typecheck:roster
npm run build:v2 && npm run build:global
```

GlobalSim's own python regression suite over `tests/fixtures` (84 official
captures) is NOT part of this fork's CI — it stays upstream's native-side job.
This fork's parity net is `phase0.mjs` (wasm-vs-native byte parity) plus the
acceptance suites above running against the real engine.

## 7. Commit

```
chore: upgrade GlobalSim to vNN (submodule, profile, goldens)
```

Then open the PR — CI is the gate.

## Decision record: panic strategy

Upstream GlobalSim ships **`panic = "abort"`** in its release profile and this
fork keeps that (the submodule is consumed unmodified — plan D8, and the stdin
worker / upstream tests run exactly as upstream ships them). The fork's wrapper
crate, `globalsim-wasm/Cargo.toml`, deliberately builds **`panic = "unwind"`**
for its release profile: an engine panic then becomes a rejected run
(`"engine panic: …"`, killing only that handle, which `pool.ts` recreates)
instead of a wasm trap that kills the whole Web Worker. TypeScript input
validation still runs first — unwind is the backstop, not the contract. See the
comment in `[profile.release]` of `globalsim-wasm/Cargo.toml`.
