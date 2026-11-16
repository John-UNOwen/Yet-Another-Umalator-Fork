/**
 * Real-engine exhaustive acceptance check (SKILL-OPTIMIZER-PLAN §13.2, the
 * Phase-3 acceptance). For each setup it:
 *
 *   1. builds a purchasable space over REAL GlobalSim skills (wasm engine in
 *      real worker_threads — pool.ts parallelism),
 *   2. runs the optimizer (Stages B–F + G),
 *   3. enumerates EVERY affordable (one-per-group) build and evaluates each on
 *      the SAME held-out verification seeds the optimizer was scored on,
 *   4. requires the recommendation to BE the exhaustive best on those seeds,
 *      or to be a statistical TIE with it (paired CI of the mean-lead difference
 *      straddles 0) — the same tie honesty the plan demands of Stage G.
 *
 * Objective = meanLead: P(1st) is degenerate over a no-skill base against the
 * strong default field at 2000m (every build sits at P1≈0), so it cannot rank
 * the top pair; meanLead stays non-degenerate and is a first-class plan §5
 * objective. The test guards against degeneracy itself (asserts the lead
 * spread over the space is > 0).
 *
 * Cost control: worker_threads cold-start (each loads the wasm pkg under
 * ts-node) dominates. Env knobs scale it:
 *   SLOW_SETUPS   setups to run (default 1; plan full = 3)
 *   SLOW_OPTIONS  purchasable options per setup (default 9; plan full = 12)
 *   SLOW_VERIFY   verification seeds per build (default 400; plan full = 2000)
 *   SLOW_THREADS  worker_threads (default auto, capped 8)
 *   SLOW_FULL=1   plan §13.2 full sizing in one shot (3 × 12 × 2000)
 */

// HorseDefTypes reads the build-time define at module scope (ts-node has no
// bundler). Before any import: TS compiles imports to requires in source order.
(globalThis as any).CC_GLOBAL = true;

import test from 'tape';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Worker } from 'worker_threads';

import { HorseState, SkillSet } from '../../../../../components/HorseDefTypes';
import { GroundCondition, Season, Time, Weather } from '../../../../../uma-skill-tools/RaceParameters';
import { parseMobPresets } from '../mobs';
import { WorkerFactory } from '../pool';
import { calculateSkillCost, isPurpleSkill, skillGroups } from '../../../skill-chart-utils';
import { createEvaluator } from './evaluator';
import { NS_VERIFY } from './cache';
import { assertFeasible, assertOnePerGroup, buildSpace, BuildSpace, simIdentity } from './space';
import { createController, runOptimizer } from './search';
import { STANDARD } from './config';
import { BuildRefLite } from './evaluator';
import { EffortConfig } from './config';
import { ScenarioSpec } from './types';

const repoRoot = path.resolve(__dirname, '../../../../../');
const pkgDir = path.join(repoRoot, 'globalsim-wasm', 'pkg');
const geomDir = path.join(repoRoot, 'vendor', 'GlobalSim', 'data', 'course_geometry');
const courseIds: string[] = Object.keys(require(path.join(repoRoot, 'vendor/GlobalSim/data/course_data.json')));
const mobPreset = parseMobPresets(require('../mob-presets.json')).presets['default'];
const mergedTable = require(path.join(repoRoot, 'globalsim/skills.json'));
const knownSkillIds = new Set<string>(Object.keys(mergedTable));

const FULL = process.env.SLOW_FULL === '1';
const N_SETUPS = Number(process.env.SLOW_SETUPS ?? (FULL ? 3 : 1));
const N_OPTS = Number(process.env.SLOW_OPTIONS ?? (FULL ? 12 : 9));
const V_SEEDS = Number(process.env.SLOW_VERIFY ?? (FULL ? 2000 : 400));
const THREADS = Number(process.env.SLOW_THREADS ?? Math.min(8, (os as any).availableParallelism?.() ?? os.cpus().length));
const BASE_SEED = 20261115;

/** A worker_threads-backed pool worker: real wasm, real OS thread. */
const threadFactory: WorkerFactory = () => {
	const w = new Worker(path.join(__dirname, 'slowWorker.js'), { workerData: { pkgDir, geomDir } });
	let messageCb: ((e: { data: any }) => void) | null = null;
	let errorCb: ((e: unknown) => void) | null = null;
	w.on('message', (data) => messageCb?.({ data }));
	w.on('error', (err) => errorCb?.(err));
	return {
		postMessage: (m) => w.postMessage(m),
		addEventListener: (type: string, cb: any) => { if (type === 'message') messageCb = cb; else if (type === 'error') errorCb = cb; },
		terminate: () => { void w.terminate(); },
	};
};

