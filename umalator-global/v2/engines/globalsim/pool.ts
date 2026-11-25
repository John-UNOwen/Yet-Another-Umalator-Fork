/**
 * GlobalSim worker pool + seed scheduler (Phase 4, §4.1, decision D2).
 *
 * N Web Workers, each holding one globalsim-wasm instance. Jobs are
 * (setup, ≤CHUNK seeds) chunks; every completed chunk streams its compact
 * per-seed records back through onChunk, so aggregates grow while the run
 * proceeds.
 *
 * ## Preparation affinity (§H: per-worker LRU, key-affine scheduling)
 *
 * Each worker keeps a small LRU of prepared races keyed by setupKey
 * ("roster/skills/course/gate"; cap: workerCore PREPARED_LRU) and reports
 * the held keys on every `prepared` reply, which the slot mirrors in
 * `held`. A job for a held key runs bare (no prepare round-trip); dispatch
 * prefers, for each idle worker, a queued job matching ANY held key (most
 * recent first), so a worker never re-prepares while a gate block it can
 * run bare is still queued — a seed batch that reuses setups (bandit
 * rungs, chart rounds) lands on the workers that already hold them, and a
 * cold prepare happens only when the whole queue misses the LRU. Callers
 * keep the blocks contiguous by feeding jobs grouped by setupKey (the
 * compare facade, the chart per-skill groups, the optimizer's sorted
 * ensure-batch).
 *
 * ## Adaptive lane sizing (handoff D2, floor-aware for the gpu lane)
 *
 * Every slot measures its own chunk cost from the worker-reported runMs. A CPU
 * lane's chunk stays the caller's job shape (25 seeds). A gpu launch pays a
 * whole device pass whatever its width, so the gpu lane is sized from a cost
 * model instead of its measured rate: rate × 500 ms starved the lane, because
 * a narrow launch mostly measures the fixed pass and the next rate shrank the
 * chunk again. The pool records (seeds, runMs) per gpu chunk, fits
 * cost = floor + slope × seeds from two measured chunks, and then sizes each
 * chunk for gpuLaunchTargetMs. A slow lane is judged on the projected rate of
 * the width it would actually take (gpuTakeWidth) against GPU_DEGRADE_RATIO of
 * the best CPU lane, so a lane whose floor alone dwarfs the target retires as
 * well as one whose marginal cost is too high. An unmeasured gpu lane waits
 * until the measured CPU lanes' projection for the queued work exceeds
 * GPU_PROBE_GUARD_MS, then takes ONE job as its floor probe. Its second chunk
 * is sized from the first probe and the CPU lanes' measured per-race cost, so
 * it stays near the target even before the slope is known.
 *
 * The gpu lane rides on top of the cpu pool (gpuExtraLane, default on): a mixed
 * pool keeps the full `threads` cpu workers and runs one slot more for the
 * device, so the lane never replaces a cpu lane, and no cpu core is reserved
 * for it. A fitted lane only takes a chunk it can finish inside the CPU lanes'
 * projected drain (GPU_DRAIN_SLACK), so a pass the batch cannot afford waits
 * instead of straggling. The fit is shared process-wide: a pool whose device a
 * sibling already fitted starts at a chunk width instead of paying the probe
 * pair again. gpuHostReserve and the cpu-worker throttle are the old sizing
 * (gpuExtraLane false). An all-gpu pool is homogeneous: it always merges to
 * the cap (the device pass dominates).
 *
 * ## Cross-setup packing (gpu group lane)
 *
 * A gpu launch pays a device pass whatever its width, so one launch carrying
 * many setup keys' seeds is cheaper than one launch per key (the app compare
 * view has 18 setup keys of 44 to 72 seeds on a 500-sample run). When a gpu
 * worker reports the multi-preparation entry (`prepared.multi`, from
 * gpuRunCompactGroups), a dispatch gathers queued compact jobs of OTHER setup
 * keys into the same run message: one part per job, requests and fold options
 * included. Compatibility is what the launch itself needs: one runner count
 * (the kernel grid), one course (only the head's setup was prepared, so only
 * its geometry is registered), one frame-row mode (second player or not) and
 * compact records. Mixed skill-table buckets stay safe: the engine launches
 * each bucket pair as its own run inside the one call. The reply is split
 * back to the parts POSITIONALLY, because different setup keys can carry the
 * same seed values (the compare variants do), so a seed-keyed split would
 * misattribute records. The fitted cost model sizes the chunk whatever keys
 * it packs: an all-gpu pool packs to gpuBatchSeeds, a mixed-pool gpu lane to
 * the width whose predicted cost is the launch target. A worker without the
 * entry keeps the old single-preparation merge.

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
	// Memory does grow with worker count, just far less than it did: a busy worker holds
	// ≈19 MB of wasm heap (module + geometry + a full PREPARED_LRU of 10 ≈1.1 MB preparations,
	// workerCore.ts; ≈17 MB measured at the old LRU of 8), ≈285 MB at 15 workers and ≈610 MB
	// at 32 — none of it counted in the
	// optimizer's CACHE_CAP_BYTES. The old "cap at 6" (renderer Out of Memory at 8 workers on
	// the ~120 MB/worker baseline field) is gone with that baseline; dial it back in Advanced
	// if a machine still runs out of memory.

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

/**
 * A Worker 'error' event carries the reason in `message`, and SimWorker passes a
 * plain string. The pool used to drop both, so a 401 from the local sim server
 * reached the user as "worker crashed".
 */
function workerErrorReason(e: unknown): string {
	if (typeof e === 'string' && e) return e;
	const m = (e as { message?: unknown } | null)?.message;
	return typeof m === 'string' && m ? m : 'worker crashed';
}

export interface WorkerLike {
	postMessage(msg: unknown): void;
	addEventListener(type: 'message', cb: (e: { data: any }) => void): void;
	addEventListener(type: 'error', cb: (e: unknown) => void): void;
	terminate(): void;
	/**
	 * Optional: hand an idle session back for the next pool instead of closing
	 * it. A pool calls this only at dispose, never on abort or a failure.
	 */
	retain?(): void;
	/**
	 * Optional: resolves once the worker can name its backend (the sim-server
	 * session opened and reported it). Dispatch holds an unready worker back so
	 * the first chunk is sized with the lane known. A worker without it is
	 * ready immediately.
	 */
	ready?: Promise<void>;
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
	/** Optional: course length, forwarded to the prepare message (workerCore PrepareMsg.distance). */
	distance?: number;
	/** Per-seed gate for a gate-batched build: the request is the gate-0 field
	 *  and the worker runs each seed at its own gate from one preparation. */
	gates?: number[];
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
	/**
	 * CPU rerun lane for compact records a sim-server gpu session answered with
	 * {seed, gpuFallback} (handoff step 5): the pool re-runs those seeds on ONE
	 * worker built here before onChunk sees the chunk. The caller picks the CPU
	 * backend (native first, else wasm). Without it, fallback records are
	 * delivered as {seed, error}.
	 */
	cpuFactory?: WorkerFactory;
	/**
	 * Seed cap for a merged chunk (handoff D1/D2): queued chunks of the SAME
	 * setupKey are merged into ONE run message for a lane, because a wide
	 * launch is far cheaper per seed than a narrow one (a gpu launch pays a
	 * whole device pass per call, and a CPU lane pays its per-message reply
	 * decode). The cap bounds one message; a mixed-pool gpu lane's target is
	 * the width whose fitted cost is gpuLaunchTargetMs. 0 disables merging.
	 */
	gpuBatchSeeds?: number;
	/**
	 * Adaptive per-lane work sizing (handoff D2). Default on. A gpu lane fits
	 * cost = floor + slope × seeds from its measured chunks and sizes each
	 * chunk for gpuLaunchTargetMs; in a mixed pool it may only take work when
	 * that projected rate pays for the device pass, so a slow or absent gpu
	 * lane degrades to the CPU lanes instead of becoming the straggler. CPU
	 * lanes keep the caller's one-job chunks. False restores the fixed
	 * one-job-chunk scheduling (plus the gpu merge).
	 */
	adaptiveSizing?: boolean;
	/** Target wall of one gpu lane launch, ms. Default 3000. */
	gpuLaunchTargetMs?: number;
	/**
	 * The gpu lane rides on top of the cpu pool (default true): cpu workers
	 * keep the full `threads` count and a mixed pool runs one slot more.
	 * False restores the old sizing where the gpu slot is one of `threads`
	 * and a busy gpu lane throttles the cpu pool by gpuHostReserve cores.
	 */
	gpuExtraLane?: boolean;
	/**
	 * Legacy sizing only (gpuExtraLane false): cores kept out of the cpu
	 * worker count while a gpu lane carries work. Default 1.
	 */
	gpuHostReserve?: number;
	/**
	 * A factory for the extra gpu lane when the caller can name one (the local
	 * server advertises a gpu backend, the bench pins one). `factory` then
	 * stays the cpu lanes' source, and the pool creates the gpu slot only once
	 * the batch can pay for a launch, so a run that stays all-CPU never boots
	 * the session. Omit it to let any `factory` worker report the gpu backend.
	 */
	gpuFactory?: WorkerFactory;
	/**
	 * When a gpu lane may start. 'auto' (default) and 'eager' share one gate:
	 * the lane opens once the measured CPU projection can cover its session
	 * open, one host pass and the smallest useful chunk. 'eager' is kept for
	 * callers that name their intent (the skill chart, the optimizer). 'off'
	 * never adds one.
	 */
	gpuLane?: 'auto' | 'eager' | 'off';
}

