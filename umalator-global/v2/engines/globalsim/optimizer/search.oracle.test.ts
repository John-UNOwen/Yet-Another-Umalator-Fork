/**
 * Synthetic oracle tests — the plan's CORE correctness harness (§13.1).
 *
 * A fake evaluator with known per-skill values, planted pair synergies and
 * overlaps, and a recovery-threshold effect (a recovery skill is worth 0 until
 * the hidden HP budget is crossed), with Gaussian seed noise at the calibrated
 * σ(ℓ) ≈ 1.6 L. Instances ≤ 16 options are fully enumerable, so the true
 * optimum is exact: the optimizer must land on it or a statistical tie in
 * ≥ 95% of 100 random instances (plan §13.1). Determinism (§13.4) and the
 * §13.3 invariants are asserted here too.
 */

// HorseDefTypes reads the build-time define at module scope (via evaluator →
// chart.ts); ts-node has no bundler. Before any import: TS compiles imports
// to requires in source order.
(globalThis as any).CC_GLOBAL = true;

import test from 'tape';
import { NS_SEARCH, NS_VERIFY } from './cache';
import { EffortConfig } from './config';
import { BuildRefLite, objectiveOf, pairedOf, SearchEvaluator, statsOf } from './evaluator';
import { BuildSpace, OptOption, simIdentity } from './space';
import { createController, runOptimizer } from './search';
import { MeanSem, ObjectiveKind, OptimizerProgress, OptimizerResult, SeedSlot, SeedValue } from './types';

// ── deterministic PRNG + normal noise (CRN: identical per (ns, position)) ───

