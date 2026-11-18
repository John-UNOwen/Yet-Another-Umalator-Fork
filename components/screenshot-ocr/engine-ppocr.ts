// The in-house PP-OCR runner. Horizontal game text only, so there is no angle classifier and no perspective warp.

import type { Box, CandidateScore, OcrEngine, OcrLine, Preprocessed } from './contract';
import { boxesFromProbMap } from './db';
import { crop, toCHW } from './preprocess';
import { buildAlphabet, ctcLogScore, decodeGreedy, digitMask, toLogProbs } from './ctc';

/** PaddleOCR decodes BGR, then normalizes with these ImageNet figures for detection. */
const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD = [0.229, 0.224, 0.225];
/** Recognition normalizes to -1..1 instead. */
const REC_MEAN = [0.5, 0.5, 0.5];
const REC_STD = [0.5, 0.5, 0.5];

const REC_HEIGHT = 48;
/** Both det dimensions must divide by 32 or the model's kernels reject the run. Measured on 2026-11-18. */
const DET_STEP = 32;
/** Recognition outputs one frame per this many input columns, so crops round up to it. */
const REC_STEP = 8;
const MAX_REC_WIDTH = 1600;
/** Padding to the left and right of a crop, in crop heights, so a marker or a descender stays inside. */
const CROP_PAD = 0.15;
/** Lines per recognition call. The TensorRT shape table in inference.yml tops out at batch 8. */
const REC_BATCH = 8;

export interface PpOcrUrls {
	/** Loads ort itself. The browser caller does a runtime import of `${BASE_PATH}ocr/ort/ort.wasm.min.js`, which no bundler may resolve. */
	loadOrt: () => Promise<Ort>;
	/** Directory holding ort.wasm.min.js, the ort-wasm-simd-threaded pair and nothing else ort guesses at. */
	ortDir: string;
	detectModel: string;
	recognizeModel: string;
	/** The recognition dictionary, one character per line, in the model's class order. */
	dictChars: readonly string[];
	/** Bytes already fetched, so a Cache Storage hit skips every network read. */
	fetch?: (url: string) => Promise<ArrayBuffer>;
}

interface OrtSession {
	inputNames: readonly string[];
	outputNames: readonly string[];
	run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: readonly number[] }>>;
	release?(): void;
}

export interface Ort {
	env: { wasm: { wasmPaths: string; numThreads: number; proxy: boolean } };
	InferenceSession: { create(model: Uint8Array | string): Promise<OrtSession> };
	Tensor: new (type: string, data: Float32Array, dims: readonly number[]) => unknown;
}

