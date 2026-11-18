// Replays the nine corpus scans frozen in test/ocr-corpus/fixtures, so the merge and the build are checked
// over real screenshots without the OCR models. Regenerating them: test/ocr-corpus/README.md.

import test from 'tape';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Grade } from './aptitudes';
import { DISTANCE_KEYS, umaFromRead } from './build';
import { splitMarker } from './matcher';
import { gaps, mergeReads } from './merge';
import type { Read } from './merge';

const root = join(__dirname, '..', '..');
const fixture = (name: string): Read => JSON.parse(readFileSync(join(root, 'test/ocr-corpus/fixtures', `${name}.json`), 'utf8')).read;
const frozen = (group: string) => JSON.parse(readFileSync(join(root, 'test/ocr-corpus/golden', `${group}.json`), 'utf8'));

const GROUPS: Record<string, string[]> = {
	'daiwa-peak-blue': ['daiwa-scarlet-peak-blue-steam-top', 'daiwa-scarlet-peak-blue-steam-scrolled'],
	'taiki-bubblegum-steam': ['taiki-shuttle-bubblegum-steam-top', 'taiki-shuttle-bubblegum-steam-scrolled'],
	'taiki-bubblegum-ug7': ['taiki-shuttle-bubblegum-ug7'],
	'taiki-bubblegum-ug9': ['taiki-shuttle-bubblegum-ug9'],
	'taiki-bubblegum-ss': ['taiki-shuttle-bubblegum-ss'],
	'oguri-starlight-beat': ['oguri-cap-starlight-beat'],
	'symboli-archer-by-moonlight': ['symboli-rudolf-archer-by-moonlight'],
};
const CAPTURES = [
	'daiwa-scarlet-peak-blue-steam-scrolled', 'daiwa-scarlet-peak-blue-steam-top',
	'oguri-cap-starlight-beat', 'symboli-rudolf-archer-by-moonlight',
	'taiki-shuttle-bubblegum-ss', 'taiki-shuttle-bubblegum-steam-scrolled',
	'taiki-shuttle-bubblegum-steam-top', 'taiki-shuttle-bubblegum-ug7', 'taiki-shuttle-bubblegum-ug9',
];

const skilldata = JSON.parse(readFileSync(join(root, 'umalator-global/skill_data.json'), 'utf8')) as Record<string, unknown>;
const KNOWN_IDS = new Set(Object.keys(skilldata));
const GRADES = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];
const STAT_FIELDS = ['speed', 'stamina', 'power', 'guts', 'wisdom'];

for (const [group, names] of Object.entries(GROUPS)) {
	test(`${group} builds the frozen uma`, (t) => {
		t.deepEqual(umaFromRead(mergeReads(names.map(fixture))), frozen(group), 'the merged read builds what was frozen');
		t.end();
	});
}

test('every frozen build is a build the app would accept', (t) => {
	for (const group of Object.keys(GROUPS)) {
		const draft = frozen(group);
		for (const field of STAT_FIELDS) t.ok(Number.isInteger(draft[field]) && draft[field] >= 1 && draft[field] <= 2000, `${group} ${field} ${draft[field]}`);
		for (const field of ['distanceAptitude', 'surfaceAptitude', 'strategyAptitude']) t.ok(GRADES.includes(draft[field]), `${group} ${field} ${draft[field]}`);
		t.ok(['Nige', 'Senkou', 'Sasi', 'Oikomi'].includes(draft.strategy), `${group} strategy ${draft.strategy}`);
		t.ok(draft.starCount >= 1 && draft.starCount <= 5, `${group} starCount ${draft.starCount}`);
		t.ok(draft.uniqueLv >= 1 && draft.uniqueLv <= 6, `${group} uniqueLv ${draft.uniqueLv}`);
		t.ok(draft.mood >= -2 && draft.mood <= 2, `${group} mood ${draft.mood}`);
		t.equal(draft.outfitId, '', `${group} leaves the outfit to the review screen`);
		for (const id of draft.skills) t.ok(KNOWN_IDS.has(id), `${group} offers ${id}, which the app knows`);
		t.deepEqual(draft.skills.filter((id: string, at: number) => draft.skills.indexOf(id) !== at), [], `${group} reads every skill once`);
	}
	t.end();
});

