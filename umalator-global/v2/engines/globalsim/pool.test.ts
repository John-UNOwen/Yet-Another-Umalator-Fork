/**
 * Tests for the GlobalSim worker pool + seed scheduler (Phase 4).
 *
 * Run: npm run test:globalsim-pool  (from the repo root)
 *
 * The scheduler is driven by scripted FAKE workers (the injectable
 * WorkerFactory — node has no Web Worker), covering acceptance (e): ~25-seed
 * chunking (via buildCompareJobs), order-independent partial merge of streamed
 * chunks, worker restart with exactly one requeue of a dead chunk then a job
 * error, preparation affinity (re-prepare only on setup change), plus the
 * thread-count option resolution rules (§4.1).
 */

// HorseDefTypes' Record defaults reference the build-time constant CC_GLOBAL
// (compare.ts → adapter.ts imports it). Same trick as adapter.test.ts.
(globalThis as any).CC_GLOBAL = true;

import test from 'tape';
import path from 'path';

import {
	createGlobalsimPool, PoolJob, WorkerLike,
	autoThreadCount, resolveThreadCount, serverAwareThreadCount, loadThreadsOption, saveThreadsOption,
	THREADS_STORAGE_KEY, MAX_THREADS, AUTO_THREADS_MAX,
	__testResetWorkerBudget, __testWorkerBudgetLive,
} from './pool';
import { buildCompareJobs, globalsimSeedList, hashString64, GlobalsimCompareInput, DEFAULT_CHUNK_SIZE } from './compare';
import { parseMobPresets } from './mobs';
import { HorseState, SkillSet } from '../../../../components/HorseDefTypes';
import { GroundCondition, Weather, Season, Time } from '../../../../uma-skill-tools/RaceParameters';
import { addPair, newAggregate, summarizeAggregate } from './metrics';

// ── fake worker plumbing ─────────────────────────────────────────────────────

type Responder = (msg: any, w: FakeWorker) => void;

class FakeWorker implements WorkerLike {
	sent: any[] = [];
	terminated = false;
	instance: number;
	respond: Responder = () => {};
	private messageCbs: ((e: { data: any }) => void)[] = [];
	private errorCbs: ((e: unknown) => void)[] = [];
	constructor(instance: number) { this.instance = instance; }
	postMessage(msg: any): void {
		this.sent.push(msg);
		queueMicrotask(() => { if (!this.terminated) this.respond(msg, this); });
	}
	addEventListener(type: 'message' | 'error', cb: any): void {
		(type === 'message' ? this.messageCbs : this.errorCbs).push(cb);
	}
	terminate(): void { this.terminated = true; }
	fire(data: any): void { for (const cb of this.messageCbs) cb({ data }); }
	fireError(): void { for (const cb of this.errorCbs) cb({}); }
}

function scripted(responder: Responder) {
	const workers: FakeWorker[] = [];
	const factory = () => {
		const w = new FakeWorker(workers.length + 1);
		w.respond = responder;
		workers.push(w);
		return w;
	};
	return { workers, factory };
}

const preparedOk = (m: any) => ({ type: 'prepared', id: m.id, setupKey: m.setupKey, ok: true });
const chunkOk = (m: any) => ({
	type: 'chunk', jobId: m.jobId, mode: m.mode, ok: true,
	records: m.seeds.map((seed: number) => ({ seed, finishTimeRaw: 10, finishOrder: 0 })),
});

function job(id: string, setupKey: string, seeds: number[]): PoolJob {
	return { id, setupKey, request: { courseId: '10504' }, seeds, mode: 'compact' };
}

// ── scheduler behaviour ──────────────────────────────────────────────────────

test('happy path: prepare→run streams every chunk back', async t => {
	const { workers, factory } = scripted((m, w) => {
		if (m.type === 'prepare') w.fire(preparedOk(m));
		else if (m.type === 'run') w.fire(chunkOk(m));
	});
	const seen: Array<{ jobId: string; n: number }> = [];
	const pool = createGlobalsimPool({
		factory, threads: 2,
		onChunk: (j, records) => seen.push({ jobId: j.id, n: records.length }),
	});
	const res = await pool.runJobs([job('a', 'X', [1, 2, 3]), job('b', 'Y', [4, 5]), job('c', 'Z', [6])]);
	t.deepEqual(res.errors, [], 'no errors');
	t.equal(seen.length, 3, 'three chunks delivered');
	t.equal(seen.reduce((s, c) => s + c.n, 0), 6, 'every seed accounted for');
	pool.dispose();
	t.ok(workers.every(w => w.terminated), 'dispose terminates live workers');
	t.end();
});

