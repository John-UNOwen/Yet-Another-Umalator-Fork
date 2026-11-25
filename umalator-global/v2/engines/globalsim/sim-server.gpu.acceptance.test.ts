/**
 * GPU backend acceptance (handoff step 2 gpu slot + step 5 rerun-by-scheduler):
 *
 *   (a) the real v77 line-1 request (GlobalSim-gpu/examples/v77-race.jsonl), 8
 *       seeds through a gpu session and through a wasm session: every compact
 *       record byte-identical and the gpu lane never falls back,
 *   (b) a request on the engine's classic lane that only the gpu lane refuses:
 *       the gpu session answers {seed, gpuFallback}. The pool re-runs those
 *       seeds on a
 *       CPU backend before onChunk, and the merged output equals an all-CPU
 *       run byte for byte. The per-job tally reports every refusal by reason,
 *       and as rerun failures when the pool has no rerun lane.
 *   (c) SIM_SERVER_BACKENDS=wasm,gpu rotates ONE gpu session first, then the
 *       CPU backends, and hands the gpu lane to a later session once the first
 *       one is deleted (a batch-capable lane answers a whole seed block in one
 *       launch, so a second gpu session would only narrow the launches and take
 *       a CPU slot away),
 *   (d) the gpu batch lane: a 64-seed v77 chunk answers in ONE gpuRunCompactBatch
 *       facade call, byte-identical to the 64 per-seed wasm records and
 *       fallback-free, and the gpu-batch / gpu-per-seed / wasm-per-seed
 *       wall-time table is printed,
 *   (e) register_geometry feeds the gpu facade: the vendor geometry copy
 *       injects cleanly through the addon (engine-side verification throws
 *       otherwise), and a gpu session that registered it runs the kernel
 *       fallback-free with records byte-identical to wasm (the proof that the
 *       kernel flattens the injected copy lives engine-side, facade_gate),
 *   (f) two-consumer gpu gate: two concurrent sim-server gpu sessions, each
 *       with its own single-thread pool over 16 v77 seeds, finish and produce
 *       records byte-identical to the wasm reference, each under SESSION_BUDGET_MS,
 *       and their session windows overlap (so the pair ran at once).
 *       This pins the multi-consumer contract: on 2026-11-18 a two-session
 *       pool run stalled for minutes on one driver state. Every re-measured
 *       run since shares the device linearly at kernel granularity, and any
 *       regression past the per-session budget fails here.
 *   (g) gpu group lane: the compare field at 90 samples (auto gate ⇒ 18 setup
 *       keys, 180 races) through a one-thread gpu pool answers the whole batch
 *       in ONE run message with no fallbacks, and every per-seed record is
 *       byte-identical to the same batch on an all-wasm pool. That is the
 *       cross-setup packing end to end: before it, one launch per setup key.
 *
 * Machine-conditional: prints a skip reason and skips every case when the gpu
 * lane is unavailable (addon not built with --features gpu, or the device gate
 * refuses). The B580 dev machine runs it for real.
 *
 * Run: npm run test:globalsim-backend-gpu  (from the repo root)
 */

// Same CC_GLOBAL-before-import trick as compare.acceptance.test.ts.
(globalThis as any).CC_GLOBAL = true;

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { HorseState, SkillSet } from '../../../../components/HorseDefTypes';
import { GroundCondition, Weather, Season, Time, Grade } from '../../../../uma-skill-tools/RaceParameters';
import { runGlobalsimSkillChart } from './chart';
import { buildCompareJobs, globalsimSeedList } from './compare';
import { parseMobPresets } from './mobs';
import { createGlobalsimPool, PoolJob, WorkerFactory } from './pool';
import { pingSimServer, simGpuFactory, SimWorker } from './simLink';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SERVER = path.join(__dirname, 'sim-server.ts');
const TS_NODE = path.join(REPO, 'node_modules', 'ts-node', 'dist', 'bin.js');
const NATIVE_NODE = path.join(REPO, 'globalsim-native', 'globalsim_native.node');
const V77_LINE1 = path.join(REPO, '..', 'GlobalSim-gpu', 'examples', 'v77-race.jsonl');
const mergedTable = require(path.join(REPO, 'globalsim/skills.json'));
const knownSkillIds = new Set<string>(Object.keys(mergedTable));
const mobPreset = parseMobPresets(require('./mob-presets.json')).presets['default'];
const courseIds: string[] = Object.keys(require(path.join(REPO, 'vendor/GlobalSim/data/course_data.json')));

const COURSE = '10504';
const DISTANCE = 2000;
const BASE_SEED = 20261115;
const N = 8;
const BATCH_N = 64;   // batch-lane case (d): one chunk, 64 seeds
const GATE = 3; // fixed single gate group → one chunk job (chunk 25) holds all seeds