/**
 * Process-wide gpu cost model: the newest fitted floor+slope from any pool in
 * this process. A fresh pool's gpu lane reads it to skip its 4.5 s probe pair
 * and to decide whether its shape pays at all, every later fit replaces it.
 */
let sharedGpuFit: { floor: number; slope: number } | null = null;
/** Measured session open (device, kernel build, first request). A lane with no
 *  chunks pays it before its first launch, so the startup probe or a cold
 *  lane's own first chunk reports it here. */
let sharedGpuOpenMs: number | null = null;

/**
 * Feed the server's startup measurement into every pool in this process: the
 * warm launch floor and slope, and what a fresh session costs before its first
 * launch. The gate can then size a first chunk on a cold lane instead of
 * trusting the old startup prior.
 */
export function setGpuCostModel(model: { floor: number; slope: number; openMs?: number | null } | null): void {
	const usable = model != null && Number.isFinite(model.floor) && Number.isFinite(model.slope) && model.floor >= 0 && model.slope >= 0;
	sharedGpuFit = usable ? { floor: model!.floor, slope: model!.slope } : null;
	if (model && typeof model.openMs === 'number' && Number.isFinite(model.openMs) && model.openMs >= 0) {
		sharedGpuOpenMs = model.openMs;
	}
}

/** Test seam: clear the process-wide gpu model (tests script their own). */
export function __testResetGpuFit(): void { sharedGpuFit = null; sharedGpuOpenMs = null; }
/** Test seam: script the process-wide warm gpu fit. */
export function __testSetGpuFit(fit: { floor: number; slope: number } | null): void { setGpuCostModel(fit); }
/** Test seam: read the process-wide warm gpu fit. */
export function __testGetGpuFit(): { floor: number; slope: number } | null { return sharedGpuFit; }

/**
 * Default seed cap for a merged chunk. Measured on the B580 (app field, locals
 * 8, one frame row): 1,024 seeds answer 464 races/s, 1,536 give 627 and 2,048
 * peak at 730 (1.57x the 1,024 rate), then 3,072 falls to 702, 4,096 to 614
 * and the 11,540-seed memory cap to 406. The cap sits on the measured peak.
 */
export const DEFAULT_GPU_BATCH_SEEDS = 2048;

/**
 * Adaptive sizing: the launch wall a gpu lane's chunk is sized for (ms).
 * The measured app compare field costs about 1.8 s of fixed pass plus
 * 1.3 ms per race, so 3,000 ms is about 900 races. A higher target amortizes
 * the pass better. Lower cuts the mixed pool's straggler tail: the batch
 * cannot finish before this lane's last launch does.
 */
export const DEFAULT_GPU_LAUNCH_TARGET_MS = 3000;
/** Cost priors for a gpu lane with no measured warm chunk yet, ms. A session's
 *  first launch pays the engine load, the OpenCL program build and one skill
 *  table parse per packed request (the engine repeats that parse today, about
 *  4.2 s of fixed cost measured for a packed first chunk). Every launch then
 *  pays the host pass plus the kernel (about 900 ms of host work and about 1.37
 *  ms per race at the throughput peak). */
export const GPU_STARTUP_PRIOR_MS = 4200;
export const GPU_FLOOR_PRIOR_MS = 900;
export const GPU_SLOPE_PRIOR_MS_PER_RACE = 1.5;
/** Smallest chunk: one DEFAULT_CHUNK_SIZE job. A lane that would ask for less
 *  keeps one job per run (its rate is below the sizing floor). */
export const MIN_CHUNK_SEEDS = 25;
/** Fixed cost the drain of a batch must cover before the lane opens: session
 *  open, one host pass and the smallest useful chunk. */
export const GPU_LANE_PAY_MS =
	GPU_STARTUP_PRIOR_MS + GPU_FLOOR_PRIOR_MS + MIN_CHUNK_SEEDS * GPU_SLOPE_PRIOR_MS_PER_RACE;
/** A mixed pool holds a gpu lane back until the measured CPU lanes' projection
 *  for the remaining queue can pay for a cold launch, then lets it take one
 *  chunk. Measured startup is about 2 s, so a shorter projection would make the
 *  first launch the straggler. */
export const GPU_PROBE_GUARD_MS = 6000;
/** A gpu lane sizes its chunk to finish inside this fraction of the CPU lanes'
 *  projected drain, so the device pass never outlives the cpu pool. */
export const GPU_DRAIN_SLACK = 0.85;

/** A fitted gpu lane whose chunk rate is below this fraction of the best
 *  non-gpu lane is left idle: at that rate it delays the CPU lanes instead of
 *  helping. Judged on the width it would actually take, so a floor that dwarfs
 *  the drain retires the lane the same way a high slope does. */
export const GPU_DEGRADE_RATIO = 0.75;

export interface GlobalsimPool {
	/**
	 * Run one batch; resolves when it drains. `errors` carries ONLY this
	 * batch's job errors — a second runJobs on the same pool never
	 * re-reports an earlier batch's (chart.ts concatenates each result).
	 * `gpuFallbacks` carries ONLY this batch's per-job gpu rerun tallies
	 * (handoff step 5): one entry per job whose compact chunk carried
	 * {seed, gpuFallback} refusals, counted by the kernel's reason. A job
	 * the gpu lane never refused (or an all-CPU run) has no entry.
	 */
	runJobs(jobs: PoolJob[]): Promise<{ errors: Array<{ jobId: string; error: string }>; gpuFallbacks: GpuFallbackTally[] }>;
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
	/**
	 * §H timing ledger (accumulated across batches): worker-measured prepare
	 * and run ms. prepareMs times PreparedRace construction (the engine
	 * prepare), runMs the per-seed run loop (engine + reply parse). The
	 * §H acceptance is prepareMs < 10% of runMs on a real-engine run;
	 * workers that do not report timings simply add nothing.
	 */
	timing(): PoolTiming;
}

/**
 * Per-job gpu fallback tally (handoff step 5, "count and report them").
 * Created only for jobs whose compact chunk carried refusals, so the
 * common all-CPU / fallback-free-gpu path reports nothing.
 */
export interface GpuFallbackTally {
	jobId: string;
	/** Compact records the gpu lane answered for this job (refusals included). */
	races: number;
	/** Refused seeds, keyed by the kernel gate's gpuFallback reason string. */
	fallbacks: Record<string, number>;
	/** Refusals delivered as {seed, error}: the rerun lane failed or was absent. */
	rerunFailures: number;
}

export interface PoolTiming {
	/** Preparations built across all batches. */
	prepares: number;
	/** Worker-measured PreparedRace construction time (ms). */
	prepareMs: number;
	/** Completed run replies (a merged gpu reply counts once and delivers
	 *  every part). */
	chunks: number;
	/** Worker-measured run-loop time (ms), the prepare-share denominator. */
	runMs: number;
	/** Per-seed records streamed back on successful chunks. */
	records: number;
}

interface Queued { job: PoolJob; requeues: number }

/**
 * The pool's job queue. Dispatch wants "the first queued job for any key this
 * worker holds" on every chunk completion; a plain array answered that with a
 * findIndex per held key (O(held × queue) per completion, superlinear in the
 * batch). Here every job sits in a global FIFO and in its key's FIFO, both
 * lazily cleared, and requeued chunks sit in a small `front` list served
 * first — the same order the array gave (requeue unshift, then queue order),
 * at amortized O(held) per take.
 */
