/**
 * run_compact parity tests: wasm-side compact extraction (globalsim-wasm
 * run_compact) vs the JS fallback (run + JSON.parse + extractCompact +
 * metrics.samplePlayerTail), on the REAL v77 engine.
 *
 * Run: npm run test:globalsim-compact  (from the repo root)
 *
 * Same bridge trick as compare.acceptance.test.ts. For each setup we drive
 * the real workerCore twice: once with the real pkg (wasm run_compact path)
 * and once with a pkg whose PreparedRace instances have run_compact shadowed
 * out (forcing the JS extractCompact fallback). Every SeedCompactRecord —
 * finish metadata, the 41-sample tail grid, the h2h opp block and the
 * activation counts — must deepStrictEqual, bit for bit. If the two paths
 * ever drift, sampling results would change silently when pkg is updated,
 * which is exactly what this test exists to catch.
 */

// Same CC_GLOBAL-before-import trick as adapter.test.ts.
(globalThis as any).CC_GLOBAL = true;

import test from 'tape';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { HorseState, SkillSet } from '../../../../components/HorseDefTypes';
import { GroundCondition, Weather, Season, Time } from '../../../../uma-skill-tools/RaceParameters';
import { parseMobPresets } from './mobs';
import { createGlobalsimWorkerCore, WasmApi } from './workerCore';
import { SeedCompactRecord, leadMarginL } from './metrics';
import { buildCompareJobs, GlobalsimCompareInput } from './compare';

const repoRoot = path.resolve(__dirname, '../../../../');
const pkgDir = path.join(repoRoot, 'globalsim-wasm', 'pkg');
const geomDir = path.join(repoRoot, 'vendor', 'GlobalSim', 'data', 'course_geometry');
const courseIds: string[] = Object.keys(require(path.join(repoRoot, 'vendor/GlobalSim/data/course_data.json')));
const mobPreset = parseMobPresets(require('./mob-presets.json')).presets['default'];
const mergedTable = require(path.join(repoRoot, 'globalsim/skills.json'));
const knownSkillIds = new Set<string>(Object.keys(mergedTable));

const COURSE = '10504';
const DISTANCE = 2000;
const BASE_SEED = 20261114;
const N = 24;
const GATE = 3; // fixed single gate group → one job holds all seeds (chunk 25)

let instances = 0;
/** Fresh pkg instance; stripCompact=true shadows run_compact (JS fallback). */
async function loadPkgFresh(stripCompact: boolean): Promise<WasmApi> {
	const dynImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>;
	const mod = await dynImport(pathToFileURL(path.join(pkgDir, 'globalsim_wasm.js')).href + `?w=${instances++}`);
	const init = mod.default ?? mod.init;
	await init(fs.readFileSync(path.join(pkgDir, 'globalsim_wasm_bg.wasm')));
	const PreparedRace: any = mod.PreparedRace;
	return {
		register_geometry: (courseId: number, jsonText: string) => mod.register_geometry(courseId, jsonText),
		PreparedRace: stripCompact
			? class extends PreparedRace {
				constructor(json: string) { super(json); (this as any).run_compact = undefined; }
			}
			: PreparedRace,
	};
}

/** Drive workerCore (mode compact) for one job; resolve with its records. */
function runCore(request: any, seeds: number[], trackSkillId: string | undefined, secondPlayerIndex: number | undefined, stripCompact: boolean): Promise<SeedCompactRecord[]> {
	return new Promise((resolve, reject) => {
		const core = createGlobalsimWorkerCore({
			postMessage: (m: any) => queueMicrotask(() => {
				if (m.type === 'prepared') {
					if (!m.ok) reject(new Error(`prepare failed: ${m.error}`));
					else core.onMessage({ type: 'run', jobId: 'j1', seeds, mode: 'compact' });
				} else if (m.type === 'chunk') {
					if (m.ok) resolve(m.records);
					else reject(new Error(`chunk failed: ${m.error}`));
				}
			}),
			loadWasm: () => loadPkgFresh(stripCompact),
			fetchText: (url) => fs.promises.readFile(path.join(geomDir, path.basename(url)), 'utf8'),
		});
		core.onMessage({ type: 'skillData', skillData: mergedTable });
		core.onMessage({ type: 'prepare', id: 'p1', setupKey: 'k1', request, trackSkillId, secondPlayerIndex });
	});
}

function horseWithSkills(ids: string[]): HorseState {
	return new HorseState({
		speed: 1000, stamina: 1000, power: 900, guts: 800, wisdom: 900,
		strategy: 'Senkou', distanceAptitude: 'A', surfaceAptitude: 'A', strategyAptitude: 'A', mood: 2,
	}).set('skills', SkillSet(ids));
}

function compareInput(uma1: HorseState, uma2: HorseState, over: Partial<GlobalsimCompareInput> = {}): GlobalsimCompareInput {
	return {
		uma1, uma2,
		courseId: COURSE, distance: DISTANCE,
		ground: GroundCondition.Good, weather: Weather.Sunny, season: Season.Spring, time: Time.Midday,
		knownSkillIds, courseIds, mobPreset,
		skillData: mergedTable,
		seedBase: BASE_SEED, sampleCount: N, threads: 1, fixedGate: GATE,
		...over,
	} as GlobalsimCompareInput;
}

