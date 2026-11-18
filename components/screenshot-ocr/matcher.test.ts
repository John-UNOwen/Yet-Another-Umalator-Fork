/**
 * Name matching tests against the names this fork actually offers: misreads accepted, screen text
 * refused, and the variants of one name kept apart by the marker or by whether the game showed a level.
 *
 * Run via: npm run test:ocr
 */
import test from 'tape';
import skillnames from '../../umalator-global/skillnames.json';
import notInGame from '../../umalator-global/not-in-game.json';
import { DEFAULT_MATCH, hasLevel, markerOf, matchName, normalizeName, similarity, splitMarker, type NameEntry } from './matcher';

const OFFERED: NameEntry[] = Object.entries(skillnames as Record<string, string | string[]>)
	.map(([id, v]) => ({ id, name: Array.isArray(v) ? v[0] : v }))
	.filter((e) => !(notInGame as { skills: string[] }).skills.includes(e.id) && /[a-z]/i.test(e.name));

const idOf = (name: string) => OFFERED.filter((e) => e.name === name).map((e) => e.id);

test('a screenshot name is folded to what can be compared', (t) => {
	t.equal(normalizeName('Corner Adept ○'), 'corneradept');
	t.equal(normalizeName('Neck & Neck!'), 'neckneck', 'punctuation and case carry no information');
	t.equal(normalizeName('粥Buding Blossom'), 'budingblossom', 'an icon glyph is noise, not a letter');
	t.deepEqual(splitMarker('Pace Chaser Corners ◎'), { base: 'pacechasercorners', marker: '◎' });
	t.deepEqual(splitMarker('Groundwork'), { base: 'groundwork', marker: null });
	t.end();
});

test('the marker is only claimed when the reader really saw one', (t) => {
	t.deepEqual(markerOf('Sprint Corners ◎'), { glyph: '◎', uncertain: false });
	t.deepEqual(markerOf('Corner Adept ×'), { glyph: '×', uncertain: false });
	t.deepEqual(markerOf('Pace Chaser Corners ©'), { glyph: '◎', uncertain: false }, 'a copyright glyph is how the double ring gets misread');
	t.deepEqual(markerOf('Firm Conditions O'), { glyph: null, uncertain: true }, 'a plain O says a marker was there, not which');
	t.deepEqual(markerOf('Groundwork'), { glyph: null, uncertain: false });
	t.end();
});

test('similarity is one for equal and drops with the edits', (t) => {
	t.equal(similarity('speedstar', 'speedstar'), 1);
	t.ok(Math.abs(similarity('shitinggears', 'shiftinggears') - 0.929) < 0.01, 'one dropped letter out of fourteen');
	t.ok(similarity('pacechasercorners', 'straightawayadept') < 0.4, 'two different names stay far apart');
	t.end();
});

test('a misread skill name resolves to the offered id', (t) => {
	const cases: [string, string][] = [
		['Profesor of Curvature', 'Professor of Curvature'],
		['Shiting Gears', 'Shifting Gears'],
		['Straight Desce', 'Straight Descent'],
		['Neck and Neck', 'Neck and Neck'],
		['Burning Spirit SPD', 'Burning Spirit SPD'],
	];
	for (const [read, name] of cases) {
		const m = matchName(read, OFFERED);
		t.ok(m && idOf(name).includes(m.id ?? ''), `${read} -> ${m ? `${m.name} ${m.score.toFixed(2)}` : 'nothing'}`);
	}
	t.end();
});

test('screen text that is not a skill name is refused', (t) => {
	for (const read of ['Umamusume Details', 'Umamusume', 'Career Info', 'Inspiration', 'Distance', 'Pace A', 'Taiki Shuttle', 'Daiwa Scarlet', 'Witness to Legend', 'Mightiest Miler', '19,669']) {
		const m = matchName(read, OFFERED);
		t.ok(!m, `${read} is not offered${m ? ` (closest ${m.name} ${m.score.toFixed(2)})` : ''}`);
	}
	t.end();
});

test('the marker decides which variant of a name it is', (t) => {
	const ring = idOf('Corner Adept ○')[0];
	const cross = idOf('Corner Adept ×')[0];
	t.ok(ring && cross && ring !== cross, 'the database holds both as separate skills');
	t.equal(matchName('Corner Adept ○', OFFERED)?.id, ring, 'the ring is the learnable one');
	t.equal(matchName('Corner Adept ×', OFFERED)?.id, cross, 'the cross is a different skill');
	const unsure = matchName('Corner Adept O', OFFERED);
	t.equal(unsure?.id, null, 'a plain O is not enough to choose');
	t.equal(unsure?.why, 'marker');
	t.ok(unsure && unsure.ids.length >= 2, `both variants stay on offer, got ${unsure?.ids.join(' ')}`);
	t.end();
});

test('a level decides the character own skill over the inherited one', (t) => {
	t.ok(hasLevel('Triumphant Pulse Lvl 4'), 'the game marks the own skill with a level');
	t.notOk(hasLevel('Triumphant Pulse'), 'an inherited skill shows none');
	const ids = idOf('Triumphant Pulse');
	t.equal(ids.length, 2, `the name is stored twice, got ${ids.join(' ')}`);
	t.equal(matchName('Triumphant Pulse Lvl 4', OFFERED)?.id, ids.find((id) => id.startsWith('1')), 'with a level it is the own skill');
	t.equal(matchName('Triumphant Pulse', OFFERED)?.id, ids.find((id) => id.startsWith('9')), 'without one it is the inherited skill');
	t.end();
});

test('junk words around a name are dropped and cost a little', (t) => {
	const trimmed = matchName('3 Neck and Neck', OFFERED);
	t.ok(trimmed && trimmed.name === 'Neck and Neck', `found ${trimmed?.name}`);
	t.equal(trimmed?.trims, 1, 'the junk word was dropped');
	t.equal(trimmed?.score, 1 - DEFAULT_MATCH.trimPenalty, 'a dropped word costs the trim penalty');
	t.end();
});

test('a fragment of a longer name is not that name', (t) => {
	const m = matchName('Straightaways', OFFERED);
	t.ok(!m || !m.name.includes('Pace Chaser'), `got ${m ? `${m.name} ${m.score.toFixed(2)}` : 'nothing'}`);
	t.end();
});

test('the accept line sits in an empty band', (t) => {
	// Every skill line read from the corpus scored 0.9 or better. Every piece of screen text that is
	// not a skill scored 0.55 or worse, so 0.82 is not balancing on a slope.
	for (const read of ['Triumphant Pulse', 'Right-Handed O', 'No Stoping Me!', 'Pace Chaser Corners', 'Burning Spirit SPD', 'Ignited Spirit P']) {
		const m = matchName(read, OFFERED);
		t.ok(m && m.score >= DEFAULT_MATCH.minScore, `${read} accepted at ${m?.score.toFixed(3)}`);
	}
	t.end();
});
