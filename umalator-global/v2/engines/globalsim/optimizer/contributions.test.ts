/** Rules for reading a finished build's per-skill worth out of the run's cache. */
import test from 'tape';
import { contributionsOf, resolvedDiff, ciHalfWidth } from './contributions';

test('one row per skill, in the build order', t => {
	const rows = contributionsOf(['302', '105', '401'], () => ({ lead: null, win: null }));
	t.deepEqual(rows.map(r => r.id), ['302', '105', '401'], 'rows follow the selection order');
	t.ok(rows.every(r => r.lead === null && r.win === null), 'a drop never raced reads null, not zero');
	t.end();
});

test('a measured drop carries mean, interval and seed count', t => {
	const rows = contributionsOf(['105'], () => ({
		lead: { mean: 0.42, sem: 0.1, n: 150, ci95: [0.22, 0.62] },
		win: { mean: 0.02, sem: 0.01, n: 150, ci95: [0.0, 0.04] },
	}));
	t.deepEqual(rows[0].lead, { mean: 0.42, ci95: [0.22, 0.62], seeds: 150 }, 'the lead row');
	t.equal(rows[0].win!.seeds, 150, 'the win row keeps the shared seed count');
	t.end();
});

test('a difference is resolved only when its interval misses zero', t => {
	t.ok(resolvedDiff([0.1, 0.5]), 'clearly positive');
	t.ok(resolvedDiff([-0.5, -0.1]), 'clearly negative');
	t.notOk(resolvedDiff([-0.2, 0.3]), 'interval holds zero');
	t.notOk(resolvedDiff([NaN, NaN]), 'no interval is not resolved');
	t.equal(ciHalfWidth([0.22, 0.62]), 0.2, 'half the interval');
	t.end();
});
