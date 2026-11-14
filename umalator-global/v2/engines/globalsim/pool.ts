/**
 * GlobalSim worker pool + seed scheduler (Phase 4, §4.1, decision D2).
 *
 * N Web Workers, each holding one globalsim-wasm instance (§4.2 — one
 * PreparedRace at a time per worker). Jobs are (setup, ≤CHUNK seeds) chunks;
 * every completed chunk streams its compact per-seed records back through
 * onChunk, so aggregates grow while the run proceeds.
 *
 * ## Preparation affinity
 *
 * A worker re-prepares only when the next job's setupKey differs from the
 * setup it currently holds ("roster/skills/course/gate"). The scheduler
 * prefers a queued job matching a free worker's current preparation; the
 * compare facade feeds jobs grouped by setupKey so a worker usually runs
 * several consecutive chunks on one preparation (auto-gate mode: ≤9 setups
 * per variant — one per gate — instead of one per seed).
 *
 * ## Crash policy
 *
 * Only a dead handle/worker triggers recovery: the engine's "engine panic:
 * …" errors (globalsim-wasm/README.md) kill the wasm handle, so the pool
 * terminates and recreates that worker and requeues the in-flight chunk
 * exactly once; a second failure of the same chunk is reported as a job
 * error — one bad input can never wedge the run.
 *
 * ## Thread-count option
 *
 * Persisted at THREADS_STORAGE_KEY: 'auto' = clamp(hardwareConcurrency − 1,
 * 1..8), or a fixed 1..16. Phase 7 settings will surface this; the pool
 * resolves it here (resolveThreadCount) and the UI control in sim-settings
 * reads/writes it.
 *
 * ## Testability (§4.1, Phase 4 test (e))
 *
 * The scheduler talks to workers only through the WorkerLike interface and an
 * injected WorkerFactory — mirroring how app-v2 constructs the classic
 * simulator worker (`new Worker(new URL('./simulator.worker.ts',
 * import.meta.url), {type:'module'}))`. The URL-based default factory lives
 * in the app (app-v2) because only the bundler knows the emitted worker
 * file; unit tests inject scripted fakes and node acceptance tests bridge the
 * REAL workerCore against the REAL wasm pkg (compare.acceptance.test.ts).
 */

export const THREADS_STORAGE_KEY = 'umalator_v2_globalsim_threads';
export const AUTO_THREADS_MAX = 8;   // §4.1: Auto caps at 8 (lower on mobile later)
export const MAX_THREADS = 16;       // user option range 1..16

export type ThreadsOption = 'auto' | number;

export function loadThreadsOption(): ThreadsOption {
	try {
		if (typeof localStorage === 'undefined') return 'auto';
		const raw = localStorage.getItem(THREADS_STORAGE_KEY);
		if (raw == null) return 'auto';
		const n = Number(raw);
		return Number.isInteger(n) && n >= 1 && n <= MAX_THREADS ? n : 'auto';
	} catch { return 'auto'; }
}

export function saveThreadsOption(v: ThreadsOption): void {
	try {
		if (typeof localStorage === 'undefined') return;
		localStorage.setItem(THREADS_STORAGE_KEY, v === 'auto' ? 'auto' : String(Math.max(1, Math.min(MAX_THREADS, Math.round(v)))));
	} catch { /* private mode etc. — the default is fine */ }
}

/** Auto = hardwareConcurrency − 1 (leave one core for UI), clamped to [1, 8]. */
export function autoThreadCount(hardwareConcurrency?: number): number {
	const hc = hardwareConcurrency ?? (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4) ?? 4;
	return Math.max(1, Math.min(AUTO_THREADS_MAX, hc - 1));
}

export function resolveThreadCount(opt: ThreadsOption = loadThreadsOption()): number {
	return opt === 'auto' ? autoThreadCount() : Math.max(1, Math.min(MAX_THREADS, Math.round(opt)));
}

// ── worker seam ──────────────────────────────────────────────────────────────

export interface WorkerLike {
	postMessage(msg: unknown): void;
	addEventListener(type: 'message', cb: (e: { data: any }) => void): void;
	addEventListener(type: 'error', cb: (e: unknown) => void): void;
	terminate(): void;
}
export type WorkerFactory = () => WorkerLike;

