/**
 * GlobalSim skill-chart acceptance tests (Phase 5 of the integration plan).
 *
 * Run: npm run test:globalsim-chart  (from the repo root)
 *
 * (a) REAL wasm (node bridge of compare.acceptance.test.ts): known-good
 *     covered speed skill 200011 on a plain build ⇒ mean margin > 0 with
 *     win rate > 0.5 over 50 paired seeds (round 1: 25, filter keeps it,
 *     round 2 adds 25). Also proves trackSkillId → activations through the
 *     real engine reply (activationMean > 0).
 * (b) Control: covered white skill 200241 whose ONLY condition is
 *     weather==4 (Snowy) while the test race is Sunny ⇒ mean margin ≈ 0
 *     within ±0.15 L (actual values printed as comments). Supplement ids
 *     like 110271 are NOT usable here — see the (b) header note.
 * (c) Determinism: the same seed list twice ⇒ identical aggregates.
 * (d) Pool abort mid-run (pool.test.ts-style FAKE factory): the chart
 *     promise rejects with AbortError, every worker terminates, nothing is
 *     dispatched after the abort.
 * (e) Offline aggregate math: fake compact records through the chart
 *     collector ⇒ streaming merge (B-before-A order), win/tie rates, median,
 *     round-2 merge-on-top, 95% CI, and activation stats match metrics.ts
 *     computed independently.
 */

// Same CC_GLOBAL-before-import trick as compare.acceptance.test.ts.
(globalThis as any).CC_GLOBAL = true;

import test from 'tape';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { HorseState, SkillSet } from '../../../../components/HorseDefTypes';
import { GroundCondition, Weather, Season, Time } from '../../../../uma-skill-tools/RaceParameters';
import { parseMobPresets } from './mobs';
import type { WorkerFactory, WorkerLike, PoolJob } from './pool';
import { createGlobalsimWorkerCore, WasmApi } from './workerCore';
import {
	runGlobalsimSkillChart, createChartCollector, buildGlobalsimChartJobs, withSkillSwappedIn,
	GlobalsimSkillChartInput, CHART_FILTER_MAX_L, CHART_FILTER_SPREAD_L,
	CHART_DEFAULT_SEEDS, CHART_MAX_SEEDS, resolveChartSeedCount,
} from './chart';
import { newAggregate, addPair, summarizeAggregate, ci95, medianOf, SeedCompactRecord } from './metrics';
import type { SkillChartResult } from '../../skill-chart-types';

// ── engine fixtures (identical bridge pattern to compare.acceptance.test.ts) ──

const repoRoot = path.resolve(__dirname, '../../../../');
const pkgDir = path.join(repoRoot, 'globalsim-wasm', 'pkg');
const geomDir = path.join(repoRoot, 'vendor', 'GlobalSim', 'data', 'course_geometry');
const courseIds: string[] = Object.keys(require(path.join(repoRoot, 'vendor/GlobalSim/data/course_data.json')));
// Chart MECHANICS suite: round-1 filter margins and round counts are tuned
// against a bare field, so the shipped "default" (baseline builds, much
// stronger) would flip deterministic expectations. Keep a local bare copy;
// compare/h2h cover the real field.
const mobPreset = parseMobPresets({
	bare: {
		name: 'bare', comment: 'test fixture',
		runners: (['Nige', 'Nige', 'Senkou', 'Senkou', 'Sasi', 'Sasi', 'Oikomi', 'Oikomi'] as const).map((strategy) =>
			({ speed: 1200, stamina: 1000, power: 1000, guts: 800, wisdom: 1000, strategy, distanceAptitude: 'A', surfaceAptitude: 'A', strategyAptitude: 'A', mood: 0, skills: [] })),
	},
}).presets['bare'];
const mergedTable = require(path.join(repoRoot, 'globalsim/skills.json'));
const knownSkillIds = new Set<string>(Object.keys(mergedTable));

const COURSE = '10504';          // Nakayama turf mile (turf ⇒ dirt-gated skills never fire)
const DISTANCE = 2000;
const BASE_SEED = 20261115;      // deterministic, pinned (distinct from the compare suite)

let instances = 0;
async function loadPkgFresh(): Promise<WasmApi> {
	const dynImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>;
	const mod = await dynImport(pathToFileURL(path.join(pkgDir, 'globalsim_wasm.js')).href + `?w=${instances++}`);
	const init = mod.default ?? mod.init;
	await init(fs.readFileSync(path.join(pkgDir, 'globalsim_wasm_bg.wasm')));
	return {
		register_geometry: (courseId: number, jsonText: string) => mod.register_geometry(courseId, jsonText),
		PreparedRace: mod.PreparedRace,
	};
}

