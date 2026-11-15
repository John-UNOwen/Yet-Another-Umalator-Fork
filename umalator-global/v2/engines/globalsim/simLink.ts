/**
 * Browser client for the local sim server (sim-server.ts).
 *
 * SimWorker implements the pool's WorkerLike interface over the sim-server
 * session API (POST msg + long-poll multiplex), so the pool, chart and compare
 * facades use offloaded workers with zero changes — the app factory just
 * returns SimWorker instead of a Worker when a server answered /ping.
 *
 * Semantics mapped from a Web Worker:
 *   postMessage        → POST /session/:id/msg (queued in order until the
 *                        session is open; flushed strictly sequentially)
 *   worker messages    → ONE shared GET /multiplex?ids=… long-poll (SimMux).
 *                        Deliberate: browsers cap a host at 6 concurrent
 *                        connections, so a long-poll PER worker would pin the
 *                        pool at ~6 workers no matter the threads setting.
 *                        One held GET feeds all workers; ids= refreshes on
 *                        watch (abort → immediate re-GET).
 *   worker crash       → child exit pushes {type:'__died'} OR transport loss →
 *                        ONE 'error' event per worker (pool then recreates)
 *   terminate()        → unwatch + DELETE (child killed server-side)
 */

import type { WorkerLike } from './pool';

export const SIMSERVER_DEFAULT_URL = 'http://127.0.0.1:8765';
export const SIMSERVER_URL_KEY = 'umalator_v2_simserver_url';
export const SIMSERVER_TOKEN_KEY = 'umalator_v2_simserver_token';

export interface PingResult {
	ok: boolean;
	cores?: number;
	tokenRequired?: boolean;
	error?: string;
}

/** 'auto' when stored as 'auto'/empty; otherwise the stored absolute URL. */
export function loadSimServerUrl(): string {
	try {
		if (typeof localStorage === 'undefined') return SIMSERVER_DEFAULT_URL;
		return localStorage.getItem(SIMSERVER_URL_KEY)?.trim() || SIMSERVER_DEFAULT_URL;
	} catch { return SIMSERVER_DEFAULT_URL; }
}
export function loadSimServerToken(): string {
	try {
		if (typeof localStorage === 'undefined') return '';
		return localStorage.getItem(SIMSERVER_TOKEN_KEY)?.trim() ?? '';
	} catch { return ''; }
}
export function saveSimServerSettings(url: string, token: string): void {
	try {
		if (typeof localStorage === 'undefined') return;
		localStorage.setItem(SIMSERVER_URL_KEY, url.trim());
		localStorage.setItem(SIMSERVER_TOKEN_KEY, token.trim());
	} catch { /* private mode — per-tab default is fine */ }
}

/** Cheap liveness probe (also how we learn the server wants a token). */
export async function pingSimServer(url = loadSimServerUrl(), token = loadSimServerToken()): Promise<PingResult> {
	try {
		const res = await fetch(`${url.replace(/\/+$/, '')}/ping`, {
			headers: token ? { 'x-sim-token': token } : undefined,
			signal: AbortSignal.timeout(1500),
		});
		if (res.status === 401) return { ok: false, tokenRequired: true, error: 'token required' };
		if (!res.ok) return { ok: false, error: `http ${res.status}` };
		const j = await res.json() as any;
		return { ok: j.ok === true, cores: j.cores, tokenRequired: !!j.tokenRequired };
	} catch (e: any) {
		return { ok: false, error: String(e?.name === 'TimeoutError' ? 'timeout' : (e?.message || e)) };
	}
}

function simHdrs(token: string): Record<string, string> {
	const h: Record<string, string> = { 'content-type': 'application/json' };
	if (token) h['x-sim-token'] = token;
	return h;
}

/** One long-poll feed for every session against one base+token (≤6-socket cap). */
class SimMux {
	private static instances = new Map<string, SimMux>();
	static for(base: string, token: string): SimMux {
		const key = `${base}|${token}`;
		let m = SimMux.instances.get(key);
		if (!m) { m = new SimMux(base, token); SimMux.instances.set(key, m); }
		return m;
	}

	private handlers = new Map<string, (m: any) => void>();
	private running = false;
	private ac: AbortController | null = null;

	private constructor(private readonly base: string, private readonly token: string) {}

	watch(sid: string, fn: (m: any) => void): void {
		const fresh = !this.handlers.has(sid);
		this.handlers.set(sid, fn);
		if (!this.running) { this.running = true; void this.loop(); }
		// A new session must not wait out the held GET's idle timeout.
		else if (fresh) this.ac?.abort();
	}

	unwatch(sid: string): void {
		this.handlers.delete(sid);
	}

