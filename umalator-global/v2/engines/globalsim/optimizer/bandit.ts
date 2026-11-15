/**
 * Seed allocation for a batch of candidates vs one incumbent (SKILL-OPTIMIZER-PLAN
 * §9). First implementation = successive halving behind the plan's interface
 * ("25 → 75 → 200 → … is acceptable … behind the same interface"):
 *
 *  - every candidate starts at the first ladder rung (50 seeds, or whatever the
 *    transposition cache already holds — ensure() skips cached positions for
 *    free, so cached builds start with more);
 *  - each round grows ALL survivors to the next rung (same seed positions for
 *    everyone — comparisons stay paired, P2);
 *  - a survivor whose optimistic Δ vs the incumbent (mean + β·SE, β shrinking
 *    with the seed total — conservative early, §9) is ≤ 0 is dropped; from the
 *    second round on, survivors are additionally halved by Δ;
 *  - end when one survivor's lower bound beats 0 and every rival's upper bound
 *    (resolved winner), when all are dropped, or at the batch seed cap.
 *
 * Eliminated candidates keep their last measured Δ in `measured` — it is a
 * valid paired estimate at that seed count, and the knapsack re-solve needs
 * every number (§8D). LUCB (§9's UCB-targeted chunk picking) plugs in here
 * later behind the same result shape.
 */

import { BANDIT_LADDER, EffortConfig } from './config';
import { BuildRefLite, PairedDiff, SearchEvaluator } from './evaluator';
import { SeedValue } from './types';

export interface BanditOpts {
	ns: string;
	scenarioIdx: number;
	incumbent: BuildRefLite;
	/** Deterministic order (caller sorts) — the ladder is reproducible (P6). */
	candidates: BuildRefLite[];
	/** Metric for Δ vs the incumbent (searchPick=ℓ, or objPick(obj) in Stage G). */
	pick: (v: SeedValue) => number | null;
	cfg: EffortConfig;
	/** First rung (default: first ladder entry). */
	startSeeds?: number;
	/** Observability: called after each round. */
	onRound?: (survivors: number, seedsUsed: number) => void;
}

export interface BanditOutcome {
	build: BuildRefLite;
	/** Δ vs incumbent on the candidate's final common seed prefix. */
	diff: PairedDiff;
	/** Survived the ladder (vs merely measured at some rung). */
	survived: boolean;
}

export interface BanditResult {
	/** Survivors, best Δ first (possibly empty). */
	survivors: BanditOutcome[];
	/** Every candidate ever measured, including eliminated ones. */
	measured: BanditOutcome[];
}

interface Row {
	build: BuildRefLite;
	mean: number;
	sem: number;
	n: number;
	survived: boolean;
}

const Z = 1.96;

/** §9's shrinking β: conservative (≈2.8) at 50 seeds, Z at ≥300. */
const beta = (n: number) => Z * Math.sqrt(Math.min(2, 300 / Math.max(1, n)));

/** Run one bandit batch. */
export async function banditVsIncumbent(ev: SearchEvaluator, o: BanditOpts): Promise<BanditResult> {
	const cands = o.candidates.filter(c => c.id !== o.incumbent.id);
	if (!cands.length) return { survivors: [], measured: [] };
	const ladder = BANDIT_LADDER.filter(r => r <= o.cfg.batchCap);
	const start = o.startSeeds ?? (ladder[0] ?? o.cfg.batchCap);
	const rungs = ladder.filter(r => r >= start);
	if (!rungs.length || rungs[rungs.length - 1] < o.cfg.batchCap) rungs.push(o.cfg.batchCap);

	const best = new Map<string, Row>(); // id → last measurement (every candidate)
	for (const c of cands) best.set(c.id, { build: c, mean: NaN, sem: NaN, n: 0, survived: false });

	let survivors = cands;
	let rows: Row[] = [];
	let lastN = 0;
	for (let ri = 0; ri < rungs.length; ri++) {
		const r = Math.min(rungs[ri], o.cfg.batchCap);
		if (r <= lastN) continue;
		const positions = Array.from({ length: r }, (_, i) => i);
		await ev.ensure([
			...survivors.map(c => ({ ns: o.ns, scenarioIdx: o.scenarioIdx, build: c, positions })),
			{ ns: o.ns, scenarioIdx: o.scenarioIdx, build: o.incumbent, positions },
		]);
		const b = beta(r);
		const scored: Row[] = [];
		for (const c of survivors) {
			const d = ev.paired(o.ns, o.scenarioIdx, c, o.incumbent, o.pick);
			if (!d) continue;
			const row: Row = { build: c, mean: d.mean, sem: d.sem, n: d.n, survived: true };
			best.set(c.id, row);
			scored.push(row);
		}
		lastN = r;
		// Drop anything whose optimistic Δ is still ≤ 0 (§9), then halve.
		const alive = scored.filter(s => s.mean + b * (s.sem || 0) > 0);
		const keep = ri === 0 ? alive.length : Math.max(2, Math.ceil(scored.length / 2));
		for (const s of scored) if (!alive.includes(s)) s.survived = false;
		rows = alive.sort((x, y) => y.mean - x.mean).slice(0, keep);
		o.onRound?.(rows.length, r);
		// Resolved: the best survivor's lower bound beats 0 AND every rival's
		// upper bound (same β — one consistent bar per round).
		if (rows.length >= 1 && rows[0].n >= 2) {
			const lo = rows[0].mean - b * rows[0].sem;
			const restWorst = rows.length === 1 ? -Infinity : Math.max(...rows.slice(1).map(s => s.mean + b * (s.sem || 0)));
			if (lo > 0 && lo >= restWorst - 1e-12) {
				for (const rw of rows.slice(1)) rw.survived = false; // resolved: only the winner stands
				return done(best);
			}
		}
		if (!rows.length) return done(best);
		survivors = rows.map(rw => rw.build);
	}
	return done(best);
}

function done(best: Map<string, Row>): BanditResult {
	const measured = [...best.values()].filter(r => r.n > 0).map(toOutcome);
	const survivors = measured.filter(m => m.survived).sort((a, b) => b.diff.mean - a.diff.mean || (a.build.id < b.build.id ? -1 : 1));
	return { survivors, measured };
}

function toOutcome(r: Row): BanditOutcome {
	const half = r.n >= 2 && Number.isFinite(r.sem) ? Z * r.sem : 0;
	return { build: r.build, survived: r.survived, diff: { mean: r.mean, sem: r.sem, n: r.n, ci95: [r.mean - half, r.mean + half] } };
}