function bridgeFactory(): WorkerFactory {
	return (): WorkerLike => {
		const msgCbs: ((e: { data: any }) => void)[] = [];
		let dead = false;
		const core = createGlobalsimWorkerCore({
			postMessage: (m) => queueMicrotask(() => { if (!dead) for (const cb of msgCbs) cb({ data: m }); }),
			loadWasm: loadPkgFresh,
			fetchText: (url) => fs.promises.readFile(path.join(geomDir, path.basename(url)), 'utf8'),
		});
		return {
			postMessage: (m: any) => queueMicrotask(() => { if (!dead) core.onMessage(m); }),
			addEventListener: (type: string, cb: any) => { if (type === 'message') msgCbs.push(cb); },
			terminate: () => { dead = true; },
		};
	};
}

// ── horses + chart input ─────────────────────────────────────────────────────

// Mid-distance Senkou runner, same line the compare suite used for (b).
function baseHorse(): HorseState {
	return new HorseState({
		speed: 1000, stamina: 1000, power: 900, guts: 800, wisdom: 900,
		strategy: 'Senkou', distanceAptitude: 'A', surfaceAptitude: 'A', strategyAptitude: 'A', mood: 2,
	});
}
function horseWithSkills(ids: string[]): HorseState {
	return baseHorse().set('skills', SkillSet(ids));
}

const PLAIN_BUILD = ['100011', '100031', '100051'];

function chartInput(over: Partial<GlobalsimSkillChartInput> = {}): GlobalsimSkillChartInput {
	return {
		uma: horseWithSkills(PLAIN_BUILD),
		skills: [],
		courseId: COURSE, distance: DISTANCE,
		ground: GroundCondition.Good, weather: Weather.Sunny, season: Season.Spring, time: Time.Midday,
		knownSkillIds, courseIds, mobPreset,
		// Mobs now carry modern skills: without the merged table the worker
		// falls back to the engine's bundled v70 table and prepare fails.
		skillData: mergedTable,
		seedBase: BASE_SEED,
		threads: 2,                 // node bridge is single-threaded anyway; keep wasm instances low
		workerFactory: bridgeFactory(),
		...over,
	} as GlobalsimSkillChartInput;
}

/** Run one chart and count streaming paints (partial row snapshots). */
async function chart(over: Partial<GlobalsimSkillChartInput>): Promise<{ rows: SkillChartResult[]; paints: number }> {
	let paints = 0;
	const rows = await runGlobalsimSkillChart(chartInput({
		...over,
		onProgress: () => { paints++; },
	}));
	return { rows, paints };
}

// ── (a) known-good speed skill ⇒ positive mean margin, win rate > 0.5 ───────

let rowA: SkillChartResult;
test('(a) speed skill 200011 ⇒ mean margin > 0, win rate > 0.5 (real wasm)', async t => {
	const { rows, paints } = await chart({ skills: ['200011'], sampleCount: 50 });
	t.equal(rows.length, 1, 'one row');
	rowA = rows[0];
	t.equal(rowA.id, '200011');
	const gs = rowA.globalsim!;
	t.ok(gs, 'globalsim block present');
	t.equal(gs.n, 50, 'two rounds merged: 25 + 25 = 50 paired seeds (round-1 filter kept the skill)');
	t.equal(gs.round, 2, 'round 2 ran for this skill');
	const mean = rowA.mean;
	t.ok(mean > 0, `mean margin positive: ${mean.toFixed(3)} L`);
	t.ok(gs.winRate > 0.5, `win rate ${((gs.winRate) * 100).toFixed(1)}% > 50% (loss ${(gs.lossRate * 100).toFixed(1)}%, tie ${(gs.tieRate * 100).toFixed(1)}%)`);
	t.ok(gs.ci95[0] < mean && mean < gs.ci95[1], `mean inside its 95% CI [${gs.ci95[0].toFixed(3)}, ${gs.ci95[1].toFixed(3)}]`);
	t.ok((gs.activationMean ?? 0) > 0, `test skill activations tracked via trackSkillId (mean ${gs.activationMean?.toFixed(2)}, rate ${((gs.activationRate ?? 0) * 100).toFixed(0)}%)`);
	t.ok(paints >= 2, `partial rows streamed during the run (${paints} paints)`);
	t.equal(gs.seedErrors, 0, 'no per-seed engine errors');
	t.comment(`(a) actual: mean=${mean.toFixed(3)}L median=${rowA.median.toFixed(3)}L win=${(gs.winRate * 100).toFixed(1)}% activationMean=${gs.activationMean?.toFixed(2)}`);
	t.end();
});

