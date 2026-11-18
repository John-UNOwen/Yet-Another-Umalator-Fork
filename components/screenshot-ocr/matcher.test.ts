/**
 * Name matching tests against the names this fork actually offers: misreads accepted, screen text
 * refused, and the variants of one name kept apart by the marker or by whether the game showed a level.
 *
 * Run via: npm run test:ocr
 */
import test from 'tape';
import skillnames from '../../umalator-global/skillnames.json';
import notInGame from '../../umalator-global/not-in-game.json';
import { DEFAULT_MATCH, hasLevel, levelOf, markerOf, matchName, normalizeName, similarity, skillReads, splitMarker, type NameEntry } from './matcher';
import { levelBeside } from './layout';

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

test('the level badge is read even when the reader cannot spell it', (t) => {
	t.equal(levelOf('Lvl 4'), 4);
	t.equal(levelOf('Lv| 3'), 3, 'the reader confused the letter i with a bar');
	t.equal(levelOf('Fantastical Circle Lvl 5'), 5, 'glued onto the name it follows');
	t.equal(levelOf('Right-Handed ○'), null, 'an inherited copy shows nothing');
	t.equal(levelOf('U 1321'), null, 'a stat number is not a level');
	t.ok(hasLevel('Lv| 3'), 'the level still decides the owned copy');
	t.end();
});

test('the skills on a screen are the lines that answer to offered names', (t) => {
	const lines = [
		{ text: 'Triumphant Pulse', score: 0.96, box: { x: 179, y: 744, w: 200, h: 30 } },
		{ text: '院', score: 0.28, box: { x: 527, y: 744, w: 20, h: 30 } },
		{ text: 'Lvl 4', score: 0.83, box: { x: 430, y: 745, w: 50, h: 26 } },
		{ text: 'Right-Handed O', score: 0.92, box: { x: 580, y: 832, w: 220, h: 30 } },
		{ text: 'Speed', score: 1, box: { x: 161, y: 366, w: 60, h: 24 } },
		{ text: '1321', score: 1, box: { x: 150, y: 401, w: 90, h: 30 } },
	];
	const reads = skillReads(lines, OFFERED, {}, levelBeside);
	t.deepEqual(reads.map((r) => r.text), ['Triumphant Pulse', 'Right-Handed O'], 'icons, level chips and stat labels answer to no name');
	t.ok(reads[0].box, 'the line box comes back with the read, for the review screen to crop');
	t.ok(reads[0].match.id!.startsWith('1'), `${reads[0].match.id} is the character's own copy, because the chip on its row says so`);
	t.equal(reads[0].level, 4);
	t.equal(reads[1].match.id, null, 'a marker read as the letter O stays a choice');
	t.equal(reads[1].level, null);

	const blind = skillReads([lines[0]], OFFERED);
	t.ok(blind[0].match.id!.startsWith('9'), 'without the row the name is taken as the inherited copy');
	t.equal(blind[0].level, null);
	t.end();
});

test('a name wrapped onto a second line is one skill', (t) => {
	const reads = skillReads([
		{ text: 'Pace Chaser', score: 1, box: { x: 867, y: 1108, w: 190, h: 25 } },
		{ text: 'Straightaways ©', score: 0.98, box: { x: 866, y: 1130, w: 210, h: 25 } },
		{ text: 'Pace Chaser Corners ©', score: 0.96, box: { x: 1244, y: 1117, w: 260, h: 25 } },
	], OFFERED);
	t.deepEqual(reads.map((r) => r.text), ['Pace Chaser Straightaways ©', 'Pace Chaser Corners ©'], 'neither half is a name, the wrap is');
	t.deepEqual(reads[0].box, { x: 866, y: 1108, w: 210, h: 47 }, 'the crop the review screen shows covers both lines');
	t.notEqual(reads[0].match.id, reads[1].match.id, 'the wrapped name is not the corner skill beside it');

	const stacked = skillReads([
		{ text: 'Standard Distance ©', score: 1, box: { x: 179, y: 920, w: 210, h: 30 } },
		{ text: 'Corner Recovery O', score: 0.95, box: { x: 179, y: 942, w: 200, h: 30 } },
	], OFFERED);
	t.deepEqual(stacked.map((r) => r.text), ['Standard Distance ©', 'Corner Recovery O'], 'a row that is already a name keeps it instead of being swallowed by the row above');
	t.end();
});
