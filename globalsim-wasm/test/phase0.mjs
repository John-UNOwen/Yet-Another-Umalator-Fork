// Phase 0 acceptance harness: WebAssembly GlobalSim vs native GlobalSim.
//
// Runs the pinned examples/v77-race.jsonl profile through the wasm build and
// against two native references on the same request, across N seeds and three
// courses:
//   A) wasm PreparedRace.run vs native_ref (same public prepared API) —
//      byte-for-byte identical JSON.
//   B) wasm output with the omitFrames keys removed vs the native stdin
//      worker with "omitFrames": true — the frames-less contract.
// Records ms/race for wasm and native on every course, and wasm raw+gzip size.
//
// Usage (from any cwd): node globalsim-wasm/test/phase0.mjs [--seeds N]
// Exits non-zero on the first byte mismatch or error.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const repo = root; // uma-tools repo root
const sim = path.join(repo, 'vendor', 'GlobalSim');
const pkgDir = path.join(root, 'globalsim-wasm', 'pkg');
const outDir = path.join(root, 'globalsim-wasm', 'test', 'out');
// Rust emits no .exe outside Windows — CI (ubuntu) builds plain binaries.
const EXE = process.platform === 'win32' ? '.exe' : '';
const nativeRef = path.join(root, 'globalsim-wasm', 'target', 'release', 'examples', `native_ref${EXE}`);
const worker = path.join(sim, 'target', 'release', `race_engine_rs_v2${EXE}`);

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const seedCount = Number(arg('seeds', '200'));
const courses = arg('courses', '10504,10606,10207').split(',').map(Number);
const omitStrip = ['frames', 'finishFrames', 'rawFrameCount', 'framesDownsampled', 'gateFrameNeeded'];

fs.mkdirSync(outDir, { recursive: true });
const write = (name, text) => fs.writeFileSync(path.join(outDir, name), text, 'utf8');

const { default: init, register_geometry, PreparedRace } =
  await import(pathToFileURL(path.join(pkgDir, 'globalsim_wasm.js')).href);
const wasmBytes = fs.readFileSync(path.join(pkgDir, 'globalsim_wasm_bg.wasm'));
await init(wasmBytes);
console.log(`wasm instantiated: ${wasmBytes.length} bytes raw, ${zlib.gzipSync(wasmBytes, { level: 9 }).length} gzipped`);

const baseRequest = JSON.parse(fs.readFileSync(path.join(sim, 'examples', 'v77-race.jsonl'), 'utf8').split('\n')[0]);
const seeds = Array.from({ length: seedCount }, (_, i) => 1000000 + i);

function jsonLines(text) {
  const lines = text.split('\n').filter((l) => l.length > 0);
  if (/\r/.test(text)) throw new Error('native output contains CR — refusing to compare line endings');
  return lines;
}

// Canonicalize a reply for the frames-less comparison: both sides go through
// the same parse/serialize, so only engine float/format differences are lost.
function canonical(line, dropOmit) {
  const value = JSON.parse(line);
  if (dropOmit) for (const key of omitStrip) delete value[key];
  return JSON.stringify(value);
}

