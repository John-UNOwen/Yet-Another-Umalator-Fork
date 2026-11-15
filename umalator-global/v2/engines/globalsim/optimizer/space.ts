/**
 * The purchasable space (SKILL-OPTIMIZER-PLAN §5, §12 space.ts).
 *
 * A build = fixed skills (uniques, learned skills — never bought, never
 * removed) + owned skills (free, always in) + exactly ONE option per skill
 * group (none / lower tier / higher tier / ○/◎ variant), mirroring
 * withSkillSwappedIn's group-replacement semantics and skillGroups' chain
 * order (white → gold, ○ before ◎, purple last).
 *
 * Rules encoded here (§5):
 *  - cost = Σ calculateSkillCost(id, hints, ownedByGroup) — the tier walk
 *    (gold without white pays white+gold) comes from the helper unchanged;
 *  - purple (negative) skills are never offered;
 *  - already-learned skills and anything below an owned tier are not options;
 *  - a gold option only exists if the chain under it is owned, purchasable
 *    (implied by cost) or itself — calculateSkillCost charges the walk, and
 *    the simulated list keeps only the SELECTED skill of the group, so no
 *    prerequisite needs to enter the skill list itself;
 *  - locks are hard (include ⇒ always in, exclude ⇒ removed);
 *  - simulation identity = sorted simulated skill ids; hints change cost
 *    only, never the identity (cache-key purity, §5);
 *  - invariant: no selection over budget (affordable()/assertFeasible()).
 */

import skillmeta from '../../../../../skill_meta.json';
import { calculateSkillCost, isPurpleSkill, skillGroups } from '../../../skill-chart-utils';

const metaOf = skillmeta as Record<string, { groupId?: string }>;

export interface OptOption {
	/** Skill id simulated when this option is picked. */
	id: string;
	groupId: string;
	/** SP cost at the given hints/owned state (tier walk included). */
	cost: number;
	/** Chain position within the group (skillGroups order). */
	tierIndex: number;
	/** True for "must include" locked options (always in every build). */
	forced: boolean;
}

export interface BuildSpace {
	/** groupId → learned skill id (cost baseline for the tier walk). */
	ownedByGroup: Map<string, string>;
	/** Fixed simulated skill ids (owned + uniques + forced), always present. */
	fixedIds: string[];
	/** SP reserved by forced options (budget for search = budget − this). */
	forcedCost: number;
	/** Purchasable options, coverage-filtered, non-purple, deduped, locks applied. */
	options: OptOption[];
	byId: Map<string, OptOption>;
	/** Purchasable options per group (group exclusivity: pick ≤ 1). */
	groups: Map<string, OptOption[]>;
	budget: number;
	warnings: string[];
	/** Non-empty when the space is unusable (e.g. locks alone bust the budget). */
	error?: string;
}

export interface SpaceInput {
	/** Learnable skill ids offered to the player (the UI's multi-select). */
	purchasable: readonly string[];
	/** Learned skills: groupId → id (exactly what calculateSkillCost expects). */
	ownedByGroup: Map<string, string>;
	/** Unique-skill ids and any other always-simulated skills (not bought). */
	fixedIds: readonly string[];
	hints: Map<string, number>;
	budget: number;
	include?: readonly string[];
	exclude?: readonly string[];
	/** GlobalSim coverage gate (D5): skills outside the active table never reach the engine. */
	knownSkillIds?: ReadonlySet<string>;
	/** Free-form skill ids the engine must not see (safety mirror of the chart's filter). */
	isOfferable?: (id: string) => boolean;
}

