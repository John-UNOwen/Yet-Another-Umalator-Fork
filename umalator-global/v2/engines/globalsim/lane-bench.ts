/**
 * GPU-lane benchmark (PERF-PLAN step 0): the committed measuring stick every
 * later perf step reports against. Two workloads through the real pool against
 * a real sim-server:
 *
 *   compare  a compare at `--samples` (default 500) on the app field: course
 *            10504, the default mob preset, plain horses. The auto seed gate
 *            fans it out to 18 setup keys, ~1,000 races.
 *   chart    a Skill-mode chart: `--chart-skills` skills (default 20) at the
 *            default per-skill seed count (CHART_DEFAULT_SEEDS = 200 each).
 *   optimizer one fixed Optimizer run (budget 60 SP, one scenario, a race-bounded
 *            search). Its recommendation and every reported number must match in
 *            every mode, so a lane that changed a measurement fails the run.
 *
 * Four lanes: wasm, native, gpu (all sessions gpu), mixed (one gpu session
 * plus native CPU sessions). Threads `--threads` (default 1,2,4,6,19). Every
 * point is the median of `--runs` (default 3) cold runs: a fresh pool per run,
 * so fresh sim-server children (fresh wasm/native engine, fresh gpu facade).
 * Every measured run's merged records must be byte-identical to the all-wasm
 * reference, else the point FAILs.
 *
 * A point is only reported if its native runs spread inside `--noise` (default
 * 0.05 of the median), since every claim is mixed against native. Rounds
 * interleave the modes at every thread count and rotate which mode goes first,
 * so machine drift lands on all modes alike. A point still too wide after
 * `--max-runs` (default 9) is printed as REFUSED and the bench exits non-zero,
 * so a noisy table cannot pass for a result. A mixed point wider than the
 * limit is printed with a `wide=` figure.
 *
 * Prints every run, then each point as races/s, median/min/max wall ms, spread
 * and gpu launches (run messages the gpu sessions received, one facade call
 * each) on [lane-bench] lines.
 *
 * Run (repo root, GPU to itself):
 *   npm run bench:globalsim-lanes                       full default matrix
 *   npm run bench:globalsim-lanes -- --workloads compare --threads 19 --runs 3
 */

(globalThis as any).CC_GLOBAL = true;

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import { HorseState, SkillSet } from '../../../../components/HorseDefTypes';
import { GroundCondition, Weather, Season, Time, Grade } from '../../../../uma-skill-tools/RaceParameters';
import skillmeta from '../../../../skill_meta.json';
import { buildCompareJobs, globalsimSeedList } from './compare';
import { buildGlobalsimChartJobs, withSkillSwappedIn, CHART_DEFAULT_SEEDS, ChartRaceConditions } from './chart';
import { parseMobPresets } from './mobs';
import { createGlobalsimPool, PoolJob, WorkerLike } from './pool';
import { SimWorker } from './simLink';
import { calculateSkillCost, isPurpleSkill } from '../../skill-chart-utils';
import { EffortConfig, effortConfig } from './optimizer/config';
import { createEvaluator } from './optimizer/evaluator';
import { createController, runOptimizer } from './optimizer/search';
import { BuildSpace, buildSpace } from './optimizer/space';
import { OptimizerResult, ScenarioSpec } from './optimizer/types';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SERVER = path.join(__dirname, 'sim-server.ts');
const TS_NODE = path.join(REPO, 'node_modules', 'ts-node', 'dist', 'bin.js');
const NATIVE_NODE = path.join(REPO, 'globalsim-native', 'globalsim_native.node');
const mergedTable = require(path.join(REPO, 'globalsim/skills.json'));
const knownSkillIds = new Set<string>(Object.keys(mergedTable));
const mobPreset = parseMobPresets(require('./mob-presets.json')).presets['default'];
const courseIds: string[] = Object.keys(require(path.join(REPO, 'vendor/GlobalSim/data/course_data.json')));

const COURSE = '10504';
const DISTANCE = 2000;
const BASE_SEED = 20261115;

type LaneMode = 'wasm' | 'native' | 'gpu' | 'mixed';
const MODES: LaneMode[] = ['wasm', 'native', 'gpu', 'mixed'];

