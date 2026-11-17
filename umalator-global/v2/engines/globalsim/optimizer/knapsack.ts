/**
 * Multiple-choice knapsack (SKILL-OPTIMIZER-PLAN §8 Stage C).
 *
 * Groups = skill groups; each group contributes exactly one item (or the
 * implicit "none" with cost 0 / value 0); weight = SP cost; value = the
 * stage's per-skill value (out-of-context v⁰ in Stage C, in-context v in
 * Stage D re-picks); capacity = SP budget. DP over integer SP — with ≤ ~40
 * groups × ≤ ~4,000 SP the table is trivial (plan §8: "trivial").
 *
 * Top-K restart points (§8): we re-solve the exact DP excluding ONE pick of
 * the best solution at a time and keep the K best distinct starts under a
 * diversity rule (§3.B.3). Forced groups (locks) are pre-committed and shrink
 * the capacity.
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

/** §3.B.3 diversity floor: every kept start differs from all other kept
 *  starts by at least this many picks (near-clones waste a restart slot). */
const TOPK_MIN_DIFF_PICKS = 3;
/** Re-solve budget for the top-K sweep (each re-solve excludes one pick). */
const TOPK_RESOLVE_CAP = 240;

/**
 * Top-K distinct solutions (§8 Stage C, §3.B.3): re-solve once per pick of
 * the best solution excluding ONLY that one pick (plus one deeper round for
 * candidates too close to a kept start), keep the K best distinct results by
 * value, and enforce the diversity rule — each kept start differs from every
 * other kept start by ≥ TOPK_MIN_DIFF_PICKS picks. (The old cumulative
 * "forbid every item of each previous solution" loop made restart 2 avoid all
 * of restart 1's skills: Jaccard overlap 0.00 and far worse starts.)
 * Values are noisy, so K solutions are RESTART POINTS, not rankings.
 */
export function mckpTopK(groups: readonly KnapGroup[], budget: number, k: number, minDiff: number = TOPK_MIN_DIFF_PICKS): KnapSolution[] {
	const first = mckpSolve(groups, budget);
	if (!first) return [];
	const out: KnapSolution[] = [first];
	if (out.length >= k) return out;
	const pairKey = (g: string, id: string) => `${g}\u0000${id}`;
	const key = (s: KnapSolution) => s.ids.join(',');
	const forcedIds = new Set(groups.map(g => g.forcedId).filter((x): x is string => !!x));
	const nodes = (sols: KnapSolution[]) => sols.map(s => ({ sol: s, ids: new Set(s.ids) }));
	const picksDiff = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
		let d = 0;
		for (const x of a) if (!b.has(x)) d++;
		for (const x of b) if (!a.has(x)) d++;
		return d;
	};
	// Levels of single-pick exclusions: the best solutions expand first, so
	// the re-solve cap only runs out on the least promising territory.
	let level = nodes([first]);
	const seen = new Set<string>([key(first)]);
	let reSolvesLeft = TOPK_RESOLVE_CAP;
	// Exclusions are single picks, so the same pick excluded from different
	// nodes is the same DP: memoize it and charge the cap only for new ones
	// (repeats used to spend re-solves re-deriving already-seen solutions).
	const memo = new Map<string, KnapSolution | null>();
	while (out.length < k && level.length && reSolvesLeft > 0) {
		const cands: ReturnType<typeof nodes> = [];
		for (const node of level) {
			for (const [gid, id] of node.sol.selection) {
				if (forcedIds.has(id)) continue;
				const pk = pairKey(gid, id);
				let sol: KnapSolution | null;
				if (memo.has(pk)) sol = memo.get(pk)!;
				else {
					if (reSolvesLeft <= 0) continue;
					reSolvesLeft--;
					sol = mckpSolve(groups, budget, new Set([pk]));
					memo.set(pk, sol);
				}
				if (!sol || !sol.ids.length) continue; // nothing left to start from
				const ck = key(sol);
				if (seen.has(ck)) continue;
				seen.add(ck);
				cands.push({ sol, ids: new Set(sol.ids) });
			}
		}
		cands.sort((a, b) => b.sol.value - a.sol.value || (key(b.sol) < key(a.sol) ? -1 : 1));
		const next: ReturnType<typeof nodes> = [];
		for (const c of cands) {
			if (out.every(s => picksDiff(new Set(s.ids), c.ids) >= minDiff)) {
				out.push(c.sol);
				if (out.length >= k) break;
			} else if (reSolvesLeft > 0) next.push(c); // too close: exclude one of its picks next round
		}
		level = next;
	}
	return out;
}

/** Picks two starts differ by: a skill in one and not the other counts once. */
function picksApart(a: readonly string[], b: readonly string[]): number {
	const sa = new Set(a), sb = new Set(b);
	let d = 0;
	for (const x of sa) if (!sb.has(x)) d++;
	for (const x of sb) if (!sa.has(x)) d++;
	return d;
}

/** Wider search: every start differs from every other by at least this many
 *  picks, about three skills swapped (the default floor is 3). */
export const SPREAD_MIN_DIFF_PICKS = 6;
/** Wider search: noise added to each option's value for the shuffled starts,
 *  in units of the median |value|. At 1 a skill worth a typical amount can
 *  trade places with one worth nothing alone, which is how a skill that only
 *  pays off next to another one gets into a start. */
export const SPREAD_NOISE = 1;
/** Shuffled-start tries per slot before the slot is given up. */
const SPREAD_TRIES_PER_SLOT = 8;

/**
 * Starts for the wider search. Half the slots are the top-K solutions held
 * SPREAD_MIN_DIFF_PICKS apart, the other half re-solve the knapsack with noise
 * on every option's value, so they leave the area around the best additive
 * build. Every start keeps the same distance from all the others. The first
 * start is still the exact optimum. `rng` returns uniforms in [0, 1), so a
 * fixed seed gives the same starts.
 */
export function mckpSpreadStarts(
	groups: readonly KnapGroup[], budget: number, k: number, rng: () => number,
	opts: { minDiff?: number; noise?: number } = {},
): KnapSolution[] {
	const minDiff = opts.minDiff ?? SPREAD_MIN_DIFF_PICKS;
	const out = mckpTopK(groups, budget, Math.max(1, Math.ceil(k / 2)), minDiff);
	if (!out.length) return out;
	const mags = groups.flatMap(g => g.options.map(o => Math.abs(o.value))).filter(v => v > 0).sort((a, b) => a - b);
	const scale = (mags.length ? mags[Math.floor(mags.length / 2)] : 1) * (opts.noise ?? SPREAD_NOISE);
	const gauss = (): number => {
		const u = Math.max(rng(), 1e-12), v = rng();
		return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
	};
	const valueOf = new Map(groups.flatMap(g => g.options.map(o => [`${g.groupId}\u0000${o.id}`, o.value] as const)));
	for (let tries = 0; out.length < k && tries < k * SPREAD_TRIES_PER_SLOT; tries++) {
		const noisy = groups.map(g => ({ ...g, options: g.options.map(o => ({ ...o, value: o.value + scale * gauss() })) }));
		const sol = mckpSolve(noisy, budget);
		if (!sol || !sol.ids.length) continue;
		if (!out.every(s => picksApart(s.ids, sol.ids) >= minDiff)) continue;
		let value = 0;
		for (const [gid, id] of sol.selection) value += valueOf.get(`${gid}\u0000${id}`) ?? 0;
		out.push({ ...sol, value });
	}
	return out;
}
