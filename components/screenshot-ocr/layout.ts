// The aptitude block of the details dialog, found by the words it is built from. Their positions
// vary with screen size and how the game was scrolled, so nothing here is a fixed coordinate.

import type { Box, OcrLine } from './contract';
import type { LetterProbe } from './aptitudes';

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
