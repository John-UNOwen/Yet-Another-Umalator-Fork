/**
 * Hachimi career-dump import (Skill Optimizer).
 *
 * Reads the JSON that Hachimi-Edge writes from the running game (menu "Dump career
 * data" → `career_<charaId>_<epoch>.json`, tagged `"kind": "hachimi-career-dump"`,
 * `"version": 1`) and turns it into app state: the trained uma (outfit, stats,
 * aptitudes, running style, mood, learned skills) plus what the Optimizer needs to
 * answer "what should I buy with the SP I have" (hint levels, SP budget, and the
 * skill list the game was actually offering).
 *
 * Field semantics were read off the writer itself, not guessed:
 *   - `CareerDataDump.rs` (dump body, aptitude/style/stat getters, the 48-item list
 *     cap) and `SingleModeSkillProbe.rs` (the skill-row walk) in the Hachimi-Edge
 *     repo. The dump's own `acquiredSkills.items` walk yields empty objects and
 *     `raceEvaluations` are per-NPC bond entries, so neither is used here.
 *   - Aptitudes are the game's `ProperGrade` enum: 1=G … 8=S (same scale the roster
 *     tab and `components/gameExportParser.ts` use).
 *   - `runningStyle` is `RaceDefine.RunningStyle`: 1=Nige, 2=Senkou, 3=Sashi,
 *     4=Oikomi (5=Ōonige is race-only).
 *   - `motivation` is 0..5 (None…Max); the app's mood is -2..2, so mood = motivation-3.
 *   - A row with `IsGet=1` is a skill the trainee has; the rest are what the
 *     skill-learning screen was offering. `HintLv` is the hint count (0-5) and its
 *     discount ladder 10/20/30/35/40% is exactly `scaleBaseCost()` in
 *     `skill-chart-utils.ts`, so hint levels port directly and the app recomputes
 *     chain costs its own way (buying a gold skill still has to pay its silver).
 *
 * Deliberately NOT imported: `raceEvaluations` (bond entries, `ObscuredBool` fields
 * serialized as "<obscured …>"), `acquiredSkills` (contentless), `skillMasterNames`
 * (only filled by a different capture door), `scenarioId`/`routeId`/`entryProgramId`
 * (career context with no verified mapping onto an app course).
 */

import umas from '../../umas.json';
import skilldata from '../skill_data.json';
import { skillGroups } from './skill-chart-utils';
import type { UmaState } from './uma-panel';

/** The dump's tag. `version` is a literal 1 with no versioning logic behind it. */
export const CAREER_DUMP_KIND = 'hachimi-career-dump';
export const CAREER_DUMP_VERSION = 1;

