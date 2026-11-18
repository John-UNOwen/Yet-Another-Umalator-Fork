/**
 * Marker shape tests on painted glyphs. The three tiers differ by rings the text reader cannot see, so the
 * test paints them and checks which tier the pixels answer with, including the shapes that answer nothing.
 * A marker always sits after a name, with the panel behind both.
 *
 * Run via: npm run test:ocr
 */
import test from 'tape';
import { markerShape } from './markers';
import type { Box } from './contract';

const PANEL: [number, number, number] = [28, 30, 42];
const INK: [number, number, number] = [236, 232, 224];

const WIDTH = 160, HEIGHT = 30;
/** The line's box, as the detector would give it for a name and its marker. */
const LINE: Box = { x: 0, y: 0, w: WIDTH, h: HEIGHT };
/** Where the marker sits: the name's letters end well to the left of it. */
const CX = 142, CY = 15;

type Shape = (x: number, y: number) => boolean;

const distance = (x: number, y: number, cx: number, cy: number) => Math.hypot(x - cx, y - cy);

/** A ring band from `inner` to `outer` pixels around a centre. */
const ring = (inner: number, outer: number, cx = CX, cy = CY): Shape => (x, y) => {
	const d = distance(x, y, cx, cy);
	return d >= inner && d <= outer;
};

/** A filled block, which is what a name's letters or a stray badge look like. */
const block = (x0: number, y0: number, w: number, h: number): Shape => (x, y) => x >= x0 && x < x0 + w && y >= y0 && y < y0 + h;

const anyOf = (shapes: Shape[]): Shape => (x, y) => shapes.some((s) => s(x, y));

function canvasWith(shapes: Shape[], box = LINE) {
	const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
	for (let i = 0; i < WIDTH * HEIGHT; i++) {
		rgba[i * 4] = PANEL[0]; rgba[i * 4 + 1] = PANEL[1]; rgba[i * 4 + 2] = PANEL[2]; rgba[i * 4 + 3] = 255;
	}
	const drawn = anyOf(shapes);
	for (let y = 0; y < HEIGHT; y++) {
		for (let x = 0; x < WIDTH; x++) {
			if (!drawn(x, y)) continue;
			const at = (y * WIDTH + x) * 4;
			rgba[at] = INK[0]; rgba[at + 1] = INK[1]; rgba[at + 2] = INK[2];
		}
	}
	return { rgba, width: WIDTH, box };
}

/** A name drawn as three letter blocks, ending far enough left to leave the marker its space. */
const NAME: Shape[] = [block(20, 6, 6, 18), block(32, 6, 6, 18), block(44, 6, 6, 18)];

const read = (shapes: Shape[], box = LINE) => markerShape(canvasWith(shapes, box).rgba, WIDTH, box);

test('a ring after a name is the single tier', (t) => {
	t.equal(read([...NAME, ring(6, 9)]), '○', 'one ring of ink with a hole in it');
	t.end();
});

test('a ring inside a ring is the double tier', (t) => {
	t.equal(read([...NAME, ring(2, 4), ring(6, 9)]), '◎', 'two rings of ink, so two bands crossed from the centre');
	t.end();
});

test('the tiers keep their answer at the sizes the dialog draws them', (t) => {
	// The five corpus captures draw the glyph 18 to 23 px across with a 3 px wall, on a 30 px line.
	for (const [outer, thickness, want] of [[9, 3, '○'], [11, 3, '○'], [9, 2, '○']] as [number, number, string][]) {
		t.equal(read([...NAME, ring(outer - thickness, outer)]), want, `${outer * 2}px ring with a ${thickness}px wall`);
	}
	// The two rings stay separate: a panel pixel's width between them, as the game draws them.
	for (const [innerFrom, innerTo, outerFrom, outerTo] of [[3, 5, 8, 11], [3, 4, 6, 9], [2, 3, 6, 8]] as [number, number, number, number][]) {
		t.equal(read([...NAME, ring(innerFrom, innerTo), ring(outerFrom, outerTo)]), '◎', `ring ${outerFrom * 2} to ${outerTo * 2}px wide with an inner ring`);
	}
	t.end();
});

test('a glyph with ink in its middle is no tier', (t) => {
	const cross: Shape = (x, y) => Math.abs(x - CX - (y - CY)) < 3 || Math.abs(x - CX + (y - CY)) < 3;
	t.equal(read([...NAME, cross]), null, 'a cross, which is the third tier and never asked about here');
	t.equal(read([...NAME, block(CX - 8, CY - 8, 17, 17)]), null, 'a filled square');
	t.end();
});

test('a ring missing a piece is still one ring', (t) => {
	const gap = (x: number, y: number) => x > CX + 4 && Math.abs(y - CY) < 2;
	const broken = (x: number, y: number) => ring(6, 9)(x, y) && !gap(x, y);
	t.equal(read([...NAME, broken]), '○', 'the ray that crosses the gap finds nothing, the other three find one wall');
	t.end();
});

test('a glyph the shape of a letter is no tier', (t) => {
	t.equal(read([...NAME, block(138, 4, 5, 22)]), null, 'a tall stroke: too thin round to be a marker');
	t.equal(read(NAME), null, 'nothing after the name');
	t.end();
});

test('a glyph joined to the name is no tier', (t) => {
	// One blank column between them, where the game leaves the width of a space.
	t.equal(read([block(80, 6, 37, 18), ring(6, 9, 127)]), null, 'the ring sits one column from the name, where a letter would be');
	t.end();
});

test('a box with nothing in it is no tier', (t) => {
	t.equal(read([]), null, 'an empty line');
	t.end();
});
