/// <reference lib="webworker" />
// The OCR worker holds the two PP-OCR sessions and the 19.7 MB behind them, so the page never touches a
// 3440 px canvas, a second copy of the models, or a 15 MB wasm binary.

import { BASE_PATH } from '../base-path';
import { createPpOcrEngine } from './engine-ppocr';
import { preprocess } from './preprocess';
import { scanScreen } from './scan';
import type { ScanResult } from './scan';
import type { AssetCache, CacheStorageLike, Manifest } from './model-cache';
import { defaultSha256, dropStaleCaches, ensureAssets, manifestKey, openAssetCache } from './model-cache';
import type { OcrEngine, Preprocessed } from './contract';
import type { NameEntry } from './matcher';

const OCR = `${BASE_PATH}/ocr`;

type Stage = 'assets' | 'models' | 'read';
type Reply =
	| { type: 'progress'; stage: Stage; done: number; total: number }
	| { type: 'ready' }
	| { type: 'scanned'; id: number; result: ScanResult; ms: number }
	| { type: 'failed'; id: number | null; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: Reply) => scope.postMessage(m);
const report = (stage: Stage) => (done: number, total: number) => post({ type: 'progress', stage, done, total });

/** The bundler must not try to resolve this: the url is only known once the site is serving it. */
const importRuntime = (url: string): Promise<any> => new Function('u', 'return import(u)')(url) as Promise<any>;

/** Cache Storage keeps a body inside a Response, which is the only shape its put takes. */
const stores: CacheStorageLike = {
	keys: () => caches.keys(),
	open: async (name) => {
		const cache = await caches.open(name);
		return { match: (request) => cache.match(request), put: async (request, body) => cache.put(request, new Response(new Uint8Array(body).buffer)) };
	},
	delete: (name) => caches.delete(name),
};

/** The manifest is read fresh every time: it is small, and it is what decides what is worth downloading. */
async function fetchManifest(): Promise<Manifest> {
	const r = await fetch(`${OCR}/MANIFEST.json`, { cache: 'no-store' });
	if (!r.ok) throw new Error(`MANIFEST.json HTTP ${r.status}`);
	return r.json();
}

async function fetchAsset(dest: string): Promise<ArrayBuffer> {
	const r = await fetch(`${OCR}/${dest}`);
	if (!r.ok) throw new Error(`${dest} HTTP ${r.status}`);
	return r.arrayBuffer();
}

async function hold(cache: AssetCache, dest: string): Promise<Uint8Array> {
	const bytes = await cache.get(dest);
	if (!bytes) throw new Error(`${dest} is not in the cache, which said it was`);
	return bytes;
}

let engine: Promise<OcrEngine> | null = null;
let names: readonly NameEntry[] = [];

/**
 * Everything needed to recognise text: the assets in Cache Storage under the manifest's own fingerprint,
 * and the two sessions built from them. The models are handed to onnxruntime as bytes, so nothing here
 * refetches 19.7 MB after the first scan of the first session.
 */
async function prepare(onNames: readonly NameEntry[]): Promise<void> {
	names = onNames;
	if (engine) return;
	engine = (async () => {
		const manifest = await fetchManifest();
		const key = manifestKey(manifest);
		const cache = await openAssetCache(stores, key, `${OCR}`);
		await dropStaleCaches(stores, 'ocr-' + key);
		const fetched = await ensureAssets(manifest, cache, { download: (a) => fetchAsset(a.dest), sha256: defaultSha256, onProgress: report('assets') });
		post({ type: 'progress', stage: 'models', done: 0, total: 2 });

		const mod: any = await importRuntime(`${OCR}/ort/ort.wasm.min.js`);
		const ort = mod.env ? mod : mod.default;
		// The engine sets wasmPaths, numThreads and proxy itself. Handing it the binary is what keeps the
		// 14.8 MB wasm out of the network path, since Pages serves it with a short max-age.
		ort.env.wasm.wasmBinary = await hold(cache, 'ort/ort-wasm-simd-threaded.wasm');
		const dict = new TextDecoder().decode(await hold(cache, 'models/ppocrv6-tiny-rec.dict.txt')).split('\n').slice(0, -1);
		const built = await createPpOcrEngine({
			loadOrt: async () => ort,
			ortDir: `${OCR}/ort/`,
			detectModel: 'models/ppocrv6-tiny-det.onnx',
			recognizeModel: 'models/ppocrv6-tiny-rec.onnx',
			dictChars: dict,
			fetch: async (id) => (await hold(cache, id)).buffer as ArrayBuffer,
		});
		post({ type: 'progress', stage: 'models', done: 2, total: 2 });
		post({ type: 'ready' });
		if (fetched.length) console.log(`ocr: fetched ${fetched.length} of ${manifest.assets.length} assets`);
		return built;
	})();
	return engine.then(() => undefined);
}

/** A screenshot the user picked, decoded to the RGBA the engine works on. */
async function imageOf(source: ArrayBuffer): Promise<Preprocessed> {
	const bitmap = await createImageBitmap(new Blob([source]));
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	const ctx = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
	ctx.drawImage(bitmap, 0, 0);
	bitmap.close();
	return { width: canvas.width, height: canvas.height, rgba: ctx.getImageData(0, 0, canvas.width, canvas.height).data, scale: 1 };
}

scope.addEventListener('message', async (e: MessageEvent) => {
	const msg = e.data as { type: string; id?: number; source?: ArrayBuffer; names?: NameEntry[] };
	try {
		if (msg.type === 'prepare') {
			await prepare(msg.names ?? []);
		} else if (msg.type === 'scan') {
			const id = msg.id ?? 0;
			if (!engine) await prepare(names);
			const ocr = await engine!;
			const image = preprocess(await imageOf(msg.source!));
			post({ type: 'progress', stage: 'read', done: 0, total: 1 });
			const started = Date.now();
			const result = await scanScreen(ocr, image, names);
			post({ type: 'progress', stage: 'read', done: 1, total: 1 });
			post({ type: 'scanned', id, result, ms: Date.now() - started });
		}
	} catch (err) {
		post({ type: 'failed', id: msg.id ?? null, message: err instanceof Error ? err.message : String(err) });
	}
});
