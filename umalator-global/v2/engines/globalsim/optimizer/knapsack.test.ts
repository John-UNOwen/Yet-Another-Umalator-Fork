/**
 * Multiple-choice knapsack unit tests: DP optimality vs brute force on random
 * small instances, feasibility, locks, and top-K distinctness (§8 Stage C).
 */

import test from 'tape';
import { KnapGroup, mckpSolve, mckpSpreadStarts, mckpTopK, SPREAD_MIN_DIFF_PICKS } from './knapsack';

/** Tiny deterministic PRNG (LCG) — tests must be reproducible. */
function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function bruteBest(groups: KnapGroup[], budget: number): number {
	const pick: number[] = new Array(groups.length).fill(-1);
	let best = 0;
	const walk = (gi: number, cost: number, value: number) => {
		if (gi === groups.length) { if (value > best) best = value; return; }
		if (value + groups.slice(gi).reduce((a, g) => a + Math.max(0, ...g.options.map(o => o.value)), 0) <= best) return;
		walk(gi + 1, cost, value); // none
		for (let i = 0; i < groups[gi].options.length; i++) {
			const o = groups[gi].options[i];
			if (cost + o.cost <= budget) walk(gi + 1, cost + o.cost, value + o.value);
		}
		void pick;
	};
	walk(0, 0, 0);
	return best;
}

test('mckpSolve matches brute force on 40 random instances', t => {
	const rnd = lcg(0xC0FFEE);
	for (let inst = 0; inst < 40; inst++) {
		const nG = 2 + Math.floor(rnd() * 4);
		const groups: KnapGroup[] = [];
		for (let g = 0; g < nG; g++) {
			const nOpt = 1 + Math.floor(rnd() * 3);
			const options = Array.from({ length: nOpt }, (_, i) => ({
				id: `g${g}o${i}`,
				cost: 1 + Math.floor(rnd() * 12),
				value: Math.round(rnd() * 100) / 10,
			}));
			groups.push({ groupId: `g${g}`, options });
		}
		const budget = 5 + Math.floor(rnd() * 30);
		const sol = mckpSolve(groups, budget);
		const best = bruteBest(groups, budget);
		t.ok(sol != null, `inst ${inst}: solution exists`);
		t.ok(Math.abs(sol!.value - best) < 1e-9, `inst ${inst}: DP value ${sol!.value} == brute force ${best}`);
		const cost = sol!.ids.reduce((a, id) => a + groups.flatMap(g => g.options).find(o => o.id === id)!.cost, 0);
		t.ok(cost <= budget && cost === sol!.cost, `inst ${inst}: cost ${cost} ≤ ${budget} and consistent`);
	}
	return t.end();
});

test('mckpSolve: a budget past the cost of everything gives the same answer, Infinity included', t => {
	const rnd = lcg(0xB16B00);
	let same = true;
	for (let inst = 0; inst < 30; inst++) {
		const groups: KnapGroup[] = Array.from({ length: 3 + Math.floor(rnd() * 6) }, (_, g) => ({
			groupId: `g${g}`,
			options: Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, i) => ({
				id: `g${g}o${i}`, cost: 50 + Math.floor(rnd() * 300), value: rnd() - 0.3,
			})),
		}));
		const all = groups.reduce((a, g) => a + Math.max(...g.options.map(o => o.cost)), 0);
		const at = mckpSolve(groups, all)!;
		for (const b of [all + 1, all * 7, 1e7, Infinity]) {
			const s = mckpSolve(groups, b)!;
			same &&= s.ids.join() === at.ids.join() && s.cost === at.cost && s.value === at.value;
		}
		// Under the cap the answer still matches brute force.
		const tight = Math.floor(all / 3);
		same &&= Math.abs(mckpSolve(groups, tight)!.value - bruteBest(groups, tight)) < 1e-9;
	}
	t.ok(same, 'solutions above the cost of every group\'s dearest option match the solution at it');
	t.equal(mckpTopK([{ groupId: 'a', options: [{ id: 'x', cost: 100, value: 1 }] }], Infinity, 3).length, 1, 'top-K on an infinite budget returns');
	t.end();
});

