// Turns a merged read plus what the user changed into the object `validateAndParseUmaJson` takes.
// Kept apart from the review screen so the same rules can be run over the screenshot corpus.

import type { Grade } from './aptitudes';
import type { AptitudeKey, StatKey } from './layout';
import type { MergedRead } from './merge';

export type Strategy = 'Nige' | 'Senkou' | 'Sasi' | 'Oikomi';

/** A field the user set. Absent means the reading stands. */
export interface Edits {
	stats?: Partial<Record<StatKey, number>>;
	aptitudes?: Partial<Record<AptitudeKey, Grade>>;
	strategy?: Strategy;
	outfitId?: string;
	starCount?: number;
	uniqueLv?: number;
	/** Per skill row, keyed by `match.ids.join(',')`: the candidate chosen, or dropped. */
	skills?: Record<string, { pick?: string; off?: boolean }>;
}

export interface UmaDraft {
	outfitId: string;
	starCount: number;
	uniqueLv: number;
	speed: number;
	stamina: number;
	power: number;
	guts: number;
	wisdom: number;
	strategy: Strategy;
	distanceAptitude: Grade;
	surfaceAptitude: Grade;
	strategyAptitude: Grade;
	mood: number;
	skills: string[];
	forcedSkillPositions: Record<string, string>;
}

const STAT_DEFAULTS: Record<StatKey, number> = { Speed: 1200, Stamina: 1200, Power: 800, Guts: 400, Wit: 400 };
const STRATEGY_APTITUDE: Record<Strategy, AptitudeKey> = { Nige: 'nige', Senkou: 'senkou', Sasi: 'sashi', Oikomi: 'oikomi' };
const DISTANCES: readonly AptitudeKey[] = ['short', 'mile', 'medium', 'long'];
const STRATEGIES: readonly Strategy[] = ['Nige', 'Senkou', 'Sasi', 'Oikomi'];

/** S above A above B. The panel keeps one distance grade, so the best of the four is what fits. */
const BEST = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
const rank = (grade: Grade) => BEST.indexOf(grade as (typeof BEST)[number]);

/** The aptitude a running style's own grade is stored under. */
export const styleAptitudeOf = (strategy: Strategy): AptitudeKey => STRATEGY_APTITUDE[strategy];

/** The four cells the panel collapses into one distance grade. */
export const DISTANCE_KEYS: readonly AptitudeKey[] = DISTANCES;
/** One row of the merged list, named by the candidates it came with so the review screen and this module agree. */
export const skillKey = (row: { match: { ids: readonly string[] } }) => row.match.ids.join(',');

export function umaFromRead(merged: MergedRead, edits: Edits = {}): UmaDraft {
	const grade = (key: AptitudeKey) => edits.aptitudes?.[key] ?? merged.aptitudes[key].value ?? 'A';
	// A distance cell the screens never showed does not vote. Only an unread set falls back.
	const shown = DISTANCES.map((key) => edits.aptitudes?.[key] ?? merged.aptitudes[key].value).filter((g): g is Grade => !!g);
	const distance = shown.length ? shown.sort((a, b) => rank(a) - rank(b))[0] : 'A';
	const strategy = STRATEGIES.includes(edits.strategy as Strategy) ? (edits.strategy as Strategy) : 'Senkou';
	const stat = (label: StatKey) => edits.stats?.[label] ?? merged.stats[label].value ?? STAT_DEFAULTS[label];

	const skills: string[] = [];
	for (const row of merged.skills) {
		const choice = edits.skills?.[skillKey(row)];
		if (choice?.off) continue;
		const id = choice?.pick ?? row.match.id ?? row.match.ids[0];
		if (id) skills.push(id);
	}

	return {
		outfitId: edits.outfitId ?? '',
		// The Details dialog shows neither stars nor mood, so these stay the panel's own defaults
		// unless the user sets them.
		starCount: edits.starCount ?? 3,
		uniqueLv: edits.uniqueLv ?? merged.uniqueLevel.value ?? 1,
		speed: stat('Speed'),
		stamina: stat('Stamina'),
		power: stat('Power'),
		guts: stat('Guts'),
		wisdom: stat('Wit'),
		strategy,
		distanceAptitude: distance,
		surfaceAptitude: grade('turf'),
		strategyAptitude: grade(STRATEGY_APTITUDE[strategy]),
		mood: 2,
		skills,
		forcedSkillPositions: {},
	};
}
