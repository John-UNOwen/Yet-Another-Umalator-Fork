/**
 * Utility functions for Skill Chart mode
 *
 * Ported from umalator/BasinnChart.tsx for v2
 */

import { Region, RegionList } from '../../uma-skill-tools/Region';
import { CourseData } from '../../uma-skill-tools/CourseData';
import { RaceParameters } from '../../uma-skill-tools/RaceParameters';
import { getParser } from '../../uma-skill-tools/ConditionParser';
import { buildBaseStats, buildSkillData, Perspective } from '../../uma-skill-tools/RaceSolverBuilder';
import type { UmaState } from './storage';
import type { SkillChartResult } from './skill-chart-types';
import { buildRaceParameters } from './simulation-utils';
import { describeOut, factOut, raceFacts, RaceConditions, RaceCourse } from './engines/globalsim/focus';

// Import data files
import skilldata from '../skill_data.json';
import skillmeta from '../../skill_meta.json';
import skillnames from '../skillnames.json';
import umas from '../../umas.json';
import notInGame from '../not-in-game.json';

/**
 * Check if a skill is a purple (evolved) variant
 */
export function isPurpleSkill(id: string): boolean {
	const iconId = skillmeta[id]?.iconId;
	if (!iconId) return false;
	return iconId[iconId.length - 1] === '4';
}

/**
 * Skill groups sorted by rarity and upgraded/downgraded status
 * Used for SP cost calculation
 */
export const skillGroups = Object.keys(skilldata).sort((a, b) =>
	// Sort by:
	//   - rarity (lowest to highest: white → gold → pink)
	//   - if rarity is same, sort ○ before ◎ (◎ skills have lower ID than ○ counterparts)
	//   - sort purple versions last (to avoid counting towards total cost)
	isPurpleSkill(a) - isPurpleSkill(b) || skilldata[a].rarity - skilldata[b].rarity || +b - +a
).reduce((groups, id) => {
	const groupId = skillmeta[id]?.groupId;
	if (groupId) {
		if (groups.has(groupId)) {
			groups.get(groupId).push(id);
		} else {
			groups.set(groupId, [id]);
		}
	}
	return groups;
}, new Map<string, string[]>());

/**
 * Scale base SP cost by hint level
 * Hint levels 1-3: 10% reduction per level
 * Hint levels 4-5: 30% + 5% per level above 3
 *
 * Integer percentages: the float form (1 - 0.1 * 3 = 0.6999…) floored one SP
 * low at hint 3 for base costs 90/170/180/360.
 */
const HINT_PERCENT = [100, 90, 80, 70, 65, 60];
/** Highest hint level the game gives. */
export const MAX_HINT_LEVEL = 5;
/** SP discount of a hint level in percent: 0, 10, 20, 30, 35, 40. */
export function hintDiscountPercent(hint: number): number {
	const h = Math.max(0, Math.min(MAX_HINT_LEVEL, Math.round(hint) || 0));
	return 100 - HINT_PERCENT[h];
}

/** A skill name's trailing ○ or ◎. */
const CIRCLE = /\s*[○◎]$/;
/** Each ○ / ◎ skill and the pair it belongs to: same group, same name apart
 *  from the circle. */
const circlePairs: Map<string, string[]> = (() => {
	const byName = new Map<string, string[]>();
	for (const id of Object.keys(skilldata)) {
		const name: string | undefined = (skillnames as Record<string, string[]>)[id]?.[0];
		const groupId = skillmeta[id]?.groupId;
		if (!name || !groupId || !CIRCLE.test(name)) continue;
		const key = `${groupId}|${name.replace(CIRCLE, '')}`;
		const ids = byName.get(key);
		if (ids) ids.push(id); else byName.set(key, [id]);
	}
	const out = new Map<string, string[]>();
	for (const ids of byName.values()) if (ids.length > 1) for (const id of ids) out.set(id, ids);
	return out;
})();

/** The skills one hint level covers: a skill and its ○ / ◎ partner. The game
 *  keeps hints per skill group and rarity tier, so the two share one, while
 *  the gold version, the × debuff and every other skill keep their own. */
