/**
 * Hachimi career-dump import tests: the field mapping (aptitude collapse, running
 * style, mood, star level, unique level), the owned/offered split, hint levels from
 * the per-skill sources, budget, and the warnings for everything the dump cannot give.
 *
 * Run via: npm run test:career-import
 */
// (globalThis).CC_GLOBAL must exist before the imports below are required:
// skill-chart-utils reaches HorseDefTypes, whose Record defaults read this
// esbuild-time constant (see adapter.test.ts's note).
(globalThis as any).CC_GLOBAL = true;

import test from 'tape';
import skilldata from '../skill_data.json';
import skillmeta from '../../skill_meta.json';
import careerUnbuyable from '../career-unbuyable.json';
import careerCardSkills from '../career-card-skills.json';
import {
	isCareerDump, isUmadumpCareer, isUmadumpManifest, convertCareerDump,
	CAREER_DUMP_KIND, UMADUMP_ARCHIVE_TYPE,
} from './career-import';

/** A real outfit so the outfit-lookup warning stays quiet in the base fixture. */
const OUTFIT = '101002';
const UNIQUE = '110101';      // a character unique skill, group 11010
const SILVER = '200161';      // group 20016, base cost 110
const GOLD = '200162';        // same group, base cost 90
const OTHER_GROUP = '200331'; // group 20033, hinted only by the group table

const row = (id: string, over: Record<string, unknown> = {}) => ({
	SkillId: Number(id), Level: 1, IsGet: 0, HintLv: 0,
	CalcNeedPoint: 100, OriginNeedPoint: 100, ...over,
});

function dump(over: Record<string, unknown> = {}) {
	return {
		kind: CAREER_DUMP_KIND,
		version: 1,
		skillPoint: 2948,
		character: { charaId: 1010, cardId: Number(OUTFIT), motivation: 5, limitBreakCount: 4 },
		stats: { speed: 1600, stamina: 626, power: 1319, guts: 627, wiz: 990, hp: 60, maxHp: 104 },
		aptitudes: {
			distanceShort: 7, distanceMile: 8, distanceMiddle: 3, distanceLong: 1,
			groundTurf: 7, groundDirt: 7,
			runningStyle: 2, styleNige: 5, styleSenko: 7, styleSashi: 3, styleOikomi: 1,
		},
		skillRowsObserved: {
			count: 4,
			rows: [
				row(UNIQUE, { IsGet: 1, Level: 3, CalcNeedPoint: 0, OriginNeedPoint: 0 }),
				row(SILVER, { HintLv: 2, CalcNeedPoint: 88, OriginNeedPoint: 110 }),
				row(GOLD, { HintLv: 2, CalcNeedPoint: 72, OriginNeedPoint: 90 }),
				row(OTHER_GROUP),
			],
		},
		skillHints: { count: 2, shown: 2, items: [{ GroupId: 20033, Level: 5, Rarity: 1 }] },
		skillTipsObserved: {},
		...over,
	};
}

for (const id of [OUTFIT, UNIQUE, SILVER, GOLD, OTHER_GROUP]) {
	if (id !== OUTFIT && !(skilldata as Record<string, any>)[id]) {
		throw new Error(`test fixture bug: ${id} is not in the local skill table`);
	}
}

test('rejects anything that is not a career dump', (t) => {
	t.notOk(isCareerDump(null), 'null is not a dump');
	t.notOk(isCareerDump({ outfitId: '101002', speed: 1200 }), 'an exported uma is not a dump');
	t.equal(convertCareerDump({ speed: 1 }), null, 'convert returns null for the wrong shape');
	t.end();
});

test('maps the uma: outfit, stars, stats, aptitudes, style, mood', (t) => {
	const imp = convertCareerDump(dump())!;
	t.equal(imp.uma.outfitId, OUTFIT, 'outfitId is the dump cardId');
	t.equal(imp.uma.starCount, 5, '4 limit breaks = 5 stars');
	t.equal(imp.uma.speed, 1600, 'speed');
	t.equal(imp.uma.wisdom, 990, 'wiz maps to wisdom');
	t.equal(imp.uma.distanceAptitude, 'S', 'best of the four distances (mile 8 = S)');
	t.equal(imp.uma.surfaceAptitude, 'A', 'turf 7 = A');
	t.equal(imp.uma.strategy, 'Senkou', 'runningStyle 2 = Senkou');
	t.equal(imp.uma.strategyAptitude, 'A', 'the running style’s own grade (senko 7 = A)');
	t.equal(imp.uma.mood, 2, 'motivation 5 (Max) = mood 2');
	t.notOk(imp.warnings.length, `no warnings for a complete dump: ${imp.warnings.join(' | ')}`);
	t.ok(imp.summary.includes('Senkou') && imp.summary.includes('2948 SP'), 'summary names the build and the SP');
	t.end();
});

