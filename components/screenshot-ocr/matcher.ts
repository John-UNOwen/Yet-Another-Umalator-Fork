// Names the OCR read against names the app actually offers. Only this fork's own database is a
// candidate, so a misread can never invent a skill, and a fast-forwarded JP-only name is not a
// candidate either because the player cannot have it.
//
// Two names can be identical apart from how the skill was acquired, and those are different skills
// with different effects, so a marker the reader cannot see is never guessed: it comes back as a
// choice for the user. The same goes for a name that one character learns at its own level and
// another inherits, which the database stores under two ids.

export interface NameEntry {
	id: string;
	name: string;
}

export interface MatchOptions {
	/** Below this, the closest name is not accepted. */
	minScore: number;
	/** How far the best must beat the closest different name before it is accepted without asking. */
	minMargin: number;
	/** A line this much shorter or longer than a candidate is not that candidate. */
	lengthRatio: number;
	/** How many junk words may be dropped from either end of a line. */
	maxTrims: number;
	/** What each dropped word costs the score. */
	trimPenalty: number;
}

export const DEFAULT_MATCH: MatchOptions = { minScore: 0.82, minMargin: 0.08, lengthRatio: 0.6, maxTrims: 4, trimPenalty: 0.03 };

export interface Match {
	/** The id when one entry answers to this line, otherwise null and `ids` is the choice to present. */
	id: string | null;
	/** Every id still compatible with what was read. */
	ids: string[];
	name: string;
	score: number;
	/** How far the best beats the closest different name. */
	margin: number;
	/** Junk words dropped from the ends of the read line. */
	trims: number;
	/** Why the ids could not be narrowed to one. */
	why?: 'marker' | 'level';
}

const MARKER_GLYPHS: Record<string, '○' | '◎' | '×'> = {
	'○': '○', '◯': '○', '⭕': '○', '◦': '○', '⃝': '○',
	'◎': '◎', '⦿': '◎', '⊚': '◎', '©': '◎',
	'×': '×', '✕': '×', '✖': '×',
};

export interface ReadMarker {
	/** The glyph the reader saw, when it was clear enough to name. */
	glyph: '○' | '◎' | '×' | null;
	/** Set when the line ended in a letter that stands for some marker but says which. */
	uncertain: boolean;
}

/** The acquisition marker drawn after a name, and whether the reader could tell which one it was. */
export function markerOf(line: string): ReadMarker {
	const tail = line.trim().slice(-1);
	const glyph = MARKER_GLYPHS[tail];
	if (glyph) return { glyph, uncertain: false };
	if (/[oO0]/.test(tail)) return { glyph: null, uncertain: true };
	return { glyph: null, uncertain: false };
}

/** The name with its marker removed, in the shape a screenshot can show. */
export function normalizeName(text: string): string {
	return text
		.normalize('NFKD')
		.toLowerCase()
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[○◎×◯⭕◦⃝⦿⊚©✕✖]/g, '')
		.replace(/[^a-z0-9]/g, '');
}

/** The marker a database name ends with, and the name without it. */
export function splitMarker(name: string): { base: string; marker: '○' | '◎' | '×' | null } {
	const trimmed = name.trim();
	const marker = MARKER_GLYPHS[trimmed.slice(-1)] ?? null;
	return { base: normalizeName(marker ? trimmed.slice(0, -1) : trimmed), marker };
}

/** The game prints a level after a skill the character owns outright, and nothing after an inherited one. */
export function hasLevel(line: string): boolean {
	return /(?:^|\s)(?:lvl|level|lgl|lva)\s*\.?\s*\d/.test(line.toLowerCase());
}

/** Levenshtein ratio of two strings, 1 for equal, 0 for nothing in common. */
export function similarity(a: string, b: string): number {
	if (a === b) return 1;
	if (!a.length || !b.length) return 0;
	const previous = new Array<number>(b.length + 1);
	const current = new Array<number>(b.length + 1);
	for (let j = 0; j <= b.length; j++) previous[j] = j;
	for (let i = 1; i <= a.length; i++) {
		current[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
		}
		previous.splice(0, previous.length, ...current);
	}
	return 1 - previous[b.length] / Math.max(a.length, b.length);
}

