/**
 * Mixed-backend acceptance test (SIM_SERVER_BACKENDS):
 *
 * With SIM_SERVER_BACKENDS=wasm,native the server rotates backends across
 * sessions that carry no explicit engine, an explicit {"engine":...} body
 * picks one without consuming a rotation slot, and both children log their
 * backend once. On top of that the two backends must agree exactly: the same
 * results-only batch (course 10504, 24 seeds, run_compact) driven through the
 * real HTTP API produces byte-identical per-seed record JSON on wasm and on
 * native. The napi addon is the wasm pkg in native clothing.
 *
 * The master is spawned as a real child process on an ephemeral port and
 * killed by PID at the end. It owns its children, which exit on disconnect.
 *
 * Run: npm run test:globalsim-backend  (from the repo root)
 */

// Same CC_GLOBAL-before-import trick as compare.acceptance.test.ts.
(globalThis as any).CC_GLOBAL = true;

import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { HorseState, SkillSet } from '../../../../components/HorseDefTypes';
import { GroundCondition, Weather, Season, Time, Grade } from '../../../../uma-skill-tools/RaceParameters';
import { buildCompareJobs } from './compare';
import { parseMobPresets } from './mobs';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SERVER = path.join(__dirname, 'sim-server.ts');
const TS_NODE = path.join(REPO, 'node_modules', 'ts-node', 'dist', 'bin.js');
const mergedTable = require(path.join(REPO, 'globalsim/skills.json'));
const knownSkillIds = new Set<string>(Object.keys(mergedTable));
const mobPreset = parseMobPresets(require('./mob-presets.json')).presets['default'];
const courseIds: string[] = Object.keys(require(path.join(REPO, 'vendor/GlobalSim/data/course_data.json')));

const COURSE = '10504';
const DISTANCE = 2000;
const BASE_SEED = 20261115;
const N = 24;
const GATE = 3; // fixed single gate group → one chunk job (chunk 25) holds all seeds

function spawnMaster(): Promise<{ proc: ChildProcess; url: string; out: () => string }> {
	return new Promise((resolve, reject) => {
		const proc = spawn(process.execPath, [
			TS_NODE, '--transpile-only',
			'--compiler-options', JSON.stringify({ moduleResolution: 'node', module: 'commonjs' }),
			SERVER, '--port=0',
		], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SIM_SERVER_BACKENDS: 'wasm,native' } });
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

// ── HTTP API driver (the real routes, no client library) ─────────────────────

async function postMsg(url: string, id: string, m: unknown): Promise<void> {
	const r = await fetch(`${url}/session/${id}/msg`, { method: 'POST', body: JSON.stringify(m) });
	assert.equal(r.status, 202, `POST /session/${id}/msg → ${r.status}`);
}

/** Long-poll one session's queue (ack=1 commits the previous window) until a
 *  message passes accept. Returns the whole delivered window. */
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

/** Open a session, run the job's seeds compact, resolve with its records. */
async function runBatch(url: string, engine: 'wasm' | 'native' | undefined, job: any): Promise<{ backend: string; records: any[] }> {
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
		const runMsgs = await pollOut(url, s.sessionId, (m) => m.type === 'chunk' && m.jobId === 'j1', 300_000, 'chunk');
		const chunk = runMsgs.find((m: any) => m.type === 'chunk' && m.jobId === 'j1');
		assert.ok(chunk.ok, `chunk failed: ${chunk.error}`);
		return { backend: s.backend, records: chunk.records };
	} finally {
		await fetch(`${url}/session/${s.sessionId}`, { method: 'DELETE' }).catch(() => { /* gone */ });
	}
}

// ── the batch: one mob-layout compact job, like compact-parity.test.ts ───────

function horse(): HorseState {
	return new HorseState({
		speed: 1000, stamina: 1000, power: 900, guts: 800, wisdom: 900,
		strategy: 'Senkou', distanceAptitude: 'A', surfaceAptitude: 'A', strategyAptitude: 'A', mood: 2,
	}).set('skills', SkillSet(['100011', '100031', '200011', '100051']));
}

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

test('rotated backends report, rotate and repeat: 24-seed compact batch is byte-identical wasm vs native', async () => {
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
	const job = built.jobs[0];
	assert.equal(job.seeds.length, N, 'one chunk job holds all seeds');

	const { proc, url, out } = await spawnMaster();
	try {
		// Rotation: the first two engine-less sessions get wasm then native.
		const wasmRun = await runBatch(url, undefined, job);
		assert.equal(wasmRun.backend, 'wasm', 'rotation slot 0 = wasm');
		const nativeRun = await runBatch(url, undefined, job);
		assert.equal(nativeRun.backend, 'native', 'rotation slot 1 = native');

		// An explicit engine picks its backend without consuming a slot.
		const openExplicit = await fetch(`${url}/session`, { method: 'POST', body: JSON.stringify({ engine: 'native' }) });
		assert.equal(openExplicit.status, 200);
		const explicit = await openExplicit.json() as any;
		assert.equal(explicit.backend, 'native', 'explicit engine: native');
		const openNext = await fetch(`${url}/session`, { method: 'POST', body: '{}' });
		const next = await openNext.json() as any;
		assert.equal(next.backend, 'wasm', 'the explicit request did not consume a rotation slot');
		await fetch(`${url}/session/${explicit.sessionId}`, { method: 'DELETE' });
		await fetch(`${url}/session/${next.sessionId}`, { method: 'DELETE' });

		// Both children printed their backend exactly once loadWasm ran.
		const log = out();
		assert.ok(log.includes('[sim-server] engine backend: wasm'), 'wasm child reported its backend');
		assert.ok(log.includes('[sim-server] engine backend: native'), 'native child reported its backend');

		// Per-seed compact records byte-identical, seed by seed.
		assert.equal(wasmRun.records.length, N, 'wasm: one record per seed');
		assert.equal(nativeRun.records.length, N, 'native: one record per seed');
		assert.ok(wasmRun.records.every((r: any) => !r.error), `no per-seed errors on wasm: ${JSON.stringify(wasmRun.records.map((r: any) => r.error ?? 'ok'))}`);
		const bySeed = (records: any[]): Map<number, string> => new Map(records.map((r: any) => [r.seed, JSON.stringify(r)]));
		const a = bySeed(wasmRun.records);
		const b = bySeed(nativeRun.records);
		assert.deepEqual([...a.keys()].sort((x, y) => x - y), [...b.keys()].sort((x, y) => x - y), 'both backends answered the same seed set');
		for (const seed of a.keys()) {
			assert.equal(b.get(seed), a.get(seed), `record JSON differs for seed ${seed}`);
		}
		assert.ok([...a.values()].some((j) => j.includes('"tail"')), 'compact records carry the tail grid (not degenerate)');
	} finally {
		stop(proc);
		await waitPortFree(Number(new URL(url).port));
	}
});
