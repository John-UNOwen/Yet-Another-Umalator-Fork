/**
 * Tests for the GlobalSim input adapter (Phase 1).
 *
 * Run: npm run test:globalsim  (from the repo root)
 *
 * Covers: enum mapping tables, HorseState → runner mapping (raw stats, unique
 * skill + uniqueLv, canonical skill order, forced-position warning), canonical
 * field order / playerHorseIndex, validation failures, and the engine-level
 * acceptance from the plan: feeding the adapter the equivalent of the horses in
 * vendor/GlobalSim/examples/v77-race.jsonl must produce a request whose engine
 * output equals the raw example's (pinned in ./v77-golden.json, 5 seeds, via
 * globalsim-wasm's native_ref).
 */

// HorseDefTypes' Record defaults reference the build-time constant CC_GLOBAL
// (esbuild defines it in app builds). Statements before imports stay in source
// order in the emitted CommonJS, so this runs before the module loads below.
(globalThis as any).CC_GLOBAL = true;

import test from 'tape';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { Map as ImmMap } from 'immutable';

import { HorseState, SkillSet, uniqueSkillForUma } from '../../../../components/HorseDefTypes';
import { GroundCondition, Weather, Season, Time, Grade } from '../../../../uma-skill-tools/RaceParameters';
import {
	AdapterConfig, AdapterError, AdapterResult, buildGlobalSimRequest, canonicalSkillOrder, toGlobalSimRunner,
	GROUND_TO_GLOBALSIM, WEATHER_TO_GLOBALSIM, SEASON_TO_GLOBALSIM, TIME_TO_GLOBALSIM, GRADE_TO_GLOBALSIM,
} from './adapter';

// ── fixtures / config ────────────────────────────────────────────────────────

const repoRoot = path.resolve(__dirname, '../../../../');
// GlobalSim's bundled course table: in the app this list is fetched as config;
// here it is required straight from the pinned submodule.
const courseIds = Object.keys(require(path.join(repoRoot, 'vendor/GlobalSim/data/course_data.json')));
const CONFIG: AdapterConfig = { courseIds };

const golden = require('./v77-golden.json');
const geometryFile = path.join(repoRoot, 'vendor/GlobalSim/data', 'course_geometry', `${golden.courseId}.json`);
// Rust emits no .exe outside Windows — CI (ubuntu) builds plain binaries.
const EXE = process.platform === 'win32' ? '.exe' : '';
const nativeRef = path.join(repoRoot, 'globalsim-wasm', 'target', 'release', 'examples', `native_ref${EXE}`);

const EXAMPLE_HORSE = {
	speed: 1000, stamina: 1000, power: 1000, guts: 800, wisdom: 900,
	strategy: 'Senkou', distanceAptitude: 'A', surfaceAptitude: 'A', strategyAptitude: 'A', mood: 2,
} as const;

/** A HorseState built exactly like the app builds them (Record + SkillSet). */
function horse(over: Partial<Record<keyof typeof EXAMPLE_HORSE | 'outfitId' | 'starCount' | 'uniqueLv', any>> = {}): HorseState {
	return new HorseState({ ...EXAMPLE_HORSE, ...over }).set('skills', SkillSet([]));
}

function errCodes(res: AdapterResult<any>): string[] {
	// `=== true`: strictNullChecks is off in this repo, so a bare `res.ok` check
	// does not narrow the discriminated union.
	return res.ok === true ? [] : res.errors.map(e => e.code);
}

// ── 1. enum mapping tables ───────────────────────────────────────────────────

test('ground enum maps to GlobalSim strings', t => {
	t.equal(GROUND_TO_GLOBALSIM[GroundCondition.Good], 'Good', 'Good(1)=良/Firm → Good');
	t.equal(GROUND_TO_GLOBALSIM[GroundCondition.Yielding], 'Yielding', 'Yielding(2)=稍重 → Yielding');
	t.equal(GROUND_TO_GLOBALSIM[GroundCondition.Soft], 'Soft', 'Soft(3)=重 → Soft');
	t.equal(GROUND_TO_GLOBALSIM[GroundCondition.Heavy], 'Heavy', 'Heavy(4)=不良 → Heavy');
	t.notOk(GROUND_TO_GLOBALSIM[0] ?? GROUND_TO_GLOBALSIM[5], 'out-of-range ground has no mapping');
	t.end();
});

