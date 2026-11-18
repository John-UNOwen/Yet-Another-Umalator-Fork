// Replays the five corpus scans frozen in test/ocr-corpus/fixtures, so the merge and the build are checked
// over real screenshots without the OCR models. Regenerating them: test/ocr-corpus/README.md.

import test from 'tape';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Grade } from './aptitudes';
import type { AptitudeKey } from './layout';
import { DISTANCE_KEYS, umaFromRead } from './build';
import { splitMarker } from './matcher';
import { gaps, mergeReads } from './merge';
import type { Read } from './merge';

const root = join(__dirname, '..', '..');
const fixture = (name: string): Read => JSON.parse(readFileSync(join(root, 'test/ocr-corpus/fixtures', `${name}.json`), 'utf8')).read;
const frozen = (group: string) => JSON.parse(readFileSync(join(root, 'test/ocr-corpus/golden', `${group}.json`), 'utf8'));

const skilldata = JSON.parse(readFileSync(join(root, 'umalator-global/skill_data.json'), 'utf8')) as Record<string, unknown>;
const KNOWN_IDS = new Set(Object.keys(skilldata));
const GRADES = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];
const STAT_FIELDS = ['speed', 'stamina', 'power', 'guts', 'wisdom'];
const BEST = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];

/** One capture as a person read it off the screen: the five stats, the ten aptitude letters, the header,
 *  the level on the unique skill's chip, and every skill row shown. */
interface Hand {
	stats: [number, number, number, number, number];
	aptitudes: Partial<Record<AptitudeKey, Grade>>;
	epithet: string;
	name: string;
	uniqueLevel: number;
	skills: string[];
}