// ── (b) weather-gated control skill ⇒ mean margin ≈ 0 ───────────────────────
// NOTE: the EXPECTED_NEVER ids from skills.test.ts (110271 …) are SUPPLEMENT
// ids — profile-v77.json's embedded skillData is the pure v70 table, so the
// engine rejects them at prepare ("Missing retail initialization field").
// (Phase 2's "merge into skillData" is not wired through adapter.ts yet —
// same for the compare path.) 200241 is the in-table equivalent control: its
// ONLY condition is weather==4 (Snowy) and the test race is Sunny.

test('(b) control skill 200241 (weather==4 only, race is Sunny) ⇒ mean margin ≈ 0', async t => {
	const { rows } = await chart({ skills: ['200241'], sampleCount: 50 });
	t.equal(rows.length, 1, 'one row');
	const row = rows[0];
	const gs = row.globalsim!;
	// The never-firing control fails the classic round-1 keep-filter (max 0 is
	// not > 0.1 L) ⇒ it stays a round-1-only row (25 seeds) — exactly the
	// sampling saving the two-round design exists for.
	t.equal(gs.n, 25, 'round-1 only: the keep-filter dropped the control from round 2');
	t.equal(gs.round, 1, 'row marked round 1');
	const mean = row.mean;
	t.ok(Math.abs(mean) <= 0.15, `mean margin ${mean.toFixed(3)} L within ±0.15 L of 0`);
	t.equal(mean, 0, 'the non-firing skill leaves every paired race bit-identical to the baseline (all ties, margin exactly 0)');
	t.equal(gs.tieRate, 1, 'tie rate 100%');
	t.comment(`(b) actual: mean=${mean.toFixed(3)}L min=${row.min.toFixed(3)}L max=${row.max.toFixed(3)}L win=${(gs.winRate * 100).toFixed(1)}% loss=${(gs.lossRate * 100).toFixed(1)}% tie=${(gs.tieRate * 100).toFixed(1)}% activationRate=${((gs.activationRate ?? 0) * 100).toFixed(0)}% round=${gs.round} n=${gs.n}`);
	t.equal(gs.activationRate, 0, 'the control skill never activated (0 of the sampled seeds)');
	t.end();
});

// ── (c) determinism: same seed list twice ⇒ identical aggregates ────────────

test('(c) same seed list twice ⇒ identical per-skill aggregates', async t => {
	const input = { skills: ['200011'], sampleCount: 20 }; // 20 ≤ round 1 ⇒ single round, fully comparable
	const first = await chart(input);
	const second = await chart(input);
	t.equal(first.rows.length, 1);
	t.equal(second.rows.length, 1);
	const a = first.rows[0], b = second.rows[0];
	for (const key of ['min', 'max', 'mean', 'median', 'sampleCount'] as const) {
		t.equal(b[key], a[key], `${key} identical`);
	}
	const ga = a.globalsim!, gb = b.globalsim!;
	for (const key of ['winRate', 'lossRate', 'tieRate', 'activationMean', 'activationRate', 'seedErrors'] as const) {
		t.equal(gb[key], ga[key], `globalsim.${key} identical`);
	}
	t.deepEqual(gb.ci95, ga.ci95, 'CI identical');
	t.end();
});

// ── (d) pool abort mid-run (fake factory, no wasm) ──────────────────────────

class FakeChartWorker implements WorkerLike {
	sent: any[] = [];
	terminated = false;
	private messageCbs: ((e: { data: any }) => void)[] = [];
	postMessage(msg: any): void { this.sent.push(msg); queueMicrotask(() => { if (!this.terminated) this.respond(msg); }); }
	addEventListener(type: 'message' | 'error', cb: any): void { if (type === 'message') this.messageCbs.push(cb); }
	terminate(): void { this.terminated = true; }
	fire(data: any): void { for (const cb of this.messageCbs) cb({ data }); }
	respond: (msg: any) => void = (m) => {
		// Acks prepares but NEVER answers a run → the batch stalls mid-chunk.
		if (m.type === 'prepare') this.fire({ type: 'prepared', id: m.id, setupKey: m.setupKey, ok: true });
	};
}

