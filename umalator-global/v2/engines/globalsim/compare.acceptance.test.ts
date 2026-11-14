/**
 * GlobalSim compare acceptance tests (Phase 4 of the integration plan).
 *
 * Run: npm run test:globalsim-compare  (from the repo root; ~1 min — this is
 * the real engine end-to-end: real globalsim-wasm pkg + real course geometry).
 *
 * Node has no Web Worker, so the pool's WorkerFactory injects a BRIDGE: a
 * WorkerLike object wired to the REAL workerCore (globalsim.worker.ts is only
 * the self-wiring; the logic lives in workerCore.createGlobalsimWorkerCore)
 * with disk-backed loadWasm/fetchText. globalsim-wasm/pkg runs in node —
 * exactly how globalsim-wasm/test/phase0.mjs drives it.
 *
 * Acceptance criteria from the plan:
 *   (a) identical UMA1/UMA2 ⇒ margin 0 on every seed; ties reported at 50%-
 *       scale separately from win rates; identical placing histograms.
 *   (b) a speed skill (200011) added to UMA2 ⇒ positive mean margin.
 *   (c) determinism: the same seed list twice ⇒ byte-identical aggregates.
 *   (d) both margin methods agree within 0.05 L on frame runs (real wasm).
 *   (e) is covered in pool.test.ts (fake worker factory).
 *   (f) the representative-run pool receives the injected skill table too
 *       (scripted workers; regression — rep requests omit skillData).
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
import type { WorkerFactory, WorkerLike } from './pool';
import { createGlobalsimWorkerCore, WasmApi } from './workerCore';
import { runGlobalsimCompare, buildCompareJobs, GlobalsimCompareInput, GlobalsimCompareResults } from './compare';
import { pairMarginFromFull, FullRunData } from './metrics';

// ── engine fixtures ──────────────────────────────────────────────────────────

const repoRoot = path.resolve(__dirname, '../../../../');
const pkgDir = path.join(repoRoot, 'globalsim-wasm', 'pkg');
const geomDir = path.join(repoRoot, 'vendor', 'GlobalSim', 'data', 'course_geometry');
const courseIds: string[] = Object.keys(require(path.join(repoRoot, 'vendor/GlobalSim/data/course_data.json')));
const mobPreset = parseMobPresets(require('./mob-presets.json')).presets['default'];
// The active Phase 2 coverage table (the same file the app's /uma-tools/
// globalsim/skills.json is generated from) — the adapter's skill gate.
const knownSkillIds = new Set<string>(Object.keys(require(path.join(repoRoot, 'globalsim/skills.json'))));

const COURSE = '10504';          // Nakayama turf mile
const DISTANCE = 2000;           // course_data.json distance for 10504
const BASE_SEED = 20261114;      // deterministic, pinned
const N = 200;                   // plan: acceptance runs 200 paired seeds

let instances = 0;
/** Fresh globalsim-wasm module instance (each browser worker gets its own). */
async function loadPkgFresh(): Promise<WasmApi> {
	// Dynamic-import through Function so ts-node/COMMONJS leaves the native
	// import() call intact (require() would share ONE module instance across
	// "workers"; the ?w= query gives each bridge its own wasm instance).
	const dynImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>;
	const mod = await dynImport(pathToFileURL(path.join(pkgDir, 'globalsim_wasm.js')).href + `?w=${instances++}`);
	const init = mod.default ?? mod.init;
	await init(fs.readFileSync(path.join(pkgDir, 'globalsim_wasm_bg.wasm')));
	return {
		register_geometry: (courseId: number, jsonText: string) => mod.register_geometry(courseId, jsonText),
		PreparedRace: mod.PreparedRace,
	};
}

/** The bridge: WorkerLike backed by the real workerCore + real wasm on disk. */
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

// ── horses ───────────────────────────────────────────────────────────────────

// A mid-distance Senkou runner — same stats both sides for (a)/(c)/(d); uma2
// gets skill 200011 (a covered speed skill) for (b).
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
		seedBase: BASE_SEED, sampleCount: N,
		threads: 2,                 // node bridge is single-threaded anyway; keep wasm instances low
		workerFactory: bridgeFactory(),
		...over,
	} as GlobalsimCompareInput;
}

/** Run one full compare and return it (paints progress — ignore partials). */
async function compare(uma1: HorseState, uma2: HorseState, over: Partial<GlobalsimCompareInput> = {}): Promise<GlobalsimCompareResults> {
	let progressPaints = 0;
	const res = await runGlobalsimCompare(compareInput(uma1, uma2, {
		onProgress: () => { progressPaints++; },
		...over,
	}));
	(res as any).progressPaints = progressPaints;
	return res;
}

// ── (a) identical umas: every margin 0, ties separate, identical placings ────

