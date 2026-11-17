/**
 * Seed allocation for a batch of candidates vs one incumbent (SKILL-OPTIMIZER-PLAN
 * §9, LUCB form with the §D indifference zone):
 *
 *  - every candidate starts at the first rung (50 seeds, or whatever the
 *    transposition cache already holds — ensure() skips cached positions for
 *    free, so cached builds start with more) — except under the §I.5 prior: a
 *    candidate whose predicted Δ has an optimistic bound under δ_min never
 *    races at all and is counted in `priorCut`;
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

import { BANDIT_CHUNK_SIZE, BANDIT_MAX_ALIVE, BANDIT_RUNG_MIN_SEEDS, EffortConfig, PRUNE_KAPPA } from './config';
import { BuildRefLite, PairedDiff, SearchEvaluator } from './evaluator';
import { SeedValue } from './types';

export interface BanditOpts {
	ns: string;
	scenarioIdx: number;
	incumbent: BuildRefLite;
	/** Deterministic order (caller sorts) — the ladder is reproducible (P6). */
	candidates: BuildRefLite[];
	/** Metric for Δ vs the incumbent (the §F search currency in Stages B–F,
	 *  or objPick(obj) in Stage G). δ_min below is in that metric's units. */
	pick: (v: SeedValue) => number | null;
	cfg: EffortConfig;
	/** First rung (default: 50). */
	startSeeds?: number;
	/** Minimum growth per ladder round (default BANDIT_RUNG_MIN_SEEDS = 8 threads ×
	 *  chunk). The §C climb lowers it: its batches are 4–16 waves wide, so even a
	 *  small per-candidate step is a pool-sized job, and the wide screening pays
	 *  the rung floor once per candidate — a smaller step is the cost lever that
	 *  lets the whole N1 be laddered at all. */
	rungMin?: number;
	/** Cap growth at this seed count (default: the preset's batchCap). The §C
	 *  certified climb passes the δ-resolution count of the measured σΔ: growth
	 *  past that point cannot change a candidate's δ-zone verdict, and candidates
	 *  still at the ceiling with UCB ≥ δ_min come back as "unresolved" (measured,
	 *  not adopted, not certifiably hopeless). */
	rungCeil?: number;
	/** Set false to switch off the LUCB rival cut. The §C certification pass does
	 *  this: only an indifference-zone drop proves UCB < δ_min, and a wave whose
	 *  survivors are all zone-dropped is a certified screen. */
	lucbCut?: boolean;
	/** Override the alive cap (default BANDIT_MAX_ALIVE). The §C climb screens in
	 *  waves and raises the cap to the wave size so a cut candidate can never
	 *  invalidate the wave's certification (capCut then always reports 0). */
	maxAlive?: number;
	/** §I.5 prior: a prediction of each candidate's Δ vs the incumbent with
	 *  the posterior SE OF THE DIFFERENCE (the surrogate's predictDiff), or
	 *  null when no model has seen the candidate. A candidate whose OPTIMISTIC
	 *  prior bound (gain + PRUNE_KAPPA·se) cannot reach δ_min is retired before
	 *  its first race — the §C screening rule's one sanctioned exception, so a
	 *  first rung is spent only where the prediction leaves a chance. Anything
	 *  that races lives and dies by the indifference zone exactly as before. */
	prior?: (build: BuildRefLite) => { gain: number; se: number } | null;
	/** Observability: called after each round. */
	onRound?: (survivors: number, seedsUsed: number) => void;
	/** Stop requested: the ladder ends before its next rung and reports what
	 *  it measured (the candidates still alive come back as survivors). A late
	 *  rung can take minutes, so the search's STOP must not wait for the ceiling. */
	stopped?: () => boolean;
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
	/** §I.5: candidates the Δ-SE prior retired before their first race (0 when
	 *  no prior is given). They never raced, so they are absent from
	 *  `measured`; the caller treats them as bound-certified hopeless (§C). */
	priorCut: number;
}

interface Row {
	build: BuildRefLite;
	mean: number;
	sem: number;
	n: number;
	survived: boolean;
}

const Z = 1.96;

/** §9's shrinking β: conservative (≈2.8) at 50 seeds, easing to Z at 300 and
 *  held at Z from there (it used to keep shrinking — 0.78 at 1,882 seeds — so
 *  a δ-zone drop or a certified peak rested on a ~60–80% bound instead of the
 *  95% one it claims). Exported so callers that classify survivors (the §C
 *  climb's δ-zone check) use exactly the ladder's own optimism. */
