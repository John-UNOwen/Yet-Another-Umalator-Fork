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

import {
	BANDIT_CHUNK_SIZE, BANDIT_MAX_ALIVE, BANDIT_RUNG_MIN_SEEDS, BANDIT_START_SEEDS, CLIMB_CONFIRM_PARALLEL, CLIMB_CONFIRM_START,
	EffortConfig, PRUNE_KAPPA, SEED_LIST_SIZE, SEQ_ADOPT_Z,
} from './config';
import { BuildRefLite, PairedDiff, pairedOf, SearchEvaluator } from './evaluator';
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
	const reached = new Map<string, number>(); // id → the prefix it was last grown to
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
		// Seeds that fail ('err') leave the paired count behind the prefix
		// already raced, and growing from that count asked for the same prefix
		// forever. A stalled count steps from that prefix instead (the same
		// rungs whenever the count keeps up with the prefix).
		const step = (n: number) => Math.min(cap, Math.max(n + rungMin, Math.ceil(n * 1.5)));
		const grow = (r: Row) => {
			const to = step(r.n), had = reached.get(r.build.id) ?? 0;
			return to > had ? to : step(had);
		};
		const chosen = kept.filter(r => r.n < cap && (reached.get(r.build.id) ?? 0) < cap);
		if (!chosen.length) { alive = kept.map(r => r.build); break; } // everyone capped
		const reqs = [];
		for (const r of chosen) {
			const newN = grow(r);
			reached.set(r.build.id, newN);
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

// ── the race climb's wave (search.ts `climb: 'race'`) ────────────────────────

export interface RaceWaveOpts {
	ns: string;
	scenarioIdx: number;
	incumbent: BuildRefLite;
	/** Deterministic order (the climb's move order). */
	candidates: BuildRefLite[];
	pick: (v: SeedValue) => number | null;
	cfg: EffortConfig;
	/** The wave's target gain g and per-move seed cap from the paired spread σ
	 *  the start rung measured at this incumbent (median over the wave's moves
	 *  with a spread above 0, NaN when none has one). */
	targetOf: (sigma: number) => { g: number; nMax: number };
	startSeeds?: number;
	rungMin?: number;
	/** §I.5 prior, as banditVsIncumbent: cuts only what cannot reach δ_min. */
	prior?: BanditOpts['prior'];
	stopped?: () => boolean;
}

export interface RaceWaveResult {
	/** The move adopted: it passed the sequential test on the ladder AND again
	 *  on positions it had not raced. Its diff covers every position it raced. */
	adopted: BanditOutcome | null;
	/** Every raced candidate's last paired Δ (for the value maps). */
	measured: BanditOutcome[];
	priorCut: number;
	/** Set aside with an optimistic Δ still at or above δ_min (below g only, at
	 *  nMax, a failed confirm, or alive when the wave was cut): these block a
	 *  §C certificate. Moves ruled out under δ_min are not counted. */
	unresolved: number;
	/** STOP or the budget ended the wave early. */
	cut: boolean;
	g: number;
	nMax: number;
	sigma: number;
	races: number;
}

/** Positions [lo, hi) of two builds, paired (the confirm test's window). */
function pairedWindow(ev: SearchEvaluator, ns: string, si: number, a: BuildRefLite, b: BuildRefLite, lo: number, hi: number, pick: (v: SeedValue) => number | null): PairedDiff | null {
	return pairedOf(ev.slots(ns, si, a.id).slice(lo, hi), ev.slots(ns, si, b.id).slice(lo, hi), pick);
}

/** One past the last measured position of a build (where its unseen seeds start). */
function measuredEnd(ev: SearchEvaluator, ns: string, si: number, b: BuildRefLite): number {
	const s = ev.slots(ns, si, b.id);
	for (let i = s.length - 1; i >= 0; i--) if (s[i] != null) return i + 1;
	return 0;
}

const prefix = (n: number) => Array.from({ length: n }, (_, i) => i);
const range = (lo: number, hi: number) => Array.from({ length: Math.max(0, hi - lo) }, (_, i) => lo + i);

/**
 * One wave of the race climb: first improvement with a confirm step.
 *
 * Every candidate starts at the first rung and grows ×1.5 per round, like the
 * §C ladder. Three things differ:
 *  - A candidate whose sequential lower bound (SEQ_ADOPT_Z) clears 0 is
 *    re-tested on positions it has not raced (from CLIMB_CONFIRM_START seeds
 *    up to nMax, the same test). The first one that passes is adopted and the
 *    wave ends. Testing every move at every rung picks up noise, and the
 *    fresh positions cannot have been chosen for it.
 *  - A candidate is set aside once its optimistic Δ (mean + max(SEQ_ADOPT_Z,
 *    β(n))·SE) falls under the target gain g, or at nMax seeds. targetOf
 *    sets g from the noise the start rung measured, never below δ_min, so a
 *    coarse wave stops paying for gains finer than it looks for. A finer
 *    refinement level asks for a smaller g.
 *  - With several improvers alive the wave still ends at the first confirmed
 *    one. The §C wave could only end when its leader's lower bound cleared
 *    every rival's upper bound, so a wave full of close improvers ran every
 *    one of them to the ceiling.
 * With g = δ_min, every move set aside under g is ruled out under δ_min, so an
 * empty wave with no unresolved moves is the same certificate as before.
 */
export async function raceWave(ev: SearchEvaluator, o: RaceWaveOpts): Promise<RaceWaveResult> {
	const r0 = ev.racesRun();
	const deltaMin = o.cfg.deltaMinL;
	const seen = new Set<string>([o.incumbent.id]);
	let cands = o.candidates.filter(c => !seen.has(c.id) && (seen.add(c.id), true));
	let priorCut = 0;
	if (o.prior) {
		cands = cands.filter(c => {
			const p = o.prior!(c);
			if (p && p.gain + PRUNE_KAPPA * p.se < deltaMin) { priorCut++; return false; }
			return true;
		});
	}
	const empty = (cut = false): RaceWaveResult => ({ adopted: null, measured: [], priorCut, unresolved: 0, cut, g: deltaMin, nMax: 0, sigma: NaN, races: ev.racesRun() - r0 });
	if (!cands.length) return empty();
	const rungMin = o.rungMin ?? BANDIT_CHUNK_SIZE;
	const start = o.startSeeds ?? BANDIT_START_SEEDS;
	const inc = o.incumbent;
	await ev.ensure([
		...cands.map(c => ({ ns: o.ns, scenarioIdx: o.scenarioIdx, build: c, positions: prefix(start) })),
		{ ns: o.ns, scenarioIdx: o.scenarioIdx, build: inc, positions: prefix(start) },
	]);
	const diffOf = (c: BuildRefLite) => ev.paired(o.ns, o.scenarioIdx, c, inc, o.pick);
	const last = new Map<string, PairedDiff>();
	const sds: number[] = [];
	for (const c of cands) {
		const d = diffOf(c);
		if (!d) continue;
		last.set(c.id, d);
		// A move with a spread of 0 (a skill that never fires, so every Δ is
		// equal) says nothing about the noise. Counted, a wave of mostly such
		// moves had σ = 0, so nMax fell to the start rung and every real move
		// was set aside unresolved after 50 seeds.
		const sd = d.sem * Math.sqrt(d.n);
		if (d.n >= 2 && Number.isFinite(sd) && sd > 0) sds.push(sd);
	}
	sds.sort((a, b) => a - b);
	const sigma = sds.length ? sds[Math.floor(sds.length / 2)] : NaN;
	const { g: g0, nMax: n0 } = o.targetOf(sigma);
	const g = Math.max(deltaMin, Number.isFinite(g0) ? g0 : deltaMin);
	const nMax = Math.min(SEED_LIST_SIZE, Math.max(start, Math.floor(n0)));
	const semOf = (d: PairedDiff) => (d.n >= 2 && Number.isFinite(d.sem) ? d.sem : Infinity);
	const lcb = (d: PairedDiff) => d.mean - SEQ_ADOPT_Z * semOf(d);
	const ucb = (d: PairedDiff) => d.mean + Math.max(SEQ_ADOPT_Z, betaOf(d.n)) * semOf(d);
	const zoneUp = (d: PairedDiff) => d.mean + betaOf(d.n) * semOf(d); // the §C ladder's own optimism
	let unresolved = 0;
	const setAside = (d: PairedDiff | undefined) => { if (!d || zoneUp(d) >= deltaMin) unresolved++; };
	const out = (adopted: BanditOutcome | null, cut: boolean): RaceWaveResult => ({
		adopted, priorCut, unresolved, cut, g, nMax, sigma, races: ev.racesRun() - r0,
		measured: [...last.entries()].map(([id, d]) => toOutcome({
			build: cands.find(c => c.id === id)!, mean: d.mean, sem: d.sem, n: d.n, survived: adopted?.build.id === id,
		})),
	});
	let alive = cands.filter(c => last.has(c.id));
	unresolved += cands.length - alive.length; // never measured: nothing rules them out
	// How far a move's ladder got: its paired count, or the prefix it was last
	// raced to when engine errors ('err' seeds) leave that count behind. Growth
	// steps from this, so a move with failing seeds still reaches nMax.
	const reached = new Map<string, number>();
	const reachOf = (c: BuildRefLite) => Math.max(last.get(c.id)!.n, reached.get(c.id) ?? 0);

	for (;;) {
		// 1. Hits: confirm them on positions they have not raced.
		const hits = alive.map(c => ({ c, d: last.get(c.id)! })).filter(x => lcb(x.d) > 0)
			.sort((a, b) => b.d.mean - a.d.mean || (a.c.id < b.c.id ? -1 : 1)).slice(0, CLIMB_CONFIRM_PARALLEL);
		if (hits.length) {
			const tried = new Set(hits.map(h => h.c.id));
			const base = new Map(hits.map(h => [h.c.id, measuredEnd(ev, o.ns, o.scenarioIdx, h.c)]));
			// The window never runs past the seed list. A hit raced to its end
			// (an old incumbent keeps every position it was raced on) has no
			// unseen positions left, so it is set aside, not confirmed.
			const endOf = (c: BuildRefLite, m: number) => Math.min(SEED_LIST_SIZE, base.get(c.id)! + m);
			let open: BuildRefLite[] = [];
			for (const h of hits) {
				if (SEED_LIST_SIZE - base.get(h.c.id)! < 2) setAside(h.d);
				else open.push(h.c);
			}
			let m = Math.min(nMax, CLIMB_CONFIRM_START);
			while (open.length) {
				const hi = Math.max(...open.map(c => endOf(c, m)));
				await ev.ensure([
					...open.map(c => ({ ns: o.ns, scenarioIdx: o.scenarioIdx, build: c, positions: range(base.get(c.id)!, endOf(c, m)) })),
					{ ns: o.ns, scenarioIdx: o.scenarioIdx, build: inc, positions: prefix(hi) },
				]);
				const passed: BuildRefLite[] = [];
				const stay: BuildRefLite[] = [];
				for (const c of open) {
					const b = base.get(c.id)!, e = endOf(c, m);
					const w = pairedWindow(ev, o.ns, o.scenarioIdx, c, inc, b, e, o.pick);
					const full = diffOf(c);
					if (full) last.set(c.id, full);
					if (w && lcb(w) > 0) passed.push(c);
					else if ((w && w.mean + SEQ_ADOPT_Z * semOf(w) < 0) || m >= nMax || e >= SEED_LIST_SIZE) setAside(last.get(c.id));
					else stay.push(c);
				}
				if (passed.length) {
					const best = passed.reduce((a, b) => (last.get(b.id)!.mean > last.get(a.id)!.mean ? b : a));
					const d = last.get(best.id)!;
					const half = d.n >= 2 && Number.isFinite(d.sem) ? Z * d.sem : 0;
					return out({ build: best, survived: true, diff: { mean: d.mean, sem: d.sem, n: d.n, ci95: [d.mean - half, d.mean + half] } }, false);
				}
				open = stay;
				if (!open.length) break;
				// Stopped mid-confirm: the open hits and every move not yet
				// confirmed are still alive, so none of them is ruled out.
				if (o.stopped?.()) { unresolved += open.length + alive.filter(c => !tried.has(c.id)).length; return out(null, true); }
				m = Math.min(nMax, Math.ceil(m * 1.5));
			}
			alive = alive.filter(c => !tried.has(c.id));
			continue; // the next hits, if any, before the ladder grows
		}
		// 2. Set aside what cannot reach g, or ran out of seeds.
		const kept: BuildRefLite[] = [];
		for (const c of alive) {
			const d = last.get(c.id)!;
			if (ucb(d) < g || reachOf(c) >= nMax) setAside(d);
			else kept.push(c);
		}
		alive = kept;
		if (!alive.length) return out(null, false);
		if (o.stopped?.()) { unresolved += alive.length; return out(null, true); }
		// 3. Grow the rest one rung.
		let incTo = 0;
		const reqs = alive.map(c => {
			const n = reachOf(c);
			const to = Math.min(nMax, Math.max(n + rungMin, Math.ceil(n * 1.5)));
			reached.set(c.id, to);
			incTo = Math.max(incTo, to);
			return { ns: o.ns, scenarioIdx: o.scenarioIdx, build: c, positions: prefix(to) };
		});
		reqs.push({ ns: o.ns, scenarioIdx: o.scenarioIdx, build: inc, positions: prefix(incTo) });
		await ev.ensure(reqs);
		for (const c of alive) { const d = diffOf(c); if (d) last.set(c.id, d); }
	}
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