// ── pkg sanity: the wasm actually exposes run_compact ────────────────────────

test('pkg exposes wasm run_compact (guards the whole test)', async t => {
	const w = await loadPkgFresh(false);
	t.equal(typeof (w.PreparedRace as any).prototype.run_compact, 'function', 'PreparedRace.prototype.run_compact exists');
	t.end();
});

// ── mob layout: finish metadata + tail grid ──────────────────────────────────

test('mob layout: wasm run_compact records deepStrictEqual JS extractCompact', async t => {
	const h = horseWithSkills(['100011', '100031', '200011', '100051']);
	const built = buildCompareJobs(compareInput(h, h), Array.from({ length: N }, (_, i) => BASE_SEED + i), 'compact');
	t.equal(built.errors.length, 0, `job build errors: ${built.errors.join(' | ')}`);
	const job = built.jobs[0];
	const seeds = job.seeds;
	const viaWasm = await runCore(job.request, seeds, undefined, undefined, false);
	const viaJs = await runCore(job.request, seeds, undefined, undefined, true);
	t.deepEqual(viaWasm, viaJs, 'records bit-identical (wasm vs JS extraction)');
	t.equal(viaWasm.length, seeds.length, 'one record per seed');
	t.ok(viaWasm.every(r => typeof (r as any).finishTimeRaw === 'number'), 'records carry finish metadata');
	t.ok(viaWasm.some(r => Array.isArray(r.tail) && r.tail.length === 41), 'tail grid (41 samples) sampled in both paths');
	// Lead-margin proxy field: must be PRESENT (both paths) and usable, not
	// silently skipped — otherwise the optimizer screens on all-null ℓ.
	const leadable = viaWasm.filter(r => !r.error);
	t.ok(leadable.length > 0 && leadable.every(r =>
		typeof r.bestRivalFinishTimeRaw === 'number' && Number.isFinite(r.bestRivalFinishTimeRaw)),
	'bestRivalFinishTimeRaw present and finite on every ok record');
	t.ok(leadable.every(r => {
		const l = leadMarginL(r, 2000);
		// finishOrder is 0-based (lib.rs order_index from enumerate): the winner
		// is 0, and ℓ > 0 ⇔ the player beat every rival ⇔ finishOrder === 0.
		return l !== null && Number.isFinite(l) && Math.sign(l) === (typeof r.finishOrder === 'number' && r.finishOrder === 0 ? 1 : -1);
	}), 'leadMarginL finite and sign-consistent with finishOrder===0 (0-based: 0 = won)');
	t.end();
});

// ── chart mode: activation counting ──────────────────────────────────────────

test('trackSkillId: activation counts match, and the skill really activates', async t => {
	const h = horseWithSkills(['100011', '100031', '200011', '100051']);
	const built = buildCompareJobs(compareInput(h, h), Array.from({ length: N }, (_, i) => BASE_SEED + i), 'compact');
	const job = built.jobs[0];
	const viaWasm = await runCore(job.request, job.seeds, '200011', undefined, false);
	const viaJs = await runCore(job.request, job.seeds, '200011', undefined, true);
	t.deepEqual(viaWasm, viaJs, 'records with activations deepStrictEqual');
	t.ok(viaWasm.every(r => typeof (r as any).activations === 'number'), 'activations present on every record');
	const total = viaWasm.reduce((n, r) => n + ((r as any).activations || 0), 0);
	t.ok(total > 0, `skill 200011 actually activated (total ${total}) — count path exercised`);
	t.end();
});

// ── h2h layout: opp block + both tails ───────────────────────────────────────

test('h2h layout: opp finish + both tails deepStrictEqual', async t => {
	const h1 = horseWithSkills(['100011', '100031', '200011', '100051']);
	const h2 = horseWithSkills(['100011', '100031', '200012', '100051']);
	const built = buildCompareJobs(compareInput(h1, h2, { fieldLayout: 'h2h' } as any), Array.from({ length: N }, (_, i) => BASE_SEED + i), 'compact');
	t.equal(built.errors.length, 0, `h2h job build errors: ${built.errors.join(' | ')}`);
	const job = built.jobs[0];
	const second = (job as any).secondPlayerIndex as number;
	t.ok(second >= 0, `job carries secondPlayerIndex (${second})`);
	const viaWasm = await runCore(job.request, job.seeds, undefined, second, false);
	const viaJs = await runCore(job.request, job.seeds, undefined, second, true);
	t.deepEqual(viaWasm, viaJs, 'h2h records bit-identical (own + opp metadata and tails)');
	t.ok(viaWasm.every(r => typeof (r as any).opp?.finishTimeRaw === 'number'), 'opp finish metadata present');
	t.ok(viaWasm.every(r => Array.isArray(r.opp?.tail) ? r.opp!.tail.length === 41 : r.opp?.tail === null), 'opp tail grid 41 samples or null in both');
	t.end();
});