function flag(name: string, dflt: string): string {
	const i = process.argv.indexOf('--' + name);
	return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
}

const opts = {
	workloads: flag('workloads', 'compare,chart').split(','),
	threads: flag('threads', '1,2,4,6,19').split(',').map((n) => Number(n)),
	runs: Number(flag('runs', '3')),
	maxRuns: Number(flag('max-runs', '9')),
	noise: Number(flag('noise', '0.05')),
	samples: Number(flag('samples', '500')),
	chartSkills: Number(flag('chart-skills', '20')),
	chartSeeds: Number(flag('chart-seeds', String(CHART_DEFAULT_SEEDS))),
	modes: flag('modes', 'wasm,native,gpu,mixed').split(','),
	gpuLane: flag('gpu-lane', 'app') as 'app' | 'auto' | 'eager' | 'off',
	batches: Math.max(1, Number(flag('batches', '1'))),
	optBudget: Math.max(1, Number(flag('opt-budget', '600'))),
	optSkills: Math.max(2, Number(flag('opt-skills', '8'))),
	optClimbRaces: Math.max(100, Number(flag('opt-races', '1000'))),
};

// ── sim-server master ─────────────────────────────────────────────────────────

function spawnMaster(backendEnv: string): Promise<{ proc: ChildProcess; url: string }> {
	return new Promise((resolve, reject) => {
		const proc = spawn(process.execPath, [
			TS_NODE, '--transpile-only',
			'--compiler-options', JSON.stringify({ moduleResolution: 'node', module: 'commonjs' }),
			SERVER, '--port=0',
		], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SIM_SERVER_BACKENDS: backendEnv } });
		let buf = '';
		const t = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } reject(new Error(`sim-server did not bind:\n${buf}`)); }, 60_000);
		proc.stdout!.on('data', (d: Buffer) => {
			buf += d.toString();
			const m = /listening on (https?:\/\/[^ ]+) /.exec(buf);
			if (m) { clearTimeout(t); resolve({ proc, url: m[1] }); }
		});
		proc.stderr!.on('data', (d) => { if (process.env.SIMSRV_DEBUG) console.error('[server]', d.toString()); });
		proc.on('exit', () => { clearTimeout(t); reject(new Error(`sim-server exited:\n${buf}`)); });
	});
}
const stop = (proc: ChildProcess) => { try { proc.kill(); } catch { /* gone */ } };

function waitPortFree(port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + 10_000;
		const tryOnce = (): void => {
			const sock = net.connect(port, '127.0.0.1');
			sock.once('connect', () => {
				sock.destroy();
				Date.now() < deadline ? setTimeout(tryOnce, 250) : reject(new Error(`port ${port} still owned`));
			});
			sock.once('error', () => resolve());
		};
		tryOnce();
	});
}

// ── workloads ─────────────────────────────────────────────────────────────────

function horse(): HorseState {
	return new HorseState({
		speed: 1000, stamina: 1000, power: 900, guts: 800, wisdom: 900,
		strategy: 'Senkou', distanceAptitude: 'A', surfaceAptitude: 'A', strategyAptitude: 'A', mood: 2,
	}).set('skills', SkillSet(['100011', '100031', '200011', '100051']));
}

const baseInput = {
	uma1: horse(), uma2: horse(),
	courseId: COURSE, distance: DISTANCE,
	ground: GroundCondition.Good, weather: Weather.Sunny, season: Season.Spring, time: Time.Midday,
	grade: Grade.G1,
	knownSkillIds, courseIds, mobPreset, skillData: mergedTable,
	seedBase: BASE_SEED, sampleCount: opts.samples, threads: 1,
};

