/**
 * Evaluator integration tests — REAL workerCore + REAL wasm pkg in-process
 * (same bridge pattern as compact-parity.test.ts, but driven through
 * pool.ts). Covers: cache fill & reuse (no refetch), search/verify seed
 * disjointness (P3), determinism (§13.4), paired anti-symmetry (§6.2),
 * objective math, and a live noise calibration (§7.3).
 *
 * Small on purpose: 40 seeds × 2 builds × 2 passes ≈ a couple of seconds.
 */

// HorseDefTypes reads the build-time define at module scope — ts-node has no bundler.
// (Before any import: TS compiles the import lines to requires in source order.)
(globalThis as any).CC_GLOBAL = true;

import test from 'tape';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { HorseState, SkillSet } from '../../../../../components/HorseDefTypes';
import { GroundCondition, Season, Time, Weather } from '../../../../../uma-skill-tools/RaceParameters';
import { parseMobPresets } from '../mobs';
import { createGlobalsimWorkerCore, WasmApi } from '../workerCore';
import { WorkerFactory, WorkerLike } from '../pool';
import { calculateSkillCost, isPurpleSkill, skillGroups } from '../../../skill-chart-utils';
import { createEvaluator, calibrateNoise, seedValueOf, statsOf } from './evaluator';
import { NS_SEARCH, NS_VERIFY } from './cache';
import { buildSpace, simIdentity } from './space';
import { ScenarioSpec } from './types';
import { leadMarginL } from '../metrics';
import { EffortConfig, STANDARD } from './config';

const repoRoot = path.resolve(__dirname, '../../../../../');
const pkgDir = path.join(repoRoot, 'globalsim-wasm', 'pkg');
const geomDir = path.join(repoRoot, 'vendor', 'GlobalSim', 'data', 'course_geometry');
const courseIds: string[] = Object.keys(require(path.join(repoRoot, 'vendor/GlobalSim/data/course_data.json')));
const mobPreset = parseMobPresets(require('../mob-presets.json')).presets['default'];
const mergedTable = require(path.join(repoRoot, 'globalsim/skills.json'));
const knownSkillIds = new Set<string>(Object.keys(mergedTable));

const COURSE = '10504';
const DISTANCE = 2000;
const BASE_SEED = 20261115;
const GATE = 3;
const SEEDS = 40;

let instances = 0;
async function loadPkgFresh(): Promise<WasmApi> {
	const dynImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>;
	const mod = await dynImport(pathToFileURL(path.join(pkgDir, 'globalsim_wasm.js')).href + `?w=${instances++}`);
	const init = mod.default ?? mod.init;
	await init(fs.readFileSync(path.join(pkgDir, 'globalsim_wasm_bg.wasm')));
	return {
		register_geometry: (courseId: number, jsonText: string) => mod.register_geometry(courseId, jsonText),
		PreparedRace: mod.PreparedRace,
	};
}

/** Fresh in-process workerCore behind the pool's WorkerLike contract. */
const factory: WorkerFactory = () => {
	let closed = false;
	const listeners: Array<(e: { data: any }) => void> = [];
	const core = createGlobalsimWorkerCore({
		postMessage: (m: any) => queueMicrotask(() => { if (!closed) for (const cb of listeners) cb({ data: m }); }),
		loadWasm: loadPkgFresh,
		fetchText: (url: string) => fs.promises.readFile(path.join(geomDir, path.basename(url)), 'utf8'),
	});
	return {
		postMessage: (m: any) => queueMicrotask(() => { if (!closed) core.onMessage(m); }),
		addEventListener: (type: string, cb: any) => { if (type === 'message') listeners.push(cb); },
		terminate: () => { closed = true; },
	};
};

function baseHorse(): HorseState {
	return new HorseState({
		speed: 1000, stamina: 1000, power: 900, guts: 800, wisdom: 900,
		strategy: 'Senkou', distanceAptitude: 'A', surfaceAptitude: 'A', strategyAptitude: 'A', mood: 2,
	}).set('skills', SkillSet([]));
}

/** Four cheap candidates from four different groups (never purple, covered). */
function pickCandidates(excludeGroups: Set<string>): string[] {
	const out: string[] = [];
	for (const [, ids] of skillGroups) {
		if (out.length >= 4) break;
		for (const id of ids) {
			if (isPurpleSkill(id)) continue;
			if (ids[0] !== id) continue; // cheapest tier of this group only
			if (excludeGroups.has(id)) continue;
			if (!knownSkillIds.has(id)) continue;
			if (calculateSkillCost(id, new Map(), new Map()) <= 0) continue;
			out.push(id);
			break;
		}
	}
	return out;
}