test('(d) abort mid-run rejects the chart, terminates workers, no post-abort dispatch', async t => {
	const workers: FakeChartWorker[] = [];
	const factory: WorkerFactory = () => { const w = new FakeChartWorker(); workers.push(w); return w; };
	const controller = new AbortController();
	const done = runGlobalsimSkillChart(chartInput({
		skills: ['200011', '100011'],
		sampleCount: 40,
		threads: 2,
		workerFactory: factory,
		signal: controller.signal,
	}));
	// Wait until workers are actually running chunks (run messages posted).
	for (let waited = 0; ; waited += 20) {
		if (workers.some(w => w.sent.some(m => m.type === 'run'))) break;
		if (waited > 2000) { t.fail('workers never started running chunks'); controller.abort(); await done.catch(() => {}); t.end(); return; }
		await new Promise(r => setTimeout(r, 20));
	}
	const sentBefore = workers.map(w => w.sent.length);
	controller.abort();
	let rejected = false;
	let name = '';
	try { await done; } catch (e: any) { rejected = true; name = e.name; }
	t.ok(rejected, 'chart promise rejected when the pool was aborted');
	t.equal(name, 'AbortError', `rejection named AbortError (got ${name})`);
	t.ok(workers.length > 0 && workers.every(w => w.terminated), 'every live worker terminated');
	t.deepEqual(workers.map(w => w.sent.length), sentBefore, 'no message dispatched after the abort');
	t.end();
});

// ── (e) offline per-skill aggregate math through the chart internals ────────