test('weather enum maps to GlobalSim strings', t => {
	t.equal(WEATHER_TO_GLOBALSIM[Weather.Sunny], 'Sunny');
	t.equal(WEATHER_TO_GLOBALSIM[Weather.Cloudy], 'Cloudy');
	t.equal(WEATHER_TO_GLOBALSIM[Weather.Rainy], 'Rainy');
	t.equal(WEATHER_TO_GLOBALSIM[Weather.Snowy], 'Snowy');
	t.notOk(WEATHER_TO_GLOBALSIM[5]);
	t.end();
});

test('season enum maps to GlobalSim strings (incl. Sakura)', t => {
	t.equal(SEASON_TO_GLOBALSIM[Season.Spring], 'Spring');
	t.equal(SEASON_TO_GLOBALSIM[Season.Summer], 'Summer');
	t.equal(SEASON_TO_GLOBALSIM[Season.Autumn], 'Autumn');
	t.equal(SEASON_TO_GLOBALSIM[Season.Winter], 'Winter');
	t.equal(SEASON_TO_GLOBALSIM[Season.Sakura], 'Sakura');
	t.notOk(SEASON_TO_GLOBALSIM[6]);
	t.end();
});

test('time enum maps to GlobalSim lowercase strings', t => {
	t.equal(TIME_TO_GLOBALSIM[Time.NoTime], 'none');
	t.equal(TIME_TO_GLOBALSIM[Time.Morning], 'morning');
	t.equal(TIME_TO_GLOBALSIM[Time.Midday], 'midday');
	t.equal(TIME_TO_GLOBALSIM[Time.Evening], 'evening');
	t.equal(TIME_TO_GLOBALSIM[Time.Night], 'night');
	t.notOk(TIME_TO_GLOBALSIM[5]);
	t.end();
});

test('grade enum maps to GlobalSim grade strings', t => {
	t.equal(GRADE_TO_GLOBALSIM[Grade.G1], 'g1');
	t.equal(GRADE_TO_GLOBALSIM[Grade.G2], 'g2');
	t.equal(GRADE_TO_GLOBALSIM[Grade.G3], 'g3');
	t.equal(GRADE_TO_GLOBALSIM[Grade.OP], 'op');
	t.equal(GRADE_TO_GLOBALSIM[Grade.PreOP], 'preop');
	t.equal(GRADE_TO_GLOBALSIM[Grade.Maiden], 'maiden');
	t.equal(GRADE_TO_GLOBALSIM[Grade.Debut], 'debut');
	t.equal(GRADE_TO_GLOBALSIM[Grade.Daily], 'daily');
	t.notOk(GRADE_TO_GLOBALSIM[Grade.G1 + 1], 'no partial values');
	t.end();
});

// ── 2. HorseState → runner mapping ───────────────────────────────────────────

test('stats pass through raw (no overcap/mood/ground pre-adjustment)', t => {
	const res = toGlobalSimRunner(horse({ speed: 1500, mood: -2 }), 3);
	t.ok(res.ok, 'valid');
	if (res.ok === false) return t.end();
	const r = res.value;
	t.equal(r.speed, 1500, 'overcap 1500 NOT halved to 1350 — the engine does that');
	t.equal(r.mood, -2, 'mood passed through, not folded into stats');
	t.equal(r.guts, EXAMPLE_HORSE.guts, 'unchanged stats untouched');
	t.equal(r.gateIndex, 3);
	t.end();
});

