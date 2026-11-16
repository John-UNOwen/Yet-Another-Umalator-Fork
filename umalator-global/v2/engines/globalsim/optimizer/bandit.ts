/**
 * Seed allocation for a batch of candidates vs one incumbent (SKILL-OPTIMIZER-PLAN
 * §9, LUCB form with the §D indifference zone):
 *
 *  - every candidate starts at the first rung (50 seeds, or whatever the
 *    transposition cache already holds — ensure() skips cached positions for
 *    free, so cached builds start with more);
 *  - candidates are dropped when their optimistic Δ (mean + β·SE, β shrinking
 *    with the seed total, conservative early per §9) falls under δ_min, the
 *    indifference zone (§D.1): if the best case is below the smallest
 *    improvement worth chasing, no more races get spent trying to find one.
 *    This, not a small cap, sizes the alive set. Candidates that can no
 *    longer reach the current best Δ (LUCB cut on the leader's lower bound)
 *    drop too; if more than BANDIT_MAX_ALIVE still survive, the weakest UCBs
 *    are cut as a cost backstop and counted in `capCut` (§D.4) so a batch
 *    ending at the cap is visible instead of silent;
 *  - each round, every kept candidate grows by an exponential rung floored
 *    at 8 threads × chunk (§D.2), so one batch keeps the pool busy (the old
 *    top-2-per-round starved it to two builds of tiny jobs);
 *  - end when one candidate's lower bound beats 0 and every rival's upper
 *    bound (resolved winner), when nothing clears δ_min any more, or at the
 *    batch seed cap.
 *
 * Every candidate's last measured Δ — eliminated included — is returned in
 * `measured`: it is a valid paired estimate at its seed count, and the
 * knapsack re-solve needs every number (§8D). Chunk growth is exponential
 * (×1.5), so a batch converges in O(log cap) rounds regardless of alive size.
 */

import { BANDIT_CHUNK_SIZE, BANDIT_MAX_ALIVE, BANDIT_RUNG_MIN_SEEDS, EffortConfig } from './config';
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
	/** First rung (default: 50). */
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
	/** Candidates the alive cap cut during this batch (§D.4). > 0 means the
	 *  cap, not the indifference zone, ended the batch. The caller logs it. */
	capCut: number;
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
	const seen = new Set<string>([o.incumbent.id]);
	const cands = o.candidates.filter(c => !seen.has(c.id) && (seen.add(c.id), true));
	if (!cands.length) return { survivors: [], measured: [], capCut: 0 };
	const cap = o.cfg.batchCap;
	const start = Math.min(cap, o.startSeeds ?? BANDIT_CHUNK_SIZE * 5);

	const best = new Map<string, Row>(); // id → last measurement (every candidate)
	for (const c of cands) best.set(c.id, { build: c, mean: NaN, sem: NaN, n: 0, survived: true });

	// Round 0: everyone gets the start rung (ensure() skips cached positions).
	{
		const positions = Array.from({ length: start }, (_, i) => i);
		await ev.ensure([
			...cands.map(c => ({ ns: o.ns, scenarioIdx: o.scenarioIdx, build: c, positions })),
			{ ns: o.ns, scenarioIdx: o.scenarioIdx, build: o.incumbent, positions },
		]);
	}
	let alive = cands;
	let lastN = start;
	let capCut = 0;
	const deltaMin = o.cfg.deltaMinL;
	for (;;) {
		const rows: Row[] = [];
		for (const c of alive) {
			const d = ev.paired(o.ns, o.scenarioIdx, c, o.incumbent, o.pick);
			if (!d) { best.get(c.id)!.survived = false; continue; }
			const row = best.get(c.id)!;
			Object.assign(row, { build: c, mean: d.mean, sem: d.sem, n: d.n, survived: true });
			rows.push(row);
		}
		// Drop: the indifference zone (§D.1: the optimistic Δ can no longer
		// reach δ_min, so there is no improvement worth chasing), the LUCB
		// rival cut (can't reach the leader's lower bound), and as a cost
		// backstop the alive cap, whose cut is counted for the caller (§D.4).
		const up = (r: Row) => r.mean + beta(r.n) * (r.sem || 0);
		const leader = rows.length ? rows.reduce((a, b) => (b.mean > a.mean ? b : a)) : null;
		const lcb = leader ? leader.mean - beta(leader.n) * (leader.sem || 0) : 0;
		const ranked = [...rows].sort((a, b) => up(b) - up(a) || (a.build.id < b.build.id ? -1 : 1));
		const kept: Row[] = [];
		for (const r of ranked) {
			if (up(r) < deltaMin) { r.survived = false; continue; }
			if (r !== leader && up(r) < lcb) { r.survived = false; continue; }
			if (kept.length >= BANDIT_MAX_ALIVE) { r.survived = false; capCut++; continue; }
			kept.push(r);
		}
		// Resolved: the best survivor's lower bound beats 0 AND every rival's
		// upper bound.
		if (kept.length) {
			const top = kept.reduce((a, b) => (b.mean > a.mean ? b : a));
			const lo = top.mean - beta(top.n) * (top.sem || 0);
			const restWorst = kept.length === 1 ? -Infinity : Math.max(...kept.filter(r => r !== top).map(up));
			if (lo > 0 && lo >= restWorst - 1e-12) {
				for (const r of kept) if (r !== top) r.survived = false;
				break;
			}
		}
		if (!kept.length) break; // nothing clears δ_min any more (§D.1)
		// §D.2: every kept candidate's interval still straddles the decision
		// threshold, so every one grows one rung (not just the top two). The
		// rung floor of 8 threads × chunk keeps one batch big enough to
		// saturate the pool. The ×1.5 keeps it at O(log cap) rounds.
		const grow = (r: Row) => Math.min(cap, Math.max(r.n + BANDIT_RUNG_MIN_SEEDS, Math.ceil(r.n * 1.5)));
		const chosen = kept.filter(r => r.n < cap);
		if (!chosen.length) { alive = kept.map(r => r.build); break; } // everyone capped
		const reqs = [];
		for (const r of chosen) {
			const newN = grow(r);
			lastN = Math.max(lastN, newN);
			reqs.push({ ns: o.ns, scenarioIdx: o.scenarioIdx, build: r.build, positions: Array.from({ length: newN }, (_, i) => i) });
		}
		reqs.push({ ns: o.ns, scenarioIdx: o.scenarioIdx, build: o.incumbent, positions: Array.from({ length: lastN }, (_, i) => i) });
		await ev.ensure(reqs);
		o.onRound?.(kept.length, lastN);
		alive = kept.map(r => r.build);
	}
	return { ...done(best), capCut };
}

function done(best: Map<string, Row>): Omit<BanditResult, 'capCut'> {
	const measured = [...best.values()].filter(r => r.n > 0).map(toOutcome);
	const survivors = measured.filter(m => m.survived).sort((a, b) => b.diff.mean - a.diff.mean || (a.build.id < b.build.id ? -1 : 1));
	return { survivors, measured };
}

function toOutcome(r: Row): BanditOutcome {
	const half = r.n >= 2 && Number.isFinite(r.sem) ? Z * r.sem : 0;
	return { build: r.build, survived: r.survived, diff: { mean: r.mean, sem: r.sem, n: r.n, ci95: [r.mean - half, r.mean + half] } };
}
