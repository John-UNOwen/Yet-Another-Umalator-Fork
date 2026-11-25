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
 *                        watch (abort → immediate re-GET). A window is
 *                        dropped server-side only when the next poll carries
 *                        ack=1 (set only after full dispatch), so an
 *                        aborted/dropped response is redelivered — results
 *                        windows are never lost.
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
	/** Whether the server accepted the token this client sent. False with
	 *  tokenRequired true means the server is up but every other call 401s. */
	authed?: boolean;
	/** The server's gpu verdict: only a batch-capable gpu whose startup check
	 *  passed is usable as the extra lane. Pending until the server's check answers.
	 *  Absent on servers that predate the field. */
	gpu?: {
		ok: boolean;
		batch: boolean;
		reasons: string[];
		device?: string | null;
		floorMs?: number | null;
		slopeMsPerRace?: number | null;
		parityOk?: boolean | null;
		pending?: boolean;
	};
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

/** Chrome's Local Network Access sorts the destination into an address space,
 *  and an https page may only reach http://127.0.0.1 when the request names the
 *  space it means: without this a hostname that resolves to loopback fails the
 *  mixed-content check before the permission is ever asked. IP literals are
 *  exempt from that check, so this is a no-op for the default URL. */
export type SimAddressSpace = 'local' | 'loopback';

