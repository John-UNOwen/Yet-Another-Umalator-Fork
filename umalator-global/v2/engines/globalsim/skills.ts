/**
 * Active GlobalSim skill table (Phase 2 of the GlobalSim integration plan).
 *
 * The merged active table (validated v70 ∪ globalsim/skills-supplement.json) is
 * generated at build time by tools/globalsim-coverage.mjs into
 * globalsim/skills.json at the site root, where it is served under the same
 * /uma-tools/ asset prefix the icons use (build.mjs' dev server, the Vite dev
 * plugin and the Cloudflare Pages rewrite all map that prefix).
 *
 * The table's keys are the coverage set: in GlobalSim mode, skill ids outside
 * it are hidden in the pickers and dropped from any imported state, so
 * uncovered skills never reach the engine (decision D5 — same ids the
 * adapter's `knownSkillIds` validation accepts).
 *
 * Fetched once per session and cached. A failed fetch is not cached — the
 * next caller retries (e.g. after the missing asset gets built).
 */

let pending: Promise<Set<string> | null> | null = null;

/** Keys of the active GlobalSim skill table, or null when the fetch fails. */
export function loadGlobalsimSkillIds(): Promise<Set<string> | null> {
	if (!pending) {
		pending = fetch('/uma-tools/globalsim/skills.json')
			.then(r => {
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				return r.json();
			})
			.then((table: Record<string, unknown>) => new Set(Object.keys(table)))
			.catch(e => {
				console.warn('[GlobalSim] active skill table unavailable:', e);
				pending = null; // don't cache failures — the next caller retries
				return null;
			});
	}
	return pending;
}