// ── machine gate: only run on a machine where the gpu lane actually opens ────
let skipReason = '';
try {
	const addon = require(NATIVE_NODE);
	if (typeof addon.gpuAvailable !== 'function') skipReason = 'addon has no gpu lane (build with npm run build:globalsim-native-gpu)';
	else {
		const a = addon.gpuAvailable();
		if (!a.ok) skipReason = `gpu unavailable: ${a.reasons.join(', ')}`;
	}
	if (!skipReason && !fs.existsSync(V77_LINE1)) skipReason = `v77 example missing: ${V77_LINE1} (sibling gpu-backend checkout)`;
} catch (e: any) {
	skipReason = `addon not built: ${String(e?.message || e).split('\n')[0]}`;
}
const gpuSkip = skipReason ? skipReason : false;
if (skipReason) console.log(`[gpu-acceptance] SKIPPED — ${skipReason}`);

function spawnMaster(backendEnv: string, extraEnv: Record<string, string> = {}): Promise<{ proc: ChildProcess; url: string; out: () => string }> {
	return new Promise((resolve, reject) => {
		const proc = spawn(process.execPath, [
			TS_NODE, '--transpile-only',
			'--compiler-options', JSON.stringify({ moduleResolution: 'node', module: 'commonjs' }),
			SERVER, '--port=0',
		], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SIM_SERVER_BACKENDS: backendEnv, ...extraEnv } });
		let buf = '';
		const t = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } reject(new Error(`sim-server did not bind:\n${buf}`)); }, 60_000);
		proc.stdout!.on('data', (d: Buffer) => {
			buf += d.toString();
			const m = /listening on (https?:\/\/[^ ]+) /.exec(buf);
			if (m) { clearTimeout(t); resolve({ proc, url: m[1], out: () => buf }); }
		});
		proc.stderr!.on('data', (d) => { if (process.env.SIMSRV_DEBUG) console.error('[server]', d.toString()); });
		proc.on('exit', () => { clearTimeout(t); reject(new Error(`sim-server exited:\n${buf}`)); });
	});
}
const stop = (proc: ChildProcess) => { try { proc.kill(); } catch { /* gone */ } };

/** The startup check runs off the request path: poll until its verdict lands. */
async function waitGpuVerdict(url: string): Promise<any> {
	const deadline = Date.now() + 120_000;
	for (;;) {
		const r = await (await fetch(`${url}/ping`)).json() as any;
		if (r.gpu && r.gpu.pending !== true) return r.gpu;
		if (Date.now() > deadline) throw new Error('gpu startup check did not finish');
		await new Promise((res) => setTimeout(res, 250));
	}
}

async function postMsg(url: string, id: string, m: unknown): Promise<void> {
	const r = await fetch(`${url}/session/${id}/msg`, { method: 'POST', body: JSON.stringify(m) });
	assert.equal(r.status, 202, `POST /session/${id}/msg → ${r.status}`);
}

async function pollOut(url: string, id: string, accept: (m: any) => boolean, budgetMs: number, what: string): Promise<any[]> {
	const deadline = Date.now() + budgetMs;
	for (;;) {
		const r = await fetch(`${url}/session/${id}/out?ack=1`, { signal: AbortSignal.timeout(Math.max(1_000, Math.min(30_000, deadline - Date.now()))) });
		assert.equal(r.status, 200, `GET /session/${id}/out → ${r.status}`);
		const { msgs } = await r.json() as { msgs: any[] };
		assert.ok(!msgs.some((m: any) => m.type === '__died'), `session ${id} child died while waiting for ${what}`);
		if (msgs.some(accept)) return msgs;
		assert.ok(Date.now() < deadline, `timed out waiting for ${what} on session ${id}`);
	}
}

/** Open a session (engine undefined = rotation), run the job compact, return its records. */
async function runBatch(url: string, engine: 'wasm' | 'native' | 'gpu' | undefined, job: any, budgetMs = 300_000): Promise<{ backend: string; records: any[]; runMs: number }> {
	const open = await fetch(`${url}/session`, { method: 'POST', body: JSON.stringify(engine ? { engine } : {}) });
	assert.equal(open.status, 200, 'POST /session');
	const s = await open.json() as any;
	try {
		await postMsg(url, s.sessionId, { type: 'skillData', skillData: mergedTable });
		await postMsg(url, s.sessionId, { type: 'prepare', id: 'p1', setupKey: job.setupKey, request: job.request, distance: job.distance });
		const prepMsgs = await pollOut(url, s.sessionId, (m) => m.type === 'prepared' && m.setupKey === job.setupKey, 180_000, 'prepared');
		const prep = prepMsgs.find((m: any) => m.type === 'prepared');
		assert.ok(prep.ok, `prepare failed: ${prep.error}`);
		await postMsg(url, s.sessionId, { type: 'run', jobId: 'j1', setupKey: job.setupKey, seeds: job.seeds, mode: 'compact' });
		const runMsgs = await pollOut(url, s.sessionId, (m) => m.type === 'chunk' && m.jobId === 'j1', budgetMs, 'chunk');
		const chunk = runMsgs.find((m: any) => m.type === 'chunk' && m.jobId === 'j1');
		assert.ok(chunk.ok, `chunk failed: ${chunk.error}`);
		return { backend: s.backend, records: chunk.records, runMs: chunk.runMs ?? 0 };
	} finally {
		await fetch(`${url}/session/${s.sessionId}`, { method: 'DELETE' }).catch(() => { /* gone */ });
	}
}

