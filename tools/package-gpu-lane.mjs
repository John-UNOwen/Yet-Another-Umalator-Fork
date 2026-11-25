#!/usr/bin/env node
// Build the standalone sim-server package: one folder with node, the bundled
// server, the wasm pkg, the gpu addon, a warm program cache and the launcher.
// Usage: node tools/package-gpu-lane.mjs [--out <dir>]

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argOut = process.argv.indexOf('--out');
const OUT = path.resolve(argOut > 0 ? process.argv[argOut + 1] : path.join(ROOT, 'dist', 'gpu-lane'));
const SERVER_REL = path.join('umalator-global', 'v2', 'engines', 'globalsim', 'server.cjs');

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 1. One CommonJS bundle. The child mode re-runs the same file with --child, so
//    __dirname must keep the repo layout: the bundle sits where sim-server.ts
//    sat and the sibling folders are copied to their repo paths below.
await build({
  entryPoints: [path.join(ROOT, 'umalator-global', 'v2', 'engines', 'globalsim', 'sim-server.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: path.join(OUT, SERVER_REL),
  logLevel: 'warning',
});

// 2. The engine folders the server resolves from its own location.
const pkgSrc = path.join(ROOT, 'globalsim-wasm', 'pkg');
const pkgDst = path.join(OUT, 'globalsim-wasm', 'pkg');
fs.mkdirSync(pkgDst, { recursive: true });
for (const name of fs.readdirSync(pkgSrc)) {
  if (name === '.gitignore' || name.startsWith('globalsim_wasm_bg.wasm.d.ts')) continue;
  copyFile(path.join(pkgSrc, name), path.join(pkgDst, name));
}
copyFile(path.join(ROOT, 'globalsim-native', 'globalsim_native.node'), path.join(OUT, 'globalsim-native', 'globalsim_native.node'));

// The self-test ships too: testers run sim-server.bat --self-test and send the
// report back. It needs the engine fixtures and the course geometry below.
copyFile(path.join(ROOT, 'tools', 'gpu-self-test.mjs'), path.join(OUT, 'tools', 'gpu-self-test.mjs'));
const exampleDst = path.join(OUT, 'vendor', 'GlobalSim', 'examples');
fs.mkdirSync(exampleDst, { recursive: true });
for (const name of ['cm-10506-race', 'cm-10701-race', 'cm-10808-race', 'cm-10903-race', 'cm-11103-race', 'app-compare-race', 'v77-race']) {
  copyFile(path.join(ROOT, 'vendor', 'GlobalSim', 'examples', `${name}.jsonl`), path.join(exampleDst, `${name}.jsonl`));
}

// 3. Course geometry, the engine's fallback for a course the app never
//    registered. 120 courses, 32 MB.
const geomSrc = path.join(ROOT, 'vendor', 'GlobalSim', 'data', 'course_geometry');
const geomDst = path.join(OUT, 'vendor', 'GlobalSim', 'data', 'course_geometry');
fs.mkdirSync(geomDst, { recursive: true });
for (const name of fs.readdirSync(geomSrc)) {
  if (!name.endsWith('.json')) continue;
  copyFile(path.join(geomSrc, name), path.join(geomDst, name));
}

// 4. The built web app, served by the same server on the same port. The app is
//    built for root serving (CC_BASE_PATH=''), so its asset fetches resolve
//    under the server's own origin, the one its default URL points at.
const distSrc = path.join(ROOT, 'umalator-global', 'v2', 'dist');
const viteDir = path.join(ROOT, 'umalator-global', 'v2');
const vite = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
  cwd: viteDir, encoding: 'utf8', timeout: 600_000,
  env: { ...process.env, CC_BASE_PATH: '' },
});
if (vite.status !== 0) {
  console.error(vite.stdout ?? '');
  console.error(vite.stderr ?? '');
  process.exit(1);
}
const webDst = path.join(OUT, 'web');
fs.mkdirSync(webDst, { recursive: true });
fs.cpSync(distSrc, webDst, { recursive: true });

