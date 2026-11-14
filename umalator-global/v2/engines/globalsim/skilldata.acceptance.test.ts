/**
 * skillData injection tests (Phase 2 merged table → engine).
 *
 * Run: npm run test:globalsim-skilldata  (repo root; needs globalsim/skills.json
 * — the script chain generates it — and the built globalsim-wasm pkg.)
 *
 * profile-v77.json embeds the PURE v70 skillData, so the 21 batch-1 supplement
 * ids initialize only when the request carries the merged table. The app path
 * strips the table from each request (adapter config.skillData === null) and
 * the pool delivers it ONCE per worker ({type:'skillData'}) which workerCore
 * injects at prepare. These tests pin that whole path against the REAL wasm:
 *   1. adapter request shapes (override / omit / default-unchanged),
 *   2. supplement skill 201253: fails with the v70-only table injected
 *      ('Missing retail initialization field'), succeeds with the merged
 *      table, runs produce finite results (deterministic); an omitted table
 *      silently falls back to the engine's own bundled table — which is why
 *      the app always injects ours (pinned, versioned behavior),
 *   3. invariance: merged table never changes results for v70-only builds
 *      (reply bytes identical to the profile-table request, 5 seeds).
 */

(globalThis as any).CC_GLOBAL = true;

import test from 'tape';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { HorseState, SkillSet } from '../../../../components/HorseDefTypes';
import { GroundCondition, Weather, Season, Time, Grade } from '../../../../uma-skill-tools/RaceParameters';
import { buildGlobalSimRequest, toGlobalSimRunner, AdapterConfig } from './adapter';
import { createGlobalsimWorkerCore, WasmApi } from './workerCore';
import { parseMobPresets, buildMobField } from './mobs';
import { mergeCanonicalField } from './compare';

const repoRoot = path.resolve(__dirname, '../../../../');
const pkgDir = path.join(repoRoot, 'globalsim-wasm', 'pkg');
const geomDir = path.join(repoRoot, 'vendor', 'GlobalSim', 'data', 'course_geometry');
const courseIds: string[] = Object.keys(require(path.join(repoRoot, 'vendor/GlobalSim/data/course_data.json')));
const mobPreset = parseMobPresets(require('./mob-presets.json')).presets['default'];
const mergedTable: Record<string, unknown> = require(path.join(repoRoot, 'globalsim/skills.json'));
const mergedIds = new Set(Object.keys(mergedTable));

let instances = 0;
async function loadPkgFresh(): Promise<WasmApi> {
	const dynImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>;
	const mod = await dynImport(pathToFileURL(path.join(pkgDir, 'globalsim_wasm.js')).href + `?w=${instances++}`);
	const init = mod.default ?? mod.init;
	await init(fs.readFileSync(path.join(pkgDir, 'globalsim_wasm_bg.wasm')));
	return { register_geometry: (c, j) => mod.register_geometry(c, j), PreparedRace: mod.PreparedRace };
}

/** A bridged workerCore; skillDataMsg sends the one-time injection if given. */
function bridgedWorker(skillData?: unknown): { prepare: (request: unknown) => Promise<any>; run: (seeds: number[]) => Promise<any[]>; terminate: () => void } {
	const core = createGlobalsimWorkerCore({
		postMessage: (m) => queueMicrotask(() => onMsg(m)),
		loadWasm: loadPkgFresh,
		fetchText: (url) => fs.promises.readFile(path.join(geomDir, path.basename(url)), 'utf8'),
	});
	let pending: ((m: any) => void) | null = null;
	function onMsg(m: any) { if (pending) { const p = pending; pending = null; p(m); } }
	if (skillData !== undefined) core.onMessage({ type: 'skillData', skillData });
	const send = (m: any) => new Promise<any>((res) => { pending = res; core.onMessage(m); });
	return {
		prepare: (request) => send({ type: 'prepare', id: 'p1', setupKey: 's', request }),
		run: async (seeds) => (await send({ type: 'run', jobId: 'p1', seeds, mode: 'compact' })).records,
		terminate: () => { pending = null; },
	};
}

function horseWithSkills(ids: string[]): HorseState {
	return new HorseState({
		speed: 1000, stamina: 1000, power: 900, guts: 800, wisdom: 900,
		strategy: 'Senkou', distanceAptitude: 'A', surfaceAptitude: 'A', strategyAptitude: 'A', mood: 2,
		skills: SkillSet(ids) as any,
	});
}