// ── batches ──────────────────────────────────────────────────────────────────

/** The engine's own v77 race request line 1 (its own skillData travels with it). */
function v77Job(): any {
	const request = JSON.parse(fs.readFileSync(V77_LINE1, 'utf8').split(/\r?\n/)[0]);
	return { setupKey: 'v77-line1', request, seeds: Array.from({ length: N }, (_, i) => BASE_SEED + i), distance: DISTANCE };
}

function horse(): HorseState {
	return new HorseState({
		speed: 1000, stamina: 1000, power: 900, guts: 800, wisdom: 900,
		strategy: 'Senkou', distanceAptitude: 'A', surfaceAptitude: 'A', strategyAptitude: 'A', mood: 2,
	}).set('skills', SkillSet(['100011', '100031', '200011', '100051']));
}

/** The mob-layout jobs on the engine's classic lane: with none of the retail
 *  flags the CPU engine reads, it ignores the retailRuntime key and runs the
 *  race, while the gpu lane refuses it (gpuRefusals, one text per gpu entry).
 *  No skill is involved, so skill ports cannot flip it. */
function refusedJobs(): any[] {
	const h = horse();
	const seeds = Array.from({ length: N }, (_, i) => BASE_SEED + i);
	const built = buildCompareJobs({
		uma1: h, uma2: h,
		courseId: COURSE, distance: DISTANCE,
		ground: GroundCondition.Good, weather: Weather.Sunny, season: Season.Spring, time: Time.Midday,
		grade: Grade.G1,
		knownSkillIds, courseIds, mobPreset, skillData: mergedTable,
		seedBase: BASE_SEED, sampleCount: N, threads: 1, fixedGate: GATE,
	} as any, seeds, 'compact');
	assert.equal(built.errors.length, 0, `job build errors: ${built.errors.join(' | ')}`);
	for (const job of built.jobs) {
		const request = job.request as Record<string, unknown>;
		for (const flag of ['experimentalRetailRuntime', 'experimentalRetailInitialization', 'experimentalRetailSections', 'experimentalRetailStartup', 'experimentalRetailGeometry']) {
			delete request[flag];
		}
		request.retailRuntime = true;
	}
	return built.jobs;
}

/** Both refusal texts a gpu lane quotes for this request: the per-seed and
 *  batch lanes answer from classic_exec's retail-config gate, the group entry
 *  from its own classic-lane guard. */
const gpuRefusals = ['retail runtime belongs to the retail lane', 'the compact launch runs the retail kernel only'];
const isGpuRefusal = (reason: unknown): boolean => typeof reason === 'string' && gpuRefusals.some((text) => reason.includes(text));

function waitPortFree(port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + 10_000;
		const tryOnce = (): void => {
			const sock = net.connect(port, '127.0.0.1');
			sock.once('connect', () => {
				sock.destroy();
				Date.now() < deadline
					? setTimeout(tryOnce, 250)
					: reject(new Error(`port ${port} still owned after the server died`));
			});
			sock.once('error', () => resolve());
		};
		tryOnce();
	});
}

const bySeed = (records: any[]): Map<number, string> => new Map(records.map((r: any) => [r.seed, JSON.stringify(r)]));
function assertSameRecords(a: Map<number, string>, b: Map<number, string>, what: string): void {
	assert.deepEqual([...a.keys()].sort((x, y) => x - y), [...b.keys()].sort((x, y) => x - y), `${what}: same seed set`);
	for (const seed of a.keys()) assert.equal(b.get(seed), a.get(seed), `${what}: record JSON differs for seed ${seed}`);
}