/** The best candidate for one read line, or nothing when the closest name is too far away. */
export function matchName(line: string, entries: readonly NameEntry[], options: Partial<MatchOptions> = {}): Match | null {
	const o = { ...DEFAULT_MATCH, ...options };
	const groups = scoreGroups(line, entries, o);
	const top = groups[0];
	if (!top || top.score < o.minScore) return null;

	const marker = markerOf(line);
	let pool = top.entries;
	let why: Match['why'];
	if (marker.glyph) {
		const marked = pool.filter((e) => splitMarker(e.name).marker === marker.glyph);
		if (marked.length) pool = marked;
	} else if (marker.uncertain) {
		const marked = pool.filter((e) => splitMarker(e.name).marker !== null);
		if (marked.length) { pool = marked; why = 'marker'; }
	}

	if (pool.length > 1) {
		// A level means the character's own skill, no level an inherited one. Both are the same name.
		const wanted = hasLevel(line) ? '1' : '9';
		const tiered = pool.filter((e) => e.id.startsWith(wanted));
		if (tiered.length) pool = tiered;
		else why = why ?? 'level';
	}
	if (pool.length > 1) why = why ?? 'level';

	return {
		id: pool.length === 1 ? pool[0].id : null,
		ids: pool.map((e) => e.id),
		name: top.name,
		score: top.score,
		margin: top.score - (groups[1]?.score ?? 0),
		trims: top.trims,
		why,
	};
}

/** The candidates worth showing a user, best first, each above the accept threshold. */
export function matchCandidates(line: string, entries: readonly NameEntry[], options: Partial<MatchOptions> = {}): Match[] {
	const o = { ...DEFAULT_MATCH, ...options };
	return scoreGroups(line, entries, o).filter((g) => g.score >= o.minScore).slice(0, 4).map((g) => ({
		id: g.entries.length === 1 ? g.entries[0].id : null,
		ids: g.entries.map((e) => e.id),
		name: g.name,
		score: g.score,
		margin: 0,
		trims: g.trims,
	}));
}

interface NameGroup {
	name: string;
	entries: NameEntry[];
	score: number;
	trims: number;
}

/**
 * Score each distinct name once. Names differing only by their acquisition marker are different
 * skills, so they share a group here and are separated afterwards by the marker the reader saw.
 */
function scoreGroups(line: string, entries: readonly NameEntry[], o: MatchOptions): NameGroup[] {
	const words = line.trim().split(/\s+/).filter(Boolean);
	if (!words.length) return [];

	// Each way of dropping junk words from the ends, with how many were dropped. With an unclear
	// marker the last letter may be the marker or the name's own last letter, so both readings count.
	const marker = markerOf(line);
	const readings = new Map<string, number>();
	for (let trims = 0; trims <= o.maxTrims; trims++) {
		for (let head = 0; head <= trims && head + trims <= words.length; head++) {
			const keep = words.slice(head, words.length - (trims - head) || undefined);
			if (!keep.length) continue;
			for (const variant of marker.uncertain ? [keep.slice(0, -1), keep] : [keep]) {
				const read = normalizeName(variant.join(''));
				if (read && !readings.has(read)) readings.set(read, trims);
			}
		}
	}

	const groups = new Map<string, NameGroup>();
	for (const [read, trims] of readings) {
		for (const entry of entries) {
			const target = normalizeName(entry.name);
			if (!target) continue;
			const ratio = Math.min(read.length, target.length) / Math.max(read.length, target.length);
			if (ratio < o.lengthRatio) continue;
			const score = similarity(read, target) - trims * o.trimPenalty;
			const seen = groups.get(target);
			if (!seen) groups.set(target, { name: entry.name, entries: [entry], score, trims });
			else if (!seen.entries.some((e) => e.id === entry.id)) seen.entries.push(entry);
			if (seen && score > seen.score) { seen.score = score; seen.trims = trims; seen.name = entry.name; }
		}
	}
	return [...groups.values()].sort((a, b) => b.score - a.score);
}