interface QEntry { q: Queued; taken: boolean }
class JobQueue {
	private all: QEntry[] = [];
	private head = 0;
	private byKey = new Map<string, { items: QEntry[]; head: number }>();
	private front: QEntry[] = [];
	private n = 0;
	private seedsN = 0;
	get length(): number { return this.n; }
	/** Seeds still queued (the gpu probe projection reads this). */
	get seedCount(): number { return this.seedsN; }
	push(q: Queued): void {
		const e: QEntry = { q, taken: false };
		this.all.push(e);
		let l = this.byKey.get(q.job.setupKey);
		if (!l) { l = { items: [], head: 0 }; this.byKey.set(q.job.setupKey, l); }
		l.items.push(e);
		this.n++;
		this.seedsN += q.job.seeds.length;
	}
	/** A requeued chunk goes ahead of everything (exactly one requeue, §4.1). */
	unshift(q: Queued): void {
		this.front.unshift({ q, taken: false });
		this.n++;
		this.seedsN += q.job.seeds.length;
	}
	private take(e: QEntry): Queued {
		e.taken = true;
		this.seedsN -= e.q.job.seeds.length;
		// Drained: drop the lazily-cleared arrays so finished jobs (and the
		// requests they reference) do not live on for the rest of the run.
		if (--this.n === 0) this.clear();
		return e.q;
	}
	/** First queued job for the first key in `held` (MRU order) that has one,
	 *  else the queue head; undefined when empty. */
	takeFor(held: readonly string[]): Queued | undefined {
		if (this.n === 0) return undefined;
		for (const key of held) {
			const fi = this.front.findIndex(e => e.q.job.setupKey === key);
			if (fi >= 0) return this.take(this.front.splice(fi, 1)[0]);
			const l = this.byKey.get(key);
			if (!l) continue;
			while (l.head < l.items.length && l.items[l.head].taken) l.head++;
			if (l.head < l.items.length) return this.take(l.items[l.head++]);
			this.byKey.delete(key);
		}
		if (this.front.length) return this.take(this.front.shift()!);
		while (this.head < this.all.length && this.all[this.head].taken) this.head++;
		if (this.head < this.all.length) return this.take(this.all[this.head++]);
		return undefined;
	}
	/** First queued job for `key` satisfying pred (front first, then the key's
	 *  FIFO), leaving non-matching entries queued. Used by the gpu batch lane
	 *  to gather extra chunks of one preparation. */
	takeMatching(key: string, pred: (q: Queued) => boolean): Queued | undefined {
		if (this.n === 0) return undefined;
		const fi = this.front.findIndex(e => e.q.job.setupKey === key && pred(e.q));
		if (fi >= 0) return this.take(this.front.splice(fi, 1)[0]);
		const l = this.byKey.get(key);
		if (!l) return undefined;
		for (let i = l.head; i < l.items.length; i++) {
			const e = l.items[i];
			if (!e.taken && pred(e.q)) return this.take(e);
		}
		return undefined;
	}
	/** First queued job anywhere satisfying pred (front first, then global FIFO),
	 *  leaving non-matching entries queued. Used by the gpu group lane to pack
	 *  compatible chunks of OTHER preparations into one run message. */
	takeMatchingAny(pred: (q: Queued) => boolean): Queued | undefined {
		if (this.n === 0) return undefined;
		const fi = this.front.findIndex(e => pred(e.q));
		if (fi >= 0) return this.take(this.front.splice(fi, 1)[0]);
		while (this.head < this.all.length && this.all[this.head].taken) this.head++;
		for (let i = this.head; i < this.all.length; i++) {
			const e = this.all[i];
			if (!e.taken && pred(e.q)) return this.take(e);
		}
		return undefined;
	}
	clear(): void {
		this.all = []; this.head = 0; this.byKey.clear(); this.front = []; this.n = 0; this.seedsN = 0;
	}
}

interface Slot {
	gen: number;                 // bumped on every worker (re)creation to ignore stale messages
	worker: WorkerLike | null;
	/** Created from `gpuFactory`: this is the extra lane from the moment it
	 *  exists, before the session opens and names its backend. */
	gpuLane?: boolean;
	/** False while the worker's optional `ready` promise is pending. Dispatch
	 *  skips the slot: the first chunk must know the lane's backend so a gpu
	 *  lane merges the queued same-setup chunks instead of paying one narrow
	 *  launch. */
	ready: boolean;
	/** §H: setupKeys the worker's preparation LRU holds, most-recently-used
	 *  first — mirrored from the worker's `prepared` replies. Empty until the
	 *  first successful prepare; reset whenever the worker is (re)created. */
	held: string[];
	/** Measured lane throughput in seeds/ms (EWMA of records/runMs), 0 until
	 *  the first completed chunk. The gpu cost fit and the degradation check
	 *  read (seeds, ms) samples instead. */
	rate: number;
	/** Completed chunk costs on a gpu lane: (seeds, worker-reported runMs).
	 *  The floor-aware sizing fits cost = floor + slope × seeds from them. */
	costSamples: Array<{ seeds: number; ms: number }>;
	/** The worker's session was already opened and warmed before this pool took
	 *  it, so its first chunk is a normal sample and pays no startup cost. */
	openPaid: boolean;
	/** The backend answers a whole multi-preparation chunk in one call (the gpu
	 *  group lane). Mirrored from the worker's `prepared` reply; the pool only
	 *  packs different setup keys into one run message when this is true. */
	multi: boolean;
	/** The worker answers a cold `run` carrying its request in one message
	 *  (workerCore's inline prepare). Mirrored from `prepared`. False keeps the
	 *  two-step prepare then run flow, which scripted test workers rely on. */
	pipelined: boolean;
	inflight: Queued | null;
	/** The pipelined second job (pipelined CPU workers only): its message is
	 *  already inside the worker while the in-flight job runs. */
	second: Queued | null;
	/** Queued jobs merged into the in-flight run message (gpu batch lane,
	 *  handoff D1). Null for the ordinary one-job chunk. */
	parts: Queued[] | null;
	/** The in-flight run message carries `parts` (one part per job), so its
	 *  reply has to be split back to the parts positionally, not by seed. */
	multiRun: boolean;
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
	const gpuBatchSeeds = Math.max(0, Math.floor(opts.gpuBatchSeeds ?? DEFAULT_GPU_BATCH_SEEDS));
	const queue = new JobQueue();
	const slots: Slot[] = [];
	const errors: Array<{ jobId: string; error: string }> = [];
	// Per-job gpu fallback tallies (handoff step 5), sliced per batch like errors.
	const gpuTallies: GpuFallbackTally[] = [];
	let running: { resolve: () => void; reject: (e: Error) => void } | null = null;
	let disposed = false;
	let aborted = false;
	// §H: worker-reported timing ledger (see GlobalsimPool.timing).
	const timingLedger: PoolTiming = { prepares: 0, prepareMs: 0, chunks: 0, runMs: 0, records: 0 };

	// ── adaptive per-lane sizing (handoff D2) ──────────────────────────────────
	const adaptiveSizing = opts.adaptiveSizing !== false;
	const gpuLaunchTargetMs = Math.max(500, opts.gpuLaunchTargetMs ?? DEFAULT_GPU_LAUNCH_TARGET_MS);
	const gpuExtraLane = opts.gpuExtraLane !== false;
	const gpuFactory = opts.gpuFactory;
	const gpuLaneMode = opts.gpuLane ?? 'auto';
	const gpuHostReserve = Math.max(0, Math.floor(opts.gpuHostReserve ?? 1));
	/** SimWorker mirrors the sim-server backend onto the worker. */
	const backendOf = (slot: Slot): string | undefined =>
		(slot.worker as { backend?: unknown } | null)?.backend as string | undefined;
	const isGpuLane = (slot: Slot): boolean => slot.gpuLane === true || backendOf(slot) === 'gpu';
	const nonGpuRateSum = (): number => {
		let sum = 0;
		for (const s of slots) if (!isGpuLane(s) && s.rate > 0) sum += s.rate;
		return sum;
	};
	/** Projected CPU-lane wall for the queued seeds: the measured average lane
	 *  rate extended to every non-gpu slot. Using only the measured lanes would
	 *  treat the pool as one lane until the others report, which opens the gpu
	 *  probe gate far too early on a wide CPU pool. */
	const projectedCpuMs = (): number => {
		let measured = 0, nonGpu = 0;
		for (const s of slots) {
			if (isGpuLane(s)) continue;
			nonGpu++;
			if (s.rate > 0) measured++;
		}
		if (measured === 0 || nonGpu === 0) return 0;
		const avg = nonGpuRateSum() / measured;
		return queue.seedCount / (avg * nonGpu);
	};
	/** Every live slot reports the gpu backend: one lane class, so the widest
	 *  chunk is always the cheapest per seed (the device pass dominates). */
	const homogeneousGpu = (): boolean => slots.length > 0 && slots.every(isGpuLane);

