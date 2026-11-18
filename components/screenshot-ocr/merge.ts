// Several screenshots of one uma become one reading: the same dialog photographed twice with an overlap,
// or a skill list long enough to need two shots. Skills are combined by what they matched, so a row seen
// twice stays one row, and a field the screenshots disagree on is reported rather than decided.

import type { Grade } from './aptitudes';
import { APTITUDE_WORDS, STAT_LABELS } from './layout';
import type { AptitudeKey, StatKey } from './layout';
import { normalizeName, similarity } from './matcher';
import type { SkillRead } from './matcher';

export type { SkillRead } from './matcher';

/** What one screenshot read. A missing field means that screen did not show it. */
export interface Read {
	stats?: Partial<Record<StatKey, number>>;
	aptitudes?: Partial<Record<AptitudeKey, Grade>>;
	skills?: SkillRead[];
	name?: string;
	epithet?: string;
	star?: number;
	uniqueLevel?: number;
}

export interface Agreed<T> {
	value: T | null;
	/** The other answers that came in, so a disagreement is shown to the user instead of buried. */
	other: T[];
}

export interface MergedRead {
	stats: Record<StatKey, Agreed<number>>;
	aptitudes: Record<AptitudeKey, Agreed<Grade>>;
	skills: SkillRead[];
	name: Agreed<string>;
	epithet: Agreed<string>;
	star: Agreed<number>;
	uniqueLevel: Agreed<number>;
	/** Screenshots this came from, for the review screen to say so. */
	screenshots: number;
}

/** Two rows are the same skill when the matcher settled them on the same id. */
function keyOf(skill: SkillRead): string {
	return skill.match.id ?? `?${skill.name.toLowerCase()}`;
}

/**
 * The stronger of two readings of one skill. The candidate lists are unioned so a pick the other
 * reading saw is still offered, and the level is the higher one because a screenshot that clipped the
 * `Lvl` text is a miss rather than a contradiction.
 */
function combine(kept: SkillRead, next: SkillRead): SkillRead {
	const better = next.match.score > kept.match.score ? next : kept;
	const ids = [...kept.match.ids];
	for (const id of next.match.ids) if (!ids.includes(id)) ids.push(id);
	const levels = [kept.level, next.level].filter((n): n is number => typeof n === 'number');
	return {
		text: better.text,
		name: better.name,
		match: { ...better.match, ids },
		level: levels.length ? Math.max(...levels) : null,
	};
}

/** A second reading of the same row, unresolved, that says nearly the same thing as a resolved one. */
const SAME_ROW = 0.9;

/**
 * The skills across all screenshots, one entry per skill, in the order they were first read.
 * A row neither screenshot could resolve is folded into a resolved one when the text is the same row
 * misread, which is what two shots of one list usually produce.
 */
function mergeSkills(reads: readonly Read[]): SkillRead[] {
	const byKey = new Map<string, SkillRead>();
	for (const read of reads) {
		for (const skill of read.skills ?? []) {
			const key = keyOf(skill);
			const kept = byKey.get(key);
			byKey.set(key, kept ? combine(kept, skill) : { ...skill, match: { ...skill.match, ids: [...skill.match.ids] } });
		}
	}
	const resolved = [...byKey.entries()].filter(([, s]) => s.match.id !== null);
	for (const [key, skill] of [...byKey.entries()]) {
		if (skill.match.id !== null) continue;
		const home = resolved.find(([, other]) => other.match.id !== null && similarity(normalizeName(skill.name), normalizeName(other.name)) >= SAME_ROW);
		if (!home) continue;
		byKey.set(home[0], combine(home[1], skill));
		byKey.delete(key);
	}
	return [...byKey.values()];
}

/** The answer the screenshots gave, with any other answer they gave too. */
function agree<T>(values: readonly (T | undefined)[]): Agreed<T> {
	const seen: T[] = [];
	for (const value of values) if (value !== undefined && !seen.includes(value)) seen.push(value);
	return { value: seen.length ? seen[0] : null, other: seen.slice(1) };
}

/**
 * One reading built from several screenshots. Absent everywhere is a null value with no other answer,
 * which is what the review screen shows as "not read".
 */
export function mergeReads(reads: readonly Read[]): MergedRead {
	const stats = {} as Record<StatKey, Agreed<number>>;
	for (const label of STAT_LABELS) stats[label] = agree(reads.map((r) => r.stats?.[label]));
	const aptitudes = {} as Record<AptitudeKey, Agreed<Grade>>;
	for (const key of Object.keys(APTITUDE_WORDS) as AptitudeKey[]) aptitudes[key] = agree(reads.map((r) => r.aptitudes?.[key]));
	return {
		stats,
		aptitudes,
		skills: mergeSkills(reads),
		name: agree(reads.map((r) => r.name)),
		epithet: agree(reads.map((r) => r.epithet)),
		star: agree(reads.map((r) => r.star)),
		uniqueLevel: agree(reads.map((r) => r.uniqueLevel)),
		screenshots: reads.length,
	};
}

/** What the merge could not settle, so the review screen can say what still needs the user. */
export function gaps(merged: MergedRead): string[] {
	const missing: string[] = [];
	for (const label of STAT_LABELS) if (merged.stats[label].value === null) missing.push(label.toLowerCase());
	for (const key of Object.keys(APTITUDE_WORDS) as AptitudeKey[]) if (merged.aptitudes[key].value === null) missing.push(key);
	if (merged.epithet.value === null && merged.name.value === null) missing.push('character');
	if (merged.skills.length === 0) missing.push('skills');
	return missing;
}
