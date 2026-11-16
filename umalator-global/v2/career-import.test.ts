/**
 * Hachimi career-dump import tests: the field mapping (aptitude collapse, running
 * style, mood, star level, unique level), the owned/offered split, hint levels from
 * both sources, budget, and the warnings for everything the dump cannot give.
 *
 * Run via: npm run test:career-import
 */
// (globalThis).CC_GLOBAL must exist before the imports below are required:
// skill-chart-utils reaches HorseDefTypes, whose Record defaults read this
// esbuild-time constant (see adapter.test.ts's note).
(globalThis as any).CC_GLOBAL = true;

import test from 'tape';
import skilldata from '../skill_data.json';
import { isCareerDump, convertCareerDump, CAREER_DUMP_KIND } from './career-import';

/** A real outfit so the outfit-lookup warning stays quiet in the base fixture. */
const OUTFIT = '101002';
const UNIQUE = '110101';      // a character unique skill, group 11010
const SILVER = '200161';      // group 20016, base cost 110
const GOLD = '200162';        // same group, base cost 90
const OTHER_GROUP = '200331'; // group 20033, reachable only through the hint table

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

test('hint levels come from the rows and from the group table', (t) => {
	const imp = convertCareerDump(dump())!;
	t.equal(imp.hints.get(SILVER), 2, 'row HintLv used for a row skill');
	t.equal(imp.hints.get(GOLD), 2, 'and for its pair');
	for (const id of ['200331', '200332']) {
		t.equal(imp.hints.get(id), 5, `group 20033 expanded to ${id} at level 5`);
	}
	t.notOk(imp.hints.has(UNIQUE), 'a zero hint level is not recorded');
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
	t.ok(truncated.warnings.some((w) => /48/.test(w)), 'the 48-item hint cap is reported');

	const noSp = convertCareerDump(dump({ skillPoint: '<unreadable>' }))!;
	t.equal(noSp.budget, null, 'unreadable SP leaves the budget alone');
	t.ok(noSp.warnings.some((w) => /Skill points/.test(w)), 'and says so');

	const mismatch = convertCareerDump(dump({
		skillTipsObserved: { [SILVER]: { tipsDiscount: 40 } },
	}))!;
	t.ok(mismatch.warnings.some((w) => /does not match their hint level/.test(w)), 'discount/hint-level disagreement reported');
	t.equal(mismatch.hints.get(SILVER), 2, 'the hint level still wins');

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