export function hintLinkedIds(id: string): string[] {
	return circlePairs.get(id) ?? [id];
}

/** A copy of the hint levels with `id` and its ○ / ◎ partner set to `level`. */
export function withHintLevel(hints: Map<string, number>, id: string, level: number): Map<string, number> {
	const next = new Map(hints);
	for (const x of hintLinkedIds(id)) next.set(x, level);
	return next;
}
function scaleBaseCost(baseCost: number, hint: number): number {
	const h = Math.max(0, Math.min(5, Math.round(hint) || 0));
	return Math.floor(baseCost * HINT_PERCENT[h] / 100);
}

/**
 * Calculate total SP cost for acquiring a skill
 * Considers skill groups, hint levels, and owned skills
 */
export function calculateSkillCost(
	id: string,
	hints: Map<string, number>,
	ownedSkills: Map<string, string>
): number {
	const groupId = skillmeta[id]?.groupId;
	if (!groupId) return 0;

	const group = skillGroups.get(groupId);
	if (!group) return 0;

	const existing = ownedSkills.get(groupId);
	let cost = 0;

	// An owned lower tier was paid for together with every link below it, so
	// the walk starts just above it (crediting only the owned id re-charged
	// the cheaper links: owning ◎ priced the gold at ○ + gold, not gold).
	const ownedIdx = existing != null ? group.indexOf(existing) : -1;
	const targetIdx = group.indexOf(id);
	const start = ownedIdx >= 0 && targetIdx > ownedIdx ? ownedIdx + 1 : 0;

	for (let i = start; i < group.length; ++i) {
		// Don't count cost of already-owned skill in same group
		if (group[i] !== existing) {
			const hint = hints.get(group[i]) || 0;
			cost += scaleBaseCost(skillmeta[group[i]].baseCost, hint);
		}
		// Stop when we reach the target skill
		if (group[i] === id) {
			break;
		}
	}

	return cost;
}

/**
 * Get uma outfit ID for a character-specific skill (unique or inherited)
 * Returns null if skill is not character-specific or uma doesn't exist
 *
 * Skill ID patterns:
 * - Unique: 100XXX (e.g., 100681 → uma 1068, outfit 106801)
 * - Inherited: 90XXX or 9XXXX (e.g., 900681 → uma 1068)
 */
export function umaForUniqueSkill(skillId: string): string | null {
	const sid = parseInt(skillId);

	// Handle inherited skills (9xxxxx pattern)
	if (skillId[0] === '9' && skillId.length >= 6) {
		// Extract uma ID: 90XXX → uma 10XX, 9XXXX → uma 1XXX
		// Pattern: 9 + (uma_id - 1000 padded to 4 digits) + variant
		const umaDigits = skillId.slice(1, 5); // e.g., "0068" from "900681"
		const umaId = 1000 + parseInt(umaDigits, 10); // 1000 + 68 = 1068
		const baseUmaId = umaId.toString();

		// Return first outfit for this uma (01 suffix)
		const outfitId = `${baseUmaId}01`;
		if (umas[baseUmaId] && umas[baseUmaId].outfits[outfitId]) {
			return outfitId;
		}
		return null;
	}

	// Handle unique skills (100xxx-199xxx pattern)
	if (sid < 100000 || sid >= 200000) return null;

	const remainder = sid - 100001;
	if (remainder < 0) return null;

	const i = Math.floor(remainder / 10) % 1000;
	const v = Math.floor(remainder / 10 / 1000) + 1;

	const umaId = i.toString().padStart(3, '0');
	const baseUmaId = `1${umaId}`;
	const outfitId = `${baseUmaId}${v.toString().padStart(2, '0')}`;

	if (umas[baseUmaId] && umas[baseUmaId].outfits[outfitId]) {
		return outfitId;
	}

	return null;
}

type ActivationVerdict = 'ok' | 'no-window' | 'parse-error';