export async function createPpOcrEngine(urls: PpOcrUrls): Promise<OcrEngine> {
	const ort = await urls.loadOrt();
	ort.env.wasm.wasmPaths = urls.ortDir;
	ort.env.wasm.numThreads = 1;
	ort.env.wasm.proxy = false;

	const load = async (url: string) => (urls.fetch ? new Uint8Array(await urls.fetch(url)) : url);
	const detect = await ort.InferenceSession.create(await load(urls.detectModel));
	const recognize = await ort.InferenceSession.create(await load(urls.recognizeModel));
	const alphabet = buildAlphabet(urls.dictChars);
	const digits = digitMask(alphabet.length, alphabet);
	const Tensor = ort.Tensor;

	/** Run detection and return line boxes in the image's own coordinates. */
	const detectLines = async (image: Preprocessed): Promise<Box[]> => {
		const height = Math.max(DET_STEP, Math.round(image.height / DET_STEP) * DET_STEP);
		const width = Math.max(DET_STEP, Math.round(image.width / DET_STEP) * DET_STEP);
		const grown = image.width === width && image.height === height ? image : resizeTo(image, width, height);
		const feed = new Tensor('float32', toCHW(grown.rgba, width, height, DET_MEAN, DET_STD), [1, 3, height, width]);
		const out = await detect.run({ [detect.inputNames[0]]: feed });
		const map = out[detect.outputNames[0]].data;
		const atMap = boxesFromProbMap(map, width, height);
		const sx = image.width / width, sy = image.height / height;
		return atMap.boxes.map((b) => ({ x: b.x * sx, y: b.y * sy, w: b.w * sx, h: b.h * sy }));
	};

	/**
	 * One recognition call. Crops keep their own width inside a batch padded on the right, since
	 * stretching a narrow crop to the batch's widest image squeezes its glyphs and truncates the
	 * decode at the padded frame count.
	 */
	const recognizeBatch = async (crops: { rgba: Uint8ClampedArray; width: number }[]): Promise<{ logProbs: Float32Array; steps: number; classes: number }[]> => {
		const padTo = Math.min(MAX_REC_WIDTH, Math.ceil(Math.max(...crops.map((c) => c.width)) / REC_STEP) * REC_STEP);
		const batch = new Float32Array(crops.length * 3 * REC_HEIGHT * padTo);
		crops.forEach((c, i) => {
			const base = i * 3 * REC_HEIGHT * padTo;
			for (let ch = 0; ch < 3; ch++) {
				const mean = REC_MEAN[ch], std = REC_STD[ch];
				for (let y = 0; y < REC_HEIGHT; y++) {
					const at = base + (ch * REC_HEIGHT + y) * padTo;
					for (let x = 0; x < padTo; x++) {
						// ch 0 is blue: PaddleOCR decodes BGR.
						batch[at + x] = x < c.width ? (c.rgba[(y * c.width + x) * 4 + (2 - ch)] / 255 - mean) / std : 0;
					}
				}
			}
		});
		const out = await recognize.run({ [recognize.inputNames[0]]: new Tensor('float32', batch, [crops.length, 3, REC_HEIGHT, padTo]) });
		const result = out[recognize.outputNames[0]];
		const totalSteps = result.dims[1];
		const classes = result.dims[2];
		return crops.map((c, i) => {
			const steps = Math.min(totalSteps, Math.ceil(c.width / REC_STEP));
			const probs = new Float32Array(steps * classes);
			probs.set(result.data.subarray(i * totalSteps * classes, i * totalSteps * classes + steps * classes));
			return { logProbs: toLogProbs(probs, steps, classes), steps, classes };
		});
	};

	/** A box crop at the model's height, width proportional, so no glyph is squashed or lost. */
	const cropOf = (image: Preprocessed, box: Box) => {
		const pad = Math.round(box.h * CROP_PAD);
		const cut = crop(image.rgba, image.width, image.height, box, pad);
		const width = Math.max(REC_STEP * 4, Math.min(MAX_REC_WIDTH, Math.round(cut.width * (REC_HEIGHT / cut.height))));
		const out = new Uint8ClampedArray(width * REC_HEIGHT * 4);
		for (let y = 0; y < REC_HEIGHT; y++) {
			const sy = Math.min(cut.height - 1, Math.floor(((y + 0.5) * cut.height) / REC_HEIGHT));
			for (let x = 0; x < width; x++) {
				const sx = Math.min(cut.width - 1, Math.floor((x * cut.width) / width));
				const from = (sy * cut.width + sx) * 4;
				const to = (y * width + x) * 4;
				for (let c = 0; c < 4; c++) out[to + c] = cut.rgba[from + c];
			}
		}
		return { rgba: out, width };
	};

	return {
		id: 'ppocrv6-tiny',
		detect: detectLines,
		async read(image, boxes) {
			const lines: OcrLine[] = [];
			for (let i = 0; i < boxes.length; i += REC_BATCH) {
				const slice = boxes.slice(i, i + REC_BATCH);
				const frames = await recognizeBatch(slice.map((b) => cropOf(image, b)));
				slice.forEach((box, k) => {
					const { text, score } = decodeGreedy(frames[k].logProbs, frames[k].steps, frames[k].classes, alphabet);
					lines.push({ text, score, box });
				});
			}
			return lines;
		},
		async readDigits(image, box) {
			const [one] = await recognizeBatch([cropOf(image, box)]);
			return decodeGreedy(one.logProbs, one.steps, one.classes, alphabet, digits).text;
		},
		async scoreKeys(image, box, keys) {
			const [one] = await recognizeBatch([cropOf(image, box)]);
			return keys
				.map((key) => ({ key, score: ctcLogScore(one.logProbs, one.steps, one.classes, key, alphabet) }))
				.sort((a, b) => b.score - a.score);
		},
		dispose() {
			detect.release?.();
			recognize.release?.();
		},
	};
}

/** Resize to an exact size, keeping the RGBA rows flat. */
function resizeTo(image: Preprocessed, width: number, height: number): { rgba: Uint8ClampedArray; width: number; height: number } {
	const out = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		const sy = Math.min(image.height - 1, Math.floor(((y + 0.5) * image.height) / height));
		for (let x = 0; x < width; x++) {
			const sx = Math.min(image.width - 1, Math.floor(((x + 0.5) * image.width) / width));
			const from = (sy * image.width + sx) * 4;
			const to = (y * width + x) * 4;
			out[to] = image.rgba[from];
			out[to + 1] = image.rgba[from + 1];
			out[to + 2] = image.rgba[from + 2];
			out[to + 3] = 255;
		}
	}
	return { rgba: out, width, height };
}

export { buildAlphabet };
