/**
 * One screenshot read end to end, against a fake engine so the composition is what is under test. The
 * measurements themselves are pinned in the modules that make them.
 *
 * Run via: npm run test:ocr
 */
import test from 'tape';
import { scanScreen } from './scan';
import type { Box, OcrEngine, OcrLine, Preprocessed } from './contract';

const line = (text: string, x: number, y: number, w = 60, h = 20): OcrLine => ({ text, score: 1, box: { x, y, w, h } });
const image = (scale = 1) => ({ width: 120, height: 80, rgba: new Uint8ClampedArray(120 * 80 * 4), scale });

/** A light panel with two dark bands, which is what a box drawn over a wrapped name holds. */
function bandedImage(): Preprocessed {
	const width = 120, height = 80;
	const rgba = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = 255;
	}
	for (let y = 10; y < 40; y++) {
		if (y >= 20 && y < 30) continue;
		for (let x = 0; x < width; x++) {
			const at = (y * width + x) * 4;
			rgba[at] = 0; rgba[at + 1] = 0; rgba[at + 2] = 0;
		}
	}
	return { width, height, rgba, scale: 1 };
}

function fakeEngine(lines: readonly OcrLine[], digits = ''): OcrEngine {
	return {
		id: 'fake',
		detect: async () => lines.map((l) => l.box),
		read: async () => [...lines],
		readDigits: async () => digits,
		scoreKeys: async () => [],
		dispose: () => undefined,
	};
}

/** An engine that answers each box by its geometry, so a read of two halves can be told from the first. */
function boxedEngine(boxes: readonly Box[], answers: readonly OcrLine[]) {
	const asked: Box[][] = [];
	const engine: OcrEngine = {
		id: 'fake',
		detect: async () => [...boxes],
		read: async (_image, found) => {
			asked.push([...found]);
			return found.map((box) => answers.find((l) => Math.abs(l.box.y - box.y) < 1 && Math.abs(l.box.h - box.h) < 1) ?? { text: '', score: 0, box });
		},
		readDigits: async () => '',
		scoreKeys: async () => [],
		dispose: () => undefined,
	};
	return { engine, asked };
}

const STAT_ROWS = [
	line('5 Speed', 288, 259), line('Stamina', 399, 259), line('F Power', 517, 259), line('Guts', 637, 259), line('Wit', 751, 259),
	line('U 1321', 268, 285, 92, 40), line('473', 400, 286, 62, 38), line('Ue 1208', 490, 285, 130, 42), line('445', 637, 286, 60, 38), line('U81230', 730, 285, 90, 40),
];

test('the five numbers are taken from the lines under their own labels', async (t) => {
	const scan = await scanScreen(fakeEngine(STAT_ROWS, '1321'), image(), []);
	t.deepEqual(scan.read.stats, { Speed: 1321, Stamina: 473, Power: 1208, Guts: 445, Wit: 1230 }, 'the badge digit is dropped from each run');
	t.equal(scan.statNotes.length, 5);
	const speed = scan.statNotes.find((n) => n.stat === 'Speed')!;
	t.ok(speed.agreed, 'the digit reader saw the same number there');
	t.equal(scan.statNotes.find((n) => n.stat === 'Wit')!.agreed, false, 'and where it did not, the note says so');
	t.end();
});

test('a digit reader that cannot read does not veto the number', async (t) => {
	const scan = await scanScreen(fakeEngine(STAT_ROWS, 'U13a'), image(), []);
	t.equal(scan.read.stats.Speed, 1321, 'the text value stands');
	t.ok(scan.statNotes.every((n) => !n.agreed), 'every cell is flagged for the review screen');
	t.end();
});

test('skills, epithet, name and unique level come through', async (t) => {
	const names = [{ id: '200111', name: 'Head On ○' }, { id: '900111', name: 'Head On ○' }, { id: '100061', name: 'Triumphant Pulse' }];
	const lines = [
		line('[Starlight Beat]', 100, 40, 200, 30),
		line('Oguri Cap', 120, 76, 150, 28),
		line('Head On', 180, 200, 140, 26),
		line('Lvl 4', 330, 201, 60, 26),
		line('Triumphant Pulse Lvl 5', 600, 200, 260, 26),
	];
	const scan = await scanScreen(fakeEngine(lines), image(), names);
	t.deepEqual(scan.read.skills!.map((s) => s.text), ['Head On', 'Triumphant Pulse Lvl 5']);
	t.equal(scan.read.skills![0].level, 4, 'the chip on the row is the level');
	t.equal(scan.read.skills![1].level, 5);
	t.equal(scan.read.epithet, '[Starlight Beat]');
	t.equal(scan.read.name, 'Oguri Cap');
	t.equal(scan.read.uniqueLevel, 4);
	t.end();
});

test('boxes are returned in the screenshot’s own pixels', async (t) => {
	const lines = [line('Head On', 180, 200, 140, 26)];
	const scan = await scanScreen(fakeEngine(lines), image(2), [{ id: '200111', name: 'Head On ○' }]);
	t.equal(scan.scale, 2, 'the engine worked on an image twice the size');
	t.deepEqual(scan.lines[0].box, { x: 90, y: 100, w: 70, h: 13 }, 'so the crop the review screen cuts is halved');
	t.deepEqual(scan.read.skills![0].box, { x: 90, y: 100, w: 70, h: 13 });
	t.end();
});

test('a box drawn over a wrapped name is read again in halves', async (t) => {
	const names = [{ id: '201311', name: 'Pace Chaser Straightaways ◎' }, { id: '201312', name: 'Pace Chaser Straightaways ○' }];
	const tall = line('sarcichaays', 0, 8, 100, 34);
	const top = line('Pace Chaser', 0, 8, 100, 17);
	const bottom = line('Straightaways O', 0, 25, 100, 17);
	const others = [line('Mile Maven', 0, 50, 100, 14), line('Slipstream', 0, 66, 100, 14), line('Unstoppable', 0, 76, 100, 14)];
	const boxes = [tall.box, ...others.map((l) => l.box)];
	const { engine, asked } = boxedEngine(boxes, [tall, top, bottom, ...others]);
	const scan = await scanScreen(engine, bandedImage(), names);
	t.equal(asked[0].length, 4, 'the first read covered every box the detector found');
	const split = asked.find((found) => found.length === 2);
	t.ok(split, 'the tall box was read a second time');
	t.deepEqual(split!.map((b) => [b.y, b.h]), [[8, 17], [25, 17]], 'cut in the blank band between the two printed lines');
	t.deepEqual(scan.read.skills!.map((s) => s.text), ['Pace Chaser Straightaways O'], 'which join into the one name the screen printed over two lines');
	t.end();
});

test('a screen with no box over two lines is read once per box', async (t) => {
	const pool = [line('Mile Maven', 0, 8, 100, 14), line('Slipstream', 0, 30, 100, 14)];
	const { engine, asked } = boxedEngine(pool.map((l) => l.box), pool);
	const scan = await scanScreen(engine, bandedImage(), [{ id: '200681', name: 'Mile Maven' }]);
	t.deepEqual(asked.map((found) => found.length), [2], 'one read for the whole screen, and no second pass over a line');
	t.deepEqual(scan.read.skills!.map((s) => s.text), ['Mile Maven']);
	t.end();
});
