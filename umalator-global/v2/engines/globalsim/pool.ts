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
 * 1..MAX_THREADS), or a fixed 1..MAX_THREADS. The pool resolves it here
 * (resolveThreadCount) and the UI control in sim-settings reads/writes it.
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
export const MAX_THREADS = 32;       // worker ceiling: user option range 1..32
export const AUTO_THREADS_MAX = MAX_THREADS;  // Auto = every core minus the UI thread (hc−1, up to MAX_THREADS).
	// A browser worker for the skill sim does not grow the tab's memory with worker count, so the
	// old "cap at 6" (renderer Out of Memory at 8 workers on the ~120 MB/worker baseline field)
	// no longer applies. Dial it back in Advanced if a machine still runs out of memory.

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

/** Auto = hardwareConcurrency − 1 (leave one core for UI), clamped to [1, max]. */
export function autoThreadCount(hardwareConcurrency?: number, max: number = AUTO_THREADS_MAX): number {
	const hc = hardwareConcurrency ?? (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4) ?? 4;
	return Math.max(1, Math.min(max, hc - 1));
}

export function resolveThreadCount(opt: ThreadsOption = loadThreadsOption()): number {
	return opt === 'auto' ? autoThreadCount() : Math.max(1, Math.min(MAX_THREADS, Math.round(opt)));
}

/**
 * Thread count honoring whether a local sim server backs the workers. Auto now
 * reaches the same ceiling either way: in-browser the sim's memory no longer
 * scales with worker count, and with the server each worker is just a JSON-pipe
 * connection so the tab's heap ceiling is off the table too. The server-aware
 * hook stays for clarity; explicit settings are unchanged.
 */
export function serverAwareThreadCount(opt: ThreadsOption, serverBacked: boolean): number {
	return opt === 'auto'
		? (serverBacked ? autoThreadCount(undefined, MAX_THREADS) : autoThreadCount())
		: resolveThreadCount(opt);
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
	/**
	 * Optional (head-to-head compare): post-sort index of the second player in
	 * the race; forwarded to the prepare message so records carry `opp`.
	 * Part of the preparation identity (the caller must fold it into setupKey
	 * or keep one setupKey per distinct value).
	 */
	secondPlayerIndex?: number;
}

export interface PoolOptions {
	factory: WorkerFactory;
	/** Resolved worker count (see resolveThreadCount). Default: auto. */
	threads?: number;
	/**
	 * Merged active skill table (engine skillData): sent once to every worker
	 * as its first message ({type:'skillData'}), so preparations can omit the
	 * ~350 KB table per prepare (adapter config.skillData === null).
	 */
	skillData?: unknown;
	/** Every completed chunk: records are SeedCompactRecord[] or FullRunData[]. */
	onChunk?: (job: PoolJob, records: any[]) => void;
	/** A chunk that failed twice (dead twice) or hit an input error. */
	onJobError?: (job: PoolJob, error: string) => void;
}

