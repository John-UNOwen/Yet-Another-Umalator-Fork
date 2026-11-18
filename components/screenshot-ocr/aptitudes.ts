// Aptitude grades come from the colour the game draws the letter in, never from reading the letter.
// A lone glyph is too small to trust a reader on, and the game already encodes the grade in a colour
// that survives any screenshot: seven letters in seven colours, the eighth drawn without colour.

export type Grade = 'S' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

export const GRADES: readonly Grade[] = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];

/**
 * Hue, in degrees, of each letter as the Global client draws it, measured on the screenshots in
 * test/ocr-corpus. G is absent: it is drawn without colour, so it is what a letter with ink but no
 * hue has to be. A shares its colour with the value words, which is why reading A means noticing
 * that nothing else came out.
 */
export const GRADE_HUES: Record<Exclude<Grade, 'G'>, number> = { S: 44, A: 25, B: 340, C: 107, D: 205, E: 287, F: 247 };

/** Below this many pixels that stand out from the panel, a region holds no letter. */
export const MIN_GLYPH_PIXELS = 140;

/** A letter this poorly coloured is the grey G rather than one of the coloured seven. */
export const MIN_COLOURED_SHARE = 0.3;

/** A hue this far from every anchor is not a grade the game drew here. */
export const MAX_HUE_DISTANCE = 30;

/** How far apart two hue bins have to be to belong to different colours. */
const HUE_CLUSTER_GAP = 15;

export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface LetterStats {
	/** Pixels that stand out from the panel behind them. */
	ink: number;
	/** Mean hue of the coloured ones, or null when none carried colour. */
	hue: number | null;
	/** How much of the ink carried colour at all. */
	coloured: number;
}

/** Mean hue of the largest group of nearby hue bins, so a letter split across two bins still reads as one colour. */
function dominantHue(bins: Map<number, number>): number | null {
	if (!bins.size) return null;
	const sorted = [...bins.keys()].sort((a, b) => a - b);
	let best: { sum: number; count: number } | null = null;
	let start = 0;
	for (let i = 0; i <= sorted.length; i++) {
		if (i < sorted.length && (i === start || sorted[i] - sorted[i - 1] <= HUE_CLUSTER_GAP)) continue;
		let sum = 0, count = 0;
		for (let j = start; j < i; j++) {
			const n = bins.get(sorted[j]) ?? 0;
			sum += sorted[j] * n;
			count += n;
		}
		if (count && (!best || count > best.count)) best = { sum, count };
		start = i;
	}
	// Wrap the ring: the two ends of the scale are neighbours, which is where pink letters live.
	if (sorted.length > 1) {
		const span = sorted[sorted.length - 1] - sorted[0];
		if (360 - span <= HUE_CLUSTER_GAP * 2) {
			let sum = 0, count = 0;
			for (const bin of sorted) {
				const n = bins.get(bin) ?? 0;
				const shifted = bin > 180 ? bin - 360 : bin;
				sum += shifted * n;
				count += n;
			}
			if (count && (!best || count > best.count)) best = { sum, count };
		}
	}
	return best ? ((best.sum / best.count) + 360) % 360 : null;
}

/**
 * What a box holds, measured against the panel behind it. The box has to hold more panel than glyph,
 * which the letter crops do by being about twice as wide as a letter, or the two swap roles.
 */