const horse = baseHorse();
const candidates = pickCandidates(new Set());
if (candidates.length < 4) throw new Error(`expected 4+ candidates, got ${candidates.length}`);
const space = buildSpace({
	purchasable: candidates, ownedByGroup: new Map(), fixedIds: [], hints: new Map(), budget: 4000,
});
const conds: any = {
	courseId: COURSE, distance: DISTANCE,
	ground: GroundCondition.Good, weather: Weather.Sunny, season: Season.Spring, time: Time.Midday,
	knownSkillIds, courseIds, mobPreset, skillData: mergedTable, fixedGate: GATE,
};
const scenarios: ScenarioSpec[] = [{ id: '0', label: 'test', conds, mobPreset }];

const base = { id: simIdentity(space, []), selection: [] as string[] };
const add1 = { id: simIdentity(space, [candidates[0]]), selection: [candidates[0]] };
const add2 = { id: simIdentity(space, [candidates[1]]), selection: [candidates[1]] };

const mkEval = () => createEvaluator({
	workerFactory: factory, threads: 2, space, baseHorse: horse, scenarios, baseSeed: BASE_SEED, skillData: mergedTable,
});
const positions = Array.from({ length: SEEDS }, (_, i) => i);

// ── pure folding unit tests ──────────────────────────────────────────────────

test('seedValueOf folds records; statsOf drops null leads from ℓ stats only', t => {
	const rec: any = { seed: 1, finishTimeRaw: 120, bestRivalFinishTimeRaw: 119.8, finishOrder: 2, hpEmptyOnRace: false, rushingStartCount: 1, tail: [[0, 1990, 11.5]] };
	const v = seedValueOf(rec, DISTANCE)!;
	t.ok(v !== 'err' && v.win === 0 && v.top3 === 1 && v.placing === 2 && v.rushed === 1, 'flags from finishOrder/HP/rush');
	t.ok(v !== 'err' && v.lead != null && v.lead < 0, 'negative lead when best rival finished first');
	t.equal(v !== 'err' && v.lead, leadMarginL(rec, DISTANCE), 'lead == metrics.leadMarginL');
	const oldPkg: any = { seed: 2, finishTimeRaw: 120, finishOrder: 1 };
	const v2 = seedValueOf(oldPkg, DISTANCE)!;
	t.ok(v2 !== 'err' && v2.lead === null && v2.win === 1, 'old-pkg record: usable placing stats, null lead');
	t.equal(seedValueOf({ seed: 3, error: 'boom' }, DISTANCE), 'err', 'engine error → err');
	const st = statsOf([v, v2, 'err', null]);
	t.equal(st.n, 2, 'null/err excluded from n');
	t.equal(st.lead.n, 1, 'null lead excluded from ℓ statistics only');
	t.end();
});

// ── live engine integration ─────────────────────────────────────────────────

let ev = mkEval();

test('ensure fills the cache exactly once (P7 cache reuse)', async t => {
	await ev.ensure([
		{ ns: NS_SEARCH, scenarioIdx: 0, build: base, positions },
		{ ns: NS_SEARCH, scenarioIdx: 0, build: add1, positions },
	]);
	const a = ev.slots(NS_SEARCH, 0, base.id);
	const b = ev.slots(NS_SEARCH, 0, add1.id);
	t.equal(a.length, SEEDS, 'base slots sized');
	t.ok(a.every(s => s != null && s !== 'err'), 'every base seed measured, none errored');
	t.ok(b.every(s => s != null && s !== 'err'), 'every add1 seed measured');
	t.equal(ev.racesRun(), SEEDS * 2, 'exactly 2×40 races dispatched');
	await ev.ensure([
		{ ns: NS_SEARCH, scenarioIdx: 0, build: base, positions },
		{ ns: NS_SEARCH, scenarioIdx: 0, build: add1, positions },
		{ ns: NS_SEARCH, scenarioIdx: 0, build: add2, positions },
	]);
	t.equal(ev.racesRun(), SEEDS * 3, 'cache hit for base/add1; only add2 ran');
	const st = ev.stats(NS_SEARCH, 0, base);
	t.ok(st && st.n === SEEDS && Number.isFinite(st.lead.mean), 'base stats complete with finite mean lead');
	t.end();
});

test('search vs verify seed lists are disjoint (P3)', t => {
	const s = ev.seeds(NS_SEARCH, 0, 1000);
	const v = ev.seeds(NS_VERIFY, 0, 1000);
	t.equal(new Set(s).size, 1000, 'search list unique');
	t.equal(new Set(v).size, 1000, 'verify list unique');
	t.equal(s.filter(x => v.includes(x)).length, 0, 'zero overlap');
	t.end();
});