function mulberry(seed: number): () => number {
	let a = seed | 0;
	return () => {
		a = (a + 0x6D2B79F5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const SIGMA_L = 1.6; // measured σ(ℓ) band (optimizer/README.md)

/** Standard normal, deterministic per integer index (Box–Muller over two hashes). */
function gauss(idx: number): number {
	const u1 = (mulberry(idx * 2 + 1)() || 1e-12);
	const u2 = mulberry(idx * 2 + 2)();
	return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Φ: exact P(ℓ > 0) for a build at latent mean μ under Gaussian noise. */
const phi = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
function erf(x: number): number {
	// Abramowitz & Stegun 7.1.26 (|ε| < 1.5e-7)
	const s = x < 0 ? -1 : 1;
	x = Math.abs(x);
	const t = 1 / (1 + 0.3275911 * x);
	const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
	return s * y;
}

// ── the instance (known latent build values) ────────────────────────────────

interface Instance {
	space: BuildSpace;
	/** Latent mean lead (lengths) of a simulated identity. */
	mu: (identity: string) => number;
	/** Every feasible build, best-first (exact enumeration). */
	ranked: { ids: string[]; mu: number }[];
}

function genInstance(seed: number): Instance {
	const rng = mulberry(seed);
	const nOpts = 8 + Math.floor(rng() * 9); // 8..16 options
	const options: OptOption[] = [];
	const groupOf = new Map<string, string>();
	const groupCount: string[] = [];
	for (let i = 0; i < nOpts; i++) {
		const id = `o${i}`;
		// ~40% chance to join an existing small group (tier/overlap families)
		let gid = `g${groupCount.length}`;
		if (groupCount.length) {
			const small = groupCount.filter(g => options.filter(o => o.groupId === g).length < 3);
			if (small.length && rng() < 0.4) gid = small[Math.floor(rng() * small.length)];
		}
		if (!groupOf.has(gid)) groupCount.push(gid);
		const cost = 20 + Math.floor(rng() * 120);
		options.push({ id, groupId: gid, cost, tierIndex: 0, forced: false });
		groupOf.set(id, gid);
	}
	const byId = new Map(options.map(o => [o.id, o] as const));
	const groups = new Map<string, OptOption[]>();
	for (const o of options) {
		const l = groups.get(o.groupId) ?? [];
		l.push(o);
		groups.set(o.groupId, l);
	}
	const sum = options.reduce((a, o) => a + o.cost, 0);
	const budget = Math.max(200, Math.round(sum * (0.30 + rng() * 0.22)));
	const space: BuildSpace = {
		ownedByGroup: new Map(), fixedIds: [], forcedCost: 0,
		options, byId, groups, budget, warnings: [],
	};

	// latent model: per-option value + planted pair synergy/overlap + recovery
	// threshold. Effect sizes are calibrated to the RESOLVABLE BAND (§7.3): a
	// few strong options move μ by ~±1–2 L around the win/loss boundary
	// (σ(ℓ) = 1.6 L), so P(1st) lands in 0.3–0.9 where paired differences are
	// what the real game actually asks the optimizer to resolve.
	const val = new Map<string, number>();
	for (const o of options) val.set(o.id, (rng() - 0.5) * 1.0);
	const pairCount = 2 + Math.floor(rng() * 3);
	const pairs: { a: string; b: string; w: number }[] = [];
	for (let p = 0; p < pairCount; p++) {
		const a = options[Math.floor(rng() * nOpts)].id;
		const b = options[Math.floor(rng() * nOpts)].id;
		if (a === b || groupOf.get(a) === groupOf.get(b)) continue; // pairs span groups
		const w = (rng() < 0.6 ? 1 : -1) * (0.15 + rng() * 0.45); // synergy or overlap
		pairs.push({ a, b, w });
	}
	const recovery = options.filter(() => rng() < 0.35).slice(0, 4).map(o => o.id);
	const hpMap = new Map(recovery.map(r => [r, 1 + Math.floor(rng() * 3)] as const));
	const hpThreshold = recovery.length >= 2 ? 2 + Math.floor(rng() * 3) : 0; // hidden "recovery budget"

	const mu = (identity: string): number => {
		const ids = identity ? identity.split(',') : [];
		const have = new Set(ids);
		const recSum = recovery.reduce((a, r) => a + (have.has(r) ? (hpMap.get(r) ?? 0) : 0), 0);
		const recOn = recovery.length >= 2 && hpThreshold > 0 ? recSum >= hpThreshold : true;
		let m = 0;
		for (const id of ids) {
			const v = val.get(id) ?? 0;
			m += recovery.includes(id) && !recOn ? 0 : v; // recovery skills: worth 0 until the hidden HP budget is crossed
		}
		for (const p of pairs) if (have.has(p.a) && have.has(p.b)) m += p.w;
		return m;
	};

	// exact enumeration of every feasible (group-exclusive) build
	const ranked: { ids: string[]; mu: number }[] = [];
	const groupList = [...groups.values()];
	const walk = (gi: number, sel: string[], cost: number) => {
		if (gi === groupList.length) { ranked.push({ ids: [...sel], mu: mu(simIdentity(space, sel)) }); return; }
		walk(gi + 1, sel, cost); // pick none
		for (const o of groupList[gi]) {
			if (cost + o.cost > budget) continue;
			sel.push(o.id);
			walk(gi + 1, sel, cost + o.cost);
			sel.pop();
		}
	};
	walk(0, [], 0);
	ranked.sort((a, b) => b.mu - a.mu || (a.ids.join() < b.ids.join() ? -1 : 1));
	return { space, mu, ranked };
}

// ── the fake evaluator: exact model + CRN Gaussian noise ────────────────────

class OracleEval implements SearchEvaluator {
	private table = new Map<string, SeedSlot[]>(); // `${ns}|${id}`
	private races = 0;
	/** Noise offset separating the two namespaces = the P3 disjointness analog. */
	private noiseIndex(ns: string, pos: number): number { return ns === NS_SEARCH ? pos : 1000000 + pos; }

	constructor(private inst: Instance) {}

	/** Two-part noise (calibrated §7.3): a SHARED field term (gate/pace luck,
	 *  cancels in paired comparisons) + a build-specific term — so σ(ℓ) ≈ 1.6
	 *  while the PAIRED σΔ(ℓ) ≈ 1.5, matching the measured engine band. Pure
	 *  shared noise would make paired ℓ differences noise-free — unrealistically
	 *  easy screening. */
	private static readonly SIGMA_FIELD = 0.6;
	private static readonly SIGMA_INDEP = 1.5;

	private leadOf(identity: string, ns: string, pos: number): number {
		let h = 2166136261;
		for (let i = 0; i < identity.length; i++) h = Math.imul(h ^ identity.charCodeAt(i), 16777619);
		const field = gauss(this.noiseIndex(ns, pos) * 3 + 0);
		const indep = gauss(this.noiseIndex(ns, pos) * 3 + 1 + Math.imul(h | 0, 40503) * 3);
		return this.inst.mu(identity) + OracleEval.SIGMA_FIELD * field + OracleEval.SIGMA_INDEP * indep;
	}

	private valueOf(identity: string, ns: string, pos: number): SeedValue {
		const lead = this.leadOf(identity, ns, pos);
		const placing = Math.min(10, Math.max(1, 5 - Math.round(lead * 2)));
		return { lead, win: lead > 0 ? 1 : 0, top3: placing <= 3 ? 1 : 0, placing, hpEmpty: 0, rushed: 0 };
	}

	seeds(ns: string, _si: number, n: number): number[] { return Array.from({ length: n }, (_, i) => i); }

	async ensure(reqs: { ns: string; scenarioIdx: number; build: BuildRefLite; positions: number[] }[]) {
		for (const r of reqs) {
			const k = `${r.ns}|${r.build.id}`;
			let arr = this.table.get(k);
			let maxPos = -1;
			for (const p of r.positions) if (p > maxPos) maxPos = p;
			if (!arr) { arr = new Array<SeedSlot>(maxPos + 1).fill(null); this.table.set(k, arr); }
			else if (arr.length < maxPos + 1) {
				// Grow: trailing holes must be null, not undefined (mirrors cache.ts)
				const old = arr.length;
				arr.length = maxPos + 1;
				arr.fill(null, old);
			}
			for (const p of r.positions) {
				if (arr[p] == null) { arr[p] = this.valueOf(r.build.id, r.ns, p); this.races++; }
			}
		}
		return { jobErrors: [] };
	}

	private slotsOf(ns: string, id: string): SeedSlot[] { return this.table.get(`${ns}|${id}`) ?? []; }
	slots(ns: string, _si: number, identity: string): SeedSlot[] { return this.slotsOf(ns, identity); }
	racesRun(): number { return this.races; }
	stats(ns: string, _si: number, build: BuildRefLite) {
		const arr = this.slotsOf(ns, build.id);
		return arr.some(s => s != null) ? statsOf(arr) : null;
	}
	paired(ns: string, _si: number, a: BuildRefLite, b: BuildRefLite, pick: (v: SeedValue) => number | null) {
		return pairedOf(this.slotsOf(ns, a.id), this.slotsOf(ns, b.id), pick);
	}
	objective(ns: string, _si: number, build: BuildRefLite, obj: ObjectiveKind, vs?: BuildRefLite): MeanSem | null {
		const st = this.stats(ns, _si, build);
		if (!st) return null;
		const gain = obj === 'gainVsCurrent' && vs ? this.paired(ns, _si, build, vs, v => v.lead) : null;
		return objectiveOf(st, obj, gain);
	}
	dispose(): void { /* nothing external */ }
}

// ── the harness ─────────────────────────────────────────────────────────────

const TEST_CFG: EffortConfig = {
	preset: 'standard',
	// Standard-scale knobs (plan §11); verification trimmed for test runtime.
	deltaMinL: 0.03, restarts: 3, dMaxIters: 4, beam: 0,
	gSeedsMin: 2000, gSeedsCap: 6000, batchCap: 5000, surrogate: false, timeBudgetMs: Infinity,
	screenRound1Seeds: 25, screenRound2Seeds: 175, screenFilterMaxL: 0.1, screenFilterSpreadL: 0.1,
	noiseSeeds: 120, noiseVariants: 3,
};

const refOf = (space: BuildSpace, ids: string[]): BuildRefLite => ({ id: simIdentity(space, ids), selection: ids });

test('oracle model sanity: instances live in the resolvable band (P(1st) not saturated)', t => {
	let boundary = 0;
	for (let i = 0; i < 30; i++) {
		const inst = genInstance(7000 + i);
		if (!inst.ranked.length) continue;
		const p1 = phi(inst.ranked[0].mu / SIGMA_L);
		if (p1 < 0.97) boundary++;
	}
	t.ok(boundary >= 20, `most instances near the decision boundary (${boundary}/30 with true P1 < 0.97)`);
	t.end();
});

test('synthetic oracle: >=95% of 100 instances find the optimum or a statistical tie (§13.1)', async t => {
	const fails: string[] = [];
	let ties = 0, exact = 0, races = 0;
	for (let i = 0; i < 100; i++) {
		const seed = 1234 + i * 97;
		const inst = genInstance(seed);
		const ev = new OracleEval(inst);
		const ctrl = createController();
		let result: OptimizerResult;
		try {
			if (process.env.OPT_DEBUG_I !== undefined && i === Number(process.env.OPT_DEBUG_I)) (globalThis as any).OPT_DBG = true;
			result = await runOptimizer(ev, { space: inst.space, scenarioIdx: 0, objective: 'p1', aggregation: 'mean', effort: TEST_CFG }, ctrl, (_p: OptimizerProgress) => undefined);
			(globalThis as any).OPT_DBG = false;
		} catch (e) {
			fails.push(`#${i}: threw ${e}`);
			continue;
		}
		races += ev.racesRun();
		const best = result.best.build.id;
		const truth = inst.ranked[0];
		const truthId = [...truth.ids].sort().join(',');
		if (best === truthId) { exact++; continue; }
		const rec = refOf(inst.space, best.split(',').filter(Boolean));
		// Within δ_min of the model optimum = "the optimum" by the plan's own
		// definition of the smallest difference worth chasing (§11).
		if (truth.mu - inst.mu(rec.id) <= TEST_CFG.deltaMinL) { ties++; continue; }
		// Statistical tie: paired Δ win (verify seeds) vs the true best contains 0.
		const tb = refOf(inst.space, truth.ids);
		// Put the ground-truth build on the SAME verified seeds, then compare paired.
		await ev.ensure([{ ns: NS_VERIFY, scenarioIdx: 0, build: tb, positions: Array.from({ length: result.verificationSeeds }, (_, k) => k) }]);
		const d = ev.paired(NS_VERIFY, 0, rec, tb, v => v.win);
		if (d && d.ci95[0] <= 0 && d.ci95[1] >= 0) { ties++; continue; }
		fails.push(`#${i}: rec[${rec.id}] p1 ${phi(inst.mu(rec.id) / SIGMA_L).toFixed(3)} vs true[${tb.id}] ${phi(truth.mu / SIGMA_L).toFixed(3)} (Δci [${d ? d.ci95[0].toFixed(3) : '?'},${d ? d.ci95[1].toFixed(3) : '?'}])`);
	}
	console.log(`  oracle: exact=${exact} tie=${ties} fail=${fails.length} avgRaces=${Math.round(races / 100)}`);
	for (const f of fails.slice(0, 8)) console.log('  MISS', f);
	t.ok(fails.length <= 5, `failure rate ≤ 5% (fails=${fails.length}/100)`);
	t.end();
});

test('invariants on every shortlist row + determinism (§13.3, §13.4)', async t => {
	const inst = genInstance(4242);
	const run = async () => {
		const ev = new OracleEval(inst);
		return { res: await runOptimizer(ev, { space: inst.space, scenarioIdx: 0, objective: 'p1', aggregation: 'mean', effort: TEST_CFG }, createController(), () => undefined), ev };
	};
	const a = await run();
	const b = await run();
	t.equal(a.res.best.build.id, b.res.best.build.id, 'same recommendation across runs');
	t.deepEqual(a.res.best.obj, b.res.best.obj, 'same verification numbers across runs (CRN)');
	for (const row of a.res.shortlist) {
		t.ok(row.leftover >= 0, 'never over budget');
		const seen = new Set<string>();
		for (const id of row.build.selection) {
			const gid = inst.space.byId.get(id)!.groupId;
			t.ok(!seen.has(gid), `group ${gid} appears once`);
			seen.add(gid);
		}
	}
	t.ok(a.res.verificationSeeds >= TEST_CFG.gSeedsMin, 'verification meets the seed floor');
	t.ok(a.res.searchSeedsPerScenario > 0 && !a.res.stoppedEarly, 'search seeds reported; not truncated');
	a.ev.dispose(); b.ev.dispose();
	t.end();
});

test('meanLead objective also finds the true latent best (ties allowed)', async t => {
	const inst = genInstance(99001);
	const ev = new OracleEval(inst);
	const res = await runOptimizer(ev, { space: inst.space, scenarioIdx: 0, objective: 'meanLead', aggregation: 'mean', effort: TEST_CFG }, createController(), () => undefined);
	const truthMu = inst.ranked[0].mu;
	const recMu = inst.mu(res.best.build.id);
	// Under CRN Gaussian noise the paired ℓ CI resolves ~0.15 L at these seed counts.
	t.ok(recMu >= truthMu - 0.2, `rec μ ${recMu.toFixed(2)} ≥ true ${truthMu.toFixed(2)} − 0.2`);
	t.end();
});
