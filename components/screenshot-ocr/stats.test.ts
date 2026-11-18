/**
 * Stat number reading tests. The recogniser is replaced by a fake that reports what it was handed, so
 * the ladder, the length rule and the vote are checked without wasm or a screenshot.
 *
 * Run via: npm run test:ocr
 */
import test from 'tape';
import { MAX_DIGITS, MIN_DIGITS, STAT_LADDER, ladderCrop, maskedAgrees, numberFromText, parseNumber, readNumber, vote } from './stats';
import type { Preprocessed } from './contract';

/** A pale panel with a dark bar across it, the shape a stat number sits on. */
function panel(width = 60, height = 30): Preprocessed {
	const rgba = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const at = (y * width + x) * 4;
			const ink = y >= 8 && y < 18 && x >= 12 && x < 40;
			const v = ink ? 40 : 235;
			rgba[at] = v; rgba[at + 1] = v; rgba[at + 2] = v; rgba[at + 3] = 255;
		}
	}
	return { width, height, rgba, scale: 1 };
}

const BOX = { x: 10, y: 4, w: 20, h: 10 };

test('a number only counts when it is digits of an expected length', (t) => {
	t.equal(parseNumber('1321'), 1321);
	t.equal(parseNumber(' 473 '), 473, 'the decoders padding is not part of the number');
	t.equal(parseNumber('9'), null, `below ${MIN_DIGITS} digits it is a fragment`);
	t.equal(parseNumber('81230'), null, `above ${MAX_DIGITS} digits it swallowed the rank badge`);
	t.equal(parseNumber('12o8'), null, 'a letter means the crop was not a clean number');
	t.equal(parseNumber(''), null);
	t.end();
});

test('the value is the one the most variants agreed on', (t) => {
	t.deepEqual(vote([1208, 1208, 1200]), { value: 1208, agreed: 2 });
	t.deepEqual(vote([1208, 1200, 1190]), { value: 1208, agreed: 1 }, 'nothing agreed, and that is said rather than hidden');
	t.deepEqual(vote([null, null, null]), { value: null, agreed: 0 });
	t.deepEqual(vote([445, null, 445]), { value: 445, agreed: 2 }, 'a variant that failed to read is not a vote against');
	t.end();
});

test('a ladder rung crops, binarizes and magnifies in that order', (t) => {
	const image = panel();
	const raw = ladderCrop(image, BOX, STAT_LADDER[0]);
	t.deepEqual({ w: raw.width, h: raw.height }, { w: 22, h: 12 }, 'the box plus a tenth of its height as padding');
	t.ok(raw.rgba.some((v, i) => i % 4 === 0 && v > 200) && raw.rgba.some((v, i) => i % 4 === 0 && v < 100), 'the pale panel and the dark bar both survive');

	const cut = ladderCrop(image, BOX, { cut: 185, scale: 1 });
	const values = new Set<number>();
	for (let i = 0; i < cut.rgba.length; i += 4) values.add(cut.rgba[i]);
	t.deepEqual([...values].sort((a, b) => a - b), [0, 255], 'a binarized crop holds ink and panel only');

	const grown = ladderCrop(image, BOX, { cut: 185, scale: 2 });
	t.deepEqual({ w: grown.width, h: grown.height }, { w: 44, h: 24 }, 'the magnified rung gives the recogniser more pixels');
	t.equal(grown.scale, 2, 'the rung records itself so the review screen can say what was tried');
	t.end();
});

test('the reading is the vote over the ladder, with what each rung saw', async (t) => {
	const image = panel();
	const handed: Preprocessed[] = [];
	const answers = ['1208', '1208', 'B208'];
	const seen = await readNumber(image, BOX, async (crop) => {
		handed.push(crop);
		return answers[handed.length - 1];
	});
	t.equal(handed.length, STAT_LADDER.length, 'every rung was tried');
	t.equal(seen.value, 1208);
	t.equal(seen.agreed, 2);
	t.equal(seen.attempts, 3);
	t.deepEqual(seen.seen, answers, 'a bad rung stays visible for the review screen');
	t.end();
});

test('the number is taken from the line text, badge and all', (t) => {
	t.deepEqual(numberFromText('U 1321'), { value: 1321, candidates: [1321] }, 'the badge is a letter, so the digits stand apart');
	t.deepEqual(numberFromText('445'), { value: 445, candidates: [445] });
	t.deepEqual(numberFromText('A 923'), { value: 923, candidates: [923] });
	t.deepEqual(numberFromText('U81230'), { value: 1230, candidates: [1230] }, 'the badge stuck its digit on the front');
	t.deepEqual(numberFromText('u81249'), { value: 1249, candidates: [1249] });
	t.deepEqual(numberFromText('22,753'), { value: 753, candidates: [753] }, 'a two digit fragment is not a stat');
	t.deepEqual(numberFromText('123 456'), { value: null, candidates: [123, 456] }, 'two plausible numbers is not an answer');
	t.deepEqual(numberFromText('Speed 99'), { value: null, candidates: [] }, 'below what a stat can be');
	t.deepEqual(numberFromText(''), { value: null, candidates: [] });
	t.end();
});

test('the masked reading either contains the number or does not', (t) => {
	t.ok(maskedAgrees(['10181230', '81230', '1230'], 1230), 'the badge digits are still in front of it');
	t.ok(maskedAgrees(['16596'], 596), 'a leading badge digit is tolerated');
	t.notOk(maskedAgrees(['16596'], 1596), 'a number that is not in there does not agree');
	t.notOk(maskedAgrees([], 596), 'nothing read is no agreement');
	t.end();
});

test('no rung agreeing leaves no answer', async (t) => {
	const image = panel();
	const read = await readNumber(image, BOX, async () => '81230');
	t.equal(read.value, null);
	t.equal(read.agreed, 0);
	t.deepEqual(read.seen, ['81230', '81230', '81230'], 'the badge was swallowed on every rung, and that is what gets shown');
	t.end();
});