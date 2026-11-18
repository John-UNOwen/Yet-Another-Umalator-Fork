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
import { banditVsIncumbent, raceWave } from './bandit';
import { BuildRefLite, EnsureReq, pairedOf, SearchEvaluator, statsOf } from './evaluator';
import { CLIMB_CONFIRM_START, CLIMB_NMAX_FACTOR, CLIMB_TARGET_SEEDS, EffortConfig, SEED_LIST_SIZE, SEQ_ADOPT_Z, STANDARD } from './config';
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

/** Every build's per-seed lead is mu[build] + sigma · n(position, build).
 *  `twin` gives a build another build's noise (a move that changes nothing:
 *  every paired Δ is the same). `errFrom` makes a build's seeds from that
 *  position on engine errors. Like the real evaluator, a position past the
 *  seed list throws. */
class FakeEval implements SearchEvaluator {
	private table = new Map<string, SeedSlot[]>();
	races = 0;
	constructor(private mu: Map<string, number>, private sigma: number,
		private opt: { twin?: Map<string, string>; errFrom?: Map<string, number> } = {}) { }
	seeds(_ns: string, _si: number, n: number): number[] { return Array.from({ length: n }, (_, i) => i); }
	async ensure(reqs: EnsureReq[]) {
		for (const r of reqs) {
			const k = `${r.ns}|${r.build.id}`;
			let arr = this.table.get(k);
			if (!arr) { arr = []; this.table.set(k, arr); }
			const noiseId = this.opt.twin?.get(r.build.id) ?? r.build.id;
			const errFrom = this.opt.errFrom?.get(r.build.id) ?? Infinity;
			for (const p of r.positions) if (arr[p] === undefined) {
				if (p >= SEED_LIST_SIZE) throw new Error(`position ${p} beyond the seed list`);
				arr[p] = p >= errFrom ? 'err'
					: { lead: this.mu.get(r.build.id)! + this.sigma * gauss(p * 7 + (hash(noiseId) % 997)), win: 0, top3: 0, placing: 5, hpEmpty: 0, rushed: 0 };
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

test('STOP: the ladder ends before its next rung and reports what it measured', async t => {
	// Two candidates inside the indifference zone keep climbing toward the cap.
	const mk = () => new Map<string, number>([['inc', 0], ['a', 0.04], ['b', 0.035]]);
	const cs = () => [build('a'), build('b')];
	const full = new FakeEval(mk(), 0.5);
	await banditVsIncumbent(full, { ns: 's', scenarioIdx: 0, incumbent: build('inc'), candidates: cs(), pick: pickLead, cfg });
	let stop = false;
	let rounds = 0;
	const cut = new FakeEval(mk(), 0.5);
	const res = await banditVsIncumbent(cut, {
		ns: 's', scenarioIdx: 0, incumbent: build('inc'), candidates: cs(), pick: pickLead, cfg,
		onRound: () => { rounds++; stop = true; }, stopped: () => stop,
	});
	t.equal(rounds, 1, 'one rung after round 0, then the stop holds');
	t.ok(cut.races < full.races, `fewer races than the full ladder (${cut.races} < ${full.races})`);
	t.equal(res.measured.length, 2, 'both candidates come back measured');
	t.end();
});

test('a candidate whose seeds fail still reaches the cap', async t => {
	// Inside the indifference zone, so it keeps growing. From position 60 on
	// every seed fails, so the paired count stops at 60. Growing from that
	// count asked for the same prefix forever.
	const mu = new Map<string, number>([['inc', 0], ['a', 0.04]]);
	const ev = new FakeEval(mu, 0.5, { errFrom: new Map([['a', 60]]) });
	const res = await banditVsIncumbent(ev, { ns: 's', scenarioIdx: 0, incumbent: build('inc'), candidates: [build('a')], pick: pickLead, cfg, rungCeil: 400 });
	t.equal(res.measured.length, 1, 'it comes back measured');
	t.ok(ev.slots('s', 0, 'a').length >= 400, 'its ladder got to the cap');
	t.end();
});

// ── the race climb's wave ────────────────────────────────────────────────────

const waveOf = (tag: string, mus: number[]) => {
	const mu = new Map<string, number>([[`inc${tag}`, 0]]);
	const cands = mus.map((m, i) => { const b = build(`c${tag}_${i}`); mu.set(b.id, m); return b; });
	return { mu, cands, inc: build(`inc${tag}`) };
};
const target = (g: number, nMax: number) => () => ({ g, nMax });

test('race wave: a wave full of close improvers adopts a confirmed one early', async t => {
	// 20 close improvers among 108 worse moves, the shape of the climb's first
	// wave on the career dump. The §C wave can only end once its leader clears
	// every rival, so it ladders all 20 to the ceiling.
	const mus = Array.from({ length: 128 }, (_, i) => (i % 6 === 0 && i < 120 ? 0.3 + 0.002 * i : -0.5));
	const { mu, cands, inc } = waveOf('a', mus);
	const evZ = new FakeEval(new Map(mu), 1);
	await banditVsIncumbent(evZ, { ns: 's', scenarioIdx: 0, incumbent: inc, candidates: cands, pick: pickLead, cfg, rungMin: 10, rungCeil: 3000, maxAlive: 128, lucbCut: false });
	const evR = new FakeEval(new Map(mu), 1);
	const r = await raceWave(evR, { ns: 's', scenarioIdx: 0, incumbent: inc, candidates: cands, pick: pickLead, cfg, targetOf: target(0.2, 3000) });
	t.ok(r.adopted, 'a move is adopted');
	t.ok(r.adopted && mu.get(r.adopted.build.id)! > 0, `the adopted move improves (true Δ ${r.adopted ? mu.get(r.adopted.build.id) : NaN})`);
	t.ok(evR.races * 5 < evZ.races, `at under a fifth of the races (${evR.races} vs ${evZ.races})`);
	t.equal(r.races, evR.races, 'the result counts its own races');
	t.end();
});

test('race wave: the confirm test runs on positions the move has not raced', async t => {
	const { mu, cands, inc } = waveOf('b', [0.8]);
	const ev = new FakeEval(mu, 1);
	const r = await raceWave(ev, { ns: 's', scenarioIdx: 0, incumbent: inc, candidates: cands, pick: pickLead, cfg, targetOf: target(0.2, 3000) });
	t.ok(r.adopted, 'a clear improver is adopted');
	t.ok(r.adopted!.diff.n >= 50 + CLIMB_CONFIRM_START, `its numbers include the confirm window (n = ${r.adopted!.diff.n})`);
	t.end();
});

test('race wave: a wave with nothing to gain rarely adopts, and stays within nMax', async t => {
	let adopted = 0, races = 0, over = 0;
	const trials = 30;
	for (let k = 0; k < trials; k++) {
		// Half the moves no-gain, half clearly worse: the peak-like wave where
		// testing every move at every rung picks up noise.
		const { mu, cands, inc } = waveOf(`e${k}`, Array.from({ length: 128 }, (_, i) => (i % 2 ? 0 : -0.4)));
		const ev = new FakeEval(mu, 1);
		const r = await raceWave(ev, { ns: 's', scenarioIdx: 0, incumbent: inc, candidates: cands, pick: pickLead, cfg, targetOf: target(0.2, 1500) });
		if (r.adopted) adopted++;
		races += ev.races;
		for (const c of cands) {
			const n = ev.slots('s', 0, c.id).filter(x => x != null).length;
			if (n > 1500 * 2) over++; // ladder cap plus at most one confirm window
		}
	}
	t.ok(adopted <= 2, `no-gain moves adopted in ${adopted} of ${trials} waves`);
	t.equal(over, 0, 'no move raced past nMax plus one confirm window');
	t.comment(`mean races per empty wave ${Math.round(races / trials)}`);
	t.end();
});

test('race wave: moves ruled out under δ_min are resolved, the rest block a certificate', async t => {
	const clear = waveOf('c', Array.from({ length: 16 }, () => -3));
	const r1 = await raceWave(new FakeEval(clear.mu, 0.5), { ns: 's', scenarioIdx: 0, incumbent: clear.inc, candidates: clear.cands, pick: pickLead, cfg, targetOf: target(0.03, 3000) });
	t.equal(r1.adopted, null, 'nothing adopted');
	t.equal(r1.unresolved, 0, 'every move ruled out under δ_min: certificate-grade');
	const near = waveOf('d', Array.from({ length: 16 }, () => 0));
	const r2 = await raceWave(new FakeEval(near.mu, 0.5), { ns: 's', scenarioIdx: 0, incumbent: near.inc, candidates: near.cands, pick: pickLead, cfg, targetOf: target(0.5, 3000) });
	t.ok(r2.unresolved > 0, `no-gain moves set aside under g = 0.5 but not under δ_min stay unresolved (${r2.unresolved})`);
	t.equal(r2.g, 0.5, 'the wave reports its target gain');
	const low = await raceWave(new FakeEval(near.mu, 0.5), { ns: 's', scenarioIdx: 0, incumbent: near.inc, candidates: near.cands, pick: pickLead, cfg, targetOf: target(0.001, 3000) });
	t.equal(low.g, cfg.deltaMinL, 'g is never below δ_min');
	t.end();
});

test('race wave: moves with a spread of 0 do not set the noise', async t => {
	// Ten moves that change nothing (every paired Δ exactly 0) and one real
	// improver that needs more than the start rung. Counted in the median,
	// the ten made σ = 0, nMax fell to 50 and the improver was set aside.
	const { mu, cands, inc } = waveOf('z', [...Array.from({ length: 10 }, () => 0), 0.3]);
	const twin = new Map(cands.slice(0, 10).map(c => [c.id, inc.id]));
	// The search's own targetOf (search.ts) at level 0, without the room cap.
	const targetOf = (sigma: number) => {
		if (!Number.isFinite(sigma)) return { g: cfg.deltaMinL, nMax: cfg.batchCap };
		const g = Math.max(cfg.deltaMinL, (SEQ_ADOPT_Z * sigma) / Math.sqrt(CLIMB_TARGET_SEEDS));
		return { g, nMax: Math.ceil(CLIMB_NMAX_FACTOR * Math.pow((SEQ_ADOPT_Z * sigma) / g, 2)) };
	};
	const r = await raceWave(new FakeEval(mu, 1, { twin }), { ns: 's', scenarioIdx: 0, incumbent: inc, candidates: cands, pick: pickLead, cfg, targetOf });
	t.ok(r.sigma > 1, `σ comes from the move that has a spread (${r.sigma.toFixed(3)})`);
	t.ok(r.nMax > 1000, `so the seed cap is the noise's (${r.nMax})`);
	t.equal(r.adopted?.build.id, cands[10].id, 'the real improver is adopted');
	t.end();
});

test('race wave: a confirm window never runs past the seed list', async t => {
	// A clear improver already raced near the end of the list (an old
	// incumbent keeps every position it was raced on).
	for (const [tag, lastPos, adopts] of [['l1', SEED_LIST_SIZE - 50, true], ['l2', SEED_LIST_SIZE - 1, false]] as const) {
		const { mu, cands, inc } = waveOf(tag, [0.8]);
		const ev = new FakeEval(mu, 1);
		await ev.ensure([{ ns: 's', scenarioIdx: 0, build: cands[0], positions: [...Array.from({ length: 50 }, (_, i) => i), lastPos] }]);
		const r = await raceWave(ev, { ns: 's', scenarioIdx: 0, incumbent: inc, candidates: cands, pick: pickLead, cfg, targetOf: target(0.2, 3000) });
		if (adopts) t.ok(r.adopted, `room for ${SEED_LIST_SIZE - lastPos - 1} unseen positions: confirmed there and adopted`);
		else {
			t.equal(r.adopted, null, 'no unseen position left: not adopted');
			t.equal(r.unresolved, 1, 'and set aside unresolved');
		}
	}
	t.end();
});

test('race wave: a move whose seeds fail still reaches its seed cap', async t => {
	// Every seed from position 60 on is an engine error, so the paired count
	// stops at 60. Growing from that count asked for the same prefix forever.
	const { mu, cands, inc } = waveOf('x', [0.1]);
	const ev = new FakeEval(mu, 1, { errFrom: new Map([[cands[0].id, 60]]) });
	const r = await raceWave(ev, { ns: 's', scenarioIdx: 0, incumbent: inc, candidates: cands, pick: pickLead, cfg, targetOf: target(0.03, 400) });
	t.equal(r.adopted, null, 'nothing adopted');
	t.equal(r.unresolved, 1, 'set aside unresolved at the cap');
	t.ok(ev.slots('s', 0, cands[0].id).length >= 400, 'its ladder got to nMax');
	t.end();
});

test('race wave: STOP ends the wave and counts what was still alive', async t => {
	const { mu, cands, inc } = waveOf('s', Array.from({ length: 8 }, () => 0));
	let calls = 0;
	const r = await raceWave(new FakeEval(mu, 0.5), { ns: 's', scenarioIdx: 0, incumbent: inc, candidates: cands, pick: pickLead, cfg, targetOf: target(0.05, 3000), stopped: () => ++calls > 1 });
	t.ok(r.cut, 'the wave reports the cut');
	t.ok(r.unresolved > 0, 'moves still alive are unresolved');
	t.equal(r.measured.length, 8, 'every raced move comes back measured');
	t.end();
});