// Checkup 50: motivation 0 (None) and 1 both became the lowest mood.
test('mood: 1 to 5 map to -2 to 2, 0 and off-scale values leave it with a warning', (t) => {
	const moodOf = (motivation: number) => convertCareerDump(dump({ character: { charaId: 1010, cardId: Number(OUTFIT), motivation, limitBreakCount: 4 } }))!;
	t.equal(moodOf(1).uma.mood, -2, 'motivation 1 = mood -2');
	t.equal(moodOf(3).uma.mood, 0, 'motivation 3 = mood 0');
	for (const m of [0, 7]) {
		const imp = moodOf(m);
		t.equal(imp.uma.mood, undefined, `motivation ${m}: the mood is left as it was`);
		t.ok(imp.warnings.some(w => w.includes(`Motivation ${m}`)), `motivation ${m}: and a warning says so`);
	}
	t.end();
});

// Checkup 49: a stats object with holes printed "undefined" in the summary.
test('a partly readable stats object shows ? for the missing stats', (t) => {
	const imp = convertCareerDump(dump({ stats: { speed: 1200 } }))!;
	t.ok(imp.summary.includes('1200/?/?/?/?'), `summary: ${imp.summary}`);
	t.notOk(imp.summary.includes('undefined'), 'never the word undefined');
	t.end();
});

// Checkup finding 48: a cut row list replaced the build's skills with no word.
test('a truncated skill row list is reported', (t) => {
	const base = dump();
	const cut = convertCareerDump(dump({ skillRowsObserved: { ...base.skillRowsObserved, count: 97 } }))!;
	t.ok(cut.warnings.some((w) => w.includes('truncated') && w.includes('4 of 97')), `warned: ${cut.warnings.join(' | ')}`);
	const whole = convertCareerDump(dump({
		skillRowsObserved: { ...base.skillRowsObserved, count: 97 },
		skillLearningScreen: { count: 4, rows: base.skillRowsObserved.rows },
	}))!;
	t.notOk(whole.warnings.some((w) => w.includes('skill rows arrived truncated')), 'one complete source is enough');
	t.notOk(convertCareerDump(dump())!.warnings.length, 'a complete dump stays quiet');
	t.end();
});

test('splits owned from offered and reads the unique level', (t) => {
	const imp = convertCareerDump(dump())!;
	t.same(imp.owned, [UNIQUE], 'only IsGet=1 is owned');
	t.same(imp.uma.skills, [UNIQUE], 'owned skills go onto the uma');
	t.equal(imp.uma.uniqueLv, 3, 'the unique skill row level becomes uniqueLv');
	t.same(imp.offered, [SILVER, GOLD, OTHER_GROUP], 'the rest is the offer pool');
	t.equal(imp.budget, 2948, 'SP budget from skillPoint');
	t.end();
});

test('the unique level is read for every outfit, not only 11xxxx ids', (t) => {
	// Outfit 01's unique is 100xxx (HorseDefTypes uniqueSkillForUma), so an
	// 11xxxx-only rule lost its level.
	const first = convertCareerDump(dump({
		character: { charaId: 1010, cardId: 101001, motivation: 5, limitBreakCount: 4 },
		skillRowsObserved: { count: 1, rows: [row('100101', { IsGet: 1, Level: 4 })] },
	}))!;
	t.equal(first.uma.uniqueLv, 4, 'outfit 101001: row 100101 sets uniqueLv');
	// Another outfit's unique is just an owned skill: it must not set the level.
	const other = convertCareerDump(dump({
		skillRowsObserved: { count: 1, rows: [row('100101', { IsGet: 1, Level: 4 })] },
	}))!;
	t.equal(other.uma.uniqueLv, undefined, 'outfit 101002 ignores outfit 101001\'s unique');
	t.end();
});

