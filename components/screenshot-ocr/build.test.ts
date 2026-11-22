import test from 'tape';
import { umaFromRead, skillKey } from './build';
import { mergeReads } from './merge';
import type { Read, SkillRead } from './merge';

const skill = (id: string | null, ids: string[], name = 'Head On'): SkillRead => ({
	text: name,
	name,
	match: { id, ids, name, score: 0.95, margin: 0.2, trims: 0 },
	level: null,
});

const read = (over: Partial<Read> = {}): Read => ({
	stats: { Speed: 1321, Stamina: 473, Power: 1208, Guts: 445, Wit: 1230 },
	aptitudes: { turf: 'A', dirt: 'G', short: 'A', mile: 'B', medium: 'A', long: 'B', nige: 'A', senkou: 'S', sashi: 'B', oikomi: 'C' },
	skills: [skill('200111', ['200111']), skill(null, ['100061', '900061'], 'Triumphant Pulse')],
	name: 'Taiki Shuttle',
	epithet: '[Bubblegum]',
	uniqueLevel: 4,
	...over,
});

test('the reading stands when nothing is edited', (t) => {
	const draft = umaFromRead(mergeReads([read()]));
	t.equal(draft.speed, 1321);
	t.equal(draft.wisdom, 1230);
	t.equal(draft.uniqueLv, 4);
	t.deepEqual(draft.skills, ['200111', '100061']);
	t.end();
});

test('distance and surface each take the best of their cells', (t) => {
	const draft = umaFromRead(mergeReads([read({ aptitudes: { turf: 'B', short: 'B', mile: 'A', medium: 'G', long: 'C' } })]));
	t.equal(draft.distanceAptitude, 'A');
	t.equal(draft.surfaceAptitude, 'B');
	t.end();
});

test('a dirt horse keeps its dirt grade on the surface the panel shows', (t) => {
	const dirt = umaFromRead(mergeReads([read({ aptitudes: { turf: 'F', dirt: 'A' } })]));
	t.equal(dirt.surfaceAptitude, 'A', 'the panel keeps one grade, and the better of the two is the one the horse is built for');
	const turf = umaFromRead(mergeReads([read({ aptitudes: { turf: 'A', dirt: 'G' } })]));
	t.equal(turf.surfaceAptitude, 'A');
	t.end();
});

test('a surface the user set stands over the reading', (t) => {
	const merged = mergeReads([read({ aptitudes: { turf: 'F', dirt: 'A' } })]);
	const draft = umaFromRead(merged, { aptitudes: { turf: 'C', dirt: 'C' } });
	t.equal(draft.surfaceAptitude, 'C');
	t.end();
});

test('the style aptitude follows the strategy the user picked', (t) => {
	const merged = mergeReads([read()]);
	t.equal(umaFromRead(merged).strategyAptitude, 'S');
	t.equal(umaFromRead(merged, { strategy: 'Oikomi' }).strategyAptitude, 'C');
	t.equal(umaFromRead(merged, { strategy: 'Oonige' as never }).strategy, 'Senkou');
	t.end();
});

test('a screen that showed nothing falls back to the panel defaults', (t) => {
	const draft = umaFromRead(mergeReads([read({ stats: {}, aptitudes: {}, uniqueLevel: undefined })]));
	t.deepEqual([draft.speed, draft.stamina, draft.power, draft.guts, draft.wisdom], [1200, 1200, 800, 400, 400]);
	t.equal(draft.distanceAptitude, 'A');
	t.equal(draft.surfaceAptitude, 'A');
	t.equal(draft.uniqueLv, 1);
	t.equal(draft.starCount, 3);
	t.end();
});

test('an edit wins over the reading', (t) => {
	const draft = umaFromRead(mergeReads([read()]), { stats: { Speed: 1500 }, aptitudes: { senkou: 'A' }, outfitId: '110101', starCount: 5 });
	t.equal(draft.speed, 1500);
	t.equal(draft.stamina, 473);
	t.equal(draft.strategyAptitude, 'A');
	t.equal(draft.outfitId, '110101');
	t.equal(draft.starCount, 5);
	t.end();
});

test('an unresolved row takes its first candidate until the user picks', (t) => {
	const merged = mergeReads([read()]);
	const unresolved = merged.skills[1];
	const key = skillKey(unresolved);
	t.deepEqual(unresolved.match.ids, ['100061', '900061']);
	t.equal(umaFromRead(merged).skills[1], '100061');
	t.equal(umaFromRead(merged, { skills: { [key]: { pick: '900061' } } }).skills[1], '900061');
	t.deepEqual(umaFromRead(merged, { skills: { [key]: { off: true } } }).skills, ['200111']);
	t.end();
});