/** Build the option space. Pure over data (no engine, no DOM). */
export function buildSpace(input: SpaceInput): BuildSpace {
	const warnings: string[] = [];
	const ownedByGroup = new Map(input.ownedByGroup);
	const include = new Set(input.include ?? []);
	const exclude = new Set(input.exclude ?? []);
	const ownedIds = new Set([...ownedByGroup.values()]);

	const fixedIds = [...new Set([...(input.fixedIds ?? []), ...ownedIds])].sort();
	const forcedCosts: number[] = [];
	const options: OptOption[] = [];
	const seen = new Set<string>([...ownedIds, ...fixedIds]);

	for (const rawId of input.purchasable) {
		const id = String(rawId);
		if (seen.has(id)) continue; // learned or fixed twice
		const gid = metaOf[id]?.groupId;
		if (!gid) { warnings.push(`skill ${id}: no groupId in skill_meta (skipped)`); continue; }
		if (isPurpleSkill(id)) continue; // plan §4: purple skills are never offered
		if (input.knownSkillIds && !input.knownSkillIds.has(id)) continue; // coverage gate
		if (input.isOfferable && !input.isOfferable(id)) continue;
		if (exclude.has(id)) continue;
		const chain = skillGroups.get(gid) ?? [id];
		const tierIndex = chain.indexOf(id);
		if (tierIndex < 0) { warnings.push(`skill ${id}: not in its skillGroups chain (skipped)`); continue; }
		const ownedInGroup = ownedByGroup.get(gid);
		if (ownedInGroup) {
			const oi = chain.indexOf(ownedInGroup);
			// Only upgrades above the learned tier can be bought (§5).
			if (oi >= tierIndex) continue;
		}
		const cost = calculateSkillCost(id, input.hints, ownedByGroup);
		if (cost <= 0) { warnings.push(`skill ${id}: computed SP cost ${cost} (skipped)`); continue; }
		seen.add(id);
		options.push({ id, groupId: gid, cost, tierIndex, forced: include.has(id) });
		if (include.has(id)) forcedCosts.push(cost);
	}
	for (const locked of include) {
		if (!seen.has(locked) && !ownedIds.has(locked)) {
			return { ownedByGroup, fixedIds, forcedCost: 0, options: [], byId: new Map(), groups: new Map(), budget: input.budget, warnings, error: `"must include" skill ${locked} is not purchasable` };
		}
	}

	const forcedCost = forcedCosts.reduce((a, b) => a + b, 0);
	if (forcedCost > input.budget) {
		return { ownedByGroup, fixedIds, forcedCost, options: [], byId: new Map(), groups: new Map(), budget: input.budget, warnings, error: `locked skills cost ${forcedCost} SP > budget ${input.budget}` };
	}

	const byId = new Map(options.map(o => [o.id, o]));
	const groups = new Map<string, OptOption[]>();
	for (const o of options) {
		const arr = groups.get(o.groupId);
		if (arr) arr.push(o); else groups.set(o.groupId, [o]);
	}
	return { ownedByGroup, fixedIds, forcedCost, options, byId, groups, budget: input.budget, warnings };
}

/** Expand a selection into the full simulated skill id list (sorted unique):
 *  fixed + one per group (selection wins over any same-group owned id only
 *  when the option is an upgrade — buildSpace guarantees that pairing). */
export function simIds(space: BuildSpace, selection: Iterable<string>): string[] {
	const out = new Set(space.fixedIds);
	for (const id of selection) {
		const opt = space.byId.get(id);
		if (!opt) continue;
		const owned = space.ownedByGroup.get(opt.groupId);
		if (owned) out.delete(owned); // upgrade replaces in the simulated list (withSkillSwappedIn parity)
		out.add(id);
	}
	return [...out].sort();
}

/** Cache/simulation identity key (§5): sorted simulated ids. Hints never appear. */
export function simIdentity(space: BuildSpace, selection: Iterable<string>): string {
	return simIds(space, selection).join(',');
}

/** Total SP cost of a selection (forced options are NOT included — they are
 *  paid once in space.forcedCost; pass `withForced` for the grand total). */
export function costOf(space: BuildSpace, selection: Iterable<string>, withForced = false): number {
	let c = 0;
	for (const id of selection) c += space.byId.get(id)?.cost ?? 0;
	return withForced ? c + space.forcedCost : c;
}

/** Budget invariant (§5): Σ costs incl. forced stays within budget. */
export function affordable(space: BuildSpace, selection: Iterable<string>): boolean {
	return costOf(space, selection, true) <= space.budget;
}

/** Throws with the offending totals when a selection busts the budget — call
 *  it at stage boundaries so an over-budget build can never be simulated. */
export function assertFeasible(space: BuildSpace, selection: Iterable<string>): void {
	const total = costOf(space, selection, true);
	if (total > space.budget) throw new Error(`optimizer: build over budget (${total} > ${space.budget})`);
}

/** Group-exclusivity invariant: at most one option per group. */
export function assertOnePerGroup(space: BuildSpace, selection: Iterable<string>): void {
	const seen = new Set<string>();
	for (const id of selection) {
		const gid = space.byId.get(id)?.groupId ?? id;
		if (seen.has(gid)) throw new Error(`optimizer: two options of group ${gid} in one build`);
		seen.add(gid);
	}
}

/** Every affordable single-option add to a selection (ordered cheap-first). */
export function affordableAdds(space: BuildSpace, selection: Iterable<string>): OptOption[] {
	const sel = new Set(selection);
	const usedGroups = new Set([...sel].map(id => space.byId.get(id)?.groupId));
	const free = space.budget - costOf(space, selection, true);
	return space.options
		.filter(o => !sel.has(o.id) && !usedGroups.has(o.groupId) && o.cost <= free)
		.sort((a, b) => a.cost - b.cost);
}

/** Every forced option (locked-in skills are always part of every build). */
export function forcedOptions(space: BuildSpace): OptOption[] {
	return space.options.filter(o => o.forced);
}
