/**
 * Local sim server acceptance test (CPU offload):
 *
 *  (a) /ping shape; token server rejects sessions without the token,
 *  (b) PARITY: runGlobalsimCompare through the HTTP SimWorker factory is
 *      bit-identical to the same run through the in-process bridge factory —
 *      the whole point of the server reusing workerCore,
 *  (c) a dead server-side child surfaces to the pool as a worker 'error'
 *      (via the __died control message) — proven against a fake transport.
 *
 * The master is spawned as a real child process on an ephemeral port
 * (port=0 → the listening line reports it) and killed by PID at the end.
 *
 * Run: npm run test:globalsim-simserver
 */

// Same CC_GLOBAL-before-import trick as compare.acceptance.test.ts.
(globalThis as any).CC_GLOBAL = true;

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import http from 'http';
import test from 'node:test';
import assert from 'node:assert/strict';

import { HorseState, SkillSet } from '../../../../components/HorseDefTypes';
import { GroundCondition, Weather, Season, Time, Grade } from '../../../../uma-skill-tools/RaceParameters';
import { runGlobalsimCompare } from './compare';
import type { WorkerFactory } from './pool';
import { createGlobalsimWorkerCore, WasmApi } from './workerCore';
import { SimWorker, pingSimServer } from './simLink';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SERVER = path.join(__dirname, 'sim-server.ts');
const TS_NODE = path.join(REPO, 'node_modules', 'ts-node', 'dist', 'bin.js');
const mergedTable = require(path.join(REPO, 'globalsim/skills.json'));
const knownSkillIds = new Set<string>(Object.keys(mergedTable));
const mobPresets = require('./mob-presets.json');
const courseIds: string[] = Object.keys(require(path.join(REPO, 'vendor/GlobalSim/data/course_data.json')));

// ── in-process bridge (the parity reference) ─────────────────────────────────

const pkgDir = path.join(REPO, 'globalsim-wasm', 'pkg');
const geomDir = path.join(REPO, 'vendor', 'GlobalSim', 'data', 'course_geometry');
let instances = 0;
async function loadPkgFresh(): Promise<WasmApi> {
	const dynImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>;
	const mod = await dynImport(pathToFileURL(path.join(pkgDir, 'globalsim_wasm.js')).href + `?w=${instances++}`);
	const init = mod.default ?? mod.init;
	await init(fs.readFileSync(path.join(pkgDir, 'globalsim_wasm_bg.wasm')));
	return { register_geometry: (id: number, t: string) => mod.register_geometry(id, t), PreparedRace: mod.PreparedRace };
}
function bridgeFactory(): WorkerFactory {
	return (): any => {
		const cbs: ((e: { data: any }) => void)[] = [];
		let dead = false;
		const core = createGlobalsimWorkerCore({
			postMessage: (m) => queueMicrotask(() => { if (!dead) for (const cb of cbs) cb({ data: m }); }),
			loadWasm: loadPkgFresh,
			fetchText: (url) => fs.promises.readFile(path.join(geomDir, path.basename(url)), 'utf8'),
		});
		return {
			postMessage: (m: any) => queueMicrotask(() => { if (!dead) core.onMessage(m); }),
			addEventListener: (t: string, cb: any) => { if (t === 'message') cbs.push(cb); },
			terminate: () => { dead = true; },
		};
	};
}

// ── real master ──────────────────────────────────────────────────────────────