test('(e) collector: streaming merge (B-before-A), win/tie rates, CI, round-2 merge = metrics.ts', t => {
	const distance = 2000;
	// Synthetic pairs: seeds 1..8. Odd wins (B 10.0 beats A 10.5), seed 3
	// ties (both 10.5), seed 4 loses (B 11.0). No tails ⇒ delta-avg margins.
	const A = (seed: number): SeedCompactRecord => ({ seed, finishTimeRaw: 10.5, finishOrder: 1 });
	const B = (seed: number): SeedCompactRecord => ({
		seed,
		finishTimeRaw: seed === 3 ? 10.5 : seed === 4 ? 11.0 : 10.0,
		finishOrder: seed === 4 ? 5 : 1,
		activations: seed % 2 === 0 ? 2 : seed === 3 ? 0 : 1,   // even→2, seed 3→0, other odd→1
	});
	const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
	const half1 = seeds.slice(0, 4), half2 = seeds.slice(4);

	// Order A: A chunks then B chunks, halves in order.
	const c1 = createChartCollector(distance, ['900001']);
	for (const s of half1) c1.addBaseline(s, A(s));
	for (const s of half2) c1.addBaseline(s, A(s));
	for (const s of half1) c1.addVariant('900001', s, B(s));
	for (const s of half2) c1.addVariant('900001', s, B(s));

	// Order B: interleaved — every B record lands BEFORE its A record.
	const c2 = createChartCollector(distance, ['900001']);
	for (const s of half2) { c2.addVariant('900001', s, B(s)); c2.addBaseline(s, A(s)); }
	for (const s of half1) { c2.addVariant('900001', s, B(s)); c2.addBaseline(s, A(s)); }

	const rows1 = c1.rows(), rows2 = c2.rows();
	t.equal(rows1.length, 1, 'one streamed row');
	// summarizeAggregate sums the SORTED margins, so arrival order cannot shift the
	// float-sum last bits — mean and CI are bitwise-identical regardless of order.
	t.deepEqual(rows2[0].globalsim!.ci95, rows1[0].globalsim!.ci95, 'B-before-A streaming merge ⇒ bitwise-identical CI');
	t.equal(rows1[0].mean, rows2[0].mean, 'identical mean regardless of arrival order');

	// Independent metrics.ts computation on the same pairs.
	const agg = newAggregate();
	for (const s of seeds) addPair(agg, A(s), B(s), distance);
	const s = summarizeAggregate(agg);
	const r = rows1[0], gs = r.globalsim!;
	t.equal(gs.n, 8);
	t.equal(r.sampleCount, 8, 'row.sampleCount = paired seeds');
	t.equal(r.mean, s.mean, 'mean === summarizeAggregate().mean');
	t.equal(r.median, medianOf(agg.margins.slice().sort((x, y) => x - y)), 'median matches medianOf on the margins');
	t.deepEqual(gs.ci95, ci95(s.mean, s.stdDev, 8), 'CI === metrics.ci95(mean, stdDev, n)');
	t.equal(gs.winRate, s.winRateUma2, 'winRate = share of margin > 0 (skill ahead)');
	t.equal(gs.lossRate, s.winRateUma1, 'lossRate = share of margin < 0');
	t.equal(gs.tieRate, s.tieRate, 'ties counted separately (seed 3)');
	t.equal(gs.tieRate, 1 / 8, 'exactly one tie');
	t.equal(gs.lossRate, 1 / 8, 'exactly one loss (seed 4)');
	// Activation stats (test-skill counts on the B side): seed activations
	// 1→1 2→2 3→0 4→2 5→1 6→2 7→1 8→2 (sum 11, seven seeds with ≥1).
	t.equal(gs.activationMean, 11 / 8, 'activationMean = mean activations per sampled seed');
	t.equal(gs.activationRate, 7 / 8, 'activationRate = share of seeds with ≥1 activation (seed 3 is 0)');

	// Round 2 = more paired seeds onto the SAME aggregate (merge-on-top).
	const c3 = createChartCollector(distance, ['900001']);
	const seedsR2 = [101, 102, 103, 104];
	for (const s2 of seeds) { c3.addBaseline(s2, A(s2)); c3.addVariant('900001', s2, B(s2)); }
	for (const s2 of seedsR2) { c3.addBaseline(s2, A(s2)); c3.addVariant('900001', s2, B(s2)); }
	for (const s2 of seedsR2) addPair(agg, A(s2), B(s2), distance);   // expected continuation of agg above
	c3.markRound('900001', 2);
	const r3 = c3.rows()[0], gs3 = r3.globalsim!;
	t.equal(gs3.n, 12, 'round-2 seeds add onto the round-1 aggregate (8 + 4)');
	t.equal(gs3.round, 2, 'row marked round 2');
	t.equal(r3.mean, summarizeAggregate(agg).mean, 'merged mean === one-pass metrics.ts mean over all 12');

	// Classic round-1 filter constants are the ones chart.ts applies.
	t.ok(CHART_FILTER_MAX_L === 0.1 && CHART_FILTER_SPREAD_L === 0.1, 'filter thresholds mirror the classic worker');

	// withSkillSwappedIn mirrors the classic group-replacement semantics.
	const horse = horseWithSkills(['100011', '100031', '200011']);
	const swapped = withSkillSwappedIn(horse, '200012');   // same group as an owned skill (check below)
	const meta = require(path.join(repoRoot, 'skill_meta.json')) as Record<string, { groupId?: string }>;
	t.equal(meta['200011'].groupId, meta['200012'].groupId, 'fixture sanity: 200011/200012 share a group');
	t.same(Array.from(swapped.get('skills').values()).sort(), ['100011', '100031', '200012'], 'owned group member swapped out, candidate in');
	t.same(Array.from(horse.get('skills').values()).sort(), PLAIN_BUILD.slice(0, 2).concat('200011'), 'baseline horse untouched');
	t.end();
});

// ── job-topology check: one baseline pass + one variant pass per skill ───────

test('job topology: baseline covers all seeds once; variant jobs grouped per skill with trackSkillId', t => {
	const conds = chartInput({});
	const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
	const base = buildGlobalsimChartJobs(conds, 'base', horseWithSkills(PLAIN_BUILD), seeds);
	t.deepEqual(base.errors, [], 'baseline builds');
	const totalBase = base.jobs.reduce((s, j) => s + j.seeds.length, 0);
	t.equal(totalBase, 20, 'baseline covers every seed exactly once for ALL skills');
	t.ok(base.jobs.every(j => j.trackSkillId === undefined), 'baseline tracks nothing');
	const v = buildGlobalsimChartJobs(conds, 'k200011', withSkillSwappedIn(horseWithSkills(PLAIN_BUILD), '200011'), seeds, { trackSkillId: '200011' });
	t.deepEqual(v.errors, [], 'variant builds');
	t.ok(v.jobs.length > 0 && v.jobs.every(j => j.trackSkillId === '200011'), 'every variant job carries the trackSkillId');
	const keys = new Set(v.jobs.map(j => j.setupKey));
	t.ok(keys.size <= 9, 'auto-gate: ≤ one preparation per gate for the variant');
	t.ok([...keys].every(k => k.startsWith('gs|chart|k200011|')), 'setupKey names the variant (chart namespace)');
	t.end();
});

