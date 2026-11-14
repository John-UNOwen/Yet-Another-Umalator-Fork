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
 * Fetched once per session and cached. A single transient failure must not
 * kill the coverage gate for the whole session (one-shot callers — app-v2's
 * mount effect — never re-call after a null), so the fetch retries with a
 * capped backoff before giving up. Only a fully failed retry sequence returns
 * null, and it is not cached — the next caller starts a fresh sequence (e.g.
 * after the missing asset gets built).
 */

interface SkillTable { ids: Set<string>; defs: Record<string, unknown> }

import { BASE_PATH } from '../../../../components/base-path';

/** Backoff before retries 1/2/3 after a failed attempt (3 retries, ≤10 s). */
export const SKILL_TABLE_RETRY_DELAYS_MS = [1000, 4000, 10000];

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let pending: Promise<SkillTable | null> | null = null;

async function fetchTableOnce(): Promise<SkillTable> {
	const r = await fetch(`${BASE_PATH}/globalsim/skills.json`);
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	const table = (await r.json()) as Record<string, unknown>;
	return { ids: new Set(Object.keys(table)), defs: table };
}

async function fetchTableWithRetries(): Promise<SkillTable | null> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await fetchTableOnce();
		} catch (e) {
			if (attempt >= SKILL_TABLE_RETRY_DELAYS_MS.length) {
				console.warn('[GlobalSim] active skill table unavailable:', e);
				return null;
			}
			await delay(SKILL_TABLE_RETRY_DELAYS_MS[attempt]);
		}
	}
}

function fetchTable(): Promise<SkillTable | null> {
	if (!pending) {
		pending = fetchTableWithRetries().then((table) => {
			if (!table) pending = null; // don't cache failures — the next caller retries
			return table;
		});
	}
	return pending;
}

/** Keys of the active GlobalSim skill table, or null when the fetch fails. */
export async function loadGlobalsimSkillIds(): Promise<Set<string> | null> {
	return (await fetchTable())?.ids ?? null;
}

/**
 * The full merged table (engine skillData shape) — passed as `skillData` to
 * runGlobalsimCompare/runGlobalsimSkillChart so the engine initializes the
 * batch-1 supplement skills too (profile-v77's own skillData is v70-only).
 */
export async function loadGlobalsimSkillTable(): Promise<Record<string, unknown> | null> {
	return (await fetchTable())?.defs ?? null;
}