test('mckpSolve respects locks (forced items) and shrinks capacity', t => {
	const groups: KnapGroup[] = [
		{ groupId: 'a', options: [{ id: 'a1', cost: 6, value: 1 }, { id: 'a2', cost: 1, value: 1 }], forcedId: 'a1' },
		{ groupId: 'b', options: [{ id: 'b1', cost: 6, value: 100 }] },
	];
	const sol = mckpSolve(groups, 10);
	t.ok(sol, 'solved');
	t.deepEqual(sol!.ids, ['a1'], 'forced pick kept; unaffordable rival dropped (6+6 > 10)');
	t.equal(sol!.cost, 6, 'cost counts the forced item');
	const infeasible = mckpSolve(groups, 5);
	t.equal(infeasible, null, 'forced item busting the budget ⇒ infeasible');
	return t.end();
});

test('mckpTopK: distinct feasible solutions, first is the optimum', t => {
	const rnd = lcg(424242);
	for (let inst = 0; inst < 20; inst++) {
		const groups: KnapGroup[] = [];
		const nG = 3;
		for (let g = 0; g < nG; g++) {
			groups.push({
				groupId: `g${g}`,
				options: Array.from({ length: 3 }, (_, i) => ({
					id: `g${g}o${i}`, cost: 1 + Math.floor(rnd() * 8), value: Math.round(rnd() * 100) / 10,
				})),
			});
		}
		const budget = 12 + Math.floor(rnd() * 10);
		const top = mckpTopK(groups, budget, 3);
		t.ok(top.length >= 1 && top.length <= 3, `inst ${inst}: 1..3 solutions (got ${top.length})`);
		const keys = top.map(s => s.ids.slice().sort().join(','));
		t.equal(new Set(keys).size, keys.length, `inst ${inst}: solutions distinct`);
		const best = bruteBest(groups, budget);
		t.ok(Math.abs(top[0].value - best) < 1e-9, `inst ${inst}: first == optimum`);
		for (const s of top) {
			const cost = s.ids.reduce((a, id) => a + groups.flatMap(g => g.options).find(o => o.id === id)!.cost, 0);
			t.ok(cost <= budget, `inst ${inst}: every solution within budget`);
		}
	}
	return t.end();
});

// §3.B.3: the K starts must be NEAR-optimal restart points. Before the fix the
// cumulative "forbid every item of each previous solution" loop made restart 2
// avoid all of restart 1's skills (measured: Jaccard overlap 0.00 with the
// optimum's solution and far worse starts); the fix re-solves excluding ONE
// pick at a time with a ≥ 3-picks diversity rule, which measures avg overlap
// 0.71 (pairs up to 0.81) and every start within 4% of the optimum's value.
test('mckpTopK starts overlap heavily and differ by >= 3 picks (§3.B.3)', t => {
	const rnd = lcg(0xBEEF01);
	let full = 0, pairs = 0, sumJac = 0, minJac = 1, minDiff = Infinity, worstRel = 1;
	for (let inst = 0; inst < 12; inst++) {
		// Realistic regime: ~30 skill families of 2–3 tiers, budget ≈ the 15
		// cheapest options × 1.2 — the optimum buys most of the budget, exactly
		// where the old forbidding loop starved restarts 2..K.
		const groups: KnapGroup[] = [];
		const allCost: number[] = [];
		const nG = 30 + Math.floor(rnd() * 5);
		for (let g = 0; g < nG; g++) {
			const options = Array.from({ length: 2 + Math.floor(rnd() * 2) }, (_, i) => {
				const cost = 20 + Math.floor(rnd() * 120);
				allCost.push(cost);
				return { id: `g${g}o${i}`, cost, value: Math.round(rnd() * 1000) / 10 };
			});
			groups.push({ groupId: `g${g}`, options });
		}
		allCost.sort((a, b) => a - b);
		const budget = Math.round(allCost.slice(0, 15).reduce((a, c) => a + c, 0) * 1.2);
		const top = mckpTopK(groups, budget, 4);
		if (top.length < 4) { console.log(`  §3.B.3 inst ${inst}: only ${top.length} starts found`); continue; }
		full++;
		const opt = mckpSolve(groups, budget)!;
		const sets = top.map(s => new Set(s.ids));
		for (let a = 0; a < sets.length; a++) for (let b = a + 1; b < sets.length; b++) {
			let inter = 0, d = 0;
			for (const x of sets[a]) { if (sets[b].has(x)) inter++; else d++; }
			for (const x of sets[b]) if (!sets[a].has(x)) d++;
			const j = inter / (sets[a].size + sets[b].size - inter);
			sumJac += j; pairs++;
			minJac = Math.min(minJac, j);
			minDiff = Math.min(minDiff, d);
		}
		for (const s of top) worstRel = Math.min(worstRel, s.value / opt.value);
	}
	console.log(`  §3.B.3: full=${full}/12 avgJaccard=${(sumJac / pairs).toFixed(3)} minJaccard=${minJac.toFixed(3)} minPicksDiff=${minDiff} worstValue/Opt=${worstRel.toFixed(3)}`);
	t.ok(full >= 10, `full K=4 found on most instances (full=${full}/12)`);
	t.ok(minDiff >= 3, `every pair of starts differs by >= 3 picks (min=${minDiff})`);
	t.ok(sumJac / pairs >= 0.6, `starts overlap heavily (avgJaccard=${(sumJac / pairs).toFixed(3)}, was 0.00 pre-fix)`);
	t.ok(worstRel >= 0.9, `every start is near-optimal (worst value = ${(worstRel * 100).toFixed(1)}% of the optimum, was ~34% pre-fix)`);
	return t.end();
});

