/**
 * Seed allocation for a batch of candidates vs one incumbent (SKILL-OPTIMIZER-PLAN
 * §9, LUCB form):
 *
 *  - every candidate starts at the first rung (50 seeds, or whatever the
 *    transposition cache already holds — ensure() skips cached positions for
 *    free, so cached builds start with more);
 *  - each round the next chunk goes to the candidate with the highest UCB on
 *    Δ vs the incumbent, plus its closest rival (the next-highest UCB —
 *    LUCB-style; the rival is what keeps the resolution honest);
 *  - candidates are dropped when their optimistic Δ (mean + β·SE, β shrinking
 *    with the seed total — conservative early, §9) can no longer reach 0 or
 *    the current best Δ; if more than MAX_ALIVE survive, the weakest UCBs are
 *    dropped too (cost bound);
 *  - end when one candidate's lower bound beats 0 and every rival's upper
 *    bound (resolved winner), when all are dropped, or at the batch seed cap.
 *
 * Every candidate's last measured Δ — eliminated included — is returned in
 * `measured`: it is a valid paired estimate at its seed count, and the
 * knapsack re-solve needs every number (§8D). Chunk growth is exponential
 * (×1.5), so a batch converges in O(log cap) rounds regardless of alive size.
 */

import { BANDIT_CHUNK_SIZE, EffortConfig } from './config';
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
}

interface Row {
	build: BuildRefLite;
	mean: number;
	sem: number;
	n: number;
	survived: boolean;
}

const Z = 1.96;
/** Cost bound: never carry more than this many live candidates in a batch. */
const MAX_ALIVE = 14;

/** §9's shrinking β: conservative (≈2.8) at 50 seeds, Z at ≥300. */
const beta = (n: number) => Z * Math.sqrt(Math.min(2, 300 / Math.max(1, n)));

/** Run one bandit batch. */
export async function banditVsIncumbent(ev: SearchEvaluator, o: BanditOpts): Promise<BanditResult> {
	const seen = new Set<string>([o.incumbent.id]);
	const cands = o.candidates.filter(c => !seen.has(c.id) && (seen.add(c.id), true));
	if (!cands.length) return { survivors: [], measured: [] };
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
	for (;;) {
		const rows: Row[] = [];
		for (const c of alive) {
			const d = ev.paired(o.ns, o.scenarioIdx, c, o.incumbent, o.pick);
			if (!d) { best.get(c.id)!.survived = false; continue; }
			const row = best.get(c.id)!;
			Object.assign(row, { build: c, mean: d.mean, sem: d.sem, n: d.n, survived: true });
			rows.push(row);
		}
		// Drop: optimistic Δ can't reach 0, nor the current best Δ (LUCB cut
		// on the leader's lower bound), nor (cost bound) stay in the top UCBs.
		const up = (r: Row) => r.mean + beta(r.n) * (r.sem || 0);
		const leader = rows.length ? rows.reduce((a, b) => (b.mean > a.mean ? b : a)) : null;
		const lcb = leader ? leader.mean - beta(leader.n) * (leader.sem || 0) : 0;
		const ranked = [...rows].sort((a, b) => up(b) - up(a) || (a.build.id < b.build.id ? -1 : 1));
		const kept: Row[] = [];
		for (const r of ranked) {
			const viable = up(r) > 0 && (r === leader || up(r) >= lcb) && kept.length < MAX_ALIVE;
			if (viable) kept.push(r);
			else r.survived = false;
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
		if (!kept.length) break;
		// LUCB allocation: the top-UCB candidate grows by an exponential
		// chunk, and so does its closest rival when different.
		const grow = (r: Row) => Math.min(cap, Math.max(r.n + BANDIT_CHUNK_SIZE, Math.ceil(r.n * 1.5)));
		const chosen: Row[] = [];
		for (const r of kept) {
			if (r.n < cap) chosen.push(r);
			if (chosen.length >= 2) break;
		}
		if (!chosen.length) { alive = kept.map(r => r.build); break; } // everyone capped
		if (chosen.length === 1) {
			const rival = kept.find(r => r !== chosen[0] && r.n < cap);
			if (rival) chosen.push(rival);
		}
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
