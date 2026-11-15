/**
 * Multiple-choice knapsack (SKILL-OPTIMIZER-PLAN §8 Stage C).
 *
 * Groups = skill groups; each group contributes exactly one item (or the
 * implicit "none" with cost 0 / value 0); weight = SP cost; value = the
 * stage's per-skill value (out-of-context v⁰ in Stage C, in-context v in
 * Stage D re-picks); capacity = SP budget. DP over integer SP — with ≤ ~40
 * groups × ≤ ~4,000 SP the table is trivial (plan §8: "trivial").
 *
 * Top-K restart points (§8): the plan allows a DP top-K backtrack "or
 * re-solving with each previous solution's skills excluded in turn" — we
 * implement the latter (exact per-run DP, distinct-by-construction solutions,
 * K ≤ 5). Forced groups (locks) are pre-committed and shrink the capacity.
 */

export interface KnapItem {
	/** Selection id (skill id) chosen when this item wins. */
	id: string;
	cost: number;
	value: number;
}

export interface KnapGroup {
	groupId: string;
	options: KnapItem[];
	/** Pre-committed lock: only this id may be chosen. */
	forcedId?: string;
}

export interface KnapSolution {
	/** groupId → chosen item id (groups with "none" absent). */
	selection: Map<string, string>;
	ids: string[];
	value: number;
	cost: number;
}

/**
 * Solve one MCKP exactly. `forbidden` blocks (groupId, itemId) pairs — used
 * by the top-K loop to force distinct solutions. Returns the best solution
 * (possibly empty when everything is forbidden/over budget) or null when even
 * the forced items bust the budget.
 */
export function mckpSolve(groups: readonly KnapGroup[], budget: number, forbidden?: ReadonlySet<string>): KnapSolution | null {
	const pairKey = (g: string, id: string) => `${g}\u0000${id}`;
	// Pre-commit forced items and drop forbidden/forced-away options.
	const usable: KnapGroup[] = [];
	let forcedCost = 0;
	const forcedPick = new Map<string, string>();
	for (const g of groups) {
		if (g.forcedId) {
			const f = g.options.find(o => o.id === g.forcedId);
			if (!f) return null; // forced option vanished from the space — infeasible
			forcedCost += f.cost;
			forcedPick.set(g.groupId, f.id);
			continue;
		}
		const opts = g.options.filter(o => o.cost <= budget && !forbidden?.has(pairKey(g.groupId, o.id)));
		if (opts.length) usable.push({ groupId: g.groupId, options: opts });
	}
	if (forcedCost > budget) return null;
	const cap = budget - forcedCost;
	const nG = usable.length;
	if (nG === 0) return { selection: forcedPick, ids: [...forcedPick.values()], value: 0, cost: forcedCost };

	// DP table: dp[g][b] = best value using groups 0..g−1 with capacity b.
	// Float values (noisy estimates) — compare with normal ordering.
	const NEG = -Infinity;
	let prev = new Float64Array(cap + 1).fill(0);
	const choice: Int16Array[] = []; // choice[g][b] = chosen option index (−1 = none)
	for (let g = 0; g < nG; g++) {
		const opts = usable[g].options;
		const cur = new Float64Array(cap + 1).fill(NEG);
		const ch = new Int16Array(cap + 1).fill(-1);
		for (let b = 0; b <= cap; b++) {
			// "none" option
			let best = prev[b];
			let bestIdx = -1;
			for (let i = 0; i < opts.length; i++) {
				const o = opts[i];
				if (o.cost > b) continue;
				const v = prev[b - o.cost] + o.value;
				if (v > best) { best = v; bestIdx = i; }
			}
			cur[b] = best;
			ch[b] = bestIdx;
		}
		choice.push(ch);
		prev = cur;
	}

	// Backtrack.
	const selection = new Map(forcedPick);
	let b = cap;
	let value = 0;
	for (let g = nG - 1; g >= 0; g--) {
		const idx = choice[g][b];
		if (idx >= 0) {
			const o = usable[g].options[idx];
			selection.set(usable[g].groupId, o.id);
			value += o.value;
			b -= o.cost;
		}
	}
	let cost = forcedCost + (cap - b);
	return { selection, ids: [...selection.values()].sort(), value, cost };
}

/**
 * Top-K distinct solutions (§8 Stage C): re-solve forbidding each previous
 * solution's (group, option) pairs — the plan's sanctioned simple scheme.
 * Values are noisy, so K solutions are RESTART POINTS, not rankings.
 */
export function mckpTopK(groups: readonly KnapGroup[], budget: number, k: number): KnapSolution[] {
	const out: KnapSolution[] = [];
	const forbidden = new Set<string>();
	for (let round = 0; round < k; round++) {
		const sol = mckpSolve(groups, budget, forbidden);
		if (!sol || sol.ids.length === 0 && round > 0) break;
		// Dedupe by id list (identical re-solutions can only repeat when a
		// group had a single option — forbidden then blocks nothing new).
		const key = sol.ids.join(',');
		if (out.some(s => s.ids.join(',') === key)) break;
		out.push(sol);
		for (const [gid, id] of sol.selection) forbidden.add(`${gid}\u0000${id}`);
	}
	return out;
}