const HAND: Record<string, Hand> = {
	'copano-rickey-eightfold-fortune': {
		stats: [1622, 613, 1208, 597, 1266],
		aptitudes: { turf: 'E', dirt: 'A', short: 'C', mile: 'S', medium: 'A', long: 'G', nige: 'A', senkou: 'A', sashi: 'C', oikomi: 'G' },
		epithet: '[Eightfold☆Fortune]', name: 'Copano Rickey', uniqueLevel: 4,
		skills: ['Luck Runs My Way', 'Angling and Scheming', 'Wet Conditions', 'Professor of Curvature', 'Mile Maven', 'Top Runner', 'Groundwork', 'Slipstream', 'Chance of Victory', 'Muddy', 'Victoria por plancha', 'Standard Distance', 'Winter Runner', 'Taking the Lead', 'Speed Eater', 'Front Runner Savvy', 'Tail Held High', 'See Ya Later!', 'Solid Steps'],
	},
	'grass-wonder-stone-piercing-blue': {
		stats: [1615, 667, 1159, 591, 1235],
		aptitudes: { turf: 'A', dirt: 'F', short: 'G', mile: 'A', medium: 'A', long: 'A', nige: 'F', senkou: 'A', sashi: 'A', oikomi: 'F' },
		epithet: '[Stone-Piercing Blue]', name: 'Grass Wonder', uniqueLevel: 6,
		skills: ['Where There\'s a Will, There\'s a Way', 'Let\'s Pump Some Iron!', 'Right-Handed', 'Straightaway Adept', 'Nimble Navigator', 'Position Pilfer', 'Outer Swell', 'Late Surger Savvy', 'See Ya Later!', 'Leap Forward', 'Triumphant Pulse', 'Moving Past, and Beyond', 'Professor of Curvature', 'Ramp Up', 'Go with the Flow', 'On Your Left!', '1,500,000 CC', 'Uma Stan', 'Take the Chance'],
	},
	'narita-taishin-nevertheless': {
		stats: [1537, 611, 1228, 672, 1201],
		aptitudes: { turf: 'A', dirt: 'A', short: 'F', mile: 'S', medium: 'A', long: 'A', nige: 'G', senkou: 'F', sashi: 'B', oikomi: 'A' },
		epithet: '[Nevertheless]', name: 'Narita Taishin', uniqueLevel: 5,
		skills: ['Nemesis', 'Tokyo Racecourse', 'Winter Runner', 'Nimble Navigator', 'Acceleration', 'End Closer Corners', 'See Ya Later!', 'Pumped', 'Full Tilt', 'Ignited Spirit SPD', 'White Lightning Comin\' Through!', 'Standard Distance', 'Corner Adept', 'Encroaching Shadow', 'End Closer Straightaways', 'Slipstream', 'Daring Strike', 'Comeback', 'Razor-Sharp Steps'],
	},
	'oguri-cap-starlight-beat': {
		stats: [1601, 754, 1239, 566, 1056],
		aptitudes: { turf: 'A', dirt: 'A', short: 'E', mile: 'A', medium: 'A', long: 'B', nige: 'F', senkou: 'A', sashi: 'A', oikomi: 'D' },
		// The reader lost the `l` and the closing bracket: "[Staright Beatl". Opening bracket plus shape is
		// what the outfit lookup works with, so that is what is asserted here.
		epithet: '[Staright Beatl', name: 'Oguri Cap', uniqueLevel: 5,
		skills: ['Triumphant Pulse', 'Moving Past, and Beyond', 'Spring Runner', 'Straightaway Adept', 'Nimble Navigator', 'Slick Surge', 'Medium Straightaways', 'Late Surger Corners', 'Late Surger Savvy', 'Come What May', 'Leap Forward', 'Let\'s Pump Some Iron!', 'Right-Handed', 'Professor of Curvature', 'Ramp Up', 'Position Pilfer', 'Outer Swell', 'Late Surger Straightaways', '1,500,000 CC', 'See Ya Later!', 'Restraint'],
	},
	'taiki-shuttle-bubblegum': {
		stats: [1635, 627, 1234, 530, 1131],
		aptitudes: { turf: 'A', dirt: 'A', short: 'A', mile: 'S', medium: 'E', long: 'G', nige: 'C', senkou: 'A', sashi: 'E', oikomi: 'G' },
		epithet: '[Bubblegum☆Memories]', name: 'Taiki Shuttle', uniqueLevel: 3,
		skills: ['Joyful Voyage!', 'Victoria por plancha', 'Tokyo Racecourse', 'Straightaway Adept', 'Mile Maven', 'Shifting Gears', 'Pace Chaser Corners', 'Neck and Neck', 'Unstoppable', 'Lights of Vaudeville', 'Budding Blossom', 'Professor of Curvature', 'Nimble Navigator', 'Mile Corners', 'Pace Chaser Straightaways', 'See Ya Later!', 'Full Tilt'],
	},
};

// Every skill row on the five screens has an offered name now. Rows whose marker the OCR read as the letter O
// stay a choice between the tiers, and the build takes the first of them, so `Muddy ◎` lands on 202342.

for (const capture of Object.keys(HAND)) {
	test(`${capture} builds the frozen uma`, (t) => {
		t.deepEqual(umaFromRead(mergeReads([fixture(capture)])), frozen(capture), 'the read builds what was frozen');
		t.end();
	});
}

test('the frozen builds are what the screens say', (t) => {
	for (const [capture, hand] of Object.entries(HAND)) {
		const merged = mergeReads([fixture(capture)]);
		const draft = frozen(capture);
		const seen = [draft.speed, draft.stamina, draft.power, draft.guts, draft.wisdom];
		t.deepEqual(seen, hand.stats, `${capture} read the five stats as seen`);
		for (const [key, want] of Object.entries(hand.aptitudes)) {
			t.equal(merged.aptitudes[key as AptitudeKey].value, want, `${capture} ${key} ${want}`);
			t.deepEqual(merged.aptitudes[key as AptitudeKey].other, [], `${capture} ${key} read once`);
		}
		t.equal(merged.epithet.value, hand.epithet, `${capture} epithet ${hand.epithet}`);
		t.equal(merged.name.value, hand.name, `${capture} name ${hand.name}`);
		t.equal(draft.uniqueLv, hand.uniqueLevel, `${capture} unique level from its chip`);
	}
	t.end();
});