export interface PoolJob {
	id: string;
	/** Identity of the preparation: 'roster/skills/course/gate' encoded by the caller. */
	setupKey: string;
	/** The full GlobalSim request (adapter output; plain JSON, seed = placeholder). */
	request: unknown;
	seeds: number[];
	mode: 'compact' | 'full';
	/**
	 * Optional: skill id the worker should count activations of for the player
	 * runner in every compact record of this job (Phase 5 chart — the worker
	 * only pays for the events of this ONE skill; see workerCore extractCompact).
	 * Travels with the prepare message, so it is part of the preparation.
	 */
	trackSkillId?: string;
}

export interface PoolOptions {
	factory: WorkerFactory;
	/** Resolved worker count (see resolveThreadCount). Default: auto. */
	threads?: number;
	/** Every completed chunk: records are SeedCompactRecord[] or FullRunData[]. */
	onChunk?: (job: PoolJob, records: any[]) => void;
	/** A chunk that failed twice (dead twice) or hit an input error. */
	onJobError?: (job: PoolJob, error: string) => void;
}

export interface GlobalsimPool {
	runJobs(jobs: PoolJob[]): Promise<{ errors: Array<{ jobId: string; error: string }> }>;
	dispose(): void;
	/**
	 * Cancel a running batch (Phase 5 chart Stop path): every live worker is
	 * terminated, queued and in-flight jobs are dropped WITHOUT requeue, and
	 * the pending runJobs promise REJECTS with an 'aborted' error. A no-op
	 * after dispose or a second abort.
	 */
	abort(): void;
	/** Number of live workers (tests). */
	size(): number;
}

interface Queued { job: PoolJob; requeues: number }

interface Slot {
	gen: number;                 // bumped on every worker (re)creation to ignore stale messages
	worker: WorkerLike | null;
	preparedKey: string | null;
	inflight: Queued | null;
	expecting: 'prepared' | 'chunk' | null;
}