export function letterStats(rgba: Uint8ClampedArray, width: number, box: Box): LetterStats {
	const empty: LetterStats = { ink: 0, hue: null, coloured: 0 };
	const height = rgba.length / (width * 4);
	const x0 = Math.max(0, Math.round(box.x)), y0 = Math.max(0, Math.round(box.y));
	const x1 = Math.min(width, Math.round(box.x + box.w)), y1 = Math.min(height, Math.round(box.y + box.h));
	if (x1 <= x0 || y1 <= y0) return empty;

	const counts = new Map<number, number>();
	let pixels = 0;
	for (let y = y0; y < y1; y++) {
		for (let x = x0; x < x1; x++) {
			const at = (y * width + x) * 4;
			const key = ((rgba[at] >> 4) << 8) | ((rgba[at + 1] >> 4) << 4) | (rgba[at + 2] >> 4);
			counts.set(key, (counts.get(key) ?? 0) + 1);
			pixels++;
		}
	}
	if (!pixels) return empty;

	let panelKey = 0, mostSeen = 0;
	for (const [key, n] of counts) if (n > mostSeen) { panelKey = key; mostSeen = n; }
	// The panel colour is quantised, so compare against its brightest representative to keep the
	// distance threshold about the same at both ends of the panel's brightness range.
	const panelR = ((panelKey >> 8) & 15) << 4, panelG = ((panelKey >> 4) & 15) << 4, panelB = (panelKey & 15) << 4;

	const hues = new Map<number, number>();
	let ink = 0, coloured = 0;
	for (let y = y0; y < y1; y++) {
		for (let x = x0; x < x1; x++) {
			const at = (y * width + x) * 4;
			const r = rgba[at], g = rgba[at + 1], b = rgba[at + 2];
			if (Math.abs(r - panelR) + Math.abs(g - panelG) + Math.abs(b - panelB) <= 90) continue;
			ink++;
			const rn = r / 255, gn = g / 255, bn = b / 255;
			const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), d = max - min;
			if (d < 0.12) continue;
			coloured++;
			let hue = 0;
			if (max === rn) hue = 60 * (((gn - bn) / d) % 6);
			else if (max === gn) hue = 60 * ((bn - rn) / d + 2);
			else hue = 60 * ((rn - gn) / d + 4);
			if (hue < 0) hue += 360;
			const bin = Math.round(hue);
			hues.set(bin, (hues.get(bin) ?? 0) + 1);
		}
	}
	return { ink, hue: dominantHue(hues), coloured: ink ? coloured / ink : 0 };
}

/** The grade a single region holds, or null when it holds nothing that could be a letter. */
export function gradeOfStats(stats: LetterStats): Grade | null {
	if (stats.ink < MIN_GLYPH_PIXELS) return null;
	if (stats.hue === null || stats.coloured < MIN_COLOURED_SHARE) return 'G';
	let best: Grade | null = null, bestDistance = MAX_HUE_DISTANCE + 1;
	for (const [grade, at] of Object.entries(GRADE_HUES) as [Exclude<Grade, 'G'>, number][]) {
		const d = Math.min(Math.abs(stats.hue - at), 360 - Math.abs(stats.hue - at));
		if (d < bestDistance) { best = grade; bestDistance = d; }
	}
	return best;
}

export interface LetterProbe {
	box: Box;
	/** Where this box sits in the cell, so the review screen can point at what it measured. */
	where: 'blob' | 'gap' | 'word';
}

export interface LetterReading {
	grade: Grade | null;
	confident: boolean;
	/** Where the answer came from, or nothing when the cell could not be read. */
	where: LetterProbe['where'] | 'none';
	/** What the text reader made of the same letter, kept so a disagreement stays visible. */
	seen: Grade | null;
}

/**
 * The letter beside a value word, read from its colour and checked against whatever the text reader
 * saw of it. The probes are tried in order and the first one holding a letter answers: the blob the
 * detector found, else the strip just past the word, else the word's own tail, which can only ever
 * say A because the words are drawn in that colour. Two readers that disagree give no answer.
 */
export function readLetter(rgba: Uint8ClampedArray, width: number, probes: readonly LetterProbe[], seen: Grade | null): LetterReading {
	let colour: { grade: Grade; where: LetterProbe['where'] } | null = null;
	for (const probe of probes) {
		const grade = gradeOfStats(letterStats(rgba, width, probe.box));
		if (grade !== null) { colour = { grade, where: probe.where }; break; }
	}
	if (colour && seen !== null && colour.grade !== seen) return { grade: null, confident: false, where: colour.where, seen };
	if (colour) return { grade: colour.grade, confident: colour.where !== 'word' || seen !== null, where: colour.where, seen };
	if (seen !== null) return { grade: seen, confident: false, where: 'none', seen };
	return { grade: null, confident: false, where: 'none', seen };
}
