#!/usr/bin/env node
// Set up the optional gpu lane: toolchain check, gpu-built addon, device gate verdict.
// Usage: node tools/setup-gpu-lane.mjs

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ADDON = path.join(ROOT, 'globalsim-native', 'globalsim_native.node');
const CARGO_BIN = path.join(os.homedir(), '.cargo', 'bin');

function fail(msg) {
  console.error('setup-gpu-lane: ' + msg);
  process.exit(1);
}

if (process.argv.length > 2) fail('usage: node tools/setup-gpu-lane.mjs  (no arguments: the engine ships in vendor/GlobalSim)');

if (process.platform !== 'win32') {
  fail('the gpu lane links OpenCL.lib from Intel oneAPI on Windows, other platforms are not supported');
}

// (a) toolchain: cargo on PATH plus the oneAPI LIB prefix.
// The env block keeps its original key casing (Path vs PATH), so merge into
// whichever key exists or cmd.exe gets a truncated search path.
const env = { ...process.env };
function envKey(name) {
  return Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase()) ?? name;
}
function envGet(name) {
  return env[envKey(name)] ?? '';
}
function envSet(name, value) {
  env[envKey(name)] = value;
}
if (spawnSync('cargo', ['--version'], { stdio: 'ignore', env, windowsHide: true }).status !== 0) {
  if (!fs.existsSync(path.join(CARGO_BIN, 'cargo.exe'))) {
    fail(`cargo not found. Install Rust 1.100+, make sure ${CARGO_BIN} is on PATH, then re-run.`);
  }
  envSet('PATH', CARGO_BIN + path.delimiter + envGet('PATH'));
  console.log(`cargo not on PATH: using ${CARGO_BIN} for this run`);
}

function libDirWithOpenCl() {
  for (const d of envGet('LIB').split(path.delimiter)) {
    const t = d.trim();
    if (t && fs.existsSync(path.join(t, 'OpenCL.lib'))) return t;
  }
  for (const root of ['C:\\Program Files (x86)\\Intel\\oneAPI', 'C:\\Program Files\\Intel\\oneAPI']) {
    if (!fs.existsSync(root)) continue;
    const versions = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d/.test(e.name))
      .map((e) => e.name).sort().reverse();
    for (const v of versions) {
      const lib = path.join(root, v, 'lib');
      if (fs.existsSync(path.join(lib, 'OpenCL.lib'))) return lib;
    }
  }
  return null;
}
const libDir = libDirWithOpenCl();
console.log('a fresh shell that builds the gpu addon itself starts with (PowerShell):');
console.log(`  $env:Path = "$env:USERPROFILE\\.cargo\\bin;$env:Path"; $env:LIB = "${libDir ?? '<oneAPI>\\lib'};$env:LIB"`);
if (!libDir) {
  fail('no oneAPI lib dir containing OpenCL.lib found (LIB and the Intel oneAPI roots were checked). Replace <oneAPI> in the line above, set LIB, then re-run.');
}
if (!envGet('LIB').toLowerCase().split(path.delimiter).includes(libDir.toLowerCase())) {
  envSet('LIB', libDir + path.delimiter + envGet('LIB'));
  console.log(`prepended to LIB for this run: ${libDir}`);
}

// (b) gpu-built addon (the wasm|native builds stay gpu-free by default).
// cmd.exe mis-resolves a quoted command name through the npm shim, so the call
// stays unquoted. When npm is off PATH, prepend the node dir instead.
if (spawnSync('where', ['npm'], { stdio: 'ignore', env, windowsHide: true }).status !== 0) {
  const nodeDir = path.dirname(process.execPath);
  if (!fs.existsSync(path.join(nodeDir, 'npm.cmd'))) {
    fail('npm not found on PATH and not beside node.exe. Install Node.js 20+, then re-run.');
  }
  envSet('PATH', nodeDir + path.delimiter + envGet('PATH'));
}
console.log('building the gpu addon (cargo build --release --features gpu, plus the .node copy):');
if (spawnSync('npm run build:globalsim-native-gpu', { shell: true, stdio: 'inherit', cwd: ROOT, env }).status !== 0) {
  fail('gpu addon build failed. Read the cargo output above, fix the cause, re-run.');
}

// (c) device gate and startup check, the same probe the sim server runs.
// The probe warms the race program's disk cache, the one the server then loads.
if (!env.GSIM_GPU_PROGRAM_CACHE) {
  const base = env.LOCALAPPDATA || env.TEMP || '.';
  env.GSIM_GPU_PROGRAM_CACHE = path.join(base, 'GlobalSim', 'program-cache');
}
fs.mkdirSync(env.GSIM_GPU_PROGRAM_CACHE, { recursive: true });
console.log(`program cache: ${env.GSIM_GPU_PROGRAM_CACHE}`);
const probeScript =
  'const m = require(' + JSON.stringify(ADDON) + ');'
  + 'const done = (r) => process.stdout.write("GPU_PROBE" + JSON.stringify(r));'
  + 'const r = typeof m.gpuProbe === "function" ? m.gpuProbe()'
  + ' : typeof m.gpuAvailable !== "function"'
  + ' ? { ok: false, reasons: ["addon lacks gpu support (build with --features gpu)"] }'
  + ' : (() => { try { return m.gpuAvailable(); } catch (e) { return { ok: false, reasons: [String((e && e.message) || e)] }; } })();'
  + 'done(r);';
const probe = spawnSync(process.execPath, ['-e', probeScript], {
  encoding: 'utf8', timeout: 300000, maxBuffer: 8 << 20, stdio: ['ignore', 'pipe', 'ignore'], env,
});
const hit = /GPU_PROBE(\{.*\})/.exec(probe.stdout ?? '');
if (!hit) fail(`gpu probe printed no verdict. Is the built addon at ${ADDON}?`);
const gate = JSON.parse(hit[1]);
const reasons = Array.isArray(gate.reasons) ? gate.reasons.join(', ') : '';
if (gate.ok === true) {
  const parity = gate.parityOk === true ? ', guard race bit-exact' : '';
  const measured = typeof gate.floorMs === 'number' && typeof gate.slopeMsPerRace === 'number'
    ? `, floor ${Math.round(gate.floorMs)} ms, ${gate.slopeMsPerRace.toFixed(2)} ms/race` : '';
  console.log(`device gate: ok (${gate.device ?? 'unknown device'}${parity}${measured})`);
} else console.log(`device gate: unavailable (${reasons || 'no reasons given'})`);
if (gate.ok === true && gate.parityOk !== true) fail('the guard race did not match the CPU engine: the lane would not be bit-exact');

// (d) the three commands that turn the lane on.
console.log('');
console.log('Turn the lane on (PowerShell, per shell):');
console.log("  $env:SIM_SERVER_BACKENDS = 'wasm,gpu'");
console.log('  npm run sim-server');
console.log('  npm run test:globalsim-backend-gpu');
console.log('Without SIM_SERVER_BACKENDS every session stays wasm, and the test skips with a reason when the device gate refuses.');
if (gate.ok !== true) {
  fail('the addon is built, but this machine fails the device gate: gpu sessions stay 503 until a gate-passing GPU is attached');
}
