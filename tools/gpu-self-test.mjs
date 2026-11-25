#!/usr/bin/env node
// GPU self-test for GlobalSim: the device gate, CPU-vs-GPU parity and the
// tuning sweeps, written as one JSON report to share with a bug report.
//
// Usage: node tools/gpu-self-test.mjs [--out <file>] [--server-dir <dir>] [--quick] [--no-server]
//   --out         report path (default globalsim-self-test.json in the cwd)
//   --server-dir  packaged server directory holding node.exe, server.cjs and
//                 globalsim-native/globalsim_native.node. Default is this repo.
//   --quick       fewer seeds and widths
//   --no-server   skip the startup check section (no server spawn)

import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const QUICK = process.argv.includes('--quick');
const NO_SERVER = process.argv.includes('--no-server');
const OUT = path.resolve(arg('out', 'globalsim-self-test.json'));
const SERVER_DIR = arg('server-dir', null);
const BASE = SERVER_DIR ? path.resolve(SERVER_DIR) : ROOT;
const ADDON = process.env.GLOBALSIM_ADDON || path.join(BASE, 'globalsim-native', 'globalsim_native.node');
// A package ships the fixtures beside the addon; the repo keeps them under vendor.
const EXAMPLES = fs.existsSync(path.join(BASE, 'vendor', 'GlobalSim', 'examples'))
  ? path.join(BASE, 'vendor', 'GlobalSim', 'examples')
  : path.join(ROOT, 'vendor', 'GlobalSim', 'examples');
const GEOMETRY = fs.existsSync(path.join(BASE, 'vendor', 'GlobalSim', 'data', 'course_geometry'))
  ? path.join(BASE, 'vendor', 'GlobalSim', 'data', 'course_geometry')
  : path.join(ROOT, 'vendor', 'GlobalSim', 'data', 'course_geometry');
const SKILLS = fs.existsSync(path.join(BASE, 'web', 'globalsim', 'skills.json'))
  ? path.join(BASE, 'web', 'globalsim', 'skills.json')
  : path.join(ROOT, 'globalsim', 'skills.json');

const report = {
  tool: 'globalsim-self-test',
  format: 1,
  mode: SERVER_DIR ? 'packaged' : 'repo',
  generatedAt: new Date().toISOString(),
  host: {
    os: `${os.type()} ${os.release()}`,
    cpu: (os.cpus()[0] || {}).model || 'unknown',
    cores: os.cpus().length,
    node: process.version,
    arch: process.arch,
  },
  engine: { app: null, vendored: null, addon: null },
  device: null,
  startup: null,
  parity: [],
  tdr: null,
  widths: [],
  localWorkSizes: [],
  f64Ratio: null,
  verdict: null,
};

function note(what) {
  console.log(`self-test: ${what}`);
}