test('hint levels are read per skill, never spread over a group', (t) => {
	const imp = convertCareerDump(dump())!;
	t.equal(imp.hints.get(SILVER), 2, 'row HintLv used for a row skill');
	t.equal(imp.hints.get(GOLD), 2, 'and for its pair');
	t.notOk(imp.hints.has(OTHER_GROUP), 'a row reading hint level 0 records nothing');
	t.notOk(imp.hints.has('200332'), 'the group table entry does not stamp the group’s other skills');

	// The per-skill tip discount is the game's own number, so it outranks a row.
	const fromTips = convertCareerDump(dump({
		skillTipsObserved: { [GOLD]: { tipsDiscount: 30 } },
	}))!;
	t.equal(fromTips.hints.get(GOLD), 3, 'tipsDiscount 30 = hint level 3');
	t.ok(fromTips.warnings.some((w) => /discount; the discount was used/.test(w)), 'the row disagreement is reported');

	// A hint level the group table knows but no per-skill source does: not invented.
	const noRow = convertCareerDump(dump({
		skillRowsObserved: { count: 1, rows: [row(SILVER)] },
	}))!;
	t.notOk(noRow.hints.has('200331'), 'the group table alone does not set a level');
	t.end();
});

test('warns about what the dump cannot give', (t) => {
	const noRows = convertCareerDump(dump({ skillRowsObserved: { count: 0, rows: [] } }))!;
	t.ok(noRows.warnings.some((w) => /never opened/.test(w)), 'missing skill rows is a warning, not a failure');
	t.same(noRows.owned, [], 'nothing owned');
	t.equal(noRows.uma.strategy, 'Senkou', 'the uma still imports');

	const unknown = convertCareerDump(dump({
		skillRowsObserved: { count: 1, rows: [row('999999', { IsGet: 1 })] },
	}))!;
	t.ok(unknown.warnings.some((w) => /not in the local skill table/.test(w)), 'unknown skill ids reported');
	t.same(unknown.owned, [], 'unknown ids dropped');

	const truncated = convertCareerDump(dump({
		skillHints: { count: 50, shown: 48, items: [] },
	}))!;
	t.ok(truncated.warnings.some((w) => /48.*no hint level was lost/.test(w)),
		'the 48-item cap is reported, and the per-skill discounts say nothing was lost');

	const truncatedBlind = convertCareerDump(dump({
		skillRowsObserved: { count: 2, rows: [row(SILVER), row(OTHER_GROUP, { HintLv: undefined })] },
		skillHints: { count: 50, shown: 48, items: [] },
	}))!;
	t.ok(truncatedBlind.warnings.some((w) => /have no hint level from any source/.test(w)),
		'and a real hole is called out as a hole');

	const noSp = convertCareerDump(dump({ skillPoint: '<unreadable>' }))!;
	t.equal(noSp.budget, null, 'unreadable SP leaves the budget alone');
	t.ok(noSp.warnings.some((w) => /Skill points/.test(w)), 'and says so');

	const mismatch = convertCareerDump(dump({
		skillTipsObserved: { [SILVER]: { tipsDiscount: 40 } },
	}))!;
	t.ok(mismatch.warnings.some((w) => /disagrees with their own hint discount/.test(w)), 'row/discount disagreement reported');
	t.equal(mismatch.hints.get(SILVER), 5, 'the per-skill discount wins (40% is level 5)');

	const offLadder = convertCareerDump(dump({
		skillTipsObserved: { [GOLD]: { tipsDiscount: 15 } },
	}))!;
	t.ok(offLadder.warnings.some((w) => /not on the 0\/10\/20\/30\/35\/40 ladder/.test(w)), 'an impossible discount is called out');
	t.equal(offLadder.hints.get(GOLD), 2, 'and the row hint level is used instead');

	const badOutfit = convertCareerDump(dump({
		character: { charaId: 999999, cardId: 99999900, motivation: 5, limitBreakCount: 0 },
	}))!;
	t.ok(badOutfit.warnings.some((w) => /not in the local uma data/.test(w)), 'unknown outfit reported');
	t.equal(badOutfit.uma.outfitId, '99999900', 'and imported anyway');

	const weirdStyle = convertCareerDump(dump({
		aptitudes: {
			distanceShort: 7, distanceMile: 8, distanceMiddle: 3, distanceLong: 1,
			groundTurf: 7, runningStyle: 0, styleNige: 8, styleSenko: 3, styleSashi: 2, styleOikomi: 1,
		},
	}))!;
	t.equal(weirdStyle.uma.strategy, 'Nige', 'unknown style code falls back to the best style grade');
	t.equal(weirdStyle.uma.strategyAptitude, 'S', 'with that grade');

	const v2 = convertCareerDump(dump({ version: 2 }))!;
	t.ok(v2.warnings.some((w) => /version 2/.test(w)), 'an unknown format version warns');
	t.end();
});