// ── (a) gpu vs wasm byte identity on the v77 line-1 race ─────────────────────
test('gpu session vs wasm session: v77 line-1 batch, 8 seeds, compact records byte-identical', { skip: gpuSkip }, async () => {
	const job = v77Job();
	const { proc, url, out } = await spawnMaster('wasm');
	try {
		const gpuRun = await runBatch(url, 'gpu', job);
		assert.equal(gpuRun.backend, 'gpu', 'engine:gpu session got the gpu backend');
		assert.ok(gpuRun.records.every((r: any) => !r.error && !r.gpuFallback),
			`gpu lane ran all seeds: ${JSON.stringify(gpuRun.records.map((r: any) => r.gpuFallback ?? r.error ?? 'ok'))}`);
		const wasmRun = await runBatch(url, 'wasm', job);
		assert.equal(wasmRun.backend, 'wasm');
		assert.equal(gpuRun.records.length, N, 'gpu: one record per seed');
		assert.ok(gpuRun.records.some((r: any) => JSON.stringify(r).includes('"tail"')), 'compact records carry the tail grid (not degenerate)');
		assertSameRecords(bySeed(gpuRun.records), bySeed(wasmRun.records), 'gpu vs wasm');
		// Cheap observation for the handoff: the gpu lane's per-seed run_batch loop
		// (one request per call, facade prepares every race) against the wasm loop.
		console.log(`[gpu-perf] ${N} seeds runMs: gpu=${gpuRun.runMs.toFixed(1)} wasm=${wasmRun.runMs.toFixed(1)}`);
		assert.ok(out().includes('[sim-server] engine backend: gpu'), 'gpu child reported its backend');
	} finally {
		stop(proc);
		await waitPortFree(Number(new URL(url).port));
	}
});

// ── (b) classic-lane batch: gpuFallback → pool CPU rerun → all-CPU parity ───
test('classic-lane batch: gpu answers gpuFallback, pool re-runs on CPU, merged output equals all-CPU', { skip: gpuSkip }, async () => {
	const jobs = refusedJobs();
	const { proc, url } = await spawnMaster('wasm');
	try {
		// The raw gpu session flags every seed with the classic-lane refusal.
		const gpuRun = await runBatch(url, 'gpu', jobs[0]);
		assert.ok(gpuRun.records.length > 0 && gpuRun.records.every((r: any) => typeof r.gpuFallback === 'string'),
			`every record carries gpuFallback: ${JSON.stringify(gpuRun.records[0]).slice(0, 400)}`);
		assert.ok(gpuRun.records.every((r: any) => isGpuRefusal(r.gpuFallback)),
			`fallback names the classic lane: ${gpuRun.records[0].gpuFallback}`);

		// The pool: every sampling worker is a gpu session. cpuFactory is the
		// CPU rerun lane (native first, else wasm).
		const cpuBackend = fs.existsSync(NATIVE_NODE) ? 'native' : 'wasm';
		const collect = () => {
			const merged = new Map<number, string>();
			return { merged, onChunk: (_job: PoolJob, records: any[]) => { for (const r of records) merged.set(r.seed, JSON.stringify(r)); } };
		};
		const gpuSide = collect();
		const pool = createGlobalsimPool({
			factory: () => new SimWorker(url, '', 'gpu'),
			cpuFactory: () => new SimWorker(url, '', cpuBackend),
			threads: 1,
			skillData: mergedTable,
			onChunk: gpuSide.onChunk,
		});
		const gpuRes = await pool.runJobs(jobs).finally(() => pool.dispose());
		assert.equal(gpuRes.errors.length, 0, `pool job errors: ${JSON.stringify(gpuRes.errors)}`);
		for (const json of gpuSide.merged.values()) {
			assert.ok(!json.includes('gpuFallback'), `merged chunk has no gpuFallback record left: ${json.slice(0, 120)}`);
			assert.ok(!json.includes('rerun'), `merged chunk has no rerun-failure record: ${json.slice(0, 120)}`);
		}

		// The all-CPU reference on the same jobs.
		const refSide = collect();
		const refPool = createGlobalsimPool({
			factory: () => new SimWorker(url, '', 'wasm'),
			threads: 1,
			skillData: mergedTable,
			onChunk: refSide.onChunk,
		});
		const refRes = await refPool.runJobs(jobs).finally(() => refPool.dispose());
		assert.equal(refRes.errors.length, 0, `reference pool job errors: ${JSON.stringify(refRes.errors)}`);

		assert.ok(gpuSide.merged.size > 0, 'gpu+rerun pool produced records');
		assertSameRecords(refSide.merged, gpuSide.merged, 'merged vs all-CPU');

		// Handoff step 5 "count and report them": every refusal tallied by reason.
		const seedsOf = new Map<string, number>(jobs.map((j: any) => [j.id, j.seeds.length as number]));
		assert.equal(gpuRes.gpuFallbacks.length, jobs.length, 'one tally per pool job');
		assert.deepEqual(gpuRes.gpuFallbacks.map(t => t.jobId).sort(), jobs.map((j: any) => j.id).sort(), 'tallies name the pool jobs');
		for (const t of gpuRes.gpuFallbacks) {
			const n = seedsOf.get(t.jobId)!;
			assert.equal(t.races, n, `races = records the gpu lane answered: ${JSON.stringify(t)}`);
			const reasons = Object.keys(t.fallbacks);
			assert.equal(reasons.length, 1, `one gate reason: ${JSON.stringify(t)}`);
			assert.ok(isGpuRefusal(reasons[0]), `the reason names the classic-lane gate: ${reasons[0]}`);
			assert.equal(t.fallbacks[reasons[0]], n, `fully gated job counts every seed under the gate reason: ${JSON.stringify(t)}`);
			assert.equal(t.rerunFailures, 0, 'the rerun lane recovered every refusal');
		}

		// No rerun lane: refusals land as {seed, error} and count as rerun failures.
		const noLane = collect();
		const noLanePool = createGlobalsimPool({
			factory: () => new SimWorker(url, '', 'gpu'),
			threads: 1,
			skillData: mergedTable,
			onChunk: noLane.onChunk,
		});
		const noLaneRes = await noLanePool.runJobs(jobs).finally(() => noLanePool.dispose());
		assert.equal(noLaneRes.errors.length, 0, `no-lane pool job errors: ${JSON.stringify(noLaneRes.errors)}`);
		assert.equal(noLaneRes.gpuFallbacks.length, jobs.length, 'the tally also covers the no-lane pool');
		for (const t of noLaneRes.gpuFallbacks) {
			const n = seedsOf.get(t.jobId)!;
			assert.ok(Object.keys(t.fallbacks).length === 1 && isGpuRefusal(Object.keys(t.fallbacks)[0]), `reasons counted the same without a lane: ${JSON.stringify(t)}`);
			assert.equal(Object.values(t.fallbacks)[0], n, `the no-lane tally counts every seed: ${JSON.stringify(t)}`);
			assert.equal(t.rerunFailures, n, `every refusal is a rerun failure without a lane: ${JSON.stringify(t)}`);
		}
		assert.equal(noLane.merged.size, N, 'no-lane pool still delivered every seed');
		for (const json of noLane.merged.values()) {
			assert.ok(!json.includes('gpuFallback'), `no raw refusal left: ${json.slice(0, 120)}`);
			assert.match(JSON.parse(json).error, /CPU rerun lane/, 'refusal became a rerun-failure error record');
		}
	} finally {
		stop(proc);
		await waitPortFree(Number(new URL(url).port));
	}
});

