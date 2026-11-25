/**
 * Local sim server (opt-in CPU offload) — see KB decisions/globalsim-compare-semantics.md.
 *
 * Why: a browser tab cannot host 8+ wasm workers (renderer "Out of Memory" at
 * ~1.6 GB on the skill-bearing baseline field). This server runs the REAL
 * globalsim workerCore outside the browser, so the tab only ships JSON.
 *
 * ## Architecture
 *
 *   master (this file)  plain node http server, zero deps:
 *     GET    /ping                 → {ok, cores, tokenRequired}
 *     POST   /session              → {sessionId,backend}  (forks ONE child;
 *                                    optional body {"engine":"wasm"|"native"|
 *                                    "gpu"}; SIM_SERVER_BACKENDS=wasm,native
 *                                    rotates the backend when the body has no
 *                                    engine; gpu is filtered out of rotation
 *                                    when the device or gpu-built addon is
 *                                    missing, and a batch-capable gpu lane
 *                                    takes one session, first, while the CPU
 *                                    backends rotate around it)
 *     POST   /session/:id/msg      → 202                   (forward to child)
 *     GET    /multiplex?ids=a,b    → {msgs:[{s,m}]} long-poll ALL sessions on
 *                                    ONE connection (browser per-host socket
 *                                    cap is 6 — one held GET per session would
 *                                    pin the client at ~6 workers).
 *                                    &ack=1 acknowledges the previous
 *                                    response (see dequeue-on-ack below)
 *     GET    /session/:id/out      → {msgs:[...]} long-poll (single session,
 *                                    tests/compat; same &ack=1 protocol)
 *     DELETE /session/:id          → 202                   (kill child)
 *   child (--child flag) the real createGlobalsimWorkerCore over process IPC —
 *     identical message protocol to globalsim.worker.ts, so the browser-side
 *     SimWorker is a drop-in WorkerLike adapter and results are bit-identical.
 *
 * One child PER session is not optional: node runs races synchronously, so a
 * single process would serialize every "worker" onto one core.
 *
 * Dequeue-on-acknowledge: long-poll responses PEAK the session queue — a
 * message is removed from it only when the client's NEXT poll carries
 * ack=1, meaning the previous response was fully received and dispatched.
 * A response lost to a dropped connection or an aborted fetch is therefore
 * redelivered on the next poll instead of vanishing (the client dispatches
 * a response window wholly or not at all, so window-level acks are exact).
 *
 * ## Security
 *
 * Binds 127.0.0.1 only (use --lan to bind 0.0.0.0 — combine with --token=XYZ,
 * required on the X-Sim-Token header). No auth on localhost by default: this
 * machine is your trust boundary. CORS: * (localhost sim API, no cookies).
 *
 * ## Run
 *
 *   double-click sim-server.bat          (recommended, checks node/deps)
 *   npx ts-node --transpile-only --compiler-options
 *     "{\"moduleResolution\":\"node\",\"module\":\"commonjs\"}"
 *     umalator-global/v2/engines/globalsim/sim-server.ts [--port=8765] [--lan] [--token=XYZ]
 */

import * as http from 'http';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { fork, ChildProcess, execFile } from 'child_process';
import { pathToFileURL } from 'url';
import { createGlobalsimWorkerCore } from './workerCore';

const argv = process.argv.slice(2);
const flag = (name: string, dflt?: string): string | undefined => {
	const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
	if (!hit) return dflt;
	const eq = hit.indexOf('=');
	return eq < 0 ? '' : hit.slice(eq + 1);
};

const HERE = __dirname;
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const GEOM_DIR = path.join(REPO_ROOT, 'vendor', 'GlobalSim', 'data', 'course_geometry');
const WASM_PKG = path.join(REPO_ROOT, 'globalsim-wasm', 'pkg');
const NATIVE_NODE = path.join(REPO_ROOT, 'globalsim-native', 'globalsim_native.node');
/** The built web app to serve from this origin, when the launcher ships one. */
const staticDir = process.env.SIM_SERVER_STATIC ? path.resolve(process.env.SIM_SERVER_STATIC) : null;
const STATIC_TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
	'.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
	'.wasm': 'application/wasm', '.map': 'application/json', '.woff2': 'font/woff2',
};