function spawnMaster(extraArgs: string[]): Promise<{ proc: ChildProcess; url: string }> {
	return new Promise((resolve, reject) => {
		const proc = spawn(process.execPath, [
			TS_NODE, '--transpile-only',
			'--compiler-options', JSON.stringify({ moduleResolution: 'node', module: 'commonjs' }),
			SERVER, '--port=0', ...extraArgs,
		], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
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

function horse(skills: string[]) {
	return new HorseState({
		speed: 1100, stamina: 1000, power: 1050, guts: 900, wisdom: 1000,
		strategy: 'Senkou', distanceAptitude: 'A', surfaceAptitude: 'A', strategyAptitude: 'A', mood: 0,
	}).set('skills', SkillSet(skills));
}
const baseInput = (factory: WorkerFactory) => ({
	uma1: horse(['100011', '200011']),
	uma2: horse(['100011', '200011', '200791']),
	courseId: '10504', distance: 2000,
	ground: GroundCondition.Good, weather: Weather.Sunny, season: Season.Spring, time: Time.Midday,
	grade: Grade.G1,
	knownSkillIds, skillData: mergedTable, courseIds,
	mobPreset: mobPresets['default'], fieldLayout: 'mob' as const,
	seedBase: 777, sampleCount: 12, threads: 2, workerFactory: factory,
});

test('ping reports cores and no token by default', async () => {
	const { proc, url } = await spawnMaster([]);
	try {
		const r = await pingSimServer(url);
		assert.equal(r.ok, true);
		assert.ok((r.cores ?? 0) >= 2);
		assert.equal(r.tokenRequired, false);
	} finally { stop(proc); }
});

test('token server: ping public, session 401 without the token', async () => {
	const { proc, url } = await spawnMaster(['--token=s3cret']);
	try {
		const r = await pingSimServer(url);
		assert.equal(r.ok, true);
		assert.equal(r.tokenRequired, true);
		const open = await fetch(`${url}/session`, { method: 'POST', body: '{}' });
		assert.equal(open.status, 401);
		const open2 = await fetch(`${url}/session`, { method: 'POST', headers: { 'x-sim-token': 's3cret' }, body: '{}' });
		assert.equal(open2.status, 200);
	} finally { stop(proc); }
});

test('compare through the sim server is bit-identical to the in-process bridge', async () => {
	const { proc, url } = await spawnMaster([]);
	try {
		const viaServer = await runGlobalsimCompare(baseInput(() => new SimWorker(url)));
		const viaBridge = await runGlobalsimCompare(baseInput(bridgeFactory()));
		const a = viaServer.globalsim, b = viaBridge.globalsim;
		assert.equal(a.jobErrors.length, 0, `server job errors: ${JSON.stringify(a.jobErrors)}`);
		assert.equal(a.seedErrors, 0);
		assert.equal(a.doneSeeds, b.doneSeeds);
		assert.ok(a.doneSeeds >= 12, 'paired seeds completed');
		// results is arrival-order by design (progressive rendering) — the
		// multiset must be bit-identical.
		const sortCopy = (xs: number[]) => [...xs].sort((x, y) => x - y);
		assert.deepEqual(sortCopy(viaServer.results), sortCopy(viaBridge.results));
		assert.deepEqual(a.methodCounts, b.methodCounts);
	} finally { stop(proc); }
});

// ── minimal fake master: one mux feed, echo prepared, __died after the run ──
test('dead server-side child surfaces as a worker error (fake transport)', async () => {
	const msgs: any[] = [];
	const server = http.createServer(async (req, res) => {
		const p = (req.url ?? '').split('?')[0].replace(/\/+$/, '');
		if (p === '/session' && req.method === 'POST') { res.end(JSON.stringify({ sessionId: '1' })); return; }
		if (p === '/session/1/msg') {
			const body = await new Promise<string>((r) => { let s = ''; req.on('data', (c) => s += c); req.on('end', () => r(s)); });
			const m = JSON.parse(body);
			if (m.type === 'prepare') msgs.push({ s: '1', m: { type: 'prepared', id: m.id, setupKey: m.setupKey, ok: true } });
			if (m.type === 'run') msgs.push({ s: '1', m: { type: '__died' } });   // the child died mid-run
			res.statusCode = 202; res.end('{}'); return;
		}
		if (p === '/multiplex') {
			const next = msgs.splice(0, msgs.length);
			res.end(JSON.stringify({ msgs: next })); return;
		}
		res.statusCode = 404; res.end('{}');
	});
	await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
	const url = `http://127.0.0.1:${(server.address() as any).port}`;
	try {
		const w = new SimWorker(url);
		const errors: unknown[] = [];
		w.addEventListener('error', (e) => errors.push(e));
		w.postMessage({ type: 'skillData', skillData: {} });
		w.postMessage({ type: 'prepare', id: 'j1', setupKey: 's1', request: {} });
		await new Promise(r => setTimeout(r, 200));
		w.postMessage({ type: 'run', jobId: 'j1', seeds: [1], mode: 'compact' });
		await new Promise(r => setTimeout(r, 400));
		assert.equal(errors.length, 1, `expected exactly one error event, got ${errors.length}`);
		w.terminate();
	} finally { server.close(); }
});