test('falls back to the learning-screen window when the union is missing', (t) => {
	const imp = convertCareerDump(dump({
		skillRowsObserved: undefined,
		skillLearningScreen: { topIndex: 0, rows: [row(SILVER), row(GOLD, { IsGet: 1 })] },
	}))!;
	t.same(imp.owned, [GOLD], 'the window still says what is owned');
	t.same(imp.offered, [SILVER], 'and what is offered');
	t.end();
});

// ── umadump career snapshots ────────────────────────────────────────────────

const TIER_GOLD = '200331';     // group 20033, rarity 2
const TIER_SILVER = '200332';   // group 20033, rarity 1
const TIER_SILVER_X = '200333'; // group 20033, rarity 1: Corner Adept ×, never sold
const TIER_PAIR_A = '200131';   // group 20013, rarity 1
const TIER_PAIR_B = '200132';   // group 20013, rarity 1
const NEVER_SOLD = '200133';    // Standard Distance ×, same family, never sold
const OTHER_TIER = '409061';    // Archline Top Scholar, family 20033 rarity 6
const FAM2_GOLD = '200431';     // Concentration, family 20043 rarity 2
const FAM2_SILVER = '200432';   // Focus, family 20043 rarity 1
const FAM2_NEVER = '200433';    // Gatekept, family 20043 rarity 1, never sold
const UNIQUE_GROUP = '11010';   // the family of the fixture uma’s own unique
for (const [id, group, rarity] of [
	[TIER_GOLD, '20033', 2], [TIER_SILVER, '20033', 1], [TIER_SILVER_X, '20033', 1],
	[TIER_PAIR_A, '20013', 1], [TIER_PAIR_B, '20013', 1],
	[NEVER_SOLD, '20013', 1], [OTHER_TIER, '20033', 6],
	[FAM2_GOLD, '20043', 2], [FAM2_SILVER, '20043', 1], [FAM2_NEVER, '20043', 1],
	[UNIQUE, UNIQUE_GROUP, 5],
] as [string, string, number][]) {
	const d = (skilldata as Record<string, any>)[id];
	if (!d || d.rarity !== rarity || String((skillmeta as Record<string, any>)[id]?.groupId) !== group) {
		throw new Error(`test fixture bug: ${id} is not group ${group} rarity ${rarity} in the local skill table`);
	}
}
for (const id of [NEVER_SOLD, FAM2_NEVER]) {
	if (!careerUnbuyable.skills.includes(id)) {
		throw new Error(`test fixture bug: ${id} is not in career-unbuyable.json`);
	}
}
for (const id of [TIER_GOLD, TIER_SILVER, TIER_PAIR_A, FAM2_SILVER]) {
	if (careerUnbuyable.skills.includes(id)) {
		throw new Error(`test fixture bug: ${id} is listed in career-unbuyable.json as never sold`);
	}
}

/** The local ids of one family the game sells, in the order the skill table has them. */
const soldIn = (group: string) => Object.keys(skilldata)
	.filter((id) => String((skillmeta as Record<string, any>)[id]?.groupId) === group)
	.filter((id) => !careerUnbuyable.skills.includes(id))
	.sort((a, b) => Number(a) - Number(b));

/** Mile Maven: a gold the game offers this outfit with no hint tier anywhere. */
const MILE_MAVEN = '200681';

/** What outfit OUTFIT brings into a career: sold, and known to the app's skill table. */
const outfitRungs = ((careerCardSkills as unknown as Record<string, [string, number][]>)[OUTFIT]) ?? [];
const outfitSkills = outfitRungs.map(([id]) => id)
	.filter((id) => !careerUnbuyable.skills.includes(id) && !!(skilldata as Record<string, any>)[id]);
