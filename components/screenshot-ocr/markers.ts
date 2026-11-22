// The acquisition marker after a skill name, read from the shape of its glyph. The text reader writes `◎` and
// `○` as the letters `O` and `0`, so the tier has to come from the pixels. The two differ by the width of their
// hole: `◎` is a thick ring with a small hole, `○` leaves most of its inside empty. Measurements were taken on
// test/ocr-corpus and on a phone capture 1179 px wide, whose rows sit on a gradient.

import type { Box } from './contract';

export type MarkerGlyph = '○' | '◎';

/** Sum of channel differences from the panel colour that still counts as ink. */
export const MARKER_INK_DISTANCE = 60;

/** How far a second panel shade may sit from the first and still count as the panel. A capture may draw
 *  its row on a gradient, whose two ends are close, while glyph ink and its antialiasing are far off. */
export const PANEL_SHADE_REACH = 120;

/** The share of a box a colour needs before it can be one of the panel's shades. */
export const PANEL_SHADE_SHARE = 0.05;

/** The marker's height as a share of the line's own height, outside which the glyph is not the marker. */
export const MIN_MARKER_HEIGHT = 0.35;
export const MAX_MARKER_HEIGHT = 1.15;

/** How round a marker is: a ring is close to 1, a stray stroke or a word fused with a letter is not. */
export const MIN_MARKER_ASPECT = 0.5;
export const MAX_MARKER_ASPECT = 1.9;

/** The blank the game leaves before a marker, as a share of the marker's height. A letter gap is thinner. */
export const MIN_SPACE_BEFORE_MARKER = 0.15;

/** How far past the box's right edge to look, as a share of its height. A box that ends inside the
 *  marker cuts its right wall off, and the reader then draws the remainder as a bracket. The detector also
 *  stops the box short of the marker on some captures, by up to a marker's width, so the reach is a row. */
export const MARKER_REACH = 1.0;

/** The disc around a ring's centre, as a share of its own radius, that tells the two tiers apart: `◎` is
 *  drawn as a thick ring or a ring inside a ring, so its hole is small, while `○` leaves it empty. */
export const INNER_DISC_RADIUS = 0.5;

/** The share of that disc ink has to cover before the glyph is the double tier. */
export const INNER_DISC_INK = 0.15;

const RAYS: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Ink over a box, measured against the colours the box is mostly made of, as `aptitudes.ts` does. */
function inkOf(rgba: Uint8ClampedArray, width: number, x0: number, y0: number, x1: number, y1: number): Uint8Array {
	const w = x1 - x0, h = y1 - y0;
	const ink = new Uint8Array(w * h);
	const counts = new Map<number, number>();
	for (let y = y0; y < y1; y++) {
		for (let x = x0; x < x1; x++) {
			const at = (y * width + x) * 4;
			const key = ((rgba[at] >> 4) << 8) | ((rgba[at + 1] >> 4) << 4) | (rgba[at + 2] >> 4);
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	// Quantised, so compare against each shade's representative. A row drawn on a gradient puts text on
	// two shades, and taking only the commoner one fuses the marker into the other end as ink.
	const shades: [number, number, number][] = [];
	for (const [key, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
		const rgb: [number, number, number] = [((key >> 8) & 15) << 4, ((key >> 4) & 15) << 4, (key & 15) << 4];
		if (!shades.length) { shades.push(rgb); continue; }
		if (n < w * h * PANEL_SHADE_SHARE) break;
		if (shades.some((s) => Math.abs(s[0] - rgb[0]) + Math.abs(s[1] - rgb[1]) + Math.abs(s[2] - rgb[2]) <= PANEL_SHADE_REACH)) shades.push(rgb);
	}
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const at = ((y0 + y) * width + x0 + x) * 4;
			let near = false;
			for (const [pr, pg, pb] of shades) {
				const distance = Math.abs(rgba[at] - pr) + Math.abs(rgba[at + 1] - pg) + Math.abs(rgba[at + 2] - pb);
				if (distance <= MARKER_INK_DISTANCE) { near = true; break; }
			}
			if (!near) ink[y * w + x] = 1;
		}
	}
	return ink;
}

/** One 8-connected piece of ink, with the box it occupies in the line. */
interface Piece {
	ink: Uint8Array;
	w: number;
	h: number;
	left: number;
	top: number;
}

function piecesOf(ink: Uint8Array, w: number, h: number): Piece[] {
	const seen = new Uint8Array(w * h);
	const pieces: Piece[] = [];
	for (let seed = 0; seed < w * h; seed++) {
		if (!ink[seed] || seen[seed]) continue;
		const stack = [seed];
		seen[seed] = 1;
		const pixels: number[] = [];
		while (stack.length) {
			const at = stack.pop()!;
			pixels.push(at);
			const x = at % w, y = (at - x) / w;
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
					const next = ny * w + nx;
					if (ink[next] && !seen[next]) { seen[next] = 1; stack.push(next); }
				}
			}
		}
		let left = w, right = -1, top = h, bottom = -1;
		for (const at of pixels) {
			const x = at % w, y = (at - x) / w;
			if (x < left) left = x;
			if (x > right) right = x;
			if (y < top) top = y;
			if (y > bottom) bottom = y;
		}
		const pw = right - left + 1, ph = bottom - top + 1;
		const crop = new Uint8Array(pw * ph);
		for (const at of pixels) {
			const x = at % w, y = (at - x) / w;
			crop[(y - top) * pw + (x - left)] = 1;
		}
		pieces.push({ ink: crop, w: pw, h: ph, left, top });
	}
	return pieces;
}

