/**
 * Search pipeline orchestration (SKILL-OPTIMIZER-PLAN §8). Stages B–D + G live
 * here; Stage A (book) ships with Phase 5 and Stage E (surrogate) / Stage F
 * (local search) plug into the same loop later. Everything measurable runs
 * through the evaluator (P7); every comparison is paired over identical seed
 * positions (P2); final numbers come only from the verification namespace (P3);
 * progress events make the run anytime (P5); all inputs are deterministic (P6).
 */

import { banditVsIncumbent } from './bandit';
import { EffortConfig } from './config';
import { BuildRefLite, calibrateNoise, PairedDiff, SearchEvaluator } from './evaluator';
import { NS_SEARCH, NS_VERIFY } from './cache';
import { KnapGroup, mckpSolve, mckpTopK } from './knapsack';
import { affordable, assertFeasible, assertOnePerGroup, BuildSpace, costOf, OptOption, simIdentity } from './space';
import {
	AggregationKind, MeanSem, NoiseInfo, ObjectiveKind, OptimizerProgress,
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

export interface SearchInput {
	space: BuildSpace;
	/** Scenario to optimize against (Phase 5 generalizes to the scenario set). */
	scenarioIdx: number;
	objective: ObjectiveKind;
	aggregation: AggregationKind;
	effort: EffortConfig;
	/** The user's current build (gainVsCurrent pairs against it). */
	current?: BuildRefLite;
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

export async function runOptimizer(
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
			if (n >= nCap) break;
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
		return {
			best, shortlist: rows, noise,
			verificationSeeds: n,
			searchSeedsPerScenario: maxSearchFilled,
			stoppedEarly,
			orderingCorrelation: Number.isFinite(orderingCorrelation) ? orderingCorrelation : undefined,
		};
	};

	if (ctrl.stopped()) return verify(shortlistBy(ev, si, evaluated, objective, vs, 3, space), Math.min(1000, cfg.gSeedsCap), Math.min(1000, cfg.gSeedsCap), true);

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
	if (ctrl.stopped()) return verify(shortlistBy(ev, si, evaluated, objective, vs, 3, space), Math.min(1000, cfg.gSeedsCap), Math.min(1000, cfg.gSeedsCap), true);

	// ── Stage C: starting builds by multiple-choice knapsack ──────────────────
	emit('knapsack');
	const knapGroups = (): KnapGroup[] => [...space.groups.entries()].map(([groupId, opts]) => ({
		groupId,
		options: opts.filter(o => !o.forced).map(o => ({ id: o.id, cost: o.cost, value: v0.get(o.id)?.mean ?? 0 })),
		forcedId: opts.find(o => o.forced)?.id,
	}));
	dbg('starts');
	const startBuilds: BuildRefLite[] = [base];
	for (const sol of mckpTopK(knapGroups(), space.budget, Math.max(1, cfg.restarts))) {
		const b = remember(refOf(selFromKnap(sol.selection.values())));
		if (!startBuilds.some(s => s.id === b.id)) startBuilds.push(b);
	}
	emit('knapsack', `${startBuilds.length} restart points`, provisional(startBuilds[startBuilds.length - 1]));

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
		/** Fold bandit outcomes into the value maps (D and F share the semantics). */
		const applyMeasured = (
			outcomes: { build: BuildRefLite; diff: PairedDiff }[],
			dropOf: Map<string, string>,
			addedOf: Map<string, { opt: string; replaced?: string; pairWith?: string }>,
		) => {
			for (const out of outcomes) {
				const drop = dropOf.get(out.build.id);
				if (drop != null) { value.set(drop, -out.diff.mean); valueN.set(drop, out.diff.n); } // ℓ(X) − ℓ(X−i)
			}
			// Singles first, then pairs (a direct single measurement always
			// beats the pair's half-split floor estimate — two passes, no race).
			for (const out of outcomes) {
				const add = addedOf.get(out.build.id);
				if (!add || add.pairWith) continue;
				// Δ of X−i+j vs X is v_j − v_i; put v_i back when it was measured
				// (or fall back to the out-of-context v⁰) so the knapsack gets v_j.
				const back = add.replaced ? (value.get(add.replaced) ?? v0.get(add.replaced)?.mean ?? 0) : 0;
				value.set(add.opt, out.diff.mean + back); valueN.set(add.opt, out.diff.n);
			}
			for (const out of outcomes) {
				const add = addedOf.get(out.build.id);
				if (!add || !add.pairWith) continue;
				// Pair add Δ splits half/half as a floor estimate — never
				// overwrite a direct single-option measurement.
				if (!value.has(add.opt)) { value.set(add.opt, out.diff.mean / 2); valueN.set(add.opt, out.diff.n); }
				if (!value.has(add.pairWith)) { value.set(add.pairWith, out.diff.mean / 2); valueN.set(add.pairWith, out.diff.n); }
			}
		};
		for (let it = 0; it < cfg.dMaxIters; it++) {
			if (Date.now() - t0 > cfg.timeBudgetMs) break;
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
					addedOf.set(b.id, { opt: A.id, pairWith: C.id });
					cands.push(b);
				};
				for (let a = 0; a < pos.length && a < 3; a++) for (let c = a + 1; c < pos.length; c++) addPair(pos[a], pos[c]);
				if (it === 0) for (const a of pos.slice(0, 2)) for (const c of free) if (a.id !== c.id) addPair(a, c);
			}
			dbg('D s', s, 'it', it, 'X', X.id || '(base)', 'cands', cands.length);
			const outcomes = (await banditVsIncumbent(ev, {
				ns: NS_SEARCH, scenarioIdx: si, incumbent: X,
				candidates: cands.sort((a, b) => (a.id < b.id ? -1 : 1)), pick: searchPick, cfg,
			})).measured; // eliminated candidates' numbers feed the re-solve too (§8D)
			applyMeasured(outcomes, dropOf, addedOf);
			for (const out of outcomes) dbg('  meas', out.survived ? '+' : '-', out.build.id || '(base)', 'Δ', out.diff.mean.toFixed(3), 'n', out.diff.n);
			// Re-solve the knapsack with in-context values.
			const groups: KnapGroup[] = knapGroups().map(g => ({
				...g,
				options: g.options.map(o => ({ ...o, value: ctxVal(o.id) })),
			}));
			const sol = mckpSolve(groups, space.budget);
			const Y = sol ? remember(refOf(selFromKnap(sol.selection.values()))) : X;
			if (Y.id === X.id) { dbg('  Y==X, stop'); break; } // the build stopped changing
			dbg('  re-solve Y', Y.id || '(base)');
			// Adopt only on a significant improvement (lower CI bound > 0, §8D).
			const held = Math.min(cfg.batchCap, Math.max(150, filled(ev, NS_SEARCH, si, X)));
			const pos = Array.from({ length: held }, (_, i) => i);
			await ev.ensure([
				{ ns: NS_SEARCH, scenarioIdx: si, build: X, positions: pos },
				{ ns: NS_SEARCH, scenarioIdx: si, build: Y, positions: pos },
			]);
			const d = ev.paired(NS_SEARCH, si, Y, X, searchPick);
			dbg('  adopt test Δ', d ? d.mean.toFixed(3) : 'null', 'ci', d ? JSON.stringify(d.ci95.map(x => +x.toFixed(3))) : '');
			let adoptedNow = false;
			if (d && d.ci95[0] > 0) {
				X = Y;
				adoptedNow = true;
			} else {
				// Fallback (plan §8F "adopt the best significant improvement"
				// honored inside D): a bandit survivor with a significant Δ is a
				// safer step than the combined re-solve; hill-climb one move.
				const sure = outcomes.filter(out => out.survived && out.diff.n >= 2 && out.diff.ci95[0] > 0)
					.sort((a, b) => b.diff.mean - a.diff.mean);
				if (sure.length) {
					X = sure[0].build;
					adoptedNow = true;
					dbg('  fallback adopt', X.id || '(base)', sure[0].diff.mean.toFixed(3));
				}
			}
			if (adoptedNow) {
				for (const id of X.selection) if (!histAdopted.has(id)) histAdopted.add(id);
				emit('incontext', `adopted`, provisional(X));
			} else break;
		}

		// ── Stage F: local search over richer moves (§8F) ─────────────────────
		// Order: estimated Σv_added − Σv_removed (+history bonus), surrogate UCB
		// replaces this in Stage E. Prune: estimated Δ ≤ δ_min. Evaluate
		// survivors against X with bandit allocation; adopt the best
		// significant improvement; repeat until nothing passes or rounds run out.
		for (let fr = 0; fr < cfg.fMaxRounds; fr++) {
			if (ctrl.stopped() || Date.now() - t0 > cfg.timeBudgetMs) break;
			const moves = fMoves(space, X, ctxVal, cfg.deltaMinL, histAdopted);
			if (!moves.length) break;
			const batch = moves.slice(0, F_BATCH_MAX);
			emit('local', `restart ${s + 1}/${startBuilds.length} local ${fr + 1}/${cfg.fMaxRounds} (${batch.length}/${moves.length} moves)`, provisional(X));
			const dropOf = new Map<string, string>();
			const addedOf = new Map<string, { opt: string; replaced?: string; pairWith?: string }>();
			for (const mv of batch) {
				if (mv.adds.length === 0 && mv.drops.length === 1) dropOf.set(mv.b.id, mv.drops[0]);
				else if (mv.adds.length === 1) addedOf.set(mv.b.id, mv.drops.length === 1 ? { opt: mv.adds[0], replaced: mv.drops[0] } : { opt: mv.adds[0] });
				else if (mv.adds.length === 2) addedOf.set(mv.b.id, { opt: mv.adds[0], pairWith: mv.adds[1] });
			}
			const outcomes = (await banditVsIncumbent(ev, {
				ns: NS_SEARCH, scenarioIdx: si, incumbent: X,
				candidates: batch.map(m => m.b).sort((a, b) => (a.id < b.id ? -1 : 1)), pick: searchPick, cfg,
			})).measured;
			applyMeasured(outcomes, dropOf, addedOf);
			for (const out of outcomes) dbg('  F', out.build.id || '(base)', 'Δ', out.diff.mean.toFixed(3), 'surv', out.survived ? 1 : 0);
			// Adopt only a significant improvement (lower CI bound > 0).
			const sure = outcomes.filter(o => o.survived && o.diff.n >= 2 && o.diff.ci95[0] > 0)
				.sort((a, b) => b.diff.mean - a.diff.mean);
			if (!sure.length) break; // no candidate's CI upper beat X ⇒ local optimum (§8F stop)
			X = sure[0].build;
			remember(X);
			for (const id of X.selection) histAdopted.add(id);
			emit('local', `local adopted`, provisional(X));
		}
		remember(X);
	}
	if (ctrl.stopped()) return verify(shortlistBy(ev, si, evaluated, objective, vs, 3, space), Math.min(1000, cfg.gSeedsCap), Math.min(1000, cfg.gSeedsCap), true);

	// ── Stage G: verification on fresh seeds (the only numbers reported) ──────
	const short = shortlistBy(ev, si, evaluated, objective, vs, 5, space);
	return verify(short, cfg.gSeedsMin, cfg.gSeedsCap, false);
}