function buildWorkload(name: string): PoolJob[] {
	if (name === 'compare') {
		const seeds = globalsimSeedList(BASE_SEED, opts.samples);
		const built = buildCompareJobs(baseInput as any, seeds, 'compact');
		if (built.errors.length) throw new Error(`compare build errors: ${built.errors.join(' | ')}`);
		return built.jobs;
	}
	if (name === 'chart') {
		// The app pre-filters candidates to activateable + coverage. The bench
		// takes the merged table's ids that skill_meta groups (chart-swappable).
		const candidates = Object.keys(mergedTable).filter((id) => (skillmeta as Record<string, { groupId?: string }>)[id]?.groupId).slice(0, opts.chartSkills);
		if (candidates.length < opts.chartSkills) throw new Error(`only ${candidates.length} chart-swappable skills in the table`);
		const seeds = globalsimSeedList(BASE_SEED, opts.chartSeeds);
		const jobs: PoolJob[] = [];
		for (const skill of candidates) {
			const built = buildGlobalsimChartJobs(baseInput as any, `k${skill}`, withSkillSwappedIn(horse(), skill), seeds, { trackSkillId: skill });
			if (built.errors.length) throw new Error(`chart build errors (${skill}): ${built.errors.join(' | ')}`);
			jobs.push(...built.jobs);
		}
		return jobs;
	}
	throw new Error(`unknown workload ${name}`);
}

// ── optimizer workload (N4) ───────────────────────────────────────────────────

/** One fixed Optimizer instance: a space built from the chart-swappable pool,
 *  one scenario, one seed base. Every mode must recommend the same build. */
interface OptimizerSetup {
	space: BuildSpace;
	baseHorse: HorseState;
	scenarios: ScenarioSpec[];
}

function optimizerSetup(): OptimizerSetup {
	// Cost-bearing, non-purple table skills: the space the app's skill picker
	// would offer. Sorted so the same option set is built on every run.
	const hints = new Map<string, number>();
	const owned = new Map<string, string>();
	// One option per skill group, so group exclusivity leaves a real knapsack
	// (tiers of one group could not be picked together anyway). Sorted so the
	// same option set is built on every run.
	const seenGroups = new Set<string>();
	const purchasable: string[] = [];
	for (const id of Object.keys(mergedTable).sort()) {
		const gid = (skillmeta as Record<string, { groupId?: string }>)[id]?.groupId;
		if (!gid || seenGroups.has(gid) || isPurpleSkill(id) || calculateSkillCost(id, hints, owned) <= 0) continue;
		seenGroups.add(gid);
		purchasable.push(id);
		if (purchasable.length >= opts.optSkills) break;
	}
	const space = buildSpace({
		purchasable, ownedByGroup: new Map(), fixedIds: [], hints: new Map(),
		budget: opts.optBudget, knownSkillIds,
	});
	if (space.error) throw new Error(`optimizer space: ${space.error}`);
	if (space.options.length === 0) throw new Error(`optimizer space has no purchasable option (${purchasable.length} offered): ${space.warnings.slice(0, 4).join(' | ')}`);
	const conds: ChartRaceConditions = {
		courseId: COURSE, distance: DISTANCE,
		ground: GroundCondition.Good, weather: Weather.Sunny, season: Season.Spring, time: Time.Midday,
		grade: Grade.G1, knownSkillIds, skillData: mergedTable, courseIds, mobPreset,
	};
	const baseHorse = new HorseState({
		speed: 1000, stamina: 1000, power: 900, guts: 800, wisdom: 900,
		strategy: 'Senkou', distanceAptitude: 'A', surfaceAptitude: 'A', strategyAptitude: 'A', mood: 2,
	}).set('skills', SkillSet([]));
	return { space, baseHorse, scenarios: [{ id: 'main', label: 'Current setup', conds, mobPreset }] };
}

/** The search must stop on races, not on wall time: a time budget would cut it
 *  at a different point per mode and the recommendation would drift by design. */
function optimizerEffort(): EffortConfig {
	return { ...effortConfig('quick'), timeBudgetMs: Infinity, climbRaces: opts.optClimbRaces };
}

interface OptimizerRun {
	wallMs: number;
	races: number;
	launches: number;
	chosen: string;
	fingerprint: string;
}