test('unique skill resolved with uniqueLv + isUnique; trainable skills at MEASURED_SKILL_LEVEL', t => {
	const outfitId = '102201';
	const uid = uniqueSkillForUma(outfitId, 3);
	t.equal(uid, '100221', 'uniqueSkillForUma(102201, 3-star) = 100221 (exists in the skill table)');
	// 2-star: the formula yields a nonexistent id → no unique skill at all.
	t.equal(uniqueSkillForUma(outfitId, 2), '', '2-star without a unique skill entry → none');

	const h = new HorseState({ ...EXAMPLE_HORSE, outfitId, starCount: 3 as const, uniqueLv: 2 })
		.set('skills', SkillSet(['100221', '202171', '201251']));
	const res = toGlobalSimRunner(h, 0);
	t.ok(res.ok, 'valid');
	if (res.ok === false) return t.end();
	const expected = [
		{ skillId: '100221', level: 2, isUnique: true },   // unique group 10022 sorts first, uniqueLv wins
		{ skillId: '201251', level: 3, isUnique: false },  // group 20125, MEASURED_SKILL_LEVEL
		{ skillId: '202171', level: 3, isUnique: false },  // group 20217, MEASURED_SKILL_LEVEL
	];
	t.deepEqual(res.value.skills, expected, 'unique level + canonical groupId order');

	// Same outfit at 2 stars: no unique skill, so every entry is trainable.
	const h2 = h.set('starCount', 2 as const);
	const res2 = toGlobalSimRunner(h2, 0);
	t.ok(res2.ok);
	if (res2.ok === true) t.deepEqual(res2.value.skills.map(s => s.level), [3, 3, 3], 'no unique → all trainable');
	t.end();
});

test('canonicalSkillOrder sorts by groupId then numeric skillId', t => {
	// 202181 (group 20218) before 201251 (group 20125)? No — ascending groupId.
	// Within the debuff key trick the ids repeat; duplicates are kept (one per copy).
	const ids = ['202171', '100221', '201241', '201251', '200011'];
	t.deepEqual(canonicalSkillOrder(ids), ['100221', '200011', '201241', '201251', '202171']);
	t.deepEqual(canonicalSkillOrder(['9', '10']), ['9', '10'], 'numeric, not lexicographic');
	t.end();
});

test('forcedSkillPositions are ignored with a flag (no GlobalSim equivalent)', t => {
	const h = horse().set('forcedSkillPositions', ImmMap({ '202171': 450 }));
	const res = toGlobalSimRunner(h, 0);
	t.ok(res.ok, 'still valid');
	if (res.ok === false) return t.end();
	t.deepEqual(res.value.skills, [], 'forced positions produce no skill entries by themselves');
	t.deepEqual(res.warnings.map(w => w.code), ['forced-skill-positions-ignored'], 'warning exposed for the UI');
	t.end();
});

test('runners emitted in canonical order; playerHorseIndex follows the tested uma', t => {
	const runners = [
		{ horse: horse(), gateIndex: 5, isPlayer: true },
		{ horse: horse(), gateIndex: 0 },
		{ horse: horse(), gateIndex: 2 },
	];
	const res = buildGlobalSimRequest({
		courseId: 10504, groundCondition: GroundCondition.Good, weather: Weather.Sunny,
		season: Season.Spring, time: Time.Midday, seed: 1, runners,
	}, CONFIG);
	t.ok(res.ok);
	if (res.ok === false) return t.end();
	const req = res.value as any;
	t.deepEqual(req.horses.map((h: any) => h.gateIndex), [0, 2, 5], 'ascending gateIndex');
	t.equal(req.playerHorseIndex, 2, 'index after canonical ordering, not input order');
	t.end();
});