export interface GlobalsimPool {
	/**
	 * Run one batch; resolves when it drains. `errors` carries ONLY this
	 * batch's job errors — a second runJobs on the same pool never
	 * re-reports an earlier batch's (chart.ts concatenates each result).
	 */
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

// ── shared worker budget ──────────────────────────────────────────────────────
//
// Every createGlobalsimPool (compare sampling, compare rep, the skill chart,
// the optimizer evaluator — and any two of those running at once, since the
// three modes gate independently) used to size its OWN pool to `threads`
// workers with no knowledge of the others, so N concurrent panes could hold
// N × threads live wasm workers. That oversubscribes the machine's cores (and
// stacked tab heap on the heavy skill-bearing baseline field), so the budget is
// the one shared accounting point the pools had no way to share: it caps the TOTAL live workers across every
// live pool at the configured thread budget, so overlapping runs SHARE the
// budget instead of each taking a full pool.
//
// How it stays fair without ever deadlocking:
//  • A permit is taken per worker for the worker's whole slot lifetime (a
//    crash-recreate reuses the slot's permit, so recovery can't be starved).
//  • When the budget is full, a pool first tries to RECLAIM an idle (no
//    in-flight chunk) worker from another pool — idle warm workers are the
//    first to go, preserving the un-contended preparation-affinity optimisation
//    (a lone pool keeps every worker warm and runs exactly as before).
//  • A pool is never starved to zero workers: its first slot is granted even
//    when every other pool is busy (bounded oversubscription, at most one per
//    actively-over-budget pool), which is what guarantees progress instead of a
//    runJobs promise that can never resolve on an empty slot set.
//  • Beyond the first slot, a contended pool waits on a FIFO permit queue; a
//    pool also yields its surplus warm workers when a batch drains while
//    someone is waiting, handing the budget over at the batch boundary.
//
// Capacity is the environment's thread budget: the largest per-pool `threads`
// any pool has asked for. A single pool is therefore never throttled below its
// own requested count (so server-aware auto → MAX_THREADS still scales up);
// it is only shared when two runs actually overlap.
interface WorkerBudget {
	capacity: number;
	live: number;
	waiters: Array<() => void>;
	reclaimers: Set<() => boolean>;
}
const workerBudget: WorkerBudget = { capacity: 0, live: 0, waiters: [], reclaimers: new Set() };

function budgetCapacity(): number {
	if (workerBudget.capacity < 1) workerBudget.capacity = Math.max(1, resolveThreadCount());
	return workerBudget.capacity;
}
/** Raise the shared capacity to at least `threads` (a pool never throttles a
 *  single run below its own requested count; overlap is what shares it). */
function budgetRaiseCapacity(threads: number): void {
	if (threads > budgetCapacity()) {
		workerBudget.capacity = threads;
		budgetPump();   // newly-available room may already satisfy queued pools
	}
}
/** Hand free capacity to the longest-waiting pool (each waiter reserves its
 *  own permit as it is granted). */
function budgetPump(): void {
	while (workerBudget.live < workerBudget.capacity && workerBudget.waiters.length) {
		workerBudget.waiters.shift()!();
	}
}
function budgetRelease(n: number): void {
	if (n <= 0) return;
	workerBudget.live = Math.max(0, workerBudget.live - n);
	budgetPump();
}
function budgetReleaseNoPump(): void {
	workerBudget.live = Math.max(0, workerBudget.live - 1);
}
/** Ask another pool to release ONE idle worker (its warm-but-unneeded slot). */
function budgetTryReclaim(exclude: () => boolean): boolean {
	for (const r of workerBudget.reclaimers) {
		if (r === exclude) continue;
		if (r()) return true;
	}
	return false;
}
/** Try to reserve one permit synchronously: free capacity, else reclaim idle
 *  slots from other pools, else (lastResort) oversubscribe by one so a pool is
 *  never left with zero workers. Returns false when the caller must wait. */
function budgetReserve(exclude: () => boolean, lastResort: boolean): boolean {
	if (workerBudget.live < budgetCapacity()) { workerBudget.live++; return true; }
	while (workerBudget.live >= budgetCapacity() && budgetTryReclaim(exclude)) { /* reclaimer did live-- */ }
	if (workerBudget.live < budgetCapacity()) { workerBudget.live++; return true; }
	if (lastResort) { workerBudget.live++; return true; }
	return false;
}

// Test-only seams: force a deterministic capacity (and clear the ledger) between
// pool tests, and read the live permit count. Never used by the app.
export function __testResetWorkerBudget(capacity?: number): void {
	workerBudget.waiters.length = 0;
	workerBudget.reclaimers.clear();
	workerBudget.live = 0;
	workerBudget.capacity = capacity ?? 0;   // 0 → re-derived lazily from resolveThreadCount()
}
export function __testWorkerBudgetLive(): number { return workerBudget.live; }
export function createGlobalsimPool(opts: PoolOptions): GlobalsimPool {
	const threads = Math.max(1, Math.min(MAX_THREADS, opts.threads ?? resolveThreadCount()));
	const queue: Queued[] = [];
	const slots: Slot[] = [];
	const errors: Array<{ jobId: string; error: string }> = [];
	let running: { resolve: () => void; reject: (e: Error) => void } | null = null;
	let disposed = false;
	let aborted = false;

	// ── shared-budget plumbing (see the worker budget block above) ──────────────
	// `held` = permits this pool owns: one per live slot PLUS any permit reserved
	// for a slot that has not materialised yet (async grant). dispose/abort
	// release `held` exactly once, so pending grants must not re-release.
	let held = 0;
	const pendingWaiters = new Set<() => void>();
	budgetRaiseCapacity(threads);
	workerBudget.reclaimers.add(reclaimIdleSlot);

	/** Release one idle (no in-flight chunk) slot back to the shared budget and
	 *  return true, or false when every slot is busy. Never called on this pool
	 *  from itself (the acquirer excludes its own reference), so it only ever
	 *  gives away warm-but-unneeded capacity to a contended run. */
	function reclaimIdleSlot(): boolean {
		const i = slots.findIndex(s => !s.inflight);
		if (i < 0) return false;
		const s = slots[i];
		try { s.worker?.terminate(); } catch { /* already gone */ }
		s.worker = null;
		slots.splice(i, 1);
		held--;
		budgetReleaseNoPump();
		return true;
	}

	/** Grow toward min(threads, queued work), taking permits from the shared
	 *  budget: sync while capacity is free (fast path — identical to the
	 *  historical eager creation), then a guaranteed first slot, then FIFO waits
	 *  with idle-reclaim from other pools. */
	function grow(): void {
		if (disposed || aborted) return;
		const target = Math.min(threads, Math.max(1, queue.length));
		while (slots.length < target) {
			if (budgetReserve(reclaimIdleSlot, slots.length === 0)) { held++; makeSlot(); continue; }
			// Contended remainder: queue ONE waiter; it materialises its slot on
			// grant then re-runs grow() for the rest.
			if (pendingWaiters.size > 0) break;
			let grantReady!: () => void;
			const p = new Promise<void>(res => { grantReady = res; });
			const grant = () => { workerBudget.live++; grantReady(); };
			workerBudget.waiters.push(grant);
			pendingWaiters.add(grant);
			budgetPump();
			p.then(() => {
				const mine = pendingWaiters.delete(grant);
				if (disposed || aborted) { if (mine) budgetRelease(1); return; }
				// The grant already did live++ for this permit — it is ours now.
				held++;
				if (slots.length >= threads || queue.length === 0) { held--; budgetRelease(1); return; }
				makeSlot();
				dispatch();
				grow();
			});
			break;
		}
	}

	/** Hand every idle slot to contended waiters at a batch boundary (a lone
	 *  pool keeps its warm preparations; only a waiting pool triggers yield). */
	function yieldIdleToWaiters(): void {
		if (!workerBudget.waiters.length) return;
		let released = 0;
		for (let i = slots.length - 1; i >= 0; i--) {
			if (slots[i].inflight) continue;
			try { slots[i].worker?.terminate(); } catch { /* already gone */ }
			slots[i].worker = null;
			slots.splice(i, 1);
			held--;
			released++;
		}
		if (released) budgetRelease(released);
	}

	/** Give up every permit this pool still holds (dispose/abort): drop any
	 *  still-queued (unfired) grant so it can never fire a stray live++, then
	 *  release the permits backing live slots and a kept grant. A grant that
	 *  already fired but whose slot has not materialised yet is left queued in
	 *  pendingWaiters — its .then releases that permit (mine === true), so it is
	 *  never double-counted here. */
	function releaseBudget(): void {
		if (pendingWaiters.size) {
			for (const g of pendingWaiters) {
				const i = workerBudget.waiters.indexOf(g);
				if (i >= 0) workerBudget.waiters.splice(i, 1);   // only still-queued grants
			}
		}
		if (held > 0) { budgetRelease(held); held = 0; }
		workerBudget.reclaimers.delete(reclaimIdleSlot);
	}

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
		if (opts.skillData !== undefined) slot.worker.postMessage({ type: 'skillData', skillData: opts.skillData });
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
				// Invalidate the cached preparation: workerCore.handlePrepare
				// frees the held PreparedRace before building the next one, so
				// a failed prepare can leave the worker with NO preparation.
				// Keeping the old key here would make dispatch bare-run the
				// next matching job into a "no preparation" failure — forever.
				slot.preparedKey = null;
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
				slot.worker!.postMessage({ type: 'prepare', id: next.job.id, setupKey: next.job.setupKey, request: next.job.request, trackSkillId: next.job.trackSkillId, secondPlayerIndex: next.job.secondPlayerIndex });
			}
		}
		if (running && queue.length === 0 && slots.every(s => !s.inflight)) {
			// Batch drained: if another run is waiting on the shared budget, hand
			// our surplus warm workers over (a lone pool keeps them warm — the
			// preparation-affinity fast path is untouched when un-contended).
			yieldIdleToWaiters();
			const r = running; running = null;
			r.resolve();
		}
	}

	return {
		runJobs(jobs: PoolJob[]): Promise<{ errors: Array<{ jobId: string; error: string }> }> {
			if (running) return Promise.reject(new Error('globalsim pool is already running a batch'));
			if (aborted) return Promise.reject(new Error('globalsim pool was aborted'));
			if (disposed) return Promise.reject(new Error('globalsim pool is disposed'));
			// The pool-level `errors` array accumulates across batches (chart.ts
			// runs one batch per round on the same pool and concatenates each
			// result), so resolve ONLY the entries added during this call.
			const errorsFrom = errors.length;
			queue.push(...jobs.map(job => ({ job, requeues: 0 })));
			grow();   // size from the SHARED worker budget (see the budget block)
			return new Promise<void>((resolve, reject) => {
				running = { resolve, reject };
				dispatch();
			}).then(() => ({ errors: errors.slice(errorsFrom) }));
		},
		dispose(): void {
			disposed = true;
			for (const slot of slots) { try { slot.worker?.terminate(); } catch { /* gone */ } slot.worker = null; }
			slots.length = 0;
			releaseBudget();
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
			releaseBudget();
			// Pending runJobs promise rejects; nothing is requeued (Stop semantics).
			const r = running;
			running = null;
			r?.reject(new Error('globalsim pool aborted'));
		},
		size(): number { return slots.length; },
	};
}