// ── (c) rotation and the lane split ──────────────────────────────────────────
test('SIM_SERVER_BACKENDS=wasm,gpu keeps gpu out of the rotation, and /ping reports the lane', { skip: gpuSkip }, async () => {
	const { proc, url, out } = await spawnMaster('wasm,gpu');
	try {
		const open = async (engine?: string): Promise<any> => {
			const r = await fetch(`${url}/session`, { method: 'POST', body: JSON.stringify(engine ? { engine } : {}) });
			assert.equal(r.status, 200);
			return r.json() as Promise<any>;
		};
		const a = await open();
		assert.equal(a.backend, 'wasm', 'rotation never hands out a gpu session');
		const b = await open();
		assert.equal(b.backend, 'wasm', 'the second engine-less session stays on a CPU backend');
		// The extra lane opens through an explicit pin, which the pool's gpu
		// factory always sends. A pinned session waits for the startup check.
		const lane = await open('gpu');
		assert.equal(lane.backend, 'gpu', 'a pinned engine:gpu session still opens');
		// /ping carries the verdict the app gates the extra lane on, with the
		// device and the cost measured by the startup check.
		const gpu = await waitGpuVerdict(url);
		assert.equal(gpu.ok, true, '/ping reports the exact device');
		assert.equal(gpu.batch, true, '/ping reports the batch entry');
		assert.ok(typeof gpu.device === 'string' && gpu.device.length > 0, '/ping names the gpu device');
		assert.equal(gpu.parityOk, true, 'the startup guard race matched the CPU engine');
		assert.ok(typeof gpu.floorMs === 'number' && gpu.floorMs > 0, 'the startup check measures a launch floor');
		assert.ok(typeof gpu.slopeMsPerRace === 'number' && gpu.slopeMsPerRace > 0, 'the startup check measures a per-race slope');
		assert.ok(!out().includes('gpu lane unavailable'), 'no lane warning on a gpu machine');
		assert.ok(out().includes('[sim-server] gpu: on ('), 'the startup status line says the lane is on');
		assert.ok(out().includes('[sim-server] program cache:'), 'the server reports the program cache it uses');
		for (const id of [a.sessionId, b.sessionId, lane.sessionId]) await fetch(`${url}/session/${id}`, { method: 'DELETE' });
	} finally {
		stop(proc);
		await waitPortFree(Number(new URL(url).port));
	}
});

