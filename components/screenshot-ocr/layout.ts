// The regions of the details dialog, found by the English words they are built from: the aptitude
// block, the stat row, the header and the unique level. Nothing here is a fixed coordinate, because
// screen size and how far the game was scrolled both move everything.

import { boxRight } from './contract';
import type { Box, OcrLine } from './contract';
import type { LetterProbe } from './aptitudes';
import { levelOf } from './matcher';

export type AptitudeKey = 'turf' | 'dirt' | 'short' | 'mile' | 'medium' | 'long' | 'nige' | 'senkou' | 'sashi' | 'oikomi';

/** What the Global client prints for each aptitude, in the order the dialog lays them out. */
export const APTITUDE_WORDS: Record<AptitudeKey, string> = {
	turf: 'Turf', dirt: 'Dirt', short: 'Sprint', mile: 'Mile', medium: 'Medium', long: 'Long',
	nige: 'Front', senkou: 'Pace', sashi: 'Late', oikomi: 'End',
};

const KEYS = Object.keys(APTITUDE_WORDS) as AptitudeKey[];

/** The three headings the aptitude block is drawn under. */
const ROW_LABELS = ['Track', 'Distance', 'Style'];

export interface AptitudeCell {
	key: AptitudeKey;
	/** The value word, which is also where the letter hides when the detector did not box it alone. */
	word: OcrLine;
	/** A letter boxed on its own, when the detector found one. */
	letter: OcrLine | null;
}

interface Row {
	centre: number;
	right: number;
	/** How far from this row's centre a word still belongs to it. */
	band: number;
}

/**
 * The three rows of the block, from their headings. Two headings give the pitch between rows, which is
 * what keeps a word from the row above out of the cell below.
 */
function labelRows(lines: readonly OcrLine[]): Row[] {
	const found = ROW_LABELS.map((label) => {
		const wanted = label.toLowerCase();
		return lines
			.filter((l) => {
				const text = l.text.trim().toLowerCase();
				return text.startsWith(wanted) && text.length - wanted.length <= 2;
			})
			.sort((a, b) => a.text.length - b.text.length)[0];
	}).filter((l): l is OcrLine => !!l);
	if (!found.length) return [];

	const tallest = Math.max(...found.map((l) => l.box.h));
	const centres = found.map((l) => l.box.y + l.box.h / 2).sort((a, b) => a - b);
	const pitch = centres.length > 1 ? Math.min(...centres.slice(1).map((c, i) => c - centres[i])) : tallest * 2.5;
	return found.map((l) => ({ centre: l.box.y + l.box.h / 2, right: l.box.x + l.box.w, band: Math.min(pitch * 0.6, tallest * 1.6) }));
}

/** A letter box sitting just past a word's end, on the same line, when the detector made one. */
function letterOf(word: OcrLine, lines: readonly OcrLine[]): OcrLine | null {
	const centre = word.box.y + word.box.h / 2;
	return lines
		.filter((l) => l !== word
			&& Math.abs(l.box.y + l.box.h / 2 - centre) < word.box.h * 0.7
			&& l.box.x > word.box.x + word.box.w - word.box.h * 0.3
			&& l.box.x < word.box.x + word.box.w + word.box.h * 2.2
			&& l.box.w < word.box.h * 1.3)
		.sort((a, b) => a.box.x - b.box.x)[0] ?? null;
}

/**
 * The ten cells of the aptitude block, found under their headings so a skill row that starts with the
 * same word is never mistaken for one. A cell is its word plus, when the detector boxed one, a small
 * letter blob just past the word's end. Where two rows both hold the word, the one with a letter beside
 * it wins, since a cell without a letter is the rarer case.
 */
