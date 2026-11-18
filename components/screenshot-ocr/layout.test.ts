/**
 * Aptitude block layout tests. The boxes are the shapes the reader really returns: the geometry comes
 * from the corpus captures, with the coordinates pulled back to what one cell looks like.
 *
 * Run via: npm run test:ocr
 */
import test from 'tape';
import { APTITUDE_WORDS, aptitudeCells, cellBox, letterProbes } from './layout';
import type { OcrLine } from './contract';

const line = (text: string, x: number, y: number, w: number, h = 24, score = 0.99): OcrLine => ({ text, score, box: { x, y, w, h } });

/** One row of the aptitude block, as the 1920x1080 capture lays it out. */
function row(): OcrLine[] {
	return [
		line('Track', 296, 338, 60, 24),
		line('Turf A', 413, 338, 62, 24),
		line('Dirt', 522, 338, 34, 22),
		line('D', 560, 340, 16, 18),
		line('Distance', 296, 374, 68, 24),
		line('Sprint F', 405, 374, 74, 24),
		line('Mile', 520, 374, 38, 21),
		line('A', 562, 375, 15, 19),
		line('MediumA', 611, 374, 96, 23),
		line('Style', 296, 406, 48, 24),
		line('Front A', 407, 406, 70, 24),
		line('Pace', 517, 406, 40, 22),
		line('Late E', 625, 406, 66, 22),
		line('End', 735, 406, 34, 21),
		line('G', 772, 407, 15, 18),
		// Skill rows further down that begin with aptitude words, one of them read on its own.
		line('Medium', 866, 700, 90, 26),
		line('Pace', 1244, 740, 60, 26),
	];
}

test('the aptitude block is found by its words', (t) => {
	const cells = aptitudeCells(row());
	const keys = cells.map((c) => c.key);
	t.deepEqual(keys, ['turf', 'dirt', 'short', 'mile', 'medium', 'long', 'nige', 'senkou', 'sashi', 'oikomi'].filter((k) => k !== 'long'), 'every word the row holds, and no invented ones');
	t.equal(cells.find((c) => c.key === 'dirt')?.letter?.text, 'D', 'a letter boxed on its own is found');
	t.equal(cells.find((c) => c.key === 'turf')?.letter, null, 'a letter glued to the word stays inside the word');
	t.equal(cells.find((c) => c.key === 'medium')?.letter, null, 'a letter glued to the word stays inside the word');
	t.end();
});

test('a skill row under the block never wins the cell', (t) => {
	const cells = aptitudeCells(row());
	t.equal(cells.find((c) => c.key === 'medium')?.word.text, 'MediumA', 'the cell word is the one under its heading, not the shorter skill fragment');
	t.equal(cells.find((c) => c.key === 'senkou')?.word.text, 'Pace');
	t.equal(Math.round(cells.find((c) => c.key === 'senkou')?.word.box.y ?? 0), 406, 'in the style row, not in the skill list');
	t.end();
});

test('a skill row is not mistaken for an aptitude word', (t) => {
	const cells = aptitudeCells([line('Pace Chaser Corners ◎', 866, 700, 220, 26), line('Sprint Corners ○', 1244, 700, 170, 26)]);
	t.deepEqual(cells, [], 'a row that merely starts with an aptitude word is not that cell');
	t.end();
});

test('the probes try the boxed letter first, then the gap, then the word tail', (t) => {
	const cells = aptitudeCells(row());
	const boxed = letterProbes(cells.find((c) => c.key === 'dirt')!);
	t.deepEqual(boxed.map((p) => p.where), ['blob', 'gap', 'word']);
	const gap = boxed[1].box;
	t.ok(Math.abs(gap.x - (522 + 34)) < 1, 'the gap starts where the word ends');
	t.ok(gap.w > 16 && gap.w < 40, `the gap is about a letter wide, got ${gap.w}`);
	const blob = boxed[0].box;
	t.ok(blob.x < 560 && blob.x + blob.w > 576 && blob.h > 18 * 1.5, 'the blob is measured in a window wider than the glyph, so the panel can be its background');

	const glued = letterProbes(cells.find((c) => c.key === 'medium')!);
	t.deepEqual(glued.map((p) => p.where), ['gap', 'word'], 'no blob, so no blob probe');
	t.end();
});

test('a cell box covers the word and its letter', (t) => {
	const cells = aptitudeCells(row());
	const dirt = cellBox(cells.find((c) => c.key === 'dirt')!);
	t.deepEqual({ x: dirt.x, w: Math.round(dirt.w) }, { x: 522, w: 54 }, 'word plus the letter beside it');
	const medium = cellBox(cells.find((c) => c.key === 'medium')!);
	t.equal(Math.round(medium.w), 96, 'a glued letter is already inside the word box');
	t.end();
});

test('every aptitude word the dialog prints is known', (t) => {
	t.deepEqual(Object.values(APTITUDE_WORDS), ['Turf', 'Dirt', 'Sprint', 'Mile', 'Medium', 'Long', 'Front', 'Pace', 'Late', 'End'], 'the ten words a details dialog can show');
	t.end();
});