export function simTargetSpace(url: string): SimAddressSpace | undefined {
	let host: string;
	try { host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return undefined; }
	if (host === 'localhost' || host === '::1' || host.endsWith('.localhost') || /^127\./.test(host)) return 'loopback';
	if (host.endsWith('.local') || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return 'local';
	return undefined;
}

/** fetch init tagged with the target's address space (see simTargetSpace). */
function simInit(url: string, init: RequestInit = {}): RequestInit {
	const space = simTargetSpace(url);
	return space ? ({ ...init, targetAddressSpace: space } as RequestInit) : init;
}

/**
 * Whether this origin may reach loopback yet. Chrome answers 'prompt' when the
 * site has never asked, and a request made without a user gesture is denied
 * without showing the dialog and stays denied, so the app must not probe on
 * load. Browsers without Local Network Access reject the query and report
 * 'unknown', which keeps their old unconditional probe.
 */
export type SimAccess = 'granted' | 'prompt' | 'denied' | 'unknown';

export async function simAccessState(): Promise<SimAccess> {
	try {
		if (typeof navigator === 'undefined' || !navigator.permissions?.query) return 'unknown';
		// 'loopback-network' is the current name. The older combined
		// 'local-network-access' could crash a Chromium renderer, so it is not
		// queried here.
		const s = await navigator.permissions.query({ name: 'loopback-network' } as unknown as PermissionDescriptor);
		return s.state === 'granted' || s.state === 'denied' ? s.state : 'prompt';
	} catch { return 'unknown'; }
}

/**
 * True when reaching `url` crosses into a more private address space than this
 * page's own, which is the only case Chrome gates behind the permission. A
 * public page reaching any local target crosses, a localhost page reaching
 * loopback does not, and a page on the LAN reaching loopback does.
 */
export function needsGestureFor(url: string): boolean {
	const target = simTargetSpace(url);
	if (!target) return false;
	const origin = typeof location === 'undefined' ? undefined : simTargetSpace(location.origin);
	if (!origin) return true;
	return (target === 'loopback' ? 2 : 1) > (origin === 'loopback' ? 2 : 1);
}

/**
 * Liveness probe, and the one request that learns the server's token verdict.
 * timeoutMs has to outlast a permission dialog: the request stays pending while
 * the user reads it.
 */
export async function pingSimServer(
	url = loadSimServerUrl(),
	token = loadSimServerToken(),
	opts: { timeoutMs?: number } = {},
): Promise<PingResult> {
	try {
		const base = url.replace(/\/+$/, '');
		const res = await fetch(`${base}/ping`, simInit(base, {
			headers: token ? { 'x-sim-token': token } : undefined,
			signal: AbortSignal.timeout(opts.timeoutMs ?? 1500),
		}));
		if (res.status === 401) return { ok: false, tokenRequired: true, authed: false, error: 'token required' };
		if (!res.ok) return { ok: false, error: `http ${res.status}` };
		const j = await res.json() as any;
		const gpu = j.gpu && typeof j.gpu === 'object'
			? {
				ok: j.gpu.ok === true,
				batch: j.gpu.batch === true,
				reasons: Array.isArray(j.gpu.reasons) ? j.gpu.reasons as string[] : [],
				device: typeof j.gpu.device === 'string' ? j.gpu.device as string : null,
				floorMs: typeof j.gpu.floorMs === 'number' ? j.gpu.floorMs as number : null,
				slopeMsPerRace: typeof j.gpu.slopeMsPerRace === 'number' ? j.gpu.slopeMsPerRace as number : null,
				parityOk: typeof j.gpu.parityOk === 'boolean' ? j.gpu.parityOk as boolean : null,
				pending: j.gpu.pending === true,
			}
			: undefined;
		return {
			ok: j.ok === true,
			cores: j.cores,
			tokenRequired: !!j.tokenRequired,
			authed: typeof j.authed === 'boolean' ? j.authed : undefined,
			...(gpu ? { gpu } : {}),
		};
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
	// Dequeue-on-ack (mirrors sim-server): true only when the PREVIOUS
	// response was fully received AND dispatched — only then does the next
	// poll's ack=1 let the server drop that window. A response lost to an
	// abort/drop leaves this false, so the server redelivers the window.
	private ackNext = false;

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
			// The ack rides this request only; until the response below is
			// dispatched in full, the window stays unacked server-side.
			const ack = this.ackNext;
			this.ackNext = false;
			let got: Array<{ s: string; m: any }>;
			try {
				const ids = [...this.handlers.keys()].join(',');
				const res = await fetch(`${this.base}/multiplex?ids=${encodeURIComponent(ids)}${ack ? '&ack=1' : ''}`, simInit(this.base, { headers: simHdrs(this.token), signal: ac.signal }));
				if (!res.ok) { this.failAll(`http ${res.status}`); return; }
				got = (await res.json() as any).msgs ?? [];
			} catch (e: any) {
				if (e?.name === 'AbortError') continue;   // id set changed → immediate re-GET (the unacked window is redelivered)
				this.failAll(String(e?.message || e));
				return;
			}
			for (const { s, m } of got) {
				const h = this.handlers.get(s);
				if (m && m.type === '__died') this.handlers.delete(s);
				if (h) { try { h(m); } catch { /* caller */ } }
			}
			this.ackNext = true;   // window dispatched in full → the next poll acknowledges it
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

export type SimEngine = 'wasm' | 'native' | 'gpu';

export class SimWorker implements WorkerLike {
	/** Backend the server assigned this session (from POST /session). */
	backend: string | undefined;
	/** Resolves after the session opened (backend known); never rejects. */
	readonly ready: Promise<void>;
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

	/** engine pins the session's backend (pool gpuFallback rerun lane uses 'native');
	 *  omitted lets SIM_SERVER_BACKENDS rotation pick it. */
	constructor(base: string, private readonly token: string = '', readonly engine?: SimEngine) {
		this.base = base.replace(/\/+$/, '');
		this.mux = SimMux.for(this.base, token);
		this.opening = this.openSession();
		// Resolves once the server named this session's backend, so the pool
		// sizes the first chunk with the lane known (a gpu lane merges it).
		this.ready = this.opening.then(() => undefined, () => undefined);
		void this.opening.then(
			(sid) => this.mux.watch(sid, (m) => this.deliver(m)),
			(e: any) => this.fail(`sim server unreachable: ${String(e?.message || e)}`),
		);
	}

	private async openSession(): Promise<string> {
		const res = await fetch(`${this.base}/session`, simInit(this.base, { method: 'POST', headers: simHdrs(this.token), body: JSON.stringify(this.engine ? { engine: this.engine } : {}), signal: this.sendAc.signal }));
		if (!res.ok) throw new Error(`sim server session open failed: http ${res.status}`);
		const j = await res.json() as any;
		if (typeof j.sessionId !== 'string') throw new Error('sim server: no sessionId');
		this.backend = typeof j.backend === 'string' ? j.backend : undefined;
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
					const res = await fetch(`${this.base}/session/${id}/msg`, simInit(this.base, { method: 'POST', headers: simHdrs(this.token), body: JSON.stringify(m), signal: this.sendAc.signal }));
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
			void fetch(`${this.base}/session/${id}`, simInit(this.base, { method: 'DELETE', headers: simHdrs(this.token), keepalive: true })).catch(() => { /* gone */ });
		}
	}
}

/** The surface the pool drives on a lane worker (a subset of WorkerLike). */
export interface SimLaneWorker {
	postMessage(msg: unknown): void;
	addEventListener(type: 'message', cb: (e: { data: any }) => void): void;
	addEventListener(type: 'error', cb: (e: unknown) => void): void;
	terminate(): void;
	/** Pool dispose only: hand an idle session back for the next pool. */
	retain?(): void;
	ready?: Promise<void>;
	/** True once the session's engine is loaded (prewarmed or reused). */
	warm?: boolean;
	backend?: string;
}

/** Free gpu sessions, keyed by server+token. A lane released after a run waits
 *  here for the next pool, so a run skips the session open. The server kills a
 *  session after two idle minutes, so a stale entry is dropped on the next take. */
const warmLanes = new Map<string, WarmLane[]>();
const laneKey = (url: string, token: string): string => `${url.replace(/\/+$/, '')}|${token}`;
/** An open gpu session keeps device threads alive, which measured 27% off the
 *  CPU pool's throughput on this machine. A free lane therefore closes after
 *  this idle grace, so consecutive lane runs still reuse it but a CPU-only run
 *  never shares the machine with an idle device. */
const WARM_IDLE_CLOSE_MS = 10_000;

/**
 * A gpu session that outlives its pool: terminate() returns it to the warm
 * cache instead of closing it, unless the session died or a reply is still in
 * flight. It reports `warm` once the engine is loaded, which tells the pool
 * that its first chunk pays no startup cost.
 */
class WarmLane implements SimLaneWorker {
	/** Live, not a snapshot: the session's backend is known only after it opens,
	 *  and a pool that gets this lane from the factory reads it to see a gpu
	 *  session (that flag decides whether a batch rides one launch). */
	get backend(): string | undefined { return this.inner.backend; }
	readonly ready: Promise<void>;
	warm = false;
	private msgCbs: Array<(e: { data: any }) => void> = [];
	private errCbs: Array<(e: unknown) => void> = [];
	private adopted = false;
	private outstanding = 0;
	private poisoned = false;
	private closed = false;
	private prewarmCb: ((openMs: number) => void) | null = null;
	private prewarmStart = 0;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly key: string, private readonly inner: SimWorker) {
		this.ready = inner.ready;
		inner.addEventListener('message', (e) => this.onMessage(e.data));
		inner.addEventListener('error', (e) => this.onError(e));
	}

	/** Load the engine now. onOpen gets the measured open in ms, or -1 on failure. */
	prewarm(onOpen?: (openMs: number) => void): void {
		if (this.warm || this.closed) return;
		this.prewarmCb = onOpen ?? (() => { /* caller has no measurement */ });
		this.prewarmStart = Date.now();
		this.inner.postMessage({ type: 'warm' });
	}

	/** Hand the lane to a pool, which owns the callbacks from here on. */
	take(): this {
		this.adopted = true;
		this.cancelIdleClose();
		this.msgCbs = [];
		this.errCbs = [];
		this.outstanding = 0;
		return this;
	}

	/** A lane a pool may take: warmed and still healthy. */
	isUsable(): boolean { return this.warm && !this.poisoned && !this.closed; }

	/** Drop a lane whose warm-up failed, so no pool ever takes it. */
	discard(): void { this.cancelIdleClose(); this.close(); }

	/** Start the idle-close grace on a lane no pool has taken yet. */
	armIdleClose(): void { if (!this.adopted) this.scheduleIdleClose(); }

	postMessage(msg: unknown): void {
		if (this.closed) return;
		const type = (msg as { type?: string } | null)?.type;
		if (type === 'prepare' || type === 'run') this.outstanding++;
		this.inner.postMessage(msg);
	}

	addEventListener(type: 'message' | 'error', cb: any): void {
		if (type === 'message') this.msgCbs.push(cb);
		else if (type === 'error') this.errCbs.push(cb);
	}

	terminate(): void {
		if (!this.adopted) return;
		this.adopted = false;
		// Only an idle, healthy session may be handed to the next pool: a reply
		// still in flight would arrive on the next owner's callbacks.
		const reusable = !this.poisoned && !this.closed && this.outstanding <= 0;
		this.msgCbs = [];
		this.errCbs = [];
		if (!reusable) { this.close(); return; }
		this.outstanding = 0;
		this.warm = true;
		const free = warmLanes.get(this.key) ?? [];
		if (!free.includes(this)) free.push(this);
		warmLanes.set(this.key, free);
		this.scheduleIdleClose();
	}

	/** Close a free lane after the idle grace: an idle open session costs the
	 *  CPU pool cores. A prewarmed lane keeps its measurement window too. */
	private scheduleIdleClose(): void {
		this.cancelIdleClose();
		this.idleTimer = setTimeout(() => {
			this.idleTimer = null;
			if (!this.adopted) this.close();
		}, WARM_IDLE_CLOSE_MS);
		(this.idleTimer as { unref?: () => void }).unref?.();
	}

	private cancelIdleClose(): void {
		if (this.idleTimer != null) { clearTimeout(this.idleTimer); this.idleTimer = null; }
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.inner.terminate();
		const free = warmLanes.get(this.key);
		if (free) {
			const i = free.indexOf(this);
			if (i >= 0) free.splice(i, 1);
			if (free.length === 0) warmLanes.delete(this.key);
		}
	}

	private onMessage(m: any): void {
		if (m && m.type === 'warm') {
			const cb = this.prewarmCb;
			this.prewarmCb = null;
			if (m.ok === true) {
				this.warm = true;
				cb?.(Date.now() - this.prewarmStart);
			} else cb?.(-1);
			return;
		}
		if (!this.adopted) return;
		if (m && (m.type === 'prepared' || m.type === 'chunk')) this.outstanding = Math.max(0, this.outstanding - 1);
		for (const cb of this.msgCbs) { try { cb({ data: m }); } catch { /* pool */ } }
	}

	private onError(e: unknown): void {
		this.poisoned = true;
		if (!this.adopted) return;
		for (const cb of this.errCbs) { try { cb(e); } catch { /* pool */ } }
	}
}

/** Free cpu sessions, keyed by server, token and engine. A pool retains its
 *  idle sessions at dispose and the next pool takes them, so a run's first
 *  batch pays no session opens. The idle grace keeps sessions from lingering. */
const warmSessions = new Map<string, WarmSession[]>();

/**
 * A cpu session that outlives its pool. Only `retain()` hands it to the cache,
 * which keeps a session whose engine died on the normal terminate path.
 */
class WarmSession implements SimLaneWorker {
	/** Live, like WarmLane: the backend is known only after the session opens. */
	get backend(): string | undefined { return this.inner.backend; }
	readonly ready: Promise<void>;
	warm = false;
	private msgCbs: Array<(e: { data: any }) => void> = [];
	private errCbs: Array<(e: unknown) => void> = [];
	private adopted = false;
	private outstanding = 0;
	private answered = 0;
	private poisoned = false;
	private closed = false;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly key: string, private readonly inner: SimWorker) {
		this.ready = inner.ready;
		inner.addEventListener('message', (e) => this.onMessage(e.data));
		inner.addEventListener('error', (e) => this.onError(e));
	}

	/** Hand the session to a pool, which owns the callbacks from here on. */
	take(): this {
		this.adopted = true;
		this.cancelIdleClose();
		this.msgCbs = [];
		this.errCbs = [];
		this.outstanding = 0;
		this.answered = 0;
		return this;
	}

	postMessage(msg: unknown): void {
		if (this.closed) return;
		const type = (msg as { type?: string } | null)?.type;
		// Only messages the worker answers hold a session back: a skillData
		// install is fire and forget, and counting it would never drain.
		if (type === 'prepare' || type === 'run') this.outstanding++;
		this.inner.postMessage(msg);
	}

	addEventListener(type: 'message' | 'error', cb: any): void {
		if (type === 'message') this.msgCbs.push(cb);
		else if (type === 'error') this.errCbs.push(cb);
	}

	/** Pool dispose: hand an idle, working session to the next pool. */
	retain(): void {
		if (!this.adopted) return;
		this.adopted = false;
		const reusable = !this.poisoned && !this.closed && this.outstanding <= 0 && this.answered > 0;
		this.msgCbs = [];
		this.errCbs = [];
		if (!reusable) { this.close(); return; }
		this.warm = true;
		this.outstanding = 0;
		const free = warmSessions.get(this.key) ?? [];
		if (!free.includes(this)) free.push(this);
		warmSessions.set(this.key, free);
		this.scheduleIdleClose();
	}

	/** Every other exit closes the session for real. */
	terminate(): void {
		this.adopted = false;
		this.msgCbs = [];
		this.errCbs = [];
		this.close();
	}

	private scheduleIdleClose(): void {
		this.cancelIdleClose();
		this.idleTimer = setTimeout(() => {
			this.idleTimer = null;
			if (!this.adopted) { this.close(); this.forget(); }
		}, WARM_IDLE_CLOSE_MS);
		(this.idleTimer as { unref?: () => void }).unref?.();
	}

	private cancelIdleClose(): void {
		if (this.idleTimer != null) { clearTimeout(this.idleTimer); this.idleTimer = null; }
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.inner.terminate();
	}

	private forget(): void {
		const free = warmSessions.get(this.key);
		if (!free) return;
		const i = free.indexOf(this);
		if (i >= 0) free.splice(i, 1);
		if (free.length === 0) warmSessions.delete(this.key);
	}

	private onMessage(m: any): void {
		if (!this.adopted) return;
		if (m && (m.type === 'prepared' || m.type === 'chunk' || m.type === 'warm')) {
			this.outstanding = Math.max(0, this.outstanding - 1);
			this.answered++;
		}
		for (const cb of this.msgCbs) { try { cb({ data: m }); } catch { /* pool */ } }
	}

	private onError(e: unknown): void {
		this.poisoned = true;
		if (!this.adopted) return;
		for (const cb of this.errCbs) { try { cb(e); } catch { /* pool */ } }
	}
}