let runA: GlobalsimCompareResults;
test('(a) identical UMA1/UMA2 ⇒ margin 0 on every paired seed', async t => {
	const h = horseWithSkills(['100011', '100031', '200011', '100051']);   // a plausible covered build
	runA = await compare(h, h);
	const gs = runA.globalsim;
	t.equal(gs.doneSeeds, N, 'all 200 seeds paired');
	t.equal(runA.results.length, N, 'classic results array holds one margin per pair');
	t.ok(runA.results.every(m => m === 0), 'every margin exactly 0 (bit-identical engine runs)');
	t.equal(gs.tieRate, 1, 'tieRate 100%');
	t.equal(gs.winRateUma1, 0, 'win rate uma1 reported SEPARATELY at 0');
	t.equal(gs.winRateUma2, 0, 'win rate uma2 reported SEPARATELY at 0');
	t.deepEqual(gs.placing1, gs.placing2, 'placing histograms identical');
	t.equal(gs.seedErrors, 0, 'no per-seed engine errors');
	t.equal(gs.jobErrors.length, 0, 'no chunk failures');
	t.ok((runA as any).progressPaints >= 2, 'partial results streamed during the run');
	t.ok(gs.engineLine.startsWith('GlobalSim v77 · skill table v70 + '), `engine version line: ${gs.engineLine}`);
	t.end();
});

// ── (b) speed skill on UMA 2 ⇒ positive mean margin ─────────────────────────

test('(b) speed skill 200011 added to UMA 2 ⇒ positive mean margin', async t => {
	const plain = horseWithSkills(['100011', '100031', '100051']);
	const boosted = horseWithSkills(['100011', '100031', '100051', '200011']);
	const res = await compare(plain, boosted);
	const gs = res.globalsim;
	t.equal(gs.doneSeeds, N);
	const mean = res.results.reduce((a, b) => a + b, 0) / res.results.length;
	t.ok(mean > 0, `mean margin positive: ${mean.toFixed(3)} L over ${gs.doneSeeds} seeds`);
	t.ok(gs.winRateUma2 > gs.winRateUma1, `uma2 wins more often: ${(gs.winRateUma2 * 100).toFixed(1)}% vs ${(gs.winRateUma1 * 100).toFixed(1)}%`);
	t.ok(gs.ci95[0] > 0 || gs.winRateUma2 > 0.5, 'CI or win rate agrees with the effect');
	t.end();
});

// ── (c) determinism: same seed list twice ⇒ identical aggregates ─────────────

test('(c) same seed list twice ⇒ byte-identical aggregates', async t => {
	const h = horseWithSkills(['100011', '100031']);
	const first = await compare(h, h);
	const second = await compare(h, h);
	t.deepEqual(second.results, first.results, 'margin arrays identical');
	const a = first.globalsim; const b = second.globalsim;
	for (const key of ['winRateUma1', 'winRateUma2', 'tieRate', 'hpEmptyRate1', 'hpEmptyRate2', 'rushingRate1', 'rushingRate2'] as const) {
		t.equal(b[key], a[key], `${key} identical`);
	}
	t.deepEqual(b.placing1, a.placing1, 'placing histogram identical');
	t.deepEqual(b.placing2, a.placing2);
	t.deepEqual(b.ci95, a.ci95, 'CI identical');
	t.end();
});

// ── (d) margin-method agreement on frame-bearing runs (direct workerCore) ───

test('(d) frames vs Δt×speed margins agree within 0.05 L on real runs', async t => {
	// Drive ONE bridge per variant directly (mode 'full' ⇒ dense player frames)
	// and compare pairMarginFromFull's two methods per seed.
	const seeds: number[] = [];
	for (let s = 0; seeds.length < 10; s++) seeds.push((BASE_SEED + s * 7919) | 0);

	const plain = horseWithSkills(['100011']);
	const boosted = horseWithSkills(['100011', '200011']);
	const full = await Promise.all([plain, boosted].map((horse, v) => collectFull(horse, v, seeds)));
	const [recA, recB] = full;
	let worst = 0;
	let checked = 0;
	for (const seed of seeds) {
		const a = recA.get(seed), b = recB.get(seed);
		if (!a || !b || a.error || b.error) continue;
		const m = pairMarginFromFull(a, b, DISTANCE);
		worst = Math.max(worst, Math.abs(m.frames - m.deltaSpeed));
		checked++;
	}
	t.equal(checked, seeds.length, 'all 10 seeds produced frame data on both sides');
	t.ok(worst <= 0.05, `worst method disagreement ${worst.toFixed(4)} L ≤ 0.05 L (frames vs Δt×loser-speed)`);
	t.ok(checked >= 10);
	t.end();
});