test('shared worker budget caps live workers across concurrent pools', async t => {
	// Regression for the no-global-bound defect: compare, the skill chart and the
	// optimizer each call createGlobalsimPool; with no shared accounting two runs
	// in flight would each eagerly spawn `threads` workers at once (threads ×
	// panes live wasm instances). A tiny forced capacity makes the overlap
	// observable regardless of the machine's core count. The shared capacity is
	// the LARGEST per-pool threads a pool asks for (so one lone run is never
	// throttled), so here capacity = 2 while the two pools together want 4.
	__testResetWorkerBudget(2);
	let liveNow = 0, maxLive = 0;
	const mkFactory = () => () => {
		const w = new FakeWorker(0);
		w.respond = (m, ww) => { if (m.type === 'prepare') ww.fire(preparedOk(m)); else if (m.type === 'run') ww.fire(chunkOk(m)); };
		liveNow++;
		if (liveNow > maxLive) maxLive = liveNow;
		const origTerminate = w.terminate.bind(w);
		w.terminate = () => { if (!w.terminated) liveNow--; origTerminate(); };
		return w;
	};
	// Four jobs each so both pools want to be full; the fake workers respond
	// immediately, so both batches must still drain under contention.
	const jobsA = [job('a1', 'X', [1]), job('a2', 'Y', [2]), job('a3', 'Z', [3]), job('a4', 'W', [4])];
	const jobsB = [job('b1', 'X', [5]), job('b2', 'Y', [6]), job('b3', 'Z', [7]), job('b4', 'W', [8])];
	const pA = createGlobalsimPool({ factory: mkFactory(), threads: 2, onChunk: () => {} });
	const pB = createGlobalsimPool({ factory: mkFactory(), threads: 2, onChunk: () => {} });
	const [ra, rb] = await Promise.all([pA.runJobs(jobsA), pB.runJobs(jobsB)]);
	t.deepEqual(ra.errors, [], 'pool A drained under contention');
	t.deepEqual(rb.errors, [], 'pool B drained under contention (no starvation / hang)');
	t.ok(maxLive >= 2, `both pools were live at once (peak ${maxLive})`);
	t.ok(maxLive <= 2 + 1, `total live workers stayed within the budget(2) plus one first-worker slot: ${maxLive}`);
	t.ok(maxLive < 4, `never ran both pools at full threads (would be 4): peak ${maxLive}`);
	pA.dispose(); pB.dispose();
	t.equal(__testWorkerBudgetLive(), 0, 'every permit returned to the shared budget after dispose');
	t.equal(liveNow, 0, 'no leaked workers');
	t.end();
});

test('lone pool still gets its full thread count from the shared budget', async t => {
	// The cap must never throttle a single run below its own requested threads
	// (server-aware auto scales to MAX_THREADS with no contention).
	__testResetWorkerBudget();   // capacity derived from resolveThreadCount() (≥1)
	let liveNow = 0, maxLive = 0;
	const factory = () => {
		const w = new FakeWorker(0);
		w.respond = (m, ww) => { if (m.type === 'prepare') ww.fire(preparedOk(m)); else if (m.type === 'run') ww.fire(chunkOk(m)); };
		liveNow++;
		if (liveNow > maxLive) maxLive = liveNow;
		const orig = w.terminate.bind(w);
		w.terminate = () => { if (!w.terminated) liveNow--; orig(); };
		return w;
	};
	const want = resolveThreadCount();
	const jobs = Array.from({ length: want + 3 }, (_, i) => job(`j${i}`, `K${i}`, [i]));
	const pool = createGlobalsimPool({ factory, threads: want, onChunk: () => {} });
	const res = await pool.runJobs(jobs);
	t.deepEqual(res.errors, [], 'single pool drains with no contention');
	t.equal(maxLive, want, `a lone pool still runs at its full ${want} threads`);
	pool.dispose();
	t.equal(__testWorkerBudgetLive(), 0, 'permits returned after dispose');
	t.end();
});