// ── child role ───────────────────────────────────────────────────────────────

function childMain(): void {
	(globalThis as any).CC_GLOBAL = true;
	const core = createGlobalsimWorkerCore({
		postMessage: (m: unknown) => {
			try { process.send!({ m }); } catch { /* parent gone — exit via disconnect */ }
		},
		loadWasm: async () => {
			// The napi addon exports the same {register_geometry, PreparedRace}
			// shape as the wasm pkg, so only this loader knows about backends.
			if (process.env.NATIVE_ENGINE === 'gpu') {
				console.log('[sim-server] engine backend: gpu');
				const mod = require(NATIVE_NODE);
				if (typeof mod.gpuAvailable !== 'function' || typeof mod.gpuRunCompact !== 'function') {
					throw new Error('gpu session needs the gpu-built addon: npm run build:globalsim-native-gpu');
				}
				const avail = mod.gpuAvailable();
				if (!avail.ok) throw new Error(`gpu unavailable: ${(avail.reasons ?? []).join(', ')}`);
				// The table the session installed once, kept for the lazy CPU
				// handle: the gpu calls read it from the engine, full replies and
				// out-of-range seeds need it back in the text.
				let skillTable: unknown = null;
				const withTable = (json: string): string => {
					if (skillTable == null) return json;
					const obj = JSON.parse(json);
					if (obj && typeof obj === 'object' && (obj as any).skillData == null) (obj as any).skillData = skillTable;
					return JSON.stringify(obj);
				};
				const CpuRace = mod.PreparedRace;
				// run_compact goes to the GPU facade; full replies and out-of-i32-range
				// seeds keep a lazy native handle (the facade answers the compact contract only).
				const PreparedRace = class {
					cpu: any;
					constructor(public requestJson: string) { this.cpu = null; }
					run(seed: number) { if (!this.cpu) this.cpu = new CpuRace(withTable(this.requestJson)); return this.cpu.run(seed); }
					run_compact(seed: number, trackSkillId: string, secondPlayerIndex: number, distance: number) {
						return mod.gpuRunCompact(this.requestJson, seed, trackSkillId, secondPlayerIndex, distance);
					}
					free() { if (this.cpu) this.cpu.free(); }
				};
				// Whole seed chunks go to one gpuRunCompactBatch call (the batch seam the pool
				// drives). SIM_SERVER_GPU_BATCH=0 keeps the per-seed lane, for timing comparison.
				if (typeof mod.gpuRunCompactBatch === 'function' && process.env.SIM_SERVER_GPU_BATCH !== '0') {
					(PreparedRace.prototype as any).run_compact_batch = function (this: any, seeds: number[], trackSkillId: string, secondPlayerIndex: number, distance: number): string {
						return mod.gpuRunCompactBatch(this.requestJson, seeds, trackSkillId, secondPlayerIndex, distance);
					};
				}
				// Several setup keys in ONE gpuRunCompactGroups call (the pool's cross-key
				// lane). The entry's presence is also what the worker reports as its
				// multi-request capability, so the env switch turns the packing off too.
				if (typeof mod.gpuRunCompactGroups === 'function' && process.env.SIM_SERVER_GPU_BATCH !== '0') {
					(PreparedRace.prototype as any).run_compact_groups = function (this: any, payload: string): string {
						return mod.gpuRunCompactGroups(payload);
					};
				}
				return {
					register_geometry: (id: number, t: string) => mod.register_geometry(id, t),
					PreparedRace,
					setSkillTable: (t: string) => {
						skillTable = JSON.parse(t);
						mod.gpuSetSkillTable(t);
					},
				};
			}
			if (process.env.NATIVE_ENGINE === '1') {
				console.log('[sim-server] engine backend: native');
				const mod = require(NATIVE_NODE);
				return {
					register_geometry: (id: number, t: string) => mod.register_geometry(id, t),
					PreparedRace: mod.PreparedRace,
					// The session table: requests that omit skillData parse the
					// table once here instead of carrying it every prepare.
					setSkillTable: (t: string) => mod.setSkillTable(t),
				};
			}
			console.log('[sim-server] engine backend: wasm');
			// ESM wasm-bindgen pkg under ts-node/commonjs: import via URL (same
			// trick as the acceptance suites).
			const dynImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>;
			const mod = await dynImport(pathToFileURL(path.join(WASM_PKG, 'globalsim_wasm.js')).href);
			const init = mod.default ?? mod.init;
			await init(fs.readFileSync(path.join(WASM_PKG, 'globalsim_wasm_bg.wasm')));
			return {
				register_geometry: (id: number, t: string) => mod.register_geometry(id, t),
				PreparedRace: mod.PreparedRace,
				setSkillTable: (t: string) => mod.set_skill_table(t),
			};
		},
		fetchText: (url: string) => fs.promises.readFile(path.join(GEOM_DIR, path.basename(url)), 'utf8'),
	});
	process.on('message', (env: any) => { core.onMessage(env && env.m ? env.m : env); });
	// Master killed us or vanished: drop the PreparedRace and go.
	process.on('disconnect', () => process.exit(0));
}

