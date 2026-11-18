/**
 * Which skills can possibly fire in the race being simulated.
 *
 * A skill leaves the candidate pool only when a lookup in the app's own data
 * contradicts a term in the skill's own condition. Every other case keeps it: a
 * wrongly kept skill costs races, a wrongly dropped skill costs a build.
 * focus.audit.test.ts checks these verdicts against GlobalSim itself.
 */

import skilldata from '../../../skill_data.json';

/** Atom name → the value this race has for it. */
export interface RaceFacts {
	/**
	 * A missing key means the atom is not a race constant, so a term about it
	 * decides nothing. A shape atom is present only with an empty set, because
	 * only the absence of a feature is provable from course data.
	 */
	readonly values: Record<string, number | Set<number>>
}

export interface RaceConditions {
	ground: number
	weather: number
	season: number
	time: number
}

interface Alternative {
	condition?: string
	precondition?: string
}

const STYLE_ID: Record<string, number> = { Nige: 1, Senkou: 2, Sasi: 3, Oikomi: 4, Oonige: 5 }
const NO_FEATURE: Set<number> = new Set()
const TERM = /^([a-z_][a-z_0-9]*)\s*(==|!=|>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/

/** The course fields these rules read. `slopes` holds a scaled gradient, positive is uphill. */
export interface RaceCourse {
	readonly raceTrackId: number
	readonly distanceType: number
	readonly surface: number
	readonly corners: readonly unknown[]
	readonly straights: readonly unknown[]
	readonly slopes: readonly { readonly slope: number }[]
}

export function raceFacts(course: RaceCourse, conds: RaceConditions, strategy: string): RaceFacts {
	const slopes = course.slopes
	const values: Record<string, number | Set<number>> = {
		distance_type: course.distanceType,
		ground_type: course.surface,
		track_id: course.raceTrackId,
		ground_condition: conds.ground,
		season: conds.season,
		weather: conds.weather,
		time: conds.time,
	}
	const style = STYLE_ID[strategy]
	// The engine lets Nige and Oonige answer to each other (horse_types.rs strategy_matches).
	if (style !== undefined) values.running_style = style === 1 || style === 5 ? new Set([1, 5]) : new Set([style])
	if (!slopes.some(s => s.slope > 0)) values.up_slope_random = NO_FEATURE
	if (!slopes.some(s => s.slope < 0)) values.down_slope_random = NO_FEATURE
	if (!course.corners.length) {
		values.all_corner_random = NO_FEATURE
		values.corner_random = NO_FEATURE
	}
	if (!course.straights.length) {
		values.straight_random = NO_FEATURE
		values.last_straight_random = NO_FEATURE
	}
	return { values }
}

/** True when one AND-branch cannot hold in this race. */
function branchOut(branch: string, facts: RaceFacts): boolean {
	return branch.split('&').some(term => {
		const m = TERM.exec(term.trim())
		if (!m) return false
		const [, name, op, value] = m
		const fact = facts.values[name]
		// Only an exact requirement can be contradicted, and only by a race constant.
		if (fact === undefined || op !== '==') return false
		const want = Number(value)
		return fact instanceof Set ? !fact.has(want) : fact !== want
	})
}

/** An OR of branches is impossible only when every branch is. */
function conditionOut(condition: string, facts: RaceFacts): boolean {
	const branches = condition.split('@').filter(b => b.trim())
	if (!branches.length) return false
	return branches.every(b => branchOut(b, facts))
}

function alternativeOut(alt: Alternative, facts: RaceFacts): boolean {
	// The engine ANDs the precondition onto every branch of the condition.
	return conditionOut(alt.precondition ?? '', facts) || conditionOut(alt.condition ?? '', facts)
}

function firstContradiction(alts: Alternative[], facts: RaceFacts): string | undefined {
	// A side that is out has every @-branch out, so the first branch's own
	// contradiction names it (an OR like ground_condition==2@==3@==4 used to
	// fall through and read "needs condition").
	for (const alt of alts) {
		for (const side of [alt.precondition ?? '', alt.condition ?? '']) {
			if (!conditionOut(side, facts)) continue
			const first = side.split('@').find(b => b.trim()) ?? ''
			const term = first.split('&').find(t => t.trim() && branchOut(t, facts))
			if (term) return term.trim()
		}
	}
	return undefined
}

/**
 * The condition term that rules this skill out, or null to keep it. Out only when
 * every alternative is impossible, so one usable alternative is enough.
 *
 * With several fact sets (a run that scores more than one scenario) the skill is
 * out only when it is out for all of them.
 */
export function factOut(skillId: string, facts: RaceFacts | readonly RaceFacts[]): string | null {
	const sets = Array.isArray(facts) ? facts : [facts]
	const alts = (skilldata as Record<string, { alternatives?: Alternative[] }>)[skillId]?.alternatives
	if (!alts?.length || !sets.length) return null
	if (sets.some(f => alts.some(alt => !alternativeOut(alt, f)))) return null
	return firstContradiction(alts, sets[0]) ?? 'condition'
}

const OUT_LABEL: Record<string, string> = {
	running_style: 'needs a different running style',
	distance_type: 'needs a different distance class',
	ground_type: 'needs a different surface',
	track_id: 'needs a different racecourse',
	ground_condition: 'needs different going',
	season: 'needs a different season',
	weather: 'needs different weather',
	time: 'needs a different time of day',
	up_slope_random: 'needs an uphill stretch, and this course has none',
	down_slope_random: 'needs a downhill stretch, and this course has none',
	all_corner_random: 'needs corners, and this course has none',
	corner_random: 'needs corners, and this course has none',
	straight_random: 'needs a straight, and this course has none',
	last_straight_random: 'needs a final straight, and this course has none',
}

/** Short human text for a term from factOut, for the pool's exclusion list. */
export function describeOut(term: string): string {
	const name = TERM.exec(term)?.[1] ?? term.split(/[=!<>]/)[0]
	return OUT_LABEL[name] ?? `needs ${term}`
}