test('preparation affinity: same setupKey runs without re-preparing, matching job preferred out of order', async t => {
	const { workers, factory } = scripted((m, w) => {
		if (m.type === 'prepare') w.fire(preparedOk(m));
		else if (m.type === 'run') w.fire(chunkOk(m));
	});
	// Queue order X1, Y, X2: the idle worker holds X → must pick X2 (index 1)
	// with NO prepare, then Y (prepare). One worker → fully deterministic order.
	const pool = createGlobalsimPool({ factory, threads: 1 });
	await pool.runJobs([job('x1', 'X', [1]), job('y', 'Y', [2]), job('x2', 'X', [3])]);
	const w = workers[0];
	const seq = w.sent.map(m => `${m.type}:${(m as any).id ?? (m as any).jobId ?? m.setupKey}`).join(' ');
	t.equal(seq, 'prepare:x1 run:x1 run:x2 prepare:y run:y', 'run:x2 reuses the X preparation; Y prepared only when queued next');
	t.equal(w.sent.filter(m => m.type === 'prepare').length, 2, 'exactly two prepares (X and Y), three runs');
	pool.dispose();
	t.end();
});

test('dead handle: worker recreated, in-flight chunk requeued exactly once, second death = job error', async t => {
	let runCount = 0;
	const { workers, factory } = scripted((m, w) => {
		if (m.type === 'prepare') w.fire(preparedOk(m));
		else if (m.type === 'run') {
			runCount++;
			w.fire({ type: 'chunk', jobId: m.jobId, mode: m.mode, ok: false, dead: true, error: 'engine panic: boom', processed: 1, records: [] });
		}
	});
	const failed: string[] = [];
	const pool = createGlobalsimPool({ factory, threads: 1, onJobError: j => { failed.push(j.id); } });
	const res = await pool.runJobs([job('dead', 'X', [1, 2, 3, 4])]);
	t.equal(runCount, 2, 'chunk ran exactly twice (original + one requeue), never a third time');
	t.equal(workers.length, 3, 'worker recreated after each death (initial + 2 recreations)');
	t.ok(workers[0].terminated && workers[1].terminated, 'dead workers terminated');
	t.deepEqual(failed, ['dead'], 'onJobError fired once');
	t.equal(res.errors.length, 1);
	t.ok(/dead handle/.test(res.errors[0].error), `error mentions dead handle: ${res.errors[0].error}`);
	pool.dispose();
	t.end();
});

test('worker crash (error event) follows the same requeue-once recovery and succeeds', async t => {
	const { workers, factory } = scripted((m, w) => {
		if (m.type === 'prepare') w.fire(preparedOk(m));
		else if (m.type === 'run') {
			if (w.instance === 1) w.fireError();     // first worker dies mid-chunk
			else w.fire(chunkOk(m));                 // recreated worker completes it
		}
	});
	let delivered = 0;
	const pool = createGlobalsimPool({ factory, threads: 1, onChunk: () => { delivered++; } });
	const res = await pool.runJobs([job('crashy', 'X', [1, 2, 3])]);
	t.deepEqual(res.errors, [], 'recovery is silent when the requeue succeeds');
	t.equal(delivered, 1, 'the requeued chunk delivered its records once');
	t.ok(workers[0].terminated, 'crashed worker terminated');
	pool.dispose();
	t.end();
});

test('non-dead prepare failure = immediate job error, no requeue', async t => {
	const { workers, factory } = scripted((m, w) => {
		if (m.type === 'prepare') w.fire({ type: 'prepared', id: m.id, setupKey: m.setupKey, ok: false, error: 'geometry fetch 404', dead: false });
	});
	const pool = createGlobalsimPool({ factory, threads: 1 });
	const res = await pool.runJobs([job('pfail', 'X', [1, 2])]);
	t.equal(res.errors.length, 1);
	t.ok(/geometry fetch 404/.test(res.errors[0].error));
	t.equal(workers[0].sent.filter(m => m.type === 'prepare').length, 1, 'never retried');
	pool.dispose();
	t.end();
});