// ── (e) the app path: /ping gates the extra lane, the chart uses it ───────────
test('app chart path: a /ping-derived lane factory runs gpu launches and the rows match all-native', { skip: gpuSkip }, async () => {
	const { proc, url, out } = await spawnMaster('native');
	try {
		// Exactly what app-v2 does on checkSimServer: trust the server's verdict,
		// which arrives once the startup check finishes.
		await waitGpuVerdict(url);
		const ping = await pingSimServer(url, '');
		assert.equal(ping.ok, true, 'the server answers /ping');
		assert.equal(ping.gpu?.ok, true, '/ping reports an exact device');
		assert.equal(ping.gpu?.batch, true, '/ping reports the batch entry');
		assert.ok(typeof ping.gpu?.device === 'string' && ping.gpu.device.length > 0, '/ping names the gpu device');
		assert.equal(ping.gpu?.parityOk, true, 'the startup guard race matched the CPU engine');
		const lane = ping.gpu?.ok && ping.gpu.batch ? simGpuFactory(url, '') : undefined;
		assert.ok(lane, 'a batch-capable device yields the extra-lane factory');
		const cpuFactory: WorkerFactory = () => new SimWorker(url, '', 'native');
		const input = (gpuFactory?: WorkerFactory) => ({
			uma: new HorseState({
				speed: 1000, stamina: 1000, power: 900, guts: 800, wisdom: 900,
				strategy: 'Senkou', distanceAptitude: 'A', surfaceAptitude: 'A', strategyAptitude: 'A', mood: 2,
			}),
			skills: ['200011', '200241'],
			courseId: COURSE, distance: DISTANCE,
			ground: GroundCondition.Good, weather: Weather.Sunny, season: Season.Spring, time: Time.Midday,
			knownSkillIds, courseIds, mobPreset, skillData: mergedTable,
			// One thread and the max chamber size: the drain then covers the
			// lane's fixed cost, so the pool opens it (the gate is the sizing rule).
			seedBase: BASE_SEED, sampleCount: 1000, threads: 1,
			workerFactory: cpuFactory, cpuFactory,
			...(gpuFactory ? { gpuFactory } : {}),
		} as any);
		const allCpu = await runGlobalsimSkillChart(input());
		const withLane = await runGlobalsimSkillChart(input(lane));
		assert.ok(out().includes('[sim-server] gpu launch 1'), 'the server log counts the lane launches');
		assert.deepEqual(withLane, allCpu, 'chart rows are identical with and without the lane');
	} finally {
		stop(proc);
		await waitPortFree(Number(new URL(url).port));
	}
});

// ── (d) the gpu batch lane: one facade call for a whole seed chunk ─────────────
test('gpu batch lane: 64-seed v77 chunk answers in one facade call, byte-identical to 64 per-seed wasm records, fallback-free', { skip: gpuSkip }, async () => {
	const request = JSON.parse(fs.readFileSync(V77_LINE1, 'utf8').split(/\r?\n/)[0]);
	const job = { setupKey: 'v77-line1-64', request, seeds: Array.from({ length: BATCH_N }, (_, i) => BASE_SEED + i), distance: DISTANCE };
	/** One fresh master per timed lane (a gpu child builds its facade on session open). */
	const timedLane = async (engine: 'gpu' | 'wasm', extraEnv: Record<string, string> = {}) => {
		const { proc, url } = await spawnMaster('wasm', extraEnv);
		try {
			const t0 = Date.now();
			const res = await runBatch(url, engine, job);
			return { ...res, wallMs: Date.now() - t0 };
		} finally {
			stop(proc);
			await waitPortFree(Number(new URL(url).port));
		}
	};

	const gpuBatch = await timedLane('gpu');
	assert.equal(gpuBatch.backend, 'gpu', 'engine:gpu session got the gpu backend');
	assert.equal(gpuBatch.records.length, BATCH_N, 'one chunk answers every seed');
	assert.ok(gpuBatch.records.every((r: any) => !r.error && !r.gpuFallback),
		`gpu batch lane ran all seeds: ${JSON.stringify(gpuBatch.records.map((r: any) => r.gpuFallback ?? r.error ?? 'ok'))}`);
	assert.ok(gpuBatch.records.some((r: any) => JSON.stringify(r).includes('"tail"')), 'compact records carry the tail grid (not degenerate)');

	const gpuPerSeed = await timedLane('gpu', { SIM_SERVER_GPU_BATCH: '0' });
	const wasmPerSeed = await timedLane('wasm');
	assertSameRecords(bySeed(gpuBatch.records), bySeed(wasmPerSeed.records), 'gpu batch vs wasm per-seed');
	assertSameRecords(bySeed(gpuPerSeed.records), bySeed(wasmPerSeed.records), 'gpu per-seed vs wasm per-seed');

	console.log(`[gpu-batch-perf] v77 line-1, ${BATCH_N} seeds in one chunk:`);
	for (const [name, lane] of [['gpu batch', gpuBatch], ['gpu per-seed', gpuPerSeed], ['wasm per-seed', wasmPerSeed]] as const) {
		console.log(`[gpu-batch-perf] ${name.padEnd(13)} runMs=${lane.runMs.toFixed(1).padStart(9)} ms/seed=${(lane.runMs / BATCH_N).toFixed(2).padStart(7)} wallMs=${String(lane.wallMs).padStart(8)}`);
	}
});

