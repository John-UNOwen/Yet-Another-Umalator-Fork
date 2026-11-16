/**
 * Search pipeline orchestration (SKILL-OPTIMIZER-PLAN §8). Stages B–D + F + G
 * live here; Stage A (book) ships with Phase 5 and Stage E (surrogate) plugs in
 * to the same loop. Everything measurable runs
 * through the evaluator (P7); every comparison is paired over identical seed
 * positions (P2); final numbers come only from the verification namespace (P3);
 * progress events make the run anytime (P5); all inputs are deterministic (P6).
 */

import { banditVsIncumbent, BanditOutcome, betaOf } from './bandit';
import {
	BANDIT_CHUNK_SIZE, BANDIT_MAX_ALIVE, BANDIT_RUNG_MIN_SEEDS, BANDIT_START_SEEDS, CLIMB_WAVE,
	DEAD_SKILL_MIN_SEEDS,
	EffortConfig, KAPPA, LAMBDA_MAXIMIN, PRUNE_KAPPA,
	SURROGATE_MIN_FIT, SURROGATE_MIN_R2, SURROGATE_PAIR_CAP, SURROGATE_PAIR_MIN_COOC, SURROGATE_REFIT_EVERY,
} from './config';
import { BuildRefLite, calibrateNoise, PairedDiff, SearchEvaluator, statsOf } from './evaluator';
import { NS_SEARCH, NS_VERIFY } from './cache';
import { KnapGroup, mckpSolve, mckpTopK } from './knapsack';
import { affordable, affordableAdds, assertFeasible, assertOnePerGroup, BuildSpace, costOf, OptOption, simIdentity } from './space';
import { fitSurrogate, SurrogateModel, SurrogateSample } from './surrogate';
import {
	ActivationTelemetry, AggregationKind, MeanSem, NoiseInfo, ObjectiveKind, OptimizerProgress,
	OptimizerResult, ScoredBuild, SeedValue,
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
	/** Scenario set for robustness (§6.3). Each is searched; the recommendation
	 *  then aggregates across them by `aggregation` (§6.4). Empty/omitted → [scenarioIdx]. */
	scenarioIdxs?: number[];
	objective: ObjectiveKind;
	aggregation: AggregationKind;
	effort: EffortConfig;
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
	// §6.1: ℓ is the SEARCH-stage currency — at equal seeds it resolves
	// order-of-magnitude smaller differences than P(1st) (dP1/dℓ saturates),
	// keeping bandit elimination and Stage D adoption sensitive deep in the
	// ladder. The selected objective drives ranking and the final rows.
	const searchPick = (v: SeedValue) => v.lead;
	const vs = input.current;

	const refOf = (selection: readonly string[]): BuildRefLite => ({
		id: simIdentity(space, selection), selection: [...selection],
	});
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

	const planned = cfg.noiseSeeds * (1 + cfg.noiseVariants)
		+ space.options.length * (cfg.screenRound1Seeds + cfg.screenRound2Seeds)
		+ cfg.restarts * cfg.dMaxIters * cfg.batchCap + 6 * cfg.gSeedsMin;
	const emit = (stage: OptimizerProgress['stage'], note?: string, best?: ScoredBuild) => onProgress({
		stage, racesRun: ev.racesRun(), racesPlanned: planned, elapsedMs: Date.now() - t0,
		etaMs: ev.racesRun() > 100
			? Math.round((Date.now() - t0) / ev.racesRun() * Math.max(0, planned - ev.racesRun()))
			: undefined,
		best, note,
	});
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

	// ── Stage 0: noise calibration (§7.3; search-namespace seeds, reused later) ──
	const base = remember(refOf([]));
	emit('noise');
	const noiseVariants: BuildRefLite[] = [];
	for (const o of space.options.filter(o => !o.forced).sort((a, b) => a.cost - b.cost)) {
		if (noiseVariants.length >= cfg.noiseVariants) break;
		if (affordable(space, [o.id])) noiseVariants.push(remember(withOption([], o)));
	}
	const noise: NoiseInfo = await calibrateNoise(ev, cfg, si, base, noiseVariants);

	// ── Stage G machinery (also the Stop path): verify a shortlist fresh ──────
	const verify = async (short: BuildRefLite[], nMin: number, nCap: number, stoppedEarly: boolean): Promise<OptimizerResult> => {
		const pool = [...short];
		if (vs && !pool.some(b => b.id === vs.id)) pool.push(vs); // gainVsCurrent needs the reference row verified too
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

	if (ctrl.stopped()) return verify(shortlistBy(ev, si, evaluated, restartEnds, objective, vs, 3, space), Math.min(1000, cfg.gSeedsCap), Math.min(1000, cfg.gSeedsCap), true);

	// ── Stage B: screening chart — out-of-context v⁰ (chart-parity filter) ──
	emit('screen', `screening ${space.options.filter(o => !o.forced).length} options`);
	const adds = new Map<string, BuildRefLite>();
	for (const o of space.options) if (!o.forced) adds.set(o.id, remember(withOption([], o)));
	const v0 = new Map<string, MeanSem>();
	{
		const measured = (id: string, b: BuildRefLite) => {
			const d = ev.paired(NS_SEARCH, si, b, base, v => v.lead); // ℓ: the screening currency (§6.1)
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
	if (ctrl.stopped()) return verify(shortlistBy(ev, si, evaluated, restartEnds, objective, vs, 3, space), Math.min(1000, cfg.gSeedsCap), Math.min(1000, cfg.gSeedsCap), true);

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
			emit('incontext', `restart ${s + 1}/${startBuilds.length} round ${it + 1}/${cfg.dMaxIters}`, provisional(X));
			// Neighbourhood: drop each owned pick, add each uncovered option
			// (over-budget adds evaluated too — the number feeds the re-solve).
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
			// Surrogate-guided candidate pruning (§8 E, applied to the biggest
			// move consumer, Stage D): once the model clears the R² gate, drop a
			// neighbour whose OPTIMISTIC predicted gain (prediction + κ·SE) can't
			// beat X by δ_min — α/β with error bars. Unpruned candidates stay; if
			// every one is pruned X is already locally optimal. This only decides
			// what to simulate (P1); the knapsack re-solve still runs on measured
			// + v⁰ values, and a wrong prune is re-tried next round via v0.
			const dSm = surrModel();
			let toMeasure = cands;
			if (dSm) {
				const px = dSm.predict(X.selection);
				toMeasure = cands.filter(b => {
					if (b.id === X.id) return false;
					if (!dSm.covers(b.selection)) return true; // unjudged move: never prune
					const p = dSm.predict(b.selection);
					const se = Math.sqrt(p.se * p.se + px.se * px.se);
					return (p.mean - px.mean) + PRUNE_KAPPA * se > cfg.deltaMinL;
				});
				if (!toMeasure.length) { dbg('D pruned all cands, locally optimal'); break; }
			}
			dbg('D s', s, 'it', it, 'X', X.id || '(base)', 'cands', cands.length, dSm ? '→' + toMeasure.length : '');
			const bres = await banditVsIncumbent(ev, {
				ns: NS_SEARCH, scenarioIdx: si, incumbent: X,
				candidates: toMeasure.sort((a, b) => (a.id < b.id ? -1 : 1)), pick: searchPick, cfg,
			});
			const outcomes = bres.measured; // eliminated candidates' numbers feed the re-solve too (§8D)
			if (bres.capCut) { // §D.4: the alive cap bound this batch, not the indifference zone
				dbg('  D alive cap cut', bres.capCut, 'candidates beyond', BANDIT_MAX_ALIVE);
				emit('incontext', `restart ${s + 1}/${startBuilds.length} · alive cap cut ${bres.capCut}`, provisional(X));
			}
			applyMeasured(outcomes, dropOf, addedOf);
			for (const out of outcomes) surrHarvest(out.build);
			surrHarvest(X); surrRefit();
			for (const out of outcomes) dbg('  meas', out.survived ? '+' : '-', out.build.id || '(base)', 'Δ', out.diff.mean.toFixed(3), 'n', out.diff.n);
			// Re-solve the knapsack with in-context values.
			const groups: KnapGroup[] = knapGroups().map(g => ({
				...g,
				options: g.options.map(o => ({ ...o, value: ctxVal(o.id) })),
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
		// excludes a move (bound-pruning by the surrogate would be §I work).
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
		// climbRaces, not batchCap, its race budget.
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
					// Certifiably hopeless: the ladder's own optimism β(n) — never
					// below Z — already puts the optimistic Δ under δ_min (that is
					// what a δ-zone drop means). Anything else (still alive at the
					// ceiling, or never measured) blocks certification.
					const upb = out.diff.mean + betaOf(out.diff.n) * (out.diff.sem || 0);
					if (out.diff.n < 2 || upb >= cfg.deltaMinL) unresolved++;
				}
				// A candidate that errored out of `measured` cannot be certified either.
				unresolved += Math.max(0, wave.length - bres.measured.length);
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
	}
	if (ctrl.stopped()) return verify(shortlistBy(ev, si, evaluated, restartEnds, objective, vs, 3, space), Math.min(1000, cfg.gSeedsCap), Math.min(1000, cfg.gSeedsCap), true);

	// ── Stage G: verification on fresh seeds (the only numbers reported) ──────
	const short = shortlistBy(ev, si, evaluated, restartEnds, objective, vs, 5, space);
	return verify(short, cfg.gSeedsMin, cfg.gSeedsCap, false);
}

/**
 * Optimize one build against a scenario set (§6.3–6.4). One scenario → the
 * classic pipeline, unchanged. Several → each is searched independently (its
 * own anytime recommendation), then the shortlists are merged and re-verified
 * on fresh seeds ACROSS all scenarios, ranked by the chosen aggregation
 * (mean / maximin / blend). Cost scales linearly with the scenario count.
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
 *  only claim a win where every scenario agrees). */
async function verifyAcross(
	ev: SearchEvaluator, input: SearchInput, ranIdxs: number[], per: OptimizerResult[], ctrl: SearchController,
): Promise<OptimizerResult> {
	const { space, objective, aggregation, effort: cfg } = input;
	const vs = input.current;
	const pick = objPick(objective);
	const ids = ranIdxs.map(si => `S${si}`);
	const pool = new Map<string, BuildRefLite>();
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
	// §E: merge the per-scenario activation reports of the winning build.
	let bestActivations: ActivationTelemetry | undefined;
	{
		const merged: ActivationTelemetry = { seeds: 0, counts: Object.create(null) as Record<string, number>, fired: Object.create(null) as Record<string, number> };
		for (const r of per) {
			const a = r.bestActivations;
			if (!a || r.best.build.id !== best.build.id) continue;
			merged.seeds += a.seeds;
			for (const id in a.counts) merged.counts[id] = (merged.counts[id] ?? 0) + a.counts[id];
			for (const id in a.fired) merged.fired[id] = (merged.fired[id] ?? 0) + a.fired[id];
		}
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
 *  - every restart's final feasible build and the global incumbent always make
 *    it (mandatory slots);
 *  - the remaining slots are filled by LOWER CONFIDENCE BOUND (mean − 1.96·SE)
 *    restricted to well-measured builds (n ≥ SHORTLIST_MIN_SEEDS);
 *  - raw search means are never ranked across builds with wildly different
 *    seed counts — that is how lucky 50-seed bandit strays crowded out the
 *    well-measured restart ends.
 * Feasibility is a hard gate throughout: over-budget neighbours are evaluated
 * for their knapsack numbers only and must never reach the report (§13.3).
 * Deterministic order.
 */
function shortlistBy(ev: SearchEvaluator, si: number, evaluated: Map<string, BuildRefLite>, restartEnds: readonly BuildRefLite[], objective: ObjectiveKind, vs: BuildRefLite | undefined, k: number, space: BuildSpace): BuildRefLite[] {
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
	for (const e of restartEnds) if (affordable(space, e.selection) && !deadSkills(ev, si, e).length) take(e);
	// The global incumbent (the best search objective measured so far) keeps a
	// slot even below the seed floor; it is one raw-mean pick, not a ranking.
	const incumbent = measured.sort((x, y) => y.obj!.mean - x.obj!.mean || (x.b.id < y.b.id ? -1 : 1))[0];
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
	const predX = surr ? surr.model.predict(Xsel) : null;
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
		if (surr && predX) {
			const pred = surr.model.predict(sel);
			const se = Math.sqrt(pred.se * pred.se + predX.se * predX.se);
			est = (pred.mean - predX.mean) + KAPPA * se;                      // acquisition ordering (§8 E)
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
 * SP refill move (a drop followed by its best affordable add — it is one of the
 * swaps, so it is enumerated too). Everything budget-feasible must be reachable
 * in one move: no move caps, no estimate pruning — the bandit's indifference
 * zone (§D) screens, nothing else decides what deserves seeds.
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