// Wider search starts: held SPREAD_MIN_DIFF_PICKS apart, half of them from a
// knapsack on shuffled values. Same realistic regime as the §3.B.3 test.
test('mckpSpreadStarts: optimum first, starts further apart, repeatable', t => {
	const rnd = lcg(0xBEEF01);
	let full = 0, minDiff = Infinity, jacSpread = 0, nSpread = 0, jacTop = 0, nTop = 0, repeat = true, optFirst = true;
	const jaccard = (a: Set<string>, b: Set<string>) => {
		let inter = 0;
		for (const x of a) if (b.has(x)) inter++;
		return inter / (a.size + b.size - inter);
	};
	for (let inst = 0; inst < 12; inst++) {
		const groups: KnapGroup[] = [];
		const allCost: number[] = [];
		const nG = 30 + Math.floor(rnd() * 5);
		for (let g = 0; g < nG; g++) {
			const options = Array.from({ length: 2 + Math.floor(rnd() * 2) }, (_, i) => {
				const cost = 20 + Math.floor(rnd() * 120);
				allCost.push(cost);
				return { id: `g${g}o${i}`, cost, value: Math.round(rnd() * 1000) / 10 };
			});
			groups.push({ groupId: `g${g}`, options });
		}
		allCost.sort((a, b) => a - b);
		const budget = Math.round(allCost.slice(0, 15).reduce((a, c) => a + c, 0) * 1.2);
		const spread = mckpSpreadStarts(groups, budget, 6, lcg(77 + inst));
		const again = mckpSpreadStarts(groups, budget, 6, lcg(77 + inst));
		repeat &&= spread.map(s => s.ids.join(',')).join('|') === again.map(s => s.ids.join(',')).join('|');
		const opt = mckpSolve(groups, budget)!;
		optFirst &&= spread[0]?.ids.join(',') === opt.ids.join(',');
		if (spread.length === 6) full++;
		const sets = spread.map(s => new Set(s.ids));
		for (let a = 0; a < sets.length; a++) for (let b = a + 1; b < sets.length; b++) {
			let d = 0;
			for (const x of sets[a]) if (!sets[b].has(x)) d++;
			for (const x of sets[b]) if (!sets[a].has(x)) d++;
			minDiff = Math.min(minDiff, d);
		}
		const optSet = new Set(opt.ids);
		const top = mckpTopK(groups, budget, 6);
		for (const s of spread.slice(1)) { jacSpread += jaccard(optSet, new Set(s.ids)); nSpread++; }
		for (const s of top.slice(1)) { jacTop += jaccard(optSet, new Set(s.ids)); nTop++; }
	}
	const spreadJ = jacSpread / nSpread, topJ = jacTop / nTop;
	console.log(`  spread: full=${full}/12 minPicksDiff=${minDiff} overlapWithOpt spread=${spreadJ.toFixed(3)} topK=${topJ.toFixed(3)}`);
	t.ok(optFirst, 'the first start is the exact optimum');
	t.ok(repeat, 'the same rng seed gives the same starts');
	t.ok(full >= 10, `six starts found on most instances (full=${full}/12)`);
	t.ok(minDiff >= SPREAD_MIN_DIFF_PICKS, `every pair differs by >= ${SPREAD_MIN_DIFF_PICKS} picks (min=${minDiff})`);
	t.ok(spreadJ < topJ, `starts sit further from the optimum than the default top-K (${spreadJ.toFixed(3)} < ${topJ.toFixed(3)})`);
	t.end();
});