test('order and playerHorseIndex never depend on the skill lists (paired-draws keying)', t => {
	// pairedRandomStreams keys each runner's engine substreams by its index in
	// request.horses, so the same seed only stays paired across builds while the
	// ordering — and the player index — follow gateIndex alone, whatever skills
	// each runner carries. Every runner here holds an identifying skill, so each
	// emitted horse can be traced back to the input runner it came from.
	const base = {
		courseId: 10504, groundCondition: GroundCondition.Good, weather: Weather.Sunny,
		season: Season.Spring, time: Time.Midday, seed: 7,
	};
	const runner = (gateIndex: number, ids: string[], isPlayer = false) => ({
		horse: horse().set('skills', SkillSet(ids)), gateIndex, isPlayer,
	});
	const skillIds = (h: any) => (h.skills as any[]).map(s => s.skillId);
	const build = (runners: any[]) => {
		const res = buildGlobalSimRequest({ ...base, runners }, CONFIG);
		t.ok(res.ok, 'request valid');
		if (res.ok === false) return null;
		return res.value as any;
	};

	const a = build([
		runner(6, ['200011', '202171'], true), // the tested uma: gate 6, most skills
		runner(1, ['201251']),
		runner(4, ['202181']),
	]);
	if (!a) return t.end();
	t.deepEqual(a.horses.map((h: any) => h.gateIndex), [1, 4, 6], 'ascending gateIndex');
	t.equal(a.playerHorseIndex, 2, 'player position after the gate sort');
	t.deepEqual(skillIds(a.horses[0]), ['201251'], 'gate 1 travels with its own skills');
	t.deepEqual(skillIds(a.horses[1]), ['202181'], 'gate 4 travels with its own skills');
	t.deepEqual(skillIds(a.horses[a.playerHorseIndex]), ['200011', '202171'],
		'playerHorseIndex points at the player horse itself, not just a number');

	// Same gates, same input order, same player — skills redistributed. Neither
	// the emitted order nor playerHorseIndex may react to that.
	const b = build([
		runner(6, [], true),
		runner(1, ['200011', '202171']),
		runner(4, ['201251']),
	]);
	if (!b) return t.end();
	t.deepEqual(b.horses.map((h: any) => h.gateIndex), a.horses.map((h: any) => h.gateIndex),
		'ordering is unchanged when skill lists change');
	t.equal(b.playerHorseIndex, a.playerHorseIndex, 'playerHorseIndex is unchanged when skill lists change');
	t.deepEqual(skillIds(b.horses[0]), ['200011', '202171'], 'the moved skills follow their runner gate');

	// Same field again, player moved to another runner: the index follows the
	// player, so it cannot be an artefact of one fixed gate.
	const c = build([
		runner(6, ['200011', '202171']),
		runner(1, ['201251'], true),
		runner(4, ['202181']),
	]);
	if (!c) return t.end();
	t.deepEqual(c.horses.map((h: any) => h.gateIndex), [1, 4, 6], 'ordering still ascending');
	t.equal(c.playerHorseIndex, 0, 'playerHorseIndex follows the player to gate 1');
	t.deepEqual(skillIds(c.horses[c.playerHorseIndex]), ['201251'], 'and points at that runner');
	t.end();
});

// ── 3. validation failures (typed results, never exceptions) ─────────────────

test('pairedRandomStreams: emitted only when paired; default request byte-identical', t => {
	const input = {
		courseId: 10504, groundCondition: GroundCondition.Good, weather: Weather.Sunny,
		season: Season.Spring, time: Time.Midday, seed: 1,
		runners: [{ horse: horse(), gateIndex: 0, isPlayer: true }],
	};
	const retail = buildGlobalSimRequest(input, CONFIG);
	const explicitOff = buildGlobalSimRequest(input, { ...CONFIG, paired: false });
	const on = buildGlobalSimRequest(input, { ...CONFIG, paired: true });
	t.ok(retail.ok && explicitOff.ok && on.ok, 'all three requests valid');
	if (!retail.ok || !explicitOff.ok || !on.ok) return t.end();
	t.notOk('pairedRandomStreams' in retail.value, 'default config omits the key entirely');
	t.notOk('pairedRandomStreams' in explicitOff.value, 'paired:false also omits it (never emitted as false)');
	t.equal(on.value.pairedRandomStreams, true, 'paired:true emits the flag');
	// The whole point of omitting the key: default traffic is untouched.
	t.equal(JSON.stringify(retail.value), JSON.stringify(explicitOff.value), 'off-request byte-identical to today\'s');
	t.notEqual(JSON.stringify(on.value), JSON.stringify(retail.value), 'paired request differs from retail');
	t.end();
});

test('validation: unknown / malformed course', t => {
	const base = {
		courseId: 10504, groundCondition: GroundCondition.Good, weather: Weather.Sunny,
		season: Season.Spring, time: Time.Midday, seed: 1,
		runners: [{ horse: horse(), gateIndex: 0, isPlayer: true }],
	};
	t.deepEqual(errCodes(buildGlobalSimRequest({ ...base, courseId: 999999 }, CONFIG)), ['unknown-course']);
	t.deepEqual(errCodes(buildGlobalSimRequest({ ...base, courseId: 'abc' }, CONFIG)), ['bad-course']);
	t.deepEqual(errCodes(buildGlobalSimRequest({ ...base, courseId: 0 }, CONFIG)), ['bad-course']);
	t.end();
});

