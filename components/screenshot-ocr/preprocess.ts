// Pixel work for the worker, kept free of engine calls so a Node test can drive it.

import type { Box, Preprocessed } from './contract';

export interface Gray {
	width: number;
	height: number;
	/** One byte per pixel. */
	luma: Uint8ClampedArray;
}

const lumaOf = (r: number, g: number, b: number) => (r * 77 + g * 151 + b * 28) >> 8;

export function toGray(rgba: Uint8ClampedArray, width: number, height: number): Gray {
	const luma = new Uint8ClampedArray(width * height);
	for (let i = 0, p = 0; i < luma.length; i++, p += 4) luma[i] = lumaOf(rgba[p], rgba[p + 1], rgba[p + 2]);
	return { width, height, luma };
}

/**
 * Ink where the brightest channel is below the cut. Game text is dark on a pale panel, so the max
 * channel follows ink shape without letting a coloured background swallow it.
 */
export function binarize(rgba: Uint8ClampedArray, width: number, height: number, cut = 170): Uint8Array {
	const mask = new Uint8Array(width * height);
	for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
		mask[i] = Math.max(rgba[p], rgba[p + 1], rgba[p + 2]) < cut ? 1 : 0;
	}
	return mask;
}

export const binarizeGray = (gray: Gray, cut = 170): Uint8Array => {
	const mask = new Uint8Array(gray.width * gray.height);
	for (let i = 0; i < mask.length; i++) mask[i] = gray.luma[i] < cut ? 1 : 0;
	return mask;
};

/** Bilinear resize of RGBA rows. `scale` is the factor relative to the source, and a scale of 1 copies. */
export function resize(rgba: Uint8ClampedArray, width: number, height: number, scale: number): { rgba: Uint8ClampedArray; width: number; height: number } {
	if (scale === 1) return { rgba, width, height };
	const w = Math.max(1, Math.round(width * scale));
	const h = Math.max(1, Math.round(height * scale));
	const out = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++) {
		const sy = Math.min(height - 1, (y + 0.5) / scale - 0.5);
		const y0 = Math.max(0, Math.floor(sy));
		const y1 = Math.min(height - 1, y0 + 1);
		const fy = Math.max(0, Math.min(1, sy - y0));
		for (let x = 0; x < w; x++) {
			const sx = Math.min(width - 1, (x + 0.5) / scale - 0.5);
			const x0 = Math.max(0, Math.floor(sx));
			const x1 = Math.min(width - 1, x0 + 1);
			const fx = Math.max(0, Math.min(1, sx - x0));
			for (let c = 0; c < 4; c++) {
				const a = rgba[(y0 * width + x0) * 4 + c];
				const b = rgba[(y0 * width + x1) * 4 + c];
				const cc = rgba[(y1 * width + x0) * 4 + c];
				const d = rgba[(y1 * width + x1) * 4 + c];
				out[(y * w + x) * 4 + c] = a + (b - a) * fx + (cc - a) * fy + (a - b - cc + d) * fx * fy;
			}
		}
	}
	return { rgba: out, width: w, height: h };
}

/** A box crop, padded outward so a descender or a circle marker never gets its edge cut. */
export function crop(rgba: Uint8ClampedArray, width: number, height: number, box: Box, pad = 0): { rgba: Uint8ClampedArray; width: number; height: number } {
	const x = Math.max(0, Math.floor(box.x - pad));
	const y = Math.max(0, Math.floor(box.y - pad));
	const w = Math.min(width, Math.ceil(boxRightOf(box) + pad)) - x;
	const h = Math.min(height, Math.ceil(boxBottomOf(box) + pad)) - y;
	const out = new Uint8ClampedArray(w * h * 4);
	for (let row = 0; row < h; row++) {
		const from = ((y + row) * width + x) * 4;
		out.set(rgba.subarray(from, from + w * 4), row * w * 4);
	}
	return { rgba: out, width: w, height: h };
}

const boxRightOf = (b: Box) => b.x + b.w;
const boxBottomOf = (b: Box) => b.y + b.h;

/**
 * CHW float plan for the models. Both PP-OCR stages take blue first because PaddleOCR decodes as
 * BGR, so feeding RGB silently costs accuracy on coloured panels.
 */
export function toCHW(rgba: Uint8ClampedArray, width: number, height: number, mean: readonly number[], std: readonly number[]): Float32Array {
	const plane = width * height;
	const out = new Float32Array(plane * 3);
	for (let i = 0, p = 0; i < plane; i++, p += 4) {
		for (let c = 0; c < 3; c++) {
			// c 0 is blue, matching the channel order the exports were trained on.
			const src = rgba[p + (2 - c)];
			out[c * plane + i] = (src / 255 - mean[c]) / std[c];
		}
	}
	return out;
}

/** Grow the screenshot toward `targetWidth` for the detection pass, capped so memory stays sane on a phone. */
export function preprocess(image: Preprocessed, targetWidth = 1000, maxScale = 2): Preprocessed {
	const wanted = targetWidth / image.width;
	const scale = Math.min(Math.max(wanted, 1), maxScale);
	if (scale === 1) return image;
	const grown = resize(image.rgba, image.width, image.height, scale);
	return { ...grown, scale: image.scale * scale };
}