async function timedOptimizerRun(url: string, mode: LaneMode, threads: number): Promise<OptimizerRun> {
	const setup = optimizerSetup();
	const factory = laneFactory(url, mode);
	const ev = createEvaluator({
		workerFactory: factory.make,
		cpuFactory: mode === 'gpu' || mode === 'mixed' ? () => new SimWorker(url, '', 'native') : undefined,
		gpuFactory: factory.gpuMake,
		threads,
		space: setup.space,
		baseHorse: setup.baseHorse,
		scenarios: setup.scenarios,
		baseSeed: BASE_SEED,
		skillData: mergedTable,
		paired: true,
	});
	const t0 = Date.now();
	let races = 0;
	let res: OptimizerResult;
	try {
		res = await runOptimizer(ev, {
			space: setup.space, scenarioIdx: 0, objective: 'p1', aggregation: 'mean',
			bookStarts: [], effort: optimizerEffort(), wideSearch: false, wideSearchSeed: BASE_SEED,
		}, createController(), () => {});
		races = ev.racesRun();
	} finally {
		ev.dispose();
	}
	const wallMs = Date.now() - t0;
	const best = res.best;
	return {
		wallMs, races, launches: factory.launches.n,
		chosen: best.build.selection.join(','),
		// Every number the run reports, so a lane that moved any measured value
		// (and so a different search path) fails the comparison.
		fingerprint: JSON.stringify({
			chosen: best.build.selection, id: best.build.id, sp: best.sp, leftover: best.leftover,
			obj: [best.obj.mean, best.obj.sem, best.obj.n],
			verificationSeeds: res.verificationSeeds, searchSeedsPerScenario: res.searchSeedsPerScenario,
			certified: [res.certified1MovePeak, res.certified2MovePeak],
			shortlist: res.shortlist.map((b) => b.build.id),
		}),
	};
}


// ── one cold lane run ─────────────────────────────────────────────────────────

/** Wraps a SimWorker and counts the run messages the gpu lane receives: one
 *  run message = one facade call = one (group) launch. A pinned gpu worker
 *  counts before its session opens, since the pool posts the first chunk
 *  then (the backend is only named when the session answers). */
class Counted implements WorkerLike {
	constructor(private readonly w: SimWorker, private readonly count: () => void) {}
	get ready(): Promise<void> { return this.w.ready; }
	get backend(): string | undefined { return this.w.backend; }
	postMessage(msg: unknown): void {
		const m = msg as { type?: string };
		if (m && m.type === 'run' && (this.w.engine === 'gpu' || this.w.backend === 'gpu')) this.count();
		this.w.postMessage(msg);
	}
	addEventListener(type: any, cb: any): void { (this.w as any).addEventListener(type, cb); }
	terminate(): void { this.w.terminate(); }
}

const laneFactory = (url: string, mode: LaneMode): { make: () => WorkerLike; gpuMake?: () => WorkerLike; launches: { n: number } } => {
	const lane = (engine: 'wasm' | 'native' | 'gpu'): SimWorker => new SimWorker(url, '', engine);
	const launches = { n: 0 };
	const count = (w: SimWorker): WorkerLike => new Counted(w, () => launches.n++);
	const make = (): WorkerLike => count(mode === 'wasm' ? lane('wasm') : mode === 'native' ? lane('native') : mode === 'gpu' ? lane('gpu') : lane('native'));
	// A mixed pool's cpu lanes are pinned native and the gpu lane is its own
	// factory, so the pool can hold the session back until a batch pays.
	const gpuMake = mode === 'mixed' ? (): WorkerLike => count(lane('gpu')) : undefined;
	return { make, gpuMake, launches };
};