function gitRev(dir) {
  try { return execSync('git rev-parse --short HEAD', { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
}

function loadAddon() {
  if (!fs.existsSync(ADDON)) throw new Error(`addon not found at ${ADDON}`);
  const addon = require(ADDON);
  for (const name of ['gpuAvailable', 'gpuDeviceReport', 'gpuSetLocalWorkSize', 'gpuSetSkillTable', 'gpuRunCompactBatch', 'PreparedRace']) {
    if (typeof addon[name] !== 'function') throw new Error(`the addon has no ${name}; the gpu build is stale or missing`);
  }
  return addon;
}

function readFixture(name) {
  const file = path.join(EXAMPLES, `${name}.jsonl`);
  if (!fs.existsSync(file)) return null;
  const line = fs.readFileSync(file, 'utf8').split(/\r?\n/).find((l) => l.trim().length > 0);
  return line ? JSON.parse(line) : null;
}

function courseOf(request) {
  const id = request && request.courseId != null ? String(request.courseId) : null;
  return id && /^\d+$/.test(id) ? id : null;
}

function registerCourses(addon, requests) {
  const done = new Set();
  const missing = [];
  for (const request of requests) {
    const course = courseOf(request);
    if (!course || done.has(course)) continue;
    done.add(course);
    const file = path.join(GEOMETRY, `${course}.json`);
    if (!fs.existsSync(file)) { missing.push(course); continue; }
    addon.register_geometry(Number(course), fs.readFileSync(file, 'utf8'));
  }
  return { registered: [...done].filter((c) => !missing.includes(c)), missing };
}

// ── sections ─────────────────────────────────────────────────────────────────

function deviceSection(addon) {
  const available = addon.gpuAvailable();
  const section = { ok: available.ok === true, reasons: available.reasons || [], device: available.device || null, report: null };
  if (available.ok) {
    try { section.report = JSON.parse(addon.gpuDeviceReport()); }
    catch (e) { section.report = { error: String(e && e.message || e) }; }
    section.f64Config = section.report ? section.report.doubleFpConfig : null;
  } else {
    section.report = { error: (available.reasons || []).join(', ') };
  }
  report.device = section;
  note(`device ${section.ok ? 'on' : 'off'}: ${section.device || (available.reasons || []).join(', ')}`);
  if (section.report && section.report.driver) note(`driver ${section.report.driver}, ${section.report.platform}`);
  return section.ok;
}

function spawnServer() {
  const server = SERVER_DIR
    ? { cmd: process.execPath, args: [path.join(BASE, 'umalator-global', 'v2', 'engines', 'globalsim', 'server.cjs'), '--port=0'], cwd: BASE }
    : {
      cmd: process.execPath,
      args: [
        path.join(ROOT, 'node_modules', 'ts-node', 'dist', 'bin.js'), '--transpile-only',
        '--compiler-options', JSON.stringify({ moduleResolution: 'node', module: 'commonjs' }),
        path.join(ROOT, 'umalator-global', 'v2', 'engines', 'globalsim', 'sim-server.ts'), '--port=0',
      ],
      cwd: ROOT,
    };
  const env = { ...process.env, SIM_SERVER_BACKENDS: 'native,gpu' };
  if (SERVER_DIR) {
    // The packaged launcher sets these for the server it starts.
    const cache = path.join(BASE, 'program-cache');
    fs.mkdirSync(cache, { recursive: true });
    env.SIM_SERVER_STATIC = path.join(BASE, 'web');
    env.GSIM_GPU_PROGRAM_CACHE = cache;
  }
  const proc = spawn(server.cmd, server.args, {
    cwd: server.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  let out = '';
  const url = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 120_000);
    proc.stdout.on('data', (d) => {
      out += d.toString();
      const m = /listening on (https?:\/\/[^ ]+) /.exec(out);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.stderr.on('data', (d) => { out += d.toString(); });
    proc.on('exit', () => { clearTimeout(timer); reject(new Error(`server exited:\n${out}`)); });
  });
  return { proc, url, log: () => out };
}

async function startupSection() {
  if (NO_SERVER) { report.startup = { skipped: '--no-server' }; return; }
  let server = null;
  try {
    server = spawnServer();
    const url = await server.url;
    const deadline = Date.now() + 180_000;
    let gpu = null;
    for (;;) {
      gpu = (await (await fetch(`${url}/ping`)).json()).gpu ?? null;
      if (gpu && gpu.pending !== true) break;
      if (Date.now() > deadline) throw new Error('the gpu startup check did not finish');
      await new Promise((res) => setTimeout(res, 250));
    }
    report.startup = { url, gpu, log: server.log().split(/\r?\n/).filter((l) => l.includes('gpu') || l.includes('engine')).slice(-8) };
    note(`startup ${gpu.ok ? 'on' : 'off'}: ${gpu.device || (gpu.reasons || []).join(', ')}${gpu.floorMs != null ? `, floor ${Math.round(gpu.floorMs)} ms, slope ${Number(gpu.slopeMsPerRace).toFixed(2)} ms/race` : ''}`);
  } catch (e) {
    report.startup = { error: String(e && e.message || e) };
    note(`startup check failed: ${report.startup.error}`);
  } finally {
    if (server) { try { server.proc.kill(); } catch { /* gone */ } }
  }
}

// The gpu batch answers parsed records (serde sorts their keys), while the
// native path answers the compact record text itself, so compare values.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function nativeRecords(addon, request, seeds, distance) {
  const prep = new addon.PreparedRace(JSON.stringify(request));
  try { return seeds.map((seed) => prep.run_compact(seed, '', -1, distance)); }
  finally { prep.free(); }
}

function paritySection(addon) {
  const names = ['cm-10506-race', 'cm-10701-race', 'cm-10808-race', 'cm-10903-race', 'cm-11103-race', 'app-compare-race', 'v77-race'];
  const seeds = Array.from({ length: QUICK ? 2 : 8 }, (_, i) => 20261115 + i);
  const requests = [];
  for (const name of names) {
    const request = readFixture(name);
    if (request) requests.push({ name, request });
  }
  const courses = registerCourses(addon, requests.map((r) => r.request));
  if (courses.missing.length) note(`no geometry file for course(s) ${courses.missing.join(', ')}`);
  for (const { name, request } of requests) {
    const distance = request.course && typeof request.course.distance === 'number' ? request.course.distance : 2000;
    const entry = { fixture: name, seeds: seeds.length, identical: false, fallbacks: 0, error: null, nativeMs: null, gpuMs: null };
    try {
      nativeRecords(addon, request, seeds.slice(0, 1), distance);   // warm the engine
      const t0 = Date.now();
      const native = nativeRecords(addon, request, seeds, distance);
      entry.nativeMs = Date.now() - t0;
      const t1 = Date.now();
      const gpu = JSON.parse(addon.gpuRunCompactBatch(JSON.stringify(request), seeds, '', -1, distance));
      entry.gpuMs = Date.now() - t1;
      entry.fallbacks = gpu.filter((r) => r && typeof r.gpuFallback === 'string').length;
      entry.identical = native.length === gpu.length && native.every((text, i) => canonical(JSON.parse(text)) === canonical(gpu[i]));
      if (!entry.identical && entry.fallbacks === 0) {
        const at = native.findIndex((text, i) => canonical(JSON.parse(text)) !== canonical(gpu[i]));
        entry.error = at >= 0 ? `first difference at seed position ${at}` : `native ${native.length} records for ${gpu.length} seeds`;
      }
    } catch (e) {
      entry.error = String(e && e.message || e);
    }
    report.parity.push(entry);
    note(`parity ${name}: ${entry.identical ? 'identical' : entry.error || `${entry.fallbacks} fallbacks`} (${entry.nativeMs} vs ${entry.gpuMs} ms)`);
  }
}

function tdrSection(addon) {
  const request = readFixture('v77-race') || readFixture('cm-10701-race');
  if (!request) { report.tdr = { skipped: 'no fixture' }; return; }
  const seeds = Array.from({ length: QUICK ? 1024 : 2048 }, (_, i) => 20261115 + i);
  const entry = { races: seeds.length, ok: false, ms: null, error: null, followUpDisabled: false };
  try {
    addon.gpuRunCompactBatch(JSON.stringify(request), seeds.slice(0, 16), '', -1, 2000);   // warm the device
    const t = Date.now();
    const records = JSON.parse(addon.gpuRunCompactBatch(JSON.stringify(request), seeds, '', -1, 2000));
    entry.ms = Date.now() - t;
    entry.racesPerSec = Math.round(records.length / entry.ms * 1000);
    // One more small call proves the device still answers (a TDR would reset it).
    const probe = JSON.parse(addon.gpuRunCompactBatch(JSON.stringify(request), [1], '', -1, 2000));
    entry.ok = records.length === seeds.length && probe.length === 1;
    entry.followUpDisabled = !entry.ok;
  } catch (e) {
    entry.error = String(e && e.message || e);
  }
  report.tdr = entry;
  note(`tdr check ${entry.ok ? 'ok' : 'failed'}: ${entry.races} races in ${entry.ms} ms${entry.error ? `, ${entry.error}` : ''}`);
}

function widthsSection(addon) {
  const request = readFixture('v77-race') || readFixture('cm-10701-race');
  if (!request) return;
  const widths = QUICK ? [256, 1024] : [256, 512, 1024, 2048, 4096];
  for (const width of widths) {
    const entry = { races: width, ms: null, racesPerSec: null, error: null };
    try {
      const seeds = Array.from({ length: width }, (_, i) => 20261115 + i);
      const t = Date.now();
      const records = JSON.parse(addon.gpuRunCompactBatch(JSON.stringify(request), seeds, '', -1, 2000));
      entry.ms = Date.now() - t;
      entry.racesPerSec = Math.round(records.length / entry.ms * 1000);
    } catch (e) {
      entry.error = String(e && e.message || e);
    }
    report.widths.push(entry);
    note(`width ${width}: ${entry.ms} ms, ${entry.racesPerSec} races/s${entry.error ? ` (${entry.error})` : ''}`);
  }
}

function localWorkSizeSection(addon) {
  const request = readFixture('v77-race') || readFixture('cm-10701-race');
  if (!request) return;
  const races = QUICK ? 256 : 1024;
  const seeds = Array.from({ length: races }, (_, i) => 20261115 + i);
  let baseline = null;
  for (const size of [0, 8, 16, 32, 64]) {
    const entry = { size: size || 'pinned', ms: null, identical: null, error: null };
    try {
      addon.gpuSetLocalWorkSize(size);
      const t = Date.now();
      const records = addon.gpuRunCompactBatch(JSON.stringify(request), seeds, '', -1, 2000);
      entry.ms = Date.now() - t;
      if (baseline === null) baseline = records;
      entry.identical = records === baseline;
    } catch (e) {
      entry.error = String(e && e.message || e);
    }
    report.localWorkSizes.push(entry);
    note(`local work size ${size || 'pinned'}: ${entry.ms} ms, records identical ${entry.identical}${entry.error ? ` (${entry.error})` : ''}`);
  }
  addon.gpuSetLocalWorkSize(0);
}

// The kernel is double precision, so a device with slow f64 answers slowly. The
// ratio is the one number a support report needs from the fp microkernels.
function f64RatioSection(addon) {
  const entry = { available: false, error: null };
  try {
    if (typeof addon.gpuF64Ratio !== 'function') throw new Error('the addon has no gpuF64Ratio; rebuild it with the gpu feature');
    const t = Date.now();
    Object.assign(entry, JSON.parse(addon.gpuF64Ratio()));
    entry.available = true;
    entry.ms = Date.now() - t;
  } catch (e) {
    entry.error = String(e && e.message || e);
  }
  note(entry.available
    ? `f64 ratio ${Number(entry.ratio).toFixed(1)}x slower than f32 (${Number(entry.f64GfPerSec).toFixed(1)} against ${Number(entry.f32GfPerSec).toFixed(1)} GF/s)`
    : `f64 ratio unavailable: ${entry.error}`);
  return entry;
}

// ── main ─────────────────────────────────────────────────────────────────────

let addon;
try {
  report.engine.app = gitRev(ROOT);
  report.engine.vendored = gitRev(path.join(ROOT, 'vendor', 'GlobalSim'));
  report.engine.addon = ADDON;
  addon = loadAddon();
  if (fs.existsSync(SKILLS)) {
    const table = fs.readFileSync(SKILLS, 'utf8');
    if (typeof addon.setSkillTable === 'function') addon.setSkillTable(table);
    addon.gpuSetSkillTable(table);
  } else {
    note(`no skill table at ${SKILLS}; fixtures with their own skillData still run`);
  }
  const ok = deviceSection(addon);
  await startupSection();
  if (ok) {
    paritySection(addon);
    tdrSection(addon);
    widthsSection(addon);
    localWorkSizeSection(addon);
  } else {
    note('device refused the lane; parity and tuning sections skipped');
  }
  report.f64Ratio = f64RatioSection(addon);
  const parityOk = report.parity.length === 0 || report.parity.every((e) => e.identical && e.fallbacks === 0);
  const tdrOk = !report.tdr || report.tdr.ok === true;
  const deviceOk = report.device && report.device.ok === true;
  report.verdict = !deviceOk ? 'off' : parityOk && tdrOk ? 'exact' : 'not-exact';
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  note(`verdict ${report.verdict}; report written to ${OUT}`);
  process.exit(report.verdict === 'exact' || report.verdict === 'off' ? 0 : 1);
} catch (e) {
  report.verdict = 'error';
  report.error = String(e && e.message || e);
  try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); } catch { /* best effort */ }
  note(`failed: ${report.error}`);
  process.exit(2);
}
