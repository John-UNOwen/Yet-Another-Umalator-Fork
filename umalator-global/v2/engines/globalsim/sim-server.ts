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
 *     POST   /session              → {sessionId}          (forks ONE child)
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
import { fork, ChildProcess } from 'child_process';
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

// ── child role ───────────────────────────────────────────────────────────────

function childMain(): void {
	(globalThis as any).CC_GLOBAL = true;
	const core = createGlobalsimWorkerCore({
		postMessage: (m: unknown) => {
			try { process.send!({ m }); } catch { /* parent gone — exit via disconnect */ }
		},
		loadWasm: async () => {
			// ESM wasm-bindgen pkg under ts-node/commonjs: import via URL (same
			// trick as the acceptance suites).
			const dynImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>;
			const mod = await dynImport(pathToFileURL(path.join(WASM_PKG, 'globalsim_wasm.js')).href);
			const init = mod.default ?? mod.init;
			await init(fs.readFileSync(path.join(WASM_PKG, 'globalsim_wasm_bg.wasm')));
			return {
				register_geometry: (id: number, t: string) => mod.register_geometry(id, t),
				PreparedRace: mod.PreparedRace,
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
interface Session {
	id: string;
	child: ChildProcess;
	// Dequeue-on-ack queue: `out` holds every message the client has not
	// acknowledged; `sent` counts the leading ones already handed to the last
	// long-poll response, awaiting that response's ack=1. Responses peek the
	// whole queue, so a lost response window is redelivered, not lost.
	out: any[];
	sent: number;
	waiter: Waiter | null;
	lastSeen: number;
	dead: boolean;
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

	function createSession(): Session | null {
		const id = String(nextId++);
		let child: ChildProcess;
		try {
			child = fork(__filename, ['--child'], {
				cwd: HERE,
				env: {
					...process.env,
					TS_NODE_TRANSPILE_ONLY: '1',
					TS_NODE_COMPILER_OPTIONS: process.env.TS_NODE_COMPILER_OPTIONS ?? JSON.stringify({ moduleResolution: 'node', module: 'commonjs' }),
				},
				// fork's execArgv replaces node flags entirely: just the ts loader.
				execArgv: ['-r', require.resolve('ts-node/register/transpile-only')],
				stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
			});
		} catch (e: any) {
			console.error('fork failed:', e?.message || e);
			return null;
		}
		const s: Session = { id, child, out: [], sent: 0, waiter: null, lastSeen: Date.now(), dead: false };
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
				json(res, 200, { ok: true, cores: os.cpus().length, tokenRequired: !!token });
				return;
			}
			if (!authed) { json(res, 401, { error: 'token required (set it in Simulation settings)' }); return; }

			if (p === '/session' && req.method === 'POST') {
				const s = createSession();
				if (!s) { json(res, 500, { error: 'failed to spawn sim worker' }); return; }
				json(res, 200, { sessionId: s.id });
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
else masterMain();