/** Full 9-runner request (player at gate 3, fixed) per skillData config. */
function buildRequest(horse: HorseState, config: AdapterConfig) {
	const { mobs } = buildMobField(mobPreset, 0, { fixedGate: 3 });
	const res = buildGlobalSimRequest({
		courseId: 10504,
		groundCondition: GroundCondition.Good, weather: Weather.Sunny, season: Season.Spring, time: Time.Midday,
		grade: Grade.G1, seed: 42,
		runners: [{ horse, gateIndex: 3, isPlayer: true }],
	}, config);
	if (res.ok !== true) throw new Error(`adapter rejected: ${res.errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`);
	const player = (res.value as any).horses[0];
	const merged = mergeCanonicalField(player, 3, mobs);
	return { ...(res.value as any), horses: merged.horses, playerHorseIndex: merged.playerIndex };
}

// ── 1. adapter shapes ────────────────────────────────────────────────────────

test('adapter skillData shapes: default = profile, object = override, null = omit', t => {
	const h = horseWithSkills([]);
	const base = buildRequest(h, { courseIds, knownSkillIds: mergedIds });
	const over = buildRequest(h, { courseIds, knownSkillIds: mergedIds, skillData: { 999999: { rarity: 2, priority: 0, tags: [], isGeneralSkill: true, alternatives: [], wisdomCheck: 0 } } });
	const omit = buildRequest(h, { courseIds, knownSkillIds: mergedIds, skillData: null });
	t.equal(Object.keys((base as any).skillData).length, 730, 'default: profile v70 table (730)');
	t.equal((over as any).skillData['999999'] !== undefined && Object.keys((over as any).skillData).length === 1, true, 'object: replaces the table');
	t.equal('skillData' in omit, false, 'null: key omitted entirely');
	t.deepEqual(Object.keys(omit).filter(k => k !== 'horses').length, Object.keys(base).filter(k => k !== 'horses').length - 1, 'everything else identical');
	t.end();
});

// ── 2. supplement skill through the real engine ──────────────────────────────

test('supplement skill 201253: fails without injection, runs with it', { timeout: 240_000 }, async t => {
	const horse = horseWithSkills(['201253']);
	const reqOmit = buildRequest(horse, { courseIds, knownSkillIds: mergedIds, skillData: null });

	// No injection: the engine falls back to its OWN bundled table when the
	// request omits skillData — which is exactly why we don't rely on it: the
	// app pins behavior by injecting OUR merged table (versioned with the
	// coverage gate), so results never shift with the engine's defaults.
	const noInject = bridgedWorker();
	const p1 = await noInject.prepare(reqOmit);
	t.equal(p1.ok, true, `omitted skillData falls back to the engine's own table (${p1.error ?? 'ok'})`);
	noInject.terminate();

	const profileInject = bridgedWorker(JSON.parse(fs.readFileSync(path.join(__dirname, 'profile-v77.json'), 'utf8')).skillData);
	const p2 = await profileInject.prepare(reqOmit);
	t.equal(p2.ok, false, 'prepare with the v70-only table fails');
	t.ok(/retail initialization/i.test(p2.error || ''), `error names retail init: ${p2.error}`);
	profileInject.terminate();

	// The merged table (what the app injects): prepare ok, seeds run.
	const seeds = [1000000, 1000001, 1000002];
	const w1 = bridgedWorker(mergedTable);
	const p3 = await w1.prepare(reqOmit);
	t.equal(p3.ok, true, `prepare with the merged table ok (${p3.error ?? ''})`);
	const recs1 = await w1.run(seeds);
	w1.terminate();
	t.equal(recs1.length, seeds.length, 'three records');
	t.ok(recs1.every((r: any) => typeof r.finishTimeRaw === 'number' && !r.error), `all seeds finite: ${JSON.stringify(recs1.map((r: any) => r.error ?? 'ok'))}`);

	// Determinism: a second fresh worker with the same injection repeats.
	const w2 = bridgedWorker(mergedTable);
	await w2.prepare(reqOmit);
	const recs2 = await w2.run(seeds);
	w2.terminate();
	t.deepEqual(recs2, recs1, 'identical results on a fresh worker (determinism)');
	t.end();
});

// ── 3. v70-only builds: merged table must not change anything ───────────────

test('invariance: v70-only build replies identical with profile vs merged skillData', { timeout: 240_000 }, async t => {
	const horse = horseWithSkills(['100011', '200011']);
	const reqProfile = buildRequest(horse, { courseIds, knownSkillIds: mergedIds });
	const reqMerged = buildRequest(horse, { courseIds, knownSkillIds: mergedIds, skillData: mergedTable });
	const seeds = [77, 777, 7777, 77777, 777777];
	const run = async (request: unknown) => {
		const w = bridgedWorker();
		const p = await w.prepare(request);
		if (!p.ok) throw new Error(`prepare failed: ${p.error}`);
		const recs = await w.run(seeds);
		w.terminate();
		return recs;
	};
	const a = await run(reqProfile);
	const b = await run(reqMerged);
	t.deepEqual(b, a, 'every compact record byte-identical (5 seeds)');
	t.ok(a.every((r: any) => !r.error), 'no per-seed errors on either side');
	t.end();
});
