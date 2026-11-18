/**
 * Screenshot combining tests. The skills, stats and grades a reader produced are handed over directly,
 * so the merge rules are checked without an engine.
 *
 * Run via: npm run test:ocr
 */
import test from 'tape';
import { gaps, mergeReads } from './merge';
import type { Read, SkillRead } from './merge';
import type { Match } from './matcher';

function match(id: string | null, name: string, score = 0.95, ids: string[] = id === null ? ['200111', '100111'] : [id]): Match {
	return { id, ids, name, score, margin: 0.2, trims: 0 };
}

function skill(text: string, id: string | null, name: string, score = 0.95, level: number | null = null): SkillRead {
	return { text, name, match: match(id, name, score), level };
}

test('a dialog photographed twice gives one row per skill', (t) => {
	const merged = mergeReads([
		{ skills: [skill('Curious Genius', '201901', 'Curious Genius', 0.9), skill('High Voltage', '200421', 'High Voltage', 0.99)] },
		{ skills: [skill('Curious Genius', '201901', 'Curious Genius', 0.98), skill('High Voltage', '200421', 'High Voltage', 0.91)] },
	]);
	t.deepEqual(merged.skills.map((s) => `${s.name}:${s.match.score}`), ['Curious Genius:0.98', 'High Voltage:0.99'], 'the better reading of each row survives');
	t.equal(merged.screenshots, 2);
	t.end();
});

test('a second shot further down the list adds only the new rows', (t) => {
	const merged = mergeReads([
		{ skills: [skill('Head On', '200111', 'Head On ○')] },
		{ skills: [skill('Head On', '200111', 'Head On ○'), skill('Rush Wheel', '201511', 'Rush Wheel')] },
	]);
	t.deepEqual(merged.skills.map((s) => s.name), ['Head On ○', 'Rush Wheel'], 'in the order they were first read');
	t.end();
});

test('a row one shot resolved and the other only nearly read is one row', (t) => {
	const merged = mergeReads([
		{ skills: [skill('Burning Spirit SPD', '200431', 'Burning Spirit SPD', 0.93)] },
		{ skills: [skill('Burning Spirit SP', null, 'Burning Spirit SP', 0.4)] },
	]);
	t.equal(merged.skills.length, 1, 'the clipped reading folded into the resolved row');
	t.equal(merged.skills[0].match.id, '200431');
	t.equal(merged.skills[0].match.score, 0.93, 'the weak reading did not take the answer over');

	const apart = mergeReads([
		{ skills: [skill('Burning Spirit SPD', '200431', 'Burning Spirit SPD', 0.93)] },
		{ skills: [skill('Burning Sprint SPD', null, 'Burning Sprint SPD', 0.4)] },
	]);
	t.equal(apart.skills.length, 2, 'a row that differs by more than a clip stays on the screen to choose');
	t.end();
});

test('two skills with the same name stay two rows', (t) => {
	const merged = mergeReads([
		{ skills: [skill('Right-Handed ○ ×', '200333', 'Right-Handed ○ ×'), skill('Right-Handed ○', '200332', 'Right-Handed ○')] },
	]);
	t.deepEqual(merged.skills.map((s) => s.match.id), ['200333', '200332'], 'the sign matters, so they are not duplicates');
	t.end();
});

test('the candidate list grows with every reading of the row', (t) => {
	const merged = mergeReads([
		{ skills: [{ ...skill('Right-Handed', null, 'Right-Handed'), match: match(null, 'Right-Handed', 0.4, ['200332']) }] },
		{ skills: [{ ...skill('Right-Handed', null, 'Right-Handed'), match: match(null, 'Right-Handed', 0.45, ['200332', '200333']) }] },
	]);
	t.deepEqual(merged.skills[0].match.ids, ['200332', '200333'], 'a shot that saw the other marker still offers it');
	t.equal(merged.skills.length, 1);
	t.end();
});

test('the level survives a shot that did not read it', (t) => {
	const merged = mergeReads([
		{ uniqueLevel: 3, skills: [skill('Fantastical Circle Lvl 3', '100511', 'Fantastical Circle', 0.95, 3)] },
		{ skills: [skill('Fantastical Circle', '100511', 'Fantastical Circle', 0.95)] },
	]);
	t.equal(merged.uniqueLevel.value, 3, 'the shot that clipped the level text is silent, not a second answer');
	t.equal(merged.skills[0].level, 3);
	t.end();
});

test('fields the screenshots disagree on are reported', (t) => {
	const merged = mergeReads([
		{ stats: { Speed: 1321, Stamina: 473 }, aptitudes: { turf: 'A', dirt: 'B' }, name: 'oguri cap', star: 3 },
		{ stats: { Speed: 1321, Stamina: 474 }, aptitudes: { turf: 'A' }, name: 'Oguri Cap', star: 3 },
	]);
	t.equal(merged.stats.Speed.value, 1321, 'both said the same, so nothing to report');
	t.deepEqual({ value: merged.stats.Stamina.value, other: merged.stats.Stamina.other }, { value: 473, other: [474] });
	t.equal(merged.aptitudes.turf.value, 'A');
	t.deepEqual({ value: merged.aptitudes.dirt.value, other: merged.aptitudes.dirt.other }, { value: 'B', other: [] }, 'one screenshot did not show it, which is not a disagreement');
	t.deepEqual({ value: merged.name.value, other: merged.name.other }, { value: 'oguri cap', other: ['Oguri Cap'] });
	t.equal(merged.star.value, 3);
	t.end();
});

test('what was never read is listed as missing', (t) => {
	const empty = mergeReads([{}]);
	t.equal(empty.stats.Wit.value, null);
	t.equal(empty.aptitudes.sashi.value, null);
	t.deepEqual(gaps(empty).sort(), ['character', 'dirt', 'guts', 'long', 'medium', 'mile', 'nige', 'oikomi', 'power', 'sashi', 'senkou', 'short', 'skills', 'speed', 'stamina', 'turf', 'wit'].sort(), 'every field the import needs and did not get');

	const read = mergeReads([{ stats: { Speed: 1, Stamina: 2, Power: 3, Guts: 4, Wit: 5 }, epithet: '[Bubblegum Memories]', skills: [skill('Head On', '200111', 'Head On ○')] }]);
	t.deepEqual(gaps(read).sort(), ['long', 'medium', 'mile', 'nige', 'oikomi', 'sashi', 'senkou', 'short', 'turf', 'dirt'].sort(), 'only the aptitudes are still missing');
	t.end();
});