// ── master role ──────────────────────────────────────────────────────────────

interface Waiter {
	resolve: (msgs: any[]) => void;
	timer: NodeJS.Timeout;
}
export type Backend = 'wasm' | 'native' | 'gpu';
interface Session {
	id: string;
	child: ChildProcess;
	backend: Backend;
	// Dequeue-on-ack queue: `out` holds every message the client has not
	// acknowledged; `sent` counts the leading ones already handed to the last
	// long-poll response, awaiting that response's ack=1. Responses peek the
	// whole queue, so a lost response window is redelivered, not lost.
	out: any[];
	sent: number;
	waiter: Waiter | null;
	lastSeen: number;
	dead: boolean;
	/** Run messages this session has received (one facade launch per message
	 *  on the gpu backend). Logged so a chart run's lane use is visible. */
	gpuLaunches?: number;
}

// The gpu verdict: exactness gate, one guard race against the CPU engine, the
// device's floor and slope, and whether the batch entry exists. One throwaway
// child per server run, asynchronous so /ping never waits on it.
interface GpuProbe {
	ok: boolean;
	batch: boolean;
	reasons: string[];
	device: string | null;
	floorMs: number | null;
	slopeMsPerRace: number | null;
	parityOk: boolean | null;
	/** True until the child answers. */
	pending?: boolean;
}
const GPU_PROBE_PENDING: GpuProbe = {
	ok: false, batch: false, reasons: ['gpu check still running'], device: null,
	floorMs: null, slopeMsPerRace: null, parityOk: null, pending: true,
};
let gpuProbe: GpuProbe | null = null;
let gpuProbeDone: Promise<GpuProbe> | null = null;

/** One line for the log and the settings panel: the verdict and the measured cost. */
export function gpuStatusLine(p: GpuProbe): string {
	if (!p.ok) return `gpu: off (${p.reasons.join(', ')})`;
	const parts = [p.device ?? 'unknown device'];
	if (p.floorMs !== null) parts.push(`floor ${Math.round(p.floorMs)} ms`);
	if (p.slopeMsPerRace !== null) parts.push(`${p.slopeMsPerRace.toFixed(2)} ms/race`);
	return `gpu: on (${parts.join(', ')})`;
}