// ── seed-count cap: the Samples field (up to 10000) must not size the chart ──
// The chart's per-skill seed count comes from the shared compare Samples field
// (app-v2 sampleCount → chart.ts total). The classic chart ignores Samples
// (fixed 25 + 175 = 200); a 10000-samples compare setting would otherwise
// make the GlobalSim chart run 10000 seeds/skill (hours). CHART_MAX_SEEDS caps it.

test('seed cap: resolveChartSeedCount clamps the Samples field to ≤ CHART_MAX_SEEDS (unit)', t => {
	t.equal(CHART_MAX_SEEDS, 1000, 'the chart seed ceiling is 1000');
	t.equal(CHART_MAX_SEEDS < 10000, true, 'the ceiling is well below the Samples max (10000)');
	t.equal(resolveChartSeedCount(undefined), CHART_DEFAULT_SEEDS, 'default (undefined) stays 200 — classic parity, byte-identical');
	t.equal(resolveChartSeedCount(500), 500, 'below the cap: unchanged (app default 500 path)');
	t.equal(resolveChartSeedCount(CHART_MAX_SEEDS), 1000, 'exactly at the cap: unchanged');
	t.equal(resolveChartSeedCount(1001), 1000, 'just above the cap: clamped to 1000');
	t.equal(resolveChartSeedCount(10000), 1000, 'the Samples max (10000) clamps to 1000');
	t.ok(resolveChartSeedCount(10000) <= CHART_MAX_SEEDS, 'sampleCount 10000 ⇒ effective total ≤ 1000 (the checkup requirement)');
	t.equal(resolveChartSeedCount(0), 1, 'floor of 1 preserved');
	t.equal(resolveChartSeedCount(-25), 1, 'negative floors to 1');
	t.equal(resolveChartSeedCount(199.4), 199, 'round-to-nearest preserved');
	t.end();
});

class CountingChartWorker implements WorkerLike {
	readonly baselineSeeds = new Set<number>();
	private cbs: ((e: { data: any }) => void)[] = [];
	private dead = false;
	postMessage(m: any): void { queueMicrotask(() => { if (!this.dead) this.respond(m); }); }
	addEventListener(type: 'message' | 'error', cb: any): void { if (type === 'message') this.cbs.push(cb); }
	terminate(): void { this.dead = true; }
	private fire(data: any): void { if (!this.dead) for (const cb of this.cbs) cb({ data }); }
	private respond(m: any): void {
		if (m.type === 'prepare') { this.fire({ type: 'prepared', id: m.id, setupKey: m.setupKey, ok: true }); return; }
		if (m.type === 'run') {
			// The baseline pass runs over the FULL resolved seed list once — its
			// dispatch count IS the effective per-skill total.
			if (String(m.jobId).split('|')[0] === 'base') for (const s of m.seeds as number[]) this.baselineSeeds.add(s);
			const records = (m.seeds as number[]).map(seed => ({ seed, finishTimeRaw: 10.5, finishOrder: 1 }));
			this.fire({ type: 'chunk', jobId: m.jobId, ok: true, records });
		}
	}
}

test('seed cap: sampleCount 10000 dispatches ≤ CHART_MAX_SEEDS baseline seeds (fake factory)', async t => {
	const workers: CountingChartWorker[] = [];
	const factory: WorkerFactory = () => { const w = new CountingChartWorker(); workers.push(w); return w; };
	const rows = await runGlobalsimSkillChart(chartInput({
		skills: ['200011'],
		sampleCount: 10000,
		threads: 2,
		workerFactory: factory,
	}));
	let dispatched = 0;
	for (const w of workers) dispatched += w.baselineSeeds.size;
	t.ok(dispatched > 0, `baseline seeds were dispatched (${dispatched})`);
	t.ok(dispatched <= CHART_MAX_SEEDS, `effective per-skill seeds ≤ ${CHART_MAX_SEEDS} despite sampleCount 10000 (got ${dispatched})`);
	t.equal(dispatched, CHART_MAX_SEEDS, 'effective per-skill total is exactly the cap (1000, not 10000)');
	t.ok(rows.length === 1, 'one skill row produced');
	t.ok((rows[0].globalsim?.n ?? 0) <= CHART_MAX_SEEDS, `row sample count ≤ ${CHART_MAX_SEEDS}`);
	t.end();
});
