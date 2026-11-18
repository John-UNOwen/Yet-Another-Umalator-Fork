# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Important Guidelines

- **Do not add "Co-Authored-By" trailers to git commits** - Keep commit messages clean without attribution

## Project Overview

**Yet Another Umalator** is a Uma Musume race simulator built on **GlobalSim**, a full-field Rust race engine compiled to wasm and run in browser Web Workers. Forked from TheCing/uma-tools (Moomoolator), itself a hybrid fork of alpha123/umalator and kachi-dev/umalator.

This fork is **Global/English only, GlobalSim only**: the JP app, the classic TypeScript engine and the HP calculator have been removed. It deploys to **GitHub Pages at <https://john-unowen.github.io/Yet-Another-Umalator-Fork/>** (see [Deployment](#deployment)). The upstream `umalator.app` domain, Cloudflare Pages project and Functions belong to upstream and are not what this repo runs.

### Live Applications

This fork deploys **one** application. `.github/workflows/pages.yml` builds the v2 app and publishes `_site` (the Vite `dist/` plus `icons/`, `fonts/`, `globalsim/` and the og image) to <https://john-unowen.github.io/Yet-Another-Umalator-Fork/> on every push to `master`.

| Application | Where | Description |
|------------|-----|-------------|
| **Simulator (the whole site)** | <https://john-unowen.github.io/Yet-Another-Umalator-Fork/> | The v2 app: GlobalSim (wasm) engine, Compare / Skill / Optimizer modes, served at the Pages project root. |
| Events, skill visualizers, mechanics explorer, team trials, release timeline | source tree only | Not deployed: `pages.yml` copies none of them into `_site`. Building one locally works (`cd events && node build.mjs`), but a link to `/events/` on Pages 404s. Upstream hosts its own set at `umalator.app`. |