export function createGlobalsimPool(opts: PoolOptions): GlobalsimPool {
	const threads = Math.max(1, Math.min(MAX_THREADS, opts.threads ?? resolveThreadCount()));
	const queue: Queued[] = [];
	const slots: Slot[] = [];
	const errors: Array<{ jobId: string; error: string }> = [];
	let running: { resolve: () => void; reject: (e: Error) => void } | null = null;
	let disposed = false;
	let aborted = false;

	function makeSlot(): Slot {
		const slot: Slot = { gen: 0, worker: null, preparedKey: null, inflight: null, expecting: null };
		attachWorker(slot);
		slots.push(slot);
		return slot;
	}

	function attachWorker(slot: Slot): void {
		slot.gen++;
		const gen = slot.gen;
		slot.worker = opts.factory();
		slot.preparedKey = null;
		slot.expecting = null;
		slot.worker.addEventListener('message', (e: { data: any }) => { if (!disposed && !aborted && slot.gen === gen) onWorkerMessage(slot, e.data); });
		// A crashed worker (OOM / uncaught throw / wasm trap the runtime kills
		// the thread for) lands here — same recovery path as an engine panic.
		slot.worker.addEventListener('error', () => { if (!disposed && !aborted && slot.gen === gen) failWorker(slot, 'worker crashed'); });
	}

	function failWorker(slot: Slot, reason: string): void {
		const failed = slot.inflight;
		slot.inflight = null;
		slot.expecting = null;
		try { slot.worker?.terminate(); } catch { /* already gone */ }
		slot.worker = null;
		slot.preparedKey = null;
		if (failed) {
			if (failed.requeues >= 1) {
				// Second failure of the same chunk → job error (§4.1).
				errors.push({ jobId: failed.job.id, error: reason });
				opts.onJobError?.(failed.job, reason);
			} else {
				failed.requeues++;
				queue.unshift(failed);   // exactly one requeue of the in-flight chunk
			}
		}
		if (disposed || aborted) return;
		attachWorker(slot);             // recreate eagerly (loads wasm lazily on next prepare)
		dispatch();
	}

	function onWorkerMessage(slot: Slot, data: any): void {
		if (disposed || aborted) return;
		if (!data || typeof data !== 'object' || !slot.inflight) return;
		const job = slot.inflight.job;
		if (data.type === 'prepared') {
			if (slot.expecting !== 'prepared' || data.id !== job.id) return;
			slot.expecting = null;
			if (data.ok === true) {
				slot.preparedKey = job.setupKey;
				slot.expecting = 'chunk';
				slot.worker!.postMessage({ type: 'run', jobId: job.id, seeds: job.seeds, mode: job.mode });
			} else if (data.dead === true) {
				failWorker(slot, `prepare failed (dead): ${data.error}`);
			} else {
				// Input-level prepare failure — a retry would fail identically.
				const msg = `prepare failed: ${data.error}`;
				slot.inflight = null;
				errors.push({ jobId: job.id, error: msg });
				opts.onJobError?.(job, msg);
				dispatch();
			}
			return;
		}
		if (data.type === 'chunk') {
			if (slot.expecting !== 'chunk' || data.jobId !== job.id) return;
			slot.expecting = null;
			if (data.ok === true) {
				slot.inflight = null;
				opts.onChunk?.(job, data.records || []);
			} else if (data.dead === true) {
				// failWorker consumes slot.inflight (requeue or job error).
				failWorker(slot, `dead handle: ${data.error}`);
				return;
			} else {
				// workerCore had no preparation for the job — cannot recover by retry.
				slot.inflight = null;
				const msg = `chunk failed: ${data.error}`;
				errors.push({ jobId: job.id, error: msg });
				opts.onJobError?.(job, msg);
			}
			dispatch();
			return;
		}
	}

	/** Give every idle worker a job, preferring its held preparation. */
	function dispatch(): void {
		if (!running || disposed || aborted) return;
		for (const slot of slots) {
			if (slot.inflight || queue.length === 0) continue;
			let idx = slot.preparedKey == null ? -1 : queue.findIndex(q => q.job.setupKey === slot.preparedKey);
			if (idx < 0) idx = 0;   // no affinity match: keep queue order (jobs are grouped by setupKey upstream)
			const next = queue.splice(idx, 1)[0];
			slot.inflight = next;
			if (slot.preparedKey === next.job.setupKey) {
				slot.expecting = 'chunk';
				slot.worker!.postMessage({ type: 'run', jobId: next.job.id, seeds: next.job.seeds, mode: next.job.mode });
			} else {
				slot.expecting = 'prepared';
				slot.worker!.postMessage({ type: 'prepare', id: next.job.id, setupKey: next.job.setupKey, request: next.job.request, trackSkillId: next.job.trackSkillId });
			}
		}
		if (running && queue.length === 0 && slots.every(s => !s.inflight)) {
			const r = running; running = null;
			r.resolve();
		}
	}

	return {
		runJobs(jobs: PoolJob[]): Promise<{ errors: Array<{ jobId: string; error: string }> }> {
			if (running) return Promise.reject(new Error('globalsim pool is already running a batch'));
			if (aborted) return Promise.reject(new Error('globalsim pool was aborted'));
			if (disposed) return Promise.reject(new Error('globalsim pool is disposed'));
			queue.push(...jobs.map(job => ({ job, requeues: 0 })));
			const n = Math.min(threads, Math.max(1, queue.length));
			while (slots.length < n) makeSlot();
			return new Promise<void>((resolve, reject) => {
				running = { resolve, reject };
				dispatch();
			}).then(() => ({ errors }));
		},
		dispose(): void {
			disposed = true;
			for (const slot of slots) { try { slot.worker?.terminate(); } catch { /* gone */ } slot.worker = null; }
			slots.length = 0;
			queue.length = 0;
			running?.resolve();
			running = null;
		},
		abort(): void {
			if (disposed || aborted) return;
			aborted = true;
			queue.length = 0;
			for (const slot of slots) {
				slot.inflight = null;
				slot.expecting = null;
				try { slot.worker?.terminate(); } catch { /* already gone */ }
				slot.worker = null;
			}
			slots.length = 0;
			// Pending runJobs promise rejects; nothing is requeued (Stop semantics).
			const r = running;
			running = null;
			r?.reject(new Error('globalsim pool aborted'));
		},
		size(): number { return slots.length; },
	};
}
