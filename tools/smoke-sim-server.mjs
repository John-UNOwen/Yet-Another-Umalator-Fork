#!/usr/bin/env node
// Smoke a packaged sim server: start it, wait for the gpu check, then require
// byte-identical records from one v77 request on a wasm and a gpu session.
// Usage: node tools/smoke-sim-server.mjs --server-dir <package dir>

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const di = process.argv.indexOf('--server-dir');
if (di < 0 || !process.argv[di + 1]) {
  console.error('smoke-sim-server: usage: node tools/smoke-sim-server.mjs --server-dir <package dir>');
  process.exit(2);
}
const DIR = path.resolve(process.argv[di + 1]);
const NODE = path.join(DIR, 'node.exe');
const SERVER = path.join(DIR, 'umalator-global', 'v2', 'engines', 'globalsim', 'server.cjs');
const V77 = path.join(ROOT, 'vendor', 'GlobalSim', 'examples', 'v77-race.jsonl');
const BASE_SEED = 20261115;
const N = 8;

function fail(msg) {
  console.error(`smoke-sim-server: ${msg}`);
  try { proc?.kill(); } catch { /* gone */ }
  process.exit(1);
}
let proc = null;
let out = '';

const started = await new Promise((resolve, reject) => {
  proc = spawn(NODE, [SERVER, '--port=0'], {
    cwd: DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SIM_SERVER_BACKENDS: 'native,gpu', GSIM_GPU_PROGRAM_CACHE: path.join(DIR, 'program-cache'), SIM_SERVER_STATIC: path.join(DIR, 'web') },
  });
  const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 120_000);
  proc.stdout.on('data', (d) => {
    out += d.toString();
    const m = /listening on (https?:\/\/[^ ]+) /.exec(out);
    if (m) { clearTimeout(timer); resolve(m[1]); }
  });
  proc.stderr.on('data', (d) => { out += d.toString(); });
  proc.on('exit', () => { clearTimeout(timer); reject(new Error(`server exited:\n${out}`)); });
});
const url = started;

async function waitVerdict() {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const r = await (await fetch(`${url}/ping`)).json();
    if (r.gpu && r.gpu.pending !== true) return r.gpu;
    if (Date.now() > deadline) fail('the gpu startup check did not finish');
    await new Promise((res) => setTimeout(res, 250));
  }
}

async function postMsg(id, m) {
  const r = await fetch(`${url}/session/${id}/msg`, { method: 'POST', body: JSON.stringify(m) });
  if (r.status !== 202) fail(`POST /session/${id}/msg -> ${r.status}`);
}

async function pollOut(id, accept, budgetMs, what) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const r = await fetch(`${url}/session/${id}/out`);
    if (r.status !== 200) fail(`GET /session/${id}/out -> ${r.status}`);
    const { msgs } = await r.json();
    if (msgs.some((m) => m.type === '__died')) fail(`session ${id} child died while waiting for ${what}`);
    if (msgs.some(accept)) return msgs;
    if (Date.now() > deadline) fail(`timed out waiting for ${what} on session ${id}`);
  }
}

async function runJob(engine, job) {
  const open = await fetch(`${url}/session`, { method: 'POST', body: JSON.stringify({ engine }) });
  if (open.status !== 200) fail(`POST /session (${engine}) -> ${open.status}`);
  const s = await open.json();
  try {
    await postMsg(s.sessionId, { type: 'skillData', skillData: {} });
    await postMsg(s.sessionId, { type: 'prepare', id: 'p1', setupKey: job.setupKey, request: job.request, distance: job.distance });
    const prepMsgs = await pollOut(s.sessionId, (m) => m.type === 'prepared' && m.setupKey === job.setupKey, 180_000, 'prepared');
    const prep = prepMsgs.find((m) => m.type === 'prepared');
    if (!prep.ok) fail(`${engine} prepare failed: ${prep.error}`);
    await postMsg(s.sessionId, { type: 'run', jobId: 'j1', setupKey: job.setupKey, seeds: job.seeds, mode: 'compact' });
    const runMsgs = await pollOut(s.sessionId, (m) => m.type === 'chunk' && m.jobId === 'j1', 300_000, 'chunk');
    const chunk = runMsgs.find((m) => m.type === 'chunk' && m.jobId === 'j1');
    if (!chunk.ok) fail(`${engine} chunk failed: ${chunk.error}`);
    return chunk.records;
  } finally {
    await fetch(`${url}/session/${s.sessionId}`, { method: 'DELETE' }).catch(() => { /* gone */ });
  }
}

const gpu = await waitVerdict();
if (!gpu.ok) fail(`gpu check refused the lane: ${gpu.reasons.join(', ')}`);
if (!out.includes('[sim-server] program cache: ' + path.join(DIR, 'program-cache'))) fail('the server did not use the packaged program cache');
if (!out.includes('[sim-server] gpu: on (')) fail('no gpu status line in the server log');

// The packaged launcher defaults the rotation to the shipped native engine.
const rotated = await fetch(`${url}/session`, { method: 'POST', body: '{}' });
if (rotated.status !== 200) fail(`POST /session (rotation) -> ${rotated.status}`);
const rotatedBody = await rotated.json();
if (rotatedBody.backend !== 'native') fail(`the packaged rotation gave ${rotatedBody.backend}, expected native`);
await fetch(`${url}/session/${rotatedBody.sessionId}`, { method: 'DELETE' }).catch(() => { /* gone */ });

// The packaged launcher serves the built app from the same origin as the API.
if (fs.existsSync(path.join(DIR, 'web', 'index.html'))) {
  const page = await fetch(`${url}/`);
  if (page.status !== 200) fail(`GET / -> ${page.status}`);
  const html = await page.text();
  if (!html.includes('<title>')) fail('the served page has no title');
  const asset = /src="(?:\.\/)?(\/?assets\/[^"]+\.js)"/.exec(html);
  if (!asset) fail('the served page names no script asset');
  const assetPath = asset[1].replace(/^\/+/, '');
  const js = await fetch(`${url}/${assetPath}`);
  if (js.status !== 200) fail(`GET ${assetPath} -> ${js.status}`);
  if (!(await js.text()).length) fail('the served script is empty');
  const skills = await fetch(`${url}/globalsim/skills.json`);
  if (skills.status !== 200) fail(`GET /globalsim/skills.json -> ${skills.status}`);
  const table = await skills.json();
  if (!table || Object.keys(table).length < 100) fail('the served skill table is empty');
  console.log(`served app: ${html.length} bytes of html, ${assetPath} ${js.status}, skill table ${Object.keys(table).length} entries`);
} else {
  console.log('served app: no web/index.html in the package');
}

const request = JSON.parse(fs.readFileSync(V77, 'utf8').split(/\r?\n/)[0]);
const job = { setupKey: 'v77-line1', request, seeds: Array.from({ length: N }, (_, i) => BASE_SEED + i), distance: 2000 };

const wasm = await runJob('wasm', job);
const gpuRecords = await runJob('gpu', job);
const same = JSON.stringify(wasm) === JSON.stringify(gpuRecords);
if (!same) fail('the gpu records differ from the wasm records');
if (wasm.some((r) => r.gpuFallback)) fail('the gpu lane answered a fallback for the v77 request');

console.log(`smoke-sim-server: OK, ${path.basename(DIR)} serves ${wasm.length} byte-identical records on wasm and gpu (${gpu.device})`);
try { proc.kill(); } catch { /* gone */ }
process.exit(0);
