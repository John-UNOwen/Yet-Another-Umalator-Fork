/**
 * Search pipeline orchestration (SKILL-OPTIMIZER-PLAN §8). Stages B–D + F + G
 * live here; Stage A (book) ships with Phase 5 and Stage E (surrogate) plugs in
 * to the same loop. Everything measurable runs
 * through the evaluator (P7); every comparison is paired over identical seed
 * positions (P2); final numbers come only from the verification namespace (P3);
 * progress events make the run anytime (P5); all inputs are deterministic (P6).
 */

import { banditVsIncumbent, BanditOpts, BanditOutcome, betaOf } from './bandit';
import {
	BANDIT_CHUNK_SIZE, BANDIT_MAX_ALIVE, BANDIT_RUNG_MIN_SEEDS, BANDIT_START_SEEDS, CLIMB_WAVE,
	DEAD_SKILL_MIN_SEEDS,
	EffortConfig, KAPPA, LAMBDA_MAXIMIN, PRUNE_KAPPA,
	SURROGATE_MIN_FIT, SURROGATE_MIN_R2, SURROGATE_PAIR_CAP, SURROGATE_PAIR_MIN_COOC, SURROGATE_REFIT_EVERY,
} from './config';
import { BuildRefLite, calibrateNoise, objectiveOf, pairedOf, PairedDiff, SearchEvaluator, statsOf } from './evaluator';
import { NS_SEARCH, NS_VERIFY } from './cache';
import { KnapGroup, mckpSolve, mckpTopK } from './knapsack';
import { affordable, affordableAdds, assertFeasible, assertOnePerGroup, BuildSpace, costOf, OptOption, simIdentity } from './space';
import { fitSurrogate, SurrogateModel, SurrogateSample } from './surrogate';
import {
	ActivationTelemetry, AggregationKind, MeanSem, NoiseInfo, ObjectiveKind, OptimizerProgress,
	OptimizerResult, ScoredBuild, SeedSlot, SeedValue,
} from './types';

/** Objective metric as a per-seed pick: a positive Δ must ALWAYS mean "better"
 *  (meanPlacing sign-flipped; gainVsCurrent reduces to lead under pairing —
 *  the shared reference build cancels). */
export function objPick(obj: ObjectiveKind): (v: SeedValue) => number | null {
	switch (obj) {
		case 'p1': return v => v.win;
		case 'meanLead': return v => v.lead;
		case 'pTop3': return v => v.top3;
		case 'meanPlacing': return v => -v.placing;
		case 'gainVsCurrent': return v => v.lead;
	}
}

// ── §F: the search currency ──────────────────────────────────────────────────

/**
 * §F: how far past 0 a per-seed lead still counts, as a multiple of the measured
 * σ(ℓ). P(1st) is Φ(μ/σ), so a build sitting 2.5 σ ahead of the field has a win
 * rate of 0.994: everything beyond that is a lead the objective cannot see, and
 * paying for it is the §F misalignment (mean ℓ rewarding winning bigger). The
 * clip starts there, and the whole band below it keeps ℓ's slope of 1.
 */
export const LEAD_CLIP_SIGMAS = 2.5;

/** Floor so a noise-free scenario cannot collapse the clip to zero width (at
 *  this width the currency is effectively the hard win indicator, which is what
 *  a noise-free scenario's P(1st) actually is). */
export const LEAD_CLIP_MIN_L = 0.05;

/**
 * §F: the win-rate search currency, the lead clipped to ±clipL. Inside the band it IS
 * ℓ, so every adoption test, the bandit's indifference zone and δ_min read the
 * same numbers they always did; outside it the credit stops growing, which is
 * where P(1st) stopped growing too. Monotone in the lead (non-decreasing,
 * strictly increasing inside the band), so the search can never prefer a
 * smaller lead at the same point.
 */
export function clipLeadL(leadL: number, clipL: number): number {
	const c = Math.max(LEAD_CLIP_MIN_L, clipL);
	return leadL > c ? c : leadL < -c ? -c : leadL;
}

/** The clip width for a measured σ(ℓ) (§7.3). */
export function leadClipL(sigmaLeadL: number): number {
	return Math.max(LEAD_CLIP_MIN_L, LEAD_CLIP_SIGMAS * (Number.isFinite(sigmaLeadL) ? sigmaLeadL : LEAD_CLIP_MIN_L / LEAD_CLIP_SIGMAS));
}

/**
 * Which per-seed value the search screens, adopts and certifies against.
 *  - `aligned` (default, §F): the objective's own shape. The win-rate
 *    objectives (p1, pTop3) search the clipped lead, the handoff's other
 *    form, and the one the A/B acceptance supports: the smoothed win
 *    Φ(ℓ/τ) at a fixed τ = 0.5 L sits BELOW this race noise (σ(ℓ) ≈ 1.6 L),
 *    so it flattens the band where the objective still moves and lost hard
 *    P(1st) on 3 of 24 oracle instances (search.oracle.test.ts). P(top-3) has
 *    no lead threshold of its own (it turns on the 3rd rival, not the best
 *    one), so it gets the same clipped lead. The other objectives keep ℓ.
 *  - `lead`: ℓ for every objective, the pre-§F behaviour kept as the A/B arm
 *    of the acceptance test, and what a §G aggregated run uses, because there
 *    the currency has already been applied per scenario by the adapter.
 * A null lead (a record predating bestRivalFinishTimeRaw) stays null: the seed
 * is unusable, never a zero (§7.1).
 */
export type SearchCurrency = 'aligned' | 'lead';

export function searchPickOf(objective: ObjectiveKind, currency: SearchCurrency = 'aligned', clipL = Infinity): (v: SeedValue) => number | null {
	if (currency === 'lead') return v => v.lead;
	switch (objective) {
		case 'p1':
		case 'pTop3': return v => (v.lead == null ? null : clipLeadL(v.lead, clipL));
		// meanLead / gainVsCurrent / meanPlacing: ℓ is still the currency (§6.1).
		default: return v => v.lead;
	}
}

/**
 * Aggregate a build's per-scenario objective means into one comparable value
 * (§6.4). Higher is always better (the caller's pick already sign-normalises).
 *  - mean: plain average across scenarios.
 *  - maximin: the worst scenario (robust "must not collapse anywhere").
 *  - blend: (1−λ)·mean + λ·min, λ = LAMBDA_MAXIMIN by default.
 * Empty input → −Infinity (an unmeasurable build loses, never wins).
 */
export function aggregateValues(values: readonly number[], aggregation: AggregationKind, lambda = LAMBDA_MAXIMIN): number {
	const v = values.filter(Number.isFinite);
	if (!v.length) return -Infinity;
	const mean = v.reduce((a, b) => a + b, 0) / v.length;
	if (aggregation === 'mean' || v.length === 1) return mean;
	const min = Math.min(...v);
	if (aggregation === 'maximin') return min;
	return (1 - lambda) * mean + lambda * min;
}

/**
 * §E dead skills: purchased options of this build whose recorded activation
 * count is zero over ≥ DEAD_SKILL_MIN_SEEDS measured seeds of the very same
 * build (telemetry folded from the compact records, cache.ts). Such a skill
 * never switched on, so the build minus it performs identically (paired
 * draws: only the skill's own draws differ and were never taken) while
 * costing SP. Returns [] when the build has no telemetry yet, so the rule
 * simply stands down on engines/pipelines that never report counts.
 */
function deadSkills(ev: SearchEvaluator, si: number, b: BuildRefLite): string[] {
	const t = ev.activations?.(NS_SEARCH, si, b.id);
	if (!t || t.seeds < DEAD_SKILL_MIN_SEEDS) return [];
	return b.selection.filter(id => !t.counts[id]);
}

/**
 * §E never-add: adding `id` to `b` is pointless when b itself (the build the
 * add would create) already has telemetry showing id never activated — the
 * zero is measured in that context, so a prerequisite-gated skill that fires
 * in richer builds stays a legal add there.
 */
function addKnownDead(ev: SearchEvaluator, si: number, b: BuildRefLite, id: string): boolean {
	const t = ev.activations?.(NS_SEARCH, si, b.id);
	return !!t && t.seeds >= DEAD_SKILL_MIN_SEEDS && !t.counts[id];
}

export interface SearchInput {
	space: BuildSpace;
	/** Scenario to optimize against. When `scenarioIdxs` is absent, this single
	 *  scenario is the whole scenario set (the common default, §6.3). */
	scenarioIdx: number;
	/** Scenario set for robustness (§6.3). With a mean aggregation each is
	 *  searched and the shortlists are merged and re-verified across all of them;
	 *  with maximin/blend one aggregated search runs over the whole set unless
	 *  `aggregatedSearch: false` (§G). Either way the recommendation aggregates
	 *  by `aggregation` (§6.4). Empty/omitted → [scenarioIdx]. */
	scenarioIdxs?: number[];
	objective: ObjectiveKind;
	aggregation: AggregationKind;
	effort: EffortConfig;
	/** §F: which per-seed currency the search decides on (default 'aligned').
	 *  'lead' runs the pre-§F search on ℓ for every objective — the A/B arm of
	 *  the acceptance test, and the mode a §G aggregated run uses because the
	 *  adapter has already applied the currency per scenario. */
	searchCurrency?: SearchCurrency;
	/**
	 * §G: with more than one scenario AND a maximin/blend aggregation, run ONE
	 * search on the aggregated objective (every candidate simulated in every
	 * scenario, Stage D and the §C climb adopting on the aggregated value)
	 * instead of searching each scenario apart and picking afterwards.
	 * Default true; false keeps the §6.3 per-scenario path.
	 */
	aggregatedSearch?: boolean;
	/** The user's current build (gainVsCurrent pairs against it). */
	current?: BuildRefLite;
	/** Stage A opening-book starts (§8 A): affordable prior builds used as extra
	 *  restart points. They only seed the search; every decision is still made
	 *  by simulation (P1). Affordability is re-checked against the current space. */
	bookStarts?: readonly string[][];
}

export interface SearchController {
	/** Stop pressed (UI): finish the current batch, then a short Stage G on top 3. */
	stop(): void;
	stopped(): boolean;
}

export function createController(): SearchController {
	let isStopped = false;
	return { stop: () => { isStopped = true; }, stopped: () => isStopped };
}

const isTie = (ci: [number, number]) => ci[0] <= 0 && ci[1] >= 0;

/** Harness-gated trace (the oracle test toggles it for one instance). */
const dbg = (...a: unknown[]) => { if ((globalThis as any).OPT_DBG) console.error('[opt]', ...a); };

/** Harness-gated traces for the oracle tests (like OPT_DBG): every adoption
 *  (with its path: Stage D resolve/fallback, the §C climb, or a §E dead-skill
 *  sale, which is adopted without a test) and every restart's final build. */
const traceAdopt = (b: BuildRefLite, via: 'resolve' | 'fallback' | 'climb' | 'dead'): void => {
	const a = (globalThis as any).OPT_ADOPTIONS as { build: BuildRefLite; via: string }[] | undefined;
	if (a) a.push({ build: b, via });
};
const traceRestartEnd = (b: BuildRefLite): void => {
	const a = (globalThis as any).OPT_RESTART_ENDS as BuildRefLite[] | undefined;
	if (a) a.push(b);
};

/** §I.5: the bandit's prior from the surrogate — each candidate's predicted Δ
 *  vs the batch incumbent, SE from the COVARIANCE of that difference
 *  (predictDiff, §I.1). Unlike the ordering/acquisition use (gated on r2), the
 *  prior runs on the raw fit: its authority is its own posterior SE — a cut
 *  needs gain + κ·SE < δ_min, and an unidentified model has honest, wide SEs,
 *  so it self-silences instead of mispruning. Null (no opinion) when either
 *  build holds features the model never saw: a prior may only cut what it knows. */
function diffPrior(sm: SurrogateModel | null, inc: BuildRefLite): BanditOpts['prior'] {
	if (!sm) return undefined;
	const model = sm; // non-null for the closure
	return (b: BuildRefLite) => {
		if (!model.covers(b.selection) || !model.covers(inc.selection)) return null;
		const p = model.predictDiff(b.selection, inc.selection);
		return { gain: p.mean, se: p.se };
	};
}

/** A resolved build reference (identity + selection) for a selection. */
function buildRef(space: BuildSpace, selection: readonly string[]): BuildRefLite {
	return { id: simIdentity(space, selection), selection: [...selection] };
}