export const betaOf = (n: number) => Z * Math.sqrt(Math.max(1, Math.min(2, 300 / Math.max(1, n))));

/** Run one bandit batch. */
export async function banditVsIncumbent(ev: SearchEvaluator, o: BanditOpts): Promise<BanditResult> {
	const seen = new Set<string>([o.incumbent.id]);
	const deltaMin = o.cfg.deltaMinL;
	let cands = o.candidates.filter(c => !seen.has(c.id) && (seen.add(c.id), true));
	// §I.5: the surrogate's Δ-SE bound retires hopeless candidates BEFORE
	// their first race (the sanctioned exception; §C's "race everything"
	// stands for everything the model cannot rule out).
	let priorCut = 0;
	if (o.prior) {
		cands = cands.filter(c => {
			const p = o.prior!(c);
			if (p && p.gain + PRUNE_KAPPA * p.se < deltaMin) { priorCut++; return false; }
			return true;
		});
	}
	if (!cands.length) return { survivors: [], measured: [], capCut: 0, priorCut };
	// rungCeil overrides the preset batch cap (§C's climb sizes its ladder by
	// the measured noise, and takes climbRaces/time as the budget instead).
	const cap = o.rungCeil !== undefined ? Math.max(1, o.rungCeil) : o.cfg.batchCap;
	const maxAlive = o.maxAlive ?? BANDIT_MAX_ALIVE;
	const rungMin = o.rungMin ?? BANDIT_RUNG_MIN_SEEDS;
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
		// Under two common seeds the SEM is undefined (NaN): that is unbounded
		// uncertainty, not none — `sem || 0` turned one seed into a certainty.
		// A genuine 0 (n ≥ 2, every Δ equal, e.g. a dead add) stays 0.
		const semOf = (r: Row) => (r.n >= 2 && Number.isFinite(r.sem) ? r.sem : Infinity);
		const up = (r: Row) => r.mean + betaOf(r.n) * semOf(r);
		const leader = rows.length ? rows.reduce((a, b) => (b.mean > a.mean ? b : a)) : null;
		const lcb = leader ? leader.mean - betaOf(leader.n) * semOf(leader) : 0;
		const ranked = [...rows].sort((a, b) => up(b) - up(a) || (a.build.id < b.build.id ? -1 : 1));
		const kept: Row[] = [];
		for (const r of ranked) {
			if (up(r) < deltaMin) { r.survived = false; continue; }
			if (o.lucbCut !== false && r !== leader && up(r) < lcb) { r.survived = false; continue; }
			if (kept.length >= maxAlive) { r.survived = false; capCut++; continue; }
			kept.push(r);
		}
		// Resolved: the best survivor's lower bound beats 0 AND every rival's
		// upper bound.
		if (kept.length) {
			const top = kept.reduce((a, b) => (b.mean > a.mean ? b : a));
			const lo = top.mean - betaOf(top.n) * semOf(top);
			const restWorst = kept.length === 1 ? -Infinity : Math.max(...kept.filter(r => r !== top).map(up));
			if (lo > 0 && lo >= restWorst - 1e-12) {
				for (const r of kept) if (r !== top) r.survived = false;
				break;
			}
		}
		if (!kept.length) break; // nothing clears δ_min any more (§D.1)
		if (o.stopped?.()) break; // STOP: no further rung
		// §D.2: every kept candidate's interval still straddles the decision
		// threshold, so every one grows one rung (not just the top two). The
		// rung floor of 8 threads × chunk keeps one batch big enough to
		// saturate the pool. The ×1.5 keeps it at O(log cap) rounds.
		const grow = (r: Row) => Math.min(cap, Math.max(r.n + rungMin, Math.ceil(r.n * 1.5)));
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
	return { ...done(best), capCut, priorCut };
}

function done(best: Map<string, Row>): Omit<BanditResult, 'capCut' | 'priorCut'> {
	const measured = [...best.values()].filter(r => r.n > 0).map(toOutcome);
	const survivors = measured.filter(m => m.survived).sort((a, b) => b.diff.mean - a.diff.mean || (a.build.id < b.build.id ? -1 : 1));
	return { survivors, measured };
}

function toOutcome(r: Row): BanditOutcome {
	const half = r.n >= 2 && Number.isFinite(r.sem) ? Z * r.sem : 0;
	return { build: r.build, survived: r.survived, diff: { mean: r.mean, sem: r.sem, n: r.n, ci95: [r.mean - half, r.mean + half] } };
}
