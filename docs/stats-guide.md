# Stats Guide

What each stat does in a Uma Musume race, and how to build for a race distance.

## The five main stats

### Speed

**What it does:** Determines your maximum speed during the race.

- Higher speed = faster top speed
- Affects target speed in all phases
- S-rank distance aptitude gives +5% effective speed

**Priority:** Very High for all builds

---

### Stamina

**What it does:** Determines how long you can maintain high speeds.

- Creates your "HP pool" for the race
- Running fast drains stamina
- When stamina hits 0, your horse slows dramatically
- Longer races need more stamina

**Priority:** High for mid/long distance, Medium for short sprints

---

### Power

**What it does:** Affects acceleration and corner performance.

- Higher power = faster acceleration
- Helps recover speed after slowing down
- Important for corners and position changes
- Affected by ground conditions (heavy ground needs more power)

**Priority:** High for courses with many corners

---

### Guts

**What it does:** Reduces stamina drain and affects final sprint.

- Reduces stamina consumption in the final phase
- Higher guts = better stamina efficiency when it matters
- Diminishing returns at higher values
- Helps survive close races

**Priority:** Medium-High, especially for longer races

---

### Wisdom (Wit)

**What it does:** Affects skill activation and racing decisions.

- Higher wisdom = better chance of activating skills at optimal times
- Affects position keeping behavior
- Influences racing line choices
- Raises the chance of committing to a faster spurt plan instead of settling for a slower one: 15% plus 0.05% per wisdom ([`hp_policy.rs:215`](../vendor/GlobalSim/src/hp_policy.rs#L215))

**Priority:** Medium, more important for skill-heavy builds

---

## Aptitudes

Aptitudes multiply your effective stats for specific conditions.

### Distance aptitude

Affects performance based on race length:
- **S:** +5% to effective stats
- **A:** Baseline (no change)
- **B:** -10% penalty
- **C and below:** Increasingly severe penalties

### Surface aptitude (turf/dirt)

Same scaling as distance: affects performance on turf vs dirt tracks.

### Running style aptitude

Affects how well your horse performs with a given strategy:
- **S:** +10% effectiveness
- **A:** Baseline
- **B:** -15% penalty

Race with S or A aptitude where you can.

---

## Mood effects

Your horse's mood multiplies all stats:

| Mood | Effect |
|------|--------|
| Great | +4% to all stats |
| Good | +2% to all stats |
| Normal | No change |
| Bad | -2% to all stats |
| Awful | -4% to all stats |

---

## Stat soft caps

Stats have diminishing returns above 1200:
- Stats above 1200 are worth less per point
- This is called "overcap" adjustment
- Still valuable to go higher, but less efficient

---

## Building for different distances

### Sprint (1000-1400m)
- **Focus:** Speed, Power
- **Less important:** Stamina, Guts

### Mile (1500-1800m)
- **Focus:** Speed, Power, some Stamina
- **Balanced approach**

### Mid-distance (1900-2400m)
- **Focus:** Speed, Stamina, Guts
- **Power still important**

### Long distance (2500m+)
- **Focus:** Stamina, Guts, Speed
- **Survival is key**

---

## Quick reference

| Stat | Primary Effect | Best For |
|------|---------------|----------|
| Speed | Top speed | All races |
| Stamina | HP pool | Long races |
| Power | Acceleration | Cornering |
| Guts | Stamina efficiency | Final stretch |
| Wisdom | Skill timing | Skill builds |