/** Top-k evaluated builds by cached search objective (deterministic order).
 *  Feasibility is a hard gate here: over-budget neighbours are evaluated for
 *  their knapsack numbers only and must never reach the report (§13.3). */
function shortlistBy(ev: SearchEvaluator, si: number, evaluated: Map<string, BuildRefLite>, objective: ObjectiveKind, vs: BuildRefLite | undefined, k: number, space: BuildSpace): BuildRefLite[] {
	return [...evaluated.values()]
		.filter(b => affordable(space, b.selection))
		.map(b => ({ b, obj: ev.objective(NS_SEARCH, si, b, objective, vs) }))
		.filter(x => x.obj && x.obj.n > 0 && Number.isFinite(x.obj.mean))
		.sort((x, y) => y.obj!.mean - x.obj!.mean || (x.b.id < y.b.id ? -1 : 1))
		.slice(0, k)
		.map(x => x.b);
}

/** Tie flag vs the recommendation itself (post tie-break reorder). */
function evPairedBest(ev: SearchEvaluator, si: number, best: BuildRefLite, b: BuildRefLite, pick: (v: SeedValue) => number | null): PairedDiff | null {
	return ev.paired(NS_VERIFY, si, best, b, pick);
}

/** Bandit batch width for Stage F local search (kept modest so each move
 *  gets a meaningful rung before the batch cap; the plan caps by value). */
