/**
 * One screenshot read end to end, against a fake engine so the composition is what is under test. The
 * measurements themselves are pinned in the modules that make them.
 *
 * Run via: npm run test:ocr
 */
import test from 'tape';
import { scanScreen } from './scan';
import type { OcrEngine, OcrLine } from './contract';

const line = (text: string, x: number, y: number, w = 60, h = 20): OcrLine => ({ text, score: 1, box: { x, y, w, h } });
const image = (scale = 1) => ({ width: 120, height: 80, rgba: new Uint8ClampedArray(120 * 80 * 4), scale });

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
