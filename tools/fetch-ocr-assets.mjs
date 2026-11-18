// Downloads the pinned OCR assets into ocr/ and checks each SHA-256 against ocr/MANIFEST.json.
// The binaries stay out of git, and the manifest is committed with the revisions and hashes.
// --write recomputes the manifest after a re-pin. --verify-only is the CI gate that fetches nothing.
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'ocr');
const MANIFEST = join(OUT, 'MANIFEST.json');

const ORT_VERSION = '1.31.1';
const DET_REVISION = '2ba1506c0380b8f0b03dd142459aac66d4421f6c';
const REC_REVISION = '2612ab37152ae0a677521bae4e1e3d4fb4cf7c30';

const HF = 'https://huggingface.co/PaddlePaddle';
const hfFile = (repo, rev, name) => `${HF}/${repo}/resolve/${rev}/${name}`;

// `extract` names a transform applied to the fetched bytes instead of storing them as-is.
// `from` picks a member out of the onnxruntime-web npm tarball, so ort comes from the registry itself.
const ASSETS = [
	{ dest: 'ort/ort.wasm.min.mjs', pkg: `onnxruntime-web@${ORT_VERSION}`, from: 'dist/ort.wasm.min.mjs', license: 'MIT (onnxruntime-web)' },
	{ dest: 'ort/ort-wasm-simd-threaded.mjs', pkg: `onnxruntime-web@${ORT_VERSION}`, from: 'dist/ort-wasm-simd-threaded.mjs', license: 'MIT (onnxruntime-web)' },
	{ dest: 'ort/ort-wasm-simd-threaded.wasm', pkg: `onnxruntime-web@${ORT_VERSION}`, from: 'dist/ort-wasm-simd-threaded.wasm', license: 'MIT (onnxruntime-web)' },
	{ dest: 'licenses/MIT-onnxruntime-web.txt', url: 'https://cdn.jsdelivr.net/gh/microsoft/onnxruntime@v1.31.1/LICENSE', license: 'MIT (onnxruntime-web)' },
	{ dest: 'models/ppocrv6-tiny-det.onnx', url: hfFile('PP-OCRv6_tiny_det_onnx', DET_REVISION, 'inference.onnx'), license: 'Apache-2.0 (PaddleOCR)' },
	{ dest: 'models/ppocrv6-tiny-rec.onnx', url: hfFile('PP-OCRv6_tiny_rec_onnx', REC_REVISION, 'inference.onnx'), license: 'Apache-2.0 (PaddleOCR)' },
	{ dest: 'models/ppocrv6-tiny-rec.dict.txt', url: hfFile('PP-OCRv6_tiny_rec_onnx', REC_REVISION, 'inference.yml'), extract: 'character-dict', license: 'Apache-2.0 (PaddleOCR)' },
	{ dest: 'licenses/Apache-2.0.txt', url: 'https://www.apache.org/licenses/LICENSE-2.0.txt', license: 'Apache-2.0' },
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function fetchUrl(url, label) {
	const res = await fetch(url, { redirect: 'follow' });
	if (!res.ok) throw new Error(`${label}: ${url} returned ${res.status}`);
	return Buffer.from(await res.arrayBuffer());
}

// The registry hands back the tarball plus its own sha512, so the fetch is checked against npm's number.
async function fetchTarball(pkg) {
	const [name, version] = pkg.split('@');
	const meta = await (await fetch(`https://registry.npmjs.org/${name}/${version}`, {
		headers: { Accept: 'application/json' },
	})).json();
	if (!meta?.dist?.tarball) throw new Error(`${pkg}: registry returned no tarball`);
	const tgz = await fetchUrl(meta.dist.tarball, pkg);
	const integrity = /^sha512-(.+)$/.exec(meta.dist.integrity ?? '');
	if (integrity && !createHash('sha512').update(tgz).digest().equals(Buffer.from(integrity[1], 'base64'))) {
		throw new Error(`${pkg}: tarball does not match the registry's sha512`);
	}
	return untar(gunzipSync(tgz));
}

// npm's tarballs are plain ustar with short paths, so a fixed-block walk is enough.
function untar(buf) {
	const files = new Map();
	for (let off = 0; off + 512 <= buf.length; off += 512 + Math.ceil(readSize(buf, off + 124) / 512) * 512) {
		const header = buf.subarray(off, off + 512);
		if (header.every((b) => b === 0)) break;
		const name = cstr(header, 0, 100);
		const prefix = cstr(header, 345, 155);
		const type = header[156] === 0 ? 0x30 : header[156];
		if (type !== 0x30) continue;
		const full = prefix ? `${prefix}/${name}` : name;
		files.set(full.replace(/^package\//, ''), buf.subarray(off + 512, off + 512 + readSize(buf, off + 124)));
	}
	return files;
}

const cstr = (buf, at, max) => buf.subarray(at, at + max).toString('utf8').replace(/\0.*$/, '');
const readSize = (buf, at) => {
	const field = buf.subarray(at, at + 12);
	if (field[0] === 0x80) {
		let n = 0;
		for (const b of field.subarray(1)) n = n * 256 + b;
		return n;
	}
	return parseInt(cstr(buf, at, 12).trim() || '0', 8);
};

// The recognition dictionary is inlined in the model's inference.yml under PostProcess.
// One character per line, in the model's own class order, so the decoder needs no YAML parser at runtime.
function extractCharacterDict(yml) {
	const lines = yml.split(/\r?\n/);
	const at = lines.findIndex((l) => l.trim() === 'character_dict:');
	if (at < 0) throw new Error('inference.yml has no character_dict');
	const indent = lines.slice(at + 1).find((l) => /^\s*-\s/.test(l))?.match(/^(\s*)/)?.[1]?.length;
	if (!indent) throw new Error('character_dict has no entries');
	const chars = [];
	for (const line of lines.slice(at + 1)) {
		if (!line.trim()) continue;
		if (!line.startsWith(`${' '.repeat(indent)}-`)) break;
		// Only the YAML separator space may go. The dictionary's own space entry is U+3000, which trim would eat.
		let value = line.slice(indent + 2).replace(/^ /, '');
		if (value.length > 1 && value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/''/g, "'");
		chars.push(value);
	}
	const wrong = chars.find((c) => c.length !== 1);
	if (wrong !== undefined) throw new Error(`character_dict holds an entry that is not one character: ${JSON.stringify(wrong)}`);
	// The circle markers tell skill variants apart, so a dictionary without them means the extraction went wrong.
	for (const marker of ['○', '◎', '×']) if (!chars.includes(marker)) throw new Error(`extracted dictionary has no ${marker}`);
	return Buffer.from(`${chars.join('\n')}\n`, 'utf8');
}

async function readIfExists(path) {
	try { return await readFile(path); } catch { return null; }
}

async function main() {
	const args = new Set(process.argv.slice(2));
	const write = args.has('--write');
	const verifyOnly = args.has('--verify-only');
	const wanted = new Map();
	const pins = { 'onnxruntime-web': ORT_VERSION, 'PP-OCRv6_tiny_det_onnx': DET_REVISION, 'PP-OCRv6_tiny_rec_onnx': REC_REVISION };

	const tarballs = new Map();
	for (const asset of ASSETS) {
		const target = join(OUT, asset.dest);
		const have = await readIfExists(target);
		if (have && !write) { wanted.set(asset.dest, { asset, bytes: have, cached: true }); continue; }
		if (verifyOnly) throw new Error(`${asset.dest} is missing. Run node tools/fetch-ocr-assets.mjs to fetch it`);
		let bytes;
		if (asset.pkg) {
			if (!tarballs.has(asset.pkg)) tarballs.set(asset.pkg, await fetchTarball(asset.pkg));
			const member = tarballs.get(asset.pkg).get(asset.from);
			if (!member) throw new Error(`${asset.pkg}: no ${asset.from} in the tarball`);
			bytes = Buffer.from(member);
		} else {
			bytes = await fetchUrl(asset.url, asset.dest);
		}
		if (asset.extract === 'character-dict') bytes = extractCharacterDict(bytes.toString('utf8'));
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, bytes);
		wanted.set(asset.dest, { asset, bytes, cached: false });
		console.log(`fetched ${asset.dest} (${bytes.length} bytes)`);
	}

	const manifest = write
		? { schema: 1, pins, assets: ASSETS.map((a) => ({ ...a, sha256: sha256(wanted.get(a.dest).bytes), bytes: wanted.get(a.dest).bytes.length })) }
		: JSON.parse((await readIfExists(MANIFEST))?.toString('utf8') ?? 'null');
	if (!manifest) throw new Error('ocr/MANIFEST.json is missing. Run node tools/fetch-ocr-assets.mjs --write to create it');
	if (write) await writeFile(MANIFEST, `${JSON.stringify(manifest, null, '\t')}\n`, 'utf8');

	const known = new Map(manifest.assets.map((a) => [a.dest, a]));
	let bad = 0;
	for (const asset of ASSETS) {
		const entry = known.get(asset.dest);
		if (!entry) { console.error(`MANIFEST has no entry for ${asset.dest}`); bad++; continue; }
		const bytes = wanted.get(asset.dest).bytes;
		const got = sha256(bytes);
		if (got !== entry.sha256) { console.error(`${asset.dest} SHA-256 mismatch: expected ${entry.sha256}, got ${got}`); bad++; }
	}
	if (bad) throw new Error(`${bad} of ${ASSETS.length} assets failed verification`);
	const fresh = [...wanted.values()].filter((w) => !w.cached).length;
	console.log(`${ASSETS.length} assets verified against ocr/MANIFEST.json${fresh ? ` (${fresh} fetched)` : ''}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