test('validation: bad stats', t => {
	const bad = (speed: any) => toGlobalSimRunner(horse({ speed }), 0);
	t.deepEqual(errCodes(bad(0)), ['bad-stat'], '0 below the [1,2000] raw bound');
	t.deepEqual(errCodes(bad(2001)), ['bad-stat'], '2001 above it');
	t.deepEqual(errCodes(bad(NaN)), ['bad-stat']);
	t.deepEqual(errCodes(bad(Infinity)), ['bad-stat']);
	t.ok(toGlobalSimRunner(horse({ speed: 1 }), 0).ok, '1 accepted');
	t.ok(toGlobalSimRunner(horse({ speed: 2000 }), 0).ok, '2000 accepted');
	t.end();
});

test('validation: bad strategy / aptitude / mood / uniqueLv', t => {
	t.deepEqual(errCodes(toGlobalSimRunner(horse({ strategy: 'Sashi' }), 0)), ['bad-strategy'],
		'the engine alias "Sashi" is not the canonical spelling');
	t.deepEqual(errCodes(toGlobalSimRunner(horse({ surfaceAptitude: 'X' }), 0)), ['bad-aptitude']);
	t.deepEqual(errCodes(toGlobalSimRunner(horse({ mood: 3 }), 0)), ['bad-mood']);
	t.deepEqual(errCodes(toGlobalSimRunner(horse({ mood: 1.5 }), 0)), ['bad-mood']);
	// outfit 102201 (3★) resolves a unique skill; uniqueLv 4 is not a game level.
	const h = new HorseState({ ...EXAMPLE_HORSE, outfitId: '102201', starCount: 3 as const, uniqueLv: 4 });
	t.deepEqual(errCodes(toGlobalSimRunner(h, 0)), ['bad-uniqueLv']);
	t.end();
});

test('validation: malformed and uncovered skills', t => {
	const malformed = horse().set('skills', ImmMap({ '1': 'not-a-skill' }) as any);
	t.deepEqual(errCodes(toGlobalSimRunner(malformed, 0)), ['bad-skill']);

	const withSkill = new HorseState({ ...EXAMPLE_HORSE }).set('skills', SkillSet(['200011']));
	const cov = { ...CONFIG, knownSkillIds: ['202171'] };
	t.deepEqual(errCodes(toGlobalSimRunner(withSkill, 0, cov)), ['unknown-skill'],
		'coverage check rejects skills outside the active table (Phase 2 hook)');
	t.ok(toGlobalSimRunner(withSkill, 0, { ...CONFIG, knownSkillIds: ['200011'] }).ok, 'covered skill passes');
	t.end();
});

test('validation: field-level problems', t => {
	const base = {
		courseId: 10504, groundCondition: GroundCondition.Good, weather: Weather.Sunny,
		season: Season.Spring, time: Time.Midday, seed: 1,
	};
	const one = { horse: horse(), gateIndex: 0, isPlayer: true };
	t.deepEqual(errCodes(buildGlobalSimRequest({ ...base, seed: 2 ** 31, runners: [one] }, CONFIG)), ['bad-seed'],
		'2^31 is not a signed 32-bit seed');
	t.deepEqual(errCodes(buildGlobalSimRequest({ ...base, seed: -2147483648, runners: [one] }, CONFIG)), [], 'i32::MIN accepted');
	t.deepEqual(errCodes(buildGlobalSimRequest({ ...base, runners: [] }, CONFIG)), ['bad-runners', 'multiple-players']);
	t.deepEqual(errCodes(buildGlobalSimRequest({ ...base, runners: [{ horse: horse(), gateIndex: 0 }] }, CONFIG)), ['multiple-players'], 'no player');
	t.deepEqual(errCodes(buildGlobalSimRequest({
		...base, runners: [one, { horse: horse(), gateIndex: 0, isPlayer: true }],
	}, CONFIG)), ['multiple-players', 'bad-gate'], 'two players + duplicate gate');
	t.end();
});