test('determinism: identical inputs → identical per-position values', async t => {
	const ev2 = mkEval();
	await ev2.ensure([{ ns: NS_SEARCH, scenarioIdx: 0, build: add2, positions }]);
	const a = ev.slots(NS_SEARCH, 0, add2.id);
	const b = ev2.slots(NS_SEARCH, 0, add2.id);
	t.deepEqual(b, a, 'fresh evaluator (different worker timing) reproduces every value');
	ev2.dispose();
	t.end();
});

test('paired diff is antisymmetric and matches objective values (§6.2)', async t => {
	await ev.ensure([{ ns: NS_SEARCH, scenarioIdx: 0, build: add2, positions }]);
	const pickLead = (x: any) => x.lead;
	const d = ev.paired(NS_SEARCH, 0, add2, base, pickLead);
	const dFlip = ev.paired(NS_SEARCH, 0, base, add2, pickLead);
	t.ok(d && dFlip && Math.abs(d.mean + dFlip.mean) < 1e-9 && d.n === dFlip.n, 'Δ(A−B) = −Δ(B−A)');
	t.ok(d!.n > 0, 'paired over the common seed prefix');
	const objP1 = ev.objective(NS_SEARCH, 0, add2, 'p1');
	const st = ev.stats(NS_SEARCH, 0, add2);
	t.ok(objP1 && st && objP1.mean === st.win.mean && objP1.n === st.n, 'p1 objective == win-rate stats');
	t.end();
});

test('noise calibration runs on the live engine (§7.3)', async t => {
	const cfg: EffortConfig = { ...STANDARD, noiseSeeds: 40, noiseVariants: 2, gSeedsMin: 100 };
	const noise = await calibrateNoise(ev, cfg, 0, base, [add1, add2]);
	t.ok(noise.nSeeds === 40, 'calibrated over the requested seeds');
	t.ok(Number.isFinite(noise.sigmaLead) && noise.sigmaLead > 0, `σ(ℓ) = ${noise.sigmaLead.toFixed(3)} L`);
	t.ok(Number.isFinite(noise.sigmaDeltaLead) && noise.sigmaDeltaLead > 0, `σΔ(ℓ) = ${noise.sigmaDeltaLead.toFixed(3)} L`);
	t.ok(noise.baseP1 >= 0 && noise.baseP1 <= 1, `base P(1st) = ${noise.baseP1.toFixed(3)}`);
	t.ok(noise.resolvedDeltaL > 0 && Number.isFinite(noise.resolvedDeltaL), 'resolved δ reported');
	ev.dispose();
	t.end();
});

// ── locks reach the engine (regression: forced skills charged SP but never simulated) ──

test('locked (include) skills are simulated for EVERY build, empty selection included', async t => {
	const lock = candidates[2];
	// Spy on every message the pool sends to workerCore: the 'prepare' carries
	// the serialized race request — the exact skill list the engine receives.
	const spyMsgs: any[] = [];
	const spyFactory: WorkerFactory = () => {
		const w = factory();
		return {
			postMessage: (m: any) => { spyMsgs.push(m); w.postMessage(m); },
			addEventListener: w.addEventListener.bind(w) as WorkerLike['addEventListener'],
			terminate: () => w.terminate(),
		};
	};
	const lockSpace = buildSpace({
		purchasable: candidates, ownedByGroup: new Map(), fixedIds: [], hints: new Map(), budget: 4000, include: [lock],
	});
	t.equal(lockSpace.error, undefined, 'space built with the lock');
	t.equal(lockSpace.forcedCost, lockSpace.byId.get(lock)!.cost, 'lock cost reserved once');
	const lockBase = { id: simIdentity(lockSpace, []), selection: [] as string[] };
	t.ok(lockBase.id.split(',').includes(lock), 'locked id is part of the base build identity');
	const evLock = createEvaluator({
		workerFactory: spyFactory, threads: 1, space: lockSpace, baseHorse: horse, scenarios, baseSeed: BASE_SEED, skillData: mergedTable,
	});
	await evLock.ensure([{ ns: NS_SEARCH, scenarioIdx: 0, build: lockBase, positions: [0, 1] }]);
	const prepares = spyMsgs.filter(m => m.type === 'prepare');
	t.ok(prepares.length > 0, 'engine received prepare messages');
	const playerSkills = (m: any): string[] => {
		const req = m.request;
		const h = req.horses[req.playerHorseIndex ?? 0];
		return (h.skills as Array<{ skillId: string }>).map(e => e.skillId);
	};
	t.ok(prepares.every(m => playerSkills(m).includes(lock)),
		'the locked skill reaches the engine horse on every preparation — even with an EMPTY selection');
	evLock.dispose();
	t.end();
});