/** Run 10 seeds through one bridged workerCore in 'full' mode; seed → frames. */
async function collectFull(horse: HorseState, variant: number, seeds: number[]): Promise<Map<number, FullRunData>> {
	const worker = bridgeFactory()();
	const out = new Map<number, FullRunData>();
	// Prepare directly with the same request buildCompareJobs produces.
	const { jobs, errors } = buildCompareJobs(compareInput(horse, horse, { sampleCount: seeds.length }), seeds, 'full');
	const job = jobs.find(j => j.id.startsWith(`${variant}|`));
	if (!job || errors.length) throw new Error(`no full job for variant ${variant}: ${errors.join('; ')}`);
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('collectFull timeout')), 120_000);
		worker.addEventListener('message', (e: { data: any }) => {
			const d = e.data;
			if (d.type === 'prepared') {
				if (!d.ok) { clearTimeout(timer); reject(new Error(`prepare failed: ${d.error}`)); return; }
				worker.postMessage({ type: 'run', jobId: job.id, seeds, mode: 'full' });
			} else if (d.type === 'chunk') {
				clearTimeout(timer);
				if (!d.ok) { reject(new Error(`chunk failed: ${d.error}`)); return; }
				for (const r of d.records as FullRunData[]) out.set(r.seed, r);
				worker.terminate();
				resolve();
			}
		});
		worker.postMessage({ type: 'prepare', id: job.id, setupKey: job.setupKey, request: job.request });
	});
	return out;
}

// ── (f) rep-run pool receives the injected skill table (scripted workers) ────

test('(f) representative-run pool receives the injected skill table (scripted workers)', async t => {
	// Scripted bridge implementing the engine's table contract: a prepare
	// request that omits skillData (adapter config.skillData === null — the
	// path buildCompareJobs takes whenever input.skillData is set) only
	// initializes if the worker got the pool's first-message {type:'skillData'}
	// injection; without one the engine falls back to its own legacy table and
	// ids outside it fail prepare ('Missing retail initialization field').
	const table = { __fixture_table__: { name: 'merged table' } };
	interface Rec { firstMsg: any; sawFullPrepare: boolean; fullPrepareWithoutTable: number }
	const workers: Rec[] = [];
	const scriptedFactory: WorkerFactory = (): WorkerLike => {
		const rec: Rec = { firstMsg: null, sawFullPrepare: false, fullPrepareWithoutTable: 0 };
		workers.push(rec);
		let heldSkillData: unknown = null;
		const msgCbs: ((e: { data: any }) => void)[] = [];
		const send = (m: any) => queueMicrotask(() => { for (const cb of msgCbs) cb({ data: m }); });
		return {
			postMessage: (m: any) => {
				if (rec.firstMsg === null) rec.firstMsg = m;
				queueMicrotask(() => {
					if (m.type === 'skillData') { heldSkillData = m.skillData; return; }
					if (m.type === 'prepare') {
						const omitTable = (m.request as any).skillData == null;
						if (String(m.setupKey).includes('|full|')) {
							rec.sawFullPrepare = true;
							if (omitTable && heldSkillData == null) rec.fullPrepareWithoutTable++;
						}
						send({ type: 'prepared', id: m.id, ok: !omitTable || heldSkillData != null });
						return;
					}
					if (m.type === 'run') {
						const variant = Number(String(m.jobId).split('|')[0]);
						const records = (m.seeds as number[]).map((seed: number) => m.mode === 'full'
							? { seed, finishTimeRaw: variant ? 124 : 125, finishOrder: 3, startDelayTime: 0,
								t: [0, 1, 2], pos: [0, 500, 1000], speed: [10, 11, 11], hp: [100, 90, 80], skillEvents: [] }
							: { seed, finishTimeRaw: variant ? 124 : 125, finishOrder: 3, tail: null });
						send({ type: 'chunk', jobId: m.jobId, ok: true, records });
					}
				});
			},
			addEventListener: (type: string, cb: any) => { if (type === 'message') msgCbs.push(cb); },
			terminate: () => { /* scripted: nothing to tear down */ },
		};
	};
	const h = horseWithSkills(['100011']);
	const res = await runGlobalsimCompare(compareInput(h, h, {
		skillData: table, workerFactory: scriptedFactory, sampleCount: 4, threads: 1,
	}));
	const repWorkers = workers.filter(w => w.sawFullPrepare);
	t.ok(repWorkers.length > 0, 'representative-run workers were created');
	t.equal(res.globalsim.doneSeeds, 4, 'sampling pass completed through the scripted bridge');
	for (const w of workers) {
		t.equal(w.firstMsg?.type, 'skillData', 'every pool worker’s first message is the skill-table injection');
		t.equal(w.firstMsg?.skillData, table, 'and carries the exact injected table');
	}
	t.equal(repWorkers.reduce((s, w) => s + w.fullPrepareWithoutTable, 0), 0,
		'no full-mode prepare reached the engine without the table (legacy-table fallback)');
	t.ok(res.runData.minrun && res.runData.maxrun && res.runData.meanrun && res.runData.medianrun,
		'all four representative snapshots built (null = rep runs silently failed)');
	t.end();
});