	/** Fit cost = floor + slope × seeds over a gpu lane's measured chunks.
	 *  Null until two chunks exist. Ordinary least squares: two chunks define
	 *  the model, later chunks average the engine's integer launch-slice steps.
	 *  Clamped non-negative, a noisy fit must never ask for a negative pass. */
	function fitGpuCost(samples: ReadonlyArray<{ seeds: number; ms: number }>): { floor: number; slope: number } | null {
		const n = samples.length;
		if (n < 2) return null;
		let sx = 0, sy = 0, sxx = 0, sxy = 0;
		for (const s of samples) {
			sx += s.seeds;
			sy += s.ms;
			sxx += s.seeds * s.seeds;
			sxy += s.seeds * s.ms;
		}
		const den = n * sxx - sx * sx;
		if (!(den > 0)) return null;
		const slope = (n * sxy - sx * sy) / den;
		const floor = (sy - slope * sx) / n;
		return { floor: Math.max(0, floor), slope: Math.max(0, slope) };
	}

	/** The lane's warm cost model: its own two-plus measured warm chunks, else
	 *  the model another pool in this process already fitted. A session's first
	 *  chunk also pays the session open, so it only serves as the startup
	 *  sample and never enters the fit. A lane that was handed over warm has no
	 *  such sample, so every chunk counts. */
	function warmSamples(slot: Slot): ReadonlyArray<{ seeds: number; ms: number }> {
		return slot.openPaid ? slot.costSamples : slot.costSamples.slice(1);
	}
	function gpuFitOf(slot: Slot): { floor: number; slope: number } | null {
		return fitGpuCost(warmSamples(slot)) ?? sharedGpuFit;
	}
	/** What a lane with no measured launch still pays before its first chunk:
	 *  the measured session open when one exists, else the conservative prior. */
	function coldOpenMs(): number {
		return sharedGpuOpenMs ?? GPU_STARTUP_PRIOR_MS;
	}

	/** Seeds whose launch is projected to take `budgetMs`: the fitted model when
	 *  the lane or the process has one, else the priors. A cold lane must also
	 *  pay the session startup out of that budget. Zero says the budget cannot
	 *  pay for a launch. */
	function gpuWidthFor(slot: Slot, budgetMs: number): number {
		const fit = gpuFitOf(slot);
		if (fit) {
			if (!(fit.slope > 0) || budgetMs <= fit.floor) return 0;
			return Math.max(MIN_CHUNK_SEEDS, Math.min(gpuBatchSeeds, Math.round((budgetMs - fit.floor) / fit.slope)));
		}
		const cold = slot.costSamples.length === 0 && !slot.openPaid ? coldOpenMs() : 0;
		const room = budgetMs - cold - GPU_FLOOR_PRIOR_MS;
		if (room < MIN_CHUNK_SEEDS * GPU_SLOPE_PRIOR_MS_PER_RACE) return 0;
		return Math.max(MIN_CHUNK_SEEDS, Math.min(gpuBatchSeeds, Math.round(room / GPU_SLOPE_PRIOR_MS_PER_RACE)));
	}

	/** Width this lane may take now: the CPU lanes' projected drain caps the
	 *  budget, so the device pass ends with the cpu pool instead of after it.
	 *  The session open is the gate's business (lanePayMs), not the launch. */
	function gpuTakeWidth(slot: Slot): number {
		const drain = projectedCpuMs();
		if (!(drain > 0)) return 0;
		if (!gpuFitOf(slot)) {
			// No model yet: the priors already carry the startup prior.
			return gpuWidthFor(slot, Math.min(gpuLaunchTargetMs + coldOpenMs(), drain * GPU_DRAIN_SLACK));
		}
		return gpuWidthFor(slot, Math.min(gpuLaunchTargetMs, drain * GPU_DRAIN_SLACK));
	}

	/** Fixed cost a batch's projected drain must cover before the lane opens:
	 *  the session open minus a warm handover, one host pass and the smallest
	 *  useful chunk. The startup probe's model replaces the old priors. */
	function lanePayMs(): number {
		const fit = sharedGpuFit;
		const open = coldOpenMs();
		const floor = fit ? fit.floor : GPU_FLOOR_PRIOR_MS;
		const slope = fit ? fit.slope : GPU_SLOPE_PRIOR_MS_PER_RACE;
		return open + floor + MIN_CHUNK_SEEDS * slope;
	}