// ── (e) register_geometry feeds the gpu facade with the app's vendor copy ─────
test('register_geometry feeds the gpu facade: vendor copy injects cleanly, gpu records stay byte-identical', { skip: gpuSkip }, async () => {
	// The addon throws when the engine rejects the text, so this call proves
	// the vendor copy passes the kernel lane's own geometry verification.
	const addon = require(NATIVE_NODE);
	addon.register_geometry(Number(COURSE), fs.readFileSync(path.join(REPO, 'vendor', 'GlobalSim', 'data', 'course_geometry', `${COURSE}.json`), 'utf8'));
	const job = v77Job();
	const { proc, url } = await spawnMaster('wasm');
	try {
		// The gpu session registers the same vendor copy per course (the
		// workerCore flow) and answers the kernel lane fallback-free.
		const gpuRun = await runBatch(url, 'gpu', job);
		assert.equal(gpuRun.backend, 'gpu');
		assert.ok(gpuRun.records.every((r: any) => !r.error && !r.gpuFallback),
			`gpu lane ran all seeds on the injected copy: ${JSON.stringify(gpuRun.records.map((r: any) => r.gpuFallback ?? r.error ?? 'ok'))}`);
		const wasmRun = await runBatch(url, 'wasm', job);
		assertSameRecords(bySeed(gpuRun.records), bySeed(wasmRun.records), 'gpu (injected vendor geometry) vs wasm');
	} finally {
		stop(proc);
		await waitPortFree(Number(new URL(url).port));
	}
});

// ── (f) two concurrent gpu sessions share the device (stall regression gate) ──
const SESSION_BUDGET_MS = 120_000; // ~50x the measured 2.2 s concurrent pair, far under the stalled run
const GATE_SEEDS = 16;

