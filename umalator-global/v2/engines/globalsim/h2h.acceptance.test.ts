/**
 * Head-to-head compare layout tests (both umas + 7 mobs, mirrored gate pairs).
 *
 * Run: npm run test:globalsim-h2h  (from the repo root; ~2-3 min — the e2e
 * section drives the REAL globalsim-wasm pkg, same bridge as
 * compare.acceptance.test.ts).
 *
 * Coverage:
 *   (1) units: buildH2hMobField gates/count, mergeH2hField indices,
 *       addPairH2H averaging + placing(2·n)/HP(per race)/rushing(per seed).
 *   (2) job shape: 2 mirrored jobs per gate group, distinct setupKeys,
 *       playerHorseIndex ≠ secondPlayerIndex, unique gates 0..8.
 *   (3) e2e (real wasm): every seed pairs (2 races each), margins finite,
 *       determinism (same seed list twice → identical margins), placing
 *       histograms sum to 2·n, a speed skill on UMA 2 shifts the mean
 *       positive, and the representative snapshot carries BOTH players.
 */

(globalThis as any).CC_GLOBAL = true;

import test from 'tape';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { HorseState, SkillSet } from '../../../../components/HorseDefTypes';
import { GroundCondition, Weather, Season, Time } from '../../../../uma-skill-tools/RaceParameters';
import { parseMobPresets, buildH2hMobField, FIELD_SIZE } from './mobs';
import type { WorkerFactory, WorkerLike } from './pool';
import { createGlobalsimWorkerCore, WasmApi } from './workerCore';
import { runGlobalsimCompare, buildCompareJobs, mergeH2hField, GlobalsimCompareInput, GlobalsimCompareResults } from './compare';
import { newAggregate, addPairH2H, summarizeAggregate, SeedCompactRecord } from './metrics';

// ── engine fixtures (mirrors compare.acceptance.test.ts) ────────────────────

const repoRoot = path.resolve(__dirname, '../../../../');
const pkgDir = path.join(repoRoot, 'globalsim-wasm', 'pkg');
const geomDir = path.join(repoRoot, 'vendor', 'GlobalSim', 'data', 'course_geometry');
const courseIds: string[] = Object.keys(require(path.join(repoRoot, 'vendor/GlobalSim/data/course_data.json')));
const mobPreset = parseMobPresets(require('./mob-presets.json')).presets['default'];
const mergedTable = require(path.join(repoRoot, 'globalsim/skills.json'));
const knownSkillIds = new Set<string>(Object.keys(mergedTable));

const COURSE = '10504';
const DISTANCE = 2000;
const BASE_SEED = 771103;

let instances = 0;
async function loadPkgFresh(): Promise<WasmApi> {
	const dynImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>;
	const mod = await dynImport(pathToFileURL(path.join(pkgDir, 'globalsim_wasm.js')).href + `?w=${instances++}`);
	const init = mod.default ?? mod.init;
	await init(fs.readFileSync(path.join(pkgDir, 'globalsim_wasm_bg.wasm')));
	return {
		register_geometry: (courseId: number, jsonText: string) => mod.register_geometry(courseId, jsonText),
		PreparedRace: mod.PreparedRace,
		setSkillTable: (text: string) => mod.set_skill_table(text),
	};
}

function bridgeFactory(): WorkerFactory {
	return (): WorkerLike => {
		const msgCbs: ((e: { data: any }) => void)[] = [];
		let dead = false;
		const core = createGlobalsimWorkerCore({
			postMessage: (m) => queueMicrotask(() => { if (!dead) for (const cb of msgCbs) cb({ data: m }); }),
			loadWasm: loadPkgFresh,
			fetchText: (url) => fs.promises.readFile(path.join(geomDir, path.basename(url)), 'utf8'),
		});
		return {
			postMessage: (m: any) => queueMicrotask(() => { if (!dead) core.onMessage(m); }),
			addEventListener: (type: string, cb: any) => { if (type === 'message') msgCbs.push(cb); },
			terminate: () => { dead = true; },
		};
	};
}

