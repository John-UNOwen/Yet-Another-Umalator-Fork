// Names the OCR read against the names this fork offers, so a misread cannot invent a skill and a
// fast-forwarded JP-only name is no candidate. Names differing only by acquisition marker or by owned
// versus inherited copy are different skills, so an unseen marker or level is a choice, never a guess.

import { boxBottom, boxRight } from './contract';
import type { Box, OcrLine } from './contract';

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

/**
 * The level a skill the character owns outright carries after its name, which an inherited copy of the
 * same skill does not. The reader confuses the letter i, so the badge can arrive as "Lv| 4".
 */
export function levelOf(line: string): number | null {
	const text = line.toLowerCase().replace(/[|!¡]/g, 'l');
	const m = text.match(/(?:^|\s)(?:lvl|level|lgl|lva)\s*\.?\s*(\d{1,2})(?!\d)/);
	return m ? +m[1] : null;
}

/** The game prints a level after a skill the character owns outright, and nothing after an inherited one. */
export function hasLevel(line: string): boolean {
	return levelOf(line) !== null;
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

/** What a second look at the screen knows that the line's own text does not say. */
export interface Seen {
	/** The row carried a level chip, even though its text landed on a line of its own. */
	level?: boolean;
	/** A marker the reader saw beside the name rather than after it. */
	marker?: ReadMarker;
}

/** The best candidate for one read line, or nothing when the closest name is too far away. */
export function matchName(line: string, entries: readonly NameEntry[], options: Partial<MatchOptions> = {}, saw: Seen = {}): Match | null {
	const o = { ...DEFAULT_MATCH, ...options };
	const groups = scoreGroups(line, entries, o);
	const top = groups[0];
	if (!top || top.score < o.minScore) return null;

	const marker = saw.marker ?? markerOf(line);
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
		const wanted = (saw.level ?? hasLevel(line)) ? '1' : '9';
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

/** A skill line, what the matcher made of it, and where on the screen it was read. */
export interface SkillRead {
	/** What the screen printed, kept for the review screen to show beside the answer. */
	text: string;
	/** The name the matcher settled on, for display. */
	name: string;
	match: Match;
	/** The unique skill's level, where this line carried it. */
	level: number | null;
	box?: Box;
}

/** A name the game wrapped onto a second line continues the line above it: same column, just below. */
function aboveInColumn(line: OcrLine, lines: readonly OcrLine[]): OcrLine | undefined {
	let best: OcrLine | undefined;
	for (const other of lines) {
		if (other === line) continue;
		const shared = Math.min(boxRight(other.box), boxRight(line.box)) - Math.max(other.box.x, line.box.x);
		if (shared < Math.min(other.box.w, line.box.w) * 0.5) continue;
		const gap = line.box.y - boxBottom(other.box);
		if (gap < -other.box.h * 0.3 || gap > other.box.h * 1.2) continue;
		if (!best || other.box.y > best.box.y) best = other;
	}
	return best;
}

/**
 * The skills a screen shows. Every line is tried against the pool of names this fork offers and the
 * lines that answer are the list: the table also carries icons, hint badges and level chips, and none
 * of those answer, so the list is found without knowing where the table sits. `levelOnRow` looks along
 * the line's row for a level chip the detector boxed on its own, which is how the dialog prints the
 * unique skill's level.
 */
export function skillReads(lines: readonly OcrLine[], entries: readonly NameEntry[], options: Partial<MatchOptions> = {}, levelOnRow?: (line: OcrLine, lines: readonly OcrLine[]) => number | null): SkillRead[] {
	const o = { ...DEFAULT_MATCH, ...options };
	const rowLevel = (line: OcrLine) => levelOf(line.text) ?? levelOnRow?.(line, lines) ?? null;
	const tried = (text: string, level: number | null) => matchName(text, entries, options, { level: level !== null || undefined });
	const alone = new Map<OcrLine, Match | null>();
	for (const line of lines) alone.set(line, tried(line.text, rowLevel(line)));

	// A name wrapped over two lines only reads as a name once joined: each half alone is nothing, or the
	// line above is already a confident name of its own and keeps it rather than being swallowed.
	const tailOf = new Map<OcrLine, OcrLine>();
	for (const line of lines) {
		const upper = aboveInColumn(line, lines);
		if (!upper) continue;
		const joined = tried(`${upper.text} ${line.text}`, rowLevel(upper));
		if (!joined || joined.score < o.minScore) continue;
		if (joined.score <= (alone.get(line)?.score ?? 0) || joined.score <= (alone.get(upper)?.score ?? 0)) continue;
		tailOf.set(line, upper);
	}

	const reads: SkillRead[] = [];
	for (const line of lines) {
		if (tailOf.has(line)) continue;
		const tail = lines.find((l) => tailOf.get(l) === line);
		const text = tail ? `${line.text} ${tail.text}` : line.text;
		const box = tail
			? { x: Math.min(line.box.x, tail.box.x), y: line.box.y, w: Math.max(boxRight(line.box), boxRight(tail.box)) - Math.min(line.box.x, tail.box.x), h: boxBottom(tail.box) - line.box.y }
			: line.box;
		const level = rowLevel(line) ?? (tail ? rowLevel(tail) : null);
		const match = tail ? tried(text, level) : alone.get(line) ?? null;
		if (!match) continue;
		reads.push({ text, name: match.name, match, level, box });
	}
	return reads;
}