if (!outfitSkills.includes(MILE_MAVEN)) {
	throw new Error(`test fixture bug: outfit ${OUTFIT} no longer brings ${MILE_MAVEN}`);
}

/** The pool the reader should build: these hinted families up to their hinted tier,
 *  plus the outfit's own list. */
const expectedPool = (...hinted: [string, number][]) => [...new Set([
	...hinted.flatMap(([group, top]) => soldIn(group)
		.filter((id) => Number((skilldata as Record<string, any>)[id]?.rarity) <= top)),
	...outfitSkills,
])].sort((a, b) => Number(a) - Number(b));

/**
 * One turn of a career as umadump records it. The keys and the values around them
 * come from a real `turn_078_001.json` of a card 101002 URA Finals career.
 */
function snapshot(charaOver: Record<string, unknown> = {}) {
	return {
		single_mode_load_common: {
			chara_info: {
				single_mode_chara_id: 4845, card_id: Number(OUTFIT), rarity: 4,
				// The awakening level: every rung of the outfit's list is open at 5.
				talent_level: 5,
				speed: 1597, stamina: 570, power: 1235, wiz: 955, guts: 551,
				motivation: 5, fans: 231291, race_running_style: 2,
				proper_ground_turf: 7, proper_ground_dirt: 7,
				proper_running_style_nige: 5, proper_running_style_senko: 7,
				proper_running_style_sashi: 3, proper_running_style_oikomi: 1,
				proper_distance_short: 7, proper_distance_mile: 8,
				proper_distance_middle: 3, proper_distance_long: 2,
				turn: 78, skill_point: 2941, scenario_id: 3, route_id: 4,
				skill_array: [{ skill_id: Number(UNIQUE), level: 4 }],
				skill_tips_array: [
					{ group_id: 20033, rarity: 2, level: 3 },
					{ group_id: 20033, rarity: 1, level: 1 },
					{ group_id: 20013, rarity: 1, level: 5 },
				],
				disable_skill_id_array: [],
				support_card_array: [{ position: 1, support_card_id: 30028, limit_break_count: 4 }],
				race_history: [{ race_program_id: 2218, race_result: 1 }],
				...charaOver,
			},
		},
		live_data_set: { live_performance_info: { vocal: 14 } },
	};
}

test('a umadump snapshot is the other accepted format', (t) => {
	const snap = snapshot();
	t.ok(isUmadumpCareer(snap), 'chara_info marks the format');
	t.notOk(isCareerDump(snap), 'and it is not a Hachimi dump');
	t.ok(convertCareerDump(snap), 'the shared entry point converts it');
	t.notOk(isUmadumpCareer({ single_mode_load_common: {} }), 'an empty payload is not a career');
	t.equal(convertCareerDump({ single_mode_load_common: {} }), null, 'and converts to nothing');
	t.equal(convertCareerDump({ trained_chara_id: 10833, card_id: 101002, skill_array: [] }), null,
		'a finished veteran row is not a career snapshot');

	const manifest = { archive_type: UMADUMP_ARCHIVE_TYPE, identity: { card_id: 101002 } };
	t.ok(isUmadumpManifest(manifest), 'an archive manifest is recognised for what it is');
	t.equal(convertCareerDump(manifest), null, 'and carries no career state');
	t.end();
});

test('maps a snapshot: outfit, stars, stats, aptitudes, style, mood, unique level', (t) => {
	const imp = convertCareerDump(snapshot())!;
	t.equal(imp.uma.outfitId, OUTFIT, 'outfitId is the snapshot card_id');
	t.equal(imp.uma.starCount, 5, 'rarity 4 is 5 stars');
	t.equal(imp.uma.speed, 1597, 'speed');
	t.equal(imp.uma.wisdom, 955, 'wiz maps to wisdom');
	t.equal(imp.uma.distanceAptitude, 'S', 'best of the four distances (mile 8 = S)');
	t.equal(imp.uma.surfaceAptitude, 'A', 'turf 7 = A');
	t.equal(imp.uma.strategy, 'Senkou', 'race_running_style 2 = Senkou');
	t.equal(imp.uma.strategyAptitude, 'A', 'that style’s own grade (senko 7 = A)');
	t.equal(imp.uma.mood, 2, 'motivation 5 (Max) = mood 2');
	t.same(imp.owned, [UNIQUE], 'skill_array is what the trainee has');
	t.same(imp.uma.skills, [UNIQUE], 'and becomes the uma’s skill list');
	t.equal(imp.uma.uniqueLv, 4, 'the unique skill’s level is uniqueLv');
	t.equal(imp.budget, 2941, 'skill_point is the SP budget');
	t.ok(imp.offered.length > 0, 'a snapshot builds a pool from its hint tiers');
	t.same(imp.blocked, [], 'and blocks nothing here');
	t.ok(imp.summary.includes('turn 78') && imp.summary.includes('2941 SP'), 'the summary names the turn and the SP');
	t.notOk(imp.warnings.filter((w) => !/pool comes from the hint tiers/.test(w)).length,
		`the one note is the pool one: ${imp.warnings.join(' | ')}`);
	t.end();
});

