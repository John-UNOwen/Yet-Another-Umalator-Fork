/**
 * Stage A opening-book units (SKILL-OPTIMIZER-PLAN §8 A): key fingerprinting,
 * best-effort storage round-trip, and the "still affordable with the CURRENT
 * roster" filter that decides which saved builds may seed a new search.
 */
import test from 'tape';
import { bookKey, BookEntry, distanceBand, loadBook, saveBook, selectStarts } from './book';
import { BOOK_STORAGE_KEY } from './config';
import { BuildSpace, OptOption } from './space';

class MemStore {
	private m = new Map<string, string>();
	getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
	setItem(k: string, v: string) { this.m.set(k, v); }
}

const spaceWith = (opts: Array<[string, string, number, boolean?]>, budget: number): BuildSpace => {
	const options = opts.map(([id, groupId, cost, forced]) => ({ id, groupId, cost, forced: !!forced } as OptOption));
	return { byId: new Map(options.map(o => [o.id, o])), options, budget } as unknown as BuildSpace;
};

test('distanceBand buckets distance so near distances share a book (§8 A)', t => {
	t.equal(distanceBand(1000), 'sprint');
	t.equal(distanceBand(1200), 'sprint');   // upper edge inclusive
	t.equal(distanceBand(1600), 'mile');
	t.equal(distanceBand(5000), 'extended');
	t.end();
});

test('bookKey groups by distance band but splits on strategy/preset/ground', t => {
	const base = { courseId: '10810', distance: 1600, strategy: 'senkou', mobPresetId: 'cm8', ground: 1 };
	t.equal(bookKey(base), bookKey({ ...base, distance: 1550 }), 'near distance → same band → same key');
	t.notEqual(bookKey(base), bookKey({ ...base, distance: 2400 }), 'different band → different key');
	t.notEqual(bookKey(base), bookKey({ ...base, strategy: 'oikomi' }), 'strategy splits');
	t.notEqual(bookKey(base), bookKey({ ...base, mobPresetId: 'loh3' }), 'mob preset splits');
	t.notEqual(bookKey(base), bookKey({ ...base, ground: 3 }), 'ground splits');
	t.end();
});

test('loadBook tolerates a missing key, disabled storage and bad JSON', t => {
	t.deepEqual(loadBook(new MemStore()).entries, {}, 'empty store → no entries');
	t.deepEqual(loadBook(undefined as never).entries, {}, 'no localStorage → no entries (no throw)');
	const bad = new MemStore();
	bad.setItem(BOOK_STORAGE_KEY, '{not json');
	t.deepEqual(loadBook(bad).entries, {}, 'malformed JSON → empty (never throws)');
	t.end();
});

test('saveBook → loadBook round-trips, dedupes and honours the cap', t => {
	const s = new MemStore();
	const e = (sel: string[], value: number): BookEntry => ({ selection: [...sel].sort(), value });
	saveBook('k', [e(['a', 'b'], 5)], 5, s);
	saveBook('k', [e(['a', 'b'], 9), e(['c'], 4)], 5, s); // 'a,b' deduped, newest kept first
	const entries = loadBook(s).entries['k'];
	t.equal(entries.length, 2, 'two distinct selections stored');
	t.deepEqual(entries[0].selection, ['a', 'b'], 'newest duplicate kept first');
	t.equal(entries[0].value, 9, 'newest value wins');
	// cap: pushing more than cap distinct collapses to cap, most-recent-first
	saveBook('k', [e(['d'], 1), e(['f'], 2), e(['g'], 3)], 2, s);
	t.equal(loadBook(s).entries['k'].length, 2, 'cap enforced');
	t.deepEqual(loadBook(s).entries['k'].map(x => x.selection.join()), ['d', 'f'], 'cap keeps most-recent');
	t.end();
});

test('selectStarts keeps only legal, affordable prior builds for the current roster (§8 A)', t => {
	// groups g1: a(30) b(20); g2: c(50). budget 100, locked skill L in g0 forced.
	const space = spaceWith([['a', 'g1', 30], ['b', 'g1', 20], ['c', 'g2', 50], ['L', 'g0', 10, true]], 100);
	const s = new MemStore();
	saveBook('k', [
		{ selection: ['a', 'c'] },          // legal + affordable
		{ selection: ['a', 'b'] },          // two from one group → reject
		{ selection: ['a', 'c', 'c2'] },    // c2 not purchasable → still fits (a+c=80) after drop
		{ selection: ['a', 'b', 'c'] },     // over-group AND would be >budget? a+b+c=100 but double g1 → reject
		{ selection: ['L'] },               // forced skill only → empty selection → reject (implicit)
	], 10, s);
	const starts = selectStarts(space, 'k', s);
	const joins = starts.map(x => [...x].sort().join(','));
	t.ok(joins.includes('a,c'), 'affordable one-per-group build accepted');
	t.notOk(joins.some(j => j.split(',').length > 2 && j.includes('a') && j.includes('b')), 'double-group build rejected');
	t.notOk(joins.some(j => j.split(',').reduce((n, id) => n + (space.byId.get(id)?.cost ?? 0), 0) > 100), 'nothing over budget');
	// forced skills are implicit (never stored): a book entry of only 'L' yields nothing
	t.notOk(joins.includes('L'), 'forced-only entry dropped');
	t.ok(starts.every(st => new Set(st.map(id => space.byId.get(id)!.groupId)).size === st.length), 'each start is one-per-group');
	t.end();
});
