/// <reference lib="webworker" />
/**
 * GlobalSim Web Worker entry (Phase 4, decision D2: one wasm instance per
 * worker). Thin on purpose — the message logic lives in workerCore.ts so node
 * tests drive the identical code against the real wasm pkg.
 *
 * The wasm + course geometry are loaded from the deployed static paths the
 * build generates (umalator-global/build.mjs generateGlobalsimAssets):
 *   /uma-tools/globalsim/wasm/globalsim_wasm.js  (+ _bg.wasm)
 *   /uma-tools/globalsim/geometry/<courseId>.json
 * — the same /uma-tools/ asset prefix skills.ts fetches skills.json under, so
 * it resolves through the dev server, the Vite dev plugin and Pages alike.
 *
 * `importScripts` is intentionally avoided: the wasm-bindgen glue is an ES
 * module (init + named exports), so this worker must be type:'module' and
 * import it that way (globalsim-pool.ts creates it with {type:'module'}).
 */

import { createGlobalsimWorkerCore, WasmApi } from './workerCore';
import { BASE_PATH } from '../../../../components/base-path';

const WASM_JS = `${BASE_PATH}/globalsim/wasm/globalsim_wasm.js`;
const WASM_BYTES = `${BASE_PATH}/globalsim/wasm/globalsim_wasm_bg.wasm`;

async function loadWasmFromDeploy(): Promise<WasmApi> {
	// init() is the wasm-bindgen default export; passing bytes keeps it from
	// fetching the _bg.wasm relative to the worker URL (which is wrong here —
	// the bundle lives under the hashed v2 build path, not the assets dir).
	const mod: any = await import(/* @vite-ignore */ WASM_JS);
	const resp = await fetch(WASM_BYTES);
	if (!resp.ok) throw new Error(`globalsim_wasm_bg.wasm HTTP ${resp.status}`);
	const bytes = await resp.arrayBuffer();
	await (mod.default || mod.init)(bytes);
	return {
		register_geometry: (id: number, text: string) => mod.register_geometry(id, text),
		PreparedRace: mod.PreparedRace,
	};
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
const core = createGlobalsimWorkerCore({
	postMessage: (msg) => scope.postMessage(msg),
	loadWasm: loadWasmFromDeploy,
	fetchText: async (url) => {
		const r = await fetch(url);
		if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
		return r.text();
	},
});

scope.addEventListener('message', (e: MessageEvent) => core.onMessage(e.data));
