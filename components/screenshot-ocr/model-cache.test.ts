/**
 * Asset cache tests. Cache Storage and the network are both replaced here, so the rules about what is
 * fetched, kept, re-checked and dropped are the only thing under test.
 *
 * Run via: npm run test:ocr
 */
import test from 'tape';
import { defaultSha256, dropStaleCaches, ensureAssets, manifestKey, openAssetCache } from './model-cache';
import type { CacheStorageLike, Manifest, ManifestAsset } from './model-cache';

const hexOf = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const fakeHash = async (bytes: Uint8Array) => hexOf(bytes);

const DET = new Uint8Array([1, 2, 3]);
const REC = new Uint8Array([4, 5, 6, 7]);

function manifest(assets: { dest: string; bytes: Uint8Array }[]): Manifest {
	return { assets: assets.map((a) => ({ dest: a.dest, bytes: a.bytes.length, sha256: hexOf(a.bytes) })) };
}

function fakeStores() {
	const caches = new Map<string, Map<string, Uint8Array>>();
	const stores: CacheStorageLike & { caches: Map<string, Map<string, Uint8Array>> } = {
		keys: async () => [...caches.keys()],
		open: async (name) => {
			let entries = caches.get(name);
			if (!entries) {
				entries = new Map();
				caches.set(name, entries);
			}
			const held = entries;
			return {
				match: async (request) => {
					const hit = held.get(request);
					return hit ? { arrayBuffer: async () => new Uint8Array(hit).buffer as ArrayBuffer } : undefined;
				},
				put: async (request, body) => { held.set(request, body); },
			};
		},
		delete: async (name) => caches.delete(name),
		caches,
	};
	return stores;
}

const ASSETS = [{ dest: 'models/det.onnx', bytes: DET }, { dest: 'models/rec.onnx', bytes: REC }];

test('the cache name follows what the manifest asks for', (t) => {
	const one = manifest(ASSETS);
	t.equal(manifestKey(one), manifestKey(manifest(ASSETS)), 'the same manifest names the same cache');
	t.equal(manifestKey(one), manifestKey(manifest([...ASSETS].reverse())), 'and the order the list is written in does not matter');
	t.notEqual(manifestKey(one), manifestKey({ assets: one.assets.map((a, i) => (i ? { ...a, sha256: 'other' } : a)) }), 'a changed checksum names a different cache');
	t.notEqual(manifestKey(one), manifestKey({ assets: one.assets.map((a, i) => (i ? { ...a, dest: 'models/renamed.onnx' } : a)) }));
	t.match(manifestKey(one), /^[0-9a-f]{16}$/);
	t.end();
});

test('every asset is fetched, checked against the manifest, and kept', async (t) => {
	const stores = fakeStores();
	const cache = await openAssetCache(stores, manifestKey(manifest(ASSETS)), '/app/ocr');
	const wanted: string[] = [];
	const seen: [number, number][] = [];
	const fetched = await ensureAssets(manifest(ASSETS), cache, {
		download: async (a) => { wanted.push(a.dest); return (ASSETS.find((x) => x.dest === a.dest)!.bytes).buffer as ArrayBuffer; },
		sha256: fakeHash,
		onProgress: (done, total) => seen.push([done, total]),
	});
	t.deepEqual(fetched, ['models/det.onnx', 'models/rec.onnx']);
	t.deepEqual(seen, [[3, 7], [7, 7]], 'progress counts bytes, ending at the total');
	t.deepEqual([...(await cache.get('models/rec.onnx'))!], [4, 5, 6, 7], 'the bytes are what came off the wire');
	t.deepEqual([...stores.caches.keys()], ['ocr-' + manifestKey(manifest(ASSETS))], 'one cache per manifest');
	t.end();
});

test('a warm cache fetches nothing', async (t) => {
	const stores = fakeStores();
	const cache = await openAssetCache(stores, 'warm', '/app/ocr');
	const first = await ensureAssets(manifest(ASSETS), cache, { download: downloadOf(ASSETS), sha256: fakeHash });
	const second = await ensureAssets(manifest(ASSETS), cache, { download: downloadOf(ASSETS), sha256: fakeHash });
	t.equal(first.length, 2);
	t.deepEqual(second, [], 'the second pass found everything already in place');
	t.end();
});

test('a stored copy that no longer matches is fetched again', async (t) => {
	const stores = fakeStores();
	const cache = await openAssetCache(stores, 'rotten', '/app/ocr');
	await ensureAssets(manifest(ASSETS), cache, { download: downloadOf(ASSETS), sha256: fakeHash });
	await cache.set('models/rec.onnx', new Uint8Array([4, 5, 6, 99]));
	const fetched = await ensureAssets(manifest(ASSETS), cache, { download: downloadOf(ASSETS), sha256: fakeHash });
	t.deepEqual(fetched, ['models/rec.onnx'], 'only the damaged asset goes back to the network');
	t.deepEqual([...(await cache.get('models/rec.onnx'))!], [4, 5, 6, 7], 'and the replacement is what the manifest asks for');
	t.end();
});

test('a download the manifest does not describe is refused', async (t) => {
	const stores = fakeStores();
	const cache = await openAssetCache(stores, 'bad', '/app/ocr');
	const tooBig = await refused(ensureAssets(manifest(ASSETS), cache, { download: async () => new Uint8Array([9, 9, 9, 9]).buffer as ArrayBuffer, sha256: fakeHash }));
	t.match(tooBig ?? '', /came as 4 bytes, the manifest says 3/, 'the size mismatch is named in the error');
	const wrongSum = await refused(ensureAssets(manifest(ASSETS), cache, { download: async () => DET.buffer as ArrayBuffer, sha256: async () => 'deadbeef' }));
	t.match(wrongSum ?? '', /hashes to deadbeef/, 'and so is a checksum that disagrees');
	t.equal(await cache.get('models/det.onnx'), null, 'nothing half trusted is left in the cache');
	t.end();
});

test('the live cache is the only one left under the prefix', async (t) => {
	const stores = fakeStores();
	for (const name of ['ocr-aaaa', 'ocr-bbbb', 'globalsim-v7']) await stores.open(name);
	const dropped = await dropStaleCaches(stores, 'ocr-bbbb');
	t.deepEqual(dropped, ['ocr-aaaa'], 'only this feature’s old caches go');
	t.deepEqual((await stores.keys()).sort(), ['globalsim-v7', 'ocr-bbbb']);
	t.end();
});

test('the default checksum is sha-256', async (t) => {
	t.equal(await defaultSha256(new Uint8Array([97, 98, 99])), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'the published hash of "abc"');
	t.end();
});

function downloadOf(assets: { dest: string; bytes: Uint8Array }[]) {
	return async (a: ManifestAsset) => assets.find((x) => x.dest === a.dest)!.bytes.buffer as ArrayBuffer;
}

/** The message a promise rejects with, so a refusal can be read rather than just noticed. */
async function refused(promise: Promise<unknown>): Promise<string | null> {
	try {
		await promise;
		return null;
	} catch (e) {
		return (e as Error).message;
	}
}
