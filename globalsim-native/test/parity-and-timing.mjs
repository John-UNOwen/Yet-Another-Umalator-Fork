// Native addon vs wasm pkg: byte parity + timing on run_compact.
//
// Loads both backends in one process, runs seeds 1..100 through
// run_compact(seed, '', -1, 2000), asserts byte-identical strings, then times
// 1000 races per backend after 100 warmup. Exits non-zero on the first diff.
//
// Usage (from any cwd): node globalsim-native/test/parity-and-timing.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const sim = path.join(root, 'vendor', 'GlobalSim');
const pkgDir = path.join(root, 'globalsim-wasm', 'pkg');

const COURSE = 10504;
const GEOMETRY = path.join(sim, 'data', 'course_geometry', `${COURSE}.json`);
const SEEDS = Array.from({ length: 100 }, (_, i) => i + 1);
const WARM = Array.from({ length: 100 }, (_, i) => 1000 + i);
const TIMED = Array.from({ length: 1000 }, (_, i) => 10000 + i);

// Every backend goes through this exact call.
const rc = (race, seed) => race.run_compact(seed, '', -1, 2000);

const firstDiff = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const lo = Math.max(0, i - 40);
  return { at: i, a: a.slice(lo, i + 40), b: b.slice(lo, i + 40) };
};

// wasm backend.
const { default: init, register_geometry: registerGeometryWasm, PreparedRace: PreparedRaceWasm } =
  await import(pathToFileURL(path.join(pkgDir, 'globalsim_wasm.js')).href);
await init(fs.readFileSync(path.join(pkgDir, 'globalsim_wasm_bg.wasm')));

// native addon backend.
const require = createRequire(import.meta.url);
const addon = require(path.join(root, 'globalsim-native', 'globalsim_native.node'));

// One request, courseId set to the geometry registered below.
const base = JSON.parse(fs.readFileSync(path.join(sim, 'examples', 'v77-race.jsonl'), 'utf8').split('\n')[0]);
const request = JSON.stringify({ ...base, courseId: COURSE });

const geometry = fs.readFileSync(GEOMETRY, 'utf8');
registerGeometryWasm(COURSE, geometry);
addon.register_geometry(COURSE, geometry);

// Parity over seeds 1..100.
const wasmRace = new PreparedRaceWasm(request);
const nativeRace = new addon.PreparedRace(request);
let mismatch = null;
for (const seed of SEEDS) {
  const nativeOut = rc(nativeRace, seed);
  const wasmOut = rc(wasmRace, seed);
  if (nativeOut !== wasmOut) { mismatch = { seed, ...firstDiff(nativeOut, wasmOut) }; break; }
}
wasmRace.free();
nativeRace.free();
if (mismatch) {
  console.error(`MISMATCH seed ${mismatch.seed} at byte ${mismatch.at}`);
  console.error(`  native: ${mismatch.a}`);
  console.error(`  wasm:   ${mismatch.b}`);
  process.exit(1);
}

// Timing: 100 warmup then 1000 timed races per backend.
const bench = (makeRace, label) => {
  const race = makeRace();
  for (const seed of WARM) rc(race, seed);
  const start = performance.now();
  for (const seed of TIMED) rc(race, seed);
  const msPerRace = (performance.now() - start) / TIMED.length;
  race.free();
  return { [label]: +msPerRace.toFixed(3) };
};

const report = {
  course: COURSE,
  parity: `byte-identical ${SEEDS.length}/${SEEDS.length}`,
  warmupRaces: WARM.length,
  timedRaces: TIMED.length,
  msPerRace: { ...bench(() => new PreparedRaceWasm(request), 'wasm'), ...bench(() => new addon.PreparedRace(request), 'native') },
};
console.log(JSON.stringify(report, null, 2));