const F_BATCH_MAX = 14;
/** Hard ceiling on generated moves before batching (keeps the O(K·F) sweep
 *  bounded; the top-F_BATCH_MAX by estimate are what get evaluated). */
const F_MOVE_CAP = 60;

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

/** Enumerate the feasible Stage-F neighbourhood of X (§8F), ordered best
 *  estimate first. Estimates use in-context ctxVal with a small history
 *  bonus on skills that improved earlier builds. Pruning (est ≤ δ_min) and
 *  feasibility (over budget) drop moves before any race is run. */
function fMoves(
	space: BuildSpace,
	X: BuildRefLite,
	ctxVal: (id: string) => number,
	deltaMinL: number,
	hist: ReadonlySet<string>,
): FMove[] {
	const Xsel = X.selection;
	const seen = new Set<string>([X.id]);
	const free = space.options.filter(o => !o.forced && !Xsel.includes(o.id));
	const owned = Xsel.filter(id => !space.byId.get(id)?.forced);
	const pos = [...free].filter(o => ctxVal(o.id) > 0).sort((a, b) => ctxVal(b.id) - ctxVal(a.id));
	const raw: { drops: string[]; adds: string[] }[] = [];
	// 1. single adds
	for (const j of free) raw.push({ drops: [], adds: [j.id] });
	// 2. single drops
	for (const i of owned) raw.push({ drops: [i], adds: [] });
	// 3. replaces: 1-for-1 (cross-group swap; same-group = tier move)
	for (const i of owned) for (const j of free) raw.push({ drops: [i], adds: [j.id] });
	// 4. pair adds among the strongest positive options
	for (let a = 0; a < pos.length && a < 3; a++) for (let c = a + 1; c < pos.length && c < 4; c++) if (pos[a].groupId !== pos[c].groupId) raw.push({ drops: [], adds: [pos[a].id, pos[c].id] });
	// 5. pair removes within the build
	for (let a = 0; a < owned.length; a++) for (let c = a + 1; c < owned.length; c++) raw.push({ drops: [owned[a], owned[c]], adds: [] });
	// 6. uneven: drop one, add two strong (1-for-2)
	for (const i of owned) {
		const g2 = pos.filter(o => o.groupId !== space.byId.get(i)?.groupId).slice(0, 3);
		for (let a = 0; a < g2.length; a++) for (let c = a + 1; c < g2.length; c++) if (g2[a].groupId !== g2[c].groupId) raw.push({ drops: [i], adds: [g2[a].id, g2[c].id] });
	}

	const out: FMove[] = [];
	for (const mv of raw) {
		const sel = applyMove(space, Xsel, mv.drops, mv.adds);
		const b: BuildRefLite = { id: simIdentity(space, sel), selection: sel };
		if (seen.has(b.id)) continue;
		if (!affordable(space, sel)) continue;               // §13.3: never over budget
		seen.add(b.id);
		const added = sel.filter(s => !Xsel.includes(s));
		const removed = Xsel.filter(s => !sel.includes(s));
		let est = 0;
		for (const id of added) est += ctxVal(id) + (hist.has(id) ? deltaMinL : 0); // history heuristic (§8F)
		for (const id of removed) est -= ctxVal(id);
		if (est <= deltaMinL) continue;                       // optimistic prune (§8F)
		out.push({ b, est, drops: removed, adds: added });
	}
	return out
		.sort((a, b) => b.est - a.est || (a.b.id < b.b.id ? -1 : 1))
		.slice(0, F_MOVE_CAP);
}