function baseHorse(): HorseState {
	return new HorseState({
		speed: 1000, stamina: 1000, power: 900, guts: 800, wisdom: 900,
		strategy: 'Senkou', distanceAptitude: 'A', surfaceAptitude: 'A', strategyAptitude: 'A', mood: 2,
	});
}
function horseWithSkills(ids: string[]): HorseState {
	return baseHorse().set('skills', SkillSet(ids));
}

function compareInput(uma1: HorseState, uma2: HorseState, over: Partial<GlobalsimCompareInput> = {}): GlobalsimCompareInput {
	return {
		uma1, uma2,
		courseId: COURSE, distance: DISTANCE,
		ground: GroundCondition.Good, weather: Weather.Sunny, season: Season.Spring, time: Time.Midday,
		knownSkillIds, courseIds, mobPreset,
		// Mobs now carry modern skills: without the merged table the worker
		// falls back to the engine's bundled v70 table and prepare fails.
		skillData: mergedTable,
		fieldLayout: 'h2h',
		seedBase: BASE_SEED, sampleCount: 40,
		threads: 2,
		workerFactory: bridgeFactory(),
		...over,
	} as GlobalsimCompareInput;
}

// ── (1) units ────────────────────────────────────────────────────────────────

test('(1a) buildH2hMobField: 7 mobs, gates fill around the player pair', t => {
	const { mobs, errors } = buildH2hMobField(mobPreset, 3, 4);
	t.equal(errors.length, 0, 'no errors for gates 3/4');
	t.equal(mobs.length, FIELD_SIZE - 2, 'exactly 7 mobs');
	const gates = mobs.map(m => m.gateIndex).sort((a, b) => a - b);
	t.deepEqual(gates, [0, 1, 2, 5, 6, 7, 8], 'mobs take every gate except 3 and 4');
	const dup = buildH2hMobField(mobPreset, 5, 5);
	t.ok(dup.errors.some(e => e.message.includes('cannot share')), 'same-gate pair rejected');
	t.ok(buildH2hMobField(mobPreset, -1, 2).errors.length > 0, 'negative gate rejected');
	t.ok(buildH2hMobField(mobPreset, 0, 9).errors.length > 0, 'out-of-range gate rejected');
	t.end();
});

test('(1b) mergeH2hField: canonical order + player indices', t => {
	const mk = (g: number) => ({ gateIndex: g, tag: `g${g}` });
	const p = mk(7), s = mk(2);
	const mobs = [mk(0), mk(1), mk(3), mk(4), mk(5), mk(6), mk(8)];
	const merged = mergeH2hField(p, s, mobs);
	t.equal(merged.horses.length, 9, '9 horses');
	t.deepEqual(merged.horses.map((r: any) => r.gateIndex), [0, 1, 2, 3, 4, 5, 6, 7, 8], 'ascending gate order');
	t.equal(merged.playerIndex, 7, 'primary at index 7 (gate 7)');
	t.equal(merged.secondPlayerIndex, 2, 'secondary at index 2 (gate 2)');
	t.notEqual(merged.playerIndex, merged.secondPlayerIndex, 'indices differ');
	t.end();
});

