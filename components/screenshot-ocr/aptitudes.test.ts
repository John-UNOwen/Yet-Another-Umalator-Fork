/**
 * Aptitude colour tests on painted panels. The grades are colours on screen, so the test paints the
 * colours and checks the letter that comes out, including the grey one and the ones that come apart.
 * A letter always sits inside a stretch of panel, which is what it is measured against.
 *
 * Run via: npm run test:ocr
 */
import test from 'tape';
import { GRADE_HUES, GRADES, gradeOfStats, letterStats, readLetter, type Box } from './aptitudes';

const PANEL: [number, number, number] = [238, 230, 218];

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
	return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** The region a cell is measured in, with the glyph painted inside it. */
const REGION: Box = { x: 10, y: 6, w: 40, h: 28 };
const GLYPH: Box = { x: 20, y: 9, w: 18, h: 22 };

function panelWith(glyphs: { box: Box; colour: [number, number, number] }[], width = 120, height = 40) {
	const rgba = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		rgba[i * 4] = PANEL[0]; rgba[i * 4 + 1] = PANEL[1]; rgba[i * 4 + 2] = PANEL[2]; rgba[i * 4 + 3] = 255;
	}
	for (const { box, colour } of glyphs) {
		for (let y = Math.round(box.y); y < Math.round(box.y + box.h); y++) {
			for (let x = Math.round(box.x); x < Math.round(box.x + box.w); x++) {
				const at = (y * width + x) * 4;
				rgba[at] = colour[0]; rgba[at + 1] = colour[1]; rgba[at + 2] = colour[2];
			}
		}
	}
	return { rgba, width };
}

const gradeColour = (grade: keyof typeof GRADE_HUES) => hslToRgb(GRADE_HUES[grade], 0.75, 0.62);

test('every grade colour comes back as its grade', (t) => {
	for (const grade of GRADES.filter((g) => g !== 'G') as (keyof typeof GRADE_HUES)[]) {
		const { rgba, width } = panelWith([{ box: GLYPH, colour: gradeColour(grade) }]);
		const stats = letterStats(rgba, width, REGION);
		t.equal(gradeOfStats(stats), grade, `${grade} painted at ${GRADE_HUES[grade]}° (measured hue ${stats.hue?.toFixed(0)} from ${stats.ink} pixels)`);
	}
	t.end();
});

test('the grey letter is G and an empty panel is nothing', (t) => {
	const grey = panelWith([{ box: GLYPH, colour: hslToRgb(0, 0, 0.45) }]);
	t.equal(gradeOfStats(letterStats(grey.rgba, grey.width, REGION)), 'G', 'the letter drawn without colour');
	const empty = panelWith([]);
	t.equal(gradeOfStats(letterStats(empty.rgba, empty.width, REGION)), null, 'a panel with no glyph holds no grade');
	t.end();
});

test('a colour the game never draws is refused', (t) => {
	const green = panelWith([{ box: GLYPH, colour: hslToRgb(160, 0.75, 0.62) }]);
	t.equal(gradeOfStats(letterStats(green.rgba, green.width, REGION)), null, 'a green glyph is not a grade');
	t.end();
});

test('a letter drawn across the end of the hue ring is still one colour', (t) => {
	const { rgba, width } = panelWith([
		{ box: { x: 20, y: 9, w: 9, h: 22 }, colour: hslToRgb(348, 0.75, 0.62) },
		{ box: { x: 29, y: 9, w: 9, h: 22 }, colour: hslToRgb(4, 0.75, 0.62) },
	]);
	const stats = letterStats(rgba, width, REGION);
	t.equal(gradeOfStats(stats), 'B', `348° and 4° are one pink letter, not two colours (measured ${stats.hue?.toFixed(0)})`);
	t.end();
});

test('a faint letter is refused rather than guessed', (t) => {
	const faint = panelWith([{ box: { x: 24, y: 14, w: 4, h: 3 }, colour: gradeColour('S') }]);
	t.equal(gradeOfStats(letterStats(faint.rgba, faint.width, REGION)), null, 'too few pixels to call a letter');
	t.end();
});

test('a letter found in a probe answers, and the probe it came from is reported', (t) => {
	const blob: Box = { x: 80, y: 4, w: 38, h: 32 };
	const blobGlyph: Box = { x: 90, y: 9, w: 18, h: 22 };
	const tail: Box = { x: 6, y: 4, w: 38, h: 32 };
	const tailGlyph: Box = { x: 12, y: 9, w: 18, h: 22 };

	const found = panelWith([{ box: blobGlyph, colour: gradeColour('B') }]);
	const readB = readLetter(found.rgba, found.width, [{ box: blob, where: 'blob' }, { box: tail, where: 'gap' }], null);
	t.equal(readB.grade, 'B');
	t.equal(readB.where, 'blob');
	t.ok(readB.confident, 'a glyph the detector boxed is its own answer');

	const second = panelWith([{ box: tailGlyph, colour: gradeColour('D') }]);
	const readD = readLetter(second.rgba, second.width, [{ box: blob, where: 'blob' }, { box: tail, where: 'gap' }], 'D');
	t.equal(readD.grade, 'D');
	t.equal(readD.where, 'gap', 'the first probe holding a letter answers, later ones are not tried');
	t.ok(readD.confident);
	t.end();
});

test('a word tail alone only ever proves A, and is only trusted when the letter was seen too', (t) => {
	// The value words are drawn in the same colour as an A, so a tail holding only word ink reads as A.
	const tail: Box = { x: 6, y: 4, w: 38, h: 32 };
	const probes = [{ box: tail, where: 'word' as const }];
	const { rgba, width } = panelWith([{ box: { x: 10, y: 9, w: 20, h: 22 }, colour: gradeColour('A') }]);

	const alone = readLetter(rgba, width, probes, null);
	t.equal(alone.grade, 'A');
	t.notOk(alone.confident, 'the reader never saw a letter, so this is an inference from word ink');

	const corroborated = readLetter(rgba, width, probes, 'A');
	t.equal(corroborated.grade, 'A');
	t.ok(corroborated.confident, 'the reader saw the same letter the colour shows');
	t.end();
});

test('two readers that disagree give no answer', (t) => {
	const region: Box = { x: 10, y: 6, w: 40, h: 28 };
	const { rgba, width } = panelWith([{ box: GLYPH, colour: gradeColour('B') }]);
	const read = readLetter(rgba, width, [{ box: region, where: 'gap' }], 'S');
	t.equal(read.grade, null, 'a blue glyph and a letter S cannot both be right, so neither is picked');
	t.notOk(read.confident);
	t.equal(read.seen, 'S', 'what the reader saw stays visible for the review screen');
	t.end();
});

test('a letter only the text reader saw is offered as a guess', (t) => {
	const empty = panelWith([]);
	const read = readLetter(empty.rgba, empty.width, [{ box: REGION, where: 'gap' }], 'C');
	t.equal(read.grade, 'C');
	t.notOk(read.confident);
	t.equal(read.where, 'none');
	const nothing = readLetter(empty.rgba, empty.width, [{ box: REGION, where: 'gap' }], null);
	t.equal(nothing.grade, null);
	t.end();
});
