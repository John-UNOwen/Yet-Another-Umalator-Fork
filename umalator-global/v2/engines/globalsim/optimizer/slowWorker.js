/**
 * worker_threads side for the optimizer's slow acceptance test
 * (search.exhaustive.test.ts): drives the REAL workerCore.ts message logic on
 * a Node worker thread with the REAL globalsim-wasm pkg, and bridges
 * worker_threads' port API onto the pool's WorkerLike contract.
 *
 * Not part of the app bundle — only ever spawned by the slow test.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { parentPort, workerData } = require('worker_threads');

// ts-node register (transpile-only) so requiring the real .ts modules below
// matches the main test process's configuration.
require('ts-node').register({
	transpileOnly: true,
	compilerOptions: { module: 'commonjs', moduleResolution: 'node', esModuleInterop: true },
});
// HorseDefTypes reads the build-time define at module scope — the bundler's
// define is absent under ts-node, same as in the .ts tests.
globalThis.CC_GLOBAL = true;

const { createGlobalsimWorkerCore } = require(path.join(__dirname, '..', 'workerCore.ts'));

let wasmSeq = 0;
async function loadWasm() {
	const dynImport = new Function('u', 'return import(u)');
	const mod = await dynImport(pathToFileURL(path.join(workerData.pkgDir, 'globalsim_wasm.js')).href + `?w=${wasmSeq++}`);
	const init = mod.default ?? mod.init;
	await init(fs.readFileSync(path.join(workerData.pkgDir, 'globalsim_wasm_bg.wasm')));
	return {
		register_geometry: (courseId, jsonText) => mod.register_geometry(courseId, jsonText),
		PreparedRace: mod.PreparedRace,
	};
}

const core = createGlobalsimWorkerCore({
	postMessage: (m) => { try { parentPort.postMessage(m); } catch { /* terminated */ } },
	loadWasm,
	fetchText: (url) => fs.promises.readFile(path.join(workerData.geomDir, path.basename(url)), 'utf8'),
});

parentPort.on('message', (m) => core.onMessage(m));