	private async loop(): Promise<void> {
		while (this.handlers.size > 0) {
			const ac = new AbortController();
			this.ac = ac;
			let got: Array<{ s: string; m: any }>;
			try {
				const ids = [...this.handlers.keys()].join(',');
				const res = await fetch(`${this.base}/multiplex?ids=${encodeURIComponent(ids)}`, { headers: simHdrs(this.token), signal: ac.signal });
				if (!res.ok) { this.failAll(`http ${res.status}`); return; }
				got = (await res.json() as any).msgs ?? [];
			} catch (e: any) {
				if (e?.name === 'AbortError') continue;   // id set changed → immediate re-GET
				this.failAll(String(e?.message || e));
				return;
			}
			for (const { s, m } of got) {
				const h = this.handlers.get(s);
				if (m && m.type === '__died') this.handlers.delete(s);
				if (h) { try { h(m); } catch { /* caller */ } }
			}
		}
		this.running = false;
	}

	/** Transport death: every watched session behaves like a dead worker. */
	private failAll(_reason: string): void {
		const hs = [...this.handlers.values()];
		this.handlers.clear();
		this.running = false;
		for (const h of hs) { try { h({ type: '__died' }); } catch { /* caller */ } }
	}
}

export class SimWorker implements WorkerLike {
	private readonly base: string;
	private sessionId: string | null = null;
	private opening: Promise<string>;
	private queue: unknown[] = [];
	private sendChain: Promise<void> = Promise.resolve();
	private msgCbs: Array<(e: { data: any }) => void> = [];
	private errCbs: Array<(e: unknown) => void> = [];
	private closed = false;
	private failed = false;
	private readonly sendAc = new AbortController();
	private readonly mux: SimMux;

	constructor(base: string, private readonly token: string = '') {
		this.base = base.replace(/\/+$/, '');
		this.mux = SimMux.for(this.base, token);
		this.opening = this.openSession();
		void this.opening.then(
			(sid) => this.mux.watch(sid, (m) => this.deliver(m)),
			(e: any) => this.fail(`sim server unreachable: ${String(e?.message || e)}`),
		);
	}

	private async openSession(): Promise<string> {
		const res = await fetch(`${this.base}/session`, { method: 'POST', headers: simHdrs(this.token), body: '{}', signal: this.sendAc.signal });
		if (!res.ok) throw new Error(`sim server session open failed: http ${res.status}`);
		const j = await res.json() as any;
		if (typeof j.sessionId !== 'string') throw new Error('sim server: no sessionId');
		this.sessionId = j.sessionId;
		return j.sessionId;
	}

	/** 'error' exactly once per worker (mirrors a Web Worker dying). */
	private fail(reason: string): void {
		if (this.closed || this.failed) return;
		this.failed = true;
		for (const cb of this.errCbs) { try { cb(reason); } catch { /* caller */ } }
	}

	private deliver(m: any): void {
		if (this.closed) return;
		if (m && m.type === '__died') { this.fail('sim worker died'); return; }
		for (const cb of this.msgCbs) { try { cb({ data: m }); } catch { /* caller */ } }
	}

	postMessage(msg: unknown): void {
		if (this.closed) return;
		this.queue.push(msg);
		// Strictly sequential flush keeps the worker protocol FIFO even while
		// the session POST is still in flight.
		this.sendChain = this.sendChain.then(async () => {
			if (this.closed) return;
			let id: string;
			try { id = this.sessionId ?? await this.opening; }
			catch { /* opening's rejection already failed this worker */ return; }
			while (this.queue.length > 0 && !this.closed) {
				const m = this.queue.shift();
				try {
					const res = await fetch(`${this.base}/session/${id}/msg`, { method: 'POST', headers: simHdrs(this.token), body: JSON.stringify(m), signal: this.sendAc.signal });
					if (!res.ok && res.status !== 410) { this.fail(`sim server msg failed: http ${res.status}`); return; }
				} catch {
					if (this.closed) return;
					this.fail('sim server unreachable');
					return;
				}
			}
		});
	}

	addEventListener(type: 'message', cb: (e: { data: any }) => void): void;
	addEventListener(type: 'error', cb: (e: unknown) => void): void;
	addEventListener(type: string, cb: any): void {
		if (type === 'message') this.msgCbs.push(cb);
		else if (type === 'error') this.errCbs.push(cb);
	}

	terminate(): void {
		if (this.closed) return;
		this.closed = true;
		const id = this.sessionId;
		this.queue.length = 0;
		this.sendAc.abort();
		if (id) {
			this.mux.unwatch(id);
			// Fire-and-forget; the server also GCs sessions it stops hearing from.
			void fetch(`${this.base}/session/${id}`, { method: 'DELETE', headers: simHdrs(this.token), keepalive: true }).catch(() => { /* gone */ });
		}
	}
}