function startGpuProbe(): Promise<GpuProbe> {
	if (gpuProbeDone) return gpuProbeDone;
	const script = 'const m = require(' + JSON.stringify(NATIVE_NODE) + ');'
		+ 'const done = (r) => process.stdout.write("GPU_PROBE" + JSON.stringify(r));'
		+ 'const batch = typeof m.gpuRunCompactGroups === "function" && process.env.SIM_SERVER_GPU_BATCH !== "0";'
		+ 'const r = typeof m.gpuProbe === "function" ? (() => { try { return m.gpuProbe(); } catch (e) { return { ok: false, reasons: [String((e && e.message) || e)] }; } })()'
		+ ' : typeof m.gpuAvailable !== "function"'
		+ ' ? { ok: false, reasons: ["addon lacks gpu support (build with --features gpu)"] }'
		+ ' : (() => { try { return m.gpuAvailable(); } catch (e) { return { ok: false, reasons: [String((e && e.message) || e)] }; } })();'
		+ 'done({ ok: r.ok === true, reasons: Array.isArray(r.reasons) ? r.reasons : [], batch,'
		+ ' device: typeof r.device === "string" ? r.device : null,'
		+ ' floorMs: typeof r.floorMs === "number" ? r.floorMs : null,'
		+ ' slopeMsPerRace: typeof r.slopeMsPerRace === "number" ? r.slopeMsPerRace : null,'
		+ ' parityOk: typeof r.parityOk === "boolean" ? r.parityOk : null });';
	gpuProbeDone = new Promise<GpuProbe>((resolve) => {
		const settle = (verdict: GpuProbe): void => {
			gpuProbe = verdict;
			console.log(`[sim-server] ${gpuStatusLine(verdict)}`);
			if (!verdict.ok) console.warn(`[sim-server] gpu lane unavailable (${verdict.reasons.join(', ')}): CPU lanes only`);
			resolve(verdict);
		};
		execFile(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 300_000, maxBuffer: 8 << 20 }, (err, stdout) => {
			const hit = stdout ? /GPU_PROBE(\{.*\})/.exec(stdout) : null;
			let j: any = null;
			try { j = hit ? JSON.parse(hit[1]) : null; } catch { j = null; }
			if (j) {
				settle({
					ok: j.ok === true, batch: j.batch === true,
					reasons: Array.isArray(j.reasons) ? j.reasons : [],
					device: typeof j.device === 'string' ? j.device : null,
					floorMs: typeof j.floorMs === 'number' ? j.floorMs : null,
					slopeMsPerRace: typeof j.slopeMsPerRace === 'number' ? j.slopeMsPerRace : null,
					parityOk: typeof j.parityOk === 'boolean' ? j.parityOk : null,
				});
				return;
			}
			const stderr = (err as any)?.stderr;
			settle({
				ok: false, batch: false, device: null, floorMs: null, slopeMsPerRace: null, parityOk: null,
				reasons: [String(stderr || (err as any)?.message || 'gpu probe child printed no verdict').split('\n')[0]],
			});
		});
	});
	return gpuProbeDone;
}

/** The cached verdict, or the pending marker before the child answers. */
function probeGpu(): GpuProbe {
	return gpuProbe ?? GPU_PROBE_PENDING;
}

/**
 * Backend one engine-less session gets, and the rotation counter after it.
 * Pure so the rule is testable without a server.
 *
 * The gpu backend never joins the rotation: it is the pool's extra lane now,
 * opened through a pinned {"engine":"gpu"} session the pool counts on top of
 * its CPU threads. A rotated gpu session would take a thread slot.
 */
export function pickRotationBackend(
	backends: readonly Backend[],
	turn: number,
): { backend: Backend; turn: number } {
	const cpus = backends.filter(b => b !== 'gpu');
	if (cpus.length === 0) return { backend: 'wasm', turn };
	return { backend: cpus[turn % cpus.length], turn: turn + 1 };
}

