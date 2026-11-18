// Stat numbers are read from a crop the layout chose, with the CTC output masked to digits, over a
// ladder of preprocessing variants whose values are voted on. A value of an unexpected length cannot
// win, which is what keeps a rank badge out of the answer.

import { binarize, crop, maskToRgba, resize } from './preprocess';
import type { Box, Preprocessed } from './contract';

/** One preprocessing try: `cut` binarizes ink below that channel value, `scale` magnifies the crop. */
export interface Ladder {
	cut: number | null;
	scale: number;
}

/**
 * Three tries at most, as the plan budgets them. The first leaves the crop as the screenshot has it,
 * since the recognizer was trained on antialiased text. The other two trade that for more pixels and
 * a harder decision about what counts as ink.
 */
export const STAT_LADDER: readonly Ladder[] = [
	{ cut: null, scale: 1 },
	{ cut: 185, scale: 2 },
	{ cut: 200, scale: 2 },
];

/** A stat number on screen has this many digits. Anything else is a badge or a fragment. */
export const MIN_DIGITS = 2;
export const MAX_DIGITS = 4;

/** Recognition of one crop, masked to digits. The engine supplies this, so the ladder can be tested without it. */
export type Digits = (crop: Preprocessed) => Promise<string>;

export interface NumberReading {
	value: number | null;
	/** How many variants produced the winning value. One means nothing agreed. */
	agreed: number;
	/** How many variants ran. */
	attempts: number;
	/** What each variant decoded, in ladder order, for the review screen. */
	seen: string[];
}

/** A decoded string as a number, only if it is digits and of an expected length. */
export function parseNumber(text: string): number | null {
	const digits = text.trim();
	if (!/^\d+$/.test(digits) || digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null;
	return Number(digits);
}

/** The value the most variants agreed on. A winner of one is reported, not hidden, so callers can ask. */
export function vote(values: readonly (number | null)[]): { value: number | null; agreed: number } {
	const counts = new Map<number, number>();
	for (const v of values) if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
	let value: number | null = null, agreed = 0;
	for (const [v, n] of counts) if (n > agreed) { value = v; agreed = n; }
	return { value, agreed };
}


/** What a stat on the details dialog can show, so an extra badge digit inside the number is visible. */
export const MIN_STAT = 100;
export const MAX_STAT = 3000;

/**
 * The number inside the text of a line the reader produced, where a rank badge may sit in front of it.
 * The badge is drawn as a letter, so an unmasked reading keeps it apart from the digits, and a run too
 * long to be a stat says which side of a glued pair the extra digit came from.
 */
export function numberFromText(text: string): { value: number | null; candidates: number[] } {
	const candidates: number[] = [];
	const inRange = (digits: string) => (digits.length >= 2 && +digits >= MIN_STAT && +digits <= MAX_STAT ? +digits : null);
	for (const run of text.match(/\d+/g) ?? []) {
		const direct = inRange(run);
		if (direct !== null) { if (!candidates.includes(direct)) candidates.push(direct); continue; }
		// One digit too many: drop the leading one first, since that is where the badge sits.
		const dropped = inRange(run.slice(1)) ?? inRange(run.slice(0, -1));
		if (dropped !== null && !candidates.includes(dropped)) candidates.push(dropped);
	}
	return { value: candidates.length === 1 ? candidates[0] : null, candidates };
}

/**
 * Whether a digit masked reading of the crop contains a number in any of the ladder's variants. The
 * mask lets a badge shape through as a digit, so this is agreement that the number was seen, not that
 * nothing else was.
 */
export function maskedAgrees(seen: readonly string[], value: number): boolean {
	const digits = String(value);
	return seen.some((text) => text.replace(/\D/g, '').includes(digits));
}

/** One crop at one ladder setting, ready for recognition. */
export function ladderCrop(image: Preprocessed, box: Box, rung: Ladder): Preprocessed {
	const pad = Math.round(box.h * 0.1);
	const taken = crop(image.rgba, image.width, image.height, box, pad);
	const ink = rung.cut === null ? taken : maskToRgba(binarize(taken.rgba, taken.width, taken.height, rung.cut), taken.width, taken.height);
	const grown = resize(ink.rgba, ink.width, ink.height, rung.scale);
	return { width: grown.width, height: grown.height, rgba: grown.rgba, scale: image.scale * rung.scale };
}

/**
 * The number in a box, tried over the ladder and voted on.
 * `box` is in the image's own coordinates.
 */
export async function readNumber(image: Preprocessed, box: Box, digits: Digits, ladder: readonly Ladder[] = STAT_LADDER): Promise<NumberReading> {
	const seen: string[] = [];
	const values: (number | null)[] = [];
	for (const rung of ladder) {
		const text = await digits(ladderCrop(image, box, rung));
		seen.push(text);
		values.push(parseNumber(text));
	}
	const { value, agreed } = vote(values);
	return { value, agreed, attempts: ladder.length, seen };
}