test('the hand-written skill lists come out whole', (t) => {
	for (const [capture, hand] of Object.entries(HAND)) {
		const rows = fixture(capture).skills ?? [];
		t.equal(rows.length, hand.skills.length, `${capture} read all ${hand.skills.length} rows on the screen, and no others`);
		for (const name of hand.skills) {
			const base = splitMarker(name).base;
			t.ok(rows.some((row) => splitMarker(row.name).base === base), `${capture} has ${name}`);
		}
	}
	t.end();
});

test('a level chip tells the character own unique from the inherited copy', (t) => {
	const owns = (capture: string, id: string) => frozen(capture).skills.includes(id);
	t.ok(owns('oguri-cap-starlight-beat', '100061') && !owns('oguri-cap-starlight-beat', '900061'), 'oguri takes Triumphant Pulse 100061 from its Lvl 5 chip');
	t.ok(owns('grass-wonder-stone-piercing-blue', '900061') && !owns('grass-wonder-stone-piercing-blue', '100061'), 'grass wonder shows the inherited Triumphant Pulse in its inheritance slot, so it takes 900061');
	t.ok(owns('taiki-shuttle-bubblegum', '110101') && !owns('taiki-shuttle-bubblegum', '910101'), 'taiki takes Joyful Voyage! 110101 from its Lvl 3 chip');
	t.ok(owns('grass-wonder-stone-piercing-blue', '100111'), 'grass wonder takes its own Where There\'s a Will, There\'s a Way 100111');
	t.ok(owns('narita-taishin-nevertheless', '100501'), 'narita taishin takes Nemesis 100501');
	t.ok(owns('copano-rickey-eightfold-fortune', '100981'), 'copano rickey takes Luck Runs My Way 100981');
	t.end();
});

test('the one distance grade is the best of the four shown', (t) => {
	for (const capture of Object.keys(HAND)) {
		const aptitudes = fixture(capture).aptitudes ?? {};
		const shown = DISTANCE_KEYS.map((key) => aptitudes[key]).filter((grade): grade is Grade => !!grade);
		t.equal(shown.length, 4, `${capture} showed all four distance cells`);
		const best = [...shown].sort((a, b) => BEST.indexOf(a) - BEST.indexOf(b))[0];
		t.equal(frozen(capture).distanceAptitude, best, `${capture} takes ${best} from ${shown.join(' ')}`);
	}
	t.end();
});

test('these captures leave no field unread', (t) => {
	for (const capture of Object.keys(HAND)) t.deepEqual(gaps(mergeReads([fixture(capture)])), [], `${capture} read every stat and aptitude`);
	t.end();
});

test('every frozen build is a build the app would accept', (t) => {
	for (const capture of Object.keys(HAND)) {
		const draft = frozen(capture);
		for (const field of STAT_FIELDS) t.ok(Number.isInteger(draft[field]) && draft[field] >= 1 && draft[field] <= 2000, `${capture} ${field} ${draft[field]}`);
		for (const field of ['distanceAptitude', 'surfaceAptitude', 'strategyAptitude']) t.ok(GRADES.includes(draft[field]), `${capture} ${field} ${draft[field]}`);
		t.ok(['Nige', 'Senkou', 'Sasi', 'Oikomi'].includes(draft.strategy), `${capture} strategy ${draft.strategy}`);
		t.ok(draft.starCount >= 1 && draft.starCount <= 5, `${capture} starCount ${draft.starCount}`);
		t.ok(draft.uniqueLv >= 1 && draft.uniqueLv <= 6, `${capture} uniqueLv ${draft.uniqueLv}`);
		t.ok(draft.mood >= -2 && draft.mood <= 2, `${capture} mood ${draft.mood}`);
		t.equal(draft.outfitId, '', `${capture} leaves the outfit to the review screen`);
		for (const id of draft.skills) t.ok(KNOWN_IDS.has(id), `${capture} offers ${id}, which the app knows`);
		t.deepEqual(draft.skills.filter((id: string, at: number) => draft.skills.indexOf(id) !== at), [], `${capture} reads every skill once`);
	}
	t.end();
});
