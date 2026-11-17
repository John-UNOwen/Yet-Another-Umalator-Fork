# Uma Musume JP ↔ Global Terminology Reference

Maps Japanese game terms to the English the Global release uses, with the code enum behind each
one. Take the on-screen labels from the files named below rather than typing them out: this table
went stale once when the strings were copied by hand.

## Core stats

| Japanese | Romaji | English (Global) | Code constant |
|----------|--------|------------------|---------------|
| スピード | supiido | Speed | `speed` |
| スタミナ | sutamina | Stamina | `stamina` |
| パワー | pawaa | Power | `power` |
| 根性 | konjou | Guts | `guts` |
| 賢さ | kashikosa | Wit/Wisdom | `wisdom` |

## Running styles (strategy)

| Japanese | Romaji | English (Global) | Short | Code enum | Enum value |
|----------|--------|------------------|-------|-----------|------------|
| 逃げ | nige | **Front Runner** | Front | `Strategy.Nige` | 1 |
| 先行 | senkou | **Pace Chaser** | Pace | `Strategy.Senkou` | 2 |
| 差し | sasi | **Late Surger** | Late | `Strategy.Sasi` | 3 |
| 追込 | oikomi | **End Closer** | End | `Strategy.Oikomi` | 4 |
| 大逃げ | oonige | **Runaway** | (none) | `Strategy.Oonige` | 5 |