test('non-dead prepare failure invalidates the cached preparation (no stale-key poisoning)', async t => {
	// Regression: workerCore.handlePrepare frees the held PreparedRace BEFORE
	// building the next one, so a failed prepare leaves the worker holding NO
	// preparation. The pool must drop slot.preparedKey on a non-dead prepare
	// failure — keeping the previous key made dispatch bare-run the next
	// matching job into the worker's "no preparation" reply: a permanent job
	// error for every later job of that setup, for the pool's lifetime.
	const held = new Map<number, string | null>();   // per-worker state, mirrors workerCore.prepared
	const { workers, factory } = scripted((m, w) => {
		if (m.type === 'prepare') {
			held.set(w.instance, null);   // handlePrepare frees before constructing
			if (String(m.setupKey) === 'B') {
				w.fire({ type: 'prepared', id: m.id, setupKey: m.setupKey, ok: false, error: 'bad request', dead: false });
			} else {
				held.set(w.instance, String(m.setupKey));
				w.fire(preparedOk(m));
			}
		} else if (m.type === 'run') {
			if (held.get(w.instance) == null) {
				w.fire({ type: 'chunk', jobId: m.jobId, mode: m.mode, ok: false, dead: false, error: `no preparation for job ${m.jobId}` });
			} else w.fire(chunkOk(m));
		}
	});
	let delivered = 0;
	const pool = createGlobalsimPool({ factory, threads: 1, onChunk: () => { delivered++; } });
	const res1 = await pool.runJobs([job('x1', 'X', [1]), job('x2', 'X', [2]), job('b', 'B', [3])]);
	// While the preparation is still alive the affinity fast path is correct:
	// x2 runs bare, only the B input error is reported.
	t.deepEqual(res1.errors, [{ jobId: 'b', error: 'prepare failed: bad request' }], 'batch 1: only the B input error');
	// B's failed prepare (after freeing X) is where the cached key goes stale.
	// The next X job must be RE-prepared and succeed — pre-fix this failed with
	// "chunk failed: no preparation for job x3" (the poisoned slot).
	const res2 = await pool.runJobs([job('x3', 'X', [4]), job('b2', 'B', [5])]);
	t.deepEqual(res2.errors.map(e => e.jobId), ['b2'], 'batch 2: x3 succeeds on a rebuilt preparation; only b2 errors');
	t.equal(delivered, 3, 'x1, x2 and x3 all delivered their records');
	const seq = workers[0].sent.map(m => `${m.type}:${(m as any).id ?? (m as any).jobId}`).join(' ');
	t.ok(seq.includes('prepare:x3 run:x3'), `stale key dropped, preparation rebuilt: ${seq}`);
	pool.dispose();
	t.end();
});

test('second runJobs on the same pool reports only its own batch errors', async t => {
	// Regression: runJobs used to resolve with the SAME pool-level errors array,
	// never reset — chart.ts calls runJobs once per round and pushes ...res.errors
	// into jobErrors each time, so batch 1's errors were re-counted in batch 2.
	const { factory } = scripted((m, w) => {
		if (m.type === 'prepare') w.fire(preparedOk(m));
		else if (m.type === 'run') {
			if (String(m.jobId).includes('bad')) w.fire({ type: 'chunk', jobId: m.jobId, mode: m.mode, ok: false, dead: false, error: `boom ${m.jobId}` });
			else w.fire(chunkOk(m));
		}
	});
	const pool = createGlobalsimPool({ factory, threads: 1 });
	const res1 = await pool.runJobs([job('b1.bad', 'X', [1]), job('b1.ok', 'X', [2])]);
	t.deepEqual(res1.errors.map(e => e.jobId), ['b1.bad'], 'batch 1 reports only its own failure');
	const res2 = await pool.runJobs([job('b2.bad', 'Y', [3]), job('b2.ok', 'Y', [4])]);
	t.deepEqual(res2.errors.map(e => e.jobId), ['b2.bad'], 'batch 2 contains only the new errors, not batch 1 ones');
	t.notEqual(res2.errors, res1.errors, 'each batch resolves with a distinct array');
	pool.dispose();
	t.end();
});

