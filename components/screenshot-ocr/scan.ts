// One screenshot of the details dialog, and what it says about one uma. Each measurement lives in the
// module that can be tested on its own, so this only decides which box to ask about, and what a second
// reader that disagrees is worth.

import type { Box, OcrEngine, OcrLine, Preprocessed } from './contract';
import { GRADES, readLetter } from './aptitudes';
import type { Grade } from './aptitudes';
import { aptitudeCells, header, letterProbes, levelBeside, markerBeside, statColumns, statNumberLine, uniqueLevel } from './layout';
import type { AptitudeKey, StatKey } from './layout';
import { skillReads, markerOf } from './matcher';
import type { NameEntry, ReadMarker } from './matcher';
import { markerShape } from './markers';
import type { Read, SkillRead } from './merge';
import { maskedAgrees, numberFromText, readNumber } from './stats';

export interface StatNote {
	stat: StatKey;
	/** The line the value was taken from, with the rank badge still glued to it. */
	text: string;
	/** What the digit-only reader decoded from the same box. */
	masked: string[];
	/** Whether that reader saw the same number. It often cannot: some captures draw the digits in colour. */
	agreed: boolean;
}

export interface ScanResult {
	read: Read;
	/** Every line the engine read, boxes mapped back onto the screenshot the user uploaded. */
	lines: OcrLine[];
	/** How much larger the image the engine worked on was, so a crop can be cut from either copy. */
	scale: number;
	statNotes: StatNote[];
}

/** The letter the text reader saw beside a value word. */
function letterSeen(text: string | undefined): Grade | null {
	if (!text) return null;
	const tail = text.trim().slice(-1).toUpperCase();
	return (GRADES as readonly string[]).includes(tail) ? (tail as Grade) : null;
}

/** A box back from the image the engine worked on to the one the user took. */
function at(box: Box, scale: number): Box {
	return scale === 1 ? box : { x: box.x / scale, y: box.y / scale, w: box.w / scale, h: box.h / scale };
}

/** Lines back from the image the engine worked on to the one the user took. */
function unscale(lines: readonly OcrLine[], scale: number): OcrLine[] {
	return scale === 1 ? [...lines] : lines.map((l) => ({ ...l, box: at(l.box, scale) }));
}

/** A box this many times the screen's usual line height holds two printed lines, not one. */
const TWO_LINE_HEIGHT = 1.5;

/** A row this far below the box's boldest row in contrast is blank, so the two lines part there. */
const BLANK_ROW_SHARE = 0.55;

/** Contrast a blank row may still carry, which is the panel's gradient and compression noise. */
const BLANK_ROW_FLOOR = 32;

/** The height most of this screen's text lines have. A box over two of them is that much taller. */
function usualLineHeight(lines: readonly OcrLine[]): number {
	const heights = lines.filter((l) => l.box.w > l.box.h * 1.3).map((l) => l.box.h).sort((a, b) => a - b);
	return heights.length ? heights[Math.floor(heights.length / 2)] : 0;
}

/** Where the two printed lines of a tall box part, or null when no blank band sits across its middle. */
function partingRow(image: Preprocessed, box: Box): number | null {
	const x0 = Math.max(0, Math.round(box.x)), x1 = Math.min(image.width, Math.round(box.x + box.w));
	const y0 = Math.max(0, Math.round(box.y)), y1 = Math.min(image.height, Math.round(box.y + box.h));
	if (x1 - x0 < 4 || y1 - y0 < 8) return null;
	const spread: number[] = [];
	for (let y = y0; y < y1; y++) {
		let lo = 255, hi = 0;
		for (let x = x0; x < x1; x++) {
			const at = (y * image.width + x) * 4;
			const lum = (image.rgba[at] + image.rgba[at + 1] + image.rgba[at + 2]) / 3;
			if (lum < lo) lo = lum;
			if (lum > hi) hi = lum;
		}
		spread.push(hi - lo);
	}
	const blank = Math.max(BLANK_ROW_FLOOR, Math.max(...spread) * BLANK_ROW_SHARE);
	let band: [number, number] | null = null;
	for (let i = 0; i < spread.length; i++) {
		if (spread[i] > blank) continue;
		let j = i;
		while (j + 1 < spread.length && spread[j + 1] <= blank) j++;
		const middle = (i + j) / 2 / spread.length;
		if (middle > 0.25 && middle < 0.75 && (!band || j - i > band[1] - band[0])) band = [i, j];
		i = j;
	}
	if (!band) return null;
	const cut = y0 + Math.round((band[0] + band[1]) / 2);
	return cut - y0 >= box.h * 0.25 && y1 - cut >= box.h * 0.25 ? cut : null;
}

