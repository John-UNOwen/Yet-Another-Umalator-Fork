/**
 * Transposition-table unit tests: position-indexed slots, filled counting
 * ('err' never counts), LRU eviction with pinned exemptions, and the
 * search/verify namespace separation (§7.1, P3).
 */

import test from 'tape';
import { EvalCache, estimateBytes, nsWithMode, NS_SEARCH, NS_VERIFY } from './cache';
import { SeedValue } from './types';

const v = (lead: number): SeedValue => ({ lead, win: 0, top3: 0, placing: 2, hpEmpty: 0, rushed: 0 });

test('ensure/set/peek: slots grow lazily and stay position-indexed', t => {
	const c = new EvalCache(1 << 20);
	const e = c.ensure(NS_SEARCH, 'sc0', 'idA', 4);
	t.equal(e.values.length, 4, 'pre-sized to 4');
	t.equal(e.values[2], null, 'holes are null');
	c.set(NS_SEARCH, 'sc0', 'idA', 2, v(1.5));
	t.deepEqual(c.peek(NS_SEARCH, 'sc0', 'idA')!.values[2], v(1.5), 'slot 2 keeps the value at its position');
	t.equal(c.peek(NS_SEARCH, 'sc0', 'idA')!.filled, 1, 'filled counts measured slots');
	c.set(NS_SEARCH, 'sc0', 'idA', 3, 'err');
	t.equal(c.peek(NS_SEARCH, 'sc0', 'idA')!.filled, 1, 'err slots never count as measured');
	const grown = c.ensure(NS_SEARCH, 'sc0', 'idA', 10);
	t.equal(grown.values.length, 10, 'grown lazily by later requests');
	t.deepEqual(grown.values[2], v(1.5), 'existing values survive growth');
	return t.end();
});

test('namespaces isolate search from verification (P3)', t => {
	const c = new EvalCache(1 << 20);
	c.set(NS_SEARCH, 'sc0', 'same-id', 0, v(1));
	c.set(NS_VERIFY, 'sc0', 'same-id', 0, v(9));
	t.deepEqual(c.peek(NS_SEARCH, 'sc0', 'same-id')!.values[0], v(1), 'search entry');
	t.deepEqual(c.peek(NS_VERIFY, 'sc0', 'same-id')!.values[0], v(9), 'verify entry separate despite identical key parts');
	t.deepEqual(c.identities(NS_SEARCH, 'sc0'), ['same-id'], 'identities lists one namespace only');
	return t.end();
});

test('evict: LRU order, pinned exemption, byte accounting', t => {
	// Each entry of 8 slots ≈ 128 + key + 8·SLOT_BYTES; the cap fits ~2 of them.
	const c = new EvalCache(estimateBytes('x', 8) * 3);
	c.set(NS_SEARCH, 'x', 'A', 7, v(1)); // insert order A, B, C (8-slot entries)
	c.set(NS_SEARCH, 'x', 'B', 7, v(1));
	c.set(NS_SEARCH, 'x', 'A', 6, v(2)); // touch A → A is now MRU, B is LRU
	c.set(NS_SEARCH, 'x', 'C', 7, v(1));
	t.ok(c.stats().estimatedBytes > c.capBytes, 'over cap before eviction');
	const evicted = c.evict(new Set());
	t.ok(evicted >= 1, `evicted ${evicted} entries`);
	t.ok(c.peek(NS_SEARCH, 'x', 'A'), 'MRU A kept');
	t.ok(!c.peek(NS_SEARCH, 'x', 'B'), 'LRU B evicted first');
	// Pinned exemption: pin the LRU identity via the cache's own key builder.
	// (Three equal entries over a cap that fits two and a half ⇒ exactly one
	// eviction: pinned E is skipped, F goes, G survives under the cap.)
	const entryBytes = estimateBytes(new EvalCache(0).keyFor(NS_SEARCH, 'x', 'E'), 8);
	const c2 = new EvalCache(Math.floor(entryBytes * 2.5));
	c2.set(NS_SEARCH, 'x', 'E', 7, v(1));
	c2.set(NS_SEARCH, 'x', 'F', 7, v(1));
	c2.set(NS_SEARCH, 'x', 'G', 7, v(1));
	t.deepEqual(c2.identities(NS_SEARCH, 'x'), ['E', 'F', 'G'], 'three identities listed (insertion order)');
	c2.evict(new Set([c2.keyFor(NS_SEARCH, 'x', 'E')]));
	t.deepEqual(c2.identities(NS_SEARCH, 'x').sort(), ['E', 'G'], 'pinned LRU E survives, F evicted');
	t.ok(c2.stats().estimatedBytes <= c2.capBytes, 'back under cap after eviction');
	return t.end();
});