/**
 * §7.3: the builds the noise calibration reads, the cheapest affordable single
 * adds on top of the base build. Shared by the pipeline (which measures them)
 * and by the §G aggregated branch (which only re-reads them from the real
 * evaluator, so the reported σΔ(ℓ) stays a lead margin in lengths).
 */
function noiseVariantSelections(space: BuildSpace, cfg: EffortConfig): string[][] {
	const out: string[][] = [];
	for (const o of space.options.filter(o => !o.forced).sort((a, b) => a.cost - b.cost)) {
		if (out.length >= cfg.noiseVariants) break;
		if (affordable(space, [o.id])) out.push([o.id]);
	}
	return out;
}

/** Count measured (non-null, non-err) slots of a cached build. */
function filled(ev: SearchEvaluator, ns: string, si: number, b: BuildRefLite): number {
	let n = 0;
	for (const s of ev.slots(ns, si, b.id)) if (s != null && s !== 'err') n++;
	return n;
}

/** Spearman rank correlation (average ranks for ties). */
function spearman(xs: number[], ys: number[]): number {
	const ranks = (xs: number[]) => {
		const idx = [...xs.keys()].sort((a, b) => xs[a] - xs[b]);
		const r = new Array<number>(xs.length);
		for (let i = 0; i < idx.length;) {
			let j = i;
			while (j + 1 < idx.length && xs[idx[j + 1]] === xs[idx[i]]) j++;
			const avg = (i + j) / 2 + 1;
			for (let k = i; k <= j; k++) r[idx[k]] = avg;
			i = j + 1;
		}
		return r;
	};
	const rx = ranks(xs), ry = ranks(ys);
	const n = xs.length;
	if (n < 3) return NaN;
	const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
	let sxy = 0, sxx = 0, syy = 0;
	for (let i = 0; i < n; i++) { const dx = rx[i] - mx, dy = ry[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
	return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
}

/** Full B–F+G pipeline for ONE scenario (§6.3: the scenario set loops this). */
async function runSingleScenario(
	ev: SearchEvaluator,
	input: SearchInput,
	ctrl: SearchController,
	onProgress: (p: OptimizerProgress) => void,
): Promise<OptimizerResult> {
	const { space, scenarioIdx: si, objective, effort: cfg } = input;
	const t0 = Date.now();
	const pick = objPick(objective);
	// What the search screens, adopts and certifies against is built right after
	// the §7.3 noise calibration below (§F: the win-rate objectives search the
	// lead clipped to the band the objective can still see, the rest keep ℓ, the
	// §6.1 currency). The selected objective drives the shortlist, verification
	// and the final rows either way.
	const vs = input.current;

	const refOf = (selection: readonly string[]): BuildRefLite => buildRef(space, selection);
	/** selection + option, honouring group exclusivity (drop the group's old pick). */
	const withOption = (selection: readonly string[], opt: OptOption): BuildRefLite =>
		refOf([...selection.filter(s => space.byId.get(s)?.groupId !== opt.groupId), opt.id]);
	/** Knapsack picks → selection: forced ids are implicit in fixedIds/simIds. */
	const selFromKnap = (ids: Iterable<string>): string[] => [...ids].filter(id => !space.byId.get(id)?.forced);

	const evaluated = new Map<string, BuildRefLite>();
	const remember = (b: BuildRefLite): BuildRefLite => { if (!evaluated.has(b.id)) evaluated.set(b.id, b); return b; };

	// §E activation telemetry, folded from the compact records of the races
	// this pipeline already ran (cache.ts). Two rules read it: a purchased
	// skill that recorded zero activations on ≥ DEAD_SKILL_MIN_SEEDS seeds of
	// its own build is sold without a test and without spending races (its Δ
	// vs the leaner build is 0 by construction under paired draws), and an
	// add is never offered when the build it would create already shows the
	// skill recorded zero. Both zeros are measured in that exact build, so a
	// skill gated on activate_count_* conditions that does fire in richer
	// builds stays a legal add there. Without telemetry (no counts reported),
	// both rules stand down.
	const tele = (b: BuildRefLite): ActivationTelemetry | null => ev.activations?.(NS_SEARCH, si, b.id) ?? null;
	const addDead = (b: BuildRefLite, id: string): boolean => addKnownDead(ev, si, b, id);
	/** Sell every known-dead skill of b (free: no test, no new races). */
	const sellDead = (b: BuildRefLite): BuildRefLite => {
		const dead = deadSkills(ev, si, b);
		if (!dead.length) return b;
		const leaner = remember(refOf(b.selection.filter(id => !dead.includes(id))));
		assertFeasible(space, leaner.selection);
		traceAdopt(leaner, 'dead');
		dbg('  §E dead-skill sale', dead.join('+'), '→', leaner.id || '(base)');
		return leaner;
	};

	// ── §K: the race plan behind the progress bar / ETA ───────────────────────
	// The old plan (`restarts × dMaxIters × batchCap`) assumed a capped climb
	// that no longer exists: the §C climb has no round cap. What bounds the
	// search now is the per-restart climbRaces budget (config: "keep race
	// budgets instead"), the dMaxIters-capped Stage D rounds, and the ladder's
	// own stopping condition, so the plan reflects those: a preset budget per
	// not-yet-run restart up front, replaced by the MEASURED per-restart cost
	// once restarts complete (the running estimate), plus the verification
	// slack. untilStopped (climbRaces = Infinity) has no budget to plan from:
	// no ETA until the first restart ends tells us what a restart costs (the
	// anytime UI already tolerates a missing etaMs / racesPlanned).
	const perRestartPlan = (): number | undefined =>
		Number.isFinite(cfg.climbRaces) ? cfg.dMaxIters * cfg.batchCap + cfg.climbRaces : undefined;
	let startCount = Math.max(1, cfg.restarts); // Stage C replaces it with the real restart count
	let searchRaces0 = 0; // races spent before the restart loop starts
	const restartRaceMarks: number[] = []; // total races at each completed restart
	const planOf = (races: number): number | undefined => {
		const done = restartRaceMarks.length;
		const rest = Math.max(0, startCount - done);
		if (rest > 0) {
			const per = done ? (restartRaceMarks[done - 1] - searchRaces0) / done : perRestartPlan();
			return per === undefined ? undefined : Math.round(races + per * rest);
		}
		// All restarts in: what remains is Stage G verification (pool ≈ 5 + vs,
		// gSeedsMin each; any growth beyond that stays visible in racesRun).
		const at = done ? restartRaceMarks[done - 1] : searchRaces0;
		return Math.round(at + Math.max(races - at, 6 * cfg.gSeedsMin));
	};
	const emit = (stage: OptimizerProgress['stage'], note?: string, best?: ScoredBuild): void => {
		const races = ev.racesRun();
		const planned = planOf(races);
		onProgress({
			stage, racesRun: races, racesPlanned: planned ?? 0, elapsedMs: Date.now() - t0,
			etaMs: planned !== undefined && races > 100
				? Math.round((Date.now() - t0) / races * Math.max(0, planned - races))
				: undefined,
			best, note,
		});
	};
	const provisional = (b: BuildRefLite): ScoredBuild | undefined => {
		const obj = ev.objective(NS_SEARCH, si, b, objective, vs);
		if (!obj || obj.n === 0 || !Number.isFinite(obj.mean)) return undefined;
		const sp = costOf(space, b.selection, true);
		return { build: b, sp, leftover: space.budget - sp, skillCount: b.selection.length, obj, provisional: true };
	};

	// §3.B.2: every restart's final build; the shortlist always includes them
	// (Stage G can only choose among the builds it is given).
	const restartEnds: BuildRefLite[] = [];
	// §C certificates per restart end: p1 = every feasible N1 move (drop, add,
	// swap, 2-for-1, 1-for-2) had its UCB on Δ below δ_min; p2 = the N2 screen
	// (2-for-2 among the 8 lowest-value owned × the 8 best free) was clean too.
	const peakCerts = new Map<string, { p1: boolean; p2: boolean }>();

	// §K: what the cache must never evict (handoff §K, the pin-less
	// evict(new Set()) that CACHE_PIN_TOP was written for): the current
	// incumbent (every bandit rung compares against it), every restart end
	// (the shortlist's mandatory slots), and the Stage G shortlist once it
	// exists (verification grows the same slots round by round). Re-registered
	// at every incumbent change and at Stage G; the evaluator enforces the
	// CACHE_PIN_TOP cap per namespace.
	const pinnedShort = new Set<string>();
	const pinSearch = (inc?: BuildRefLite): void => {
		if (!ev.pinBuilds) return;
		const ids = new Set<string>();
		if (inc) ids.add(inc.id);
		for (const b of restartEnds) ids.add(b.id);
		for (const id of pinnedShort) ids.add(id);
		ev.pinBuilds(NS_SEARCH, si, [...ids]);
	};

	// ── Stage 0: noise calibration (§7.3; search-namespace seeds, reused later) ──
	const base = remember(refOf([]));
	emit('noise');
	const noiseVariants: BuildRefLite[] = noiseVariantSelections(space, cfg).map(sel => remember(refOf(sel)));
	const noise: NoiseInfo = await calibrateNoise(ev, cfg, si, base, noiseVariants);
	// §F: now the σ(ℓ) is known, the search currency: ℓ inside ±2.5 σ of the
	// finish line, flat beyond it, which is where P(1st) stopped growing too.
	const searchPick = searchPickOf(objective, input.searchCurrency, leadClipL(noise.sigmaLead));

	// ── Stage G machinery (also the Stop path): verify a shortlist fresh ──────
	const verify = async (short: BuildRefLite[], nMin: number, nCap: number, stoppedEarly: boolean): Promise<OptimizerResult> => {
		const pool = [...short];
		if (vs && !pool.some(b => b.id === vs.id)) pool.push(vs); // gainVsCurrent needs the reference row verified too
		// §K: pin the verification pool (every growth round re-ensures the same
		// slots, so an eviction is a re-fetch), and keep the shortlist's search
		// data warm too (orderingCorrelation / bestActivations read it here).
		if (ev.pinBuilds) {
			for (const b of pool) pinnedShort.add(b.id);
			ev.pinBuilds(NS_VERIFY, si, pool.map(b => b.id));
			pinSearch();
		}
		const rowsOf = (b: BuildRefLite) => ({ obj: ev.objective(NS_VERIFY, si, b, objective, vs), stats: ev.stats(NS_VERIFY, si, b) });
		const rankedOf = () => pool
			.map(b => ({ b, ...rowsOf(b) }))
			.filter(x => x.obj && x.obj.n > 0 && Number.isFinite(x.obj!.mean))
			.sort((a, b) => b.obj!.mean - a.obj!.mean || (a.b.id < b.b.id ? -1 : 1));
		let n = nMin;
		for (;;) {
			const positions = Array.from({ length: n }, (_, i) => i);
			await ev.ensure(pool.map(b => ({ ns: NS_VERIFY, scenarioIdx: si, build: b, positions })));
			const ranked = rankedOf();
			if (ranked.length >= 2) {
				const top = ev.paired(NS_VERIFY, si, ranked[0].b, ranked[1].b, pick);
				if (top && !isTie(top.ci95)) break; // #1 vs #2 resolved (§G)
			}
			emit('verify', `verifying ${n}/${nCap} seeds`);
			// Stop mid-verify: truncate on the spot like verifyAcross (anytime, P5).
			if (ctrl.stopped() || n >= nCap) break;
			n = Math.min(nCap, n + Math.max(500, Math.floor(cfg.gSeedsMin / 4)));
		}
		const ranked = rankedOf();
		if (!ranked.length) throw new Error('optimizer: verification produced no measurable builds');
		const pairedCiVs = (b: BuildRefLite): [number, number] => {
			const p = ev.paired(NS_VERIFY, si, ranked[0].b, b, pick);
			return p ? p.ci95 : [0, 0]; // no common seeds ⇒ cannot claim a difference: honest tie
		};
		let rows: ScoredBuild[] = ranked.map(({ b, obj, stats }) => {
			const sp = costOf(space, b.selection, true);
			return {
				build: b, sp, leftover: space.budget - sp, skillCount: b.selection.length,
				obj: obj!, stats: stats ?? undefined, provisional: false,
				tiedWithBest: b.id !== ranked[0].b.id && isTie(pairedCiVs(b)),
			};
		});
		// Recommendation inside the tie group: more SP left, then fewer skills (§G).
		const group = rows.filter(r => r.tiedWithBest || r.build.id === ranked[0].b.id);
		const best = group.sort((a, b) =>
			b.leftover - a.leftover || a.skillCount - b.skillCount || b.obj.mean - a.obj.mean || (a.build.id < b.build.id ? -1 : 1))[0];
		rows = [best, ...rows.filter(r => r.build.id !== best.build.id)];
		for (const r of rows) {
			if (r.build.id === best.build.id) { r.tiedWithBest = false; continue; }
			const p = ev.paired(NS_VERIFY, si, best.build, r.build, pick);
			r.tiedWithBest = p ? isTie(p.ci95) : true; // no common seeds ⇒ honest tie
		}
		// §13.3 invariants — an over-budget or double-group build must never escape.
		assertFeasible(space, best.build.selection);
		assertOnePerGroup(space, best.build.selection);
		// §6.1 debug log: ℓ-rank vs P(1st)-rank agreement over the shortlist.
		const lens = rows.map(r => ev.stats(NS_SEARCH, si, r.build)?.lead.mean ?? NaN);
		const wins = rows.map(r => ev.stats(NS_SEARCH, si, r.build)?.win.mean ?? NaN);
		const orderingCorrelation = spearman(lens.filter(Number.isFinite), wins.filter(Number.isFinite));
		emit('done');
		let maxSearchFilled = 0;
		for (const b of evaluated.values()) maxSearchFilled = Math.max(maxSearchFilled, filled(ev, NS_SEARCH, si, b));
		const cert = peakCerts.get(best.build.id);
		return {
			best, shortlist: rows, noise,
			verificationSeeds: n,
			searchSeedsPerScenario: maxSearchFilled,
			stoppedEarly: stoppedEarly || ctrl.stopped(),
			certified1MovePeak: cert?.p1 === true,
			certified2MovePeak: cert?.p2 === true,
			orderingCorrelation: Number.isFinite(orderingCorrelation) ? orderingCorrelation : undefined,
			// §E: per-skill activation report of the recommendation, from the
			// search races already run (the pane shows the rate next to each
			// skill and flags one under 5%).
			bestActivations: tele(best.build) ?? undefined,
		};
	};

	if (ctrl.stopped()) return verify(await shortlistBy(ev, si, evaluated, restartEnds, objective, vs, 3, space), Math.min(1000, cfg.gSeedsCap), Math.min(1000, cfg.gSeedsCap), true);

	// ── Stage B: screening chart — out-of-context v⁰ (chart-parity filter) ──
	emit('screen', `screening ${space.options.filter(o => !o.forced).length} options`);
	const adds = new Map<string, BuildRefLite>();
	for (const o of space.options) if (!o.forced) adds.set(o.id, remember(withOption([], o)));
	const v0 = new Map<string, MeanSem>();
	{
		const measured = (id: string, b: BuildRefLite) => {
			const d = ev.paired(NS_SEARCH, si, b, base, searchPick); // the search currency, same as every later decision (§6.1, §F)
			if (d) v0.set(id, { mean: d.mean, sem: d.sem, n: d.n });
		};
		const r1 = Array.from({ length: cfg.screenRound1Seeds }, (_, i) => i);
		await ev.ensure([
			{ ns: NS_SEARCH, scenarioIdx: si, build: base, positions: r1 },
			...[...adds.values()].map(b => ({ ns: NS_SEARCH, scenarioIdx: si, build: b, positions: r1 })),
		]);
		adds.forEach((b, id) => measured(id, b));
		let survivors = [...adds.keys()];
		if (survivors.length > 40) { // chart's two-round filter, only when it pays
			// (The floor is a length floor and v0 is the search currency: near the
			// finish line the two are the same number, and past it a real effect
			// that the objective cannot see is exactly what this filter drops.)
			survivors = survivors.filter(id => {
				const v = v0.get(id)!;
				const spread = Number.isFinite(v.sem) ? Math.sqrt(Math.max(1, v.n)) * v.sem : Infinity;
				return Math.abs(v.mean) >= cfg.screenFilterMaxL || spread >= cfg.screenFilterSpreadL;
			}).sort((a, b) => Math.abs(v0.get(b)!.mean) - Math.abs(v0.get(a)!.mean)).slice(0, 40);
		}
		if (survivors.length) {
			const r2 = Array.from({ length: cfg.screenRound2Seeds }, (_, i) => i);
			await ev.ensure([
				{ ns: NS_SEARCH, scenarioIdx: si, build: base, positions: r2 },
				...survivors.map(id => ({ ns: NS_SEARCH, scenarioIdx: si, build: adds.get(id)!, positions: r2 })),
			]);
			for (const id of survivors) measured(id, adds.get(id)!);
		}
	}
	dbg('v0', [...v0.entries()].map(([k, v]) => k + ':' + v.mean.toFixed(2) + '±' + v.sem.toFixed(2)).join(' '));
	if (ctrl.stopped()) return verify(await shortlistBy(ev, si, evaluated, restartEnds, objective, vs, 3, space), Math.min(1000, cfg.gSeedsCap), Math.min(1000, cfg.gSeedsCap), true);

	// ── Stage C: starting builds by multiple-choice knapsack ──────────────────
	emit('knapsack');
	const knapGroups = (): KnapGroup[] => [...space.groups.entries()].map(([groupId, opts]) => ({
		groupId,
		// Forced options stay in the item list: mckpSolve looks the forcedId up
		// among the group's items, pre-commits it, shrinks the capacity, and
		// skips the group (its selFromKnap strips the forced picks back out).
		options: opts.map(o => ({ id: o.id, cost: o.cost, value: v0.get(o.id)?.mean ?? 0 })),
		forcedId: opts.find(o => o.forced)?.id,
	}));
	dbg('starts');
	// §3.B.4: restarts start from the knapsack solutions and opening-book
	// entries only — an empty restart just re-runs restart 1's first re-solve
	// and wastes a restart slot.
	const startBuilds: BuildRefLite[] = [];
	for (const sol of mckpTopK(knapGroups(), space.budget, Math.max(1, cfg.restarts))) {
		const b = remember(refOf(selFromKnap(sol.selection.values())));
		if (!startBuilds.some(s => s.id === b.id)) startBuilds.push(b);
	}
	// Stage A opening book (§8 A): prior strong builds become extra restart
	// points when still affordable + legal. Re-filtered against the CURRENT
	// space, so a stale book entry can only ever be skipped, never misused.
	for (const sel of input.bookStarts ?? []) {
		if (startBuilds.length >= cfg.restarts + 5) break;
		const clean = sel.filter(id => space.byId.has(id) && !space.byId.get(id)?.forced);
		if (!clean.length) continue;
		const b = remember(refOf(clean));
		if (!affordable(space, b.selection)) continue;
		if (!startBuilds.some(s => s.id === b.id)) startBuilds.push(b);
	}
	emit('knapsack', `${startBuilds.length} restart points`, startBuilds.length ? provisional(startBuilds[startBuilds.length - 1]) : undefined);

	// ── Stage E: surrogate model state (§8 E) ─────────────────────────────────
	// Every cached build with a decent search-ℓ estimate becomes a training
	// row (mean = ℓ, weight = inverse variance of that mean = n/var). One global
	// model across restarts (all builds share the cache); refit as the set
	// grows. Below the R² gate the surrogate stops driving Stage F ordering and
	// the pipeline falls back to in-context ctxVal (§8 E, plan risk row).
	const surrTrain = new Map<string, SurrogateSample>();
	let surrogate: SurrogateModel | null = null;
	let surrSinceFit = 0;
	const surrHarvest = (b: BuildRefLite) => {
		if (!cfg.surrogate || surrTrain.has(b.id)) return;
		const s = ev.stats(NS_SEARCH, si, b)?.lead;
		if (!s || s.n < 20 || !Number.isFinite(s.mean) || !Number.isFinite(s.sem)) return;
		surrTrain.set(b.id, { selection: b.selection, mean: s.mean, weight: 1 / (s.sem * s.sem + 1e-6) });
		surrSinceFit++;
	};
	const surrModel = (): SurrogateModel | null => (surrogate && surrogate.r2 >= SURROGATE_MIN_R2) ? surrogate : null;
	const surrRefit = () => {
		if (!cfg.surrogate || surrTrain.size < SURROGATE_MIN_FIT) return;
		if (surrSinceFit < SURROGATE_REFIT_EVERY && surrogate) return;
		const m = fitSurrogate([...surrTrain.values()], { minPairCooccur: SURROGATE_PAIR_MIN_COOC, pairCap: SURROGATE_PAIR_CAP });
		if (m.ok) { surrogate = m; surrSinceFit = 0; dbg('surrogate fit', 'n', m.n, 'R2', m.r2.toFixed(3), 'terms', m.terms); }
	};
	// A live surrogate + the incumbent's actual ℓ lets Stage F order moves by
	// acquisition (gain + κ·SE) and prune on the optimistic bound (§8F α/β).
	const surrScore = (E: BuildRefLite) => {
		const m = surrModel();
		return m ? { model: m, xL: ev.stats(NS_SEARCH, si, E)?.lead.mean ?? m.predict(E.selection).mean } : undefined;
	};
	// Seed the first fit from everything already measured (screening adds carry
	// real out-of-context ℓ), then keep feeding it as D/F measure more.
	surrHarvest(base);
	adds.forEach(b => surrHarvest(b));
	for (const b of startBuilds) surrHarvest(b);
	surrRefit();

	// ── Stage D+F: in-context search per restart (plan §8: restarts run D–F
	//    from each start while the budget remains; global best across them) ──
	startBuilds.forEach((b, i) => dbg('start', i, b.id || '(base)'));
	const histAdopted = new Set<string>(); // §8F history heuristic: skills that already paid off
	// §K: the running-estimate baseline: everything before the loop is measured
	// now; the loop's forward plan uses the real restart count.
	searchRaces0 = ev.racesRun();
	startCount = startBuilds.length;
	for (let s = 0; s < startBuilds.length; s++) {
		if (ctrl.stopped()) break;
		if (Date.now() - t0 > cfg.timeBudgetMs) { dbg('time budget hit at restart', s); break; }
		let X = startBuilds[s];
		const value = new Map<string, number>();   // in-context option values (ℓ deltas)
		const valueN = new Map<string, number>();  // …and the seed count each was measured at
		// In-context value for knapsack/move estimates: a measurement at n seeds
		// is shrunk toward the out-of-context v⁰ (pseudo-count 25) — deep-ladder
		// survivors are trusted, 50-seed strays are damped.
		const ctxVal = (id: string): number => {
			const m = value.get(id);
			if (m == null) return v0.get(id)?.mean ?? 0;
			const p = v0.get(id);
			if (!p) return m;
			const n = valueN.get(id) ?? 0;
			return (n * m + 25 * p.mean) / (n + 25);
		};
		/** Fold bandit outcomes into the value maps (D and the §C climb share the
		 *  semantics). `replaced`/`extraDrop` are the skills a move sold;
		 *  `pairWith` marks a 1-for-2-style double add. */
		const applyMeasured = (
			outcomes: { build: BuildRefLite; diff: PairedDiff }[],
			dropOf: Map<string, string>,
			addedOf: Map<string, { opt: string; replaced?: string; extraDrop?: string; pairWith?: string }>,
		) => {
			const backOf = (id?: string): number =>
				id ? (value.get(id) ?? v0.get(id)?.mean ?? 0) : 0;
			for (const out of outcomes) {
				const drop = dropOf.get(out.build.id);
				if (drop != null) { value.set(drop, -out.diff.mean); valueN.set(drop, out.diff.n); } // ℓ(X) − ℓ(X−i)
			}
			// Singles first, then pairs (a direct single measurement always
			// beats the pair's half-split floor estimate — two passes, no race).
			for (const out of outcomes) {
				const add = addedOf.get(out.build.id);
				if (!add || add.pairWith) continue;
				// Δ of (X minus what it sold, plus opt) vs X is v_opt − Σv_sold;
				// put the sold values back (measured, or fall back to the
				// out-of-context v⁰) so the knapsack gets v_opt.
				const back = backOf(add.replaced) + backOf(add.extraDrop);
				value.set(add.opt, out.diff.mean + back); valueN.set(add.opt, out.diff.n);
			}
			for (const out of outcomes) {
				const add = addedOf.get(out.build.id);
				if (!add || !add.pairWith) continue;
				// Pair add Δ splits half/half as a floor estimate — never
				// overwrite a direct single-option measurement. A 1-for-2 puts
				// its dropped skill's value back before halving.
				const half = (out.diff.mean + backOf(add.replaced)) / 2;
				if (!value.has(add.opt)) { value.set(add.opt, half); valueN.set(add.opt, out.diff.n); }
				if (!value.has(add.pairWith)) { value.set(add.pairWith, half); valueN.set(add.pairWith, out.diff.n); }
			}
		};
		for (let it = 0; it < cfg.dMaxIters; it++) {
			if (Date.now() - t0 > cfg.timeBudgetMs) break;
			// §E: sell known-dead skills before weighing the round (free).
			X = sellDead(X);
			pinSearch(X); // §K: the incumbent of this round's ladders is pinned
			emit('incontext', `restart ${s + 1}/${startBuilds.length} round ${it + 1}/${cfg.dMaxIters}`, provisional(X));
			// ── §K: over-budget adds are measured for the knapsack re-solve ────
			// An over-budget "X+j" is never adopted (the fallback filter below
			// refuses it); its only consumer is the value the re-solve sees for
			// j. So measure one only when its value could actually change that
			// solution (§K.3, after §I.5: "measure only options whose
			// predictions are uncertain or near the cutoff"; with a budget for
			// ~20 skills nearly every plain add is over-budget, and measuring
			// the lot was the expensive part). One probe solve answers it:
			// the re-solve's groups at the same values, but j valued OPTIMISTIC
			// (predictDiff(X+j, X).mean + the displaced pick's ctxVal +
			// PRUNE_KAPPA·SE, the same α/β optimism the §I.5 prior cut uses).
			// Knapsack solutions are monotone in item values: an option that
			// loses at its optimistic value loses at its true one too and can
			// never enter the solution, so measuring it changes nothing (an
			// option that cannot even fit the capacity is cut the same way:
			// mckpSolve drops it from the DP before the first cell). No model,
			// or one that has not seen these builds: measure. A model may only
			// certify what it has seen, and a weak fit carries huge SEs
			// (predScale, §I), so it self-silences here.
			const dSm = surrModel();
			// In-context value for the re-solve (see the re-solve comment
			// below). id + group parameters: the space's option list and the
			// re-solve's item view share one value function.
			const dValue = (id: string, groupId: string): number => {
				if (value.has(id) || !dSm || !dSm.covers(X.selection)) return ctxVal(id);
				const opt = space.byId.get(id);
				if (!opt) return ctxVal(id);
				const b = withOption(X.selection, opt);
				if (!dSm.covers(b.selection)) return ctxVal(id);
				const covering = X.selection.find(x => space.byId.get(x)?.groupId === groupId);
				return dSm.predictDiff(b.selection, X.selection).mean + (covering ? ctxVal(covering) : 0);
			};
			let dView: KnapGroup[] | null = null; // the re-solve's groups, pre-bandit values (lazily, first probe only)
			const overBudgetCut = (o: OptOption, b: BuildRefLite, covering: string | undefined): boolean => {
				const raw = surrogate;
				if (!raw || !raw.covers(X.selection) || !raw.covers(b.selection)) return false;
				const pd = raw.predictDiff(b.selection, X.selection);
				const vOpt = pd.mean + (covering ? ctxVal(covering) : 0) + PRUNE_KAPPA * pd.se;
				dView ??= knapGroups().map(g => ({ ...g, options: g.options.map(x => ({ ...x, value: dValue(x.id, g.groupId) })) }));
				const probe: KnapGroup[] = dView.map(g => g.groupId === o.groupId
					? { ...g, options: g.options.map(x => x.id === o.id ? { ...x, value: vOpt } : x) }
					: g);
				const sol = mckpSolve(probe, space.budget);
				if (!sol || sol.selection.get(o.groupId) === o.id) return false; // still wins optimistically (or no opinion): measure
				dbg('  §K over-budget skip', o.id, 'optimistic value', vOpt.toFixed(3), 'cannot take the re-solve');
				return true;
			};
			// Neighbourhood: drop each owned pick, add each uncovered option
			// (over-budget adds evaluated too, their numbers feed the re-solve;
			// §K: only the ones that can change it).
			const cands: BuildRefLite[] = [];
			const dropOf = new Map<string, string>(); // build id → dropped option
			const addedOf = new Map<string, { opt: string; replaced?: string; pairWith?: string }>();
			for (const id of X.selection) {
				const b = remember(refOf(X.selection.filter(x => x !== id)));
				dropOf.set(b.id, id);
				cands.push(b);
			}
			for (const o of space.options) {
				if (o.forced || X.selection.includes(o.id)) continue;
				// Uncovered group: plain add. Covered group (i = current pick):
				// evaluate X − i + j — §8D "X + j (with tier replacement)", the
				// in-context number the knapsack re-solve needs to flip a group.
				const b = remember(withOption(X.selection, o));
				if (addDead(b, o.id)) continue; // §E never-add: recorded never to fire in this build
				const covering = X.selection.find(x => space.byId.get(x)?.groupId === o.groupId);
				if (!affordable(space, b.selection) && overBudgetCut(o, b, covering)) continue; // §K
				addedOf.set(b.id, covering ? { opt: o.id, replaced: covering } : { opt: o.id });
				cands.push(b);
			}
			// Pair adds (§8F move 4, early via the trivial v⁰>0 flag — Stage E
			// later replaces this flag with surrogate synergy detection): builds
			// where TWO individually-small options pay off together. On round 0
			// of each restart the seed set widens to best-positive × every free
			// option — a synergy can hide behind a partner whose own Δ looks
			// negative (overlap masking), so don't gate on its sign there.
			{
				const valOf = (id: string) => value.get(id) ?? v0.get(id)?.mean ?? 0;
				const free = space.options.filter(o => !o.forced && !X.selection.includes(o.id));
				const pos = free.filter(o => valOf(o.id) > 0).sort((a, b) => valOf(b.id) - valOf(a.id));
				const pairSet = new Set<string>();
				const addPair = (a: OptOption, c: OptOption) => {
					if (a.groupId === c.groupId) return;
					const key = a.id < c.id ? a.id + '|' + c.id : c.id + '|' + a.id;
					if (pairSet.has(key)) return;
					pairSet.add(key);
					const [A, C] = a.id < c.id ? [a, c] : [c, a];
					const b = remember(withOption(withOption(X.selection, A).selection, C));
					if (addDead(b, A.id) || addDead(b, C.id)) return; // §E never-add
					addedOf.set(b.id, { opt: A.id, pairWith: C.id });
					cands.push(b);
				};
				for (let a = 0; a < pos.length && a < 3; a++) for (let c = a + 1; c < pos.length; c++) addPair(pos[a], pos[c]);
				if (it === 0) for (const a of pos.slice(0, 2)) for (const c of free) if (a.id !== c.id) addPair(a, c);
			}
			// §I.5: the surrogate enters this batch as the bandit's PRIOR (the
			// old α/β prune did the same job on inflated marginals — §I.1:
			// sqrt(se² + se²) counts every shared feature twice): a candidate
			// whose predicted Δ vs X, with the SE of the DIFFERENCE from
			// predictDiff, has an optimistic bound (gain + PRUNE_KAPPA·SE, the
			// same α/β rule §8 E used) under δ_min is cut before its first
			// race. No opinion (either build holds unseen features) → it races;
			// everything that races lives and dies by the §9/§D ladder exactly
			// as before. This decides what to simulate (P1) — the re-solve
			// below still runs on measured values plus the model's in-context
			// values (§I.5).
			dbg('D s', s, 'it', it, 'X', X.id || '(base)', 'cands', cands.length);
			const bres = await banditVsIncumbent(ev, {
				ns: NS_SEARCH, scenarioIdx: si, incumbent: X,
				candidates: cands.sort((a, b) => (a.id < b.id ? -1 : 1)), pick: searchPick, cfg,
				prior: diffPrior(surrogate, X), // the raw fit, not the r2-gated one (see diffPrior)
			});
			if (bres.priorCut) dbg('  prior-cut', bres.priorCut, 'of', cands.length, 'candidates (Δ-SE bound under δ_min)');
			const outcomes = bres.measured; // eliminated candidates' numbers feed the re-solve too (§8D)
			if (bres.capCut) { // §D.4: the alive cap bound this batch, not the indifference zone
				dbg('  D alive cap cut', bres.capCut, 'candidates beyond', BANDIT_MAX_ALIVE);
				emit('incontext', `restart ${s + 1}/${startBuilds.length} · alive cap cut ${bres.capCut}`, provisional(X));
			}
			applyMeasured(outcomes, dropOf, addedOf);
			for (const out of outcomes) surrHarvest(out.build);
			surrHarvest(X); surrRefit();
			for (const out of outcomes) dbg('  meas', out.survived ? '+' : '-', out.build.id || '(base)', 'Δ', out.diff.mean.toFixed(3), 'n', out.diff.n);
			// Re-solve the knapsack with in-context values. §I.5 value provider:
			// measured value (shrunk toward v⁰) wins; else, when the model saw
			// both builds, its IN-CONTEXT option value — predictDiff(X+o, X)
			// reads the option coefficient together with its pair terms against
			// the incumbent's own skills — replaces the out-of-context v⁰
			// (adding back the displaced pick's value, same arithmetic as
			// applyMeasured). Uncovered options keep the old v⁰ fallback.
			// (The value function itself, dValue, is defined with the §K
			// probe above; it reads the `value` map, so calling it now sees
			// this round's measurements.)
			const groups: KnapGroup[] = knapGroups().map(g => ({
				...g,
				options: g.options.map(o => ({ ...o, value: dValue(o.id, g.groupId) })),
			}));
			const sol = mckpSolve(groups, space.budget);
			const Y = sol ? remember(refOf(selFromKnap(sol.selection.values()))) : X;
			surrHarvest(Y); surrRefit();
			if (Y.id === X.id) { dbg('  Y==X, stop'); break; } // the build stopped changing
			dbg('  re-solve Y', Y.id || '(base)');
			// Adopt only on a significant improvement (lower CI bound > 0, §8D).
			// §D.3: sequential test, one candidate. Grow Y vs X in rungs and
			// stop as soon as the CI excludes 0 either way or Y's 95% upper
			// bound falls under δ_min (indifference zone: the best case is
			// below what is worth chasing, so no more races). The 150-seed
			// first rung already rejects a dead candidate on the paired record:
			// 1.96·0.16/√150 = 0.026 L under the Standard δ_min of 0.03 L, so
			// seeds only grow on real close calls.
			let d: PairedDiff | null = null;
			let held = Math.min(cfg.batchCap, Math.max(150, filled(ev, NS_SEARCH, si, X)));
			for (;;) {
				const pos = Array.from({ length: held }, (_, i) => i);
				await ev.ensure([
					{ ns: NS_SEARCH, scenarioIdx: si, build: X, positions: pos },
					{ ns: NS_SEARCH, scenarioIdx: si, build: Y, positions: pos },
				]);
				d = ev.paired(NS_SEARCH, si, Y, X, searchPick);
				if (!d || held >= cfg.batchCap) break;
				if (d.ci95[0] > 0 || d.ci95[1] < 0) break; // significant either way, §8D
				if (d.ci95[1] < cfg.deltaMinL) break; // Y cannot show an improvement worth having
				held = Math.min(cfg.batchCap, Math.max(held + BANDIT_RUNG_MIN_SEEDS, Math.ceil(held * 1.5)));
			}
			dbg('  adopt test Δ', d ? d.mean.toFixed(3) : 'null', 'ci', d ? JSON.stringify(d.ci95.map(x => +x.toFixed(3))) : '');
			let adoptedNow = false;
			// §E never-add: a build whose own telemetry already shows one of
			// its skills recorded zero is not adopted, significant or not (a
			// dead skill only ever "wins" on noise).
			if (d && d.ci95[0] > 0 && !deadSkills(ev, si, Y).length) {
				X = Y;
				assertFeasible(space, X.selection); // §3.B.1: an over-budget build can never be X
				traceAdopt(X, 'resolve');
				adoptedNow = true;
			} else {
				// Fallback (plan §8F "adopt the best significant improvement"
				// honored inside D): a bandit survivor with a significant Δ is a
				// safer step than the combined re-solve; hill-climb one move.
				// §3.B.1: only AFFORDABLE survivors qualify — over-budget "X + j"
				// candidates are measured for their knapsack numbers, never
				// adopted (they walked X out of budget and lost the restart).
				const sure = outcomes.filter(out => out.survived && out.diff.n >= 2 && out.diff.ci95[0] > 0
					&& affordable(space, out.build.selection) && !deadSkills(ev, si, out.build).length)
					.sort((a, b) => b.diff.mean - a.diff.mean);
				if (sure.length) {
					X = sure[0].build;
					assertFeasible(space, X.selection);
					traceAdopt(X, 'fallback');
					adoptedNow = true;
					dbg('  fallback adopt', X.id || '(base)', sure[0].diff.mean.toFixed(3));
				}
			}
			if (adoptedNow) {
				for (const id of X.selection) if (!histAdopted.has(id)) histAdopted.add(id);
				emit('incontext', `adopted`, provisional(X));
			} else break;
		}

		// ── Stage F: certified local search + iterated local search (§C) ──────
		// Replaces the old capped sweep (3 rounds × 14 estimate-batched moves
		// pruned by the additive estimate). Now the whole feasible N1
		// neighbourhood — drop, add, swap (same-group = tier move; also every
		// drop's refill), 2-for-1 (which contains the upgrade-and-sell shape:
		// sell a filler, buy the higher tier) and 1-for-2 — is enumerated every
		// round, so everything budget-feasible is one move away. Screening is
		// the §D bandit with its indifference zone, run in waves of CLIMB_WAVE:
		// bad moves die at the first rung, seeds go to contenders. Move order
		// (surrogate acquisition / Σ ctxVal) only sequences the waves; it never
		// excludes a move. The one bound-based exception is §I.5's Δ-SE prior:
		// a wave candidate the model certifies hopeless under δ_min never races,
		// and it counts as resolved for the wave's certification.
		// A round ends three ways:
		//  - adopt the strongest significant improver (one move per round; N1
		//    is rebuilt against the new incumbent next round, and the waves the
		//    round never screened get re-enumerated anyway), or
		//  - every screened candidate's UCB sits under δ_min with no improver:
		//    a CERTIFIED peak, the §C stop certificate. The waves run with the
		//    LUCB rival cut off (only the indifference zone may drop a
		//    candidate) and maxAlive ≥ wave size (no candidate can be cap-cut
		//    out of the proof), so "the round is clean" really bounds every Δ.
		//    Or
		//  - a candidate the zone could not resolve within the ladder ceiling
		//    (§D.4: the indifference zone stopped separating this
		//    neighbourhood): keep the best build, uncertified, and no kicks.
		// There is no round cap (§C): ctrl.stopped(), the preset time budget
		// and the per-restart climbRaces budget bound the loop. After a
		// certified peak the ILS kicks cfg.kicks times (k = 2–4 random
		// feasible swaps biased toward low in-build value) and re-climbs; the
		// new peak is accepted only on a significantly better paired Δ. The
		// peak is finally screened against N2 (2-for-2 swaps among the 8
		// lowest-value owned × the 8 best free options, §C's final-
		// recommendation check) before Stage G.
		const climbRaces0 = ev.racesRun();
		const climbOut = (): boolean => ctrl.stopped() || Date.now() - t0 > cfg.timeBudgetMs
			|| ev.racesRun() - climbRaces0 >= cfg.climbRaces;
		// Ladder ceiling (§D.4 sizing): past ~4× the measured-σΔ δ-resolve
		// count ((2·1.96·σΔ/δ_min)²) growth cannot flip a δ-zone verdict, so a
		// candidate at the ceiling with UCB ≥ δ_min is reported unresolved
		// instead of burning seeds to the preset batch cap. The §C climb makes
		// climbRaces, not batchCap, its race budget. σΔ here is the calibrated
		// ℓ one (§7.3) while the ladder decides on the §F currency: near the
		// finish line the two are the same number (slope 1), and this is a
		// ceiling on growth, not a decision — a currency with less noise simply
		// resolves before reaching it.
		const climbRungCeil = Number.isFinite(noise.sigmaDeltaLead)
			? Math.max(BANDIT_START_SEEDS * 2, Math.ceil(4 * Math.pow((2 * 1.96 * noise.sigmaDeltaLead) / cfg.deltaMinL, 2)))
			: cfg.batchCap;
		const significantBetter = async (better: BuildRefLite, against: BuildRefLite): Promise<boolean> => {
			// The same sequential test Stage D's adoption test runs: grow the
			// held common prefix until the paired CI excludes 0 either way, the
			// gain falls under δ_min, or the batch cap holds.
			let d: PairedDiff | null = null;
			let held = Math.min(cfg.batchCap, Math.max(150, filled(ev, NS_SEARCH, si, better), filled(ev, NS_SEARCH, si, against)));
			for (;;) {
				const pos = Array.from({ length: held }, (_, i) => i);
				await ev.ensure([
					{ ns: NS_SEARCH, scenarioIdx: si, build: better, positions: pos },
					{ ns: NS_SEARCH, scenarioIdx: si, build: against, positions: pos },
				]);
				d = ev.paired(NS_SEARCH, si, better, against, searchPick);
				if (!d || held >= cfg.batchCap) break;
				if (d.ci95[0] > 0 || d.ci95[1] < 0) break; // significant either way, §8D
				if (d.ci95[1] < cfg.deltaMinL) break; // cannot show an improvement worth having
				held = Math.min(cfg.batchCap, Math.max(held + BANDIT_RUNG_MIN_SEEDS, Math.ceil(held * 1.5)));
			}
			return !!d && d.ci95[0] > 0;
		};
		const makeKick = (Xc: BuildRefLite, kickIdx: number): BuildRefLite => {
			// k = 2–4 random feasible swaps (§C), drop side skewed toward low
			// in-build value. The PRNG is keyed by identity+restart+kick index,
			// so the whole run stays deterministic (P6).
			const rng = mulberry32(fnv1a(`${Xc.id}\u0000${s}\u0000${kickIdx}`));
			const valOf = (id: string): number => value.get(id) ?? v0.get(id)?.mean ?? 0;
			let sel = [...Xc.selection];
			const k = 2 + Math.floor(rng() * 3);
			let moved = 0;
			for (let step = 0; step < k; step++) {
				const owned = sel.filter(id => !space.byId.get(id)?.forced);
				if (!owned.length) break;
				const asc = [...owned].sort((a, b) => valOf(a) - valOf(b) || (a < b ? -1 : 1));
				const drop = asc[Math.floor(asc.length * rng() * rng())]; // squared rng: low-value skew
				const afterDrop = sel.filter(id => id !== drop);
				// §E never-add: skip a refill whose add is recorded never to
				// fire in the build it would create.
				const free = affordableAdds(space, afterDrop)
					.filter(o => !addDead(refOf(applyMove(space, afterDrop, [], [o.id])), o.id));
				if (!free.length) { sel = afterDrop; moved++; continue; } // nothing affordable: a pure sell
				const desc = [...free].sort((a, b) => valOf(b.id) - valOf(a.id) || (a.id < b.id ? -1 : 1));
				const take = desc[Math.floor(desc.length * rng() * rng())]; // random, better end weighted
				sel = applyMove(space, afterDrop, [], [take.id]);
				moved++;
			}
			if (!moved && sel.length) sel = sel.slice(1); // never kick to the same build: sell something
			const b = remember(refOf(sel));
			assertFeasible(space, b.selection); // affordableAdds/applyMove keep budget + one-per-group
			return b;
		};
		const screenWaves = async (inc: BuildRefLite, moves: FMove[], tag: string): Promise<{ best: BanditOutcome | null; unresolved: number }> => {
			let best: BanditOutcome | null = null;
			let unresolved = 0;
			let cut = false;
			for (let w0 = 0; w0 < moves.length; w0 += CLIMB_WAVE) {
				if (w0 > 0 && climbOut()) { cut = true; break; } // budget/Stop mid-round: nothing this round is certified
				const wave = moves.slice(w0, w0 + CLIMB_WAVE);
				// Per-wave rung ceiling: the ladder may never outgrow the restart's
				// remaining climb budget — the bandit cannot check races mid-ladder,
				// so the budget is converted into a per-candidate seed cap here.
				const remain = cfg.climbRaces - (ev.racesRun() - climbRaces0);
				const rungCeil = Number.isFinite(remain)
					? Math.min(climbRungCeil, Math.max(BANDIT_CHUNK_SIZE * 5, Math.floor(remain / (wave.length + 1))))
					: climbRungCeil;
				const dropOf = new Map<string, string>();
				const addedOf = new Map<string, { opt: string; replaced?: string; extraDrop?: string; pairWith?: string }>();
				for (const mv of wave) {
					if (mv.adds.length === 0 && mv.drops.length === 1) dropOf.set(mv.b.id, mv.drops[0]);
					else if (mv.adds.length === 1) addedOf.set(mv.b.id,
						mv.drops.length >= 2 ? { opt: mv.adds[0], replaced: mv.drops[0], extraDrop: mv.drops[1] }
							: mv.drops.length === 1 ? { opt: mv.adds[0], replaced: mv.drops[0] } : { opt: mv.adds[0] });
					else if (mv.adds.length === 2) addedOf.set(mv.b.id, mv.drops.length === 1
						? { opt: mv.adds[0], pairWith: mv.adds[1], replaced: mv.drops[0] }
						: { opt: mv.adds[0], pairWith: mv.adds[1] });
				}
				emit('local', `${tag} · ${Math.min(w0 + CLIMB_WAVE, moves.length)}/${moves.length} moves screened`, provisional(inc));
				const bres = await banditVsIncumbent(ev, {
					ns: NS_SEARCH, scenarioIdx: si, incumbent: inc,
					candidates: wave.map(m => m.b), pick: searchPick, cfg,
					rungMin: BANDIT_CHUNK_SIZE, rungCeil,
					maxAlive: wave.length, lucbCut: false,
					prior: diffPrior(surrogate, inc), // §I.5 (see Stage D): a bound-certified wave candidate never races
				});
				applyMeasured(bres.measured, dropOf, addedOf);
				for (const out of bres.measured) surrHarvest(out.build);
				for (const out of bres.measured) {
					// Adopt: a significant improvement (Z-CI lower bound above 0,
					// at least two common seeds).
					if (out.diff.n >= 2 && out.diff.ci95[0] > 0) {
						if (!best || out.diff.mean > best.diff.mean) best = out;
						continue;
					}
					// Certifiably hopeless: the ladder's own optimism β(n) — floored
					// at Z (bandit.ts) — already puts the optimistic Δ under δ_min (that is
					// what a δ-zone drop means). Anything else (still alive at the
					// ceiling, or never measured) blocks certification.
					const upb = out.diff.mean + betaOf(out.diff.n) * (out.diff.sem || 0);
					if (out.diff.n < 2 || upb >= cfg.deltaMinL) unresolved++;
				}
				// A candidate that errored out of `measured` cannot be certified
				// either — but a §I.5 prior cut can: the Δ-SE bound certifies it
				// hopeless (the one sanctioned exception to "race everything"),
				// so it is resolved and comes off the unresolved head count.
				unresolved += Math.max(0, wave.length - bres.measured.length - bres.priorCut);
				if (best) break; // significant improver: adopt without screening the rest
			}
			if (cut) unresolved = Math.max(unresolved, 1); // an unscreened round certifies nothing
			surrHarvest(inc);
			surrRefit();
			return { best, unresolved };
		};
		const climbToPeak = async (startX: BuildRefLite, tag: string): Promise<{ X: BuildRefLite; p1: boolean; p2: boolean }> => {
			let Xc = startX;
			const adopt = (out: BanditOutcome): void => {
				Xc = remember(out.build);
				assertFeasible(space, Xc.selection); // §3.B.1: X stays affordable at every adoption
				for (const id of Xc.selection) histAdopted.add(id);
				traceAdopt(Xc, 'climb');
			};
			for (;;) {
				// §E dead-skill drops come first: adopted without a test and
				// without spending races. The top-up (the only thing this can
				// cost, cached seeds free) is spent just to READ the floor: a
				// build measured thinner than DEAD_SKILL_MIN_SEEDS must not be
				// judged on its first handful of seeds.
				Xc = sellDead(Xc);
				const t = tele(Xc);
				if (t && t.seeds < DEAD_SKILL_MIN_SEEDS && Xc.selection.some(id => !t.counts[id]) && !climbOut()) {
					await ev.ensure([{ ns: NS_SEARCH, scenarioIdx: si, build: Xc, positions: Array.from({ length: DEAD_SKILL_MIN_SEEDS }, (_, i) => i) }]);
					Xc = sellDead(Xc);
				}
				pinSearch(Xc); // §K: the climb's incumbent is pinned for this round's ladders
				if (climbOut()) return { X: Xc, p1: false, p2: false };
				const moves = n1Moves(space, Xc, ctxVal, cfg.deltaMinL, histAdopted, surrScore(Xc), addDead);
				if (!moves.length) return { X: Xc, p1: true, p2: true }; // degenerate space: X is the only build
				const r = await screenWaves(Xc, moves, tag);
				if (r.best) { adopt(r.best); continue; }
				if (r.unresolved > 0) {
					dbg(`  ${tag}: ${r.unresolved} N1 candidate(s) unresolved at the ${climbRungCeil}-seed ceiling — the zone stopped separating; kept uncertified`);
					return { X: Xc, p1: false, p2: false };
				}
				// Certified N1 peak (§C). Screen the recommendation against N2.
				const n2 = n2Moves(space, Xc, ctxVal, cfg.deltaMinL, histAdopted, addDead);
				if (!n2.length) return { X: Xc, p1: true, p2: true };
				if (climbOut()) return { X: Xc, p1: true, p2: false };
				const r2 = await screenWaves(Xc, n2, `${tag} N2`);
				if (r2.best) { adopt(r2.best); continue; } // a 2-for-2 improves: re-climb from there
				return { X: Xc, p1: true, p2: r2.unresolved === 0 };
			}
		};
		let peak = await climbToPeak(X, `restart ${s + 1}/${startBuilds.length} climb`);
		let kickIdx = 0;
		while (peak.p1 && kickIdx < cfg.kicks && !climbOut()) {
			const Xk = makeKick(peak.X, kickIdx);
			kickIdx++;
			// Degenerate space (nothing kickable): the kick could not change the
			// build, so no later kick can either — stop kicking this restart.
			if (Xk.id === peak.X.id) { dbg('  ILS kick impossible (nothing owned), stopping'); break; }
			emit('local', `restart ${s + 1}/${startBuilds.length} ILS kick ${kickIdx}${Number.isFinite(cfg.kicks) ? `/${cfg.kicks}` : ''}`, provisional(Xk));
			const r = await climbToPeak(Xk, `restart ${s + 1} kick ${kickIdx} climb`);
			// Accept only a certified peak that beats the current one
			// significantly (§C); anything else falls back to the old peak.
			if (r.p1 && (await significantBetter(r.X, peak.X))) {
				dbg('  ILS kick accepted', r.X.id || '(base)');
				peak = r;
			} else dbg('  ILS kick rejected');
		}
		X = peak.X;
		remember(X);
		restartEnds.push(X);
		traceRestartEnd(X);
		peakCerts.set(X.id, { p1: peak.p1, p2: peak.p2 });
		pinSearch(X); // §K: the end just reached is pinned from here on
		restartRaceMarks.push(ev.racesRun()); // §K ETA: this restart's measured cost is now the estimate for the rest
	}
	if (ctrl.stopped()) return verify(await shortlistBy(ev, si, evaluated, restartEnds, objective, vs, 3, space), Math.min(1000, cfg.gSeedsCap), Math.min(1000, cfg.gSeedsCap), true);

	// ── Stage G: verification on fresh seeds (the only numbers reported) ──────
	const short = await shortlistBy(ev, si, evaluated, restartEnds, objective, vs, 5, space);
	return verify(short, cfg.gSeedsMin, cfg.gSeedsCap, false);
}

/**
 * §G: the scenario set shown to the search as ONE scenario, so Stage B–F run
 * once on the aggregated objective instead of once per scenario.
 *
 * The adapter answers the pipeline's calls on a virtual scenario whose seed
 * positions map onto the SAME positions of every real scenario's seed list (the
 * lists are per scenario and fixed-size, so position p is one seed there and
 * one seed here: pairing per scenario, P2, and one batch per ensure for the
 * whole set). Each virtual seed slot is the scenarios combined:
 *  - `lead` carries the run's §F currency of every scenario, combined by the
 *    run's aggregation (aggregateValues, §6.4). That is the number the bandit,
 *    Stage D's adoption test, the §C climb and the ILS acceptance compare, so a
 *    candidate is only adopted when it improves the ROBUST value, and a
 *    compromise build that is top-5 in no single scenario is reachable;
 *  - `win`/`top3`/`placing` carry the same aggregation of the per-scenario
 *    indicators (so the shortlist, the provisional progress rows and the
 *    internal verification read the aggregated objective, in the reporting
 *    objective's own units), `hpEmpty`/`rushed` the plain mean;
 *  - a position is measured only once every scenario has it (null = still
 *    pending, 'err' = some scenario cannot score this seed at all).
 *
 * Because the currency is already applied here, the pipeline runs this view
 * with `searchCurrency: 'lead'` (read the slot's value as-is) and the reporting
 * objective unchanged. The §F clip width comes from the caller's measured σ(ℓ)
 * (§7.3), the same number a single-scenario run would use.
 *
 * §E activation telemetry is pooled over the scenarios: a skill counts as
 * never-firing only when no scenario ever saw it fire, so a skill that pays off
 * in one footing is never sold on another's zero.
 */
export interface AggregatedView extends SearchEvaluator {
	/** Every build the search asked this view to measure. */
	seen(): BuildRefLite[];
}

export function aggregatedEvaluator(
	ev: SearchEvaluator, scenarioIdxs: readonly number[], aggregation: AggregationKind, objective: ObjectiveKind,
	currency: SearchCurrency = 'aligned', clipL = Infinity,
): AggregatedView {
	const sis = [...scenarioIdxs];
	if (sis.length < 2) throw new Error('optimizer: aggregatedEvaluator needs at least two scenarios');
	const one = searchPickOf(objective, currency, clipL);
	const merged = new Map<string, SeedSlot[]>(); // `${ns}|${identity}`, rebuilt on every ensure
	const dropMerged = (): void => { merged.clear(); };

	const combine = (ns: string, identity: string): SeedSlot[] => {
		const key = `${ns}|${identity}`;
		const hit = merged.get(key);
		if (hit) return hit;
		const parts = sis.map(si => ev.slots(ns, si, identity));
		const len = Math.min(...parts.map(p => p.length));
		const out: SeedSlot[] = new Array<SeedSlot>(len).fill(null);
		for (let p = 0; p < len; p++) {
			const cur: number[] = [];
			const win: number[] = []; const top3: number[] = []; const plac: number[] = [];
			const hp: number[] = []; const rush: number[] = [];
			let pending = false, err = false;
			for (const part of parts) {
				const s = part[p];
				if (s == null) { pending = true; break; } // a later ensure fills it
				if (s === 'err') { err = true; break; }
				const c = one(s);
				if (c == null) { err = true; break; } // a scenario with no usable ℓ cannot score this seed
				cur.push(c); win.push(s.win); top3.push(s.top3); plac.push(-s.placing); hp.push(s.hpEmpty); rush.push(s.rushed);
			}
			if (pending) continue; // stays null: not measurable in every scenario yet
			if (err) { out[p] = 'err'; continue; }
			// placing is sign-flipped in and out, so maximin means "worst placing".
			out[p] = {
				lead: aggregateValues(cur, aggregation),
				win: aggregateValues(win, aggregation),
				top3: aggregateValues(top3, aggregation),
				placing: -aggregateValues(plac, aggregation),
				hpEmpty: aggregateValues(hp, 'mean'),
				rushed: aggregateValues(rush, 'mean'),
			};
		}
		merged.set(key, out);
		return out;
	};

	const statsFor = (ns: string, identity: string): ReturnType<SearchEvaluator['stats']> => {
		const slots = combine(ns, identity);
		return slots.some(s => s != null) ? statsOf(slots) : null;
	};
	const pairedFor = (ns: string, a: BuildRefLite, b: BuildRefLite, pick: (v: SeedValue) => number | null) =>
		pairedOf(combine(ns, a.id), combine(ns, b.id), pick);
	const pairedField = (ns: string, _si: number, a: BuildRefLite, b: BuildRefLite, pick: (v: SeedValue) => number | null) =>
		pairedFor(ns, a, b, pick);

	const seenBuilds = new Map<string, BuildRefLite>();
	return {
		seeds(ns, _si, n) { return ev.seeds(ns, sis[0], n); }, // the virtual scenario has no single list; pairing is by position
		async ensure(reqs) {
			for (const r of reqs) if (!seenBuilds.has(r.build.id)) seenBuilds.set(r.build.id, r.build);
			const fan = reqs.flatMap(r => sis.map(si => ({ ns: r.ns, scenarioIdx: si, build: r.build, positions: r.positions })));
			const res = await ev.ensure(fan);
			dropMerged();
			return res;
		},
		/** Every build the search asked this view to measure (§G): one search
		 *  measured every candidate in every scenario, so each scenario's own
		 *  champion among them is known without spending another race. */
		seen() { return [...seenBuilds.values()]; },
		slots(ns, _si, identity) { return combine(ns, identity); },
		racesRun() { return ev.racesRun(); },
		stats(ns, _si, build) { return statsFor(ns, build.id); },
		paired: pairedField,
		objective(ns, _si, build, obj, vs) {
			const st = statsFor(ns, build.id);
			if (!st) return null;
			const gain = obj === 'gainVsCurrent' && vs ? pairedFor(ns, build, vs, v => v.lead) : null;
			return objectiveOf(st, obj, gain);
		},
		activations(ns, _si, identity) {
			// Pool the scenarios (§E): seeds, counts and fired-seed counts add up,
			// so a skill is only "never fired" when no scenario recorded it.
			let out: ActivationTelemetry | null = null;
			for (const si of sis) {
				const a = ev.activations?.(ns, si, identity);
				if (!a) continue;
				const m = out ?? (out = { seeds: 0, counts: Object.create(null) as Record<string, number>, fired: Object.create(null) as Record<string, number> });
				m.seeds += a.seeds;
				for (const id in a.counts) m.counts[id] = (m.counts[id] ?? 0) + a.counts[id];
				for (const id in a.fired) m.fired[id] = (m.fired[id] ?? 0) + a.fired[id];
			}
			return out;
		},
		pinBuilds(ns, _si, identities) {
			// The virtual scenario pins every real one: ensure fans out to the
			// same slots, so eviction must not clear them either (§K).
			for (const si of sis) ev.pinBuilds?.(ns, si, identities);
		},
		dispose() { ev.dispose(); },
	};
}

/**
 * Optimize one build against a scenario set (§6.3–6.4). One scenario → the
 * classic pipeline, unchanged. Several with a mean aggregation → each is
 * searched independently (its own anytime recommendation), then the shortlists
 * are merged and re-verified on fresh seeds ACROSS all scenarios, ranked by the
 * chosen aggregation. Several with a maximin/blend aggregation → one search on
 * the aggregated objective (§G, `aggregatedSearch`): every candidate is
 * simulated in every scenario and Stage D + the §C climb adopt on the aggregated
 * value, so a robust compromise that is top-5 in no single scenario can still be
 * found. Cost scales with the scenario count either way (§G).
 */
export async function runOptimizer(
	ev: SearchEvaluator,
	input: SearchInput,
	ctrl: SearchController,
	onProgress: (p: OptimizerProgress) => void,
): Promise<OptimizerResult> {
	// gainVsCurrent is a PAIRED objective: its value is the ℓ difference against
	// input.current. Without the reference every objective value is a diff
	// against nothing (NaN), so no build is ever measurable — fail before
	// burning a search budget, not with an opaque "no measurable builds" at G.
	if (input.objective === 'gainVsCurrent' && !input.current) {
		throw new Error('optimizer: objective "gainVsCurrent" requires input.current (the reference build to measure gain against)');
	}
	const sidxs = input.scenarioIdxs && input.scenarioIdxs.length ? [...new Set(input.scenarioIdxs)] : [input.scenarioIdx];
	if (sidxs.length <= 1) {
		return runSingleScenario(ev, { ...input, scenarioIdx: sidxs[0] ?? 0, scenarioIdxs: undefined }, ctrl, onProgress);
	}
	// §G: a maximin/blend run searches the scenario set as ONE objective, so a
	// compromise build that is top-5 in no single scenario can still be the
	// recommendation. A mean keeps the §6.3 path (each scenario's own optimum
	// is already a good mean candidate, and the merged shortlist ranks by that
	// mean). The search runs on the adapter; verification and the reported rows
	// still run on the REAL evaluator, so the numbers stay the selected
	// objective on each scenario's own disjoint verify seeds (§6.4, P3).
	if (input.aggregation !== 'mean' && input.aggregatedSearch !== false) {
		// §7.3 says the reported noise is a LEAD margin in lengths, and §F needs
		// σ(ℓ) before the search starts (it sizes the clip). Read it from the
		// REAL evaluator on the first scenario; the pipeline's own Stage 0 below
		// asks the adapter for exactly these builds at these positions, which
		// fans out to exactly these slots, so this is not extra races. One
		// scenario is enough: the clip is a width, and the combined value is
		// never noisier than its parts, so this width is the generous one.
		const noiseVariants = noiseVariantSelections(input.space, input.effort).map(sel => buildRef(input.space, sel));
		const rawNoise = await calibrateNoise(ev, input.effort, sidxs[0], buildRef(input.space, []), noiseVariants);
		const aggEv = aggregatedEvaluator(ev, sidxs, input.aggregation, input.objective, input.searchCurrency, leadClipL(rawNoise.sigmaLead));
		// The adapter has already applied the §F currency per scenario and
		// combined it by the aggregation, so the pipeline reads its slots as-is.
		const agg = await runSingleScenario(
			aggEv, { ...input, scenarioIdx: 0, scenarioIdxs: undefined, searchCurrency: 'lead' }, ctrl, onProgress);
		// One search measured every candidate in every scenario, so each
		// scenario's own champion among them costs nothing to name. Stage G
		// sees those too: the pool would otherwise be only what the aggregated
		// ranking happened to like, and the fresh-seed verification, not the
		// search, is what decides the recommendation (§6.4).
		const pool: BuildRefLite[] = [];
		for (const si of sidxs) {
			const own = aggEv.seen()
				.filter(b => affordable(input.space, b.selection) && !deadSkills(ev, si, b).length)
				.map(b => ({ b, obj: ev.objective(NS_SEARCH, si, b, input.objective, input.current) }))
				.filter(x => x.obj && x.obj.n >= SHORTLIST_MIN_SEEDS && Number.isFinite(x.obj!.mean))
				.map(x => ({ b: x.b, lcb: x.obj!.mean - 1.96 * (Number.isFinite(x.obj!.sem) ? x.obj!.sem : 0) }))
				.sort((x, y) => y.lcb - x.lcb || (x.b.id < y.b.id ? -1 : 1))[0];
			if (own) pool.push(own.b);
		}
		return verifyAcross(ev, input, sidxs, [{ ...agg, noise: rawNoise }], ctrl, pool);
	}
	const ranIdxs: number[] = [];
	const per: OptimizerResult[] = [];
	for (const si of sidxs) {
		per.push(await runSingleScenario(ev, { ...input, scenarioIdx: si, scenarioIdxs: undefined }, ctrl, onProgress));
		ranIdxs.push(si);
		if (ctrl.stopped()) break; // Stop: aggregate on what finished (anytime, P5)
	}
	return verifyAcross(ev, input, ranIdxs, per, ctrl);
}

/** Merge each scenario's shortlist and verify the pooled candidates fresh
 *  across every scenario, then rank by the aggregation (§6.4). A build tied
 *  with the leader in ANY scenario is reported as a tie (conservative — we
 *  only claim a win where every scenario agrees). `extra` names more candidates
 *  for the pool (§G: the one aggregated search's per-scenario champions); they
 *  are verified on fresh seeds like everything else in it. */
async function verifyAcross(
	ev: SearchEvaluator, input: SearchInput, ranIdxs: number[], per: OptimizerResult[], ctrl: SearchController,
	extra: readonly BuildRefLite[] = [],
): Promise<OptimizerResult> {
	const { space, objective, aggregation, effort: cfg } = input;
	const vs = input.current;
	const pick = objPick(objective);
	const ids = ranIdxs.map(si => `S${si}`);
	const pool = new Map<string, BuildRefLite>();
	for (const b of extra) if (affordable(space, b.selection)) pool.set(b.id, b);
	for (const r of per) for (const row of r.shortlist.slice(0, 5)) {
		if (affordable(space, row.build.selection)) pool.set(row.build.id, row.build);
	}
	if (vs && affordable(space, vs.selection)) pool.set(vs.id, vs);
	const builds = [...pool.values()];
	if (!builds.length) return per[per.length - 1]; // degenerate: return the last single result
	const gSeeds = Math.max(1, cfg.gSeedsMin);
	const allMeasured = (b: BuildRefLite) => ranIdxs.every(si => {
		const o = ev.objective(NS_VERIFY, si, b, objective, vs);
		return !!o && o.n > 0 && Number.isFinite(o.mean);
	});
	const aggOf = (b: BuildRefLite) => {
		const objs = ranIdxs.map(si => ev.objective(NS_VERIFY, si, b, objective, vs)!);
		const vals = objs.map(o => o.mean);
		const perScenario = objs.map((obj, i) => ({ id: ids[i], obj }));
		const sem = objs.reduce((m, o) => Math.max(m, Number.isFinite(o.sem) ? o.sem : 0), 0);
		const n = objs.reduce((m, o) => Math.min(m, o.n), Infinity);
		return { agg: aggregateValues(vals, aggregation), perScenario, sem, n: Number.isFinite(n) ? n : 0 };
	};
	const allTieVs = (best: BuildRefLite, b: BuildRefLite) => ranIdxs.every(si => {
		const p = ev.paired(NS_VERIFY, si, best, b, pick);
		return p ? isTie(p.ci95) : true; // a scenario with no common seed cannot prove a difference
	});
	// Secondary columns (P(1st)/P(top-3)/mean ℓ) pool every scenario's fresh
	// verification slots into ONE real BuildStats — verification seeds only
	// (P3), identical across scenarios, so the pooled means equal the means of
	// the per-scenario stats. Null leads stay excluded per metric (§7.1).
	const pooledStats = (b: BuildRefLite) =>
		statsOf(ranIdxs.flatMap(si => ev.slots(NS_VERIFY, si, b.id)));
	// Stop path: mirror runSingleScenario's truncated Stage G — verify on one
	// short round (min(1000, gSeedsCap)) instead of burning a full gSeedsMin
	// across every scenario after the user pressed Stop (anytime, P5).
	let n = ctrl.stopped() ? Math.min(1000, cfg.gSeedsCap) : gSeeds;
	let rows: ScoredBuild[];
	let best: ScoredBuild;
	for (;;) {
		const positions = Array.from({ length: n }, (_, i) => i);
		await ev.ensure(builds.flatMap(b => ranIdxs.map(si => ({ ns: NS_VERIFY, scenarioIdx: si, build: b, positions }))));
		const ranked = builds.filter(allMeasured)
			.map(b => ({ b, ...aggOf(b) }))
			.sort((a, z) => z.agg - a.agg || (a.b.id < z.b.id ? -1 : 1));
		if (!ranked.length) throw new Error('optimizer: cross-scenario verification produced no measurable builds');
		rows = ranked.map(({ b, agg, sem, n: nn, perScenario }) => {
			const sp = costOf(space, b.selection, true);
			return {
				build: b, sp, leftover: space.budget - sp, skillCount: b.selection.length,
				obj: { mean: agg, sem, n: nn }, perScenario, provisional: false,
				stats: pooledStats(b),
				tiedWithBest: b.id !== ranked[0].b.id && allTieVs(ranked[0].b, b),
			};
		});
		const group = rows.filter(r => r.tiedWithBest || r.build.id === ranked[0].b.id);
		best = group.sort((a, b) => b.leftover - a.leftover || a.skillCount - b.skillCount
			|| b.obj.mean - a.obj.mean || (a.build.id < b.build.id ? -1 : 1))[0];
		rows = [best, ...rows.filter(r => r.build.id !== best.build.id)];
		for (const r of rows) r.tiedWithBest = r.build.id === best.build.id ? false : allTieVs(best.build, r.build);
		// Resolve the top two on the aggregation before stopping (§G).
		const two = ranked.filter(x => x.b.id !== best.build.id)[0];
		if (two && !allTieVs(best.build, two.b)) break; // a real winner somewhere, others agree
		if (ctrl.stopped() || n >= cfg.gSeedsCap) break;
		n = Math.min(cfg.gSeedsCap, n + Math.max(500, Math.floor(gSeeds / 4)));
	}
	assertFeasible(space, best.build.selection);
	assertOnePerGroup(space, best.build.selection);
	// §C certificates: only carry through when every scenario agreed on the same
	// best build AND certified it (conservative — a tie-break across scenarios
	// with different peaks certifies nothing).
	const certsOf = (key: 'p1' | 'p2'): boolean =>
		per.every(r => r.best.build.id === best.build.id && (key === 'p1' ? r.certified1MovePeak : r.certified2MovePeak));
	// §E: the winning build's activation report, pooled over the scenarios that
	// ran. Read directly for the build Stage G actually recommends (on the §G
	// path the search's own best may not be it), falling back to what each
	// per-scenario result carried.
	let bestActivations: ActivationTelemetry | undefined;
	{
		const merged: ActivationTelemetry = { seeds: 0, counts: Object.create(null) as Record<string, number>, fired: Object.create(null) as Record<string, number> };
		const add = (a: ActivationTelemetry | null | undefined): void => {
			if (!a) return;
			merged.seeds += a.seeds;
			for (const id in a.counts) merged.counts[id] = (merged.counts[id] ?? 0) + a.counts[id];
			for (const id in a.fired) merged.fired[id] = (merged.fired[id] ?? 0) + a.fired[id];
		};
		for (const si of ranIdxs) add(ev.activations?.(NS_SEARCH, si, best.build.id));
		if (merged.seeds === 0) for (const r of per) if (r.best.build.id === best.build.id) add(r.bestActivations);
		if (merged.seeds > 0) bestActivations = merged;
	}
	return {
		best, shortlist: rows, noise: per[0].noise,
		verificationSeeds: n,
		searchSeedsPerScenario: per.reduce((m, r) => Math.max(m, r.searchSeedsPerScenario), 0),
		stoppedEarly: ctrl.stopped(),
		certified1MovePeak: certsOf('p1'),
		certified2MovePeak: certsOf('p2'),
		orderingCorrelation: per[0].orderingCorrelation,
		bestActivations,
	};
}

/** Minimum search seeds a build must have to be ranked into the shortlist by
 *  its lower confidence bound (§3.B.2): below this the mean is mostly luck. */
const SHORTLIST_MIN_SEEDS = 200;

/**
 * The shortlist feeding Stage G (§3.B.2). Stage G can only choose among the
 * builds it is given, so:
 *  - every restart's final feasible build and the global incumbent are the
 *    mandatory slots; §E keeps out of them any build carrying a never-firing
 *    skill, and a thin restart end is measured up to DEAD_SKILL_MIN_SEEDS first
 *    so its slot is refused on the same evidence the climb uses;
 *  - the remaining slots are filled by LOWER CONFIDENCE BOUND (mean − 1.96·SE)
 *    restricted to well-measured builds (n ≥ SHORTLIST_MIN_SEEDS);
 *  - raw search means are never ranked across builds with wildly different
 *    seed counts — that is how lucky 50-seed bandit strays crowded out the
 *    well-measured restart ends.
 * Feasibility is a hard gate throughout: over-budget neighbours are evaluated
 * for their knapsack numbers only and must never reach the report (§13.3).
 * Deterministic order.
 */
async function shortlistBy(ev: SearchEvaluator, si: number, evaluated: Map<string, BuildRefLite>, restartEnds: readonly BuildRefLite[], objective: ObjectiveKind, vs: BuildRefLite | undefined, k: number, space: BuildSpace): Promise<BuildRefLite[]> {
	/** §E: a skill of this build its telemetry never recorded firing. */
	const neverFired = (b: BuildRefLite): boolean => {
		const t = ev.activations?.(NS_SEARCH, si, b.id);
		return !!t && b.selection.some(id => !t.counts[id]);
	};
	/** §E: below DEAD_SKILL_MIN_SEEDS the dead-skill rule stands down, so on a thin build a
	 *  never-firing skill is invisible and would ride a mandatory slot into the report. Read
	 *  the floor first (the §C climb's top-up), so the rule decides on measured seeds. */
	const readDeadFloor = async (b: BuildRefLite): Promise<void> => {
		const t = ev.activations?.(NS_SEARCH, si, b.id);
		if (!t || t.seeds >= DEAD_SKILL_MIN_SEEDS || !neverFired(b)) return;
		await ev.ensure([{ ns: NS_SEARCH, scenarioIdx: si, build: b, positions: Array.from({ length: DEAD_SKILL_MIN_SEEDS }, (_, i) => i) }]);
	};
	const measured = [...evaluated.values()]
		.filter(b => affordable(space, b.selection))
		.map(b => ({ b, obj: ev.objective(NS_SEARCH, si, b, objective, vs) }))
		.filter(x => x.obj && x.obj.n > 0 && Number.isFinite(x.obj!.mean))
		// §E: a build carrying a skill its own telemetry shows never fired is
		// dominated by the same build minus it (identical races, less SP), so
		// it never enters the report. (The empty build has no skill to fail —
		// the list can never empty out this way.)
		.filter(x => !deadSkills(ev, si, x.b).length);
	const out: BuildRefLite[] = [];
	const take = (b: BuildRefLite) => { if (!out.some(o => o.id === b.id)) out.push(b); };
	for (const e of restartEnds) {
		await readDeadFloor(e);
		if (affordable(space, e.selection) && !deadSkills(ev, si, e).length) take(e);
	}
	// The global incumbent (the best search objective measured so far) keeps a slot
	// even below the seed floor; it is one raw-mean pick, not a ranking. Taken
	// without measuring, it cannot read the floor, so it refuses any build whose own
	// seeds already show a skill that never fired (the empty build has none to fail).
	const incumbent = measured
		.sort((x, y) => y.obj!.mean - x.obj!.mean || (x.b.id < y.b.id ? -1 : 1))
		.filter(x => !neverFired(x.b))[0];
	if (incumbent) take(incumbent.b);
	const fill = measured
		.filter(x => x.obj!.n >= SHORTLIST_MIN_SEEDS && !out.some(o => o.id === x.b.id))
		.map(x => ({ b: x.b, lcb: x.obj!.mean - 1.96 * (Number.isFinite(x.obj!.sem) ? x.obj!.sem : 0) }))
		.sort((x, y) => y.lcb - x.lcb || (x.b.id < y.b.id ? -1 : 1));
	for (const f of fill) { if (out.length >= k) break; take(f.b); }
	return out;
}

/** Tie flag vs the recommendation itself (post tie-break reorder). */
function evPairedBest(ev: SearchEvaluator, si: number, best: BuildRefLite, b: BuildRefLite, pick: (v: SeedValue) => number | null): PairedDiff | null {
	return ev.paired(NS_VERIFY, si, best, b, pick);
}

// ── §C move space: the climb's full N1 + the recommendation's N2 ─────────────

/** A candidate move relative to the current build X: the resulting build plus
 *  its own drops/adds (post group-exclusivity) and the acquisition estimate.
 *  The estimate only sequences screening waves — it never excludes a move
 *  (§C: an additive estimate is too noisy AND biased to drop moves by). */
interface FMove { b: BuildRefLite; est: number; drops: string[]; adds: string[]; }

/** Apply a move (drop ids then add ids) to a selection, honouring group
 *  exclusivity: adding j first evicts any current pick of j's group. Forced
 *  skills are implicit (never in `selection`), so locks are untouched. */
function applyMove(space: BuildSpace, sel: readonly string[], drops: readonly string[], adds: readonly string[]): string[] {
	const dropSet = new Set(drops);
	let out = sel.filter(s => !dropSet.has(s));
	for (const j of adds) {
		const gj = space.byId.get(j)?.groupId;
		if (gj == null) continue;
		out = out.filter(s => space.byId.get(s)?.groupId !== gj);
		if (!out.includes(j)) out.push(j);
	}
	return out.sort();
}

/** Shared tail of the move generators: canonicalize, dedup, budget-gate
 *  (feasibility is the only filter, §13.3), estimate, and order deterministically.
 *  The estimate — surrogate acquisition `predicted gain + κ·SE` (§8 E) when the
 *  model clears the R² gate, else Σ ctxVal_added − Σ ctxVal_removed with a
 *  history nudge for skills that paid off earlier — sequences screening waves
 *  only. Nothing is pruned by it: §C put an end to estimate-based pruning
 *  (the additive estimate is too noisy AND biased; bug §B.1). */
function movesFrom(
	space: BuildSpace,
	X: BuildRefLite,
	raw: readonly { drops: string[]; adds: string[] }[],
	ctxVal: (id: string) => number,
	deltaMinL: number,
	hist: ReadonlySet<string>,
	surr?: { model: SurrogateModel; xL: number },
	addDead?: (b: BuildRefLite, id: string) => boolean,
): FMove[] {
	const Xsel = X.selection;
	const seen = new Set<string>([X.id]);
	const out: FMove[] = [];
	for (const mv of raw) {
		const sel = applyMove(space, Xsel, mv.drops, mv.adds);
		const b: BuildRefLite = { id: simIdentity(space, sel), selection: sel };
		if (seen.has(b.id)) continue;
		if (!affordable(space, sel)) continue;               // §13.3: never over budget
		seen.add(b.id);
		const added = sel.filter(s => !Xsel.includes(s));
		const removed = Xsel.filter(s => !sel.includes(s));
		// §E never-add: the resulting build already has telemetry showing this
		// add never activated in it, so the move can only waste budget; never
		// offered.
		if (addDead && added.some((id: string) => addDead(b, id))) continue;
		let est: number;
		if (surr) {
			// §I.1: acquisition on the move's own unit — the predicted DIFFERENCE
			// vs X with the SE of that difference (predictDiff; the marginals in
			// quadrature counted every shared feature twice and blurred the
			// ordering across the whole neighbourhood).
			const pd = surr.model.predictDiff(sel, Xsel);
			est = pd.mean + KAPPA * pd.se;                                             // acquisition ordering (§8 E)
			for (const id of added) if (hist.has(id)) est += deltaMinL;        // history tiebreak (§8F)
		} else {
			est = 0;
			for (const id of added) est += ctxVal(id) + (hist.has(id) ? deltaMinL : 0); // history heuristic (§8F)
			for (const id of removed) est -= ctxVal(id);
		}
		out.push({ b, est, drops: removed, adds: added });
	}
	return out.sort((a, b) => b.est - a.est || (a.b.id < b.b.id ? -1 : 1));
}

/**
 * The FULL N1 neighbourhood of X (§C): drop, add, swap (cross-group; same-group
 * = tier move), 2-for-1 (every owned pair out, every free option in — this is
 * the upgrade-and-sell shape: sell a filler, buy the higher tier), 1-for-2
 * (every owned option out, every affordable pair of free options in), and the
 * §K refill move: a drop with its FULL top-up, the best-estimated affordable
 * add bought over and over until nothing is affordable: a single-add refill
 * can leave SP unspent that another affordable option could have bought, and
 * three-or-more-add refills have no other representative in the move space.
 * Everything budget-feasible must be reachable in one move: no move caps, no
 * estimate pruning — the bandit's indifference zone (§D) screens, nothing
 * else decides what deserves seeds.
 */
function n1Moves(
	space: BuildSpace,
	X: BuildRefLite,
	ctxVal: (id: string) => number,
	deltaMinL: number,
	hist: ReadonlySet<string>,
	surr?: { model: SurrogateModel; xL: number },
	addDead?: (b: BuildRefLite, id: string) => boolean,
): FMove[] {
	const Xsel = X.selection;
	const free = space.options.filter(o => !o.forced && !Xsel.includes(o.id));
	const owned = Xsel.filter(id => !space.byId.get(id)?.forced);
	const raw: { drops: string[]; adds: string[] }[] = [];
	// add (includes refills: an add is a drop's other half done the other way)
	for (const j of free) raw.push({ drops: [], adds: [j.id] });
	// drop
	for (const i of owned) raw.push({ drops: [i], adds: [] });
	// swap: 1-for-1 (cross-group; same-group = tier move; the refill move)
	for (const i of owned) for (const j of free) raw.push({ drops: [i], adds: [j.id] });
	// 2-for-1 / upgrade-and-sell: every owned pair out, every free option in
	for (let a = 0; a < owned.length; a++) for (let c = a + 1; c < owned.length; c++)
		for (const j of free) raw.push({ drops: [owned[a], owned[c]], adds: [j.id] });
	// 1-for-2: every owned option out, every distinct-group pair in. The pair
	// may include i's own group — dropping i leaves that group open, and
	// "sell i, buy its better tier plus a filler" is part of the §C vocabulary.
	for (const i of owned)
		for (let a = 0; a < free.length; a++) for (let c = a + 1; c < free.length; c++)
			if (free[a].groupId !== free[c].groupId)
				raw.push({ drops: [i], adds: [free[a].id, free[c].id] });
	// §K refill: a drop with its full top-up. Sell i, then buy the
	// best-estimated affordable free add again and again until nothing is
	// affordable, so the resulting build leaves no SP that another affordable
	// option could still spend. (Single-add refills are swaps and two-add ones
	// are 1-for-2 above; those cover i's group re-opening too. Deeper refills
	// are this move's alone.) Greedy by ctxVal, the in-context number, ties by
	// id; `free` excludes what X already owns, so i is never re-bought.
	for (const i of owned) {
		const sel = Xsel.filter(x => x !== i);
		const adds: string[] = [];
		for (;;) {
			const used = new Set(sel.map(x => space.byId.get(x)?.groupId));
			const spare = space.budget - costOf(space, sel, true);
			let best: OptOption | undefined;
			for (const o of free) {
				if (used.has(o.groupId) || o.cost > spare) continue;
				if (!best) best = o;
				else {
					const vBest = ctxVal(best.id), vO = ctxVal(o.id);
					if (vO > vBest || (vO === vBest && o.id < best.id)) best = o;
				}
			}
			if (!best) break;
			sel.push(best.id);
			adds.push(best.id);
		}
		if (adds.length) raw.push({ drops: [i], adds });
	}
	return movesFrom(space, X, raw, ctxVal, deltaMinL, hist, surr, addDead);
}

/** The §C final-recommendation screen: every feasible 2-for-2 swap among the 8
 *  lowest-value owned options × the 8 best free options (the move class beyond
 *  N1 worth checking before reporting the peak). */
function n2Moves(
	space: BuildSpace,
	X: BuildRefLite,
	ctxVal: (id: string) => number,
	deltaMinL: number,
	hist: ReadonlySet<string>,
	addDead?: (b: BuildRefLite, id: string) => boolean,
): FMove[] {
	const Xsel = X.selection;
	const owned = Xsel.filter(id => !space.byId.get(id)?.forced);
	const free = space.options.filter(o => !o.forced && !Xsel.includes(o.id));
	const low = [...owned].sort((a, b) => ctxVal(a) - ctxVal(b) || (a < b ? -1 : 1)).slice(0, 8);
	const best = [...free].sort((a, b) => ctxVal(b.id) - ctxVal(a.id) || (a.id < b.id ? -1 : 1)).slice(0, 8);
	const raw: { drops: string[]; adds: string[] }[] = [];
	for (let a = 0; a < low.length; a++) for (let c = a + 1; c < low.length; c++)
		for (let x = 0; x < best.length; x++) for (let y = x + 1; y < best.length; y++)
			if (space.byId.get(best[x].id)?.groupId !== space.byId.get(best[y].id)?.groupId)
				raw.push({ drops: [low[a], low[c]], adds: [best[x].id, best[y].id] });
	return movesFrom(space, X, raw, ctxVal, deltaMinL, hist, undefined, addDead);
}

/** Deterministic PRNG for ILS kicks (P6): FNV-1a over the build identity +
 *  restart + kick index, then mulberry32. */
function fnv1a(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
	return h >>> 0;
}
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6D2B79F5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