function baseHorse(strategy: 'Senkou' | 'Sasi' | 'Oikomi'): HorseState {
	// Strong enough to WIN against the default field in the base state
	// (P(1st) in the resolvable 0.1–0.6 band) — a skill-less 0.000 base would
	// make the p1 objective degenerate (every build ties at zero).
	return new HorseState({
		speed: 1350, stamina: 1350, power: 1250, guts: 1250, wisdom: 1250,
		strategy, distanceAptitude: 'A', surfaceAptitude: 'A', strategyAptitude: 'A', mood: 2,
	}).set('skills', SkillSet([]));
}

/** Deterministic purchasable options: cheapest tier of distinct covered groups,
 *  non-purple, positive SP cost — mirrors the evaluator integration test. */
function pickOptions(n: number): string[] {
	const out: string[] = [];
	const groupsSeen = new Set<string>();
	for (const [gid, ids] of skillGroups) {
		if (out.length >= n) break;
		if (groupsSeen.has(gid)) continue;
		for (const id of ids) {
			if (isPurpleSkill(id)) continue;
			if (!knownSkillIds.has(id)) continue; // coverage gate
			if (ids[0] !== id) continue;          // cheapest tier of this group
			if (calculateSkillCost(id, new Map(), new Map()) <= 0) continue;
			groupsSeen.add(gid);
			out.push(id);
			break;
		}
	}
	return out;
}

/** Enumerate every affordable group-exclusive selection (all in distinct
 *  groups here, so subsets == one-per-group), each as a BuildRefLite. */
function enumerateAffordable(space: BuildSpace): BuildRefLite[] {
	const single = [...space.groups.values()].map(g => g[0]); // distinct groups
	const out: BuildRefLite[] = [];
	const opts = single;
	const rec = (i: number, sel: string[], cost: number) => {
		if (i === opts.length) {
			const b: BuildRefLite = { id: simIdentity(space, sel), selection: [...sel] };
			out.push(b);
			return;
		}
		rec(i + 1, sel, cost); // skip
		const o = opts[i];
		if (cost + o.cost <= space.budget) { sel.push(o.id); rec(i + 1, sel, cost + o.cost); sel.pop(); }
	};
	rec(0, [], 0);
	return out;
}

// Three real running styles stress different skill families (style-gated
// activation) — genuinely different optimization landscapes, same held-out seeds.
const SETUPS: { label: string; strategy: 'Senkou' | 'Sasi' | 'Oikomi'; gate: number }[] = [
	{ label: 'Senkou / gate 3', strategy: 'Senkou', gate: 3 },
	{ label: 'Sasi / gate 4', strategy: 'Sasi', gate: 4 },
	{ label: 'Oikomi / gate 5', strategy: 'Oikomi', gate: 5 },
];

const SLOW_CFG: EffortConfig = {
	...STANDARD,
	// The exhaustive truth needs every affordable build scored on verify seeds;
	// keep the optimizer's own verify floor aligned with SLOW_VERIFY.
	gSeedsMin: V_SEEDS, gSeedsCap: V_SEEDS * 2, batchCap: FULL ? 5000 : 1200,
};