/**
 * The marker's glyph: the piece of ink that ends furthest right, together with any piece drawn inside it,
 * which is what the inner ring of `◎` is. Letters sit beside it, never inside it, so they stay out.
 */
function markerPiece(pieces: readonly Piece[]): Piece | null {
	let anchor: Piece | null = null;
	for (const p of pieces) if (!anchor || p.left + p.w > anchor.left + anchor.w) anchor = p;
	if (!anchor) return null;
	const inside = (p: Piece) => p !== anchor
		&& p.left >= anchor.left - 1 && p.top >= anchor.top - 1
		&& p.left + p.w <= anchor.left + anchor.w + 1 && p.top + p.h <= anchor.top + anchor.h + 1;
	const parts = pieces.filter(inside).concat(anchor);
	const left = Math.min(...parts.map((p) => p.left)), top = Math.min(...parts.map((p) => p.top));
	const right = Math.max(...parts.map((p) => p.left + p.w)), bottom = Math.max(...parts.map((p) => p.top + p.h));
	const w = right - left, h = bottom - top;
	const crop = new Uint8Array(w * h);
	for (const p of parts) {
		for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
			if (!p.ink[y * p.w + x]) continue;
			crop[(p.top - top + y) * w + (p.left - left + x)] = 1;
		}
	}
	return { ink: crop, w, h, left, top };
}

/** Blank columns between a piece and whatever ink sits to its left. */
function spaceBefore(ink: Uint8Array, w: number, h: number, left: number): number {
	for (let x = left - 1; x >= 0; x--) {
		for (let y = 0; y < h; y++) if (ink[y * w + x]) return left - 1 - x;
	}
	return left;
}

/** A cross has ink where a ring has its hole. */
function centreIsInk(glyph: Piece): boolean {
	return !!glyph.ink[Math.floor(glyph.h / 2) * glyph.w + Math.floor(glyph.w / 2)];
}

/** How many bands of ink a ray out of the centre crosses, best of eight directions. */
function ringCount(glyph: Piece): number {
	const cx = (glyph.w - 1) / 2, cy = (glyph.h - 1) / 2;
	let best = 0;
	for (const [dx, dy] of RAYS) {
		let runs = 0, on = false;
		for (let step = 1; step <= Math.max(glyph.w, glyph.h); step++) {
			const x = Math.round(cx + dx * step), y = Math.round(cy + dy * step);
			if (x < 0 || y < 0 || x >= glyph.w || y >= glyph.h) break;
			const inked = !!glyph.ink[y * glyph.w + x];
			if (inked && !on) runs++;
			on = inked;
		}
		if (runs > best) best = runs;
	}
	return best;
}

/**
 * The share of the inner disc that ink covers. A ray count cannot answer the tier: a thick ring whose
 * wall carries one pale column crosses two bands, and a capture drawn on a gradient has such columns.
 */
function innerInk(glyph: Piece): number {
	const cx = (glyph.w - 1) / 2, cy = (glyph.h - 1) / 2;
	const limit = (Math.max(glyph.w, glyph.h) / 2) * INNER_DISC_RADIUS;
	let total = 0, dark = 0;
	for (let y = 0; y < glyph.h; y++) {
		for (let x = 0; x < glyph.w; x++) {
			if (Math.hypot(x - cx, y - cy) > limit) continue;
			total++;
			if (glyph.ink[y * glyph.w + x]) dark++;
		}
	}
	return total ? dark / total : 0;
}

/**
 * The marker at the end of a line's box, or null when the pixels do not answer: no glyph there, one the
 * size or shape of a letter, one with nothing but a letter gap before it, or one too broken to count a ring.
 * A box the detector drew around the marker alone has no gap to judge, so `alone` skips that test.
 */
export function markerShape(rgba: Uint8ClampedArray, width: number, box: Box, alone = false): MarkerGlyph | null {
	const height = rgba.length / (width * 4);
	const x0 = Math.max(0, Math.round(box.x)), y0 = Math.max(0, Math.round(box.y));
	const reach = Math.round(box.h * MARKER_REACH);
	const x1 = Math.min(width, Math.round(box.x + box.w) + reach), y1 = Math.min(height, Math.round(box.y + box.h));
	if (x1 <= x0 || y1 <= y0) return null;
	const w = x1 - x0, h = y1 - y0;
	const ink = inkOf(rgba, width, x0, y0, x1, y1);
	const glyph = markerPiece(piecesOf(ink, w, h));
	if (!glyph) return null;
	if (!alone && spaceBefore(ink, w, h, glyph.left) < Math.max(2, Math.round(glyph.h * MIN_SPACE_BEFORE_MARKER))) return null;
	if (glyph.h < box.h * MIN_MARKER_HEIGHT || glyph.h > box.h * MAX_MARKER_HEIGHT) return null;
	if (glyph.w / glyph.h < MIN_MARKER_ASPECT || glyph.w / glyph.h > MAX_MARKER_ASPECT) return null;
	if (centreIsInk(glyph)) return null;
	if (ringCount(glyph) === 0) return null;
	return innerInk(glyph) >= INNER_DISC_INK ? '◎' : '○';
}
