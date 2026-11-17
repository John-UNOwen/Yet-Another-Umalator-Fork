# Uma Musume Simulator Documentation

Player guides, engine and data references, and the translated JP articles this project keeps.

## Player guides

- [Stats Guide](stats-guide.md): what each stat does and how to build for a race type.
- [Stamina & Survival](stamina-and-survival.md): what drains HP and what keeps a spurt alive.
- [Terminology](terminology.md): glossary of game and app terms, with the enum values behind them.
- [Welfare SSR Team \<Sirius\> Usage Guide](team-sirius-guide-en.md): translated JP guide for the welfare group support card.
- [SSR The Throne's Assemblage](throne-guide.md) and [its usage guide](throne-usage-guide.md): translated JP reviews of that card.

## Engine and data references

The app simulates with GlobalSim. The four entries marked *classic solver* describe the
TypeScript engine in `uma-skill-tools/`, which is still used for skill costs and data but no
longer runs the race.

- [Race Mechanics Research](RACE-MECHANICS-RESEARCH.md) *classic solver*: stat thresholds, aptitudes and positioning.
- [Spurt Survival Rate](SPURT-SURVIVAL-RATE.md) *classic solver*: how that rate was computed, and why the app's HP Survival cells show `—`.
- [Ability Value Scaling](ability-value-scaling.md) *classic solver*: the `ability_value_usage` column and which usages the solver implements.
- [Duration Scaling](ability-time-scaling.md) *classic solver*: the `ability_time_usage` column.
- [Downhill Mode Analysis](downhill-mode-analysis.md): activation odds, measured HP savings, and why the min-stamina recommendation ignores downhill.
- [Uma Musume Race Mechanics](<Uma Musume Race Mechanics.md>): a community mechanics write-up, kept as a mirror.
- [GlobalSim upgrade runbook](globalsim-upgrade.md): how to move the engine submodule pin and what to re-verify.

## Terminology mapping

- [JP ↔ Global Terminology](JP-GLOBAL-TERMINOLOGY.md): JP terms mapped to the shipped English labels, with the code enums and where they live.

## Quick tips

1. Speed is king, but only with enough stamina to reach the line.
2. Match aptitudes. An S or A grade makes a big difference.
3. Watch the **HP empty** share in the results. If the uma runs dry before the line, add stamina or recovery skills.
4. Running style matters. Late Surgers are the most stamina-efficient.
5. Mood matters. **Great** mood (+2) gives +4% to all stats.

## Using the Simulator

1. Pick the course and the race conditions.
2. Set up the uma. Compare mode takes two.
3. Press **RUN**.
4. Read the mean finish margin with its 95% CI, the HP empty and rushing shares, and the velocity and HP curves.

The tabs switch between Compare, Skill and Optimizer.
