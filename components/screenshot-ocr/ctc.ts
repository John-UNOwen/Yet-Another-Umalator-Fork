// CTC decoding over the recognition model's output frames. Pure numbers, so a Node test can drive
// it with hand-made frames and no wasm.

/**
 * The class order the export was trained with: blank first, then the dictionary in file order, then
 * one trailing class. PaddleOCR's CTCLabelDecode puts a blank at the head and appends a plain space
 * at the tail unless the dictionary already names one, which ours does not (its space is U+3000). An
 * empty string marks a class the dictionary never named.
 */
export function buildAlphabet(dictChars: readonly string[]): string[] {
	return ['', ...dictChars, dictChars.includes(' ') ? '' : ' '];
}

const BLANK = 0;

/**
 * The PP-OCR exports end in Softmax, so their frames are already probabilities and only need a log.
 * Anything else is logits, which need normalizing. The first frame decides which, and a zero is
 * floored so a forward pass never produces NaN.
 */
export function toLogProbs(frames: Float32Array, steps: number, classes: number): Float32Array {
	let sum = 0;
	for (let c = 0; c < classes; c++) sum += frames[c];
	if (Math.abs(sum - 1) > 0.05) return logSoftmax(frames, steps, classes);
	const out = new Float32Array(frames.length);
	for (let i = 0; i < frames.length; i++) out[i] = Math.log(Math.max(frames[i], 1e-12));
	return out;
}

/** Turns logits of shape [T, C] into log probabilities, in place on a copy. */
export function logSoftmax(frames: Float32Array, steps: number, classes: number): Float32Array {
	const out = new Float32Array(frames.length);
	for (let t = 0; t < steps; t++) {
		const row = t * classes;
		let max = -Infinity;
		for (let c = 0; c < classes; c++) max = Math.max(max, frames[row + c]);
		let sum = 0;
		for (let c = 0; c < classes; c++) sum += Math.exp(frames[row + c] - max);
		const norm = max + Math.log(sum);
		for (let c = 0; c < classes; c++) out[row + c] = frames[row + c] - norm;
	}
	return out;
}

export interface GreedyResult {
	text: string;
	/** Mean probability of the emitted characters. A line with no emission reads as empty with score 0. */
	score: number;
}

/** Best class per frame, runs collapsed, blank dropped. */
export function decodeGreedy(logProbs: Float32Array, steps: number, classes: number, alphabet: readonly string[], mask?: Uint8Array): GreedyResult {
	let text = '';
	let sum = 0;
	let count = 0;
	let previous = BLANK;
	for (let t = 0; t < steps; t++) {
		const row = t * classes;
		let best = -Infinity;
		let bestClass = BLANK;
		for (let c = 0; c < classes; c++) {
			if (mask && !mask[c]) continue;
			if (logProbs[row + c] > best) { best = logProbs[row + c]; bestClass = c; }
		}
		if (bestClass === BLANK) { previous = BLANK; continue; }
		if (bestClass === previous) continue;
		previous = bestClass;
		const ch = alphabet[bestClass];
		if (!ch) continue;
		text += ch;
		sum += Math.exp(best);
		count++;
	}
	return { text, score: count ? sum / count : 0 };
}

/** Classes for the ten digits, which is all the stat read may decode. */
export function digitMask(classes: number, alphabet: readonly string[]): Uint8Array {
	const mask = new Uint8Array(classes);
	for (let c = 0; c < classes; c++) mask[c] = alphabet[c] >= '0' && alphabet[c] <= '9' ? 1 : 0;
	return mask;
}

export function classesOf(key: string, alphabet: readonly string[]): number[] {
	const out: number[] = [];
	for (const ch of key) {
		const at = alphabet.indexOf(ch);
		if (at > 0) out.push(at);
	}
	return out;
}

const logAdd = (a: number, b: number) => (a === -Infinity ? b : b === -Infinity ? a : Math.max(a, b) + Math.log1p(Math.exp(-Math.abs(a - b))));

/**
 * CTC forward algorithm: the log probability that these frames generated `key` through any
 * alignment. Comparing candidates this way beats comparing them to one greedy string, because a
 * single misread character only costs the frames that produced it.
 */
export function ctcLogScore(logProbs: Float32Array, steps: number, classes: number, key: string, alphabet: readonly string[]): number {
	const label = classesOf(key, alphabet);
	if (!label.length) return -Infinity;
	const states = label.length * 2 + 1;
	const classOf = (s: number) => (s % 2 === 0 ? BLANK : label[(s - 1) >> 1]);
	let alpha = new Float64Array(states).fill(-Infinity);
	let nextAlpha = new Float64Array(states).fill(-Infinity);
	// Before any frame, the alignment sits on the leading blank with probability 1.
	alpha[0] = 0;
	for (let t = 0; t < steps; t++) {
		nextAlpha.fill(-Infinity);
		const row = t * classes;
		for (let s = 0; s < states; s++) {
			const emission = logProbs[row + classOf(s)];
			let best = alpha[s];
			if (s > 0) best = logAdd(best, alpha[s - 1]);
			// A repeated character may only skip the blank between the two copies when the labels differ.
			if (s > 1 && classOf(s) !== classOf(s - 2)) best = logAdd(best, alpha[s - 2]);
			nextAlpha[s] = best === -Infinity ? -Infinity : best + emission;
		}
		const swap = alpha;
		alpha = nextAlpha;
		nextAlpha = swap;
	}
	return logAdd(alpha[states - 1], alpha[states - 2]);
}
