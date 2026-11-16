/**
 * Bandit seed allocation unit tests (plan §9 + the §D indifference zone +
 * the §I.5 prior). No engine: a synthetic CRN evaluator whose per-seed lead
 * is a known Δ + fixed noise, so the ladder's keep/cut decisions are exact.
 */

// HorseDefTypes reads the build-time define at module scope (via evaluator →
// chart.ts); ts-node has no bundler. Before any import: TS compiles imports
// to requires in source order.
(globalThis as any).CC_GLOBAL = true;

import test from 'tape';
import { banditVsIncumbent } from './bandit';
import { BuildRefLite, EnsureReq, pairedOf, SearchEvaluator, statsOf } from './evaluator';
import { EffortConfig, STANDARD } from './config';
import { SeedSlot, SeedValue } from './types';

// ── deterministic PRNG + normal (CRN: identical per (position, build)) ──────
function gauss(i: number): number {
	let h = i | 0;
	h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
	h = Math.imul(h ^ (h >>> 13), 0x45d9f3b);
	h ^= h >>> 16;
	const u1 = ((h >>> 0) + 0.5) / 4294967296;
	h = Math.imul(h ^ 0x9e3779b9, 0x85ebca6b);
	const u2 = ((h >>> 0) + 0.5) / 4294967296;
	return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
function hash(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return h >>> 0;
}

/** Every build's per-seed lead is mu[build] + sigma · n(position, build). */
class FakeEval implements SearchEvaluator {
	private table = new Map<string, SeedSlot[]>();
	races = 0;
	constructor(private mu: Map<string, number>, private sigma: number) { }
	seeds(_ns: string, _si: number, n: number): number[] { return Array.from({ length: n }, (_, i) => i); }
	async ensure(reqs: EnsureReq[]) {
		for (const r of reqs) {
			const k = `${r.ns}|${r.build.id}`;
			let arr = this.table.get(k);
			if (!arr) { arr = []; this.table.set(k, arr); }
			for (const p of r.positions) if (arr[p] === undefined) {
				arr[p] = { lead: this.mu.get(r.build.id)! + this.sigma * gauss(p * 7 + (hash(r.build.id) % 997)), win: 0, top3: 0, placing: 5, hpEmpty: 0, rushed: 0 };
				this.races++;
			}
		}
		return { jobErrors: [] };
	}
	slots(ns: string, _si: number, id: string): SeedSlot[] { return this.table.get(`${ns}|${id}`) ?? []; }
	racesRun(): number { return this.races; }
	stats(ns: string, si: number, build: BuildRefLite) {
		const arr = this.slots(ns, si, build.id);
		return arr.some(s => s != null) ? statsOf(arr) : null;
	}
	paired(ns: string, si: number, a: BuildRefLite, b: BuildRefLite, pick: (v: SeedValue) => number | null) {
		return pairedOf(this.slots(ns, si, a.id), this.slots(ns, si, b.id), pick);
	}
	objective(): null { return null; }
	dispose(): void { this.table.clear(); }
}

const cfg: EffortConfig = { ...STANDARD, deltaMinL: 0.03 };
const build = (id: string): BuildRefLite => ({ id, selection: [id] });
const pickLead = (v: SeedValue): number | null => v.lead;

test('§I prior: a candidate whose optimistic bound is under δ_min never races', async t => {
	const inc = build('inc'), good = build('good'), dead = build('dead');
	const mk = () => new Map<string, number>([[inc.id, 0], [good.id, 0.2], [dead.id, -5]]);
	const ev = new FakeEval(mk(), 0.5);
	const res = await banditVsIncumbent(ev, {
		ns: 's', scenarioIdx: 0, incumbent: inc, candidates: [good, dead], pick: pickLead, cfg,
		// A near-exact prior (se ≈ 0): dead's optimistic bound is −5 + 2·0.01.
		prior: b => (b.id === dead.id ? { gain: -5, se: 0.01 } : { gain: 0.2, se: 0.01 }),
	});
	t.equal(res.priorCut, 1, 'the bound-certified candidate is cut before its first race');
	t.equal(ev.slots('s', 0, dead.id).filter(x => x != null).length, 0, 'the cut candidate was never raced');
	t.ok(res.survivors.some(s => s.build.id === good.id), 'the predicted improver still races');
	t.equal(res.measured.some(m => m.build.id === dead.id), false, 'never raced, so never in measured');
	// Without the prior the same candidate pays the first rung before the
	// indifference zone (or the rival cut) can retire it.
	const ev2 = new FakeEval(mk(), 0.5);
	const res2 = await banditVsIncumbent(ev2, { ns: 's', scenarioIdx: 0, incumbent: inc, candidates: [good, dead], pick: pickLead, cfg });
	t.equal(res2.priorCut, 0, 'no prior, no prior cuts');
	t.ok(ev2.slots('s', 0, dead.id).filter(x => x != null).length >= 50, 'unprior\'d: the hopeless candidate paid ≥ one 50-seed rung');
	t.end();
});

test('§I prior: a borderline prediction still races, and the indifference zone still retires it', async t => {
	const inc = build('inc'), border = build('border');
	const ev = new FakeEval(new Map<string, number>([[inc.id, 0], [border.id, 0]]), 0.5);
	// Optimistic bound 0 + 2·0.02 = 0.04 ≥ δ_min → the prior cannot retire it.
	const res = await banditVsIncumbent(ev, {
		ns: 's', scenarioIdx: 0, incumbent: inc, candidates: [border], pick: pickLead, cfg,
		prior: () => ({ gain: 0, se: 0.02 }),
	});
	t.equal(res.priorCut, 0, 'the optimistic bound kept it alive');
	const m = res.measured.find(x => x.build.id === border.id)!;
	t.ok(m.diff.n >= 50, `it raced at least the first rung (n=${m.diff.n})`);
	t.notOk(m.survived, 'the indifference zone (not the prior) retired it');
	t.end();
});

test('§I prior: a prior that answers null leaves the ladder exactly as it was', async t => {
	const mk = () => new Map<string, number>([['inc', 0], ['a', 0.1], ['b', -0.1]]);
	const cs = () => [build('a'), build('b')];
	const ev1 = new FakeEval(mk(), 0.4), ev2 = new FakeEval(mk(), 0.4);
	const r1 = await banditVsIncumbent(ev1, { ns: 's', scenarioIdx: 0, incumbent: build('inc'), candidates: cs(), pick: pickLead, cfg });
	const r2 = await banditVsIncumbent(ev2, { ns: 's', scenarioIdx: 0, incumbent: build('inc'), candidates: cs(), pick: pickLead, cfg, prior: () => null });
	t.equal(ev1.races, ev2.races, 'same races with a null-answering prior');
	t.deepEqual(r1.measured.map(x => [x.build.id, x.survived, x.diff.n]), r2.measured.map(x => [x.build.id, x.survived, x.diff.n]), 'same measured rows (the §9/§D ladder is untouched)');
	t.end();
});