async function timedRun(url: string, mode: LaneMode, threads: number, jobs: PoolJob[], reference: Map<string, string>, gpuLane: 'auto' | 'eager' | 'off'): Promise<{ wallMs: number; launches: number }> {
	const factory = laneFactory(url, mode);
	const merged = new Map<string, string>();
	const pool = createGlobalsimPool({
		factory: factory.make, threads,
		skillData: mergedTable,
		gpuFactory: factory.gpuMake,
		gpuLane,
		cpuFactory: mode === 'gpu' || mode === 'mixed' ? () => new SimWorker(url, '', 'native') : undefined,
		onChunk: (job: PoolJob, recs: any[]) => { for (const r of recs) merged.set(`${job.setupKey}|${r.seed}`, JSON.stringify(r)); },
	});
	const t0 = Date.now();
	const errors: Array<{ jobId: string; error: string }> = [];
	let fallbacks = 0;
	try {
		// The app's chart (round 1 + optional round 2) and the optimizer
		// (an evaluation per batch) run several batches on one pool, so a gpu
		// lane pays its session open once and then carries warm launches.
		const per = Math.ceil(jobs.length / opts.batches);
		for (let i = 0; i < jobs.length; i += per) {
			const res = await pool.runJobs(jobs.slice(i, i + per));
			errors.push(...res.errors);
			fallbacks += res.gpuFallbacks.reduce((n, t) => n + t.rerunFailures, 0);
		}
	} finally {
		pool.dispose();
	}
	const wallMs = Date.now() - t0;
	if (errors.length) throw new Error(`pool errors: ${JSON.stringify(errors.slice(0, 3))}`);
	if (fallbacks) throw new Error(`rerun failures: ${fallbacks}`);
	if (merged.size !== reference.size) throw new Error(`produced ${merged.size} records, reference has ${reference.size}`);
	for (const [key, json] of reference) {
		if (merged.get(key) !== json) throw new Error(`record differs for ${key}`);
	}
	return { wallMs, launches: factory.launches.n };
}

