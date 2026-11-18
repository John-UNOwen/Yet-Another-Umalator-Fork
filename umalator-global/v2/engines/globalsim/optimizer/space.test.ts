/**
 * Space model unit tests (SKILL-OPTIMIZER-PLAN §5) — real skill_meta /
 * skillGroups data, no engine: group exclusivity, tier-walk costs, hint
 * discounts (cost only, never identity), owned/lower-tier filtering, purple
 * exclusion, locks, and the budget invariant.
 */

import test from 'tape';
import path from 'path';
import { isPurpleSkill, skillGroups } from '../../../skill-chart-utils';
import {
	affordable, affordableAdds, assertFeasible, buildSpace, costOf, simIdentity, simIds,
} from './space';

const repoRoot = path.resolve(__dirname, '../../../../');
const skillmeta = require(path.join(repoRoot, 'skill_meta.json')) as Record<string, { groupId?: string; baseCost?: number }>;

/** A multi-tier group without purples (for chain assertions). */
function pickChain(): { gid: string; low: string; high: string } {
	for (const [gid, ids] of skillGroups) {
		const usable = ids.filter(id => !isPurpleSkill(id) && (skillmeta[id]?.baseCost ?? 0) > 0);
		if (usable.length >= 2) return { gid, low: usable[0], high: usable[usable.length - 1] };
	}
	throw new Error('no multi-tier group found');
}

/** Two options from two DIFFERENT groups (for exclusivity tests). */
function pickTwoGroups(): { a: string; b: string } {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const [, ids] of skillGroups) {
		const usable = ids.filter(id => !isPurpleSkill(id) && (skillmeta[id]?.baseCost ?? 0) > 0);
		if (!usable.length) continue;
		const gid = skillmeta[usable[0]]?.groupId;
		if (!gid || seen.has(gid)) continue;
		seen.add(gid);
		out.push(usable[0]);
		if (out.length === 2) break;
	}
	return { a: out[0], b: out[1] };
}

test('buildSpace: tier chain, owned filtering, upgrade-only options', t => {
	const { gid, low, high } = pickChain();
	// Nothing owned: both tiers purchasable, chain cost low < high.
	const space = buildSpace({
		purchasable: [low, high], ownedByGroup: new Map(), fixedIds: [], hints: new Map(), budget: 10000,
	});
	t.equal(space.error, undefined, 'space built');
	t.deepEqual(space.options.map(o => o.id).sort(), [low, high].sort(), 'both tiers offered when nothing is owned');
	const cLow = space.byId.get(low)!.cost;
	const cHigh = space.byId.get(high)!.cost;
	t.ok(cLow > 0 && cHigh > cLow, `tier walk: cost(low)=${cLow} < cost(high)=${cHigh}`);

	// Low learned: only the upgrade remains an option.
	const owned = new Map([[gid, low]]);
	const space2 = buildSpace({
		purchasable: [low, high], ownedByGroup: owned, fixedIds: [low], hints: new Map(), budget: 10000,
	});
	t.deepEqual(space2.options.map(o => o.id), [high], 'owned tier itself and anything below it are not options');
	t.ok(space2.fixedIds.includes(low), 'learned skill is fixed (always simulated)');
	return t.end();
});

test('buildSpace: hints change cost only, never the simulation identity', t => {
	const { gid, high } = pickChain();
	const base = { purchasable: [high], ownedByGroup: new Map<string, string>(), fixedIds: [], budget: 10000 };
	const noHints = buildSpace({ ...base, hints: new Map() });
	const hinted = buildSpace({ ...base, hints: new Map([[high, 5]]) });
	const costNo = noHints.byId.get(high)!.cost;
	const costYes = hinted.byId.get(high)!.cost;
	t.ok(costYes < costNo, `hint 5 reduces cost (${costNo} → ${costYes})`);
	t.equal(simIds(noHints, [high]).join(','), simIds(hinted, [high]).join(','), 'identity ignores hints');
	void gid;
	return t.end();
});

test('buildSpace: purple skills never offered; unknown/coverage-filtered ids dropped', t => {
	let purple: string | undefined;
	for (const id of Object.keys(skillmeta)) if (isPurpleSkill(id) && skillmeta[id]?.groupId) { purple = id; break; }
	t.ok(purple, 'a purple skill exists in the data');
	const space = buildSpace({
		purchasable: [purple!, 'not_a_skill_id'], ownedByGroup: new Map(), fixedIds: [], hints: new Map(), budget: 10000,
	});
	t.equal(space.options.length, 0, 'purple and unknown ids yield no options');
	const cov = buildSpace({
		purchasable: [pickTwoGroups().a], ownedByGroup: new Map(), fixedIds: [], hints: new Map(), budget: 10000,
		knownSkillIds: new Set(), // coverage gate closed
	});
	t.equal(cov.options.length, 0, 'coverage gate drops skills outside the table');
	return t.end();
});

test('locks: include reserves budget and forces presence; exclude removes; infeasible errors', t => {
	const { a, b } = pickTwoGroups();
	const withLock = buildSpace({
		purchasable: [a, b], ownedByGroup: new Map(), fixedIds: [], hints: new Map(), budget: 10000, include: [a],
	});
	t.ok(withLock.byId.get(a)!.forced, 'locked option marked forced');
	t.equal(withLock.forcedCost, withLock.byId.get(a)!.cost, 'forced cost reserved');
	// A shake-up draws its refills from affordableAdds. A locked skill offered
	// there was charged twice (forcedCost and again as an add).
	t.deepEqual(affordableAdds(withLock, []).map(o => o.id), [b], 'affordableAdds never offers a locked skill');
	const excl = buildSpace({
		purchasable: [a, b], ownedByGroup: new Map(), fixedIds: [], hints: new Map(), budget: 10000, exclude: [b],
	});
	t.notOk(excl.byId.get(b), 'excluded option removed');
	const bust = buildSpace({
		purchasable: [a, b], ownedByGroup: new Map(), fixedIds: [], hints: new Map(), budget: 0, include: [a],
	});
	t.ok(bust.error, `locked skills busting the budget error out (${bust.error})`);
	return t.end();
});