test('nsWithMode: the random-stream mode namespaces the transposition table', t => {
	// A seed measured with pairedRandomStreams draws a different value than the
	// retail draw — folding one into the other's statistics would be a lie, so
	// the two modes must never share a cache key.
	t.notEqual(nsWithMode(NS_SEARCH, true), nsWithMode(NS_SEARCH, false), 'paired ≠ retail (search)');
	t.notEqual(nsWithMode(NS_VERIFY, true), nsWithMode(NS_VERIFY, false), 'paired ≠ retail (verify)');
	const c = new EvalCache(1 << 20);
	c.set(nsWithMode(NS_SEARCH, true), 'sc0', 'same-id', 0, v(1));
	t.deepEqual(c.peek(nsWithMode(NS_SEARCH, true), 'sc0', 'same-id')!.values[0], v(1), 'paired slot visible under the paired namespace');
	t.equal(c.peek(nsWithMode(NS_SEARCH, false), 'sc0', 'same-id'), undefined, 'the retail namespace cannot see the paired measurement');
	t.deepEqual(c.identities(nsWithMode(NS_SEARCH, true), 'sc0'), ['same-id'], 'identities lists the paired mode only');
	t.deepEqual(c.identities(nsWithMode(NS_SEARCH, false), 'sc0'), [], 'the retail mode lists nothing');
	return t.end();
});

test('foldActivations: per-seed counts, the zero is the missing id, bytes are accounted (§E)', t => {
	const c = new EvalCache(1 << 20);
	c.set(NS_SEARCH, 'sc0', 'idA', 0, v(1));
	c.set(NS_SEARCH, 'sc0', 'idA', 1, v(2));
	t.equal(c.activationOf(NS_SEARCH, 'sc0', 'idA'), null, 'no counts reported yet → null (the rules stand down)');
	// The caller folds only first-time-filled non-error slots: seed 0 fired s1
	// (count 2), seed 1 measured every skill at zero (empty map).
	c.foldActivations(NS_SEARCH, 'sc0', 'idA', { s1: 2 });
	c.foldActivations(NS_SEARCH, 'sc0', 'idA', {});
	const a = c.activationOf(NS_SEARCH, 'sc0', 'idA')!;
	t.equal(a.seeds, 2, 'seeds = measured seeds folded');
	t.equal(a.counts.s1, 2, 'counts accumulate over seeds');
	t.equal(a.fired.s1, 1, 'fired = seeds the skill fired in, not total activations');
	t.ok(!('s2' in a.counts), 'a never-activated skill has no entry: the zero is the missing id');
	t.equal(Object.getPrototypeOf(a.counts), null, 'prototype-free map: a skill id can never collide with Object.prototype');
	t.equal(c.activationOf(NS_VERIFY, 'sc0', 'idA'), null, 'the verify namespace keeps no activation fold (P3 stays clean)');
	// Byte accounting: the fold grows the entry and evict subtracts it again,
	// so the cap never leaks the activation maps.
	const probe = new EvalCache(1 << 20);
	const c2 = new EvalCache(estimateBytes(probe.keyFor(NS_SEARCH, 'x', 'K'), 2));
	c2.set(NS_SEARCH, 'x', 'K', 1, v(1));
	c2.foldActivations(NS_SEARCH, 'x', 'K', { s1: 1 });
	c2.foldActivations(NS_SEARCH, 'x', 'K', { s1: 1 });
	t.ok(c2.stats().estimatedBytes > c2.capBytes, 'the fold pushed the entry over the cap');
	const evicted = c2.evict(new Set());
	t.equal(evicted, 1, 'the folded entry evicted');
	t.equal(c2.stats().estimatedBytes, 0, 'fold bytes leave with the entry (no cap leak)');
	return t.end();
});
