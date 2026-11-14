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
	autoThreadCount, resolveThreadCount, loadThreadsOption, saveThreadsOption,
	THREADS_STORAGE_KEY, MAX_THREADS, AUTO_THREADS_MAX,
} from './pool';
import { buildCompareJobs, globalsimSeedList, GlobalsimCompareInput, DEFAULT_CHUNK_SIZE } from './compare';
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

// ── thread option (§4.1) ─────────────────────────────────────────────────────

test('auto thread count clamps hardwareConcurrency−1 to [1, 8]', t => {
	t.equal(autoThreadCount(2), 1);
	t.equal(autoThreadCount(1), 1);
	t.equal(autoThreadCount(9), 8);
	t.equal(autoThreadCount(64), AUTO_THREADS_MAX);
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
	t.equal(resolveThreadCount(999), MAX_THREADS, 'fixed option clamped to 16');
	t.equal(resolveThreadCount('auto'), autoThreadCount(), 'auto path');
	saveThreadsOption('auto');
	t.equal(store.get(THREADS_STORAGE_KEY), 'auto');
	store.set(THREADS_STORAGE_KEY, 'garbage');
	t.equal(loadThreadsOption(), 'auto', 'bad stored value falls back to auto');
	delete (globalThis as any).localStorage;
	t.equal(loadThreadsOption(), 'auto', 'no localStorage at all → auto');
	t.end();
});