test('locks: locked skills are SIMULATED (fixedIds), lock their whole group', t => {
	const { gid, low, high } = pickChain();

	// Locking the lower tier: it must be in EVERY simulated build, and the
	// sibling tier (which would replace it in the group) is not offered.
	const lockLow = buildSpace({
		purchasable: [low, high], ownedByGroup: new Map(), fixedIds: [], hints: new Map(), budget: 10000, include: [low],
	});
	t.equal(lockLow.error, undefined, 'space built');
	t.ok(lockLow.fixedIds.includes(low), 'locked skill is in fixedIds (always simulated)');
	t.ok(simIds(lockLow, []).includes(low), 'locked skill is in the simulated list of the EMPTY selection');
	t.notOk(lockLow.byId.get(high), 'sibling tier of a locked group is dropped from the search');
	t.equal(lockLow.forcedCost, lockLow.byId.get(low)!.cost, 'lock cost still reserved exactly once');

	// Locking the upgrade over a learned skill: the lock REPLACES the learned
	// id in the simulated list (withSkillSwappedIn parity), never both.
	const owned = new Map([[gid, low]]);
	const lockUpgrade = buildSpace({
		purchasable: [low, high], ownedByGroup: owned, fixedIds: [low], hints: new Map(), budget: 10000, include: [high],
	});
	t.equal(lockUpgrade.error, undefined, 'upgrade lock accepted');
	t.ok(lockUpgrade.fixedIds.includes(high), 'locked upgrade is fixed (always simulated)');
	t.notOk(lockUpgrade.fixedIds.includes(low), 'learned id replaced by the lock leaves fixedIds');
	const simList = simIds(lockUpgrade, []);
	t.ok(simList.includes(high) && !simList.includes(low), 'simulated list carries the lock, not the replaced tier');

	// Two locks in one group contradict each other.
	const clash = buildSpace({
		purchasable: [low, high], ownedByGroup: new Map(), fixedIds: [], hints: new Map(), budget: 10000, include: [low, high],
	});
	t.ok(clash.error, `conflicting locks error out (${clash.error})`);

	// Locking an ALREADY-LEARNED skill (not an option — the purchasable loop skips
	// learned ids): its lock is HARD too. The purchasable sibling upgrade, which
	// would REPLACE the locked id in the simulated list (simIds upgrade-replace),
	// must be dropped so the locked skill is present in EVERY build.
	const lockLearned = buildSpace({
		purchasable: [low, high], ownedByGroup: owned, fixedIds: [low], hints: new Map(), budget: 10000, include: [low],
	});
	t.equal(lockLearned.error, undefined, 'learned-skill lock accepted');
	t.notOk(lockLearned.byId.get(high), 'purchasable upgrade of a locked learned group is dropped');
	t.ok(lockLearned.fixedIds.includes(low), 'locked learned skill stays fixed (always simulated)');
	t.equal(lockLearned.forcedCost, 0, 'a learned lock costs nothing (skill already owned)');
	t.ok(simIds(lockLearned, []).includes(low), 'locked learned skill in the empty-selection build');
	t.ok(simIds(lockLearned, [high]).includes(low), 'locked learned skill survives even when the upgrade id is passed');

	// A learned lock and locking that group's upgrade contradict each other.
	const learnedVsUpgrade = buildSpace({
		purchasable: [low, high], ownedByGroup: owned, fixedIds: [low], hints: new Map(), budget: 10000, include: [low, high],
	});
	t.ok(learnedVsUpgrade.error, `learned lock vs its upgrade lock conflicts (${learnedVsUpgrade.error})`);
	return t.end();
});

test('identity / cost / feasibility invariants', t => {
	const { a, b } = pickTwoGroups();
	const space = buildSpace({ purchasable: [a, b], ownedByGroup: new Map(), fixedIds: [], hints: new Map(), budget: 10000 });
	const idAB = simIds(space, [a, b]).join(',');
	t.equal(idAB, simIds(space, [b, a]).join(','), 'identity is order-independent');
	t.equal(simIdentity(space, [a]), simIds(space, [a]).join(','), 'simIdentity == simIds.join');
	t.ok(idAB.includes(a) && idAB.includes(b), 'selection appears in simulated ids');
	t.equal(costOf(space, [a, b], true), space.byId.get(a)!.cost + space.byId.get(b)!.cost, 'cost is the sum of options');
	t.ok(affordable(space, [a, b]), 'sum within the (large) budget');
	const over = costOf(space, [a, b], true);
	const tight = { ...space, budget: over - 1 }; // exactly one SP short
	t.throws(() => assertFeasible(tight, [a, b]), /over budget/, 'assertFeasible throws when over budget');
	t.ok(affordable(tight, [a]), 'tight budget still admits the single affordable option');
	const adds = affordableAdds(tight, []);
	t.ok(adds.every(o => o.cost <= tight.budget), 'affordableAdds lists only what fits');
	return t.end();
});
