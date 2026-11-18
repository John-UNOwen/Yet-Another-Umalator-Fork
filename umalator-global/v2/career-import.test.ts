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
const TIER_SILVER_2 = '200333'; // group 20033, rarity 1
const TIER_PAIR_A = '200131';   // group 20013, rarity 1
const TIER_PAIR_B = '200132';   // group 20013, rarity 1
for (const [id, group, rarity] of [
	[TIER_GOLD, '20033', 2], [TIER_SILVER, '20033', 1], [TIER_SILVER_2, '20033', 1],
	[TIER_PAIR_A, '20013', 1], [TIER_PAIR_B, '20013', 1],
] as [string, string, number][]) {
	const d = (skilldata as Record<string, any>)[id];
	if (!d || d.rarity !== rarity || String((skillmeta as Record<string, any>)[id]?.groupId) !== group) {
		throw new Error(`test fixture bug: ${id} is not group ${group} rarity ${rarity} in the local skill table`);
	}
}

/**
 * One turn of a career as umadump records it. The keys and the values around them
 * come from a real `turn_078_001.json` of a card 101002 URA Finals career.
 */
function snapshot(charaOver: Record<string, unknown> = {}) {
	return {
		single_mode_load_common: {
			chara_info: {
				single_mode_chara_id: 4845, card_id: Number(OUTFIT), rarity: 4,
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
	t.same(imp.offered, [], 'a snapshot carries no offer list');
	t.same(imp.blocked, [], 'and blocks nothing here');
	t.ok(imp.summary.includes('turn 78') && imp.summary.includes('2941 SP'), 'the summary names the turn and the SP');
	t.notOk(imp.warnings.filter((w) => !/offer list/.test(w)).length,
		`the one note is the offer list one: ${imp.warnings.join(' | ')}`);
	t.end();
});

test('a snapshot hint tier covers every skill of that group and rarity', (t) => {
	const imp = convertCareerDump(snapshot())!;
	t.equal(imp.hints.get(TIER_GOLD), 3, 'the gold tier entry');
	t.equal(imp.hints.get(TIER_SILVER), 1, 'the silver tier of the same group, tracked apart');
	t.equal(imp.hints.get(TIER_SILVER_2), 1, 'including the tier’s other id');
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

test('reports what a snapshot cannot give', (t) => {
	const base = convertCareerDump(snapshot())!;
	t.ok(base.warnings.some((w) => /no skill offer list/.test(w)), 'the missing offer list is a note, not a failure');

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
	t.end();
});