test('two concurrent gpu sessions: overlapping windows, each pool done under budget, records byte-identical to wasm', { skip: gpuSkip }, async () => {
	const job: PoolJob = {
		id: 'gate.two-consumer',
		setupKey: 'v77-line1-gate',
		request: JSON.parse(fs.readFileSync(V77_LINE1, 'utf8').split(/\r?\n/)[0]),
		seeds: Array.from({ length: GATE_SEEDS }, (_, i) => BASE_SEED + i),
		mode: 'compact',
		distance: DISTANCE,
	};
	const { proc, url } = await spawnMaster('wasm');
	try {
		/** One threads:1 gpu pool over the job, recording the pool's live window. */
		const gpuPoolRun = async (label: string) => {
			const merged = new Map<number, string>();
			const pool = createGlobalsimPool({
				factory: () => new SimWorker(url, '', 'gpu'),
				threads: 1,
				skillData: mergedTable,
				onChunk: (_j: PoolJob, records: any[]) => { for (const r of records) merged.set(r.seed, JSON.stringify(r)); },
			});
			const start = Date.now();
			try {
				const res = await Promise.race([
					pool.runJobs([job]),
					new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} pool still open after ${SESSION_BUDGET_MS} ms (stalled?)`)), SESSION_BUDGET_MS).unref()),
				]);
				const window = { label, start, end: Date.now() };
				return { window, merged, errors: res.errors, fallbacks: res.gpuFallbacks };
			} finally {
				pool.dispose();
			}
		};
		const [a, b] = await Promise.all([gpuPoolRun('A'), gpuPoolRun('B')]);
		for (const run of [a, b]) {
			const ms = run.window.end - run.window.start;
			console.log(`[gpu-concurrent] session ${run.window.label}: ${ms} ms wall (budget ${SESSION_BUDGET_MS})`);
			assert.equal(run.errors.length, 0, `session ${run.window.label} pool errors: ${JSON.stringify(run.errors)}`);
			assert.equal(run.fallbacks.length, 0, `session ${run.window.label}: the gpu lane answered every seed`);
			assert.equal(run.merged.size, GATE_SEEDS, `session ${run.window.label}: one record per seed`);
			for (const json of run.merged.values()) {
				assert.ok(!json.includes('gpuFallback') && !json.includes('"error"'), `clean record: ${json.slice(0, 120)}`);
			}
		}
		// The windows must overlap: sequential pools would pass any per-session
		// budget while never actually sharing the device.
		const overlapMs = Math.min(a.window.end, b.window.end) - Math.max(a.window.start, b.window.start);
		assert.ok(overlapMs > 0, `session windows overlapped (got ${overlapMs} ms)`);

		// The wasm reference, alone and after the pair (byte identity, not timing).
		const refMerged = new Map<number, string>();
		const refPool = createGlobalsimPool({
			factory: () => new SimWorker(url, '', 'wasm'),
			threads: 1,
			skillData: mergedTable,
			onChunk: (_j: PoolJob, records: any[]) => { for (const r of records) refMerged.set(r.seed, JSON.stringify(r)); },
		});
		const refRes = await refPool.runJobs([job]).finally(() => refPool.dispose());
		assert.equal(refRes.errors.length, 0, `reference pool errors: ${JSON.stringify(refRes.errors)}`);
		assertSameRecords(refMerged, a.merged, 'gpu session A vs wasm');
		assertSameRecords(refMerged, b.merged, 'gpu session B vs wasm');
	} finally {
		stop(proc);
		await waitPortFree(Number(new URL(url).port));
	}
});

// ── (g) gpu group lane: the compare field's 18 setup keys in one launch ─────

/** The compare field's jobs at `samples`: the auto seed gate splits it into 9
 *  gates × 2 variants = 18 setup keys, each with its own request text. */
function compareFieldJobs(samples: number): any[] {
	const seeds = globalsimSeedList(BASE_SEED, samples);
	const built = buildCompareJobs({
		uma1: horse(), uma2: horse(),
		courseId: COURSE, distance: DISTANCE,
		ground: GroundCondition.Good, weather: Weather.Sunny, season: Season.Spring, time: Time.Midday,
		grade: Grade.G1,
		knownSkillIds, courseIds, mobPreset, skillData: mergedTable,
		seedBase: BASE_SEED, sampleCount: samples, threads: 1,
	} as any, seeds, 'compact');
	assert.equal(built.errors.length, 0, `compare field build errors: ${built.errors.join(' | ')}`);
	return built.jobs;
}

/** A one-thread pool over the server. Records are keyed by setupKey and seed:
 *  the compare variants run the SAME seed, so a bare seed key would collide. */
async function laneRecords(url: string, engine: 'gpu' | 'wasm', jobs: any[]): Promise<{ records: Map<string, string>; chunks: number; fallbacks: number }> {
	const records = new Map<string, string>();
	let fallbacks = 0;
	const pool = createGlobalsimPool({
		factory: () => new SimWorker(url, '', engine),
		threads: 1,
		skillData: mergedTable,
		onChunk: (job: PoolJob, recs: any[]) => {
			for (const r of recs) {
				records.set(`${job.setupKey}|${r.seed}`, JSON.stringify(r));
				if (typeof r.gpuFallback === 'string') fallbacks++;
			}
		},
	});
	const res = await pool.runJobs(jobs);
	const chunks = pool.timing().chunks;
	pool.dispose();
	assert.equal(res.errors.length, 0, `${engine} lane job errors: ${JSON.stringify(res.errors)}`);
	return { records, chunks, fallbacks };
}

test('gpu group lane: 18 compare setup keys in one launch, records byte-identical to all-wasm', { skip: gpuSkip }, async () => {
	const jobs = compareFieldJobs(90);
	const total = jobs.reduce((n: number, job: any) => n + job.seeds.length, 0);
	assert.equal(new Set(jobs.map((job: any) => job.setupKey)).size, 18, 'auto gate gives 18 setup keys (9 gates × 2 variants)');
	assert.equal(total, 180, '90 samples × 2 variants = 180 races');
	const { proc, url } = await spawnMaster('wasm,gpu');
	try {
		const gpu = await laneRecords(url, 'gpu', jobs);
		assert.equal(gpu.records.size, total, 'one gpu record per (setupKey, seed)');
		assert.equal(gpu.fallbacks, 0, 'the compare field needs no fallback on the kernel');
		assert.equal(gpu.chunks, 1, `the whole 18-key batch answered in ONE run message (got ${gpu.chunks})`);
		assert.ok([...gpu.records.values()].some((json: string) => json.includes('"tail"')), 'compact records carry the tail grid');
		const cpu = await laneRecords(url, 'wasm', jobs);
		assert.deepEqual([...gpu.records.keys()].sort(), [...cpu.records.keys()].sort(), 'same (setupKey, seed) set on gpu and wasm');
		for (const [key, json] of gpu.records) assert.equal(cpu.records.get(key), json, `record JSON differs for ${key}`);
		console.log(`[gpu-group] 180 races, 18 setup keys: gpu run messages=${gpu.chunks} (one launch per 18 keys instead of 18)`);
	} finally {
		stop(proc);
		await waitPortFree(Number(new URL(url).port));
	}
});