test('order-independent merge: out-of-order chunk delivery yields identical summaries', t => {
	// Scheduler-independent half of acceptance (e): chunk records may arrive in
	// any order; the main-thread merge (addPair) is order-independent, which is
	// what lets partial results stream during the run.
	const mkPairRecords = (seed: number, uma2Wins: boolean) => ({
		a: { seed, finishTimeRaw: uma2Wins ? 10.25 : 10, finishOrder: 1 },
		b: { seed, finishTimeRaw: uma2Wins ? 10 : 10.25, finishOrder: 3 },
	});
	const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
	const chunks = [seeds.slice(0, 4), seeds.slice(4)];
	const run = (orders: number[]) => {
		const agg = newAggregate();
		for (const ci of orders) {
			for (const s of chunks[ci]) {
				const { a, b } = mkPairRecords(s, s % 2 === 0);
				addPair(agg, a, b, 2000);
			}
		}
		return summarizeAggregate(agg);
	};
	t.deepEqual(run([0, 1]), run([1, 0]), 'swapped chunk delivery order → identical summary');
	t.deepEqual(run([1, 0]), run([1, 0]), 'deterministic');
	t.end();
});

// ── chunking through the compare facade (buildCompareJobs) ──────────────────

const repoRoot = path.resolve(__dirname, '../../../../');
const courseIds = Object.keys(require(path.join(repoRoot, 'vendor/GlobalSim/data/course_data.json')));
const mobPreset = parseMobPresets(require('./mob-presets.json')).presets['default'];

const horse = (over: Record<string, any> = {}): HorseState =>
	new HorseState({
		speed: 900, stamina: 900, power: 800, guts: 700, wisdom: 800,
		strategy: 'Senkou', distanceAptitude: 'A', surfaceAptitude: 'A', strategyAptitude: 'A', mood: 2,
		...over,
	}).set('skills', SkillSet([]));

function compareInput(over: Partial<GlobalsimCompareInput> = {}): GlobalsimCompareInput {
	return {
		uma1: horse(), uma2: horse({ speed: 950 }),
		courseId: '10504', distance: 2000,
		ground: GroundCondition.Good, weather: Weather.Sunny, season: Season.Spring, time: Time.Midday,
		courseIds, mobPreset,
		seedBase: 20261114, sampleCount: 200,
		workerFactory: () => { throw new Error('not used by buildCompareJobs'); },
		...over,
	} as GlobalsimCompareInput;
}

test('buildCompareJobs: fixed gate → 2 variants × ceil(N/chunkSize) jobs of ≤ 25 seeds', t => {
	const input = compareInput({ fixedGate: 3 });
	const seeds = globalsimSeedList(input.seedBase, 200);
	const { jobs, errors } = buildCompareJobs(input, seeds, 'compact');
	t.deepEqual(errors, [], 'no build errors');
	t.equal(jobs.length, 16, '8 chunks × 2 variants at 200 seeds / 25');
	for (const j of jobs) {
		t.ok(j.seeds.length <= DEFAULT_CHUNK_SIZE && j.seeds.length >= 1, `chunk size ${j.seeds.length} within 1..${DEFAULT_CHUNK_SIZE}`);
	}
	const total = jobs.reduce((s, j) => s + j.seeds.length, 0);
	t.equal(total, 400, 'every seed scheduled once per variant');
	const setupKeys = new Set(jobs.map(j => j.setupKey));
	t.equal(setupKeys.size, 2, 'one preparation per variant (fixed gate ⇒ same setup across chunks)');
	t.ok(jobs.some(j => j.setupKey.includes('|g3|')), 'gate baked into the setupKey');
	t.end();
});

test('buildCompareJobs: auto gate groups seeds by derived gate (≤9 setups per variant)', t => {
	const input = compareInput();
	const seeds = globalsimSeedList(input.seedBase, 200);
	const { jobs } = buildCompareJobs(input, seeds, 'compact');
	const v0 = jobs.filter(j => j.id.startsWith('0|'));
	const v1 = jobs.filter(j => j.id.startsWith('1|'));
	t.equal(v0.length + v1.length, jobs.length);
	t.ok(new Set(v0.map(j => j.setupKey)).size <= 9, 'auto-gate: at most one setup per gate per variant');
	const total = v0.reduce((s, j) => s + j.seeds.length, 0);
	t.equal(total, 200, 'variant 0 covers every seed exactly once');
	for (const j of jobs) t.ok(j.seeds.length <= DEFAULT_CHUNK_SIZE, 'chunks stay ≤ 25 even inside a gate group');
	t.end();
});