/** The two boxes a wrapped name hides in, or null when the box holds one line. */
function wrappedParts(image: Preprocessed, line: OcrLine, usual: number): [Box, Box] | null {
	if (!usual || line.box.h < usual * TWO_LINE_HEIGHT) return null;
	if (line.box.w <= line.box.h * 1.3) return null;
	const cut = partingRow(image, line.box);
	if (cut === null) return null;
	return [{ ...line.box, h: cut - line.box.y }, { ...line.box, y: cut, h: line.box.y + line.box.h - cut }];
}

/**
 * Every line on the screen, with a box the detector drew over a wrapped name read again in halves. The
 * matcher already joins a name that arrives as two lines, so splitting it here is what lets it join.
 */
async function readLines(engine: OcrEngine, image: Preprocessed): Promise<OcrLine[]> {
	const lines = await engine.read(image, await engine.detect(image));
	const usual = usualLineHeight(lines);
	const out: OcrLine[] = [];
	for (const line of lines) {
		const parts = wrappedParts(image, line, usual);
		if (!parts) { out.push(line); continue; }
		const again = (await engine.read(image, parts)).filter((l) => l.text.trim() !== '');
		if (again.length) out.push(...again);
		else out.push(line);
	}
	return out;
}

/**
 * One screenshot, read. The stat numbers come from the line text because the detector glues the rank
 * badge to them and some captures draw the digits in colour, so the digit-only reader is a check on the
 * text value rather than its owner: when it disagrees the value stands and the note says so.
 */
export async function scanScreen(engine: OcrEngine, image: Preprocessed, names: readonly NameEntry[]): Promise<ScanResult> {
	const lines = await readLines(engine, image);
	const digits = (crop: Preprocessed) => engine.readDigits(crop, { x: 0, y: 0, w: crop.width, h: crop.height });

	const stats = {} as Partial<Record<StatKey, number>>;
	const statNotes: StatNote[] = [];
	for (const column of statColumns(lines)) {
		const line = statNumberLine(lines, column);
		if (!line) continue;
		const value = numberFromText(line.text).value;
		if (value === null) continue;
		const masked = await readNumber(image, line.box, digits);
		stats[column.label] = value;
		statNotes.push({ stat: column.label, text: line.text, masked: masked.seen, agreed: maskedAgrees(masked.seen, value) });
	}

	const aptitudes = {} as Partial<Record<AptitudeKey, Grade>>;
	for (const cell of aptitudeCells(lines)) {
		const reading = readLetter(image.rgba, image.width, letterProbes(cell), letterSeen(cell.letter?.text));
		if (reading.grade !== null) aptitudes[cell.key] = reading.grade;
	}

	// The reader draws `◎` and `○` alike, and sometimes drops the marker or boxes it on its own, so a
	// marker the text did not name is measured: first where the name ends, then in a box of its own.
	const markerOnRow = (line: OcrLine): ReadMarker | null => {
		if (markerOf(line.text).glyph) return null;
		const own = markerShape(image.rgba, image.width, line.box);
		if (own) return { glyph: own, uncertain: false };
		const beside = markerBeside(line, lines);
		const glyph = beside ? markerShape(image.rgba, image.width, beside.box, true) : null;
		return glyph ? { glyph, uncertain: false } : null;
	};
	const skills: SkillRead[] = skillReads(lines, names, {}, levelBeside, markerOnRow).map((s) => ({ ...s, box: s.box ? at(s.box, image.scale) : undefined }));
	const head = header(lines);
	const level = uniqueLevel(lines);

	return {
		read: {
			stats,
			aptitudes,
			skills,
			name: head.name ?? undefined,
			epithet: head.epithet ?? undefined,
			uniqueLevel: level ?? undefined,
		},
		lines: unscale(lines, image.scale),
		scale: image.scale,
		statNotes,
	};
}
