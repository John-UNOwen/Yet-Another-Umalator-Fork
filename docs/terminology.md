# Uma Musume Terminology Guide

A glossary of terms used in Uma Musume and this simulator.

## Running Styles

| Style | Japanese | Description |
|-------|----------|-------------|
| **Front Runner** | Nige (逃げ) | Leads from the start, tries to stay ahead |
| **Pace Chaser** | Senkou (先行) | Stays near the front, pushes in final stretch |
| **Late Surger** | Sasi (差し) | Runs in the middle, makes late moves |
| **End Closer** | Oikomi (追込) | Starts at back, relies on final sprint |
| **Runaway** | Oonige (大逃げ) | Extreme front-running, high risk/reward |

---

## Race Conditions

### Ground Conditions

| English | Japanese | Effect |
|---------|----------|--------|
| **Firm** | Ryou (良) | Best conditions, no penalties |
| **Good** | Yaya-omo (稍重) | Slightly soft, minor impact |
| **Soft** | Omo (重) | Soft ground, +1-2% stamina drain |
| **Heavy** | Furyou (不良) | Very soft, +2% stamina drain |

### Weather

| Condition | Effect |
|-----------|--------|
| **Sunny** | No special effects |
| **Cloudy** | No special effects |
| **Rainy** | Usually causes softer ground |
| **Snowy** | Winter races only |

### Seasons

Spring, Summer, Autumn, Winter - affects some skill activations.

---

## Race Phases

| Phase | When | What Happens |
|-------|------|--------------|
| **Start** | 0 to 1/6 | Initial acceleration |
| **Early** | 1/6 to 2/3 | Position establishing, most of the race |
| **Middle** | 2/3 to 5/6 | Holding position, tactics |
| **Final** | last 1/6 | Last spurt |

The four phases are the solver's own (`CourseData.ts`, `Phase = 0 | 1 | 2 | 3`), and
`phase>=2` is what "middle and final" means in skill conditions. The overlay labels them
Opening, Mid 1, Mid 2 and Final.

---

## Mood

| Mood | Japanese | Stat Effect |
|------|----------|-------------|
| **Great** | Zekkocho (絶好調) | +4% all stats |
| **Good** | Kocho (好調) | +2% all stats |
| **Normal** | Futsuu (普通) | No change |
| **Bad** | Fuchou (不調) | -2% all stats |
| **Awful** | Zekkufuchou (絶不調) | -4% all stats |

---

## Distance Categories

| Category | Distance | Examples |
|----------|----------|----------|
| **Sprint** | 1000-1400m | Sprinters Stakes |
| **Mile** | 1500-1800m | Mile Championship |
| **Mid-Distance** | 1900-2400m | Japan Derby |
| **Long** | 2500m+ | Spring Tenno Sho |

---

## Common Terms

### Bashin (バ身)
A "horse length" - the unit used to measure distances between horses. In Uma Musume, 1 bashin = 2.5 meters.

### Last Spurt
The final sprint phase where horses accelerate to maximum speed. Triggered in the final phase of the race.

### Kakari (掛かり)
When a horse gets "rushed" and runs faster than intended. Causes increased stamina drain (1.6x normal).

### Position Keep
A system where horses try to maintain their target position in the pack rather than just running at full speed.

### Pace Down
When a horse intentionally slows down to conserve stamina or adjust positioning.

### Lead Competition
When front runners compete for the lead position. Causes increased stamina drain for those involved.

### Skill Hint
The level of a skill (0-5). Higher hints reduce SP cost but don't change the skill's effect.

---

## Aptitude Grades

| Grade | Meaning |
|-------|---------|
| **S** | Excellent (+5-10% bonus) |
| **A** | Good (baseline) |
| **B** | Average (-10-15% penalty) |
| **C** | Below Average (~-20%) |
| **D** | Poor (~-40%) |
| **E** | Very Poor (~-60%) |
| **F** | Terrible (~-75%) |
| **G** | Worst (~-90%) |

---

## Simulator-Specific Terms

### Survival Rate
Percentage of simulation runs where the horse didn't run out of stamina.

### Full Spurt Rate
Percentage of runs where the horse reached maximum spurt speed.

### HP Died
When a horse runs out of stamina during a race.

### Sample Count
Number of simulation runs used to calculate statistics.

---

## Abbreviations

| Abbr | Meaning |
|------|---------|
| **SP** | Skill Points (cost to equip skills) |
| **CM** | Champions Meeting |
| **LOH** | League of Heroes |
| **G1/G2/G3** | Race grades (G1 being highest) |
| **URA** | URA Finals (training mode) |