test('hashString64: deterministic 64-bit-equivalent setup fingerprint (setupKey identity)', t => {
	// pool.ts trusts setupKey equality alone when reusing a preparation, so
	// the hash must be deterministic and collision-free at chart scale
	// (~2700 preparations on a big chart; a 32-bit FNV key collided ~0.1%/run).
	const canon = JSON.stringify({ g: 2, w: 1, s: 0, t: 1, gr: null, h: [{ gateIndex: 3, uid: 'a' }] });
	t.equal(hashString64(canon), hashString64(canon), 'deterministic: same canonical string in, same fingerprint out');
	t.equal(hashString64(canon).length, 14, 'fixed 7+7 zero-padded base36 width (36^7 > 2^32 ⇒ unambiguous pair)');
	const near = canon.replace('"gateIndex":3', '"gateIndex":4');
	t.notEqual(hashString64(canon), hashString64(near), 'one-field near-miss splits (the collision shape a 32-bit key hit)');
	const seen = new Set<string>();
	for (let i = 0; i < 10000; i++) {
		seen.add(hashString64(JSON.stringify({ g: 2, w: 1, s: 0, t: 1, gr: null, h: [{ gateIndex: i % 18, uid: 'uma' + i }] })));
	}
	t.equal(seen.size, 10000, '10000 distinct preparations ⇒ 10000 distinct fingerprints (~4× chart scale)');
	t.end();
});

// ── thread option (§4.1) ─────────────────────────────────────────────────────

test('auto thread count clamps hardwareConcurrency−1 to [1, AUTO_THREADS_MAX]', t => {
	t.equal(autoThreadCount(2), 1);
	t.equal(autoThreadCount(1), 1);
	t.equal(autoThreadCount(5), 4);              // hc−1 below the cap passes through
	t.equal(autoThreadCount(8), 7);              // hc−1 passes through — the ceiling is MAX_THREADS now
	t.equal(autoThreadCount(64), AUTO_THREADS_MAX);
	t.equal(autoThreadCount(64, MAX_THREADS), MAX_THREADS, 'server-backed auto may reach MAX_THREADS');
	t.end();
});

test('serverAwareThreadCount: auto scales with a sim server, explicit untouched', t => {
	t.equal(serverAwareThreadCount('auto', false), autoThreadCount());
	t.equal(serverAwareThreadCount('auto', true), Math.min(MAX_THREADS, autoThreadCount(undefined, MAX_THREADS)));
	t.ok(serverAwareThreadCount('auto', true) >= serverAwareThreadCount('auto', false));
	t.equal(serverAwareThreadCount(12, false), 12);
	t.equal(serverAwareThreadCount(12, true), 12);
	t.end();
});

test('threads option persists through localStorage and resolves', t => {
	const store = new Map<string, string>();
	(globalThis as any).localStorage = {
		getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
		setItem: (k: string, v: string) => { store.set(k, v); },
	};
	t.equal(loadThreadsOption(), 'auto', 'default auto');
	saveThreadsOption(12);
	t.equal(store.get(THREADS_STORAGE_KEY), '12');
	t.equal(loadThreadsOption(), 12);
	t.equal(resolveThreadCount(12), 12);
	t.equal(resolveThreadCount(999), MAX_THREADS, 'fixed option clamped to MAX_THREADS');
	t.equal(resolveThreadCount('auto'), autoThreadCount(), 'auto path');
	saveThreadsOption('auto');
	t.equal(store.get(THREADS_STORAGE_KEY), 'auto');
	store.set(THREADS_STORAGE_KEY, 'garbage');
	t.equal(loadThreadsOption(), 'auto', 'bad stored value falls back to auto');
	delete (globalThis as any).localStorage;
	t.equal(loadThreadsOption(), 'auto', 'no localStorage at all → auto');
	t.end();
});