/** Collect the all-wasm reference records for byte-identity checks. */
async function collectReference(url: string, jobs: PoolJob[]): Promise<Map<string, string>> {
	const merged = new Map<string, string>();
	const pool = createGlobalsimPool({
		factory: () => new SimWorker(url, '', 'wasm'),
		threads: 4,
		skillData: mergedTable,
		onChunk: (job: PoolJob, recs: any[]) => { for (const r of recs) merged.set(`${job.setupKey}|${r.seed}`, JSON.stringify(r)); },
	});
	let res: Awaited<ReturnType<typeof pool.runJobs>>;
	try {
		res = await pool.runJobs(jobs);
	} finally {
		pool.dispose();
	}
	if (res.errors.length) throw new Error(`reference pool errors: ${JSON.stringify(res.errors.slice(0, 3))}`);
	if (merged.size !== jobs.reduce((n, j) => n + j.seeds.length, 0)) throw new Error(`reference produced ${merged.size} records`);
	return merged;
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** Relative spread of a point's runs, from its median. */
const spreadOf = (walls: number[]): number => {
	const med = median(walls);
	return med > 0 ? (Math.max(...walls) - Math.min(...walls)) / med : Infinity;
};

/** The lane policy the app uses for this workload: compare keeps the lane off
 *  unless a batch pays, chart and the optimizer pay one cold launch and keep it. */
function appPolicy(workload: string): 'auto' | 'eager' | 'off' {
	if (opts.gpuLane !== 'app') return opts.gpuLane;
	return workload === 'compare' ? 'auto' : 'eager';
}

/** N4: one fixed Optimizer run per point. The run is race-bounded and seeded,
 *  so every mode must print the same recommendation and the same numbers. */
async function optimizerTable(url: string, refused: string[]): Promise<void> {
	const modes = MODES.filter((m) => (opts.modes as string[]).includes(m));
	const probe = optimizerSetup();
	console.log(`\n=== optimizer: one fixed run, budget ${probe.space.budget} SP over ${probe.space.options.length} options (cost ${probe.space.options.map((o) => o.cost).join(',')}), climb budget ${opts.optClimbRaces} races, objective p1 ===`);
	interface OptPoint {
		mode: LaneMode;
		threads: number;
		walls: number[];
		races: number;
		launches: number;
		chosen: string;
		fingerprint: string;
		bad: string;
	}
	const points: OptPoint[] = [];
	for (const threads of opts.threads) {
		for (const mode of modes) points.push({ mode, threads, walls: [], races: 0, launches: 0, chosen: '', fingerprint: '', bad: '' });
	}
	const sample = async (p: OptPoint): Promise<void> => {
		if (p.bad) return;
		try {
			const res = await timedOptimizerRun(url, p.mode, p.threads);
			p.walls.push(res.wallMs);
			p.races = res.races;
			p.launches = res.launches;
			p.chosen = res.chosen;
			if (!p.fingerprint) p.fingerprint = res.fingerprint;
			else if (p.fingerprint !== res.fingerprint) throw new Error('two runs of one point disagree');
			console.log(`[lane-bench] run optimizer ${p.mode} threads=${p.threads} #${p.walls.length} wall=${res.wallMs}ms races=${res.races} build=${res.chosen || '(empty)'} gpuLaunches=${res.launches}`);
		} catch (e) {
			p.bad = String(e);
		}
	};
	const round = async (r: number): Promise<void> => {
		const rotated = modes.slice(r % modes.length).concat(modes.slice(0, r % modes.length));
		for (const threads of opts.threads) {
			for (const mode of rotated) await sample(points.find((p) => p.mode === mode && p.threads === threads)!);
		}
	};
	for (let r = 0; r < opts.runs; r++) await round(r);
	for (let r = opts.runs; r < opts.maxRuns; r++) {
		if (!points.some((p) => !p.bad && spreadOf(p.walls) > opts.noise)) break;
		await round(r);
	}
	const nativeSpread = new Map<number, number>();
	for (const p of points) if (p.mode === 'native') nativeSpread.set(p.threads, spreadOf(p.walls));
	for (const p of points) {
		if (p.bad) {
			console.log(`[lane-bench] point optimizer ${p.mode} threads=${p.threads} FAIL ${p.bad}`);
			refused.push(`optimizer ${p.mode} threads=${p.threads}`);
			continue;
		}
		const med = median(p.walls);
		const spread = spreadOf(p.walls);
		const gate = nativeSpread.get(p.threads) ?? spread;
		const wide = p.mode !== 'native' && spread > opts.noise ? ` wide=${(spread * 100).toFixed(1)}%` : '';
		const line = `[lane-bench] point optimizer ${p.mode} threads=${p.threads} races/s=${(p.races / med * 1000).toFixed(1)} races=${p.races} median=${med}ms min=${Math.min(...p.walls)} max=${Math.max(...p.walls)} spread=${(spread * 100).toFixed(1)}%${wide} runs=${p.walls.length} gpuLaunches=${p.launches} build=${p.chosen || '(empty)'}`;
		if (gate > opts.noise) {
			console.log(`${line} REFUSED (native spread ${(gate * 100).toFixed(1)}% > ${(opts.noise * 100).toFixed(1)}%)`);
			refused.push(`optimizer ${p.mode} threads=${p.threads}`);
		} else {
			console.log(line);
		}
	}
	// The N4 gate: one fixed run, one recommendation and one set of numbers in
	// every mode. The fingerprint covers the build and everything the run reports.
	const ok = points.filter((p) => !p.bad);
	const ref = ok.find((p) => p.mode === 'native') ?? ok[0];
	if (!ref) return;
	const disagree = ok.filter((p) => p.fingerprint !== ref.fingerprint);
	console.log(`[lane-bench] optimizer recommendation: ${ref.chosen || '(empty)'} (${ref.mode} threads=${ref.threads}, ${ref.fingerprint.length}-char fingerprint)`);
	if (disagree.length) {
		for (const p of disagree) console.log(`[lane-bench] optimizer MISMATCH ${p.mode} threads=${p.threads} build=${p.chosen || '(empty)'}`);
		refused.push(`optimizer: ${disagree.length} run(s) disagree with the native recommendation`);
	} else {
		console.log(`[lane-bench] optimizer agreement: all ${ok.length} runs picked the same build and reported identical numbers`);
	}
}

interface Point {
	mode: LaneMode;
	threads: number;
	policy: 'auto' | 'eager' | 'off';
	walls: number[];
	launches: number;
	bad: string;
}

async function main(): Promise<void> {
	if (!fs.existsSync(NATIVE_NODE)) throw new Error(`native addon missing: ${NATIVE_NODE} (npm run build:globalsim-native-gpu)`);
	const addon = require(NATIVE_NODE);
	if (typeof addon.gpuAvailable !== 'function' || !addon.gpuAvailable().ok) throw new Error('gpu lane unavailable (build with npm run build:globalsim-native-gpu)');

	const logical = os.cpus().length;
	const modes = MODES.filter((m) => (opts.modes as string[]).includes(m));
	console.log(`[lane-bench] machine: ${logical} logical CPUs, threads ${opts.threads.join(',')}, runs ${opts.runs} to ${opts.maxRuns}, noise limit ${(opts.noise * 100).toFixed(1)}%`);
	const refused: string[] = [];
	const { proc, url } = await spawnMaster('wasm,native,gpu');
	try {
		for (const workload of opts.workloads) {
			if (workload === 'optimizer') { await optimizerTable(url, refused); continue; }
			const jobs = buildWorkload(workload);
			const races = jobs.reduce((n, j) => n + j.seeds.length, 0);
			const keys = new Set(jobs.map((j) => j.setupKey)).size;
			const policy = appPolicy(workload);
			console.log(`\n=== ${workload}: ${races} races, ${jobs.length} jobs, ${keys} setup keys, gpu lane policy ${policy} ===`);
			const reference = await collectReference(url, jobs);
			console.log('[lane-bench] reference collected (all-wasm, threads 4)');
			const points: Point[] = [];
			for (const threads of opts.threads) {
				for (const mode of modes) points.push({ mode, threads, policy, walls: [], launches: 0, bad: '' });
			}
			const label = (p: Point): string => (p.mode === 'mixed' ? `mixed(${p.policy})` : p.mode);
			const sample = async (p: Point): Promise<void> => {
				if (p.bad) return;
				try {
					const res = await timedRun(url, p.mode, p.threads, jobs, reference, p.policy);
					p.walls.push(res.wallMs);
					p.launches = res.launches;
					console.log(`[lane-bench] run ${workload} ${label(p)} threads=${p.threads} #${p.walls.length} wall=${res.wallMs}ms races/s=${(races / res.wallMs * 1000).toFixed(1)} gpuLaunches=${res.launches}`);
				} catch (e) {
					p.bad = String(e);
				}
			};
			// One round measures every point once. The mode order rotates per
			// round so no mode is always measured on the same side of the drift.
			const round = async (r: number): Promise<void> => {
				const rotated = modes.slice(r % modes.length).concat(modes.slice(0, r % modes.length));
				for (const threads of opts.threads) {
					for (const mode of rotated) {
						await sample(points.find((p) => p.mode === mode && p.threads === threads)!);
					}
				}
			};
			for (let r = 0; r < opts.runs; r++) await round(r);
			// A wide point earns extra rounds, each remeasuring every point so the
			// modes stay interleaved, up to `--max-runs`.
			for (let r = opts.runs; r < opts.maxRuns; r++) {
				if (!points.some((p) => !p.bad && spreadOf(p.walls) > opts.noise)) break;
				await round(r);
			}
			// The plan's rule: a point is reported only when its native runs are
			// steady, since every claim is mixed against native. A non-native
			// point wider than the limit is printed with its spread flagged.
			const nativeSpread = new Map<number, number>();
			for (const p of points) if (p.mode === 'native') nativeSpread.set(p.threads, spreadOf(p.walls));
			for (const p of points) {
				if (p.bad) {
					console.log(`[lane-bench] point ${workload} ${label(p)} threads=${p.threads} FAIL ${p.bad}`);
					refused.push(`${workload} ${label(p)} threads=${p.threads}`);
					continue;
				}
				const med = median(p.walls);
				const spread = spreadOf(p.walls);
				const gate = nativeSpread.get(p.threads) ?? spread;
				const wide = p.mode !== 'native' && spread > opts.noise ? ` wide=${(spread * 100).toFixed(1)}%` : '';
				const line = `[lane-bench] point ${workload} ${label(p)} threads=${p.threads} races/s=${(races / med * 1000).toFixed(1)} median=${med}ms min=${Math.min(...p.walls)} max=${Math.max(...p.walls)} spread=${(spread * 100).toFixed(1)}%${wide} runs=${p.walls.length} gpuLaunches=${p.launches}`;
				if (gate > opts.noise) {
					console.log(`${line} REFUSED (native spread ${(gate * 100).toFixed(1)}% > ${(opts.noise * 100).toFixed(1)}%)`);
					refused.push(`${workload} ${label(p)} threads=${p.threads}`);
				} else {
					console.log(line);
				}
			}
		}
	} finally {
		stop(proc);
		await waitPortFree(Number(new URL(url).port));
	}
	if (refused.length) {
		console.error(`[lane-bench] ${refused.length} refused point(s): ${refused.join(', ')}`);
		process.exitCode = 1;
	}
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });
