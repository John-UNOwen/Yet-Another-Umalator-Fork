/**
 * Rules for which skills can possibly fire in a race. Each case names the term it
 * turns on. The last two groups check real skills against the courses the
 * exclusion audit used, and the table the request sends.
 */
import test from 'tape';
import { factOut, raceFacts, describeOut, RaceConditions, RaceCourse } from './focus';
import courseFile from '../../../course_data.json';
import skilldata from '../../../skill_data.json';
import merged from '../../../../globalsim/skills.merged.json';

const courses = courseFile as unknown as Record<string, RaceCourse>;
const skills = skilldata as Record<string, { alternatives?: { condition?: string; precondition?: string }[] }>;
const FIRM: RaceConditions = { ground: 1, weather: 1, season: 1, time: 2 };

const tokyoDirtMile = raceFacts(courses['10611'], FIRM, 'Senkou');
const hanshinDirt = raceFacts(courses['10912'], FIRM, 'Senkou');
const sapporoDirt = raceFacts(courses['10107'], FIRM, 'Senkou');
const niigataSprint = raceFacts(courses['10301'], FIRM, 'Senkou');

const FACT_ATOMS = new Set([
	'running_style', 'distance_type', 'ground_type', 'track_id', 'ground_condition', 'season', 'weather', 'time',
	'up_slope_random', 'down_slope_random', 'all_corner_random', 'corner_random', 'straight_random', 'last_straight_random',
]);
const atomOf = (term: string) => term.split(/[=!<>]/)[0];
const branches = (cond?: string) => (cond ?? '').split('@').map(b => b.split('&').map(t => t.trim()).filter(Boolean)).filter(b => b.length);
const learnableFirst = Object.keys(skills).sort((a, b) =>
	Number(!(a.length === 6 && a[0] === '2')) - Number(!(b.length === 6 && b[0] === '2')) || a.localeCompare(b));

/**
 * The lowest skill id (learnable ids first) where every alternative carries the term
 * in every branch, or in its precondition. One contradicted term then cuts the whole
 * skill, so this is safe for expected-out cases whatever else the condition says.
 */
function outCase(term: string): { id: string; condition: string } {
	for (const id of learnableFirst) {
		const alts = skills[id].alternatives ?? [];
		if (alts.length && alts.every(a => branches(a.precondition).some(b => b.includes(term)) || branches(a.condition).every(b => b.includes(term)))) {
			return { id, condition: alts.map(a => a.condition ?? '').join(' | ') };
		}
	}
	throw new Error(`no skill requires ${term} in every branch`);
}

/**
 * The lowest skill id with one alternative, no precondition and one branch that
 * carries the term, where every other term is runtime state the rules never read.
 * Nothing else in the condition can then interfere, so this is safe for expected-in cases.
 */
function inCase(term: string): { id: string; condition: string } {
	for (const id of learnableFirst) {
		const alts = skills[id].alternatives ?? [];
		if (alts.length !== 1 || alts[0].precondition) continue;
		const br = branches(alts[0].condition);
		if (br.length === 1 && br[0].includes(term) && br[0].every(t => t === term || !FACT_ATOMS.has(atomOf(t)))) {
			return { id, condition: alts[0].condition ?? '' };
		}
	}
	throw new Error(`no skill needs only ${term} among race constants`);
}

test('race constants: a mismatch cuts the skill, a match keeps it', t => {
	// No skill in the table conditions on running_style==5 or time==1, so Oonige is
	// covered through the Nige skills below and time through the one value in use.
	// Going only appears inside OR chains, so it is covered in the OR group.
	const cases: [string, boolean, string][] = [
		['running_style==1', true, 'a Nige skill at a Senkou race'],
		['running_style==2', false, 'a Senkou skill at a Senkou race'],
		['distance_type==4', true, 'a Long skill at a mile race'],
		['distance_type==2', false, 'a Mile skill at a mile race'],
		['ground_type==1', true, 'ground_type means surface: turf at a dirt race'],
		['ground_type==2', false, 'dirt at a dirt race'],
		['track_id==10005', true, 'a Nakayama skill at Tokyo'],
		['track_id==10006', false, 'a Tokyo skill at Tokyo'],
		['season==2', true, 'a Summer skill in Spring'],
		['weather==2', true, 'a Cloudy skill in Sun'],
		['time==4', true, 'a Night skill at Midday'],
	];
	for (const [term, expectOut, why] of cases) {
		const { id, condition } = expectOut ? outCase(term) : inCase(term);
		t.equal(factOut(id, tokyoDirtMile) !== null, expectOut, `${why} (${id} ${condition})`);
	}
	t.end();
});

test('running style follows the uma, and Nige and Oonige answer to each other', t => {
	const { id } = outCase('running_style==1');
	t.equal(factOut(id, raceFacts(courses['10611'], FIRM, 'Nige')) !== null, false, `a Nige race keeps ${id}`);
	t.equal(factOut(id, raceFacts(courses['10611'], FIRM, 'Oonige')) !== null, false, 'an Oonige race keeps the Nige skill');
	t.equal(factOut(id, raceFacts(courses['10611'], FIRM, 'Watashi')) !== null, false, 'an unknown style cuts nothing');
	t.end();
});

test('course shape: only the absence of a feature is provable', t => {
	const down = inCase('down_slope_random==1');
	const up = outCase('up_slope_random==1');
	const corner = inCase('all_corner_random==1');
	t.ok(factOut(down.id, hanshinDirt) !== null, `${down.id} out where the course has no downhill`);
	t.equal(factOut(down.id, tokyoDirtMile) !== null, false, `${down.id} kept where it has one`);
	t.ok(factOut(up.id, sapporoDirt) !== null, `${up.id} out where the course has no slopes at all`);
	t.ok(factOut(corner.id, niigataSprint) !== null, `${corner.id} out where the course has no corners`);
	t.equal(factOut(corner.id, tokyoDirtMile) !== null, false, `${corner.id} kept where there are corners`);
	t.end();
});

test('OR and alternatives: one usable branch is enough to keep the skill', t => {
	t.equal(factOut('202401', tokyoDirtMile) !== null, false, 'a short-or-mile condition stays in at a mile race (202401)');
	t.ok(factOut('202401', raceFacts(courses['10810'], FIRM, 'Senkou')) !== null, 'and is out at a long race, where neither branch holds');
	t.ok(factOut('200161', tokyoDirtMile) !== null, 'a Good-or-Soft-or-Heavy skill is out at firm (200161)');
	t.equal(factOut('200161', raceFacts(courses['10611'], { ...FIRM, ground: 3 }, 'Senkou')) !== null, false, 'and kept at Soft');
	t.ok(factOut('202242', tokyoDirtMile) !== null, 'a skill restricted to six named courses is out at a seventh');
	t.equal(factOut('202242', raceFacts(courses['10101'], FIRM, 'Senkou')) !== null, false, 'kept on one of its named courses (10101, Sapporo)');
	const always = Object.keys(skills).sort().find(id => (skills[id].alternatives ?? []).some(a => a.condition === 'always==1'));
	t.ok(always !== undefined, 'the table has an always==1 alternative');
	if (always !== undefined) t.equal(factOut(always, tokyoDirtMile) !== null, false, `always==1 is never out (${always})`);
	t.end();
});

test('anything the rules cannot read keeps the skill', t => {
	const runtime = inCase('phase==1');
	t.equal(factOut(runtime.id, tokyoDirtMile) !== null, false, `a phase condition is runtime state (${runtime.id} ${runtime.condition})`);
	const threshold = inCase('order_rate<=50');
	t.equal(factOut(threshold.id, tokyoDirtMile) !== null, false, `a threshold is not an exact requirement (${threshold.id} ${threshold.condition})`);
	t.equal(factOut('999999', tokyoDirtMile), null, 'an unknown skill id keeps');
	t.equal(factOut('200042', []), null, 'no fact sets prove nothing');
	t.end();
});

test('a run scoring several scenarios keeps anything usable in one of them', t => {
	const firmOnly = outCase('ground_condition==1');
	const soft = raceFacts(courses['10611'], { ...FIRM, ground: 3 }, 'Senkou');
	t.ok(factOut(firmOnly.id, soft) !== null, `${firmOnly.id} needs firm, so it is out at Soft`);
	t.equal(factOut(firmOnly.id, [soft, tokyoDirtMile]) !== null, false, 'kept when another scenario is firm');
	t.end();
});

test('the audited exclusions and the plan shape cases reproduce', t => {
	const cases: [string, string, boolean][] = [
		['200042', '10611', true],
		['201342', '10912', true],
		['201342', '10611', false],
		['200391', '10107', true],
		['200391', '10611', false],
		['200331', '10301', true],
		['200331', '10611', false],
	];
	for (const [id, courseId, expectOut] of cases) {
		t.equal(factOut(id, raceFacts(courses[courseId], FIRM, 'Senkou')) !== null, expectOut, `${id} at course ${courseId} out=${expectOut}`);
	}
	t.end();
});

test('the pool filters the table the request sends', t => {
	// The merged table adds engine fields to each alternative. The rules read only the
	// condition and the precondition, so those are what must agree.
	type Alt = { condition?: string; precondition?: string };
	const mergedSkills = merged as Record<string, { alternatives?: Alt[] }>;
	const terms = (alts?: Alt[]) => JSON.stringify((alts ?? []).map(a => [a.precondition ?? '', a.condition ?? '']));
	const learnableCovered = Object.keys(mergedSkills).filter(id => id.length === 6 && id[0] === '2' && skills[id]);
	const differ = learnableCovered.filter(id => terms(mergedSkills[id].alternatives) !== terms(skills[id].alternatives));
	t.ok(learnableCovered.length > 400, `${learnableCovered.length} learnable skills are in both tables`);
	t.deepEqual(differ, [], 'globalsim/skills.merged.json carries the same conditions as skill_data.json');
	t.end();
});

test('exclusion text says what the skill needs', t => {
	t.equal(describeOut('track_id==10005'), 'needs a different racecourse', 'track term');
	t.equal(describeOut('down_slope_random==1'), 'needs a downhill stretch, and this course has none', 'shape term');
	t.equal(describeOut('running_style_count_same>=2'), 'needs running_style_count_same>=2', 'an unknown atom falls back to the term');
	t.end();
});

test('the pool split accounts for every skill, and the position band no longer cuts', async t => {
	(globalThis as any).CC_GLOBAL = true;
	const { partitionPool, applyExclusions, getBaseSkillsToTest, getActivateableSkills } = await import('../../skill-chart-utils');
	const { buildRaceParameters } = await import('../../simulation-utils');
	const uma: any = {
		speed: 1200, stamina: 800, power: 900, guts: 500, wisdom: 900, strategy: 'Senkou',
		distanceAptitude: 'A', surfaceAptitude: 'A', strategyAptitude: 'A', mood: 2,
	};
	const conds = { ground: 1, weather: 1, season: 1, time: 2 };
	const course = (courseFile as any)['10611'];
	const base = getBaseSkillsToTest(uma, false);
	const known = new Set(Object.keys(merged as object));
	const split = partitionPool(base, uma, course, conds, known);
	const outIds = split.out.map(e => e.id);
	t.equal(split.kept.length + outIds.length, base.length, `${base.length} skills: ${split.kept.length} kept, ${outIds.length} listed out`);
	t.deepEqual([...split.kept, ...outIds].sort(), [...base].sort(), 'every skill is either kept or has a line in the list');
	t.ok(split.out.every(e => e.reason.length > 0), 'every line has a reason');
	t.ok(split.out.some(e => e.kind === 'fact') && split.out.every(e => e.kind !== 'fact' || factOut(e.id, tokyoDirtMile) === e.term), 'fact lines carry the factOut term');

	// The old path cut by the strategy's position band, the split does not.
	const banded = new Set(getActivateableSkills(base, uma, course, buildRaceParameters(1, 1, 1, 2, 'Senkou') as any));
	const bandOnly = split.kept.filter(id => !banded.has(id));
	t.comment(`${bandOnly.length} skill(s) kept now that the old position band dropped`);

	t.deepEqual(applyExclusions(split.kept, split.out, true, new Set()), split.kept, 'focus on: the kept list');
	const anyFact = split.out.find(e => e.kind === 'fact')!.id;
	t.ok(applyExclusions(split.kept, split.out, true, new Set([anyFact])).includes(anyFact), 'include anyway puts one skill back');
	const off = applyExclusions(split.kept, split.out, false, new Set());
	t.equal(off.length, split.kept.length + split.out.filter(e => e.kind !== 'engine').length, 'focus off: everything but engine gaps is back');
	t.end();
});

test('the pool follows the focus running style', async t => {
	(globalThis as any).CC_GLOBAL = true;
	const { partitionPool, getBaseSkillsToTest } = await import('../../skill-chart-utils');
	const uma: any = {
		speed: 1200, stamina: 800, power: 900, guts: 500, wisdom: 900, strategy: 'Senkou',
		distanceAptitude: 'A', surfaceAptitude: 'A', strategyAptitude: 'A', mood: 2,
	};
	const base = getBaseSkillsToTest(uma, false);
	const known = new Set(Object.keys(merged as object));
	const course = (courseFile as any)['10611'];
	const split = (strategy: string) => partitionPool(base, { ...uma, strategy }, course, FIRM, known);
	const senkou = split('Senkou');
	const nige = split('Nige');
	const oonige = split('Oonige');
	const keptOf = (s: typeof senkou) => new Set(s.kept);

	const moved = base.filter(id => keptOf(senkou).has(id) !== keptOf(nige).has(id));
	t.ok(moved.length > 0, `the focus style moves ${moved.length} skills between Senkou and Nige`);
	// factOut's running_style term and the window check's style-shaped atoms are the
	// only reasons a skill may move, not ground, track, season, engine or parse.
	const styleReason = (s: typeof senkou, id: string) => {
		const e = s.out.find(x => x.id === id);
		return !e || e.kind === 'window' || (e.kind === 'fact' && (e.term ?? '').startsWith('running_style'));
	};
	t.ok(moved.every(id => styleReason(senkou, id) && styleReason(nige, id)),
		'moved skills: ' + moved.slice(0, 6)
			.map(id => `${id} ${senkou.out.find(e => e.id === id)?.kind ?? 'kept'}/${nige.out.find(e => e.id === id)?.kind ?? 'kept'}`)
			.join(' , '));
	const nigeOnly = [...keptOf(nige)].filter(id => !keptOf(senkou).has(id));
	const senkouOnly = [...keptOf(senkou)].filter(id => !keptOf(nige).has(id));
	t.ok(nigeOnly.length > 0, `a Nige focus keeps ${nigeOnly.length} skills a Senkou focus cuts`);
	t.ok(senkouOnly.length > 0, `a Senkou focus keeps ${senkouOnly.length} skills a Nige focus cuts`);
	t.ok(nigeOnly.every(id => keptOf(oonige).has(id)), 'the Nige/Oonige alias keeps those under Oonige too');
	t.end();
});
