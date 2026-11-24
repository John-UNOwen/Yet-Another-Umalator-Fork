/**
 * Hint levels shared by a skill's ○ and ◎ versions (hintLinkedIds,
 * withHintLevel): the pair moves together, the gold version, the × debuff and
 * every other skill keep their own level.
 */

// HorseDefTypes reads the build-time define at module scope (via
// skill-chart-utils), and ts-node has no bundler, so set it before any import.
(globalThis as any).CC_GLOBAL = true;

import test from 'tape';
import { calculateSkillCost, hintLinkedIds, withHintLevel } from './skill-chart-utils';

test('○ and ◎ of one skill share a hint level', t => {
	// End Closer Straightaways ◎ 201451, ○ 201452, gold Moonlit Flash 201453.
	t.deepEqual(hintLinkedIds('201452').sort(), ['201451', '201452'], 'the ○ reaches the ◎');
	t.deepEqual(hintLinkedIds('201451').sort(), ['201451', '201452'], 'and the ◎ the ○');
	t.deepEqual(hintLinkedIds('201453'), ['201453'], 'the gold version keeps its own');
	// Funabashi Racecourse ◎ 202211, ○ 202212, × 202213.
	t.deepEqual(hintLinkedIds('202212').sort(), ['202211', '202212'], 'a group with a × debuff links only the circles');
	t.deepEqual(hintLinkedIds('202213'), ['202213'], 'the × keeps its own');
	// End Closer Corners ○ 201462 is a different skill in a different group.
	t.notOk(hintLinkedIds('201452').includes('201462'), 'a similar name in another group stays apart');
	t.end();
});

test('withHintLevel sets the pair and leaves the rest alone', t => {
	const before = new Map([['201461', 2], ['201453', 1]]);
	const after = withHintLevel(before, '201452', 4);
	t.equal(after.get('201452'), 4, 'the skill set');
	t.equal(after.get('201451'), 4, 'its ◎ set too');
	t.equal(after.get('201453'), 1, 'the gold version unchanged');
	t.equal(after.get('201461'), 2, 'another skill unchanged');
	t.notOk(before.has('201452'), 'the input map is not changed');
	const plain = withHintLevel(new Map(), '201453', 3);
	t.deepEqual([...plain.entries()], [['201453', 3]], 'a skill without a partner sets only itself');
	t.end();
});

test('a learned skill costs nothing, and an upgrade costs only the tiers above it', t => {
	// End Closer Straightaways: ○ 201452, ◎ 201451, gold Moonlit Flash 201453.
	const none = new Map<string, number>();
	const gold = calculateSkillCost('201453', none, new Map());
	t.equal(calculateSkillCost('201453', none, new Map([['20145', '201453']])), 0, 'the learned gold costs 0');
	const upgrade = calculateSkillCost('201453', none, new Map([['20145', '201451']]));
	t.ok(upgrade > 0 && upgrade < gold, `over a learned ◎, the gold costs only its own tier (${upgrade} of ${gold})`);
	t.end();
});
