/**
 * Multiple-choice knapsack unit tests: DP optimality vs brute force on random
 * small instances, feasibility, locks, and top-K distinctness (§8 Stage C).
 */

import test from 'tape';
import { KnapGroup, mckpSolve, mckpTopK } from './knapsack';

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