test('a snapshot pool is the hinted families plus what the outfit brings', (t) => {
	const imp = convertCareerDump(snapshot())!;
	// The fixture hints family 20013 at rarity 1 and family 20033 at rarities 1 and 2.
	t.same(imp.offered, expectedPool(['20013', 1], ['20033', 2]),
		'the pool is every skill a hinted family sells, plus the outfit’s own list');
	t.ok(imp.offered.includes(TIER_GOLD), 'an id of its own hinted tier is in the pool');
	t.ok(imp.offered.includes(TIER_PAIR_A), 'same for the family hinted at one rarity only');
	t.notOk(imp.offered.includes(OTHER_TIER), 'a tier above every hinted tier of its family stays out');
	t.notOk(imp.offered.includes(NEVER_SOLD), 'a skill the game never sells stays out');
	t.notOk(imp.offered.includes(SILVER), 'a family with no hint tier stays out unless the outfit brings it');
	t.ok(imp.offered.includes(GOLD), 'the outfit brings that same family’s upgrade, so it is in');
	t.end();
});

test('the outfit brings its own skills, with no hint tier anywhere', (t) => {
	const imp = convertCareerDump(snapshot())!;
	const tiers: any[] = (snapshot() as any).single_mode_load_common.chara_info.skill_tips_array;
	t.notOk(tiers.some((x) => Number(x.group_id) === 20068), 'the fixture hints no tier of the Mile Maven family');
	for (const id of [MILE_MAVEN, '200682']) {
		t.ok(imp.offered.includes(id), `${id} is in the pool because the outfit brings it`);
		t.notOk(imp.hints.has(id), `${id} gets no hint level from this file`);
	}
	t.end();
});

test('a hint tier sells the tiers under it, not the ones above it', (t) => {
	const one = convertCareerDump(snapshot({
		skill_tips_array: [{ group_id: Number('20043'), rarity: 1, level: 3 }],
	}))!;
	t.same(one.offered, expectedPool(['20043', 1]), 'the hinted family the game sells is in the pool, plus the outfit’s list');
	t.ok(one.offered.includes(FAM2_SILVER), 'the hinted tier’s own id is in');
	t.notOk(one.offered.includes(FAM2_GOLD), 'the tier above it stays out, the file does not say the upgrade is on offer');
	t.notOk(one.offered.includes(FAM2_NEVER), 'Gatekept shares that tier but the game never sells it');
	t.end();
});

test('a hint tier on an upgrade sells the tiers below it too', (t) => {
	const up = convertCareerDump(snapshot({
		skill_tips_array: [{ group_id: Number('20043'), rarity: 2, level: 3 }],
	}))!;
	t.same(up.offered, expectedPool(['20043', 2]), 'the family the upgrade belongs to is in the pool');
	t.ok(up.offered.includes(FAM2_GOLD), 'the hinted upgrade is in');
	t.ok(up.offered.includes(FAM2_SILVER), 'and so is the tier under it, which the upgrade takes with it');
	t.end();
});

test('the pool leaves out what the career has already learned', (t) => {
	const owned = convertCareerDump(snapshot({
		skill_tips_array: [{ group_id: Number(UNIQUE_GROUP), rarity: 5, level: 2 }],
	}))!;
	t.same(owned.offered, expectedPool(), 'the only family hinted is the uma’s own unique, so the pool is the outfit’s list');
	t.notOk(owned.offered.includes(UNIQUE), 'and what the career has is not offered back');
	t.equal(owned.hints.get(UNIQUE), 2, 'the hint level still lands on that skill');
	t.end();
});