/** One skill's activation check against the course, on the retired TypeScript condition parser. */
function activationChecker(
	uma: UmaState,
	course: CourseData,
	racedef: RaceParameters
): (id: string) => ActivationVerdict {
	const parser = getParser();

	// Build base stats for condition checking
	const baseStats = buildBaseStats(
		{
			speed: uma.speed,
			stamina: uma.stamina,
			power: uma.power,
			guts: uma.guts,
			wisdom: uma.wisdom,
			strategy: uma.strategy,
			distanceAptitude: uma.distanceAptitude,
			surfaceAptitude: uma.surfaceAptitude,
			strategyAptitude: uma.strategyAptitude,
			mood: uma.mood
		} as any,
		uma.mood
	);

	// Create region covering entire course
	const wholeCourse = new RegionList();
	wholeCourse.push(new Region(0, course.distance));

	return id => {
		let sd;
		try {
			sd = buildSkillData(baseStats, racedef, course, wholeCourse, parser, id, Perspective.Any);
		} catch (_) {
			return 'parse-error';
		}
		// Skill is activateable if it has at least one trigger with valid regions
		return sd.some(trigger => trigger.regions.length > 0 && trigger.regions[0].start < 9999) ? 'ok' : 'no-window';
	};
}

/**
 * Condition terms whose value is fixed before the race starts (the course, the
 * going, the date, the runner's own style and stats). The app check reads them
 * the way the engine does. Every other term is decided during the race: the
 * retail engine reads phase, corner and final-corner flags from the runner on
 * each tick (they lag the static course regions at a boundary), and field terms
 * such as running_style_count_* or order_rate depend on the other eight
 * runners, which the app check does not have.
 */
const STATIC_TERMS = new Set([
	'rotation', 'track_id', 'ground_type', 'ground_condition', 'weather', 'season', 'time',
	'distance_type', 'course_distance', 'is_dirtgrade', 'is_basis_distance', 'is_tight_track',
	'running_style', 'grade', 'corner_count', 'motivation',
	'base_speed', 'base_stamina', 'base_power', 'base_guts', 'base_wiz',
]);

/** True when every term of every alternative is a STATIC_TERMS term. */
function staticOnly(id: string): boolean {
	const alts = (skilldata as Record<string, { alternatives?: { precondition?: string; condition?: string }[] }>)[id]?.alternatives ?? [];
	return alts.every((a) => `${a.precondition ?? ''}&${a.condition ?? ''}`.split(/[&@]/).every((t) => {
		const name = t.trim().split(/[=!<>]/)[0];
		return !name || STATIC_TERMS.has(name);
	}));
}

/**
 * Filter skills to only those that can activate on the given course
 * Uses condition parser to check if skill has valid activation regions
 */
export function getActivateableSkills(
	skills: string[],
	uma: UmaState,
	course: CourseData,
	racedef: RaceParameters
): string[] {
	const check = activationChecker(uma, course, racedef);
	return skills.filter(id => check(id) === 'ok');
}

/** Why a skill left a candidate pool. */
export interface PoolExclusion {
	id: string
	/** Short text for the exclusion list. */
	reason: string
	/**
	 * fact: a race constant contradicts the skill's condition (focus.ts).
	 * window, parse: the app's TypeScript condition check found no window, or could not read the skill.
	 * engine: the GlobalSim table has no entry, so the engine cannot run it at all.
	 */
	kind: 'fact' | 'window' | 'parse' | 'engine'
	/** The contradicted term, for kind 'fact'. */
	term?: string
}

export interface PoolSplit {
	kept: string[]
	out: PoolExclusion[]
}

/**
 * Split candidate skills into the ones worth simulating and the ones dropped, with a
 * reason for every drop, so no skill leaves a pool silently.
 *
 * The fact rules (focus.ts) run first. The TypeScript check then runs without the
 * position band (a guess, not a fact), though its parser still reads the uma's style.
 * Last, skills the engine table does not cover are dropped, because the engine
 * would reject them.
 */