function masterMain(): void {
	// Number(x) || fallback would turn the ephemeral `--port=0` into 8765.
	const portArg = Number(flag('port', '8765'));
	const port = Math.max(0, Math.min(65535, Number.isFinite(portArg) ? portArg : 8765));
	const token = flag('token');
	const lan = argv.includes('--lan');
	const host = lan ? '0.0.0.0' : '127.0.0.1';
	const sessions = new Map<string, Session>();
	let nextId = 1;
	// SIM_SERVER_BACKENDS=wasm,native rotates the backend for sessions with no
	// explicit engine. Unset keeps every child on wasm.
	let backends: Backend[] = (process.env.SIM_SERVER_BACKENDS ?? '')
		.split(',').map(b => b.trim()).filter((b): b is Backend => b === 'wasm' || b === 'native' || b === 'gpu');
	let backendTurn = 0;
	// The race program's disk cache binds source bytes, device and driver, so an
	// image from another build is a miss and never a wrong load. It defaults under
	// LOCALAPPDATA, overridden by GSIM_GPU_PROGRAM_CACHE.
	if (!process.env.GSIM_GPU_PROGRAM_CACHE) {
		const base = process.env.LOCALAPPDATA || process.env.TEMP || '.';
		const dir = path.join(base, 'GlobalSim', 'program-cache');
		try { fs.mkdirSync(dir, { recursive: true }); } catch { /* the engine reports its own failure */ }
		process.env.GSIM_GPU_PROGRAM_CACHE = dir;
	}
	console.log(`[sim-server] program cache: ${process.env.GSIM_GPU_PROGRAM_CACHE}`);
	if (staticDir) console.log(`[sim-server] web app: ${staticDir}`);
	// Always check at start: the app reads the verdict from /ping to decide whether
	// to open the extra lane, and backends without gpu can still pin one session.
	void startGpuProbe();

	function cors(res: http.ServerResponse): void {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'content-type, x-sim-token');
		res.setHeader('Access-Control-Max-Age', '86400');
		res.setHeader('Cache-Control', 'no-store');
	}
	function json(res: http.ServerResponse, code: number, body: unknown): void {
		if (res.writableEnded) return;
		cors(res);
		res.writeHead(code, { 'content-type': 'application/json' });
		res.end(JSON.stringify(body));
	}
	function readBody(req: http.IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			let size = 0;
			const chunks: Buffer[] = [];
			req.on('data', (c: Buffer) => {
				size += c.length;
				if (size > 32 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
				chunks.push(c);
			});
			req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
			req.on('error', reject);
		});
	}

	function flush(s: Session): void {
		// Wake only for messages NEWER than the window already awaiting ack.
		if (s.waiter && s.out.length > s.sent) {
			const w = s.waiter;
			s.waiter = null;
			clearTimeout(w.timer);
			s.sent = s.out.length;   // in flight until the next ack=1
			w.resolve([...s.out]);   // peek, not splice — see Session.out
		}
		flushAllMux();
	}

	// ── multiplex waiters: ONE long-poll feeds every watched session ─────────
	interface MuxWaiter {
		ids: Set<string>;
		acked: boolean;   // this request carried ack=1 (commit on collect)
		resolve: (msgs: Array<{ s: string; m: unknown }>) => void;
		timer: NodeJS.Timeout;
	}
	const muxWaiters: MuxWaiter[] = [];
	function collectMux(ids: Set<string>, commit: boolean): Array<{ s: string; m: unknown }> | null {
		let any = false;
		const got: Array<{ s: string; m: unknown }> = [];
		for (const id of ids) {
			const s = sessions.get(id);
			if (!s) { got.push({ s: id, m: { type: '__died' } }); any = true; continue; }
			// ack=1: the client fully processed the previous response — its
			// in-flight window leaves the queue here (and only here).
			if (commit && s.sent > 0) { s.out.splice(0, s.sent); s.sent = 0; }
			if (s.out.length > 0) {
				any = true;
				s.sent = s.out.length;   // snapshot awaiting the next ack
				for (const m of s.out) got.push({ s: id, m });   // peek, incl. any unacked head
			}
		}
		return any ? got : null;
	}
	function flushAllMux(): void {
		for (let i = muxWaiters.length - 1; i >= 0; i--) {
			const w = muxWaiters[i];
			const got = collectMux(w.ids, w.acked);
			if (got) {
				muxWaiters.splice(i, 1);
				clearTimeout(w.timer);
				w.resolve(got);
			}
		}
	}

	function createSession(requested?: Backend): Session | null {
		const id = String(nextId++);
		let backend: Backend;
		if (requested != null) backend = requested;
		else {
			const picked = pickRotationBackend(backends, backendTurn);
			backend = picked.backend;
			backendTurn = picked.turn;
		}
		let child: ChildProcess;
		try {
			// A packaged bundle runs from server.cjs, which no loader needs, and
			// its folder has no node_modules for ts-node to resolve from.
			const tsLoader = __filename.endsWith('.ts')
				? (() => { try { return require.resolve('ts-node/register/transpile-only'); } catch { return null; } })()
				: null;
			child = fork(__filename, ['--child'], {
				cwd: HERE,
				env: {
					...process.env,
					NATIVE_ENGINE: backend === 'native' ? '1' : backend === 'gpu' ? 'gpu' : '0',
					TS_NODE_TRANSPILE_ONLY: '1',
					TS_NODE_COMPILER_OPTIONS: process.env.TS_NODE_COMPILER_OPTIONS ?? JSON.stringify({ moduleResolution: 'node', module: 'commonjs' }),
				},
				// fork's execArgv replaces node flags entirely: just the ts loader.
				execArgv: tsLoader ? ['-r', tsLoader] : [],
				stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
			});
		} catch (e: any) {
			console.error('fork failed:', e?.message || e);
			return null;
		}
		const s: Session = { id, child, backend, out: [], sent: 0, waiter: null, lastSeen: Date.now(), dead: false };
		child.on('message', (env: any) => { s.out.push(env && env.m ? env.m : env); flush(s); });
		child.on('exit', () => {
			if (!s.dead) {
				s.dead = true;
				s.out.push({ type: '__died' });   // browser adapter → 'error' event → pool recovery
				s.lastSeen = Date.now();            // keep GC from killing the notice before pickup
				flush(s);
			}
			sessions.delete(id);
		});
		sessions.set(id, s);
		return s;
	}
	function killSession(s: Session): void {
		s.dead = true;
		sessions.delete(s.id);
		const w = s.waiter;
		s.waiter = null;
		if (w) { clearTimeout(w.timer); w.resolve([]); }
		try { s.child.kill(); } catch { /* gone */ }
	}

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
		const p = url.pathname.replace(/\/+$/, '');
		cors(res);
		if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
		const authed = !token || req.headers['x-sim-token'] === token;
		const msgMatch = /^\/session\/(\d+)\/(msg|out)$/.exec(p);

		try {
			if (p === '/ping') {
				const gpu = probeGpu();
				json(res, 200, {
					ok: true, cores: os.cpus().length, tokenRequired: !!token,
					// The extra lane needs a device that is exact, passes the guard race
					// AND answers the multi-request entry. A pending check reports ok:false.
					gpu: {
						ok: gpu.ok, batch: gpu.batch, reasons: gpu.reasons, device: gpu.device,
						floorMs: gpu.floorMs, slopeMsPerRace: gpu.slopeMsPerRace, parityOk: gpu.parityOk,
						pending: gpu.pending === true,
					},
				});
				return;
			}
			// The packaged launcher serves the built app from this origin, so the app's
			// default server URL already points at the API it came from.
			if (staticDir && req.method === 'GET' && !p.startsWith('/session') && !p.startsWith('/multiplex')) {
				const rel = p === '' ? 'index.html' : p.slice(1);
				const file = path.resolve(staticDir, rel);
				const inside = file === path.join(staticDir, 'index.html') || file.startsWith(staticDir + path.sep);
				if (inside) {
					try {
						const body = await fs.promises.readFile(file);
						res.writeHead(200, { 'Content-Type': STATIC_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
						res.end(body);
						return;
					} catch { /* not a file: fall through to the API's 404 */ }
				}
			}
			if (!authed) { json(res, 401, { error: 'token required (set it in Simulation settings)' }); return; }

			if (p === '/session' && req.method === 'POST') {
				// Optional body {"engine":"wasm"|"native"|"gpu"} picks the backend.
				// An absent or unparsable body means "no explicit engine".
				let engine: unknown;
				try { engine = (JSON.parse((await readBody(req)) || '{}') as any).engine; } catch { /* body optional */ }
				const requested: Backend | undefined = engine === 'native' || engine === 'wasm' || engine === 'gpu' ? engine : undefined;
				if (requested === 'gpu') {
					// A pinned gpu session waits for the startup check instead of racing it.
					const gpu = gpuProbe ?? await startGpuProbe();
					if (!gpu.ok) { json(res, 503, { error: `gpu backend unavailable: ${gpu.reasons.join(', ')}` }); return; }
				}
				const s = createSession(requested);
				if (!s) { json(res, 500, { error: 'failed to spawn sim worker' }); return; }
				json(res, 200, { sessionId: s.id, backend: s.backend });
				console.log(`[sim-server] session ${s.id} backend ${s.backend}`);
				return;
			}
			if (p === '/multiplex' && req.method === 'GET') {
				const idset = new Set((url.searchParams.get('ids') ?? '').split(',').filter(x => /^\d+$/.test(x)));
				// ack=1 → the client dispatched the previous response in full:
				// commit its in-flight window before snapshotting the next one.
				const acked = url.searchParams.get('ack') === '1';
				const got = collectMux(idset, acked);
				if (got) { json(res, 200, { msgs: got }); return; }
				const waiter: MuxWaiter = {
					ids: idset,
					acked,
					resolve: (msgs) => { if (!res.writableEnded) json(res, 200, { msgs }); },
					timer: setTimeout(() => {
						const i = muxWaiters.indexOf(waiter);
						if (i >= 0) muxWaiters.splice(i, 1);
						if (!res.writableEnded) json(res, 200, { msgs: [] });
					}, 20000),
				};
				muxWaiters.push(waiter);
				req.on('close', () => {
					const i = muxWaiters.indexOf(waiter);
					if (i >= 0) muxWaiters.splice(i, 1);
					clearTimeout(waiter.timer);
				});
				return;
			}
			if (msgMatch) {
				const s = sessions.get(msgMatch[1]);
				if (!s || s.dead) { json(res, 410, { error: 'session closed' }); return; }
				s.lastSeen = Date.now();
				if (msgMatch[2] === 'msg') {
					if (req.method !== 'POST') { json(res, 405, { error: 'POST only' }); return; }
					const body = await readBody(req);
					let msg: unknown;
					try { msg = JSON.parse(body); } catch { json(res, 400, { error: 'invalid JSON' }); return; }
					if (s.backend === 'gpu' && (msg as any)?.type === 'run') {
						s.gpuLaunches = (s.gpuLaunches ?? 0) + 1;
						console.log(`[sim-server] gpu launch ${s.gpuLaunches} on session ${s.id}`);
					}
					s.child.send({ m: msg });
					json(res, 202, { ok: true });
					return;
				}
				// GET /out — long-poll; at most one waiter per session.
				if (req.method !== 'GET') { json(res, 405, { error: 'GET only' }); return; }
				// same dequeue-on-ack protocol as /multiplex (ack=1 commits the
				// window the previous response handed over)
				if (url.searchParams.get('ack') === '1' && s.sent > 0) { s.out.splice(0, s.sent); s.sent = 0; }
				if (s.waiter) { const old = s.waiter; s.waiter = null; clearTimeout(old.timer); old.resolve([]); }
				if (s.out.length > 0) {
					s.sent = s.out.length;   // snapshot awaiting the next ack
					json(res, 200, { msgs: [...s.out] });
					return;
				}
				if (s.dead) { json(res, 200, { msgs: [{ type: '__died' }] }); return; }
				const onTimeout = (): void => {
					if (s.waiter === waiter) { s.waiter = null; json(res, 200, { msgs: [] }); }
				};
				// The closure reads `waiter` only when the timer fires — after init.
				const waiter: Waiter = {
					resolve: (msgs: any[]) => json(res, 200, { msgs }),
					timer: setTimeout(onTimeout, 25000),
				};
				s.waiter = waiter;
				req.on('close', () => { if (s.waiter === waiter) { s.waiter = null; clearTimeout(waiter.timer); } });
				return;
			}
			const del = /^\/session\/(\d+)$/.exec(p);
			if (del && req.method === 'DELETE') {
				const s = sessions.get(del[1]);
				if (s) killSession(s);
				json(res, 202, { ok: true });
				return;
			}
			json(res, 404, { error: 'not found' });
		} catch (e: any) {
			json(res, 500, { error: String(e?.message || e) });
		}
	});

	// GC abandoned sessions (browser closed/refreshed without DELETE): no
	// contact for 2 minutes → kill the child.
	setInterval(() => {
		const now = Date.now();
		for (const s of [...sessions.values()]) {
			if (now - s.lastSeen > 120_000) killSession(s);
		}
	}, 30_000).unref();

	server.listen(port, host, () => {
		const real = (server.address() as any).port;
		console.log(`sim-server listening on http://${host}:${real} (cores: ${os.cpus().length}${token ? ', token required' : ''}${lan ? ', LAN BIND — keep the token set!' : ''})`);
		console.log('Keep this window open while the simulator is running. Ctrl+C or close to stop.');
	});
	process.on('SIGINT', () => { for (const s of [...sessions.values()]) killSession(s); server.close(); process.exit(0); });
}

if (argv.includes('--child')) childMain();
// require.main keeps the module importable by tests (pickRotationBackend) without
// starting a server: imported code has no main module.
else if (require.main === module) masterMain();