/** A reusable session for this server, else undefined. Dead entries are closed
 *  and skipped. */
function takeWarmSession(key: string): WarmSession | undefined {
	for (;;) {
		const free = warmSessions.get(key);
		const session = free?.shift();
		if (!session) return undefined;
		if (free!.length === 0) warmSessions.delete(key);
		session.terminate();
	}
}

/**
 * The cpu worker factory a pool gets: sessions are taken from the warm cache
 * when one is idle, so consecutive chart, compare and optimizer runs stop
 * paying the session opens again. The pool must retain idle sessions at
 * dispose for the cache to fill.
 */
export function simSessionFactory(url: string, token = '', engine: 'native' | 'wasm' = 'native'): () => SimLaneWorker {
	const key = `${laneKey(url, token)}|${engine}`;
	return () => takeWarmSession(key) ?? new WarmSession(key, new SimWorker(url, token, engine)).take();
}

/** A reusable lane for this server, else undefined. Stale or dead entries are
 *  closed and skipped. */
function takeWarmLane(key: string): WarmLane | undefined {
	for (;;) {
		const free = warmLanes.get(key);
		const lane = free?.shift();
		if (!lane) return undefined;
		if (free!.length === 0) warmLanes.delete(key);
		if (lane.isUsable()) return lane.take();
		lane.discard();
	}
}

/**
 * Open the lane's session and engine right after the startup check: the first
 * run's lane starts warm, and later runs reuse the session. onOpen gets the
 * measured session open in ms (-1 when the warm-up failed).
 */
export function prewarmGpuLane(url: string, token = '', onOpen?: (openMs: number) => void): void {
	const key = laneKey(url, token);
	const free = warmLanes.get(key);
	if (free && free.length > 0) return;
	const lane = new WarmLane(key, new SimWorker(url, token, 'gpu'));
	warmLanes.set(key, [lane]);
	lane.armIdleClose();
	lane.prewarm((openMs) => {
		if (openMs < 0) { lane.discard(); return; }
		onOpen?.(openMs);
	});
}

/** The extra lane's worker factory: one pinned gpu session per call, taken from
 *  the warm cache when one is idle. Build it only when /ping reports a
 *  batch-capable gpu, so a pool never opens a session the server would refuse. */
export function simGpuFactory(url: string, token: string): () => SimLaneWorker {
	const key = laneKey(url, token);
	return () => takeWarmLane(key) ?? new WarmLane(key, new SimWorker(url, token, 'gpu')).take();
}