// Read off the screens by hand. Only these two captures have a list known apart from the reader, so only
// they can show that nothing extra was accepted.
const BY_HAND: Record<string, string[]> = {
	'oguri-cap-starlight-beat': ['Triumphant Pulse', 'Shooting for Victory!', 'Budding Blossom', 'Right-Handed', 'Firm Conditions', 'Professor of Curvature', 'No Stopping Me!', 'Sprint Corners', 'Sprinting Gear', 'Straight Descent', 'Pace Chaser Corners', 'Pace Chaser Savvy', 'Uma Stan', 'Groundwork', 'Neck and Neck', 'Burning Spirit SPD', 'Ignited Spirit PWR'],
	'taiki-shuttle-bubblegum-steam-top': ['Joyful Voyage!', 'Shooting Star', 'Budding Blossom', 'Standard Distance', 'Corner Adept', 'Straightaway Adept', 'Speed Star', 'Mile Maven', 'Mile Corners', 'Shifting Gears', 'Pace Chaser Straightaways', 'Pace Chaser Corners', 'Uma Stan', 'Tail Held High'],
};

test('the two hand-written skill lists come out whole', (t) => {
	for (const [capture, names] of Object.entries(BY_HAND)) {
		const rows = fixture(capture).skills ?? [];
		t.equal(rows.length, names.length, `${capture} read exactly ${names.length} rows`);
		for (const name of names) {
			const want = splitMarker(name).base;
			t.ok(rows.some((row) => splitMarker(row.name).base === want), `${capture} has ${name}`);
		}
	}
	t.end();
});

test('a level chip tells the character own unique from the inherited copy', (t) => {
	const owns = (group: string, id: string) => frozen(group).skills.includes(id);
	t.ok(owns('oguri-starlight-beat', '100061') && !owns('oguri-starlight-beat', '900061'), 'oguri takes Triumphant Pulse 100061');
	t.ok(owns('taiki-bubblegum-steam', '110101') && !owns('taiki-bubblegum-steam', '910101'), 'taiki takes Joyful Voyage! 110101');
	t.ok(owns('daiwa-peak-blue', '10091') && !owns('daiwa-peak-blue', '90091'), 'daiwa takes Red Ace 10091');
	t.ok(owns('daiwa-peak-blue', '900061'), 'daiwa keeps the inherited Triumphant Pulse it shows in its inheritance slot');
	t.end();
});

test('two shots of one dialog add rows without disagreeing', (t) => {
	for (const [group, names] of Object.entries(GROUPS)) {
		if (names.length < 2) continue;
		const [first, second] = names.map(fixture);
		const merged = mergeReads([first, second]);
		t.equal(merged.screenshots, 2, `${group} came from two shots`);
		for (const label of ['Speed', 'Stamina', 'Power', 'Guts', 'Wit']) {
			t.equal(first.stats?.[label], second.stats?.[label], `${group} ${label} read the same in both shots`);
			t.deepEqual(merged.stats[label].other, [], `${group} ${label} has no second answer to show`);
		}
		const rows = (first.skills ?? []).length + (second.skills ?? []).length;
		t.ok(merged.skills.length < rows, `${group} folded ${rows} rows into ${merged.skills.length}`);
		t.deepEqual(merged.epithet.other, [], `${group} read one epithet`);
	}
	t.end();
});

test('the one distance grade is the best of the four shown', (t) => {
	for (const capture of CAPTURES) {
		const aptitudes = fixture(capture).aptitudes ?? {};
		const shown = DISTANCE_KEYS.map((key) => aptitudes[key]).filter((grade): grade is Grade => !!grade);
		const best = [...shown].sort((a, b) => GRADES.indexOf(a) - GRADES.indexOf(b))[0];
		const group = Object.keys(GROUPS).find((name) => GROUPS[name].includes(capture)) ?? '';
		t.equal(frozen(group).distanceAptitude, best, `${capture} takes ${best} from ${shown.join(' ')}`);
	}
	t.end();
});

test('these captures leave no field unread', (t) => {
	for (const capture of CAPTURES) t.deepEqual(gaps(mergeReads([fixture(capture)])), [], `${capture} read every stat and aptitude`);
	t.end();
});
