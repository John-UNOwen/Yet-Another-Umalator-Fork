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
import { MobPreset, parseMobPresets } from '../mobs';
import { createGlobalsimWorkerCore, WasmApi } from '../workerCore';
import { WorkerFactory, WorkerLike } from '../pool';
import { calculateSkillCost, isPurpleSkill, skillGroups } from '../../../skill-chart-utils';
import { createEvaluator, calibrateNoise, seedValueOf, statsOf } from './evaluator';
import { NS_SEARCH, NS_VERIFY } from './cache';
import { buildSpace, simIdentity } from './space';
import { ScenarioSpec } from './types';
import { leadMarginL, SeedCompactRecord } from '../metrics';
import { buildCompareJobs, GlobalsimCompareInput } from '../compare';
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

const mkEval = (cacheCapBytes?: number) => createEvaluator({
	workerFactory: factory, threads: 2, space, baseHorse: horse, scenarios, baseSeed: BASE_SEED, skillData: mergedTable, ...(cacheCapBytes != null ? { cacheCapBytes } : {}),
});
const positions = Array.from({ length: SEEDS }, (_, i) => i);

// ── pure folding unit tests ──────────────────────────────────────────────────

test('seedValueOf folds records; statsOf drops null leads from ℓ stats only', t => {
	// finishOrder is 0-based: order 2 = 3rd place ⇒ win 0, top3 1, placing 3.
	const rec: any = { seed: 1, finishTimeRaw: 120, bestRivalFinishTimeRaw: 119.8, finishOrder: 2, hpEmptyOnRace: false, rushingStartCount: 1, tail: [[0, 1990, 11.5]] };
	const v = seedValueOf(rec, DISTANCE)!;
	t.ok(v !== 'err' && v.win === 0 && v.top3 === 1 && v.placing === 3 && v.rushed === 1, 'flags from 0-based finishOrder/HP/rush');
	t.ok(v !== 'err' && v.lead != null && v.lead < 0, 'negative lead when best rival finished first');
	t.equal(v !== 'err' && v.lead, leadMarginL(rec, DISTANCE), 'lead == metrics.leadMarginL');
	// Winner = finishOrder 0 (old-pkg record shape: no bestRivalFinishTimeRaw).
	const oldPkg: any = { seed: 2, finishTimeRaw: 120, finishOrder: 0 };
	const v2 = seedValueOf(oldPkg, DISTANCE)!;
	t.ok(v2 !== 'err' && v2.lead === null && v2.win === 1 && v2.placing === 1, 'old-pkg winner record: usable placing stats, null lead');
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

test('§K: pinBuilds exempts pinned entries from LRU eviction', async t => {
	// Size the budget just under three entries (entries differ only by key
	// length), then push the cache over cap with a third fill: the LRU victim
	// is the base, but add1, pinned and older than add2, must survive the
	// pass that drops unpinned data.
	const probe = mkEval();
	await probe.ensure([{ ns: NS_SEARCH, scenarioIdx: 0, build: base, positions }]);
	const cap = 3 * probe.cacheStats().estimatedBytes - 100;
	probe.dispose();

	const evPin = mkEval(cap);
	await evPin.ensure([{ ns: NS_SEARCH, scenarioIdx: 0, build: base, positions }]);
	await evPin.ensure([{ ns: NS_SEARCH, scenarioIdx: 0, build: add1, positions }]);
	t.equal(evPin.cacheStats().evictions, 0, 'two entries fit the budget');
	evPin.pinBuilds?.(NS_SEARCH, 0, [add1.id]);
	await evPin.ensure([{ ns: NS_SEARCH, scenarioIdx: 0, build: add2, positions }]);
	const stP = evPin.cacheStats();
	t.ok(stP.evictions >= 1, `the over-cap eviction pass ran (evictions=${stP.evictions})`);
	t.equal(evPin.slots(NS_SEARCH, 0, add1.id).length, SEEDS, 'pinned add1 survives eviction despite being the older entry');
	t.equal(evPin.slots(NS_SEARCH, 0, add2.id).length, SEEDS, 'fresh add2 stays (cap met after the eviction)');
	t.equal(evPin.slots(NS_SEARCH, 0, base.id).length, 0, 'unpinned LRU base evicted');
	evPin.dispose();
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

// §E: the activation telemetry folded from the compact records of the races
// the optimizer already ran (no extra races). Real wasm run_compact → the
// evaluator's chunk fold → ev.activations. Determinism (§13.4) applies to
// the counts exactly as it does to the seed values.
test('activations: the compact races already run carry per-skill counts (§E)', async t => {
	await ev.ensure([{ ns: NS_SEARCH, scenarioIdx: 0, build: add1, positions }]);
	const tel = ev.activations?.(NS_SEARCH, 0, add1.id);
	t.ok(tel, 'telemetry exists after the compact fill');
	t.equal(tel!.seeds, SEEDS, 'every measured seed folded exactly once');
	t.ok(Object.keys(tel!.counts).length > 0, 'the races reported activation counts (non-empty fold)');
	for (const id of Object.keys(tel!.counts)) {
		t.ok(tel!.fired[id] <= tel!.seeds, `fired[${id}] ≤ seeds (fired counts seeds, not activations)`);
		t.ok(tel!.counts[id] >= tel!.fired[id], `counts[${id}] ≥ fired[${id}] (a fired seed activated ≥ 1 time)`);
	}
	// The verify namespace folds nothing (P3): the search telemetry must not
	// leak into a verify-namespace read of the same identity.
	t.equal(ev.activations?.(NS_VERIFY, 0, add1.id), null, 'verify namespace carries no activation fold');
	// Same engine, fresh evaluator → byte-identical telemetry.
	const ev3 = mkEval();
	await ev3.ensure([{ ns: NS_SEARCH, scenarioIdx: 0, build: add1, positions }]);
	t.deepEqual(ev3.activations?.(NS_SEARCH, 0, add1.id), tel, 'telemetry is deterministic across evaluators (§13.4)');
	ev3.dispose();
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
	t.ok(prepares.every(m => m.request.pairedRandomStreams === true),
		'EVERY optimizer race runs paired (default mode): the flag is on every request');
	t.ok(prepares.every(m => String(m.setupKey).includes('|pair|')),
		'optimizer setupKeys carry the pair mode tag (no cross-mode preparation reuse)');
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

// ── finishOrder 0-basedness on REAL engine output ─────────────────────────────
// The optimizer once read the engine's 0-based finishOrder as 1-based, so 'win'
// silently measured P(2nd). The synthetic oracle could not catch that (it builds
// SeedValues itself); only real run_compact records pin the mapping. A weak mob
// field guarantees finishOrder 0 records (win path), the default field a
// finishOrder > 0 loser (loss path) — both fold rules run over real records.

/** One compact run of `horse` against `preset`, through the real wasm pkg. */
function runCompact(horse: HorseState, preset: MobPreset): Promise<SeedCompactRecord[]> {
	const seeds = Array.from({ length: 24 }, (_, i) => BASE_SEED + i);
	const input = {
		uma1: horse, uma2: horse,
		courseId: COURSE, distance: DISTANCE,
		ground: GroundCondition.Good, weather: Weather.Sunny, season: Season.Spring, time: Time.Midday,
		knownSkillIds, courseIds, mobPreset: preset, skillData: mergedTable,
		seedBase: BASE_SEED, sampleCount: seeds.length, threads: 1, fixedGate: GATE,
		// workerFactory only matters to the pool path; runCompact drives workerCore directly.
	} as unknown as GlobalsimCompareInput;
	const built = buildCompareJobs(input, seeds, 'compact');
	if (built.errors.length) return Promise.reject(new Error(`job build errors: ${built.errors.join(' | ')}`));
	const job = built.jobs[0];
	return new Promise((resolve, reject) => {
		const core = createGlobalsimWorkerCore({
			postMessage: (m: any) => queueMicrotask(() => {
				if (m.type === 'prepared') {
					if (!m.ok) reject(new Error(`prepare failed: ${m.error}`));
					else core.onMessage({ type: 'run', jobId: 'j1', seeds: job.seeds, mode: 'compact' });
				} else if (m.type === 'chunk') {
					if (m.ok) resolve(m.records);
					else reject(new Error(`chunk failed: ${m.error}`));
				}
			}),
			loadWasm: loadPkgFresh,
			fetchText: (url: string) => fs.promises.readFile(path.join(geomDir, path.basename(url)), 'utf8'),
		});
		core.onMessage({ type: 'skillData', skillData: mergedTable });
		core.onMessage({ type: 'prepare', id: 'p1', setupKey: 'k1', request: job.request });
	});
}

test('real wasm run_compact: finishOrder is 0-based and the winner (0) folds to win', async t => {
	// Same field shape, stats low enough that ANY healthy build wins every seed.
	const weakPreset: MobPreset = {
		name: `${mobPreset.name} (weak sparring partners)`,
		runners: mobPreset.runners.map(r => ({ ...r, speed: 300, stamina: 300, power: 300, guts: 300, wisdom: 300, skills: [] })),
	};
	const winner = baseHorse();
	const loser = new HorseState({
		speed: 400, stamina: 400, power: 400, guts: 400, wisdom: 400,
		strategy: 'Senkou', distanceAptitude: 'A', surfaceAptitude: 'A', strategyAptitude: 'A', mood: 2,
	}).set('skills', SkillSet([]));
	const winRecs = await runCompact(winner, weakPreset);
	const loseRecs = await runCompact(loser, mobPreset);
	const winOk = winRecs.filter(r => !r.error && typeof r.finishOrder === 'number');
	const loseOk = loseRecs.filter(r => !r.error && typeof r.finishOrder === 'number');
	t.equal(winOk.length, 24, 'win-path run: every seed produced a finishOrder record');
	t.equal(loseOk.length, 24, 'loss-path run: every seed produced a finishOrder record');
	// The fastest runner (finishOrder 0) must fold to win=1, placing=1 — under the
	// old 1-based reading that same record folded to win=0, placing=0.
	t.ok(winOk.every(r => r.finishOrder === 0), 'the dominant build wins every seed (finishOrder 0 exists — win path exercised)');
	const vWin = seedValueOf(winOk[0], DISTANCE);
	t.ok(vWin !== 'err' && vWin.win === 1 && vWin.top3 === 1 && vWin.placing === 1,
		`finishOrder 0 (fastest) counts as a WIN, places 1 — got ${JSON.stringify(vWin)}`);
	// Loss path on the real default field: never a win, placing never 0.
	t.ok(loseOk.every(r => r.finishOrder !== 0 && (r.finishOrder as number) > 0), 'the weak build never wins the default field (loss path exercised)');
	const vLose = seedValueOf(loseOk[0], DISTANCE);
	t.ok(vLose !== 'err' && vLose.win === 0 && vLose.placing >= 2, `finishOrder > 0 folds to win=0, placing ≥ 2 — got ${JSON.stringify(vLose)}`);
	// Every real record respects the 0-based rule (top-3 ⇔ finishOrder ≤ 2).
	for (const r of [...winOk, ...loseOk]) {
		const v = seedValueOf(r, DISTANCE);
		if (v === 'err' || v.win !== (r.finishOrder === 0 ? 1 : 0)
			|| v.top3 !== ((r.finishOrder as number) <= 2 ? 1 : 0)
			|| v.placing !== (r.finishOrder as number) + 1) {
			t.fail(`real record finishOrder=${r.finishOrder} mis-folded: ${JSON.stringify(v)}`);
		}
	}
	t.pass('on all 48 real records: win ⇔ finishOrder 0, top3 ⇔ finishOrder ≤ 2, placing = finishOrder + 1');
	t.end();
});

// ── job failures: transient holes are retried, repeated ones become 'err' ────

/** The real worker, with a switch that makes the course-geometry fetch fail —
 *  the "prepare failed" job error the pool reports without any requeue. */
function flakyFactory(fail: { on: boolean }): WorkerFactory {
	return () => {
		let closed = false;
		const listeners: Array<(e: { data: any }) => void> = [];
		const core = createGlobalsimWorkerCore({
			postMessage: (m: any) => queueMicrotask(() => { if (!closed) for (const cb of listeners) cb({ data: m }); }),
			loadWasm: loadPkgFresh,
			fetchText: (url: string) => fail.on
				? Promise.reject(new Error('network down'))
				: fs.promises.readFile(path.join(geomDir, path.basename(url)), 'utf8'),
		});
		return {
			postMessage: (m: any) => queueMicrotask(() => { if (!closed) core.onMessage(m); }),
			addEventListener: (type: string, cb: any) => { if (type === 'message') listeners.push(cb); },
			terminate: () => { closed = true; },
		};
	};
}

test('a transient job failure leaves holes that the next ensure re-runs', async t => {
	const fail = { on: true };
	const evF = createEvaluator({ workerFactory: flakyFactory(fail), threads: 2, space, baseHorse: horse, scenarios, baseSeed: BASE_SEED, skillData: mergedTable });
	const req = [{ ns: NS_SEARCH, scenarioIdx: 0, build: base, positions }];
	const r1 = await evF.ensure(req);
	t.ok(r1.jobErrors.length > 0, 'the outage is reported as job errors');
	t.ok(evF.slots(NS_SEARCH, 0, base.id).every(s => s === null), 'failed seeds stay holes, not err');
	fail.on = false;
	await evF.ensure(req);
	const after = evF.slots(NS_SEARCH, 0, base.id);
	t.ok(after.length === SEEDS && after.every(s => s != null && s !== 'err'), 'every seed measured once the fetch recovers');
	t.ok(evF.stats(NS_SEARCH, 0, base)?.n === SEEDS, 'the build is measurable again');
	t.ok(evF.jobErrorLog().some(e => e.error.includes('network down')), 'the failure is in the job error log');
	evF.dispose();
	t.end();
});

test('a seed that keeps failing becomes err after the attempt cap', async t => {
	const evF = createEvaluator({ workerFactory: flakyFactory({ on: true }), threads: 2, space, baseHorse: horse, scenarios, baseSeed: BASE_SEED, skillData: mergedTable });
	const req = [{ ns: NS_SEARCH, scenarioIdx: 0, build: base, positions }];
	await evF.ensure(req);
	await evF.ensure(req);
	t.ok(evF.slots(NS_SEARCH, 0, base.id).every(s => s === null), 'still holes after 2 failed attempts');
	await evF.ensure(req);
	t.ok(evF.slots(NS_SEARCH, 0, base.id).every(s => s === 'err'), "err after the 3rd failed attempt");
	const r4 = await evF.ensure(req);
	t.equal(r4.jobErrors.length, 0, 'err seeds are never re-requested');
	evF.dispose();
	t.end();
});