const APT_LETTER: Record<number, 'S' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G'> = {
	1: 'G', 2: 'F', 3: 'E', 4: 'D', 5: 'C', 6: 'B', 7: 'A', 8: 'S',
};
/** Style code → the app's strategy name (5 is Ōonige, kept for safety). */
const STYLE_NAME: Record<number, 'Nige' | 'Senkou' | 'Sasi' | 'Oikomi' | 'Oonige'> = {
	1: 'Nige', 2: 'Senkou', 3: 'Sasi', 4: 'Oikomi', 5: 'Oonige',
};
/** Style code → the aptitudes field holding that style's own grade. */
const STYLE_GRADE_KEY: Record<number, string> = {
	1: 'styleNige', 2: 'styleSenko', 3: 'styleSashi', 4: 'styleOikomi',
};
const STYLE_ORDER: [number, string][] = [
	[1, 'styleNige'], [2, 'styleSenko'], [3, 'styleSashi'], [4, 'styleOikomi'],
];
/** Hint count → SP discount %, same ladder as `scaleBaseCost()`. */
const HINT_DISCOUNT = [0, 10, 20, 30, 35, 40];

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** One skill row as the probe recorded it (every field is optional on purpose:
 *  the shape comes from walking the game's live class, so nothing is guaranteed). */
interface CareerRow {
	SkillId?: number;
	Level?: number;
	IsGet?: number;
	HintLv?: number;
	CalcNeedPoint?: number;
	OriginNeedPoint?: number;
}

export interface CareerImport {
	/** Source file name, for the message the pane shows. */
	file: string;
	/** Patch for the current uma; feed it over the existing state and revalidate. */
	uma: Partial<UmaState>;
	/** skillId → hint level (0-5), the same map the Skill chart hint buttons edit. */
	hints: Map<string, number>;
	/** Skill points left in the career, when the dump could read them. */
	budget: number | null;
	/** Skill ids the trainee already has (`IsGet=1`). */
	owned: string[];
	/** Skill ids the game was offering at dump time (`IsGet` not 1). */
	offered: string[];
	/** One line for the pane: who this is and what came in. */
	summary: string;
	warnings: string[];
}

/** Cheap "is this the format" test, used before any field access. */
export function isCareerDump(obj: any): boolean {
	return !!obj && typeof obj === 'object' && obj.kind === CAREER_DUMP_KIND;
}

/** Merge every row source the dump carries, keyed by skill id, newest list last. */
function collectRows(dump: any): { rows: CareerRow[]; sources: string[] } {
	const byId = new Map<number, CareerRow>();
	const sources: string[] = [];
	for (const [key, list] of [
		['skillRowsObserved', dump.skillRowsObserved?.rows],
		['skillLearningScreen', dump.skillLearningScreen?.rows],
	] as [string, unknown][]) {
		if (!Array.isArray(list)) continue;
		const kept = list.filter((r) => isNum(r?.SkillId));
		if (!kept.length) continue;
		sources.push(key);
		for (const r of kept) byId.set(r.SkillId, r as CareerRow);
	}
	return { rows: [...byId.values()], sources };
}

/** id → hint level, from the row walk first and the live hint table second. */
function collectHints(rows: CareerRow[], hintItems: any[], warnings: string[]): Map<string, number> {
	const hints = new Map<string, number>();
	for (const r of rows) {
		if (!isNum(r.SkillId) || !isNum(r.HintLv) || r.HintLv <= 0) continue;
		const id = String(r.SkillId);
		if (!(skilldata as Record<string, any>)[id]) continue;
		hints.set(id, clamp(Math.round(r.HintLv), 0, 5));
	}
	// The hint table is authoritative for skills the row walk never reached (its
	// lists are capped at 48 items, and it holds whole groups by GroupId).
	for (const item of hintItems) {
		if (!isNum(item?.GroupId) || !isNum(item.Level)) continue;
		const level = clamp(Math.round(item.Level), 0, 5);
		// skillGroups is keyed by skill_meta's groupId, which is stored as a string;
		// the dump's GroupId is a number. Same value, so bridge the type.
		for (const id of skillGroups.get(String(item.GroupId)) ?? []) {
			if (!hints.has(id)) hints.set(id, level);
		}
	}
	return hints;
}

/** Count rows whose per-skill discount disagrees with their HintLv ladder. */
function checkDiscounts(rows: CareerRow[], tips: Record<string, any> | undefined, warnings: string[]) {
	if (!tips) return;
	let bad = 0;
	for (const r of rows) {
		if (!isNum(r.SkillId) || !isNum(r.HintLv)) continue;
		const t = tips[String(r.SkillId)];
		if (t && isNum(t.tipsDiscount) && t.tipsDiscount !== HINT_DISCOUNT[clamp(Math.round(r.HintLv), 0, 5)]) bad++;
	}
	if (bad) warnings.push(`${bad} skill(s) have a hint discount that does not match their hint level; the hint level was used.`);
}

function displayName(dump: any): string {
	const charaId = String(dump.character?.charaId ?? '');
	const cardId = String(dump.character?.cardId ?? '');
	const uma = (umas as Record<string, any>)[charaId];
	if (!uma) return cardId || charaId || 'unknown uma';
	const outfit = uma.outfits?.[cardId];
	const epithet = typeof outfit === 'string' ? outfit : outfit?.epithet;
	return epithet ? `${uma.name?.[1] ?? charaId} ${epithet}` : `${uma.name?.[1] ?? charaId}`;
}

/**
 * Convert a parsed dump into app state. Returns null only when the object is not a
 * career dump at all; a dump with holes in it converts with warnings instead.
 */
export function convertCareerDump(obj: any, file = 'career dump'): CareerImport | null {
	if (!isCareerDump(obj)) return null;
	const warnings: string[] = [];
	if (isNum(obj.version) && obj.version !== CAREER_DUMP_VERSION) {
		warnings.push(`Dump format version ${obj.version}; this reader knows version ${CAREER_DUMP_VERSION}.`);
	}

	const uma: Partial<UmaState> = {};
	const c = obj.character ?? {};
	const apt = obj.aptitudes ?? {};
	const stats = obj.stats ?? {};

	// ── Outfit + card level ───────────────────────────────────────────────────
	let outfitKnown = false;
	if (isNum(c.cardId)) {
		const outfitId = String(c.cardId);
		uma.outfitId = outfitId;
		outfitKnown = !!(umas as Record<string, any>)[String(c.charaId ?? '')]?.outfits?.[outfitId];
		if (!outfitKnown) {
			warnings.push(`Outfit ${outfitId} is not in the local uma data; the build was imported without a portrait.`);
		}
	} else {
		warnings.push('No character.cardId in the dump, so the outfit was left as it was.');
	}
	if (isNum(c.limitBreakCount)) {
		// 0..4 limit breaks is ★1..★5, and the star level picks which unique skill the app uses.
		uma.starCount = clamp(Math.round(c.limitBreakCount) + 1, 1, 5);
	}

	// ── Stats (the dump's `wiz` is the app's wisdom) ──────────────────────────
	const statMap: [string, string][] = [
		['speed', 'speed'], ['stamina', 'stamina'], ['power', 'power'],
		['guts', 'guts'], ['wisdom', 'wiz'],
	];
	let statsIn = 0;
	for (const [dest, src] of statMap) {
		if (isNum(stats[src])) {
			(uma as Record<string, number>)[dest] = Math.round(stats[src]);
			statsIn++;
		}
	}
	if (statsIn < statMap.length) warnings.push(`Only ${statsIn} of 5 stats were readable in the dump.`);

	// ── Aptitudes + running style ────────────────────────────────────────────
	const distGrades = ['distanceShort', 'distanceMile', 'distanceMiddle', 'distanceLong']
		.map((k) => (isNum(apt[k]) ? Math.round(apt[k]) : 0))
		.filter((v) => v >= 1 && v <= 8);
	if (distGrades.length === 4) {
		uma.distanceAptitude = APT_LETTER[Math.max(...distGrades)];
	} else {
		warnings.push('Distance aptitudes incomplete; kept the current distance aptitude.');
	}
	if (isNum(apt.groundTurf)) uma.surfaceAptitude = APT_LETTER[clamp(Math.round(apt.groundTurf), 1, 8)];

	// The strategy is the one the trainee actually runs; its own grade is the
	// aptitude the sim multiplies with. If runningStyle is missing, fall back to
	// the best style grade so the two fields stay consistent with each other.
	const styleCode = isNum(apt.runningStyle) ? Math.round(apt.runningStyle) : 0;
	let gradeKey = STYLE_GRADE_KEY[styleCode];
	let strategy = STYLE_NAME[styleCode];
	if (!gradeKey) {
		let best = -1;
		for (const [code, key] of STYLE_ORDER) {
			const g = isNum(apt[key]) ? Math.round(apt[key]) : 0;
			if (g > best) { best = g; gradeKey = key; strategy = STYLE_NAME[code]; }
		}
		if (strategy) warnings.push(`Running style code ${styleCode || 'missing'} is unknown; used the best style grade instead.`);
	}
	if (strategy) uma.strategy = strategy;
	if (gradeKey && isNum(apt[gradeKey])) uma.strategyAptitude = APT_LETTER[clamp(Math.round(apt[gradeKey]), 1, 8)];

	// Game motivation 0..5 (None…Max) → app mood -2..2.
	if (isNum(c.motivation)) {
		uma.mood = clamp(Math.round(c.motivation) - 3, -2, 2) as UmaState['mood'];
	}

	// ── Skills: owned / offered / unique level ───────────────────────────────
	const { rows, sources } = collectRows(obj);
	if (!sources.length) {
		warnings.push('The dump has no skill rows: the skill-learning screen was never opened in that session, so nothing was captured.');
	}
	const known = (id: string) => !!(skilldata as Record<string, any>)[id];
	const owned: string[] = [];
	const offered: string[] = [];
	let dropped = 0;
	let uniqueLv = 0;
	for (const r of rows) {
		if (!isNum(r.SkillId)) continue;
		const id = String(r.SkillId);
		if (!known(id)) { dropped++; continue; }
		if (r.IsGet === 1) {
			owned.push(id);
			// 11xxxx is the character's unique skill; its level is the app's uniqueLv.
			if (/^11\d{4}$/.test(id) && isNum(r.Level)) uniqueLv = Math.max(uniqueLv, clamp(Math.round(r.Level), 1, 6));
		} else {
			offered.push(id);
		}
	}
	if (owned.length) uma.skills = owned;
	if (uniqueLv) uma.uniqueLv = uniqueLv;
	if (dropped) warnings.push(`${dropped} skill id(s) in the dump are not in the local skill table and were skipped.`);

	const hints = collectHints(rows, Array.isArray(obj.skillHints?.items) ? obj.skillHints.items : [], warnings);
	checkDiscounts(rows, obj.skillTipsObserved, warnings);

	const hintsTable = obj.skillHints;
	if (hintsTable && isNum(hintsTable.count) && isNum(hintsTable.shown) && hintsTable.count > hintsTable.shown) {
		warnings.push(`The dump could only read ${hintsTable.shown} of ${hintsTable.count} hint entries (its list walk caps at 48); hint levels for the rest are missing.`);
	}

	// ── SP budget ────────────────────────────────────────────────────────────
	const budget = isNum(obj.skillPoint) ? Math.max(0, Math.round(obj.skillPoint)) : null;
	if (budget == null) warnings.push('Skill points were not readable, so the SP budget was left as it was.');

	const parts = [displayName(obj)];
	if (uma.strategy) parts.push(`${uma.strategy} ${uma.strategyAptitude ?? ''}`.trim());
	if (statsIn) parts.push(`${uma.speed}/${uma.stamina}/${uma.power}/${uma.guts}/${uma.wisdom}`);
	if (owned.length) parts.push(`${owned.length} skill${owned.length > 1 ? 's' : ''}`);
	if (offered.length) parts.push(`${offered.length} offered`);
	if (budget != null) parts.push(`${budget} SP`);
	if (hints.size) parts.push(`${hints.size} hint levels`);

	return {
		file, uma, hints, budget, owned, offered,
		summary: parts.join(' · '),
		warnings,
	};
}

/**
 * One-shot file picker. Resolves null when the user cancels, the file is not a
 * career dump, or it does not parse — never rejects, so the caller can just show
 * what came back.
 */
export function pickCareerDump(): Promise<CareerImport | null> {
	return new Promise((resolve) => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.json,application/json';
		input.onchange = async () => {
			const file = (input.files && input.files[0]) || null;
			if (!file) { resolve(null); return; }
			let imp: CareerImport | null = null;
			try {
				imp = convertCareerDump(JSON.parse(await file.text()), file.name);
				if (!imp) {
					alert(`${file.name} is not a Hachimi career dump (it needs "kind": "${CAREER_DUMP_KIND}").`);
				}
			} catch (e) {
				alert(`${file.name} could not be read: ${e instanceof Error ? e.message : String(e)}`);
			}
			resolve(imp);
		};
		input.click();
	});
}
