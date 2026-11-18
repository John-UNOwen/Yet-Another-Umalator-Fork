// One screenshot of the details dialog, and what it says about one uma. Each measurement lives in the
// module that can be tested on its own, so this only decides which box to ask about, and what a second
// reader that disagrees is worth.

import type { Box, OcrEngine, OcrLine, Preprocessed } from './contract';
import { GRADES, readLetter } from './aptitudes';
import type { Grade } from './aptitudes';
import { aptitudeCells, header, letterProbes, levelBeside, statColumns, statNumberLine, uniqueLevel } from './layout';
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

/**
 * One screenshot, read. The stat numbers come from the line text because the detector glues the rank
 * badge to them and some captures draw the digits in colour, so the digit-only reader is a check on the
 * text value rather than its owner: when it disagrees the value stands and the note says so.
 */
export async function scanScreen(engine: OcrEngine, image: Preprocessed, names: readonly NameEntry[]): Promise<ScanResult> {
	const lines = await engine.read(image, await engine.detect(image));
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

	// The reader draws `◎` and `○` alike, so a marker whose letter could be either is measured as a glyph.
	const markerOnRow = (line: OcrLine): ReadMarker | null => {
		if (!markerOf(line.text).uncertain) return null;
		const glyph = markerShape(image.rgba, image.width, line.box);
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