export function aptitudeCells(lines: readonly OcrLine[]): AptitudeCell[] {
	const rows = labelRows(lines);
	if (!rows.length) return [];
	const cells: AptitudeCell[] = [];
	for (const key of KEYS) {
		const wanted = APTITUDE_WORDS[key].toLowerCase();
		const candidates = lines
			.map((word) => {
				const text = word.text.trim().toLowerCase();
				if (!text.startsWith(wanted) || text.length - wanted.length > 3) return null;
				const centre = word.box.y + word.box.h / 2;
				const row = rows.filter((r) => Math.abs(centre - r.centre) <= r.band && word.box.x > r.right - word.box.h).sort((a, b) => Math.abs(centre - a.centre) - Math.abs(centre - b.centre))[0];
				if (!row) return null;
				return { word, letter: letterOf(word, lines), glued: text.length > wanted.length };
			})
			.filter((c): c is { word: OcrLine; letter: OcrLine | null; glued: boolean } => !!c)
			.sort((a, b) => Number(!!b.letter) - Number(!!a.letter) || Number(b.glued) - Number(a.glued) || a.word.text.length - b.word.text.length)[0];
		if (candidates) cells.push({ key, word: candidates.word, letter: candidates.letter });
	}
	return cells;
}

/**
 * Where a cell's letter can be, most trusted first. A boxed letter is measured in a window widened
 * until the panel outnumbers the glyph, since the colour of a letter is read against its panel. A
 * word's own tail is last: it can only ever say A, the colour the words share with that grade.
 */
export function letterProbes(cell: AptitudeCell): LetterProbe[] {
	const { word, letter } = cell;
	const b = word.box;
	const probes: LetterProbe[] = [];
	if (letter) {
		const pad = letter.box.h * 0.45;
		probes.push({ where: 'blob', box: { x: letter.box.x - pad, y: letter.box.y - pad, w: letter.box.w + pad * 2, h: letter.box.h + pad * 2 } });
	}
	probes.push({ where: 'gap', box: { x: b.x + b.w, y: b.y - b.h * 0.1, w: b.h * 1.4, h: b.h * 1.2 } });
	probes.push({ where: 'word', box: { x: b.x + b.w - b.h * 0.9, y: b.y, w: b.h * 0.9, h: b.h } });
	return probes;
}

/** A box around a cell's word and letter, for showing the user what was read. */
export function cellBox(cell: AptitudeCell): Box {
	const right = cell.letter ? cell.letter.box.x + cell.letter.box.w : cell.word.box.x + cell.word.box.w;
	return { x: cell.word.box.x, y: cell.word.box.y, w: right - cell.word.box.x, h: cell.word.box.h };
}

/** The five stats, in the order the dialog prints them across the row. */
export const STAT_LABELS = ['Speed', 'Stamina', 'Power', 'Guts', 'Wit'] as const;
export type StatKey = typeof STAT_LABELS[number];

export interface StatColumn {
	label: typeof STAT_LABELS[number];
	/** Middle of the label, which the number below it is aligned to. */
	centre: number;
	/** Where the number sits: below its label, up to the next column, badge included. */
	region: Box;
}

/**
 * The five number regions, placed by the labels above them rather than by the numbers themselves,
 * because the rank badge beside a number gets glued to it by the detector. The region reaches left of
 * the label so the badge is inside it, which is what lets the reader cut the badge out by colour.
 */
export function statColumns(lines: readonly OcrLine[]): StatColumn[] {
	const found = STAT_LABELS.map((label) => {
		const wanted = label.toLowerCase();
		// The reader often glues a glyph or two onto the front of a short word, so the label may end
		// with the word rather than be it.
		const word = lines
			.filter((l) => {
				const last = l.text.trim().toLowerCase().split(/\s+/).pop() ?? '';
				return last.endsWith(wanted) && last.length - wanted.length <= 2;
			})
			.sort((a, b) => a.box.x - b.box.x)[0];
		return word ? { label, word } : null;
	}).filter((l): l is { label: typeof STAT_LABELS[number]; word: OcrLine } => !!l);
	if (found.length < 3) return [];

	const rowCentre = found.reduce((sum, f) => sum + f.word.box.y + f.word.box.h / 2, 0) / found.length;
	const row = found.filter((f) => Math.abs(f.word.box.y + f.word.box.h / 2 - rowCentre) < 30).sort((a, b) => a.word.box.x - b.word.box.x);
	return row.map((f, i) => {
		const h = f.word.box.h;
		const x0 = f.word.box.x - h * 1.4;
		const x1 = i + 1 < row.length ? row[i + 1].word.box.x - h * 0.2 : f.word.box.x + f.word.box.w + h * 2;
		return {
			label: f.label,
			centre: f.word.box.x + f.word.box.w / 2,
			region: { x: x0, y: f.word.box.y + f.word.box.h - h * 0.3, w: x1 - x0, h: h * 3 },
		};
	});
}

