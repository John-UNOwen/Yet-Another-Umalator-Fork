// The one interface between an OCR engine and the parser. The parser takes boxes and text, so the
// engine stays a swappable detail. Coordinates are pixels in the image the engine was given.

export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface OcrLine {
	text: string;
	/** Mean probability the decoder assigned to the emitted characters, 0 to 1. */
	score: number;
	box: Box;
}

export interface CandidateScore {
	key: string;
	/** Log probability that the line's frames generated this key, so higher is better and the values are never above 0. */
	score: number;
}

export interface Preprocessed {
	width: number;
	height: number;
	/** RGBA rows, top to bottom. */
	rgba: Uint8ClampedArray;
	/** How much larger this is than the screenshot the user took, so boxes can be mapped back. */
	scale: number;
}

export interface OcrEngine {
	readonly id: string;
	/** Line boxes only, in reading order, top to bottom then left to right. */
	detect(image: Preprocessed): Promise<Box[]>;
	/** Greedy decode of each crop. Boxes the model finds empty of text come back with an empty string. */
	read(image: Preprocessed, boxes: readonly Box[]): Promise<OcrLine[]>;
	/** Digits only: the decode is masked to the ten digit classes, so a stray letter cannot slip in. */
	readDigits(image: Preprocessed, box: Box): Promise<string>;
	/** Scores each key against the line's frames, best first. This is how a skill name becomes a database id. */
	scoreKeys(image: Preprocessed, box: Box, keys: readonly string[]): Promise<CandidateScore[]>;
	dispose(): void;
}

export const boxRight = (b: Box) => b.x + b.w;
export const boxBottom = (b: Box) => b.y + b.h;
export const boxCenterY = (b: Box) => b.y + b.h / 2;

/** How much two boxes overlap vertically, as a fraction of the shorter height. Two lines of one row overlap near 1. */
export function verticalOverlap(a: Box, b: Box): number {
	const shared = Math.min(boxBottom(a), boxBottom(b)) - Math.max(a.y, b.y);
	return shared <= 0 ? 0 : shared / Math.min(a.h, b.h);
}