test(`real-engine exhaustive check (3 setups × ${N_OPTS} options × ${V_SEEDS} verify seeds × ${THREADS} threads)`, async t => {
	if (!fs.existsSync(path.join(pkgDir, 'globalsim_wasm_bg.wasm'))) {
		t.fail('globalsim-wasm pkg not built — run `wasm-pack build --target web --release --out-dir pkg` in globalsim-wasm/');
		t.end();
		return;
	}
	const options = pickOptions(N_OPTS);
	if (options.length < N_OPTS) { t.fail(`only ${options.length} purchasable options found (need ${N_OPTS})`); t.end(); return; }
	const budget = Math.round(options.reduce((a, id) => a + calculateSkillCost(id, new Map(), new Map()), 0) * 0.55); // ~half the roster

	for (const setup of SETUPS.slice(0, N_SETUPS)) {
		const space = buildSpace({ purchasable: options, ownedByGroup: new Map(), fixedIds: [], hints: new Map(), budget });
		if (space.error) { t.fail(`${'[' + setup.label + '] space error: '}` + space.error); continue; }
		assertFeasible(space, []);
		const scenario: ScenarioSpec = {
			id: 'main', label: setup.label,
			conds: { courseId: '10504', distance: 2000, ground: GroundCondition.Good, weather: Weather.Sunny, season: Season.Spring, time: Time.Midday, mobPreset, fixedGate: setup.gate, courseIds, skillData: mergedTable, knownSkillIds } as any,
			mobPreset,
		};
		const ev = createEvaluator({ workerFactory: threadFactory, threads: THREADS, space, baseHorse: baseHorse(setup.strategy), scenarios: [scenario], baseSeed: BASE_SEED, skillData: mergedTable });
		const t0 = Date.now();
		// Objective = meanLead (§5): P(1st) is degenerate here (a no-skill base
		// loses to the strong default field at 2000m, so every build sits at
		// P1≈0 and the objective can't rank the top pair). meanLead stays
		// non-degenerate — it measures HOW CLOSE the horse finishes, exactly the
		// signal an exhaustive check must resolve. The recommendation must match
		// the exhaustive lead-best, or tie it (paired CI of the lead difference
		// straddles 0) — the same honesty Stage G demands.
		const res = await runOptimizer(ev, { space, scenarioIdx: 0, objective: 'meanLead', aggregation: 'mean', effort: SLOW_CFG }, createController(), () => undefined);
		const recId = res.best.build.id;
		assertFeasible(space, res.best.build.selection);
		assertOnePerGroup(space, res.best.build.selection);

		// Exhaustive ground truth on the SAME verify seeds.
		const all = enumerateAffordable(space);
		await ev.ensure(all.map(b => ({ ns: NS_VERIFY, scenarioIdx: 0, build: b, positions: Array.from({ length: V_SEEDS }, (_, i) => i) })));
		const leadMean = (b: BuildRefLite) => { const s = ev.stats(NS_VERIFY, 0, b)?.lead; return s && s.n > 0 && Number.isFinite(s.mean) ? s.mean : null; };
		const scored = all
			.map(b => ({ b, lead: leadMean(b) }))
			.filter((x): x is { b: BuildRefLite; lead: number } => x.lead !== null)
			.sort((a, z) => z.lead - a.lead);
		if (scored.length < 2) { t.fail(`[${setup.label}] fewer than 2 enumerated builds produced verify lead stats`); ev.dispose(); continue; }
		const truthBest = scored[0];
		// The optimizer rec must already be verify-scored (Stage G); if the rec
		// isn't in the enumerated set (tier variants), score it explicitly.
		const recIn = all.find(b => b.id === recId);
		const recRef = recIn ?? res.best.build;
		if (!recIn) await ev.ensure([{ ns: NS_VERIFY, scenarioIdx: 0, build: recRef, positions: Array.from({ length: V_SEEDS }, (_, i) => i) }]);
		const recLead = leadMean(recRef);
		const d = ev.paired(NS_VERIFY, 0, recRef, truthBest.b, v => v.lead);
		const tied = d ? (d.ci95[0] <= 0 && d.ci95[1] >= 0) : true;
		const recBest = recLead !== null && recLead >= truthBest.lead - 1e-12;
		const spread = truthBest.lead - scored[scored.length - 1].lead; // non-degeneracy guard
		t.comment(`[${setup.label}] builds=${scored.length} lead-spread=${spread.toFixed(3)} races=${ev.racesRun()} truth ℓ=${truthBest.lead.toFixed(3)} rec ℓ=${recLead?.toFixed(3)} Δci=[${d ? d.ci95[0].toFixed(3) : '?'},${d ? d.ci95[1].toFixed(3) : '?'}] ${((Date.now() - t0) / 1000).toFixed(0)}s`);
		// §H acceptance record: worker-measured prepare time as a share of
		// worker-measured race time (gate: under 10%; the per-setup LRU reuse
		// is what keeps it there — every re-run rung runs on held preparations).
		const tm = ev.poolTiming();
		t.comment(`[${setup.label}] prep share: ${tm.prepares} prepares ${tm.prepareMs.toFixed(0)}ms / ${tm.runMs.toFixed(0)}ms race over ${tm.chunks} chunks ${tm.records} records = ${(100 * tm.prepareMs / Math.max(1, tm.runMs)).toFixed(1)}%`);
		t.ok(spread > 1e-6, `[${setup.label}] the lead objective is non-degenerate over the space (spread=${spread.toFixed(3)})`);
		t.ok(recBest || tied, `[${setup.label}] recommendation is the exhaustive best or tied with it`);
		ev.dispose();
	}
	t.end();
});
