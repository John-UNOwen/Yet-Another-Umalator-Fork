// Turns a detection probability map into line boxes. Axis-aligned on purpose: this input is
// horizontal game text with no rotation or perspective, so the general polygon and warp stages of
// DBNet buy nothing here, and a rectangle is all the parser needs.

import { boxBottom, boxRight, verticalOverlap, type Box } from './contract';

export interface DbOptions {
	/** Map values above this are text. From the model's inference.yml. */
	thresh: number;
	/** A component whose mean map value falls below this is noise. From the model's inference.yml. */
	boxThresh: number;
	/** How far DB's unclip step would push the outline out, as the ratio in inference.yml. */
	unclipRatio: number;
	/** Components below this many map pixels are dropped. */
	minArea: number;
	/** Two boxes this far apart vertically are the same text line. */
	rowOverlap: number;
	/** Within a text line, a wider gap than this many text heights starts a new box. Keeps columns apart. */
	maxGapFactor: number;
}

export const DEFAULT_DB: DbOptions = { thresh: 0.2, boxThresh: 0.4, unclipRatio: 1.4, minArea: 12, rowOverlap: 0.5, maxGapFactor: 1.2 };

export interface DbResult {
	/** Line boxes in the map's own pixel space. */
	boxes: Box[];
	/** Boxes before row fusion, kept so threshold tuning can see what the blobs actually looked like. */
	blobs: Box[];
	/** Map pixels that were dropped for a weak mean value, so a caller can tell a thin detection from none. */
	rejected: number;
}

/**
 * `map` is one float per pixel of the detection output, row-major, values 0 to 1.
 * The returned boxes need scaling back to the image by whoever sized the map.
 */
export function boxesFromProbMap(map: Float32Array, mapWidth: number, mapHeight: number, options: Partial<DbOptions> = {}): DbResult {
	const o = { ...DEFAULT_DB, ...options };
	const labels = new Int32Array(mapWidth * mapHeight).fill(-1);
	const boxes: { x0: number; y0: number; x1: number; y1: number; sum: number; area: number }[] = [];
	let next = 0;
	const stack = new Int32Array(mapWidth * mapHeight);

	for (let start = 0; start < map.length; start++) {
		if (labels[start] >= 0 || map[start] <= o.thresh) continue;
		const box = { x0: mapWidth, y0: mapHeight, x1: 0, y1: 0, sum: 0, area: 0 };
		let top = 0;
		stack[top++] = start;
		labels[start] = next;
		while (top > 0) {
			const p = stack[--top];
			const x = p % mapWidth;
			const y = (p / mapWidth) | 0;
			box.x0 = Math.min(box.x0, x);
			box.y0 = Math.min(box.y0, y);
			box.x1 = Math.max(box.x1, x + 1);
			box.y1 = Math.max(box.y1, y + 1);
			box.sum += map[p];
			box.area++;
			if (x > 0 && labels[p - 1] < 0 && map[p - 1] > o.thresh) { labels[p - 1] = next; stack[top++] = p - 1; }
			if (x + 1 < mapWidth && labels[p + 1] < 0 && map[p + 1] > o.thresh) { labels[p + 1] = next; stack[top++] = p + 1; }
			if (y > 0 && labels[p - mapWidth] < 0 && map[p - mapWidth] > o.thresh) { labels[p - mapWidth] = next; stack[top++] = p - mapWidth; }
			if (y + 1 < mapHeight && labels[p + mapWidth] < 0 && map[p + mapWidth] > o.thresh) { labels[p + mapWidth] = next; stack[top++] = p + mapWidth; }
		}
		if (box.area >= o.minArea) boxes.push(box);
		next++;
	}

	// The axis-aligned form of DB's unclip: push each blob out by ratio times area over perimeter,
	// which is how far its outline would move. The raw box is kept because a text height, not an
	// expanded one, is what tells a word space from a column gap.
	const parts: { raw: Box; grown: Box }[] = [];
	let rejected = 0;
	for (const b of boxes) {
		if (b.sum / b.area < o.boxThresh) { rejected += b.area; continue; }
		const w = b.x1 - b.x0;
		const h = b.y1 - b.y0;
		const offset = (o.unclipRatio * b.area) / (2 * (w + h));
		const raw = { x: b.x0, y: b.y0, w, h };
		parts.push({ raw, grown: { x: raw.x - offset, y: raw.y - offset, w: w + 2 * offset, h: h + 2 * offset } });
	}

	const fused = fuseRows(parts, o.rowOverlap, o.maxGapFactor);
	return {
		boxes: fused.map((b) => clampBox(b, mapWidth, mapHeight)),
		blobs: parts.map((p) => clampBox(p.grown, mapWidth, mapHeight)),
		rejected,
	};
}

/** Split a text row where the gap grows past a text height, so two skill columns stay two boxes. */
export function fuseRows(parts: readonly { raw: Box; grown: Box }[], rowOverlap: number, maxGapFactor: number): Box[] {
	const bands: { raw: Box; grown: Box }[][] = [];
	for (const part of [...parts].sort((a, b) => a.raw.y - b.raw.y || a.raw.x - b.raw.x)) {
		const band = bands.find((row) => row.some((r) => verticalOverlap(r.raw, part.raw) >= rowOverlap));
		if (band) band.push(part);
		else bands.push([part]);
	}

	const out: Box[] = [];
	for (const band of bands) {
		let cluster: { raw: Box; grown: Box } | null = null;
		for (const part of band.sort((a, b) => a.raw.x - b.raw.x)) {
			const gap = cluster ? part.raw.x - boxRight(cluster.raw) : Infinity;
			if (cluster && gap <= maxGapFactor * Math.min(cluster.raw.h, part.raw.h)) {
				cluster.raw = hull(cluster.raw, part.raw);
				cluster.grown = hull(cluster.grown, part.grown);
				continue;
			}
			if (cluster) out.push(cluster.grown);
			cluster = { raw: { ...part.raw }, grown: { ...part.grown } };
		}
		if (cluster) out.push(cluster.grown);
	}
	return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

const hull = (a: Box, b: Box): Box => {
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return { x, y, w: Math.max(boxRight(a), boxRight(b)) - x, h: Math.max(boxBottom(a), boxBottom(b)) - y };
};

const clampBox = (b: Box, width: number, height: number): Box => {
	const x = Math.max(0, Math.round(b.x));
	const y = Math.max(0, Math.round(b.y));
	return { x, y, w: Math.max(1, Math.min(width, Math.round(boxRight(b))) - x), h: Math.max(1, Math.min(height, Math.round(boxBottom(b))) - y) };
};
