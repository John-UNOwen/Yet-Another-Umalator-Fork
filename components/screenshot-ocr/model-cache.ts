// The OCR assets are 19.7 MB, and Pages serves them with a short max-age, so they live in Cache Storage
// under a name built from the manifest's own checksums: one changed asset names a different cache, and
// the old one is removed once the new one is filled.

export interface ManifestAsset {
	dest: string;
	sha256: string;
	bytes: number;
}

export interface Manifest {
	assets: readonly ManifestAsset[];
}

/** Bytes for one asset, from wherever they are kept. */
export interface AssetCache {
	get(dest: string): Promise<Uint8Array | null>;
	set(dest: string, bytes: Uint8Array): Promise<void>;
}

/** Cache Storage, narrowed to the three calls this needs so a test can hand in a plain object. */
export interface CacheStorageLike {
	keys(): Promise<string[]>;
	open(name: string): Promise<CacheLike>;
	delete(name: string): Promise<boolean>;
}

export interface CacheLike {
	match(request: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | undefined>;
	put(request: string, body: Uint8Array): Promise<void>;
}

function fnv1a(text: string, seed: number): string {
	let h = seed >>> 0;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}

/**
 * A fingerprint of what the manifest asks for. Two seeds make a 64 bit name, which is far past any
 * realistic collision, and reading the manifest is the only thing that has to change to refetch.
 */
export function manifestKey(manifest: Manifest): string {
	const text = manifest.assets.map((a) => `${a.dest}:${a.sha256}`).sort().join('\n');
	return fnv1a(text, 0x811c9dc5) + fnv1a(text, 0x84222325);
}

/** The per-asset cache for one manifest, addressed by the same urls the site serves the assets at. */
export async function openAssetCache(stores: CacheStorageLike, key: string, base: string, prefix = 'ocr-'): Promise<AssetCache> {
	const cache = await stores.open(prefix + key);
	return {
		async get(dest) {
			const found = await cache.match(`${base}/${dest}`);
			return found ? new Uint8Array(await found.arrayBuffer()) : null;
		},
		async set(dest, bytes) {
			await cache.put(`${base}/${dest}`, bytes);
		},
	};
}

/** The caches this feature filled earlier, so they do not pile up under the same prefix. */
export async function dropStaleCaches(stores: CacheStorageLike, keep: string, prefix = 'ocr-'): Promise<string[]> {
	const stale = (await stores.keys()).filter((name) => name.startsWith(prefix) && name !== keep);
	for (const name of stale) await stores.delete(name);
	return stale;
}

export interface EnsureOptions {
	/** Fetches what the cache does not hold. */
	download: (asset: ManifestAsset) => Promise<ArrayBuffer>;
	/** Hashes bytes for the check against the manifest. */
	sha256?: (bytes: Uint8Array) => Promise<string>;
	/** Bytes fetched or verified so far, and the total to reach. */
	onProgress?: (done: number, total: number) => void;
}

export async function defaultSha256(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Every asset the manifest lists, in the cache and matching the manifest by the end of it. A stored copy
 * is re-checked against its checksum rather than trusted, because a half written entry would otherwise
 * serve a broken model forever.
 */
export async function ensureAssets(manifest: Manifest, cache: AssetCache, options: EnsureOptions): Promise<string[]> {
	const hash = options.sha256 ?? defaultSha256;
	const total = manifest.assets.reduce((sum, a) => sum + a.bytes, 0);
	const report = (done: number) => options.onProgress?.(Math.min(done, total), total);
	const fetched: string[] = [];
	let done = 0;
	for (const asset of manifest.assets) {
		const held = await cache.get(asset.dest);
		if (held) {
			if (held.length !== asset.bytes || await hash(held) !== asset.sha256) await cache.set(asset.dest, new Uint8Array(0));
			else {
				done += held.length;
				report(done);
				continue;
			}
		}
		const bytes = new Uint8Array(await options.download(asset));
		if (bytes.length !== asset.bytes) throw new Error(`${asset.dest} came as ${bytes.length} bytes, the manifest says ${asset.bytes}`);
		const sum = await hash(bytes);
		if (sum !== asset.sha256) throw new Error(`${asset.dest} hashes to ${sum}, the manifest says ${asset.sha256}`);
		await cache.set(asset.dest, bytes);
		fetched.push(asset.dest);
		done += bytes.length;
		report(done);
	}
	return fetched;
}
