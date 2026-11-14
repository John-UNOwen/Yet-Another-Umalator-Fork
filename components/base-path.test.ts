/**
 * resolveBase nil-safety — the icons[id] miss case.
 * Imported/roster outfits can carry an id that has no icons.json entry
 * (storage.ts only checks typeof outfitId === 'string'), so components call
 * resolveBase(undefined). Before the guard that threw a TypeError during
 * render (upstream rendered a broken image); the guard returns non-strings
 * unchanged so `|| fallback` chains work again.
 * Run via the plain ts-node smoke (CC_BASE_PATH unset → BASE_PATH '/uma-tools'):
 *   npx ts-node --transpile-only --compiler-options \
 *     "{\"moduleResolution\":\"node\",\"module\":\"commonjs\"}" components/base-path.test.ts
 */
import test from 'tape';
import { BASE_PATH, resolveBase } from './base-path';

test('resolveBase is nil-safe and preserves the rewrite semantics', (t) => {
	t.equal(BASE_PATH, '/uma-tools', 'default base is byte-identical when CC_BASE_PATH is unset');
	// The regression case: an icons.json miss used to throw here.
	t.equal(resolveBase(undefined as any), undefined, 'undefined passes through (no throw)');
	t.equal(resolveBase(null as any), null, 'null passes through');
	t.equal(resolveBase('' as any), '', 'empty string passes through');
	// Unchanged rewrite semantics under the default base.
	t.equal(resolveBase('/uma-tools/icons/chara/x.png'), '/uma-tools/icons/chara/x.png', 'default base is identity');
	t.equal(resolveBase('/other/path.png'), '/other/path.png', 'non-prefixed path unchanged');
	t.end();
});
