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
 * thread-count option resolution rules (§4.1). The gpu group lane cases pack
 * compatible setup keys into one run message and pin the positional split
 * (equal seed values across the compare variants) and its compatibility
 * limits.
 */

// HorseDefTypes' Record defaults reference the build-time constant CC_GLOBAL
// (compare.ts → adapter.ts imports it). Same trick as adapter.test.ts.
(globalThis as any).CC_GLOBAL = true;

import test from 'tape';
import path from 'path';

import {
	createGlobalsimPool, PoolJob, WorkerLike, setGpuCostModel,
	autoThreadCount, resolveThreadCount, serverAwareThreadCount, loadThreadsOption, saveThreadsOption,
	THREADS_STORAGE_KEY, MAX_THREADS, AUTO_THREADS_MAX,
	__testResetWorkerBudget, __testWorkerBudgetLive, __testResetGpuFit, __testSetGpuFit, __testGetGpuFit, __testFitGpuMinima,
} from './pool';
import { pickRotationBackend } from './sim-server';
import type { Backend } from './sim-server';
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
	backend?: string;   // simLink's SimWorker mirrors the sim-server backend here
	ready?: Promise<void>;   // simLink's SimWorker resolves it once the backend is named
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

function scripted(responder: Responder, backend?: string) {
	const workers: FakeWorker[] = [];
	const factory = () => {
		const w = new FakeWorker(workers.length + 1);
		w.respond = responder;
		if (backend) w.backend = backend;
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

test('pipelined worker: a cold job prepares inline, so one message answers both', async t => {
	// workerCore advertises `pipelined` on its first prepared reply. From then on
	// a cold job is a single `run` carrying its request, which removes one worker
	// round trip per cold setup (C1).
	const { workers, factory } = scripted((m, w) => {
		if (m.type === 'prepare') w.fire({ type: 'prepared', id: m.id, setupKey: m.setupKey, ok: true, pipelined: true });
		else if (m.type === 'run') w.fire(chunkOk(m));
	});
	const seen: string[] = [];
	const pool = createGlobalsimPool({ factory, threads: 1, onChunk: (j) => seen.push(j.id) });
	const res = await pool.runJobs([job('a', 'X', [1, 2]), job('b', 'Y', [3])]);
	t.deepEqual(res.errors, [], 'no errors');
	const sent = workers[0].sent;
	t.equal(sent.filter(m => m.type === 'prepare').length, 1, 'only the first cold job takes the two-step flow');
	const runs = sent.filter(m => m.type === 'run');
	t.equal(runs.length, 2, 'both jobs run');
	t.equal(runs.filter(m => m.request != null).length, 1, 'the pipelined cold run carries its request');
	t.deepEqual(seen.sort(), ['a', 'b'], 'both chunks delivered');
	pool.dispose();
	t.end();
});

const tick = () => new Promise<void>((res) => setTimeout(res, 0));

test('pipelined worker: two jobs stay in flight and the next is queued in the worker', async t => {
	// Depth two: after the first reply the second job's message is already inside
	// the worker, so the pool pays no round trip between them (C1, second half).
	const { workers, factory } = scripted((m, w) => {
		if (m.type === 'prepare') w.fire({ type: 'prepared', id: m.id, setupKey: m.setupKey, ok: true, pipelined: true });
		// run replies are fired by the test so the pipeline depth is observable
	});
	const seen: string[] = [];
	const pool = createGlobalsimPool({ factory, threads: 1, onChunk: (j) => seen.push(j.id) });
	const done = pool.runJobs([job('a', 'X', [1]), job('b', 'Y', [2]), job('c', 'Z', [3])]);
	await tick();
	const runs1 = workers[0].sent.filter(m => m.type === 'run');
	t.equal(runs1.length, 2, 'two jobs in flight on one worker');
	t.deepEqual(runs1.map(m => m.jobId), ['a', 'b'], 'the second job rides behind the first');
	workers[0].fire(chunkOk({ jobId: 'a', mode: 'compact', seeds: [1] }));
	await tick();
	t.deepEqual(seen, ['a'], 'the first chunk is delivered');
	const runs2 = workers[0].sent.filter(m => m.type === 'run');
	t.equal(runs2.length, 3, 'the answered slot takes the next queued job');
	t.equal(runs2[2].jobId, 'c', 'the third job fills the pipeline');
	workers[0].fire(chunkOk({ jobId: 'b', mode: 'compact', seeds: [2] }));
	await tick();
	workers[0].fire(chunkOk({ jobId: 'c', mode: 'compact', seeds: [3] }));
	const res = await done;
	t.deepEqual(res.errors, [], 'no errors');
	t.deepEqual(seen, ['a', 'b', 'c'], 'every chunk delivered once');
	pool.dispose();
	t.end();
});

test('pipelined worker: a crash requeues both in-flight jobs', async t => {
	const { workers, factory } = scripted((m, w) => {
		if (m.type === 'prepare') w.fire({ type: 'prepared', id: m.id, setupKey: m.setupKey, ok: true, pipelined: true });
	});
	const seen: string[] = [];
	const pool = createGlobalsimPool({ factory, threads: 1, onChunk: (j) => seen.push(j.id) });
	const done = pool.runJobs([job('a', 'X', [1]), job('b', 'Y', [2])]);
	await tick();
	workers[0].fireError();
	await tick();
	const w2 = workers[1];
	t.ok(w2, 'a replacement worker was created');
	const fired = new Set<string>();
	for (let i = 0; i < 20 && seen.length < 2; i++) {
		await tick();
		for (const m of w2.sent) {
			if (m.type === 'run' && !fired.has(m.jobId)) { fired.add(m.jobId); w2.fire(chunkOk(m)); }
		}
	}
	const res = await done;
	t.deepEqual(res.errors, [], 'both jobs finished without a job error');
	t.deepEqual(seen.sort(), ['a', 'b'], 'both requeued jobs delivered once');
	pool.dispose();
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

// ── §H: per-worker preparation LRU + key-affine scheduling ──────────────────

/**
 * Scripted workers that model the §H LRU core: every `prepared` reply (ok or
 * failed) reports the held setupKeys, MRU first, trimmed to the cap — exactly
 * what the pool mirrors into slot.held for key-affine dispatch. The §H tests
 * pin the exact message sequence, so they turn the adaptive chunk sizing off.
 */
function lruScripted(cap: number, failKeys: ReadonlySet<string> = new Set()) {
	const heldBy = new Map<number, string[]>(); // worker instance → held keys, MRU first
	const { workers, factory } = scripted((m, w) => {
		const keys = () => heldBy.get(w.instance) ?? [];
		const touch = (key: string) => {
			const next = keys().filter(k => k !== key);
			next.unshift(key);
			heldBy.set(w.instance, next.slice(0, cap));
		};
		if (m.type === 'prepare') {
			// Re-preparing a key drops its old entry even when the build
			// fails; the OTHER preparations are untouched (LRU core contract).
			heldBy.set(w.instance, keys().filter(k => k !== String(m.setupKey)));
			if (failKeys.has(String(m.setupKey))) {
				w.fire({ type: 'prepared', id: m.id, setupKey: m.setupKey, ok: false, error: 'bad request', dead: false, held: keys().slice() });
				return;
			}
			touch(String(m.setupKey));
			w.fire({ type: 'prepared', id: m.id, setupKey: m.setupKey, ok: true, prepareMs: 8, held: keys().slice() });
		} else if (m.type === 'run') {
			const key = String(m.setupKey);
			if (!keys().includes(key)) {
				w.fire({ type: 'chunk', jobId: m.jobId, mode: m.mode, ok: false, dead: false, error: `no preparation for job ${m.jobId}` });
				return;
			}
			touch(key);
			w.fire({ type: 'chunk', jobId: m.jobId, mode: m.mode, ok: true, records: m.seeds.map((seed: number) => ({ seed, finishTimeRaw: 10, finishOrder: 0 })), runMs: 40 });
		}
	});
	return { workers, factory, heldBy };
}

test('§H LRU scheduling: interleaved gate blocks on ONE worker pay one prepare per setup', async t => {
	const { workers, factory } = lruScripted(8);
	// Three setups interleaved gate-block style. A one-preparation worker
	// re-prepares six times here; the LRU worker holds all three, so every
	// job after the first of its setup runs bare, out of queue order.
	const pool = createGlobalsimPool({ factory, threads: 1, adaptiveSizing: false });
	const res = await pool.runJobs([
		job('x1', 'X', [1]), job('y1', 'Y', [2]), job('x2', 'X', [3]),
		job('z1', 'Z', [4]), job('y2', 'Y', [5]), job('x3', 'X', [6]),
	]);
	t.deepEqual(res.errors, [], 'no job errors (every held key served bare)');
	const w = workers[0];
	const seq = w.sent.map(m => `${m.type}:${(m as any).id ?? (m as any).jobId}`).join(' ');
	// Key-affine dispatch drains ALL of a held setup's blocks (MRU first)
	// before the worker ever goes cold: X's blocks go first, then Y's, then Z.
	t.equal(seq, 'prepare:x1 run:x1 run:x2 run:x3 prepare:y1 run:y1 run:y2 prepare:z1 run:z1',
		'each setup prepared once and drained whole before the next prepare');
	t.equal(w.sent.filter(m => m.type === 'prepare').length, 3, 'three prepares for six jobs across three setups');
	t.ok(w.sent.filter(m => m.type === 'run').every(m => typeof (m as any).setupKey === 'string'), 'every run names the setupKey it runs on');
	pool.dispose();
	t.end();
});

test('§H held mirror: an evicted preparation re-prepares, held ones never do', async t => {
	const { workers, factory } = lruScripted(2);
	const pool = createGlobalsimPool({ factory, threads: 1, adaptiveSizing: false });
	const res1 = await pool.runJobs([job('a1', 'A', [1]), job('b1', 'B', [2]), job('c1', 'C', [3])]);
	t.deepEqual(res1.errors, [], 'batch 1: three cold prepares');
	// Cap 2: preparing C evicted A. The mirror carries the worker's truth,
	// so A is re-prepared — had the pool merely accumulated every key it
	// ever saw, a2 would bare-run into a "no preparation" failure.
	const res2 = await pool.runJobs([job('a2', 'A', [4])]);
	t.deepEqual(res2.errors, [], 'the evicted setup is re-prepared, not errored');
	const seq = workers[0].sent.map(m => `${m.type}:${(m as any).id ?? (m as any).jobId}`).join(' ');
	t.equal(seq, 'prepare:a1 run:a1 prepare:b1 run:b1 prepare:c1 run:c1 prepare:a2 run:a2');
	pool.dispose();
	t.end();
});

test('§H gate-blocked batch: two workers, two gate blocks, one prepare each', async t => {
	const { workers, factory } = lruScripted(8);
	const pool = createGlobalsimPool({ factory, threads: 2, adaptiveSizing: false });
	const res = await pool.runJobs([job('g0a', 'G0', [1]), job('g1a', 'G1', [2]), job('g0b', 'G0', [3]), job('g1b', 'G1', [4])]);
	t.deepEqual(res.errors, [], 'no job errors');
	// Each worker cold-prepared one gate block and then bare-ran the second
	// chunk of the block it holds — a batch never waits on a preparation it
	// cannot use.
	t.equal(workers.length, 2, 'two workers for four queued chunks');
	for (const w of workers) {
		t.equal(w.sent.filter(m => m.type === 'prepare').length, 1, 'one prepare per worker');
		t.equal(w.sent.filter(m => m.type === 'run').length, 2, 'two bare runs per worker');
	}
	pool.dispose();
	t.end();
});

test('§H timing ledger: worker prepareMs/runMs accumulate for the prepare-share check', async t => {
	const { factory } = lruScripted(8);   // reports prepareMs: 8, runMs: 40
	const pool = createGlobalsimPool({ factory, threads: 1, adaptiveSizing: false, onChunk: () => {} });
	t.deepEqual(pool.timing(), { prepares: 0, prepareMs: 0, chunks: 0, runMs: 0, records: 0 }, 'zero until the worker reports');
	await pool.runJobs([job('j1', 'X', [1, 2, 3]), job('j2', 'Y', [4, 5])]);
	t.deepEqual(pool.timing(), { prepares: 2, prepareMs: 16, chunks: 2, runMs: 80, records: 5 }, 'ledger reflects the two preparations and two chunks');
	await pool.runJobs([job('j3', 'X', [6])]);
	const late = pool.timing();
	t.equal(late.prepares, 2, 'a held setup re-runs bare: no new prepare in the ledger');
	t.equal(late.chunks, 3, 'the third chunk ran on the held preparation');
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

// ── gpu batch lane (handoff D1) ──────────────────────────────────────────────

test('gpu batch lane: same-setup chunks merge into ONE run message and split back per job', async t => {
	const { workers, factory } = scripted((m, w) => {
		if (m.type === 'prepare') w.fire(preparedOk(m));
		else if (m.type === 'run') w.fire(chunkOk(m));
	}, 'gpu');
	const jobs = [job('g1', 'X', [1, 2, 3]), job('g2', 'X', [4, 5, 6]), job('g3', 'X', [7, 8]), job('g4', 'X', [9])];
	const got: Array<{ jobId: string; seeds: number[] }> = [];
	const pool = createGlobalsimPool({
		factory, threads: 1,
		onChunk: (j, records) => got.push({ jobId: j.id, seeds: records.map((r: any) => r.seed) }),
	});
	const res = await pool.runJobs(jobs);
	t.deepEqual(res.errors, [], 'no errors');
	const runs = workers[0].sent.filter(m => m.type === 'run');
	t.equal(runs.length, 1, 'the four queued chunks answer in one run message');
	t.deepEqual(runs[0].seeds, [1, 2, 3, 4, 5, 6, 7, 8, 9], 'merged seeds, queue order');
	t.equal(runs[0].jobId, 'g1', 'the reply keys on the head job');
	t.equal(workers[0].sent.filter(m => m.type === 'prepare').length, 1, 'one preparation for the merged batch');
	t.equal(got.length, 4, 'one onChunk per original job');
	for (const j of jobs) {
		const hit = got.find(g => g.jobId === j.id);
		t.deepEqual(hit && hit.seeds, j.seeds, `job ${j.id} gets exactly its own records`);
	}
	pool.dispose();
	t.end();
});

test('gpu batch lane: an unready worker is not dispatched, so the first chunk merges too', async t => {
	// The sim-server names a session's backend only after POST /session returns.
	// Dispatching before that ran the first chunk unmerged, and a 25-seed gpu
	// launch costs a full device pass (measured 4.2 s on v77): one third of a
	// 600-seed run. The pool waits for the worker's ready promise instead.
	let release!: () => void;
	const ready = new Promise<void>(res => { release = res; });
	const workers: FakeWorker[] = [];
	const factory = () => {
		const w = new FakeWorker(workers.length + 1);
		w.backend = 'gpu';
		w.ready = ready;
		w.respond = (m, ww) => {
			if (m.type === 'prepare') ww.fire(preparedOk(m));
			else if (m.type === 'run') ww.fire(chunkOk(m));
		};
		workers.push(w);
		return w;
	};
	const got: string[] = [];
	const pool = createGlobalsimPool({ factory, threads: 1, onChunk: j => { got.push(j.id); } });
	const run = pool.runJobs([job('w1', 'X', [1, 2, 3]), job('w2', 'X', [4, 5, 6]), job('w3', 'X', [7, 8])]);
	await new Promise(res => setTimeout(res, 20));
	t.equal(workers[0].sent.length, 0, 'nothing dispatched before the backend is known');
	release();
	const res = await run;
	t.deepEqual(res.errors, [], 'no errors');
	const runs = workers[0].sent.filter(m => m.type === 'run');
	t.equal(runs.length, 1, 'the first chunk is the merged chunk, not a narrow one');
	t.deepEqual(runs[0].seeds, [1, 2, 3, 4, 5, 6, 7, 8], 'all queued seeds in one run message');
	t.equal(workers[0].sent.filter(m => m.type === 'prepare').length, 1, 'one preparation');
	t.deepEqual(got.sort(), ['w1', 'w2', 'w3'], 'every job still delivers its own chunk');
	pool.dispose();
	t.end();
});

test('gpu batch lane: the seed cap bounds the merge', async t => {
	const { workers, factory } = scripted((m, w) => {
		if (m.type === 'prepare') w.fire(preparedOk(m));
		else if (m.type === 'run') w.fire(chunkOk(m));
	}, 'gpu');
	const jobs = Array.from({ length: 4 }, (_, i) => job(`c${i}`, 'X', [i * 5 + 1, i * 5 + 2, i * 5 + 3, i * 5 + 4, i * 5 + 5]));
	let delivered = 0;
	const pool = createGlobalsimPool({ factory, threads: 1, gpuBatchSeeds: 7, onChunk: () => { delivered++; } });
	const res = await pool.runJobs(jobs);
	t.deepEqual(res.errors, [], 'no errors');
	const runs = workers[0].sent.filter(m => m.type === 'run');
	t.equal(runs.length, 2, '20 seeds at cap 7 ride two launches, not four');
	t.deepEqual(runs.map(r => r.seeds.length), [10, 10], 'the gather stops once the cap is reached');
	t.equal(delivered, 4, 'every job still delivers its own chunk');
	pool.dispose();
	t.end();
});

test('gpu batch lane: off for CPU workers, other preparations, and gpuBatchSeeds 0', async t => {
	const responder = (m: any, w: any) => {
		if (m.type === 'prepare') w.fire(preparedOk(m));
		else if (m.type === 'run') w.fire(chunkOk(m));
	};
	const { workers: cpuWorkers, factory: cpuFactory } = scripted(responder);   // no backend reported
	const poolA = createGlobalsimPool({ factory: cpuFactory, threads: 1, onChunk: () => {} });
	const resA = await poolA.runJobs([job('n1', 'X', [1, 2]), job('n2', 'X', [3, 4])]);
	poolA.dispose();
	t.equal(cpuWorkers[0].sent.filter(m => m.type === 'run').length, 2, 'a worker that does not report the gpu backend stays one job per run');
	const { workers: offWorkers, factory: offFactory } = scripted(responder, 'gpu');
	const poolB = createGlobalsimPool({ factory: offFactory, threads: 1, gpuBatchSeeds: 0, onChunk: () => {} });
	const resB = await poolB.runJobs([job('z1', 'X', [1, 2]), job('z2', 'X', [3, 4])]);
	poolB.dispose();
	t.equal(offWorkers[0].sent.filter(m => m.type === 'run').length, 2, 'gpuBatchSeeds 0 disables merging on a gpu worker');
	const { workers: mixWorkers, factory: mixFactory } = scripted(responder, 'gpu');
	const poolC = createGlobalsimPool({ factory: mixFactory, threads: 1, onChunk: () => {} });
	const resC = await poolC.runJobs([job('m1', 'X', [1, 2]), { ...job('m2', 'X', [3, 4]), trackSkillId: '9' }]);
	poolC.dispose();
	t.equal(mixWorkers[0].sent.filter(m => m.type === 'run').length, 2, 'a different trackSkillId never merges (each prepare holds one skill)');
	t.deepEqual([...resA.errors, ...resB.errors, ...resC.errors], [], 'no job errors in any configuration');
	t.end();
});

// ── adaptive per-lane sizing (handoff D2) ────────────────────────────────────

const seedChunk = (first: number): number[] => Array.from({ length: 25 }, (_, k) => first + k);

test('adaptive sizing: a cold gpu lane sizes its first chunk from the priors, not one job', async t => {
	// A fresh session's first launch pays about 2 s of session open, so a
	// one-job probe would measure the open instead of the launch. The priors
	// budget the launch target minus that open, one host pass and the chunk's
	// kernel, so the lane starts with real work.
	__testResetGpuFit();
	const gpuRuns: number[][] = [];
	let instance = 0;
	const factory = () => {
		const w = new FakeWorker(++instance);
		const gpu = instance === 2;
		if (gpu) w.backend = 'gpu';
		w.respond = (m, ww) => {
			if (m.type === 'prepare') ww.fire(preparedOk(m));
			else if (m.type === 'run') {
				if (gpu) gpuRuns.push(m.seeds as number[]);
				ww.fire({ ...chunkOk(m), runMs: gpu ? 1800 + 1.3 * m.seeds.length : m.seeds.length / 0.15 });
			}
		};
		return w;
	};
	const jobs = Array.from({ length: 120 }, (_, i) => job(`f${i}`, 'X', seedChunk(i * 25 + 1)));
	let delivered = 0;
	const pool = createGlobalsimPool({ factory, threads: 2, onChunk: () => { delivered++; } });
	const res = await pool.runJobs(jobs);
	t.deepEqual(res.errors, [], 'no errors');
	t.ok(gpuRuns.length >= 1, 'the cold lane ran');
	t.ok(gpuRuns[0].length > 25, `the first chunk is prior-sized, not one job: got ${gpuRuns[0].length} seeds`);
	t.ok(gpuRuns[0].length <= 2075, 'and stays inside the seed cap (one gathered job may overshoot)');
	t.equal(delivered, 120, 'every job delivered');
	pool.dispose();
	t.end();
});

test('adaptive sizing: a fitted model sizes chunks to the launch target', async t => {
	// The compare field fits about 1,800 ms of fixed pass plus 1.3 ms per race.
	// A 4,500 ms target asks for (4500 - 1800) / 1.3 ≈ 2,077 seeds, which
	// the 2,048 cap takes, and one gathered job may overshoot it.
	__testSetGpuFit({ floor: 1800, slope: 1.3 });
	const gpuRuns: number[][] = [];
	let instance = 0;
	const factory = () => {
		const w = new FakeWorker(++instance);
		const gpu = instance === 2;
		if (gpu) w.backend = 'gpu';
		w.respond = (m, ww) => {
			if (m.type === 'prepare') ww.fire(preparedOk(m));
			else if (m.type === 'run') {
				if (gpu) gpuRuns.push(m.seeds as number[]);
				ww.fire({ ...chunkOk(m), runMs: gpu ? 1800 + 1.3 * m.seeds.length : m.seeds.length / 0.15 });
			}
		};
		return w;
	};
	const jobs = Array.from({ length: 160 }, (_, i) => job(`g${i}`, 'X', seedChunk(i * 25 + 1)));
	let delivered = 0;
	const pool = createGlobalsimPool({ factory, threads: 2, onChunk: () => { delivered++; } });
	const res = await pool.runJobs(jobs);
	t.deepEqual(res.errors, [], 'no errors');
	t.ok(gpuRuns.length >= 2, 'the fitted lane keeps taking work');
	t.ok(gpuRuns[0].length >= 1900 && gpuRuns[0].length <= 2100, `the first chunk aims at the 4,500 ms target: got ${gpuRuns[0].length} seeds`);
	t.equal(delivered, 160, 'every job still delivers its own chunk');
	pool.dispose();
	__testResetGpuFit();
	t.end();
});

test('startup model: the measured floor, slope and open open the lane on a mid-sized batch', async t => {
	// 50 jobs of 25 seeds project about 4.2 s of CPU drain on two threads. The
	// startup measurement (1,800 ms floor, 1.3 ms per race, 700 ms open) needs
	// 2,532 ms, so the lane pays. The old 4.2 s startup prior needed 5,137 ms and
	// held it back.
	setGpuCostModel({ floor: 1800, slope: 1.3, openMs: 700 });
	const gpuRuns: number[][] = [];
	let instance = 0;
	const factory = () => {
		const w = new FakeWorker(++instance);
		const gpu = instance === 2;
		if (gpu) w.backend = 'gpu';
		w.respond = (m, ww) => {
			if (m.type === 'prepare') ww.fire(preparedOk(m));
			else if (m.type === 'run') {
				if (gpu) gpuRuns.push(m.seeds as number[]);
				ww.fire({ ...chunkOk(m), runMs: gpu ? 1800 + 1.3 * m.seeds.length : m.seeds.length / 0.15 });
			}
		};
		return w;
	};
	const jobs = Array.from({ length: 50 }, (_, i) => job(`m${i}`, 'X', seedChunk(i * 25 + 1)));
	let delivered = 0;
	const pool = createGlobalsimPool({ factory, threads: 2, onChunk: () => { delivered++; } });
	const res = await pool.runJobs(jobs);
	t.deepEqual(res.errors, [], 'no errors');
	t.ok(gpuRuns.length >= 1, 'the lane opened on the measured model');
	t.ok(gpuRuns[0].length > 100, `the first chunk is fitted, not one job: got ${gpuRuns[0].length} seeds`);
	t.equal(delivered, 50, 'every job delivered');
	pool.dispose();
	__testResetGpuFit();
	t.end();
});

test('startup prior: without a startup model the same batch holds the lane back', async t => {
	__testResetGpuFit();
	const gpuRuns: number[][] = [];
	let instance = 0;
	const factory = () => {
		const w = new FakeWorker(++instance);
		const gpu = instance === 2;
		if (gpu) w.backend = 'gpu';
		w.respond = (m, ww) => {
			if (m.type === 'prepare') ww.fire(preparedOk(m));
			else if (m.type === 'run') {
				if (gpu) gpuRuns.push(m.seeds as number[]);
				ww.fire({ ...chunkOk(m), runMs: gpu ? 1800 + 1.3 * m.seeds.length : m.seeds.length / 0.15 });
			}
		};
		return w;
	};
	const jobs = Array.from({ length: 50 }, (_, i) => job(`p${i}`, 'X', seedChunk(i * 25 + 1)));
	const pool = createGlobalsimPool({ factory, threads: 2, onChunk: () => {} });
	const res = await pool.runJobs(jobs);
	t.deepEqual(res.errors, [], 'no errors');
	t.equal(gpuRuns.length, 0, 'the 4.2 s prior keeps the lane closed');
	pool.dispose();
	t.end();
});

test('cost fit: per-width minima ignore a contended sample', t => {
	// True cost 500 ms + 2 ms per race. The third sample was contended (the
	// host was busy) so ordinary least squares would lift the slope; the
	// per-width minimum keeps the least contended time of each width.
	const fit = __testFitGpuMinima([
		{ seeds: 600, ms: 1700 },
		{ seeds: 1200, ms: 2900 },
		{ seeds: 1200, ms: 5000 },
	]);
	t.ok(fit, 'two widths define a model');
	t.ok(Math.abs(fit!.floor - 500) < 1, `the floor stays at the idle cost: got ${fit!.floor}`);
	t.ok(Math.abs(fit!.slope - 2) < 0.05, `the slope stays at the idle cost: got ${fit!.slope}`);
	t.equal(__testFitGpuMinima([{ seeds: 600, ms: 1700 }, { seeds: 610, ms: 1900 }]), null, 'one width cannot fit a line');
	t.end();
});

test('cost fit: one update cannot move the fit by more than 30 percent', t => {
	const prev = { floor: 1000, slope: 3 };
	const wild = __testFitGpuMinima([
		{ seeds: 400, ms: 4000 },
		{ seeds: 1200, ms: 10000 },
	], prev);
	t.ok(wild, 'a fit exists');
	t.ok(wild!.floor <= prev.floor * 1.3 + 1e-9, `the floor moves at most 30 percent: got ${wild!.floor}`);
	t.ok(wild!.slope <= prev.slope * 1.3 + 1e-9, `the slope moves at most 30 percent: got ${wild!.slope}`);
	t.end();
});

test('adaptive sizing: gpuLaunchTargetMs moves the chunk width', async t => {
	// A lighter field (500 ms floor, 2 ms per race) so the launch target decides
	// the width: 2,000 ms over the 1.1 safety margin gives
	// (2000 - 500) / 2 = 750 seeds.
	__testSetGpuFit({ floor: 500, slope: 2 });
	const gpuRuns: number[][] = [];
	let instance = 0;
	const factory = () => {
		const w = new FakeWorker(++instance);
		const gpu = instance === 2;
		if (gpu) w.backend = 'gpu';
		w.respond = (m, ww) => {
			if (m.type === 'prepare') ww.fire(preparedOk(m));
			else if (m.type === 'run') {
				if (gpu) gpuRuns.push(m.seeds as number[]);
				ww.fire({ ...chunkOk(m), runMs: gpu ? 500 + 2 * m.seeds.length : m.seeds.length / 0.15 });
			}
		};
		return w;
	};
	const jobs = Array.from({ length: 200 }, (_, i) => job(`t${i}`, 'X', seedChunk(i * 25 + 1)));
	let delivered = 0;
	const pool = createGlobalsimPool({ factory, threads: 2, gpuLaunchTargetMs: 2000, onChunk: () => { delivered++; } });
	const res = await pool.runJobs(jobs);
	t.deepEqual(res.errors, [], 'no errors');
	t.ok(gpuRuns.length >= 2, 'the fitted lane keeps taking work');
	t.ok(gpuRuns[0].length >= 700 && gpuRuns[0].length <= 780, `the smaller target sizes a smaller chunk: got ${gpuRuns[0].length} seeds`);
	t.equal(delivered, 200, 'every job delivered');
	pool.dispose();
	__testResetGpuFit();
	t.end();
});

test('adaptive sizing: a lane whose model is hopeless stays idle', async t => {
	// 1,900 ms of fixed pass plus 40 ms per race: the drain-sized chunk projects
	// far below a CPU lane's 0.15 seeds/ms, so the lane takes nothing and the
	// CPU lanes carry the batch.
	__testSetGpuFit({ floor: 1900, slope: 40 });
	const gpuRuns: number[][] = [];
	let instance = 0;
	const factory = () => {
		const w = new FakeWorker(++instance);
		const gpu = instance === 2;
		if (gpu) w.backend = 'gpu';
		w.respond = (m, ww) => {
			if (m.type === 'prepare') ww.fire(preparedOk(m));
			else if (m.type === 'run') {
				if (gpu) gpuRuns.push(m.seeds as number[]);
				ww.fire({ ...chunkOk(m), runMs: gpu ? 1900 + 40 * m.seeds.length : m.seeds.length / 0.15 });
			}
		};
		return w;
	};
	const jobs = Array.from({ length: 120 }, (_, i) => job(`h${i}`, 'X', seedChunk(i * 25 + 1)));
	const delivered = new Set<number>();
	const pool = createGlobalsimPool({
		factory, threads: 2,
		onChunk: (_j, records) => { for (const r of records) delivered.add(r.seed); },
	});
	const res = await pool.runJobs(jobs);
	t.deepEqual(res.errors, [], 'no errors');
	t.equal(gpuRuns.length, 0, 'the hopeless lane never ran');
	t.equal(delivered.size, 3000, 'the CPU lanes carried every seed');
	pool.dispose();
	__testResetGpuFit();
	t.end();
});

test('shared fit: a pool whose device a sibling already fitted skips the cold probes', async t => {
	// The compare sampler, the skill chart and the optimizer run as separate
	// pools on the same device. The fit is shared, so the second pool's gpu lane
	// starts at a fitted chunk width instead of paying the cold launch.
	__testResetGpuFit();
	const mkFactory = (gpuRuns: number[][]) => {
		let instance = 0;
		return () => {
			const w = new FakeWorker(++instance);
			const gpu = instance === 2;
			if (gpu) w.backend = 'gpu';
			w.respond = (m, ww) => {
				if (m.type === 'prepare') ww.fire(preparedOk(m));
				else if (m.type === 'run') {
					if (gpu) gpuRuns.push(m.seeds as number[]);
					ww.fire({ ...chunkOk(m), runMs: gpu ? 1800 + 1.3 * m.seeds.length : m.seeds.length / 0.15 });
				}
			};
			return w;
		};
	};
	const jobs = (p: string, n: number) => Array.from({ length: n }, (_, i) => job(`${p}${i}`, 'X', seedChunk(i * 25 + 1)));
	const a: number[][] = [];
	const poolA = createGlobalsimPool({ factory: mkFactory(a), threads: 2, onChunk: () => {} });
	const ra = await poolA.runJobs(jobs('a', 200));
	poolA.dispose();
	t.deepEqual(ra.errors, [], 'pool A drained');
	t.ok(a.length >= 3, 'pool A ran enough chunks to fit the model');
	t.ok(a[0].length > 25, 'pool A paid a prior-sized cold launch first');
	const b: number[][] = [];
	const poolB = createGlobalsimPool({ factory: mkFactory(b), threads: 2, onChunk: () => {} });
	const rb = await poolB.runJobs(jobs('b', 80));
	poolB.dispose();
	t.deepEqual(rb.errors, [], 'pool B drained');
	t.ok(b.length >= 1, 'pool B used its gpu lane');
	t.ok(b[0].length >= 1800 && b[0].length <= 2100, `pool B's gpu lane starts fitted: first chunk ${b[0].length} seeds`);
	__testResetGpuFit();
	t.end();
});

test('lazy gpu lane: a named gpu factory boots the session only when the batch pays', async t => {
	// A compare-sized batch drains faster than the probe guard, so the lane
	// must not boot at all: the session open used to cost the mixed pool 2 to
	// 4 percent against all-native.
	__testResetGpuFit();
	const mk = (gpuRuns: number[][]) => {
		let cpu = 0;
		const cpuFactory = () => {
			const w = new FakeWorker(++cpu);
			w.backend = 'native';
			w.respond = (m, ww) => {
				if (m.type === 'prepare') ww.fire(preparedOk(m));
				else if (m.type === 'run') ww.fire({ ...chunkOk(m), runMs: m.seeds.length / 0.15 });
			};
			return w;
		};
		let gpu = 0;
		const gpuFactory = () => {
			const w = new FakeWorker(100 + ++gpu);
			w.backend = 'gpu';
			w.respond = (m, ww) => {
				if (m.type === 'prepare') ww.fire(preparedOk(m));
				else if (m.type === 'run') { gpuRuns.push(m.seeds as number[]); ww.fire({ ...chunkOk(m), runMs: 1800 + 1.3 * m.seeds.length }); }
			};
			return w;
		};
		return { cpuFactory, gpuFactory, gpuCount: () => gpu };
	};
	const small: number[][] = [];
	const a = mk(small);
	const jobsA = Array.from({ length: 20 }, (_, i) => job(`s${i}`, 'X', seedChunk(i * 25 + 1)));
	const poolA = createGlobalsimPool({ factory: a.cpuFactory, gpuFactory: a.gpuFactory, threads: 2, onChunk: () => {} });
	const ra = await poolA.runJobs(jobsA);
	poolA.dispose();
	t.deepEqual(ra.errors, [], 'small batch drained');
	t.equal(a.gpuCount(), 0, 'a short batch never boots the gpu session');
	t.equal(small.length, 0, 'and its lane takes no work');

	const big: number[][] = [];
	const b = mk(big);
	const jobsB = Array.from({ length: 120 }, (_, i) => job(`b${i}`, 'X', seedChunk(i * 25 + 1)));
	const poolB = createGlobalsimPool({ factory: b.cpuFactory, gpuFactory: b.gpuFactory, threads: 2, onChunk: () => {} });
	const rb = await poolB.runJobs(jobsB);
	poolB.dispose();
	t.deepEqual(rb.errors, [], 'big batch drained');
	t.equal(b.gpuCount(), 1, 'a batch that can pay boots exactly one gpu session');
	t.ok(big[0].length > 25 && big[0].length <= 2075, `its first chunk is prior-sized: ${big[0].length} seeds`);
	t.end();
});

test('gpu lane start: auto and eager share the drain gate', async t => {
	// The lane pays a session open plus one host pass, so a batch whose
	// remaining CPU drain cannot cover GPU_LANE_PAY_MS opens no session under
	// either policy. A batch that can pay opens one and gives it chunks.
	__testResetGpuFit();
	let gpuSessions = 0;
	const gpuRuns: number[][] = [];
	let cpu = 0;
	const cpuFactory = () => {
		const w = new FakeWorker(++cpu);
		w.backend = 'native';
		w.respond = (m, ww) => {
			if (m.type === 'prepare') ww.fire(preparedOk(m));
			else if (m.type === 'run') ww.fire({ ...chunkOk(m), runMs: m.seeds.length / 0.15 });
		};
		return w;
	};
	const gpuFactory = () => {
		const w = new FakeWorker(100 + ++gpuSessions);
		w.backend = 'gpu';
		w.respond = (m, ww) => {
			if (m.type === 'prepare') ww.fire(preparedOk(m));
			else if (m.type === 'run') { gpuRuns.push(m.seeds as number[]); ww.fire({ ...chunkOk(m), runMs: 1800 + 1.3 * m.seeds.length }); }
		};
		return w;
	};
	const small = Array.from({ length: 20 }, (_, i) => job(`e${i}`, 'X', seedChunk(i * 25 + 1)));
	for (const policy of ['auto', 'eager'] as const) {
		const p = createGlobalsimPool({ factory: cpuFactory, gpuFactory, gpuLane: policy, threads: 2, onChunk: () => {} });
		const r = await p.runJobs(small);
		p.dispose();
		t.deepEqual(r.errors, [], `${policy}: the small batch drained on the CPU lanes`);
		t.equal(gpuSessions, 0, `${policy}: a batch too small to pay opens no session`);
	}
	// 3,000 seeds at two 0.15 seeds/ms lanes project a 10 s drain, which covers
	// the lane's pay floor.
	const big = Array.from({ length: 120 }, (_, i) => job(`b${i}`, 'X', seedChunk(i * 25 + 1)));
	const pool = createGlobalsimPool({ factory: cpuFactory, gpuFactory, gpuLane: 'eager', threads: 2, onChunk: () => {} });
	const r = await pool.runJobs(big);
	pool.dispose();
	t.deepEqual(r.errors, [], 'the big batch drained');
	t.equal(gpuSessions, 1, 'one session for the batch that can pay');
	t.ok(gpuRuns.length >= 1, 'and the lane carried work');
	t.end();
});

test('shared fit: a pool with several gpu sessions does not publish its model', async t => {
	// Several gpu sessions on one device contend, so their chunk costs are not
	// a single lane's cost. Pool A is homogeneous gpu (two sessions), and its
	// chunks must leave the process-wide model unset.
	__testResetGpuFit();
	let instance = 0;
	const factory = () => {
		const w = new FakeWorker(++instance);
		w.backend = 'gpu';
		w.respond = (m, ww) => {
			if (m.type === 'prepare') ww.fire(preparedOk(m));
			else if (m.type === 'run') ww.fire({ ...chunkOk(m), runMs: 1800 + 1.3 * m.seeds.length });
		};
		return w;
	};
	const poolA = createGlobalsimPool({ factory, threads: 2, onChunk: () => {} });
	const ra = await poolA.runJobs(Array.from({ length: 200 }, (_, i) => job(`h${i}`, 'X', seedChunk(i * 25 + 1))));
	poolA.dispose();
	t.deepEqual(ra.errors, [], 'homogeneous pool drained');
	t.equal(__testGetGpuFit(), null, 'a multi-session pool leaves the shared model alone');
	t.end();
});

test('rotation: the gpu backend never takes a rotation slot', t => {
	// The gpu is the pool's extra lane now, opened through a pinned session
	// the pool counts on top of its CPU threads. A rotated gpu session would
	// take a thread slot, which is the old setup N2 removes.
	let turn = 0;
	const seq: string[] = [];
	for (let i = 0; i < 6; i++) {
		const picked = pickRotationBackend(['wasm', 'native', 'gpu'] as Backend[], turn);
		seq.push(picked.backend);
		turn = picked.turn;
	}
	t.deepEqual(seq, ['wasm', 'native', 'wasm', 'native', 'wasm', 'native'], 'only CPU backends rotate');
	t.deepEqual(pickRotationBackend(['gpu'] as Backend[], 0), { backend: 'wasm', turn: 0 }, 'a gpu-only list falls back to wasm');
	t.deepEqual(pickRotationBackend([], 0), { backend: 'wasm', turn: 0 }, 'empty list falls back to wasm');
	t.end();
});


test('gpu batch lane: a failed prepare of a merged batch errors every part', async t => {
	const { workers, factory } = scripted((m, w) => {
		if (m.type === 'prepare') w.fire({ type: 'prepared', id: m.id, setupKey: m.setupKey, ok: false, error: 'geometry fetch 404', dead: false });
	}, 'gpu');
	const pool = createGlobalsimPool({ factory, threads: 1 });
	const res = await pool.runJobs([job('p1', 'X', [1]), job('p2', 'X', [2])]);
	t.deepEqual(res.errors.map(e => e.jobId).sort(), ['p1', 'p2'], 'the shared prepare failure is reported to every gathered job');
	t.equal(workers[0].sent.filter(m => m.type === 'prepare').length, 1, 'one prepare for the merged batch');
	pool.dispose();
	t.end();
});

test('gpu batch lane: a dead merged chunk requeues each part exactly once', async t => {
	const { workers, factory } = scripted((m, w) => {
		if (m.type === 'prepare') w.fire(preparedOk(m));
		else if (m.type === 'run') w.fire({ type: 'chunk', jobId: m.jobId, mode: m.mode, ok: false, dead: true, error: 'engine panic: boom', processed: 0, records: [] });
	}, 'gpu');
	const jobs = [job('d1', 'X', [1]), job('d2', 'X', [2]), job('d3', 'X', [3])];
	const pool = createGlobalsimPool({ factory, threads: 1 });
	const res = await pool.runJobs(jobs);
	t.deepEqual(res.errors.map(e => e.jobId).sort(), ['d1', 'd2', 'd3'], 'every part lands as its own job error');
	const runs = workers.reduce((n, w) => n + w.sent.filter(m => m.type === 'run').length, 0);
	t.equal(runs, 2, 'the merged batch ran exactly twice (original + one requeue per part)');
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
	// Regression: a worker that does NOT report `held` (the legacy core
	// semantics this fake models) can be left holding NO preparation by a
	// failed prepare. The pool must empty slot.held on a non-dead prepare
	// failure when the worker reports no LRU — keeping the previous key would
	// make dispatch bare-run the next matching job into the worker's
	// "no preparation" reply: a permanent job error for every later job of
	// that setup, for the pool's lifetime. (The §H LRU core keeps the other
	// entries and says so via `held`; see the LRU test below.)
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

test('buildCompareJobs: stream mode is part of the setupKey — paired and retail never share a preparation', t => {
	// pool.ts reuses a live preparation on setupKey equality alone, so the
	// same setup measured in the two stream modes must never fold into it.
	const seeds = globalsimSeedList(20261114, 30);
	const mk = (over: Partial<GlobalsimCompareInput>) => compareInput({ fixedGate: 3, ...over });
	const retail = buildCompareJobs(mk({}), seeds, 'compact');
	const off = buildCompareJobs(mk({ paired: false }), seeds, 'compact');
	const paired = buildCompareJobs(mk({ paired: true }), seeds, 'compact');
	t.deepEqual(retail.errors, []);
	t.deepEqual(paired.errors, []);
	const retailKeys = new Set(retail.jobs.map(j => j.setupKey));
	const offKeys = new Set(off.jobs.map(j => j.setupKey));
	const pairedKeys = new Set(paired.jobs.map(j => j.setupKey));
	t.deepEqual([...retailKeys], [...offKeys], 'explicit false == default (retail): identical keys');
	// The mode-tagged keys sit where the old bare keys were: same segment count,
	// every retail key has exactly one paired counterpart and none are shared.
	t.equal(retailKeys.size, 2, 'one preparation per variant');
	t.equal(pairedKeys.size, 2);
	t.equal([...retailKeys].filter(k => pairedKeys.has(k)).length, 0, 'no key appears in both modes');
	for (const k of pairedKeys) t.ok(k.includes('|pair|'), 'paired setupKey carries the pair mode tag');
	for (const k of retailKeys) t.ok(k.includes('|retail|'), 'retail setupKey carries the retail mode tag');
	// Head-to-head keys carry the mode too (both mirrored variants).
	const h2hRetail = buildCompareJobs(mk({ fieldLayout: 'h2h' }), seeds, 'compact');
	const h2hPaired = buildCompareJobs(mk({ fieldLayout: 'h2h', paired: true }), seeds, 'compact');
	t.equal(h2hRetail.jobs.length, 4, '2 chunks × 2 mirrored variants (30 seeds / 25 per chunk)');
	t.equal(h2hPaired.jobs.length, 4);
	for (let i = 0; i < h2hRetail.jobs.length; i++) {
		t.equal(h2hRetail.jobs[i].id, h2hPaired.jobs[i].id, 'same job ids in the same order');
		t.equal(h2hPaired.jobs[i].setupKey.replace('|pair|', '|retail|'), h2hRetail.jobs[i].setupKey,
			'h2h keys differ ONLY in the mode segment');
	}
	// The request follows the key: the flag is on exactly for paired jobs.
	t.ok(paired.jobs.every(j => (j.request as any).pairedRandomStreams === true), 'paired jobs ship the flag');
	t.ok(retail.jobs.every(j => !('pairedRandomStreams' in (j.request as any))), 'retail jobs ship no flag');
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

// ── gpu fallback rerun lane: per-job tally (handoff step 5) ─────────────────

/** Sampling worker answering like the gpu lane: refused seeds as {seed, gpuFallback}. */
function gpuScripted(refuse: (seed: number) => string | undefined) {
	return scripted((m, w) => {
		if (m.type === 'prepare') w.fire(preparedOk(m));
		else if (m.type === 'run') w.fire({
			type: 'chunk', jobId: m.jobId, mode: m.mode, ok: true,
			records: m.seeds.map((seed: number) => {
				const fb = refuse(seed);
				return fb ? { seed, gpuFallback: fb } : { seed, finishTimeRaw: 10, finishOrder: 0 };
			}),
		});
	});
}

/** CPU rerun lane answering every seed with a finishTimeRaw: 77 record (failChunk models a dead rerun). */
function cpuLane(failChunk = false) {
	return scripted((m, w) => {
		if (m.type === 'prepare') w.fire(preparedOk(m));
		else if (m.type === 'run') {
			if (failChunk) w.fire({ type: 'chunk', jobId: m.jobId, mode: m.mode, ok: false, dead: false, error: 'rerun boom' });
			else w.fire({ type: 'chunk', jobId: m.jobId, mode: m.mode, ok: true, records: m.seeds.map((seed: number) => ({ seed, finishTimeRaw: 77, finishOrder: 0 })) });
		}
	});
}

/** Run fn with console.warn captured (the pool reports refused jobs through it). */
async function captureWarns<T>(fn: () => Promise<T>): Promise<{ warns: string[]; res: T }> {
	const warns: string[] = [];
	const orig = console.warn;
	console.warn = (...args: any[]) => { warns.push(args.join(' ')); };
	try { return { warns, res: await fn() }; } finally { console.warn = orig; }
}

test('gpu fallback tally: refusals counted by reason, CPU records replace them at delivery', async t => {
	const { factory } = gpuScripted(seed => seed % 2 === 0 ? 'startup mode' : seed === 5 ? 'grid mode' : undefined);
	const cpu = cpuLane();
	const delivered: any[][] = [];
	const pool = createGlobalsimPool({ factory, cpuFactory: cpu.factory, threads: 1, onChunk: (_j, records) => { delivered.push(records); } });
	const { warns, res } = await captureWarns(() => pool.runJobs([job('g1', 'X', [1, 2, 3, 4, 5])]));
	pool.dispose();
	t.deepEqual(res.errors, [], 'no job errors');
	t.equal(delivered.length, 1, 'one merged chunk delivered');
	const bySeed = new Map<number, any>(delivered[0].map((r: any) => [r.seed, r]));
	t.equal(bySeed.get(1).finishTimeRaw, 10, 'gpu-ran record passes through untouched');
	t.equal(bySeed.get(2).finishTimeRaw, 77, 'refusal replaced by the CPU rerun record');
	t.equal(bySeed.get(5).finishTimeRaw, 77, 'second refusal replaced too');
	t.deepEqual(res.gpuFallbacks, [{ jobId: 'g1', races: 5, fallbacks: { 'startup mode': 2, 'grid mode': 1 }, rerunFailures: 0 }],
		'tally in the runJobs result counts every refusal by reason');
	t.equal(warns.length, 1, 'one console line for the refused job');
	t.ok(warns[0].includes('job g1') && warns[0].includes('gpu races 5') && warns[0].includes('startup mode: 2') && warns[0].includes('grid mode: 1') && warns[0].includes('rerun failures 0'),
		`the line names jobId, races, reasons and failures: ${warns[0]}`);
	t.end();
});

test('gpu fallback tally: without cpuFactory every refusal is a rerun failure', async t => {
	const { factory } = gpuScripted(() => 'startup mode');
	const delivered: any[][] = [];
	const pool = createGlobalsimPool({ factory, threads: 1, onChunk: (_j, records) => { delivered.push(records); } });
	const { warns, res } = await captureWarns(() => pool.runJobs([job('nolane', 'X', [1, 2])]));
	pool.dispose();
	t.deepEqual(res.errors, [], 'refusals become record errors, not job errors');
	t.deepEqual(res.gpuFallbacks, [{ jobId: 'nolane', races: 2, fallbacks: { 'startup mode': 2 }, rerunFailures: 2 }],
		'tally counts the refusals and the missing rerun lane');
	t.ok(delivered[0].length === 2 && delivered[0].every((r: any) => /cpuFactory/.test(String(r.error))),
		'every seed delivered as a {seed, error} record');
	t.equal(warns.length, 1, 'one console line');
	t.ok(warns[0].includes('rerun failures 2'), `the line reports the failures: ${warns[0]}`);
	t.end();
});

test('gpu fallback tally: a failing rerun chunk counts as rerun failures', async t => {
	const { factory } = gpuScripted(seed => seed === 2 ? 'startup mode' : undefined);
	const cpu = cpuLane(true);
	const delivered: any[][] = [];
	const pool = createGlobalsimPool({ factory, cpuFactory: cpu.factory, threads: 1, onChunk: (_j, records) => { delivered.push(records); } });
	const { res } = await captureWarns(() => pool.runJobs([job('rlane', 'X', [1, 2])]));
	pool.dispose();
	t.deepEqual(res.errors, [], 'the chunk still delivers, as error records');
	const bySeed = new Map<number, any>(delivered[0].map((r: any) => [r.seed, r]));
	t.equal(bySeed.get(1).finishTimeRaw, 10, 'gpu-ran record untouched');
	t.ok(/rerun boom/.test(String(bySeed.get(2).error)), `the refusal carries the rerun failure reason: ${bySeed.get(2).error}`);
	t.deepEqual(res.gpuFallbacks, [{ jobId: 'rlane', races: 2, fallbacks: { 'startup mode': 1 }, rerunFailures: 1 }],
		'tally counts the failed rerun separately from the refusals');
	t.end();
});

test('gpu fallback tally: a fallback-free batch reports nothing', async t => {
	const { factory } = scripted((m, w) => {
		if (m.type === 'prepare') w.fire(preparedOk(m));
		else if (m.type === 'run') w.fire(chunkOk(m));
	});
	const pool = createGlobalsimPool({ factory, cpuFactory: cpuLane().factory, threads: 1, onChunk: () => {} });
	const { warns, res } = await captureWarns(() => pool.runJobs([job('clean', 'X', [1, 2, 3])]));
	pool.dispose();
	t.deepEqual(res.gpuFallbacks, [], 'no tallies without refusals');
	t.deepEqual(warns, [], 'console stays silent for the common case');
	t.end();
});

// ── gpu group lane: cross-setup packing (the app compare shape) ─────────────

/** A compare-shaped request: the 9 runners and course the pool's group
 *  compatibility test reads (the app compare field's setup keys share both). */
function laneRequest(courseId = 10611, runners = 9): any {
	return { courseId, horses: Array.from({ length: runners }, (_, i) => ({ gateIndex: i })) };
}

function jobWith(id: string, setupKey: string, seeds: number[], request: any, extra: Partial<PoolJob> = {}): PoolJob {
	return { id, setupKey, request, seeds, mode: 'compact', ...extra };
}

/** gpu worker that reports the multi-preparation entry and answers a parts
 *  message in part order, tagging each record with its part index. */
function gpuGroupScripted() {
	return scripted((m, w) => {
		if (m.type === 'prepare') w.fire({ ...preparedOk(m), multi: true });
		else if (m.type === 'run') {
			if (Array.isArray(m.parts)) {
				const records: any[] = [];
				m.parts.forEach((part: any, i: number) => {
					for (const seed of part.seeds) records.push({ seed, part: i, finishTimeRaw: 10, finishOrder: 0 });
				});
				w.fire({ type: 'chunk', jobId: m.jobId, mode: m.mode, ok: true, records });
			} else w.fire(chunkOk(m));
		}
	}, 'gpu');
}

test('gpu group lane: compatible setup keys answer in ONE run message and split back per job', async t => {
	const { workers, factory } = gpuGroupScripted();
	const got = new Map<string, any[]>();
	const pool = createGlobalsimPool({
		factory, threads: 1,
		onChunk: (j, records) => got.set(j.id, records),
	});
	const req = laneRequest();
	const jobs = [
		jobWith('g1', 'A', [1, 2], req),
		jobWith('g2', 'B', [3, 4], req),
		jobWith('g3', 'C', [5], req),
		jobWith('g4', 'D', [6, 7, 8], req),
	];
	const res = await pool.runJobs(jobs);
	pool.dispose();
	t.deepEqual(res.errors, [], 'no errors');
	const runs = workers[0].sent.filter(m => m.type === 'run');
	t.equal(runs.length, 1, 'one run message for the whole batch');
	t.equal(runs[0].parts.length, 4, 'one part per queued job');
	t.deepEqual(runs[0].parts.map((p: any) => p.setupKey), ['A', 'B', 'C', 'D'], 'parts in queue order');
	t.deepEqual(runs[0].seeds, [1, 2, 3, 4, 5, 6, 7, 8], 'flat seed list in queue order');
	t.equal(workers[0].sent.filter(m => m.type === 'prepare').length, 1,
		'only the head preparation is prepared; the other parts ride its launch');
	const partsOf: Record<string, number> = { g1: 0, g2: 1, g3: 2, g4: 3 };
	for (const job of jobs) {
		const records = got.get(job.id);
		t.ok(records, `${job.id} delivered`);
		t.deepEqual(records!.map((r: any) => r.seed), job.seeds, `${job.id} got exactly its own seeds`);
		t.deepEqual(records!.map((r: any) => r.part), job.seeds.map(() => partsOf[job.id]),
			`${job.id} got its own part's records`);
	}
	t.end();
});

test('gpu group lane: equal seed values in different setup keys stay with their own job', async t => {
	// The compare view runs variant 0 and variant 1 on the SAME seed, so a
	// seed-keyed split would hand one key's records to the other job.
	const { workers, factory } = gpuGroupScripted();
	const got = new Map<string, any[]>();
	const pool = createGlobalsimPool({
		factory, threads: 1,
		onChunk: (j, records) => got.set(j.id, records),
	});
	const req = laneRequest();
	const res = await pool.runJobs([
		jobWith('v0', 'K0', [7, 8, 9], req),
		jobWith('v1', 'K1', [7, 8, 9], req),
	]);
	pool.dispose();
	t.deepEqual(res.errors, [], 'no errors');
	t.equal(workers[0].sent.filter(m => m.type === 'run').length, 1, 'one run message');
	t.deepEqual(got.get('v0')!.map((r: any) => r.part), [0, 0, 0], 'variant 0 kept part 0');
	t.deepEqual(got.get('v1')!.map((r: any) => r.part), [1, 1, 1], 'variant 1 kept part 1');
	t.deepEqual(got.get('v0')!.map((r: any) => r.seed), [7, 8, 9], 'variant 0 seeds');
	t.deepEqual(got.get('v1')!.map((r: any) => r.seed), [7, 8, 9], 'variant 1 seeds');
	t.end();
});

test('gpu group lane: packing needs the group capability and matching launch limits', async t => {
	// A lane with the one-preparation batch seam but no group entry keeps one
	// run message per setup key.
	{
		const { workers, factory } = scripted((m, w) => {
			if (m.type === 'prepare') w.fire(preparedOk(m));
			else if (m.type === 'run') w.fire(chunkOk(m));
		}, 'gpu');
		const pool = createGlobalsimPool({ factory, threads: 1, onChunk: () => {} });
		await pool.runJobs([jobWith('a', 'A', [1], laneRequest()), jobWith('b', 'B', [2], laneRequest())]);
		pool.dispose();
		t.equal(workers[0].sent.filter(m => m.type === 'run').length, 2,
			'a lane without the group entry keeps one message per setup key');
	}
	const mismatches: Array<[string, PoolJob]> = [
		['runner count', jobWith('b', 'B', [2], laneRequest(10611, 8))],
		['course', jobWith('b', 'B', [2], laneRequest(10504, 9))],
		['frame-row mode', jobWith('b', 'B', [2], laneRequest(), { secondPlayerIndex: 3 })],
		['record mode', jobWith('b', 'B', [2], laneRequest(), { mode: 'full' })],
	];
	for (const [label, other] of mismatches) {
		const { workers, factory } = gpuGroupScripted();
		const pool = createGlobalsimPool({ factory, threads: 1, onChunk: () => {} });
		await pool.runJobs([jobWith('a', 'A', [1], laneRequest()), other]);
		pool.dispose();
		t.equal(workers[0].sent.filter(m => m.type === 'run').length, 2,
			`no merge across a different ${label}`);
	}
	t.end();
});

test('gpu group lane: a multi reply out of part order falls back to the seed split', async t => {
	// Parts with distinct seeds: a seed-keyed split is still exact, so the
	// pool may use it when a backend answers out of part order.
	const { factory } = scripted((m, w) => {
		if (m.type === 'prepare') w.fire({ ...preparedOk(m), multi: true });
		else if (m.type === 'run') w.fire({
			type: 'chunk', jobId: m.jobId, mode: m.mode, ok: true,
			records: m.seeds.map((seed: number) => ({ seed, finishTimeRaw: 10, finishOrder: 0 })).reverse(),
		});
	}, 'gpu');
	const got = new Map<string, number[]>();
	const pool = createGlobalsimPool({ factory, threads: 1, onChunk: (j, records) => got.set(j.id, records.map((r: any) => r.seed)) });
	const { warns, res } = await captureWarns(() => pool.runJobs([
		jobWith('a', 'A', [1, 2], laneRequest()),
		jobWith('b', 'B', [3, 4], laneRequest()),
	]));
	pool.dispose();
	t.deepEqual(res.errors, [], 'no job errors');
	t.deepEqual(got.get('a')!.sort(), [1, 2], 'first job still got its seeds');
	t.deepEqual(got.get('b')!.sort(), [3, 4], 'second job still got its seeds');
	t.ok(warns.some(w => /not in part order/.test(w)), `the fallback warns: ${warns.join(' | ')}`);
	t.end();
});

test('gpu group lane: an out-of-order reply with duplicate seeds reports per-seed errors', async t => {
	// The compare shapes share seed values across keys. A reply that neither
	// lines up positionally nor splits by seed must not silently pair records
	// with the wrong job.
	const { factory } = scripted((m, w) => {
		if (m.type === 'prepare') w.fire({ ...preparedOk(m), multi: true });
		else if (m.type === 'run') w.fire({
			type: 'chunk', jobId: m.jobId, mode: m.mode, ok: true,
			records: m.seeds.map((seed: number) => ({ seed, finishTimeRaw: 10, finishOrder: 0 })).reverse(),
		});
	}, 'gpu');
	const got = new Map<string, any[]>();
	const pool = createGlobalsimPool({ factory, threads: 1, onChunk: (j, records) => got.set(j.id, records) });
	const { warns, res } = await captureWarns(() => pool.runJobs([
		jobWith('v0', 'K0', [7, 8], laneRequest()),
		jobWith('v1', 'K1', [7, 8], laneRequest()),
	]));
	pool.dispose();
	t.deepEqual(res.errors, [], 'no job errors');
	for (const id of ['v0', 'v1']) {
		t.equal(got.get(id)!.length, 2, `${id} still reports every seed`);
		t.ok(got.get(id)!.every((r: any) => typeof r.error === 'string' && /did not line up/.test(r.error)),
			`${id} reports per-seed errors instead of mispaired records`);
	}
	t.ok(warns.some(w => /did not line up/.test(w)), `the fallback warns: ${warns.join(' | ')}`);
	t.end();
});

test('gpu group lane: a refused part flags its own seeds and the rerun lane replaces them', async t => {
	// One packed part's request is refused by the kernel (gpuFallback), the
	// other part answers. The rerun lane must replace only the refused job's
	// records, and the tally must name it alone.
	const { factory } = scripted((m, w) => {
		if (m.type === 'prepare') w.fire({ ...preparedOk(m), multi: true });
		else if (m.type === 'run') {
			const parts = Array.isArray(m.parts) ? m.parts : [{ seeds: m.seeds }];
			const records: any[] = [];
			parts.forEach((part: any, i: number) => {
				for (const seed of part.seeds) records.push(i === 1 ? { seed, gpuFallback: 'startup mode' } : { seed, finishTimeRaw: 10, finishOrder: 0 });
			});
			w.fire({ type: 'chunk', jobId: m.jobId, mode: m.mode, ok: true, records });
		}
	}, 'gpu');
	const cpu = cpuLane();
	const got = new Map<string, any[]>();
	const pool = createGlobalsimPool({
		factory, cpuFactory: cpu.factory, threads: 1,
		onChunk: (j, records) => got.set(j.id, records),
	});
	const req = laneRequest();
	const { warns, res } = await captureWarns(() => pool.runJobs([
		jobWith('good', 'A', [1, 2], req),
		jobWith('refused', 'B', [3, 4], req),
	]));
	pool.dispose();
	t.deepEqual(res.errors, [], 'no job errors');
	t.deepEqual(got.get('good')!.map((r: any) => r.finishTimeRaw), [10, 10], 'the clean part passes through untouched');
	t.deepEqual(got.get('refused')!.map((r: any) => r.finishTimeRaw), [77, 77], 'the refused part is replaced by the CPU rerun records');
	t.deepEqual(res.gpuFallbacks, [{ jobId: 'refused', races: 2, fallbacks: { 'startup mode': 2 }, rerunFailures: 0 }],
		'the tally names only the refused job');
	t.ok(warns.some(w => /job refused/.test(w)), `the rerun lane reports the refused job: ${warns.join(' | ')}`);
	t.end();
});
// ── gated work stays off the device lane ─────────────────────────────────────

function gatedJob(id: string, setupKey: string, seeds: number[]): PoolJob {
	return { ...job(id, setupKey, seeds), gates: seeds.map(() => 0) };
}

test('gpu lane: a gated-only batch boots no session and the CPU lanes take it all', async t => {
	// The device lane has no gated compact entry: a gated chunk sent there came
	// back as per-seed errors, which the optimizer folded as 'err' slots and the
	// search read as measured data. A batch that only carries gated work must
	// not open the session at all.
	__testResetGpuFit();
	let gpuSessions = 0;
	const gpuRuns: any[] = [];
	let cpu = 0;
	const cpuFactory = () => {
		const w = new FakeWorker(++cpu);
		w.backend = 'native';
		w.respond = (m, ww) => {
			if (m.type === 'prepare') ww.fire(preparedOk(m));
			else if (m.type === 'run') ww.fire({ ...chunkOk(m), runMs: m.seeds.length / 0.15 });
		};
		return w;
	};
	const gpuFactory = () => {
		const w = new FakeWorker(100 + ++gpuSessions);
		w.backend = 'gpu';
		w.respond = (m, ww) => {
			if (m.type === 'prepare') ww.fire(preparedOk(m));
			else if (m.type === 'run') { gpuRuns.push(m); ww.fire({ ...chunkOk(m), runMs: 1800 + 1.3 * m.seeds.length }); }
		};
		return w;
	};
	const gated = Array.from({ length: 120 }, (_, i) => gatedJob(`d${i}`, 'X', seedChunk(i * 25 + 1)));
	let delivered = 0;
	const pool = createGlobalsimPool({ factory: cpuFactory, gpuFactory, threads: 2, onChunk: () => { delivered++; } });
	const res = await pool.runJobs(gated);
	t.deepEqual(res.errors, [], 'no errors');
	t.equal(gpuSessions, 0, 'a gated-only batch boots no gpu session');
	t.equal(gpuRuns.length, 0, 'and the device lane takes no chunk');
	t.equal(delivered, 120, 'every gated job still delivers');
	pool.dispose();
	t.end();
});

test('gpu lane: a mixed batch gives the lane only ungated work', async t => {
	// The optimizer's foreground gate batch and a gate-split background chunk
	// can share one batch. The lane may take the ungated jobs, and every gated
	// seed must run on a CPU worker.
	__testResetGpuFit();
	let gpuSessions = 0;
	const gpuRuns: any[] = [];
	const cpuRuns: any[] = [];
	let cpu = 0;
	const cpuFactory = () => {
		const w = new FakeWorker(++cpu);
		w.backend = 'native';
		w.respond = (m, ww) => {
			if (m.type === 'prepare') ww.fire(preparedOk(m));
			else if (m.type === 'run') { cpuRuns.push(m); ww.fire({ ...chunkOk(m), runMs: m.seeds.length / 0.15 }); }
		};
		return w;
	};
	const gpuFactory = () => {
		const w = new FakeWorker(100 + ++gpuSessions);
		w.backend = 'gpu';
		w.respond = (m, ww) => {
			if (m.type === 'prepare') ww.fire(preparedOk(m));
			else if (m.type === 'run') { gpuRuns.push(m); ww.fire({ ...chunkOk(m), runMs: 1800 + 1.3 * m.seeds.length }); }
		};
		return w;
	};
	const gated = Array.from({ length: 60 }, (_, i) => gatedJob(`d${i}`, 'G', seedChunk(i * 25 + 1)));
	const plain = Array.from({ length: 60 }, (_, i) => job(`p${i}`, 'P', seedChunk(i * 25 + 1)));
	let delivered = 0;
	const pool = createGlobalsimPool({ factory: cpuFactory, gpuFactory, threads: 2, onChunk: () => { delivered++; } });
	const res = await pool.runJobs([...gated, ...plain]);
	t.deepEqual(res.errors, [], 'no errors');
	t.equal(delivered, 120, 'every job delivers once');
	t.ok(gpuRuns.length > 0, 'the lane took the ungated work');
	t.ok(gpuRuns.every(m => !m.gates), 'no gated chunk ever reaches the device lane');
	const cpuGated = cpuRuns.filter(m => m.gates).reduce((n, m) => n + m.seeds.length, 0);
	t.equal(cpuGated, 60 * 25, 'all gated seeds ran on CPU workers');
	pool.dispose();
	t.end();
});