test('(1c) addPairH2H: averaged margin, 2n placings, per-race HP, seed-level rushing', t => {
	const rec = (o: Partial<SeedCompactRecord>): SeedCompactRecord => ({ seed: 1, finishTimeRaw: 120, finishOrder: 3, hpEmptyOnRace: false, rushingStartCount: 0, ...o });
	const agg = newAggregate();
	// Race A: uma1 finishes 120.000, uma2 119.500 (uma2 ahead). Race B mirrors
	// exactly (uma1 119.500, uma2 120.000), so the combined margin is a
	// sub-nanometre cancellation → normalized to a tie.
	addPairH2H(agg,
		[rec({}), rec({ finishTimeRaw: 119.5 })],
		[rec({ finishTimeRaw: 119.5 }), rec({})],
		2000);
	t.equal(agg.n, 1, 'one paired seed');
	t.equal(agg.margins[0], 0, 'mirror-exact margins normalize to exactly 0 (sub-nanometre noise = tie)');
	t.equal(agg.methodCounts.tie, 1, 'sub-noise combined margin counted as tie');
	t.equal(agg.placing1[3], 2, 'uma1 ran both races → 2 placing samples');
	t.equal(agg.placing2[3], 2, 'uma2 likewise');
	t.deepEqual([agg.hpEmptyN1, agg.hpEmptyN2], [2, 2], 'HP counted per race, against each uma (2 races each)');
	// Finding 38: an uma that empties HP in both of its races reads 100%, not 50%.
	const hp = newAggregate();
	addPairH2H(hp,
		[rec({ hpEmptyOnRace: true }), rec({ finishTimeRaw: 119.5 })],
		[rec({ finishTimeRaw: 119.5 }), rec({ hpEmptyOnRace: true })],
		2000);
	const hs = summarizeAggregate(hp);
	t.deepEqual([hs.hpEmptyRate1, hs.hpEmptyRate2], [0.5, 0.5], 'one empty race of two, per uma');
	addPairH2H(hp,
		[rec({ hpEmptyOnRace: true }), rec({ finishTimeRaw: 119.5 })],
		[rec({ finishTimeRaw: 119.5, hpEmptyOnRace: true }), rec({})],
		2000);
	t.equal(summarizeAggregate(hp).hpEmptyRate1, 0.75, 'uma1: 3 empty races of 4');
	t.deepEqual([agg.fullSpurtN1, agg.fullSpurtN2], [0, 0], 'no spurt verdicts on these records');
	// Full spurt counts each uma's own player race: race A for uma1, race B for uma2.
	const spurt = newAggregate();
	addPairH2H(spurt,
		[rec({ fullSpurt: true }), rec({ fullSpurt: true })],
		[rec({ finishTimeRaw: 119.5, fullSpurt: false }), rec({ fullSpurt: false, finishTimeRaw: 119.5 })],
		2000);
	t.deepEqual([spurt.fullSpurt1, spurt.fullSpurtN1, spurt.fullSpurt2, spurt.fullSpurtN2], [1, 1, 0, 1], 'player races only');
	// Rushing is seed-level: race A uma2 rushed, race B uma2 did not → one flag.
	addPairH2H(agg,
		[rec({}), rec({ rushingStartCount: 2 })],
		[rec({ finishTimeRaw: 119 }), rec({})],
		2000);
	t.equal(agg.rushSeeds2, 1, 'rushing counted once per seed');
	t.equal(agg.rushStarts2, 2, 'start counts summed across both races');
	t.equal(agg.placing2[3], 4, 'uma2 placings grow by two races per seed');
	const s = summarizeAggregate(agg);
	t.equal(s.n, 2, 'summary counts seeds, not races');
	t.end();
});

// ── (2) job shape ────────────────────────────────────────────────────────────

test('(2) h2h jobs: mirrored variants, distinct setupKeys, valid indices', t => {
	// Distinct speed marks the two builds so the mirror swap is observable.
	const h1 = baseHorse();
	const h2 = new HorseState({
		speed: 1200, stamina: 1000, power: 900, guts: 800, wisdom: 900,
		strategy: 'Senkou', distanceAptitude: 'A', surfaceAptitude: 'A', strategyAptitude: 'A', mood: 2,
	});
	const input = compareInput(h1, h2, { fixedGate: 2, sampleCount: 3 });
	const { jobs, errors } = buildCompareJobs(input, [101, 102, 103], 'compact');
	t.equal(errors.length, 0, 'no build errors');
	t.equal(jobs.length, 2, 'fixed gate: one chunk per mirrored variant');
	t.equal(new Set(jobs.map(j => j.setupKey)).size, 2, 'the two variants get distinct setupKeys');
	for (const j of jobs) {
		const req = j.request as any;
		t.equal(req.horses.length, 9, '9 runners');
		t.notEqual(j.secondPlayerIndex, undefined, 'secondPlayerIndex set');
		t.notEqual(j.secondPlayerIndex, req.playerHorseIndex, 'players at different indices');
		const gates = req.horses.map((r: any) => r.gateIndex).sort((a: number, b: number) => a - b);
		t.deepEqual(gates, [0, 1, 2, 3, 4, 5, 6, 7, 8], 'unique gates 0..8');
		// Both variants keep the PRIMARY at the base gate 2 and the secondary
		// at the mirror gate 3 — what swaps is WHICH uma is the primary.
		t.equal(req.horses[req.playerHorseIndex].gateIndex, 2, 'primary on the base gate');
		t.equal(req.horses[j.secondPlayerIndex!].gateIndex, 3, 'secondary on the mirror gate');
		const primarySpeed = req.horses[req.playerHorseIndex].speed;
		const secondarySpeed = req.horses[j.secondPlayerIndex!].speed;
		if (j.id.startsWith('0|')) {
			t.deepEqual([primarySpeed, secondarySpeed], [1000, 1200], 'variant 0: UMA 1 primary at gate 2, UMA 2 at 3');
		} else {
			t.deepEqual([primarySpeed, secondarySpeed], [1200, 1000], 'variant 1 (mirror): UMA 2 at gate 2, UMA 1 at 3');
		}
	}
	t.end();
});