// ── 4. engine acceptance: adapter output == example output (native_ref) ──────

test('v77 example horses round-trip through the adapter to identical engine output', t => {
	if (!fs.existsSync(nativeRef)) {
		t.skip(`native_ref.exe not built — run: cargo build --release --example native_ref (see globalsim-wasm/README.md)`);
		t.end();
		return;
	}
	const seeds: number[] = golden.seeds;

	// The synthetic field equivalent to examples/v77-race.jsonl's nine horses:
	// same stats/aptitudes/strategy/mood/gateIndex and no skills.
	const runners = Array.from({ length: 9 }, (_, gate) => ({
		horse: new HorseState({ ...EXAMPLE_HORSE, outfitId: '', mood: 2 as const }).set('skills', SkillSet([])),
		gateIndex: gate,
		isPlayer: gate === 0,
	}));
	const res = buildGlobalSimRequest({
		courseId: golden.courseId, groundCondition: GroundCondition.Good, weather: Weather.Sunny,
		season: Season.Spring, time: Time.Midday, grade: Grade.G1, seed: 12345, runners,
	}, CONFIG);
	t.ok(res.ok, 'adapter request valid');
	if (res.ok === false) { t.fail(JSON.stringify(res.errors)); return t.end(); }
	const req = res.value;
	t.deepEqual(res.warnings, [], 'no warnings for the example field');
	// The request must carry the validated v77 profile (plan §5 Phase 1).
	for (const k of ['laneSelectionVersion', 'raceInitializationVersion', 'positionKeepVersion', 'skillValueVersion', 'raceContextVersion', 'experimentalRetailInitialization', 'experimentalRetailSections', 'experimentalRetailRuntime', 'experimentalRetailGeometry', 'dataSignature']) {
		t.ok(k in req, `profile key ${k} merged into the request`);
	}

	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'globalsim-adapter-'));
	test.onFinish(() => fs.rmSync(tmp, { recursive: true, force: true }));

	// (a) the adapter-built request; (b) the raw example request as a control —
	// both must reproduce the committed golden for every seed.
	const adapterFile = path.join(tmp, 'adapter-request.json');
	fs.writeFileSync(adapterFile, JSON.stringify(req));
	const exampleFile = path.join(tmp, 'example-request.json');
	fs.copyFileSync(path.join(repoRoot, 'vendor/GlobalSim/examples/v77-race.jsonl'), exampleFile);

	const runNative = (requestFile: string) => {
		const r = spawnSync(nativeRef, [requestFile, geometryFile], {
			input: seeds.join('\n') + '\n', maxBuffer: 4 * 1024 * 1024 * 1024, encoding: 'utf8',
		});
		if (r.status !== 0) throw new Error(`native_ref failed: ${String(r.stderr).slice(0, 500)}`);
		return r.stdout.split('\n').filter((l: string) => l.length > 0);
	};

	const check = (label: string, lines: string[]) => {
		t.equal(lines.length, seeds.length, `${label}: one reply per seed`);
		lines.forEach((line, i) => {
			const v = JSON.parse(line); // "replies parse"
			const g = golden.replies[i];
			t.equal(crypto.createHash('sha256').update(line, 'utf8').digest('hex'), g.sha256, `${label}: seed ${seeds[i]} reply byte-identical (sha256)`);
			t.deepEqual(v.results.map((x: any) => x.finishTimeRaw), g.finishTimeRaw, `${label}: seed ${seeds[i]} finishTimeRaw`);
			t.deepEqual(v.results.map((x: any) => x.finishOrder), g.finishOrder, `${label}: seed ${seeds[i]} finishOrder`);
			t.equal(v.playerLastSpurtTime, g.playerLastSpurtTime, `${label}: seed ${seeds[i]} playerLastSpurtTime`);
		});
	};

	try {
		check('adapter', runNative(adapterFile));
		check('example-control', runNative(exampleFile));
	} catch (e: any) {
		t.fail(e.message);
	}
	t.end();
});
