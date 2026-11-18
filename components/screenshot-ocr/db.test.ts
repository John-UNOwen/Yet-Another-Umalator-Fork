/**
 * Detection post-processing tests: blobs found in a probability map, weak ones refused, one text
 * row fused into one box while a neighbouring column stays its own box.
 *
 * Run via: npm run test:ocr
 */
import test from 'tape';
import { DEFAULT_DB, boxesFromProbMap, fuseRows } from './db';

const W = 64;
const H = 48;

/** A map of ones, with the given rectangles set to the value. */
const paint = (rects: readonly { x: number; y: number; w: number; h: number; v?: number }[]) => {
	const map = new Float32Array(W * H).fill(0.05);
	for (const r of rects) {
		for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) map[y * W + x] = r.v ?? 1;
	}
	return map;
};

test('glyphs of one word fuse into a single line box', (t) => {
	const map = paint([
		{ x: 10, y: 20, w: 4, h: 10 },
		{ x: 16, y: 20, w: 4, h: 10 },
		{ x: 23, y: 20, w: 5, h: 10 },
	]);
	const { boxes } = boxesFromProbMap(map, W, H);
	t.equal(boxes.length, 1, 'three glyphs, one box');
	const b = boxes[0];
	t.ok(b.x <= 10 && b.x + b.w >= 28, `the box spans the word, got x ${b.x} w ${b.w}`);
	t.ok(b.y <= 20 && b.y + b.h >= 30, `the box spans the glyph height, got y ${b.y} h ${b.h}`);
	t.end();
});

test('two text rows stay two boxes', (t) => {
	const map = paint([
		{ x: 8, y: 6, w: 30, h: 9 },
		{ x: 8, y: 30, w: 30, h: 9 },
	]);
	const { boxes } = boxesFromProbMap(map, W, H);
	t.equal(boxes.length, 2, 'rows separated vertically do not fuse');
	t.ok(boxes[0].y < boxes[1].y, 'reading order is top first');
	t.end();
});

test('a gap wider than the text height starts a new box', (t) => {
	const map = paint([
		{ x: 6, y: 20, w: 12, h: 10 },
		{ x: 40, y: 20, w: 12, h: 10 },
	]);
	const { boxes } = boxesFromProbMap(map, W, H);
	t.equal(boxes.length, 2, 'the column gap is too wide to be a word space');
	t.ok(boxes[0].x < boxes[1].x, 'left column first');
	t.end();
});

test('a component too small to be text is not a box', (t) => {
	const map = paint([{ x: 30, y: 20, w: 2, h: 2 }]);
	const { boxes } = boxesFromProbMap(map, W, H, { ...DEFAULT_DB, minArea: 12 });
	t.equal(boxes.length, 0, 'four pixels is noise');
	const bigger = paint([{ x: 30, y: 20, w: 4, h: 6 }]);
	t.equal(boxesFromProbMap(bigger, W, H).boxes.length, 1, '24 pixels is text');
	t.end();
});

test('a faint component is counted as rejected instead of kept', (t) => {
	const map = paint([
		{ x: 10, y: 20, w: 10, h: 10, v: 0.3 },
		{ x: 40, y: 20, w: 10, h: 10, v: 1 },
	]);
	const { boxes, rejected } = boxesFromProbMap(map, W, H);
	t.equal(boxes.length, 1, 'only the blob above the mean-value gate survives');
	t.ok(rejected >= 10 * 10, `the weak blob's pixels are reported, got ${rejected}`);
	t.end();
});

test('the two gates from the model decide what counts as text', (t) => {
	const map = paint([{ x: 10, y: 20, w: 10, h: 10, v: 0.45 }]);
	t.equal(boxesFromProbMap(map, W, H).boxes.length, 1, '0.45 clears the pixel gate 0.2 and the mean gate 0.4');
	t.equal(boxesFromProbMap(map, W, H, { ...DEFAULT_DB, thresh: 0.5 }).boxes.length, 0, 'raising the pixel gate erases it');
	t.equal(boxesFromProbMap(map, W, H, { ...DEFAULT_DB, boxThresh: 0.5 }).boxes.length, 0, 'raising the mean gate erases it too');
	t.end();
});

test('fuseRows merges only what overlaps vertically enough', (t) => {
	const pair = (y: number) => [{ x: 0, y: 0, w: 20, h: 10 }, { x: 0, y, w: 20, h: 10 }].map((b) => ({ raw: b, grown: b }));
	t.equal(fuseRows(pair(6), 0.9, 1.2).length, 2, 'a 40 percent overlap is under the row threshold');
	t.equal(fuseRows(pair(6), 0.3, 1.2).length, 1, 'the same pair fuses at a lower threshold');
	t.end();
});

test('the map corners keep boxes inside the image', (t) => {
	const map = paint([{ x: 0, y: 0, w: 20, h: 10 }]);
	const { boxes } = boxesFromProbMap(map, W, H);
	const b = boxes[0];
	t.ok(b.x >= 0 && b.y >= 0, 'unclip does not push a box off the top left');
	t.ok(b.x + b.w <= W && b.y + b.h <= H, 'nor past the bottom right');
	t.end();
});
