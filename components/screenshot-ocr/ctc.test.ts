/**
 * CTC decode tests: greedy emission with run collapsing, the digit-only mask, and the
 * forward score that ranks candidate skill names against what the model saw.
 *
 * Run via: npm run test:ocr
 */
import test from 'tape';
import { buildAlphabet, classesOf, ctcLogScore, decodeGreedy, digitMask, logSoftmax } from './ctc';

const ALPHABET = ['', 'a', 'b', '1', '2'];

/** Probabilities become logits through the log, which logSoftmax then turns back into log probabilities. */
const framesOf = (rows: readonly (readonly number[])[]) => {
	const steps = rows.length;
	const classes = rows[0].length;
	const logits = new Float32Array(steps * classes);
	rows.forEach((row, t) => row.forEach((v, c) => { logits[t * classes + c] = Math.log(v); }));
	return { logProbs: logSoftmax(logits, steps, classes), steps, classes };
};

test('the alphabet matches the class order the export was trained with', (t) => {
	const alphabet = buildAlphabet(['x', 'y', '　']);
	t.equal(alphabet[0], '', 'class 0 is the CTC blank');
	t.equal(alphabet[1], 'x', 'the dictionary starts at class 1');
	t.equal(alphabet[3], '　', 'the dictionary keeps its own ideographic space');
	t.equal(alphabet[4], ' ', 'a plain space is appended because the dictionary lacks one');
	t.equal(alphabet.length, 5, 'one blank plus three characters plus the appended space');
	t.end();
});

test('greedy decoding collapses runs and drops blanks', (t) => {
	const f = framesOf([
		[0.9, 0.03, 0.03, 0.02, 0.02],
		[0.05, 0.8, 0.05, 0.05, 0.05],
		[0.05, 0.8, 0.05, 0.05, 0.05],
		[0.05, 0.05, 0.8, 0.05, 0.05],
	]);
	const got = decodeGreedy(f.logProbs, f.steps, f.classes, ALPHABET);
	t.equal(got.text, 'ab', 'the repeated frame emits once');
	t.ok(Math.abs(got.score - 0.8) < 1e-6, `score is the mean emission probability, got ${got.score}`);
	t.end();
});

test('a blank between two frames lets a repeated character through', (t) => {
	const f = framesOf([
		[0.05, 0.8, 0.05, 0.05, 0.05],
		[0.9, 0.03, 0.03, 0.02, 0.02],
		[0.05, 0.8, 0.05, 0.05, 0.05],
	]);
	t.equal(decodeGreedy(f.logProbs, f.steps, f.classes, ALPHABET).text, 'aa');
	t.end();
});

test('the digit mask keeps letters out of a stat reading', (t) => {
	const f = framesOf([
		[0.02, 0.7, 0.02, 0.2, 0.06],
		[0.02, 0.02, 0.7, 0.06, 0.2],
	]);
	t.equal(decodeGreedy(f.logProbs, f.steps, f.classes, ALPHABET).text, 'ab', 'unmasked it reads the letters');
	t.equal(decodeGreedy(f.logProbs, f.steps, f.classes, ALPHABET, digitMask(f.classes, ALPHABET)).text, '12', 'masked it reads only digits');
	t.end();
});

test('the forward score prefers the sequence the frames spell', (t) => {
	const ab = ['', 'a', 'b'];
	const f = framesOf([
		[0.05, 0.9, 0.05],
		[0.9, 0.05, 0.05],
		[0.05, 0.05, 0.9],
	]);
	const score = (key: string) => ctcLogScore(f.logProbs, f.steps, f.classes, key, ab);
	t.ok(score('ab') > score('ba'), 'ab beats ba');
	t.ok(score('ab') > score('a'), 'ab beats the shorter key');
	t.ok(score('ab') > score('abb'), 'a key needing an emission the frames never made costs it');
	t.ok(score('ab') <= 0, 'a log probability is never above zero');
	t.end();
});

test('a repeated character needs a blank, and the score knows', (t) => {
	const ab = ['', 'a'];
	const withoutBlank = framesOf([[0.02, 0.98], [0.02, 0.98]]);
	const withBlank = framesOf([[0.02, 0.98], [0.98, 0.02], [0.02, 0.98]]);
	t.ok(ctcLogScore(withoutBlank.logProbs, 2, 2, 'a', ab) > ctcLogScore(withoutBlank.logProbs, 2, 2, 'aa', ab), 'two identical frames spell one a');
	t.ok(ctcLogScore(withBlank.logProbs, 3, 2, 'aa', ab) > ctcLogScore(withBlank.logProbs, 3, 2, 'a', ab), 'a blank between them spells two');
	t.end();
});

test('keys are mapped to classes with unknown characters dropped', (t) => {
	t.deepEqual(classesOf('a2b', ALPHABET), [1, 4, 2]);
	t.deepEqual(classesOf('a♥', ALPHABET), [1], 'a character outside the dictionary cannot be scored');
	t.deepEqual(classesOf('♥', ALPHABET), []);
	t.equal(ctcLogScore(framesOf([[0.5, 0.5]]).logProbs, 1, 2, '♥', ALPHABET), -Infinity, 'an unspellable key scores nothing');
	t.end();
});