The enum is at [`uma-skill-tools/HorseTypes.ts:3`](../uma-skill-tools/HorseTypes.ts#L3). The
labels come from `STRATEGIES` ([`umalator-global/v2/uma-panel.tsx:464`](../umalator-global/v2/uma-panel.tsx#L464))
and are re-exported as `STRATEGY_LABELS`
([`uma-panel.tsx:473`](../umalator-global/v2/uma-panel.tsx#L473)).

Notes:

- Use the full label ("Pace Chaser") in prose and controls. The **Short** column is for compact
  UI only, such as an aptitude grid column header. Those short labels come from
  [`umalator-global/v2/roster/roster-filter-panel.tsx:17`](../umalator-global/v2/roster/roster-filter-panel.tsx#L17),
  which has no entry for Oonige.
- Never show the romaji or the JP value (`Senkou`) in the Global UI.
- `Oonige` is treated as equivalent to `Nige` in strategy matching logic.
- Community translations and older copies of this table give "Front/Leader", "Stalker/Presser",
  "Late/Closer" and "End/Chaser". None of those match the app or the Global release. Corrected
  against the shipped UI on 2026-07-15.
- `components/SkillList.tsx` carries a third vocabulary (Runner / Leader / Betweener / Chaser) in
  its filter labels. Nothing in the v2 app reaches it: only `build-planner/`,
  `skill-visualizer-global/` and `skill-visualizer-jp/` import `SkillList`. Do not copy those
  strings into v2.

## Aptitude grades

| Grade | Code enum | Performance impact |
|-------|-----------|--------------------|
| S | `Aptitude.S` (0) | +5% Distance/Track, +10% Style |
| A | `Aptitude.A` (1) | Baseline (no modifier) |
| B | `Aptitude.B` (2) | -10% Distance/Track, -15% Style |
| C | `Aptitude.C` (3) | ~-20% |
| D | `Aptitude.D` (4) | ~-40% |
| E | `Aptitude.E` (5) | ~-60% |
| F | `Aptitude.F` (6) | ~-75% |
| G | `Aptitude.G` (7) | ~-90% |

The enum is at [`uma-skill-tools/HorseTypes.ts:4`](../uma-skill-tools/HorseTypes.ts#L4). S-rank
aptitude is worth roughly 100 to 200 extra effective stat points, depending on base stats.

## Mood conditions

| Japanese | Romaji | English (Global) | Code value |
|----------|--------|------------------|------------|
| 絶好調 | zekkocho | **Great** | `2` |
| 好調 | kocho | **Good** | `1` |
| 普通 | futsuu | **Normal** | `0` |
| 不調 | fuchou | **Bad** | `-1` |
| 絶不調 | zekkufuchou | **Awful** | `-2` |

The type is `Mood = -2 | -1 | 0 | 1 | 2`
([`uma-skill-tools/RaceParameters.ts:1`](../uma-skill-tools/RaceParameters.ts#L1)). The labels
come from `MOOD_OPTIONS` ([`umalator-global/v2/uma-panel.tsx:431`](../umalator-global/v2/uma-panel.tsx#L431)).
Older copies listed "Great/Perfect" and "Terrible/Awful". The shipped labels are **Great** and
**Awful**. Corrected 2026-07-15.

## Ground conditions

| Japanese | Romaji | English (Global) | Code enum | Enum value |
|----------|--------|------------------|-----------|------------|
| 良 | ryou | Firm\* | `GroundCondition.Good` | 1 |
| 稍重 | yaya-omo | Good\* | `GroundCondition.Yielding` | 2 |
| 重 | omo | Soft | `GroundCondition.Soft` | 3 |
| 不良 | furyou | Heavy | `GroundCondition.Heavy` | 4 |

The enum is at [`uma-skill-tools/RaceParameters.ts:2`](../uma-skill-tools/RaceParameters.ts#L2).

The naming trips people up: the code calls 良 `GroundCondition.Good`, while the Global UI calls it
"Firm" and calls 稍重 "Good". A JP document that says 良 means `GroundCondition.Good`. The enum
name is legacy and does not match the Global UI.

## Weather conditions

| Japanese | Romaji | English (Global) | Code enum | Enum value |
|----------|--------|------------------|-----------|------------|
| 晴れ | hare | Sunny | `Weather.Sunny` | 1 |
| 曇り | kumori | Cloudy | `Weather.Cloudy` | 2 |
| 雨 | ame | Rainy | `Weather.Rainy` | 3 |
| 雪 | yuki | Snowy | `Weather.Snowy` | 4 |

The enum is at [`uma-skill-tools/RaceParameters.ts:3`](../uma-skill-tools/RaceParameters.ts#L3).

## Seasons

| Japanese | Romaji | English | Code enum | Enum value | Region |
|----------|--------|---------|-----------|------------|--------|
| 春 | haru | Spring | `Season.Spring` | 1 | Both |
| 夏 | natsu | Summer | `Season.Summer` | 2 | Both |
| 秋 | aki | Autumn | `Season.Autumn` | 3 | Both |
| 冬 | fuyu | Winter | `Season.Winter` | 4 | Both |
| 桜花賞 | oukashow | Sakura (special) | `Season.Sakura` | 5 | **JP only** |

The enum is at [`uma-skill-tools/RaceParameters.ts:4`](../uma-skill-tools/RaceParameters.ts#L4).
`Season.Sakura` exists in the enum but Global does not use it, so the app's picker offers the four
seasons (`SEASON_LABELS` in
[`umalator-global/v2/conditions.tsx:24`](../umalator-global/v2/conditions.tsx#L24)). Keep the row:
this table documents the enum, not only the Global UI.

## Time of day

| Japanese | Romaji | English | Code enum | Enum value | Region |
|----------|--------|---------|-----------|------------|--------|
| (なし) | - | No Time | `Time.NoTime` | 0 | **JP only** |
| 朝 | asa | Morning | `Time.Morning` | 1 | **JP only** |
| 昼 | hiru | Midday | `Time.Midday` | 2 | Both |
| 夕 | yuu | Evening | `Time.Evening` | 3 | Both |
| 夜 | yoru | Night | `Time.Night` | 4 | Both |

The enum is at [`uma-skill-tools/RaceParameters.ts:5`](../uma-skill-tools/RaceParameters.ts#L5).
`NoTime` and `Morning` exist in the enum but Global does not use them, so the picker offers
Midday, Evening and Night. `TIME_LABELS`
([`conditions.tsx:25`](../umalator-global/v2/conditions.tsx#L25)) is indexed `t - 2`. Keep the
rows: this table documents the enum, not only the Global UI.

## Race grades

| Japanese | English | Code enum | Enum value |
|----------|---------|-----------|------------|
| G1 | G1 | `Grade.G1` | 100 |
| G2 | G2 | `Grade.G2` | 200 |
| G3 | G3 | `Grade.G3` | 300 |
| オープン | Open | `Grade.OP` | 400 |
| Pre-Open | Pre-Open | `Grade.PreOP` | 700 |
| 未勝利 | Maiden | `Grade.Maiden` | 800 |
| 新馬 | Debut | `Grade.Debut` | 900 |
| デイリー | Daily | `Grade.Daily` | 999 |

The enum is at [`uma-skill-tools/RaceParameters.ts:6`](../uma-skill-tools/RaceParameters.ts#L6).

## Distance measurement

| Japanese | Romaji | English (Global) | Conversion |
|----------|--------|------------------|------------|
| バ身 | bashin | Horse Length(s) | 1 bashin = 2.5 meters |

Distance and position inside the simulation use this unit. Real horse racing typically uses 2.4 m
per horse length. Uma Musume uses 2.5 m, explained in the lore as the arm span of three horsegirl
goddesses.

## Phase system

`Phase = 0 | 1 | 2 | 3`
([`uma-skill-tools/CourseData.ts:3`](../uma-skill-tools/CourseData.ts#L3)). The solver switches
phase by the fraction of the course run, and the velocity overlay labels the four phases Opening,
Mid 1, Mid 2 and Final.

| Phase | Overlay label | When | What happens |
|-------|---------------|------|--------------|
| 0 | Opening | first 1/6 | Initial acceleration |
| 1 | Mid 1 | 1/6 to 2/3 | Position establishing, most of the race |
| 2 | Mid 2 | 2/3 to 5/6 | Holding position, tactics |
| 3 | Final | last 1/6 | Last spurt (ラストスパート) |

## Skill condition vocabulary

Terms that appear in skill activation conditions:

| Term | Meaning |
|------|---------|
| `phase` | Race phase (0 start, 1 early, 2 middle, 3 final) |
| `running_style` | Strategy/running style |
| `is_lastspurt` | In the final sprint phase |
| `corner` | Corner/turn section |
| `straight` | Straight section |
| `slope` | Hill/slope section |
| `random` | Random activation type |
| `accumulatetime` | Time elapsed condition |
| `order` | Position in race order |
| `order_rate` | Percentile position |

## Global and JP file organization

### `umalator-global/`

Global version build with English data. Key files: `skill_data.json` (English skill names and
conditions), `skillnames.json` (English skill translations), `course_data.json` (course
definitions), `umas.json` (character data with English names), `tracknames.json` (race track
English names). `build.mjs` bundles it. The `make_global_*.pl` scripts generate the English data
from `master.mdb`.

### `uma-skill-tools/`

The shared library (enums, course data, skill parsing, costs). Its own data lives in
`uma-skill-tools/data/` and is JP data. The CLI tools run under `ts-node`.

### The `CC_GLOBAL` define

Every build in this repo defines `CC_GLOBAL: 'true'`: `umalator-global/build.mjs:520`,
`umalator-global/v2/vite.config.ts:155`, `umalator-global/skill-visualizer/build.mjs`,
`umalator-global/mechanics-explorer/build.mjs` and `skill-visualizer-global/build.mjs`.
`skill-visualizer-jp/build.mjs:31` defines `'false'`, the only build that does. Shared code reads
the flag for translation strings, skill level labels, regional default stats and the language
storage key.

## Common development commands

Find a course ID:

```bash
grep -i "tokyo" uma-skill-tools/data/course_data.json   # JP data
grep -i "tokyo" umalator-global/course_data.json        # Global data
```

Find a skill ID (`-d` prints IDs):

```bash
cd uma-skill-tools
npx ts-node --transpile-only tools/skillgrep.ts -d "skill name"
```

Measure a skill's バ身 gain over 500 samples:

```bash
cd uma-skill-tools
npx ts-node --transpile-only tools/gain.ts -c 10006 -m 2 -g good -s 200041 --nsamples 500
```

`-c` course ID, `-m` mood (`2` = 絶好調/Great), `-g` ground (`good` = 良/Firm), `-s` skill ID,
`--nsamples` number of simulations.

## References

- [GameTora Race Mechanics Handbook](https://gametora.com/umamusume/race-mechanics)
- [GameTora Skill List](https://gametora.com/umamusume/skills)
- [Game8 Aptitude Guide](https://game8.co/games/Umamusume-Pretty-Derby/archives/537119)
- [UmaTL English Translation Repository](https://github.com/UmaTL/hachimi-tl-en)
- [Steam Community Discussions](https://steamcommunity.com/app/3224770/discussions/)
- [DTG Umamusume Global vs Japan Differences Guide](https://www.dtgre.com/2025/07/umamusume-global-vs-japan-differences-guide.html)