	/** A fitted gpu lane's projected rate for the chunk it would take next,
	 *  against one CPU thread. The lane is extra work on the same CPU (its host
	 *  side plus the server), so it is only worth running while it beats the
	 *  thread it costs. Null until a model exists. */
	const gpuDegraded = (slot: Slot): boolean => {
		let lanes = 0;
		for (const s of slots) if (!isGpuLane(s)) lanes++;
		const perThread = lanes > 0 ? nonGpuRateSum() / lanes : 0;
		if (!(perThread > 0)) return false;
		const fit = gpuFitOf(slot);
		if (!fit) return false;
		const width = gpuTakeWidth(slot);
		if (!(width > 0)) return false;
		const ms = fit.floor + fit.slope * width;
		if (!(ms > 0)) return false;
		return width / ms < GPU_DEGRADE_RATIO * perThread;
	};
	/** Legacy sizing only: while a gpu lane carries work, gpuHostReserve cores
	 *  stay free of the CPU pool for its host side. */
	const effectiveThreads = (): number =>
		Math.max(1, threads - (slots.some(s => isGpuLane(s) && s.costSamples.length > 0 && !gpuDegraded(s)) ? gpuHostReserve : 0));
	/** Logical CPUs, from the one field both runtimes expose. */
	const logicalCpus = (): number => {
		const hc = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency;
		return typeof hc === 'number' && hc > 0 ? hc : 0;
	};
	/** Additive sizing: the gpu lane is the mixed pool's extra slot while a core
	 *  is free. Its host side (prepare, decode) and the sim server share the
	 *  machine, so the lane fits inside cores - 1: on top when the caller left
	 *  room, otherwise it takes one of the budgeted slots. A pure gpu pool has
	 *  no extra slot. */
	const slotCap = (): number => {
		if (!(gpuExtraLane && slots.some(isGpuLane) && !homogeneousGpu())) return effectiveThreads();
		const cores = logicalCpus();
		if (!(cores > 1)) return threads + 1;
		const native = Math.min(threads, cores - 1);
		const free = native < cores - 1;
		return Math.max(1, native + (free ? 1 : 0));
	};

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
		const i = slots.findIndex(s => !s.inflight && !s.second);
		if (i < 0) return false;
		const s = slots[i];
		try { s.worker?.terminate(); } catch { /* already gone */ }
		s.worker = null;
		slots.splice(i, 1);
		held--;
		budgetReleaseNoPump();
		return true;
	}

	/** Grow toward min(slotCap, queued work), taking permits from the shared
	 *  budget: sync while capacity is free (fast path — identical to the
	 *  historical eager creation), then a guaranteed first slot, then FIFO waits
	 *  with idle-reclaim from other pools. */
	function grow(): void {
		if (disposed || aborted) return;
		// The mixed pool's gpu slot is one permit past the cpu budget, the shared
		// cap learns about it only once such a slot exists, so a CPU-only pool
		// never lifts the cap other pools share.
		if (gpuExtraLane) budgetRaiseCapacity(slotCap());
		const target = Math.min(slotCap(), Math.max(1, queue.length));
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
				if (slots.length >= slotCap() || queue.length === 0) { held--; budgetRelease(1); return; }
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
		const slot: Slot = { gen: 0, worker: null, ready: false, held: [], rate: 0, costSamples: [], openPaid: false, multi: false, inflight: null, parts: null, multiRun: false, expecting: null };
		attachWorker(slot);
		slots.push(slot);
		return slot;
	}

	/** The extra gpu lane, created from `gpuFactory` on demand. Its host side
	 *  shares the CPU, so starting it also trims the cpu slots to the budget. */
	let gpuSlotStarted = false;
	function startGpuSlot(): void {
		if (disposed || aborted || gpuFactory == null || gpuLaneMode === 'off' || gpuSlotStarted) return;
		gpuSlotStarted = true;
		budgetRaiseCapacity(threads + 1);
		if (!budgetReserve(reclaimIdleSlot, false)) { gpuSlotStarted = false; return; }
		held++;
		const slot: Slot = { gen: 0, worker: null, ready: false, held: [], rate: 0, costSamples: [], openPaid: false, multi: false, inflight: null, parts: null, multiRun: false, expecting: null, gpuLane: true };
		attachWorker(slot, gpuFactory);
		// The factory is named for the gpu backend, so the chunk can be posted
		// before the session opens: the worker queues it and flushes on open.
		// Waiting for `ready` here would start the session's 2 s first-launch
		// cost only after the batch got short enough to refuse it.
		slot.ready = true;
		slots.push(slot);
		trimCpuSlotsForLane();
	}

	/** Decide whether the caller-named gpu lane starts now. The lane pays a
	 *  session open plus one host pass, so it opens only when the measured CPU
	 *  lanes' remaining projection covers lanePayMs(). 'auto' and 'eager' share
	 *  that gate: an eager lane on a batch too small to pay used to open the
	 *  session and then never run, which made high-thread pools slower. */
	function maybeStartGpuLane(): void {
		if (gpuFactory == null || gpuLaneMode === 'off' || gpuSlotStarted) return;
		if (!adaptiveSizing) { startGpuSlot(); return; }
		if (!(nonGpuRateSum() > 0)) return;   // no measured CPU rate yet: hold
		const drain = projectedCpuMs();
		if (!(drain * GPU_DRAIN_SLACK > lanePayMs())) return;
		startGpuSlot();
	}

	/** Seeds one run message should carry for this lane. CPU lanes keep the
	 *  caller's chunk shape: their per-chunk cost is small, and finer chunks
	 *  balance the tail better (measured: merging them to 75 seeds made a
	 *  1200-race CPU run 11% slower). A gpu lane's launch pays a whole device
	 *  pass, so a mixed-pool gpu lane sizes from a cost model (its own fitted
	 *  floor and slope, or the process-wide one from a pool that already paid
	 *  the probe pair) to finish with the CPU lanes. A cold lane runs its two
	 *  probes first. An all-gpu pool skips measuring: the widest chunk is
	 *  always cheapest there. */
	function chunkSeeds(slot: Slot): number {
		if (!isGpuLane(slot)) return 0;
		if (!adaptiveSizing) return gpuBatchSeeds;
		if (homogeneousGpu()) return gpuBatchSeeds;
		return gpuTakeWidth(slot);
	}

	/** May this lane take a chunk now? In a mixed pool a gpu lane must pay its
	 *  device pass: a fitted lane only takes work it can finish before the CPU
	 *  lanes drain, and one projected below GPU_DEGRADE_RATIO of the best CPU
	 *  lane stays idle. A cold lane waits for measured CPU throughput to
	 *  outlast one probe, then runs its probe pair. */
	function laneMayRun(slot: Slot): boolean {
		if (!adaptiveSizing || !isGpuLane(slot) || homogeneousGpu()) return true;
		if (!(nonGpuRateSum() > 0)) return false;   // no CPU throughput measured yet: hold
		if (!gpuFitOf(slot)) return gpuTakeWidth(slot) > 0;   // cold or warming up: the prior budget decides
		return !gpuDegraded(slot) && gpuTakeWidth(slot) > 0;
	}

	/** Release idle CPU workers while a gpu lane is carrying work, keeping
	 *  gpuHostReserve cores for its host side (prepare, decode). Runs only when
	 *  a gpu lane is actually used, so a degraded or absent gpu lane leaves the
	 *  full CPU pool running. */
	function reserveGpuHostCores(): void {
		if (!adaptiveSizing || gpuExtraLane || gpuHostReserve <= 0) return;
		const target = effectiveThreads();
		while (slots.length > target) {
			const i = slots.findIndex(s => !s.inflight && !s.second && !isGpuLane(s));
			if (i < 0) break;
			const s = slots[i];
			try { s.worker?.terminate(); } catch { /* already gone */ }
			s.worker = null;
			slots.splice(i, 1);
			held--;
			budgetRelease(1);
		}
	}

	/** The lane shares the thread budget, so once it exists the idle cpu slots
	 *  above the budget go back: a pool must never ask the OS for more threads
	 *  than it has. The lane keeps its own slot. */
	function trimCpuSlotsForLane(): void {
		if (!adaptiveSizing || !gpuExtraLane) return;
		const target = Math.max(1, slotCap() - 1);
		for (let i = slots.length - 1; i >= 0 && slots.filter(s => !isGpuLane(s)).length > target; i--) {
			if (isGpuLane(slots[i]) || slots[i].inflight) continue;
			const s = slots[i];
			try { s.worker?.terminate(); } catch { /* already gone */ }
			s.worker = null;
			slots.splice(i, 1);
			held--;
			budgetRelease(1);
		}
	}

	/** What a cross-preparation launch needs every packed part to agree on: the
	 *  kernel grid's one runner count, the one course whose geometry the worker
	 *  registered for this chunk (only the head's setup key was prepared), and
	 *  whether a second player row is kept (one frame-row count per launch).
	 *  Skill-table buckets are not pooled here: the engine launches each bucket
	 *  pair as its own run inside the one call, so a mix stays correct. */
	interface LaneClass { runners: number; course: number; second: boolean }
	function laneClassOf(job: PoolJob): LaneClass | null {
		if (job.mode !== 'compact') return null;
		const request = job.request as { horses?: unknown; courseId?: unknown } | null;
		if (!request || typeof request !== 'object' || !Array.isArray(request.horses)) return null;
		const raw = request.courseId;
		const course = typeof raw === 'number' ? raw
			: typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
		if (!Number.isFinite(course)) return null;
		return { runners: request.horses.length, course, second: job.secondPlayerIndex != null };
	}
	function compatibleWith(lane: LaneClass, job: PoolJob): boolean {
		const other = laneClassOf(job);
		return other != null && other.runners === lane.runners && other.course === lane.course && other.second === lane.second;
	}

	/** The run message for the slot's in-flight chunk. One part per gathered
	 *  job when the parts cannot ride one preparation's flat seed list; the
	 *  reply is then split back to the parts positionally. */
	function runMsg(slot: Slot): unknown {
		const parts = slot.parts ?? [slot.inflight!];
		const head = parts[0].job;
		const samePrep = parts.every(p => p.job.setupKey === head.setupKey && p.job.mode === head.mode && p.job.trackSkillId === head.trackSkillId);
		slot.multiRun = !samePrep;
		if (samePrep) {
			return {
				type: 'run', jobId: head.id, setupKey: head.setupKey,
				seeds: parts.length === 1 ? head.seeds : parts.flatMap(p => p.job.seeds),
				mode: head.mode,
				...(head.gates && parts.length === 1 ? { gates: head.gates } : {}),
			};
		}
		return {
			type: 'run', jobId: head.id, setupKey: head.setupKey, mode: head.mode,
			seeds: parts.flatMap(p => p.job.seeds),
			parts: parts.map(p => ({
				setupKey: p.job.setupKey,
				request: p.job.request,
				seeds: p.job.seeds,
				trackSkillId: p.job.trackSkillId,
				secondPlayerIndex: p.job.secondPlayerIndex,
				distance: p.job.distance,
			})),
		};
	}

	/** Fill `parts` up to the lane's chunk target: same-preparation jobs first
	 *  (one run message can always name one setupKey), then, when the worker
	 *  reports the group lane, compatible jobs of any other setup key. */
	function gatherParts(slot: Slot, head: Queued, parts: Queued[], target: number): void {
		let seeds = parts.reduce((n, part) => n + part.job.seeds.length, 0);
		while (seeds < target) {
			const more = queue.takeMatching(head.job.setupKey, q =>
				q.job.mode === head.job.mode && q.job.trackSkillId === head.job.trackSkillId);
			if (!more) break;
			parts.push(more);
			seeds += more.job.seeds.length;
		}
		if (!slot.multi) return;
		const lane = laneClassOf(head.job);
		if (!lane) return;
		while (seeds < target) {
			const more = queue.takeMatchingAny(q => compatibleWith(lane, q.job));
			if (!more) break;
			parts.push(more);
			seeds += more.job.seeds.length;
		}
	}

	/** Extra queued jobs this lane can answer in the SAME run message: same
	 *  preparation first, then compatible preparations when the lane supports
	 *  the group lane, gathered up to the lane's adaptive chunk target. Null
	 *  keeps the ordinary one-job chunk. */
	function batchParts(slot: Slot, head: Queued): Queued[] | null {
		// A gated job's seeds each name their own gate, so there is nothing to
		// gather: the job already carries the whole build's batch.
		if (head.job.gates) return null;
		const target = chunkSeeds(slot);
		if (!(target > head.job.seeds.length)) return null;
		const parts: Queued[] = [head];
		gatherParts(slot, head, parts, target);
		return parts.length > 1 ? parts : null;
	}

	/** A prepare reply just named the lane's group capability. Widen the first
	 *  chunk now, so a cold gpu lane's first launch already carries the whole
	 *  queued batch instead of one setup key. */
	function widenParts(slot: Slot): void {
		if (!slot.multi || !slot.inflight || slot.inflight.job.mode !== 'compact') return;
		const target = chunkSeeds(slot);
		if (!(target > 0)) return;
		const parts = slot.parts ?? [slot.inflight];
		gatherParts(slot, slot.inflight, parts, target);
		slot.parts = parts.length > 1 ? parts : null;
	}

	/** Deliver one completed run reply to its job(s). A multi-preparation
	 *  message is split positionally, because its parts may carry the same seed
	 *  values (the compare variants do). The one-preparation merge splits by
	 *  seed, its lists are disjoint. */
	function deliverChunk(parts: Queued[], records: any[], positional: boolean): void {
		if (parts.length === 1) { deliverPart(parts[0], records); return; }
		if (positional) {
			const total = parts.reduce((n, part) => n + part.job.seeds.length, 0);
			const buckets: any[][] = parts.map(() => []);
			let at = 0;
			let aligned = records.length === total;
			for (let i = 0; i < parts.length && aligned; i++) {
				for (const seed of parts[i].job.seeds) {
					const record = records[at++];
					if (!record || record.seed !== seed) { aligned = false; break; }
					buckets[i].push(record);
				}
			}
			if (aligned) { parts.forEach((part, i) => deliverPart(part, buckets[i])); return; }
			const seen = new Set<number>();
			let disjoint = true;
			for (const part of parts) for (const seed of part.job.seeds) {
				if (seen.has(seed)) { disjoint = false; break; }
				seen.add(seed);
			}
			if (disjoint) {
				console.warn(`[globalsim-pool] multi-preparation reply not in part order (${records.length} records for ${total} seeds); splitting by seed`);
				deliverChunkBySeed(parts, records);
				return;
			}
			console.warn('[globalsim-pool] multi-preparation reply did not line up with the job seed lists; reporting per-seed errors');
			for (const part of parts) deliverPart(part, part.job.seeds.map(seed => ({ seed, error: 'multi-preparation chunk reply did not line up with the job seed lists' })));
			return;
		}
		deliverChunkBySeed(parts, records);
	}

	function deliverChunkBySeed(parts: Queued[], records: any[]): void {
		const owner = new Map<number, number>();
		parts.forEach((p, i) => { for (const s of p.job.seeds) owner.set(s, i); });
		const buckets: any[][] = parts.map(() => []);
		let stray = 0;
		for (const r of records) {
			if (r && owner.has(r.seed)) buckets[owner.get(r.seed)!].push(r);
			else stray++;
		}
		if (stray) console.warn(`[globalsim-pool] merged gpu chunk carried ${stray} record(s) for seeds no part asked for`);
		parts.forEach((p, i) => deliverPart(p, buckets[i]));
	}

	function deliverPart(part: Queued, records: any[]): void {
		// Chunk merge seam: a {seed, gpuFallback} record means the GPU lane refused
		// that seed, whether one batched run_compact_batch chunk or a per-seed chunk
		// answered it. The rerun lane replaces it before onChunk.
		if (part.job.mode === 'compact' && hasGpuFallback(records)) rerunGpuFallback(part.job, records);
		else opts.onChunk?.(part.job, records);
	}

	function attachWorker(slot: Slot, factory: WorkerFactory = opts.factory): void {
		slot.gen++;
		const gen = slot.gen;
		slot.worker = factory();
		slot.ready = slot.worker.ready == null;
		slot.held = [];
		slot.rate = 0;
		slot.costSamples = [];
		// A warm handover (a prewarmed or reused session) already paid its open.
		slot.openPaid = (slot.worker as { warm?: boolean }).warm === true;
		slot.multi = false;
		slot.pipelined = false;
		slot.multiRun = false;
		slot.second = null;
		slot.expecting = null;
		if (opts.skillData !== undefined) slot.worker.postMessage({ type: 'skillData', skillData: opts.skillData });
		slot.worker.addEventListener('message', (e: { data: any }) => { if (!disposed && !aborted && slot.gen === gen) onWorkerMessage(slot, e.data); });
		// A crashed worker (OOM / uncaught throw / wasm trap the runtime kills
		// the thread for) lands here — same recovery path as an engine panic.
		slot.worker.addEventListener('error', (e) => { if (!disposed && !aborted && slot.gen === gen) failWorker(slot, workerErrorReason(e)); });
		if (slot.worker.ready) {
			// A rejected ready means the worker failed to open; its error event
			// drives recovery, so dispatch it like a ready one and let that path
			// report the chunk error.
			void slot.worker.ready.then(
				() => { if (!disposed && !aborted && slot.gen === gen) { slot.ready = true; dispatch(); } },
				() => { if (!disposed && !aborted && slot.gen === gen) { slot.ready = true; dispatch(); } },
			);
		}
	}

	function failWorker(slot: Slot, reason: string): void {
		const failed = slot.inflight;
		const second = slot.second;
		// A merged gpu chunk requeues per part: each part keeps its own
		// requeue count, so one bad pass errors out jobs one by one.
		const failedParts = slot.parts ?? (failed ? [failed] : null);
		slot.inflight = null;
		slot.second = null;
		slot.parts = null;
		slot.expecting = null;
		try { slot.worker?.terminate(); } catch { /* already gone */ }
		slot.worker = null;
		slot.held = [];   // a recreated worker holds no preparations
		if (failedParts) {
			for (const part of failedParts) {
				if (part.requeues >= 1) {
					// Second failure of the same chunk → job error (§4.1).
					errors.push({ jobId: part.job.id, error: reason });
					opts.onJobError?.(part.job, reason);
				} else {
					part.requeues++;
					queue.unshift(part);   // exactly one requeue of the in-flight chunk
				}
			}
		}
		// The pipelined second job never answered: same requeue rule.
		if (second) {
			if (second.requeues >= 1) {
				errors.push({ jobId: second.job.id, error: reason });
				opts.onJobError?.(second.job, reason);
			} else {
				second.requeues++;
				queue.unshift(second);
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
				// Mirror the worker's preparation LRU (§H). A worker that does
				// not report `held` (older core, scripted fakes) is modelled as
				// holding only what it just prepared — single-preparation
				// semantics, the conservative reading.
				slot.held = Array.isArray(data.held) ? data.held.slice() : [job.setupKey];
				// The group lane's capability arrives with the first prepare of
				// a fresh worker: widen this chunk before it goes out.
				slot.multi = data.multi === true;
				slot.pipelined = data.pipelined === true;
				if (typeof data.prepareMs === 'number' && Number.isFinite(data.prepareMs)) {
					timingLedger.prepares++;
					timingLedger.prepareMs += data.prepareMs;
				}
				widenParts(slot);
				slot.expecting = 'chunk';
				slot.worker!.postMessage(runMsg(slot));
				// A pipelined worker can take its next job now, behind this run.
				dispatch();
			} else if (data.dead === true) {
				failWorker(slot, `prepare failed (dead): ${data.error}`);
			} else {
				// Input-level prepare failure — a retry would fail identically.
				// The whole merged batch shares this one prepare: every part
				// reports it, so no gathered job vanishes without an error.
				const msg = `prepare failed: ${data.error}`;
				const failedParts = slot.parts ?? [slot.inflight!];
				slot.inflight = null;
				slot.parts = null;
				// Mirror the failure response too: the LRU core keeps the
				// OTHER preparations (it only drops the re-prepared key), and
				// a core that reports no `held` is modelled the conservative
				// old way (a failed prepare may have left NO preparation) —
				// clearing here is what stops dispatch bare-running a stale
				// key into a "no preparation" failure, forever.
				slot.held = Array.isArray(data.held) ? data.held.slice() : [];
				for (const part of failedParts) {
					errors.push({ jobId: part.job.id, error: msg });
					opts.onJobError?.(part.job, msg);
				}
				dispatch();
			}
			return;
		}
		if (data.type === 'chunk') {
			// Two jobs may be in flight on a pipelined CPU worker: match the reply
			// by jobId, and a completed first chunk promotes the second one.
			const first = slot.inflight;
			const isFirst = first != null && data.jobId === first.job.id;
			const isSecond = !isFirst && slot.second != null && data.jobId === slot.second.job.id;
			if (!isFirst && !isSecond) return;
			if (isFirst && slot.expecting !== 'chunk') return;
			if (isFirst) slot.expecting = null;
			const queued = (isFirst ? first : slot.second)!;
			const parts = isFirst ? (slot.parts ?? [queued]) : [queued];
			const positional = isFirst ? slot.multiRun : false;
			if (data.ok === true) {
				// A pipelined cold job's chunk carries what the separate prepare
				// reply used to: the worker's held keys, its multi capability and
				// the prepare time.
				if (Array.isArray(data.held)) {
					slot.held = data.held.slice();
					slot.multi = data.multi === true;
					if (typeof data.prepareMs === 'number' && Number.isFinite(data.prepareMs)) {
						timingLedger.prepares++;
						timingLedger.prepareMs += data.prepareMs;
					}
				}
				// Release the answered job before delivery, then promote the pipelined
				// second job, which already owns the next reply.
				if (isFirst) {
					slot.parts = null;
					slot.multiRun = false;
					if (slot.second) {
						slot.inflight = slot.second;
						slot.second = null;
						slot.expecting = 'chunk';
					} else slot.inflight = null;
				}
				const records = Array.isArray(data.records) ? data.records.length : 0;
				if (typeof data.runMs === 'number' && Number.isFinite(data.runMs)) {
					timingLedger.chunks++;
					timingLedger.runMs += data.runMs;
					// Lane throughput for the CPU projection and the timing ledger.
					if (data.runMs > 0 && records > 0) {
						const rate = records / data.runMs;
						slot.rate = slot.rate > 0 ? slot.rate * 0.5 + rate * 0.5 : rate;
						// A gpu chunk's cost feeds the floor-aware fit. The sample
						// is the worker's run loop, which spans the whole multi call.
						if (isGpuLane(slot)) {
							slot.costSamples.push({ seeds: records, ms: data.runMs });
							// A cold lane's first chunk also pays the session open: back
							// it out of the model so the next cold lane sizes for it.
							if (slot.costSamples.length === 1 && !slot.openPaid) {
								const model = sharedGpuFit;
								if (model) {
									const open = data.runMs - (model.floor + model.slope * records);
									if (Number.isFinite(open) && open >= 0 && open < 60_000) {
										sharedGpuOpenMs = sharedGpuOpenMs == null ? open : sharedGpuOpenMs * 0.5 + open * 0.5;
									}
								}
							}
							// Publish only a single-lane warm model: several gpu sessions
							// on one device contend, so neither sizes another pool's lane.
							const samples = warmSamples(slot);
							const warm = samples.length > 1 ? fitGpuCost(samples) : null;
							if (warm && slots.filter(isGpuLane).length <= 1) sharedGpuFit = warm;
						}
						reserveGpuHostCores();
					}
				}
				timingLedger.records += records;
				deliverChunk(parts, data.records || [], positional);
			} else if (data.dead === true) {
				// failWorker consumes both in-flight jobs (requeue or job error).
				failWorker(slot, `dead handle: ${data.error}`);
				return;
			} else {
				// workerCore had no preparation for the job — cannot recover by retry.
				// A merged run message answers for every part, so all report it.
				const msg = `chunk failed: ${data.error}`;
				// A failed inline prepare reports the surviving LRU keys.
				if (Array.isArray(data.held)) slot.held = data.held.slice();
				for (const part of parts) {
					errors.push({ jobId: part.job.id, error: msg });
					opts.onJobError?.(part.job, msg);
				}
				// The worker is alive: a pipelined second job still answers below.
				if (isFirst) {
					slot.parts = null;
					slot.multiRun = false;
					if (slot.second) {
						slot.inflight = slot.second;
						slot.second = null;
						slot.expecting = 'chunk';
					} else slot.inflight = null;
				}
			}
			dispatch();
			return;
		}
	}

	/** One cold job in one message: the worker prepares inline, then runs. */
	function combinedRunMsg(q: Queued): unknown {
		return {
			type: 'run', jobId: q.job.id, setupKey: q.job.setupKey, seeds: q.job.seeds, mode: q.job.mode,
			request: q.job.request, trackSkillId: q.job.trackSkillId, secondPlayerIndex: q.job.secondPlayerIndex, distance: q.job.distance,
			...(q.job.gates ? { gates: q.job.gates } : {}),
		};
	}

	/** Give every idle worker a job, preferring ANY preparation it holds. A
	 *  mixed pool's gpu lane is held back while it cannot pay for its device
	 *  pass (laneMayRun), so the CPU lanes keep the queue rather than waiting
	 *  on a slow lane's wide launch. gpu lanes pick first: their probe gate
	 *  reads the queue's measured CPU projection, which the CPU lanes would
	 *  shrink within the same pass. */
	function dispatch(): void {
		if (!running || disposed || aborted) return;
		// The lane decides on the measured CPU rate, so give it the first look:
		// when it opens it owns a slot budget the cpu growth must respect.
		maybeStartGpuLane();
		// Re-run the growth target: the first worker's backend (and so whether this
		// pool has a gpu lane to add a slot for) is only known after it reports.
		grow();
		for (const gpuPass of [true, false]) {
			for (const slot of slots) {
				if (isGpuLane(slot) !== gpuPass) continue;
				if (slot.ready === false || queue.length === 0) continue;
				if (!laneMayRun(slot)) continue;
				if (slot.inflight) {
					// A pipelined CPU worker holds one more job: its message queues
					// inside the worker while the first runs, so the next reply is
					// already waiting. Gpu lanes keep single depth for chunk merging.
					if (!slot.second && slot.pipelined && !isGpuLane(slot)) {
						const more = queue.takeFor(slot.held);
						if (more) { slot.second = more; slot.worker!.postMessage(combinedRunMsg(more)); }
					}
					continue;
				}
				// §H key-affine scheduling: a queued job for ANY held preparation
				// (most-recently-used first) beats a cold prepare, even when a
				// foreign job is at the queue head — the worker never waits on a
				// preparation it cannot use. With the caller's setupKey grouping
				// this keeps each gate block on a worker that already holds it.
				// No affinity match: keep queue order (jobs are grouped by setupKey upstream).
				const next = queue.takeFor(slot.held)!;
				slot.inflight = next;
				slot.parts = batchParts(slot, next);
				const warmHead = slot.held.includes(next.job.setupKey);
				// A cold pipelined job normally rides one message of its own, but a
				// gathered batch needs the prepare round trip: the run message that
				// follows is what carries the parts.
				const coldCombined = !warmHead && slot.pipelined && !(slot.parts && slot.parts.length > 1);
				if (warmHead) {
					slot.expecting = 'chunk';
					slot.worker!.postMessage(runMsg(slot));
				} else if (coldCombined) {
					// Pipelined cold job: one message prepares and runs, one reply.
					slot.expecting = 'chunk';
					slot.worker!.postMessage(combinedRunMsg(next));
				} else {
					// A worker that has not advertised inline preparation, or a cold
					// batch waiting for its gathered run, keeps the two-step flow.
					slot.expecting = 'prepared';
					slot.worker!.postMessage({ type: 'prepare', id: next.job.id, setupKey: next.job.setupKey, request: next.job.request, trackSkillId: next.job.trackSkillId, secondPlayerIndex: next.job.secondPlayerIndex, distance: next.job.distance });
				}
				// Fill the pipeline: the next job queues inside the worker while
				// the one just sent runs.
				if (slot.pipelined && !isGpuLane(slot) && !slot.second && queue.length > 0) {
					const more = queue.takeFor(slot.held);
					if (more) { slot.second = more; slot.worker!.postMessage(combinedRunMsg(more)); }
				}
			}
		}
		if (running && queue.length === 0 && slots.every(s => !s.inflight && !s.second) && !rerunBusy && rerunQueue.length === 0) {
			// Batch drained: if another run is waiting on the shared budget, hand
			// our surplus warm workers over (a lone pool keeps them warm — the
			// preparation-affinity fast path is untouched when un-contended).
			yieldIdleToWaiters();
			const r = running; running = null;
			r.resolve();
		}
	}

	// ── GPU fallback rerun lane (chunk merge seam, handoff step 5) ────────────
	// A {seed, gpuFallback} record means the gpu session's kernel gate refused
	// that seed (sim-server gpu backend). Before onChunk, the seeds re-run on
	// ONE dedicated CPU worker (cpuFactory, outside the shared budget: the gpu
	// lane's overflow relief) and the CPU records splice in, so a merged batch
	// is byte-identical to an all-CPU run (chunks queue FIFO). A rerun failure
	// or no cpuFactory lands as {seed, error} (consumers count seed errors).
	interface RerunReq { job: PoolJob; records: any[]; seeds: number[]; got: Map<number, any>; tally: GpuFallbackTally; fail?: string }
	const rerunQueue: RerunReq[] = [];
	let rerunWorker: WorkerLike | null = null;
	let rerunGen = 0;
	let rerunHeld: string[] = [];
	let rerunBusy: RerunReq | null = null;
	let rerunExpect: 'prepared' | 'chunk' | null = null;
	const RERUN = '#gpu';   // marks rerun messages on the lane's own worker

	const hasGpuFallback = (records: any[]): boolean => records.some((r: any) => r && typeof r.gpuFallback === 'string');

	function deliverRerun(req: RerunReq): void {
		const merged = req.records.map((r: any) => {
			if (!r || typeof r.gpuFallback !== 'string') return r;
			const cpu = req.got.get(r.seed);
			if (cpu) return cpu;
			req.tally.rerunFailures++;
			return { seed: r.seed, error: req.fail ?? 'gpu fallback without CPU rerun lane (pool cpuFactory)' };
		});
		opts.onChunk?.(req.job, merged);
		// One line per refused job, at its completion. Zero-refusal jobs never reach this path.
		const reasons = Object.entries(req.tally.fallbacks).map(([reason, n]) => `${reason}: ${n}`).join(', ');
		console.warn(`[globalsim-pool] job ${req.job.id}: gpu races ${req.tally.races}, fallbacks {${reasons}}, rerun failures ${req.tally.rerunFailures}`);
	}

	function rerunGpuFallback(job: PoolJob, records: any[]): void {
		const tally: GpuFallbackTally = { jobId: job.id, races: records.length, fallbacks: {}, rerunFailures: 0 };
		for (const r of records) if (r && typeof r.gpuFallback === 'string') tally.fallbacks[r.gpuFallback] = (tally.fallbacks[r.gpuFallback] ?? 0) + 1;
		gpuTallies.push(tally);   // reasons counted at hand-off, rerunFailures at delivery
		if (!opts.cpuFactory) { deliverRerun({ job, records, seeds: [], got: new Map(), tally }); return; }
		rerunQueue.push({ job, records, seeds: records.filter((r: any) => r && typeof r.gpuFallback === 'string').map((r: any) => r.seed), got: new Map(), tally });
		rerunPump();
	}

	function rerunPump(): void {
		if (disposed || aborted) { rerunQueue.length = 0; return; }
		if (rerunBusy || rerunQueue.length === 0) return;
		rerunBusy = rerunQueue.shift()!;
		rerunSend(rerunBusy);
	}

	function rerunSend(req: RerunReq): void {
		if (!rerunWorker) {
			rerunGen++;
			const gen = rerunGen;
			rerunWorker = opts.cpuFactory!();
			rerunHeld = [];
			if (opts.skillData !== undefined) rerunWorker.postMessage({ type: 'skillData', skillData: opts.skillData });
			rerunWorker.addEventListener('message', (e: { data: any }) => { if (!disposed && !aborted && rerunGen === gen) onRerunMessage(e.data); });
			rerunWorker.addEventListener('error', () => { if (!disposed && !aborted && rerunGen === gen) rerunFail('CPU rerun worker crashed'); });
		}
		if (rerunHeld.includes(req.job.setupKey)) {
			rerunExpect = 'chunk';
			rerunWorker.postMessage({ type: 'run', jobId: req.job.id + RERUN, setupKey: req.job.setupKey, seeds: req.seeds, mode: 'compact' });
		} else {
			rerunExpect = 'prepared';
			rerunWorker.postMessage({ type: 'prepare', id: req.job.id + RERUN, setupKey: req.job.setupKey, request: req.job.request, trackSkillId: req.job.trackSkillId, secondPlayerIndex: req.job.secondPlayerIndex, distance: req.job.distance });
		}
	}

	function onRerunMessage(data: any): void {
		const req = rerunBusy;
		if (!req || !data || typeof data !== 'object') return;
		if (data.type === 'prepared') {
			if (rerunExpect !== 'prepared' || data.id !== req.job.id + RERUN) return;
			if (data.ok === true) {
				rerunHeld = Array.isArray(data.held) ? data.held.slice() : [req.job.setupKey];
				rerunSend(req);   // held now: the same request answers with the run
			} else rerunFail(`CPU rerun prepare failed: ${data.error}`);
			return;
		}
		if (data.type === 'chunk') {
			if (rerunExpect !== 'chunk' || data.jobId !== req.job.id + RERUN) return;
			if (data.ok !== true) { rerunFail(`CPU rerun chunk failed: ${data.error}`); return; }
			for (const r of data.records || []) req.got.set(r.seed, r);   // CPU per-seed errors pass through: all-CPU parity includes them
			const busy = rerunBusy!;
			rerunBusy = null;
			rerunExpect = null;
			deliverRerun(busy);
			rerunPump();
			dispatch();   // pending reruns held the batch drain. It may complete here
		}
	}

	function rerunFail(reason: string): void {
		// Any poison state is indistinguishable from here: drop the lane worker and
		// let the next request rebuild it.
		const w = rerunWorker;
		rerunWorker = null;
		rerunHeld = [];
		rerunGen++;
		if (w) { try { w.terminate(); } catch { /* gone */ } }
		const busy = rerunBusy!;
		rerunBusy = null;
		rerunExpect = null;
		busy.fail = reason;
		deliverRerun(busy);
		rerunPump();
		dispatch();
	}

	function teardownRerunLane(): void {
		rerunGen++;
		rerunBusy = null;
		rerunExpect = null;
		rerunQueue.length = 0;
		if (rerunWorker) { try { rerunWorker.terminate(); } catch { /* gone */ } rerunWorker = null; rerunHeld = []; }
	}

	return {
		runJobs(jobs: PoolJob[]): Promise<{ errors: Array<{ jobId: string; error: string }>; gpuFallbacks: GpuFallbackTally[] }> {
			if (running) return Promise.reject(new Error('globalsim pool is already running a batch'));
			if (aborted) return Promise.reject(new Error('globalsim pool was aborted'));
			if (disposed) return Promise.reject(new Error('globalsim pool is disposed'));
			// The pool-level `errors` array accumulates across batches (chart.ts
			// runs one batch per round on the same pool and concatenates each
			// result), so resolve ONLY the entries added during this call.
			const errorsFrom = errors.length;
			const gpuFrom = gpuTallies.length;
			for (const job of jobs) queue.push({ job, requeues: 0 });
			grow();   // size from the SHARED worker budget (see the budget block)
			return new Promise<void>((resolve, reject) => {
				running = { resolve, reject };
				dispatch();
			}).then(() => ({ errors: errors.slice(errorsFrom), gpuFallbacks: gpuTallies.slice(gpuFrom) }));
		},
		dispose(): void {
			disposed = true;
			for (const slot of slots) {
				// An idle session may serve the next pool: chart, compare and
				// optimizer runs reuse the sim-server sessions across runs.
				const worker = slot.worker;
				if (!aborted && worker?.retain) { try { worker.retain(); } catch { /* closed */ } }
				else { try { worker?.terminate(); } catch { /* gone */ } }
				slot.worker = null;
			}
			slots.length = 0;
			teardownRerunLane();
			releaseBudget();
			queue.clear();
			running?.resolve();
			running = null;
		},
		abort(): void {
			if (disposed || aborted) return;
			aborted = true;
			queue.clear();
			for (const slot of slots) {
				slot.inflight = null;
				slot.second = null;
				slot.parts = null;
				slot.expecting = null;
				try { slot.worker?.terminate(); } catch { /* already gone */ }
				slot.worker = null;
			}
			slots.length = 0;
			teardownRerunLane();
			releaseBudget();
			// Pending runJobs promise rejects; nothing is requeued (Stop semantics).
			const r = running;
			running = null;
			r?.reject(new Error('globalsim pool aborted'));
		},
		size(): number { return slots.length; },
		timing(): PoolTiming { return { ...timingLedger }; },
	};
}