GitHub Pages has no server components: `_redirects` and `functions/` are Cloudflare Pages artifacts that never execute here, the OCR proxy and Turnstile build empty (screenshot OCR needs the user's own Gemini key), and the feedback drawer is switched off (`VITE_ENABLE_FEEDBACK=false` in `umalator-global/v2/.env`, plus no webhook).

### Project Structure

```
├── umalator-global/             # Global simulator app (v2) — the deployed site
│   ├── v2/                      # The app
│   │   ├── app-v2.tsx          # Main application
│   │   ├── engines/globalsim/  # GlobalSim engine layer (worker, wasm bridge, modes, optimizer)
│   │   ├── components/         # V2-specific components
│   │   ├── velocity-overlay.tsx
│   │   ├── results-pane.tsx
│   │   └── vite.config.ts      # Vite: dev server + the deployed dist/ build
│   ├── mechanics-explorer/      # Stat → mechanics formula explorer (source only, not deployed)
│   ├── skill-visualizer/        # Global skill visualizer (source only, not deployed)
│   ├── build.mjs               # esbuild bundles + generates the app's data files
│   ├── skill_data.json         # English game data
│   └── course_data.json
├── globalsim-wasm/              # wasm-bindgen wrapper around the engine
├── vendor/GlobalSim/            # the engine submodule (fork branch paired-draws, based on upstream v77)
├── globalsim/                   # deploy assets: wasm/, geometry/, skills.json generated; supplement committed
├── events/                      # Events page (source only, not deployed)
├── uma-skill-tools/             # Shared library (enums, course data, skill parsing, cost calc)
├── tools/                       # Utility scripts (coverage gate, master.mdb pull, fast-forward)
├── docs/                        # Documentation, guides and master.mdb
├── .github/workflows/           # pages.yml (deploy), ci.yml, sync-upstream-data.yml
├── uma-tools-worker/            # upstream Cloudflare Worker (webhook + OCR proxy) — not deployed here
└── components/                  # Shared UI components (RaceTrack.tsx, base-path.ts, GeminiOCR.ts)
```

## Development Commands

### Building Frontend Applications

**Simulator app (v2):**
```bash
cd umalator-global
node build.mjs              # Build v2 (production)
node build.mjs --serve      # Dev server with hot reload
node build.mjs --serve 3000 # Custom port
node build.mjs --debug      # Unminified with assertions
```

**Access URL:**
- V2: `http://localhost:8000/umalator-global/v2/`

The dev server:
- Serves files from project root (includes shared `icons/`, `fonts/`)
- Auto-rebuilds on source changes
- Strips `/uma-tools/` prefix from asset requests

**Other Applications** (none of these are deployed by `pages.yml`, and they each build standalone):
```bash
cd events && node build.mjs
cd umalator-global/skill-visualizer && node build.mjs      # Global visualizer
cd skill-visualizer-jp && node build.mjs                   # JP visualizer
cd umalator-global/mechanics-explorer && node build.mjs    # or: npm run build:mechanics
cd team-trials && node build.mjs                           # or: npm run build:team-trials
cd release-timeline && node build.mjs                      # or: npm run build:release-timeline
```
`build-planner/` and `courseimages/` have only a `build.bat` (no `package.json`), and their
committed bundles assume the upstream `/uma-tools/` asset prefix.

### V2 Development with Vite

V2 can optionally use Vite for development (faster HMR):

```bash
cd umalator-global/v2
npm run dev    # Vite dev server on http://localhost:5173
npm run build  # Production build
```

**Note**: `build.mjs` is the primary build system. Vite is optional for v2-only development.

### IDE Errors to Ignore

**CC_GLOBAL errors**: The IDE may show errors like `Cannot find name 'CC_GLOBAL'` in `.tsx` files. These are **safe to ignore** - `CC_GLOBAL` is a build-time constant defined by esbuild. The build will succeed despite these IDE warnings.

### Working with uma-skill-tools

The core simulation library is in `uma-skill-tools/`. This uses TypeScript and is run via `ts-node`:

```bash
cd uma-skill-tools

# Run CLI tools
ts-node tools/skillgrep.ts [options]    # Search skills by name or condition
ts-node tools/gain.ts [options]         # Calculate skill バ身 gain
ts-node tools/dump.ts [options]         # Dump race simulation data
ts-node tools/compare.ts [options]      # Compare two uma configurations
ts-node tools/speedguts.ts [options]    # Analyze speed/guts combinations

# Run tests
npm test  # Uses tape test framework
```

### Testing

```bash
cd uma-skill-tools
npm test  # Runs tape tests in test/ directory
```

Benchmark: `ts-node test/bench/bench.ts`

### Python Visualization Tools

Some tools require Python 3 and matplotlib:

```bash
# Visualize race data
ts-node tools/dump.ts [options] | python tools/plot.py [options]

# Show histogram of バ身 gain
ts-node tools/gain.ts --dump [options] | python tools/histogram.py [options]

# Visualize speed/guts analysis
ts-node tools/speedguts.ts [options] | python tools/speedguts_colormesh.py
```

## Architecture

### uma-skill-tools Core Components

**Race Simulation Pipeline:**
1. **RaceSolver.ts**: Numerically integrates position and velocity over the race course
2. **ConditionParser.ts & ActivationConditions.ts**: Parse skill conditions into activation regions
3. **ActivationSamplePolicy.ts**: Samples activation regions (handles randomness)
4. **RaceSolverBuilder.ts**: Orchestrates building a configured race solver with skills

**Key Concepts:**
- **Static conditions/triggers**: Regions where a skill *can* activate
- **Dynamic conditions**: Boolean functions that determine if a skill *will* activate
- **Sample policies**: Control how random/conditional skills are modeled

Skills are defined by:
- Activation conditions (e.g., `phase==2&running_style==3`)
- Sample policy (immediate, random, or distribution-based)
- Effect duration and magnitude

### Frontend Architecture

All frontend apps use:
- **Preact** (React alternative) with JSX via `jsxFactory: "h"`
- **D3.js** for charts and visualizations
- **Immutable.js** for state management
- **esbuild** for bundling (`umalator-global/build.mjs`)
- **Vite** for the v2 app: dev server (HMR) and the deployed `dist/` build

TypeScript config uses `"moduleResolution": "bundler"` and targets ES2018.

### Engine: GlobalSim only

There is one simulation engine: **GlobalSim**, the Rust engine vendored at
`vendor/GlobalSim` and pinned to commit `00d79fa`, three commits past upstream `v77`
(`27a4d13`) on the `paired-draws` branch of this fork's engine fork. `vendor/GlobalSim/VERSION`
names the upstream base (`v77`), not the pin. The branch adds one request flag,
`pairedRandomStreams`, and requests without it reply byte-identical to `27a4d13`. It is
compiled to wasm by the `globalsim-wasm/` crate and run in the browser by the worker in
`umalator-global/v2/engines/globalsim/` (`globalsim.worker.ts` + `workerCore.ts`).
[docs/globalsim-upgrade.md](docs/globalsim-upgrade.md) documents the branch and its acceptance
numbers.

The classic TypeScript engine has been removed: the JP v1 app, the classic Global v1 app,
the v2 classic worker (`v2/simulator.worker.ts`) and the HP/stamina calculator all went with
it. There is no v1 left to compare against: `umalator-global/v2/` is the app, served at the
site root, with three modes (Compare, Skill, Optimizer), all on GlobalSim.

`uma-skill-tools/` is still imported (enums in `RaceParameters.ts`, course data,
`ConditionParser`, skill cost building via `RaceSolverBuilder`), but it no longer runs the
simulation.

**The app (v2):**
- Modern redesigned UI in `umalator-global/v2/`
- Component-based architecture
- Mobile-first responsive design
- Modal dialogs, feedback drawer, mobile navigation
- Built with esbuild (`build.mjs`). The deployed bundle comes from the Vite `dist/` build
- Served at the site root (the old `/umalator-global/v2/` path 301s there)

Everything else is shared as before:
- Data files (skill_data.json, course_data.json)
- Core components (`components/`)
- `CC_GLOBAL` build define, always `'true'` in the app

### V2 Component Architecture

**Core Application:**
- `app-v2.tsx` - Main application with state management
- `results-pane.tsx` - Results display and statistics
- `velocity-overlay.tsx` - Track overlay for velocity/HP visualization
- `velocity-chart.tsx` - Standalone velocity chart

**UI Components:**
```
v2/components/
├── Modal.tsx           # Native-feeling modal dialogs
├── Button.tsx          # Styled button component
├── CustomSelect.tsx    # Dropdown select with icons
├── IconSelect.tsx      # Icon-based selector
├── Dropdown.tsx        # Generic dropdown menu
└── Tooltip.tsx         # Tooltip component
```

**Feature Modules:**
```
v2/
├── feedback-drawer.tsx   # Discord feedback integration
├── mobile-nav.tsx        # Mobile navigation drawer
├── track-select.tsx      # Track/course selector
├── conditions.tsx        # Race conditions panel
├── sim-settings.tsx      # Simulation settings
├── skills.tsx            # Skill selector
├── skill-charts.tsx      # Skill comparison charts
└── uma-panel.tsx         # Uma configuration panel
```

**V2 Features:**
- **URL State**: Shareable URLs via Copy Link (hash-based state serialization)
- **Preset URLs**: `?preset=X` parameter for quick race loading
- **Feedback System**: Discord webhook integration for user feedback
- **Mobile Navigation**: Responsive bottom nav for mobile devices
- **Modal Dialogs**: OCR import, feedback, settings in native-feeling modals
- **Velocity Toggles**: Independent velocity/HP line toggles

### Key Shared Components

**Horse Configuration:**
- `HorseDefTypes.ts`: HorseState Record class (Immutable.js) with regional defaults
- `UmaCard.ts`: PNG export/import with embedded JSON metadata
- `GeminiOCR.ts`: the cloud OCR call kept behind the screenshot import's fallback button
- `Dropdown.tsx`: Reusable dropdown menu component

**Race Visualization:**
- `RaceTrack.tsx`: Interactive track visualization with corners, slopes, skill regions
- `VelocityOverlay.tsx` (v2): SVG overlay for velocity/HP curves

**Skill Management:**
- `SkillList.tsx`: Skill selector with filtering and search
- `SkillIcon.tsx`: Skill icon display
- `SkillBox.tsx`: Skill card component

### Horse Data Save/Load

**JSON Export/Import:**
- Uses `horseStateToJson()` to serialize HorseState
- Skills exported as array of skill IDs
- Includes all stats, aptitudes, strategy, mood, skills, and forced positions

**Uma Card (PNG Export/Import):**
- Embeds JSON data in PNG tEXt metadata chunks with keyword "UmaCard"
- Fetches character portrait from `/icons/chara/trained_chr_icon_{uid}_{outfitId}_02.png`
- PNG remains viewable while carrying build data
- Compatible with sharing platforms
- Extraction reads PNG chunks, parses JSON, validates and loads

**OCR Screenshot Import:**
- `v2/ocr-modal.tsx` recognises screenshots on the device: `components/screenshot-ocr/ocr.worker.ts`
  runs PP-OCRv6 tiny det+rec, and the modules beside it turn the lines into a build
- Several screenshots of one Details dialog are combined, so a skill list taller than the screen imports whole
- Supports drag & drop, paste, or file upload
- The review screen allows editing before loading, and the merged build goes through `validateAndParseUmaJson`
- Google Gemini stays behind the "Use cloud OCR" button, which needs the user's own API key
- The OCR binaries are not in git: `tools/fetch-ocr-assets.mjs` fetches them from pinned revisions and
  checks each SHA-256 against `ocr/MANIFEST.json`, and `pages.yml` does the same before deploying

### OCR Pipeline (screenshot to uma)

> **On this fork**: Pages builds with `OCR_PROXY_URL` and `TURNSTILE_SITEKEY` unset, so
> `CC_OCR_PROXY` is empty, the proxy path is skipped and the modal always asks for the
> user's own Gemini key. The `uma-tools-worker/` proxy and its origin allowlist
> (`umalator.app`, `dev.umalator.app`, `localhost`) belong to upstream and are not deployed
> here. Reviving them means deploying your own worker and adding this fork's Pages origin to
> that allowlist. The mechanism below is kept as the reference for that.

Imports a uma from a game screenshot via Google Gemini. Three consumers share the
flow across two environments:

| Consumer | File | Env | Auth |
|---|---|---|---|
| v2 web modal | `components/GeminiOCR.ts` (shared lib) | Browser | Proxy (no key), then the user's own key |
| OCR proxy | `uma-tools-worker/webhook-proxy.js` | Cloudflare Worker | Server `GEMINI_API_KEY` secret |
| Discord bot | `uma-tools-bot/src/gemini-ocr.ts` | Node | Server key |

**SDK + model:** uses the unified **`@google/genai`** SDK against **`gemini-3.5-flash`**,
a GA model with a free tier (vision + structured output). Do **not** use
`gemini-flash-latest` (floating alias, no guaranteed free tier). **Model retirements
break OCR with a 404 `NOT_FOUND` "no longer available to new users"**: `gemini-2.0-flash*`
shut down 2026-06-01, and `gemini-2.5-flash` was retired for new users ~2026-06 (that's why
the code moved to 3.5-flash on 2026-07-23). Prefer a stable free-tier Flash model and avoid
the bleeding-edge one until its free tier is confirmed. The model is a `MODEL` constant in
`components/GeminiOCR.ts` and `uma-tools-bot/src/gemini-ocr.ts` (2 places). The worker is
model-agnostic.

**Structured output:** the call sets `responseMimeType: 'application/json'` +
`responseSchema` (the `OCRHorseData` shape, with `enum`s for aptitude/strategy), so
Gemini returns guaranteed-valid JSON, and no markdown-fence stripping is needed. The strategy
enum is the four on-screen styles (Nige, Senkou, Sasi, Oikomi). Oonige is not
screenshot-derivable, so the user sets it manually after import if needed.

**Proxy:** the browser points the SDK at the worker via
`httpOptions.baseUrl = OCR_PROXY_URL + '/gemini'`. The worker's `/gemini/*` route is a
transparent reverse proxy: it forwards `/v1beta/models/<model>:generateContent` to
Google, injecting `env.GEMINI_API_KEY` as `x-goog-api-key` (only inference paths are
allowed, and any client-sent key is ignored). Most users never need a key. If the proxy
fails, the client falls back to a user-supplied key (entered in the modal, optionally
saved to `localStorage`). `OCR_PROXY_URL` is provided to the build via the
`CC_OCR_PROXY` esbuild/vite define (from `OCR_PROXY_URL` in `.env.local`). After
deploying the worker, set the secret with `wrangler secret put GEMINI_API_KEY`.

**Abuse protection:** the `/gemini` proxy is gated so only the real apps can spend the
server key. The worker enforces (1) an **Origin allowlist** (`umalator.app`,
`dev.umalator.app`, `localhost`) and (2) a **Cloudflare Turnstile** token. The browser
gets a single-use token from `components/turnstile.ts` (a hidden Managed-mode widget) and
sends it as the `X-Turnstile-Token` header. The worker verifies it via Turnstile
`siteverify` before proxying. With no token, or a failed check, the worker returns `403`
and the client falls back to its user key. Setup: create a Turnstile widget in the
Cloudflare dashboard, put its **sitekey**
in the Pages build env `TURNSTILE_SITEKEY` (public, baked in via `CC_TURNSTILE_SITEKEY`)
and its **secret** in the worker via `wrangler secret put TURNSTILE_SECRET`. The worker
fails closed (`503`) until `TURNSTILE_SECRET` is set. Local dev: Cloudflare's always-pass
test pair (sitekey `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA`).

**To change the model:** edit the `MODEL` constant in the two files above (and confirm
the new model has a free tier if you rely on the proxy).

### Career import (Skill Optimizer)

The Optimizer pane's **Import career** button reads either file a running career produces.
Reader: `umalator-global/v2/career-import.ts`, tests: `npm run test:career-import`.

| Format | Where it comes from | Recognised by |
|---|---|---|
| Hachimi-Edge career dump | `career_<charaId>_<epoch>.json` in `<exe dir>\hachimi\`, written by the "Dump career data" menu | `"kind": "hachimi-career-dump"` |
| umadump career snapshot | `career_data/<identity>/turns/turn_<turn>_<revision>.json`, written by the umadump daemon while the career runs | `single_mode_load_common.chara_info` |

Both apply: outfit, star level, unique level (the level of the outfit's own unique, as
`uniqueSkillForUma()` names it), the five stats (`wiz` becomes wisdom), aptitudes (distance =
best of the four, surface = turf, strategy aptitude = the *actual* running style's own grade),
strategy, mood (`motivation - 3`, game 0-5 to app -2..2), learned skills, hint levels, and the
SP budget. Aptitude numbers are the game's `ProperGrade` enum, 1=G to 8=S. The merged uma goes
back through `validateAndParseUmaJson`, so a bad value cannot reach the sim.

The keys differ per format. The dump reads `character.cardId`, `character.limitBreakCount`,
`stats`, `aptitudes.runningStyle` with its `style*` grades, and `skillPoint`. The snapshot is
the game's own state object, so it reads `card_id`, `rarity` (the limit-break count), `wiz`,
`race_running_style` with the `proper_running_style_*` grades, `skill_point`, and owned skills
from `skill_array`. The dump's `character.charaId` names the character, while a snapshot's
`single_mode_chara_id` is the career's own row id, so the snapshot takes the character from the
outfit id.

Hint levels follow what each writer can see:

- **Dump, per skill**: `skillTipsObserved[id].tipsDiscount` first (the discount the game applies
  to that skill, and this door is not subject to the writer's list cap), the rows' `HintLv`
  second. Its `skillHints` table is keyed per (group, rarity) and its walk caps at 48 items, so
  it is only used to report truncation: spreading one entry over a whole group would invent
  levels for the other rarity tier, which the game tracks separately.
- **Snapshot, per tier**: `skill_tips_array` is `[{group_id, rarity, level}]`, the game's own
  hint table, and a tier is the unit the game prices, so its level goes onto every skill of that
  group and rarity (`skill_meta.json` names the group, `skill_data.json` the rarity). A tier at
  level 0 is written too, which clears a level an earlier import left behind.

The candidate pool differs for the same reason. A dump limits it to its `IsGet≠1` rows that the
app can offer. A snapshot carries no offer list, so its pool is the skill families its
`skill_tips_array` names, less what that career has learned and what
`umalator-global/career-unbuyable.json` lists (skills the game never sells, `skill_data.grade_value
< 0` in `docs/master.mdb`, regenerated by `umalator-global/build.mjs`). Inside a hinted family only
the hinted tier's own rarity is certain, so the ids of its other tiers come through as
`softOffered` and the Optimizer lists them switched off. Either way the pane notes what it could
not read.

Ignored on purpose: `acquiredSkills.items` (the writer's walk of that runtime class yields empty
objects, and `IsGet=1` rows are the real list), `raceEvaluations` (per-NPC bond entries whose
`ObscuredBool` fields serialize as `"<obscured …>"`), `skillMasterNames` (only filled by a
different capture door), `scenarioId`/`routeId`/`entryProgramId` (career context with no
verified mapping onto an app course), and in a snapshot the race history, the support-card and
fan-club state, the training levels and `live_data_set`.

### URL State Features (V2)

**Hash-based State Serialization:**
- Copy Link button generates shareable URLs
- Serializes: course, conditions, samples, uma1, uma2 configurations
- Compressed using LZ-string for shorter URLs
- Example: `https://john-unowen.github.io/Yet-Another-Umalator-Fork/#H4sIAAAA...`

**Preset Parameter:**
- `?preset=X` parameter for quick race loading
- Example: `https://john-unowen.github.io/Yet-Another-Umalator-Fork/?preset=8`
- Loads Champions Meeting/LoH event settings
- Takes priority over hash-based state

### `CC_GLOBAL` (Global-only app)

The JP simulator variant was removed. Every simulator build defines `CC_GLOBAL: 'true'`
(`umalator-global/build.mjs` for esbuild, `umalator-global/v2/vite.config.ts` for Vite) and
reads the Global/English data files in `umalator-global/`.

The flag is still read by shared code, so components keep compiling both ways: skill level
labels in `components/SkillList.tsx`, regional default stats in `components/HorseDefTypes.ts`,
the language storage key in `components/Language.tsx`. The JP skill visualizer
(`skill-visualizer-jp/build.mjs`) is the one remaining build with `CC_GLOBAL: 'false'`.

**See [.claude/UMALATOR-GLOBAL-MAPPING.md](.claude/UMALATOR-GLOBAL-MAPPING.md)** (historical
reference): it describes the retired `umalator/` (JP) build layout that the old Global v1 build
aliased into itself.

### Data Files

**Game Data:**
- `docs/master.mdb`: Global master.mdb, the source of truth for what's in-game on Global (pulled from MEGA)
- `uma-skill-tools/data/skill_data.json`: JP game skill definitions
- `uma-skill-tools/data/skillnames.json`: JP skill name translations
- `uma-skill-tools/data/course_data.json`: JP race course definitions
- `umalator-global/skill_data.json`: Global/English skill definitions
- `umalator-global/skillnames.json`: Global/English skill names
- `umalator-global/course_data.json`: Global/English course data
- `umalator-global/not-in-game.json`: Auto-generated list of fast-forwarded skills/outfits (built from master.mdb diff)
- `umalator-global/career-unbuyable.json`: Auto-generated list of skills the skill screen never sells (`skill_data.grade_value < 0` in master.mdb), kept out of a career snapshot's skill pool

**Metadata:**
- `skill_meta.json`: Metadata about skills (root directory)
- `umas.json`: Uma character data (root directory)
- `icons.json`: Icon mappings (root directory)

**Uma Presets:**
- `uma-skill-tools/tools/nige.json`, `senkou.json`, `sasi.json`, `oikomi.json`: Default horse parameters for different racing strategies

### Data Generation Scripts

**JP Version (Perl scripts):**
- `make_skill_data.pl`: Generates skill_data.json from master.mdb
- `make_skillnames.pl`: Generates skillnames.json
- `make_course_data.pl`: Generates course_data.json
- Root directory: `make_skill_meta.pl`, `make_uma_info.pl`, `extract_resource.pl`

**Global Version:**
```bash
cd umalator-global

# Windows
update.bat [path-to-master.mdb]

# Linux/Mac
perl make_global_skillnames.pl /path/to/master.mdb > skillnames.json
perl make_global_course_data.pl /path/to/master.mdb courseeventparams > course_data.json
```

Requires Perl with `DBI` and `DBD::SQLite` modules.

**There is no `make_global_skill_data.pl`**: it does not exist in this repo or upstream.
The JP `uma-skill-tools/tools/make_skill_data.pl` does run against the Global mdb, but it
predates the current schema: it emits only `modifier`/`target`/`type` per effect, so its
output **drops `scaling`** (which `RaceSolverBuilder.ts` reads), plus `wisdomCheck` and
`tags`. Don't regenerate `skill_data.json` with it. See "Keeping skill_data.json in sync"
below.

### Keeping skill_data.json in sync

`umalator-global/skill_data.json` is a **JP superset** (~1530 entries): ~680 skills live on
Global, plus ~850 fast-forwarded from JP. Two rules follow from that:

1. **Never *replace* it wholesale from the Global mdb**: that wipes the fast-forwarded JP
   entries, which are the point of the superset.
2. **But it does need periodic *merging*.** For skills already live on Global, `master.mdb`
   is authoritative, and Cygames rebalances them. `tools/fast-forward-global.ts` only ever
   ADDS entries (see its `existingIds` guard), so it can never refresh a skill it already
   imported. Left alone, live-skill definitions freeze at whatever they were on first import.

   This is not hypothetical: by 2026-07-30, **79 Global-live skills** had conditions that
   disagreed with `master.mdb`. For example `100051` Lights of Vaudeville still carried the JP
   definition (`is_finalcorner==1&corner==0&order_rate<=30&behind_near_lane_time_set1>=1`)
   where Global is simply `remain_distance<=300`.

**The correct operation is a merge:** take the current definition for every skill live in
`docs/master.mdb` and leave every JP-only entry untouched. Two things to preserve when doing it:

- `make_skill_data.pl`'s `patch_modifier()` deliberately multiplies ~23 scenario-skill IDs
  (`210011` to `210291`) by **1.2**. Re-apply it, or those magnitudes silently drop ~17%.
- Match the file's existing format (tab indent, original top-level key order) or the diff
  becomes unreviewable whitespace churn.

`tools/skill-drift.ts` **detects and reports this drift**: `npm run check:skill-drift`
compares every skill present in `docs/master.mdb` (precondition, condition, duration and
effects, with the 1.2 patch applied) and prints
`⚠️ [STALE DATA] N Global-live skill(s) no longer match master.mdb` plus each id and field.
JP-only entries are never compared. `fast-forward-global.ts` prints the same report on every
run. Neither rewrites `skill_data.json`: the warning is your cue to re-run the merge. Both
read the mdb with Node's built-in `node:sqlite`, so the `sqlite3` CLI is not needed
(`build.mjs` still shells out to it and falls back to the git remote without it).
`npm run test:skill-drift` checks that planted drift is caught.

### Updating Global master.mdb

The Global `master.mdb` (SQLite database extracted from the game client) is the source of truth for what skills, characters, and courses are currently in the Global version. It is stored at `docs/master.mdb` and automatically synced to MEGA (`/uma/master.mdb`) from another machine.

**Pull the latest DB:**
```bash
./tools/pull-master-mdb.sh          # Download latest from MEGA → docs/master.mdb
./tools/pull-master-mdb.sh --check  # Check if a newer version is available
```

**Prerequisites:**
- `brew install megatools`
- `~/.megarc` with MEGA credentials:
  ```
  [Login]
  Username = your@email.com
  Password = yourpassword
  ```

After pulling a new DB, rebuild to update the not-in-game filter:
```bash
cd umalator-global && node build.mjs
```

### Not-In-Game Filter

The build generates `umalator-global/not-in-game.json` listing skills and outfits that exist in our data files but aren't in the Global game yet (fast-forwarded from JP). The UI uses this to show a "Not in game" badge and allow filtering.

**How it works** (in `generateNotInGame()` in `umalator-global/build.mjs`):
1. **Primary**: Diffs `skill_data.json` and `umas.json` against `docs/master.mdb` via `sqlite3` CLI
2. **Fallback**: If `master.mdb` is unavailable (e.g. a CI run without the DB), diffs against the `kachi-dev/master` git remote

**UI usage**: Skills filter in `v2/skills.tsx`, uma panel in `v2/uma-panel.tsx`, skill charts in `v2/skill-chart-pane.tsx`

### Fast-Forwarding Characters from JP

To add a character/outfit that exists in JP but not yet on Global:

1. **Find the JP master.mdb**, typically at `docs/master(1).mdb`

2. **Extract outfit data** from the JP DB:
   ```sql
   -- Aptitudes (short,mile,mid,long,nige,senkou,sashi,oikomi,turf,dirt)
   SELECT proper_distance_short, proper_distance_mile, proper_distance_middle,
          proper_distance_long, proper_running_style_nige, proper_running_style_senkou,
          proper_running_style_sasi, proper_running_style_oikomi,
          proper_ground_turf, proper_ground_dirt
   FROM card_rarity_data WHERE card_id = <outfit_id> AND rarity = 5;

   -- Growth rates
   SELECT default_rarity FROM card_data WHERE id = <outfit_id>;

   -- Awakenings (skill IDs unlocked at each rank)
   SELECT skill_id FROM available_skill_set
   WHERE card_id = <outfit_id> ORDER BY need_rank, id;
   ```

3. **Add to `umalator-global/umas.json`**:
   ```json
   "<chara_id>": {
     "outfits": {
       "<outfit_id>": {
         "aptitudes": [short,mile,mid,long,nige,senkou,sashi,oikomi,turf,dirt],
         "awakenings": ["skill1", "skill2", ...],
         "epithet": "[Epithet Name]",
         "rarity": 3,
         "strategy": 1
       }
     }
   }
   ```
   - **Aptitude values**: 1=G, 2=F, 3=E, 4=D, 5=C, 6=B, 7=A, 8=S
   - **Strategy**: 1=Nige, 2=Senkou, 3=Sashi, 4=Oikomi (based on highest aptitude)
   - Keep keys sorted numerically

4. **Add skills to `umalator-global/skill_data.json`**: extract them from the JP `skill_data` table

5. **Add skill names to `umalator-global/skillnames.json`**:
   ```json
   "<skill_id>": ["English Skill Name"]
   ```
   **Important**: Values must be arrays, not strings. The code does `names?.[0]`, so a bare string would return just the first character.

6. **Add character icon** to `icons/chara/trained_chr_icon_<uid>_<outfitId>_02.png`

7. **Rebuild**: `cd umalator-global && node build.mjs`. The new skills/outfits then automatically appear in `not-in-game.json`

## Adding Race Event Presets

Race presets (Champions Meeting, League of Heroes) live in `umalator-global/v2/presets.ts`.

### Finding Course IDs

```bash
# Find course ID by track and distance
jq 'to_entries | .[] | select(.value.raceTrackId == 10008 and .value.distance == 3000) | .key' umalator-global/course_data.json
# Returns: "10810" (Kyoto 3000m)
```

Track IDs (in `umalator-global/tracknames.json`): Tokyo=10006, Kyoto=10008, Nakayama=10005, Hanshin=10009

### Adding a Preset

The CM list is generated, not hand-edited: `generateCMPresets()` in `build.mjs` writes
`v2/cm-presets.generated.json`, which `presets.ts` reads. Race conditions come from the JP DB
(`docs/master(1).mdb`), run dates from the Global `docs/master.mdb`, falling back to the
hand-maintained `v2/cm-dates.json` for CMs the Global client does not know yet (a CM with no
resolvable date is skipped). Entries look like this:

```typescript
// Example: CM 8 - Sagittarius Cup (added January 2026)
{
  id: 8,
  type: EventType.CM,
  name: 'Sagittarius Cup',
  date: '2026-01-22',
  courseId: 10506,
  season: Season.Winter,
  ground: GroundCondition.Good,
  weather: Weather.Sunny,
  time: Time.Midday
}
```

So adding a future CM normally means adding its `"id": "YYYY-MM-DD"` entry to
`v2/cm-dates.json` and rebuilding.

**Parameters:**
- **id**: CM number (unique, this is the key into the JP and Global schedules)
- **type**: `EventType.CM` or `EventType.LOH`
- **name**: Display name. The generator derives it from the CM number (CM 1 = Taurus)
- **date**: `'YYYY-MM-DD'`
- **courseId**: From `course_data.json` (e.g., 10506 = Nakayama 2500m inner)
- **season**: `Season.Spring|Summer|Autumn|Winter`
- **ground**: `GroundCondition.Good` (=Firm), `Yielding` (=Good), `Soft`, `Heavy`
- **weather**: `Weather.Sunny|Cloudy|Rainy|Snowy`
- **time**: `Time.Morning|Midday|Evening|Night`
- **confirmed**: `true` when the date came from the shipped Global schedule, `false` for a `cm-dates.json` prediction

**Note**: LOH events ignore ground/weather (always Firm/Sunny). Presets auto-sort by date.

## Security and Environment Variables

Feedback is off on this fork, so nothing below is configured on Pages. The sections are kept
as the reference for running the feedback + OCR stack somewhere. The drawer needs both
`VITE_DISCORD_WEBHOOK` (non-empty) and `VITE_ENABLE_FEEDBACK` not set to `'false'`. The committed
`umalator-global/v2/.env` pins `VITE_ENABLE_FEEDBACK=false`, so it stays hidden even with a
webhook set, until an override flips the flag.

### Environment Variables

**V2 uses environment variables for sensitive data:**

```bash
# .env.local (gitignored)
VITE_DISCORD_WEBHOOK=https://uma-tools-webhook-proxy.YOUR-SUBDOMAIN.workers.dev
```

**Setup:**
1. Copy `umalator-global/v2/.env.example` to `.env.local`
2. Fill in actual values
3. Never commit `.env.local` (already in `.gitignore`)

### Discord Webhook Proxy

**Architecture:**
- The client calls the Cloudflare Worker, which forwards to the Discord webhook
- Real Discord URL hidden from client-side code
- Worker adds metadata (IP, location, browser) to feedback

**Files:**
```
uma-tools-worker/
├── webhook-proxy.js    # Worker script
├── wrangler.toml       # Cloudflare config
├── .gitignore          # Ignore secrets
└── README.md           # Deployment instructions
```

**Deployment:**
```bash
cd uma-tools-worker
npx wrangler login
npx wrangler deploy
npx wrangler secret put DISCORD_WEBHOOK  # Set real webhook URL
```

**Security Best Practices:**
- ✅ Real Discord webhook URL never exposed to clients
- ✅ CORS restricted (can be tightened to specific domains)
- ✅ Only POST requests allowed
- ✅ Payload validation prevents malformed requests
- ✅ Encrypted secrets via Cloudflare

## Modern Features

### Mobile Navigation

**Component:** `v2/mobile-nav.tsx`

**Features:**
- Bottom navigation bar on mobile (<768px)
- Tabs: Track, Uma, Skills, Results
- Smooth tab switching
- Persistent across page reloads

### Velocity/HP Overlay

**Component:** `v2/velocity-overlay.tsx`

**Features:**
- Independent velocity/HP line toggles
- Pacer gap visualization (dashed lines)
- D3.js-based rendering inside RaceTrack SVG
- Responsive to simulation data updates

**Props:**
```tsx
interface VelocityOverlayProps {
  data: RaceSnapshot | null;
  courseDistance: number;
  width: number;
  height: number;
  xOffset: number;
  showVelocity?: boolean;  // Toggle velocity lines
  showHp?: boolean;        // Toggle HP lines
  showPacerGap?: boolean;  // Toggle pacer gap lines
}
```

### Easter Eggs

**Still In Love:**
- Type "STILL" anywhere (not in an input field) to trigger yandere mode
- Theme becomes bright red with subtle pulsing border effect
- Type "STILL" again to toggle off
- Reference to the "Still In Love" skill
- Files: `v2/app-v2.tsx` (keyboard listener), `v2/v2.css` (yandere theme)
- Gated by `CC_DEV`, so it is dead in the deployed build: the define is true only when
  `CF_PAGES_BRANCH=dev`, `CC_DEV=true`, or a dev server is running

## Simulation Limitations

The app runs a **full field**: the tested uma plus eight mobs drawn from `umalator-global/v2/engines/globalsim/mob-presets.json`, so position, speed and HP traces and the finish margin come from a real race, not a solo run. Compare is paired-seed (both builds over the same seeds), the skill chart measures each skill against the baseline build, and ties count against in `vs Base`.

The caveats below are inherited from the removed single-uma solver. They have **not** been re-validated against GlobalSim, so treat them as open questions rather than current facts:

- **Position keep**: not fully modeled in the classic solver (pace-down for non-runners only)
- **Order conditions**: assumed always fulfilled in the classic solver
- **Lane differences**: inner/outer lane distance differences not modeled by the classic solver
- **Skills with `accumulatetime` + probability distributions**: may activate earlier than expected

## Important Notes

- Course IDs: `uma-skill-tools/data/course_data.json` (JP) or `umalator-global/course_data.json` (Global)
- Skill IDs can be found using `skillgrep.ts -d` or from GameTora (with "Show skill IDs" enabled)
- The project uses "バ身" (bashin/horse lengths, 1 = 2.5m) as the unit for measuring distance gain
- Frontend apps use `CC_GLOBAL` flag (esbuild define) to toggle JP/Global variants
- Shared assets (`icons/`, `fonts/`) sit at the project root and are published alongside the app. The app builds their URLs with `resolveBase()` in `components/base-path.ts`, from `CC_BASE_PATH` (the Pages workflow sets it from the repo name, local builds default to `/uma-tools`)

## Japanese-to-English Terminology

**See [.claude/HORSE-DEFINITION-FLOW.md](.claude/HORSE-DEFINITION-FLOW.md)** for horse data flow documentation: how `HorseState` (UI) converts to `HorseParameters` (simulation), default stats by region, and character data structure.

**See [docs/JP-GLOBAL-TERMINOLOGY.md](docs/JP-GLOBAL-TERMINOLOGY.md)** for the mappings between Japanese and Global English terminology: running styles, stats, mood, ground conditions, weather, seasons, the code enum values and their locations, naming traps (for example `GroundCondition.Good` = 良/Firm, not "Good") and the Global vs JP file split.

## Deployment

### Production Build

```bash
npm run build:all                   # = build:global (the v2 app)
node umalator-global/build.mjs      # esbuild bundles + regenerates the app's data files
npm run build:v2                    # Vite production build → umalator-global/v2/dist (what Pages deploys)
```

### Cache Busting

The app is the v2 Vite build, and Vite cache-busts it automatically: `vite build` emits
content-hashed filenames (`assets/index-<hash>.js`, `assets/index-<hash>.css`) and the generated
`index.html` references them. Nothing to bump by hand.

The one fixed-name output is the engine worker: `worker.rollupOptions` in `v2/vite.config.ts`
sets `entryFileNames: '[name].js'`, so `globalsim.worker.js` lands at the root of `dist/` and
reaches `_site` with the rest of the dist (the main bundle resolves it as `../globalsim.worker.js`).

The old v1 scheme (hand-edited `?v=YYYYMMDD[x]` version queries on `bundle.js`,
`bundle.css` and `simulator.worker.js`) is gone along with the classic app.

### GitHub Pages

**Workflow**: `.github/workflows/pages.yml`, on push to `master` or manual dispatch.

- Builds the wasm (`wasm-pack 0.15.1`, `--target web`), the Vite app, and the
  runtime assets, then assembles `_site` = `umalator-global/v2/dist/.` + `icons/` + `fonts/` +
  `globalsim/` + `og-image-v2.png` + `.nojekyll`.
- `CC_BASE_PATH=/${{ github.event.repository.name }}` sets the asset prefix from the repo name,
  so a rename or a root-domain deploy needs no code change (`CC_BASE_PATH=''` = site root).
- Cloudflare-only features build inert: `OCR_PROXY_URL` and `TURNSTILE_SITEKEY` are unset.
- No Pages env vars are configured. `VITE_DISCORD_WEBHOOK` stays empty, so the feedback drawer
  is hidden.

`ci.yml` runs on push and pull request: the engine's own `cargo test`, the wasm-vs-native byte
parity check, the GlobalSim suites (compact-record parity and the full-spurt judge included),
`test:optimizer`, and the career import, skill hints, skill drift, mechanics and base-path suites.
It does not run `test:optimizer:slow`, `test:roster` or `uma-skill-tools`' own `npm test`.
`sync-upstream-data.yml` runs daily, pulls the upstream
game data, and opens a PR against `master`. Merging is what deploys it.

`build-all.sh`, `_redirects` and `functions/` are upstream Cloudflare Pages machinery. GitHub
Pages ignores all three, and the Pages workflow never calls `build-all.sh`.

### Branch Deployment

- **master**: deploys to GitHub Pages (the URL above)
- **dev**: no deployment on this fork. Upstream's `dev.umalator.app` preview is upstream's

### Canva guides (`canva.umalator.app`)

> Upstream-only. This fork does not host that subdomain, and `pages.yml` copies no `canva/`
> directory into `_site`, so none of these paths exist on the Pages URL. The registry and the
> generator are kept for `functions/[[catchall]].ts`, which reads the same `canva-embeds.json`.

Community guides are Canva embeds addressed by a numbered slug, reachable at both
`canva.umalator.app/<slug>` and `umalator.app/canva/<slug>`:

- `/14-yasuda`, `/15-takarazuka`, … (`<number>-<name>`)
- The bare root (`canva.umalator.app/` or `umalator.app/canva/`) sends a 302 to the
  highest-numbered (newest) guide
- A number-only path (`/14`) sends a 302 to the full slug

**Registry lives in `canva-embeds.json`** (single source of truth, repo root).

**`umalator.app/canva/<slug>` is served by STATIC pages**, not the Function. Cloudflare
Pages Functions are not currently executing on the production project (the
`functions/[[catchall]].ts` canva routing, the events OG function, and the
`www` to apex redirect never run in prod, everything falls through to static). So
`tools/gen-canva-static.mjs` reads `canva-embeds.json` and writes static
`canva/<slug>/index.html` wrapper pages (+ `canva/index.html` = newest) on every build
(wired into `build-all.sh`). These are plain static assets and always serve. The
`functions/[[catchall]].ts` still reads the same `canva-embeds.json` and would serve the
`canva.umalator.app` subdomain (and number-only slugs) **if/when Functions are revived**.
That requires a Cloudflare dashboard fix (Functions enablement / compatibility date),
not a repo change. The subdomain and number-slug redirects (for example `/14` to
`/14-yasuda`) are currently inactive in prod as a result.

**To add a guide:** add one entry to `canva-embeds.json`:

```json
{ "slug": "16-sprinters", "title": "CM 16 Guide — Sprinters",
  "canvaId": "XXXX", "viewToken": "YYYY" }
```

Get `canvaId` + `viewToken` from Canva › Share › More › Embed. The embed URL is
`https://www.canva.com/design/<canvaId>/<viewToken>/view?embed`. The highest-numbered
entry automatically becomes `canva/index.html` (the bare-`/canva` target). Changes ship
with `master`: merge `dev` into master to publish.

## Credits

Built on the work of:
- **alpha123/umalator** - Original Global simulator by alpha123 & pecan
- **kachi-dev/umalator (VFalator)** - VFcord version by kachi & Jecht
- **Skill Data** - [GameTora](https://gametora.com/umamusume)
- **Game** - Uma Musume: Pretty Derby © Cygames
- **Community** - [Moomoo Discord](https://discord.gg/moomoocows)

## License

GPL-3.0-or-later - See [LICENSE](uma-skill-tools/LICENSE)