// The app fetches these under its base path: the skill table and course list
// for the UI, the wasm pkg and geometry for browser workers, the icons.
const copyDir = (from, to) => { fs.mkdirSync(to, { recursive: true }); fs.cpSync(from, to, { recursive: true }); };
copyDir(path.join(ROOT, 'globalsim-wasm', 'pkg'), path.join(webDst, 'globalsim', 'wasm'));
for (const name of ['skills.json', 'courses.json']) copyFile(path.join(ROOT, 'globalsim', name), path.join(webDst, 'globalsim', name));
const webGeom = path.join(webDst, 'globalsim', 'geometry');
fs.mkdirSync(webGeom, { recursive: true });
for (const name of fs.readdirSync(path.join(ROOT, 'vendor', 'GlobalSim', 'data', 'course_geometry'))) {
  if (name.endsWith('.json')) copyFile(path.join(ROOT, 'vendor', 'GlobalSim', 'data', 'course_geometry', name), path.join(webGeom, name));
}
copyDir(path.join(ROOT, 'icons'), path.join(webDst, 'icons'));

// 5. The node runtime, so the machine needs nothing installed.
const nodeExe = process.execPath;
copyFile(nodeExe, path.join(OUT, 'node.exe'));

// 6. The race program's disk cache, warmed for this device. Another device or
//    driver is a miss (the header binds source, device and driver) and rebuilds.
const cache = path.join(OUT, 'program-cache');
fs.mkdirSync(cache, { recursive: true });
const warm = spawnSync(process.execPath, ['-e', 'const m = require(process.argv[1]); process.stdout.write(JSON.stringify(m.gpuProbe ? m.gpuProbe() : { ok: false }));', path.join(OUT, 'globalsim-native', 'globalsim_native.node')], {
  encoding: 'utf8', timeout: 300_000, maxBuffer: 8 << 20,
  env: { ...process.env, GSIM_GPU_PROGRAM_CACHE: cache },
});

// 7. The launcher: its own node, cache and web app, the server's default backends.
fs.writeFileSync(path.join(OUT, 'sim-server.bat'),
  '@echo off\r\n'
  + 'rem GlobalSim local sim server - double-click launcher.\r\n'
  + 'rem Runs race simulations outside the browser tab. Keep this window open.\r\n'
  + 'rem Advanced: sim-server.bat --lan --token=SECRET --port=NNNN\r\n'
  + 'title GlobalSim sim server\r\n'
  + 'cd /d "%~dp0"\r\n'
  + 'set "GSIM_GPU_PROGRAM_CACHE=%~dp0program-cache"\r\n'
  + 'if not exist "%GSIM_GPU_PROGRAM_CACHE%" mkdir "%GSIM_GPU_PROGRAM_CACHE%"\r\n'
  + 'set "SIM_SERVER_STATIC=%~dp0web"\r\n'
  + 'if not defined SIM_SERVER_BACKENDS set "SIM_SERVER_BACKENDS=native,gpu"\r\n'
  + 'if /i "%~1"=="--self-test" goto self-test\r\n'
  + 'echo Starting the local sim server. Leave this window open while simulating.\r\n'
  + 'echo To stop: press Ctrl+C in this window, or just close it.\r\n'
  + 'echo.\r\n'
  + '"%~dp0node.exe" "%~dp0' + SERVER_REL.replace(/\\/g, '\\') + '" %*\r\n'
  + 'echo.\r\n'
  + 'echo The server has stopped.\r\n'
  + 'pause\r\n'
  + 'goto :eof\r\n'
  + ':self-test\r\n'
  + 'echo Running the GPU self-test. It writes globalsim-self-test.json here.\r\n'
  + 'echo Share that file with a bug report.\r\n'
  + 'echo.\r\n'
  + '"%~dp0node.exe" "%~dp0tools\\gpu-self-test.mjs" --server-dir "%~dp0." %2 %3 %4 %5\r\n'
  + 'echo.\r\n'
  + 'pause\r\n'
  + 'exit /b %errorlevel%\r\n',
  'utf8');

// 8. Prove the packaged server answers with its own runtime before shipping it.
const smoke = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'smoke-sim-server.mjs'), '--server-dir', OUT], {
  encoding: 'utf8', timeout: 600_000, maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'inherit'],
});
console.log(smoke.stdout?.trim() ?? '');
if (smoke.status !== 0) {
  console.error('package-gpu-lane: the packaged server smoke test failed, see the output above');
  process.exit(1);
}
if (warm.stdout) {
  try { console.log(`program cache probe: ${JSON.parse(warm.stdout).device ?? 'no device'}`); } catch { /* printed raw above */ }
}
const size = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`package ready: ${OUT} (${(size(OUT) / (1 << 20)).toFixed(0)} MB, node ${path.basename(nodeExe)} included)`);