test('the outfit skills follow the awakening level when the snapshot gives it', (t) => {
	const gated = outfitRungs.filter(([, need]) => need > 1).map(([id]) => id).filter((id) => outfitSkills.includes(id));
	if (!gated.length) throw new Error(`test fixture bug: outfit ${OUTFIT} has no skill above awakening level 1`);
	const low = convertCareerDump(snapshot({ talent_level: 1, skill_tips_array: [] }))!;
	t.ok(gated.every((id) => !low.offered.includes(id)), 'at awakening level 1 the higher rungs are not offered');
	t.notOk(low.warnings.some((w) => /awakening level/.test(w)), 'and nothing is said about a level it knows');
	const full = convertCareerDump(snapshot({ talent_level: 5, skill_tips_array: [] }))!;
	t.ok(gated.every((id) => full.offered.includes(id)), 'at level 5 every rung is offered');
	const unknown = convertCareerDump(snapshot({ talent_level: undefined, skill_tips_array: [] }))!;
	t.ok(gated.every((id) => unknown.offered.includes(id)), 'without a level every rung stays in');
	t.ok(unknown.warnings.some((w) => /awakening level/.test(w)), 'and the pane says it could not tell');
	t.end();
});

test('a file that names no offerable skill leaves the pool alone', (t) => {
	const none = convertCareerDump(snapshot({ card_id: 999999, skill_tips_array: [] }))!;
	t.same(none.offered, [], 'no outfit list and no hint tiers means no pool');
	t.ok(none.warnings.some((w) => /the pool was left as it is/.test(w)),
		'and that gets said out loud');
	t.end();
});

test('a snapshot hint tier covers every skill of that group and rarity', (t) => {
	const imp = convertCareerDump(snapshot())!;
	t.equal(imp.hints.get(TIER_GOLD), 3, 'the gold tier entry');
	t.equal(imp.hints.get(TIER_SILVER), 1, 'the silver tier of the same group, tracked apart');
	t.notOk(imp.hints.has(TIER_SILVER_X), 'but not its never-sold ×');
	t.equal(imp.hints.get(TIER_PAIR_A), 5, 'and every id of the other group');
	t.equal(imp.hints.get(TIER_PAIR_B), 5, 'both of a ◎/○ pair');
	t.notOk(imp.hints.has(UNIQUE), 'a skill no tier covers gets no level');

	const clamped = convertCareerDump(snapshot({
		skill_tips_array: [{ group_id: 20033, rarity: 2, level: 9 }],
	}))!;
	t.equal(clamped.hints.get(TIER_GOLD), 5, 'a level past the top of the ladder is clamped');

	const cleared = convertCareerDump(snapshot({
		skill_tips_array: [{ group_id: 20033, rarity: 2, level: 0 }],
	}))!;
	t.equal(cleared.hints.get(TIER_GOLD), 0, 'a tier reported unhinted clears a level left by an earlier import');
	t.end();
});

test('a snapshot hint tier leaves out the skill the game never sells', (t) => {
	// Funabashi Racecourse: ◎ 202211, ○ 202212 and the never-sold × 202213 share group 20221, rarity 1.
	const imp = convertCareerDump(snapshot({ skill_tips_array: [{ group_id: 20221, rarity: 1, level: 3 }] }))!;
	t.equal(imp.hints.get('202211'), 3, 'the ◎ takes the level');
	t.equal(imp.hints.get('202212'), 3, 'and the ○');
	t.notOk(imp.hints.has('202213'), 'the × does not');
	t.end();
});