// ── (3) e2e against the real engine ──────────────────────────────────────────

let runH2H: GlobalsimCompareResults;
test('(3a) h2h e2e: every seed pairs, margins finite, 2n placings', async t => {
	const h = horseWithSkills(['100011', '100031', '200011', '100051']);
	runH2H = await runGlobalsimCompare(compareInput(h, h, { sampleCount: 40 }));
	const gs = runH2H.globalsim;
	t.equal(gs.fieldLayout, 'h2h', 'stats block reports the layout');
	t.equal(gs.doneSeeds, 40, 'all 40 seeds paired (each = 2 mirrored races)');
	t.equal(gs.seedErrors, 0, 'no per-seed engine errors');
	t.equal(gs.jobErrors.length, 0, 'no chunk failures');
	t.ok(runH2H.results.every(m => Number.isFinite(m)), 'every margin finite');
	t.equal(gs.placing1.reduce((a, b) => a + b, 0), 80, 'uma1 placing histogram sums to 2·n');
	t.equal(gs.placing2.reduce((a, b) => a + b, 0), 80, 'uma2 likewise');
	t.end();
}, { timeout: 420000 } as any);

test('(3b) determinism: same seed list twice ⇒ identical margins', async t => {
	const h = horseWithSkills(['100011', '100031', '200011', '100051']);
	const again = await runGlobalsimCompare(compareInput(h, h, { sampleCount: 40 }));
	t.deepEqual(again.results, runH2H.results, 'margin arrays byte-identical');
	t.end();
}, { timeout: 420000 } as any);

test('(3c) speed skill on UMA 2 shifts the mean h2h margin positive', async t => {
	const h1 = horseWithSkills(['100011', '100031', '100051']);
	const h2 = horseWithSkills(['100011', '100031', '100051', '200011']);
	const res = await runGlobalsimCompare(compareInput(h1, h2, { sampleCount: 120, threads: 4 }));
	const gs = res.globalsim;
	const m = res.results.reduce((a, b) => a + b, 0) / res.results.length;
	t.ok(res.results.length === 120, 'all 120 seeds paired');
	t.ok(m > 0, `mean margin positive with the buff on UMA 2 (got ${m.toFixed(2)} L)`);
	t.ok(gs.doneSeeds === 120, 'doneSeeds 120');
	t.end();
}, { timeout: 600000 } as any);

test('(3d) representative snapshot carries both players from the shared race', t => {
	const anySnap: any = runH2H.runData.medianrun ?? runH2H.runData.minrun;
	t.ok(anySnap, 'a frame-bearing representative snapshot exists');
	t.equal(anySnap.t.length, 2, 'two runner arrays (UMA 1 primary, UMA 2 opp)');
	t.ok(anySnap.t[0].length > 10 && anySnap.t[1].length > 10, 'both halves have real frames');
	t.ok(anySnap.sk[0] instanceof Map && anySnap.sk[1] instanceof Map, 'skill maps for both players');
	t.end();
});