function runNativeRef(requestFile, geometryFile, seedList) {
  const r = spawnSync(nativeRef, [requestFile, geometryFile], {
    input: seedList.join('\n') + '\n', maxBuffer: 4 * 1024 * 1024 * 1024, encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`native_ref failed: ${r.stderr?.slice(0, 500)}`);
  return r.stdout;
}

function runWorkerOmit(request, seedList) {
  const request1 = { ...request, seeds: seedList, threads: 4, omitFrames: true };
  const r = spawnSync(worker, [], {
    input: JSON.stringify(request1) + '\n', maxBuffer: 4 * 1024 * 1024 * 1024, encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`worker failed: ${r.stderr?.slice(0, 500)}`);
  return r.stdout;
}

const report = { seeds: seedCount, wasmBytes: { raw: wasmBytes.length, gzip: zlib.gzipSync(wasmBytes, { level: 9 }).length }, courses: [] };
let failures = 0;

for (const courseId of courses) {
  const request = { ...baseRequest, courseId };
  const requestFile = path.join(outDir, `request-${courseId}.json`);
  write(path.basename(requestFile), JSON.stringify(request));
  const geometryFile = path.join(sim, 'data', 'course_geometry', `${courseId}.json`);
  register_geometry(courseId, fs.readFileSync(geometryFile, 'utf8'));

  // wasm: prepare once, run every seed (this is the production worker shape).
  const t0 = performance.now();
  const race = new PreparedRace(JSON.stringify(request));
  const prepareMs = performance.now() - t0;
  const wasmReplies = [];
  const wasmTimes = [];
  for (const seed of seeds) {
    const s = performance.now();
    const reply = race.run(seed);
    wasmTimes.push(performance.now() - s);
    if (reply.startsWith('{"error"')) throw new Error(`wasm error on seed ${seed}: ${reply.slice(0, 200)}`);
    wasmReplies.push(reply);
  }
  race.free();
  const wasmTotal = wasmTimes.reduce((a, b) => a + b, 0);

  // A) native_ref parity (same prepared API, native codegen).
  const nativeOut = runNativeRef(requestFile, geometryFile, seeds);
  const nativeLines = jsonLines(nativeOut);
  write(`wasm-${courseId}.jsonl`, wasmReplies.join('\n') + '\n');
  write(`native-${courseId}.jsonl`, nativeOut);
  let mismatch = null;
  if (nativeLines.length !== wasmReplies.length) {
    mismatch = `line count ${nativeLines.length} vs ${wasmReplies.length}`;
  } else {
    for (let i = 0; i < nativeLines.length; i++) {
      if (nativeLines[i] !== wasmReplies[i]) { mismatch = `seed ${seeds[i]} at byte ${commonPrefix(nativeLines[i], wasmReplies[i])}`; break; }
    }
  }
  if (mismatch) { failures++; console.error(`FAIL course ${courseId} A parity: ${mismatch}`); }

  // B) frames-less contract vs the stdin worker.
  const workerOut = runWorkerOmit(request, seeds);
  const workerLines = jsonLines(workerOut);
  write(`worker-omit-${courseId}.jsonl`, workerOut);
  let mismatchB = null;
  if (workerLines.length !== wasmReplies.length) {
    mismatchB = `line count ${workerLines.length} vs ${wasmReplies.length}`;
  } else {
    for (let i = 0; i < workerLines.length; i++) {
      const stripped = canonical(wasmReplies[i], true);
      const workerC = canonical(workerLines[i], false);
      if (workerC !== stripped) {
        write(`diff-${courseId}-${seeds[i]}.txt`, `worker: ${workerLines[i].slice(0, 2000)}\nstripped: ${stripped.slice(0, 2000)}\n`);
        mismatchB = `seed ${seeds[i]} (diff head written) at byte ${commonPrefix(workerC, stripped)}`;
        break;
      }
    }
  }
  if (mismatchB) { failures++; console.error(`FAIL course ${courseId} B omitFrames: ${mismatchB}`); }

  // native timing with the same binary (second pass, warm).
  const t1 = performance.now();
  runNativeRef(requestFile, geometryFile, seeds);
  const nativeTotal = performance.now() - t1;

  const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  report.courses.push({
    courseId,
    parity: mismatch ? 'FAIL' : 'ok', omitFramesParity: mismatchB ? 'FAIL' : 'ok',
    prepareMs: +prepareMs.toFixed(1),
    wasmMsPerRace: +(wasmTotal / seeds.length).toFixed(2), wasmMedianMs: +median(wasmTimes).toFixed(2),
    nativeMsPerRace: +(nativeTotal / seeds.length).toFixed(2),
    ratio: +((wasmTotal / seeds.length) / (nativeTotal / seeds.length)).toFixed(2),
  });
  console.log(courseId, report.courses.at(-1), mismatch || mismatchB ? 'FAIL' : 'ok');
}

write('phase0-report.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
console.log(failures ? `${failures} FAILURE(S)` : `ALL OK (${seedCount} seeds × ${courses.length} courses)`);
process.exitCode = failures ? 1 : 0;

function commonPrefix(a, b) {
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return `${i}: ${a.slice(Math.max(0, i - 40), i + 40)} <-> ${b.slice(Math.max(0, i - 40), i + 40)}`;
}