test('reports what a snapshot cannot give', (t) => {
	const base = convertCareerDump(snapshot())!;
	t.ok(base.warnings.some((w) => /pool comes from the hint tiers/.test(w)), 'the pool rule is a note, not a failure');

	const blocked = convertCareerDump(snapshot({
		disable_skill_id_array: [Number(TIER_SILVER), 999999],
	}))!;
	t.same(blocked.blocked, [TIER_SILVER], 'skills that career cannot learn, local ids only');

	const unknownTier = convertCareerDump(snapshot({
		skill_tips_array: [{ group_id: 999999, rarity: 1, level: 4 }],
	}))!;
	t.equal(unknownTier.hints.size, 0, 'a tier with no local skill sets nothing');
	t.ok(unknownTier.warnings.some((w) => /match no skill/.test(w)), 'and says so');

	const noTips = convertCareerDump(snapshot({ skill_tips_array: undefined }))!;
	t.equal(noTips.hints.size, 0, 'no hint table means no levels');
	t.ok(noTips.warnings.some((w) => /no skill_tips_array/.test(w)), 'and is reported');

	const noSp = convertCareerDump(snapshot({ skill_point: '<unreadable>' }))!;
	t.equal(noSp.budget, null, 'unreadable SP leaves the budget alone');
	t.ok(noSp.warnings.some((w) => /Skill points/.test(w)), 'and says so');

	const noWiz = convertCareerDump(snapshot({ wiz: undefined }))!;
	t.ok(noWiz.warnings.some((w) => /Only 4 of 5 stats/.test(w)), 'a missing stat is reported');

	const noDist = convertCareerDump(snapshot({ proper_distance_long: undefined }))!;
	t.ok(noDist.warnings.some((w) => /Distance aptitudes incomplete/.test(w)), 'a missing distance grade is reported');

	const badOutfit = convertCareerDump(snapshot({ card_id: 99999900 }))!;
	t.ok(badOutfit.warnings.some((w) => /not in the local uma data/.test(w)), 'unknown outfit reported');
	t.equal(badOutfit.uma.outfitId, '99999900', 'and imported anyway');
	t.notOk(badOutfit.uma.uniqueLv, 'with no unique skill of its own to read');

	const unknownSkill = convertCareerDump(snapshot({
		skill_array: [{ skill_id: 999999, level: 1 }],
	}))!;
	t.same(unknownSkill.owned, [], 'unknown skill ids dropped');
	t.ok(unknownSkill.warnings.some((w) => /not in the local skill table/.test(w)), 'and reported');

	const badTips = convertCareerDump(snapshot({
		skill_tips_array: [{ group_id: 20033, rarity: 2, level: '3' }, { group_id: '20013', rarity: 1, level: 5 }],
	}))!;
	t.equal(badTips.hints.size, 0, 'a tier with a field that is not a number sets no level');
	t.ok(badTips.warnings.some((w) => /no readable group, rarity or level/.test(w)), 'and says how many were unreadable');

	const tooHigh = convertCareerDump(snapshot({
		skill_tips_array: [{ group_id: 20033, rarity: 2, level: 9 }],
	}))!;
	t.ok(tooHigh.warnings.some((w) => /past the top of the ladder/.test(w)), 'a clamped hint level is reported too');
	t.end();
});

test('the summary counts hint levels that carry one', (t) => {
	const all = convertCareerDump(snapshot())!;
	t.equal(all.hints.size, 4, 'the three fixture tiers cover four buyable local ids');
	t.ok(all.summary.includes('4 hint levels'), `the summary counts them: ${all.summary}`);

	const one = convertCareerDump(snapshot({ skill_tips_array: [{ group_id: 20033, rarity: 2, level: 4 }] }))!;
	t.equal(one.hints.size, 1, 'the gold tier of group 20033 holds one local id');
	t.ok(one.summary.includes('1 hint level') && !one.summary.includes('1 hint levels'), `singular: ${one.summary}`);

	const none = convertCareerDump(snapshot({ skill_tips_array: [{ group_id: 20033, rarity: 2, level: 0 }] }))!;
	t.equal(none.hints.size, 1, 'the unhinted tier is still written, to clear a stale level');
	t.notOk(/hint level/.test(none.summary), `but it is not counted: ${none.summary}`);
	t.end();
});

test('a career running a style the grade columns lack keeps that style', (t) => {
	// master.mdb has proper_running_style_nige, _senko, _sashi and _oikomi, so an
	// Oonige career has no aptitude to read and the app keeps its own.
	const oonige = convertCareerDump(snapshot({ race_running_style: 5 }))!;
	t.equal(oonige.uma.strategy, 'Oonige', 'style 5 stays Oonige instead of the best other grade');
	t.notOk('strategyAptitude' in oonige.uma, 'no aptitude comes from a column that does not exist');
	t.ok(oonige.warnings.some((w) => /Oonige has no aptitude/.test(w)), 'and the reason is stated');
	t.notOk(oonige.warnings.some((w) => /is unknown/.test(w)), 'the style is not called unknown');
	t.end();
});