export function partitionPool(
	skills: string[],
	uma: UmaState,
	course: CourseData,
	conds: RaceConditions,
	knownIds?: ReadonlySet<string> | null
): PoolSplit {
	const facts = raceFacts(course as unknown as RaceCourse, conds, uma.strategy);
	const racedef = buildRaceParameters(conds.ground, conds.weather, conds.season, conds.time);
	const check = activationChecker(uma, course, racedef as RaceParameters);
	const kept: string[] = [];
	const out: PoolExclusion[] = [];
	for (const id of skills) {
		const term = factOut(id, facts);
		if (term !== null) { out.push({ id, kind: 'fact', term, reason: describeOut(term) }); continue; }
		const verdict = check(id);
		// The app check's "no window" holds only for a skill whose condition is all
		// race constants. Anything decided in the race stays for the engine to
		// judge: the app check dropped skills that fire (900591 on Hanshin dirt,
		// the running_style_count_* family in 87 of 100 races on every course).
		if (verdict === 'no-window' && staticOnly(id)) { out.push({ id, kind: 'window', reason: 'no activation window on this course in the app check' }); continue; }
		if (verdict === 'parse-error') { out.push({ id, kind: 'parse', reason: 'the app check could not read this condition' }); continue; }
		if (knownIds && !knownIds.has(id)) { out.push({ id, kind: 'engine', reason: 'not in the engine skill table' }); continue; }
		kept.push(id);
	}
	return { kept, out };
}

/**
 * List of pink (unique) skills that are universally accessible
 * - Welfare/collaboration event alternate unique inherits
 * - Skills starting with '4' (scenario skills)
 */
const universallyAccessiblePinks = ['92111091' /* welfare kraft alt pink unique inherit */]
	.concat(Object.keys(skilldata).filter(id => id[0] === '4'));

/**
 * Check if a skill is a "general" skill that should be tested in chart mode
 * - Rarity < 3 (white and gold skills)
 * - OR universally accessible pink skills
 */
export function isGeneralSkill(id: string): boolean {
	return skilldata[id]?.rarity < 3 || universallyAccessiblePinks.indexOf(id) > -1;
}

/**
 * Get base list of skills to test in chart mode.
 * Filters to general skills only (no character-specific uniques).
 *
 * When `hideNotInGame` is true, ALSO pre-filters out skills that aren't on
 * the live Global server (per not-in-game.json). This saves chart-mode
 * simulation time on skills that would be filtered from the display anyway —
 * roughly 60% of the previously-tested skills on a typical fast-forward.
 */
export function getBaseSkillsToTest(uma: UmaState, hideNotInGame: boolean = false): string[] {
	const notInGameSet = hideNotInGame ? new Set(notInGame.skills) : null;
	return Object.keys(skilldata).filter(id => {
		if (!isGeneralSkill(id)) return false;
		if (notInGameSet && notInGameSet.has(id)) return false;
		return true;
	});
}

/**
 * Create empty result row for skills that haven't been tested yet
 */
export function getNullRow(skillId: string): SkillChartResult {
	return {
		id: skillId,
		min: 0,
		max: 0,
		mean: 0,
		median: 0,
		results: [],
		runData: null as any
	};
}

/**
 * Calculate statistics from sorted results array
 */
export function calculateStats(results: number[]): {
	min: number;
	max: number;
	mean: number;
	median: number;
} {
	if (results.length === 0) {
		return { min: 0, max: 0, mean: 0, median: 0 };
	}

	const sorted = [...results].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);

	return {
		min: sorted[0],
		max: sorted[sorted.length - 1],
		mean: sorted.reduce((sum, v) => sum + v, 0) / sorted.length,
		median: sorted.length % 2 === 0
			? (sorted[mid - 1] + sorted[mid]) / 2
			: sorted[mid]
	};
}

/**
 * The pool a run uses: the kept skills, plus every exclusion the user took back.
 * With `focusOn` false nothing the app check or the fact rules dropped stays out.
 * Skills the engine table lacks stay out either way, because the engine rejects them.
 */
export function applyExclusions(
	kept: readonly string[],
	out: readonly PoolExclusion[],
	focusOn: boolean,
	included: ReadonlySet<string>
): string[] {
	const back = out.filter(e => e.kind !== 'engine' && (!focusOn || included.has(e.id)));
	return back.length ? [...kept, ...back.map(e => e.id)] : [...kept];
}