/**
 * The line that carries a stat's number. The detector glues the rank badge to the digits, so the
 * number is one wide box rather than a digit run, and a box that belongs to the next column can still
 * reach into this region. Alignment decides: a number sits under its own label, so the digit-bearing
 * box nearest the label's middle is the one.
 */
export function statNumberLine(lines: readonly OcrLine[], column: StatColumn): OcrLine | null {
	const bottom = column.region.y + column.region.h;
	const found = lines.filter((l) => {
		if (!/\d{2,}/.test(l.text)) return false;
		const centre = l.box.x + l.box.w / 2;
		if (centre < column.region.x || centre > column.region.x + column.region.w) return false;
		return l.box.y > column.region.y - l.box.h * 0.5 && l.box.y < bottom;
	});
	if (!found.length) return null;
	return found.sort((a, b) => Math.abs(a.box.x + a.box.w / 2 - column.centre) - Math.abs(b.box.x + b.box.w / 2 - column.centre))[0];
}

/**
 * The header of the details dialog. The outfit is named by its epithet in brackets, and the trained
 * name is printed under it, so the name is whatever line sits under the brackets and overlaps them
 * rather than the rank badge that often sits beside them.
 */
export function header(lines: readonly OcrLine[]): { epithet: string | null; name: string | null } {
	// The reader can lose the closing bracket, so an opening one is enough to call a line the epithet.
	const opens = (l: OcrLine) => /^\[/.test(l.text.trim());
	const closes = (l: OcrLine) => (/\]$/.test(l.text.trim()) ? 1 : 0);
	const bracketed = lines.filter(opens).sort((a, b) => closes(b) - closes(a) || b.box.h - a.box.h)[0];
	if (!bracketed) return { epithet: null, name: null };
	const bottom = bracketed.box.y + bracketed.box.h;
	const below = lines
		.filter((l) => {
			if (l === bracketed || opens(l)) return false;
			if (l.box.y < bottom - l.box.h * 0.4 || l.box.y > bottom + l.box.h * 1.6) return false;
			const overlap = Math.min(l.box.x + l.box.w, bracketed.box.x + bracketed.box.w) - Math.max(l.box.x, bracketed.box.x);
			return overlap >= Math.min(l.box.w, bracketed.box.w) * 0.3;
		})
		.sort((a, b) => a.box.y - b.box.y)[0];
	return { epithet: bracketed.text.trim(), name: below ? below.text.trim() : null };
}

/**
 * The unique skill's level. The dialog prints it once, beside the unique skill's own name, and an
 * inherited skill has none, so a screen showing no level chip says nothing rather than zero.
 */
export function uniqueLevel(lines: readonly OcrLine[]): number | null {
	for (const line of lines) {
		const level = levelOf(line.text);
		if (level !== null) return level;
	}
	return null;
}

/**
 * The level chip that shares a name's row. The detector usually boxes it as a line of its own, so the
 * name's own text does not say that the skill is the character's rather than an inherited copy. The
 * chip can sit well clear of its name, so what makes it that name's is that no other line intrudes.
 */
export function levelBeside(name: OcrLine, lines: readonly OcrLine[]): number | null {
	const sameRow = (l: OcrLine) => Math.abs(l.box.y + l.box.h / 2 - (name.box.y + name.box.h / 2)) < name.box.h * 0.6;
	for (const line of lines) {
		if (line === name || !sameRow(line) || line.box.x < boxRight(name.box)) continue;
		const level = levelOf(line.text);
		if (level === null) continue;
		const between = lines.some((l) => sameRow(l) && l !== name && l !== line && boxRight(l.box) > boxRight(name.box) && l.box.x < line.box.x);
		if (!between) return level;
	}
	return null;
}
