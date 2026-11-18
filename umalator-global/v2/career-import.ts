/**
 * Career import (Skill Optimizer). Two file formats, one result.
 *
 * 1. The JSON Hachimi-Edge writes from the running game (menu "Dump career
 *    data" → `career_<charaId>_<epoch>.json`, tagged `"kind": "hachimi-career-dump"`,
 *    `"version": 1`).
 * 2. A umadump career snapshot: `turns/turn_<turn>_<revision>.json` inside the
 *    `career_data/<identity>/` archive its daemon keeps while a career runs (the
 *    `single_mode_load` response, under `single_mode_load_common.chara_info`).
 *
 * Both turn into app state: the trained uma (outfit, stats, aptitudes, running style,
 * mood, learned skills) plus what the Optimizer needs to answer "what should I buy
 * with the SP I have" (hint levels, SP budget, and the skill list the game was
 * actually offering, which only the Hachimi dump carries).
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
 *   - Hint levels come from per-skill sources only: `skillTipsObserved[id]
 *     .tipsDiscount` (what the game actually charges for that skill, uncapped) and
 *     the rows' own `HintLv`. The `skillHints` table is keyed per (group, rarity)
 *     and its list walk caps at 48 items, so it is used only to report truncation -
 *     spreading one group entry over all its ids would invent levels for the other
 *     rarity tier (which the game tracks separately) and for skills the career
 *     cannot buy at all.
 *
 * The snapshot is the game's own state object rather than a probe of it, so it
 * answers the same questions through different keys (see `convertUmadumpTurn`):
 *   - `card_id` is the outfit. `rarity` is the limit-break count, which is what
 *     `starCount` counts, and stats are the career's live stats with wisdom under
 *     `wiz`, aptitudes as the same `ProperGrade` numbers and `race_running_style`
 *     as the style being run. `single_mode_chara_id` is the career's own row id
 *     (4845 for a card 101002 career) and says nothing about the character, which
 *     has to come from the first four digits of `card_id`.
 *   - `skill_tips_array` is the hint table itself: `[{group_id, rarity, level}]`,
 *     one entry per (group, rarity tier) the career has hints on. Here the tier
 *     entry is all the game reports, so it is spread over every skill id of that
 *     tier, which is what the tier means (the Hachimi path refuses to spread only
 *     because it has the per-skill discount to go on instead).
 *   - `skill_point` is the SP left, `disable_skill_id_array` what that career
 *     cannot learn. There is no offer list in a snapshot, so the pool stays the
 *     app's own set of learnable skills.
 *
 * Deliberately NOT imported: `raceEvaluations` (bond entries, `ObscuredBool` fields
 * serialized as "<obscured …>"), `acquiredSkills` (contentless), `skillMasterNames`
 * (only filled by a different capture door), `scenarioId`/`routeId`/`entryProgramId`
 * (career context with no verified mapping onto an app course), and in a snapshot the
 * race history, the fan club and support-card state, the training levels and
 * `live_data_set` (nothing in the app reads them).
 */

import umas from '../../umas.json';
import skilldata from '../skill_data.json';
import skillmeta from '../../skill_meta.json';
import type { UmaState } from './uma-panel';
import { uniqueSkillForUma } from '../../components/HorseDefTypes';

/** The Hachimi dump's tag. `version` is a literal 1 with no versioning logic behind it. */
export const CAREER_DUMP_KIND = 'hachimi-career-dump';
export const CAREER_DUMP_VERSION = 1;
/** `manifest.json` of a umadump career archive, kept so the picker can explain it. */
export const UMADUMP_ARCHIVE_TYPE = 'umadump-career';

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
	/** Skill points left in the career, when the file could read them. */
	budget: number | null;
	/** Skill ids the trainee already has (`IsGet=1`, or the snapshot's `skill_array`). */
	owned: string[];
	/** Skill ids the game was offering at dump time (`IsGet` not 1). Empty for a
	 *  umadump snapshot, which carries no offer list, so the pool is left alone. */
	offered: string[];
	/** Skill ids that career cannot learn (`disable_skill_id_array`), kept out of the pool. */
	blocked: string[];
	/** One line for the pane: who this is and what came in. */
	summary: string;
	warnings: string[];
}

/** Cheap "is this the format" test, used before any field access. */
export function isCareerDump(obj: any): boolean {
	return !!obj && typeof obj === 'object' && obj.kind === CAREER_DUMP_KIND;
}

/** The other format: a umadump `career_data/<identity>/turns/turn_*.json` snapshot. */
export function isUmadumpCareer(obj: any): boolean {
	return !!obj && typeof obj === 'object'
		&& !!obj.single_mode_load_common && typeof obj.single_mode_load_common === 'object'
		&& !!obj.single_mode_load_common.chara_info
		&& typeof obj.single_mode_load_common.chara_info === 'object';
}

/** The `manifest.json` of a umadump career archive: it names the career but holds no state. */
export function isUmadumpManifest(obj: any): boolean {
	return !!obj && typeof obj === 'object' && obj.archive_type === UMADUMP_ARCHIVE_TYPE;
}

/**
 * Merge every row source the dump carries, keyed by skill id, newest list last.
 * `short` lists the sources that arrived cut: the writer caps every list walk at
 * 48 items, and a source whose own `count` is above the rows it carries lost the
 * rest (the owned and offered lists then miss skills).
 */
function collectRows(dump: any): { rows: CareerRow[]; sources: string[]; short: { key: string; rows: number; count: number }[] } {
	const byId = new Map<number, CareerRow>();
	const sources: string[] = [];
	const short: { key: string; rows: number; count: number }[] = [];
	for (const [key, block] of [
		['skillRowsObserved', dump.skillRowsObserved],
		['skillLearningScreen', dump.skillLearningScreen],
	] as [string, any][]) {
		const list = block?.rows;
		if (!Array.isArray(list)) continue;
		const kept = list.filter((r) => isNum(r?.SkillId));
		if (!kept.length) continue;
		sources.push(key);
		if (isNum(block.count) && block.count > list.length) short.push({ key, rows: list.length, count: block.count });
		for (const r of kept) byId.set(r.SkillId, r as CareerRow);
	}
	return { rows: [...byId.values()], sources, short };
}

/** Discount % → hint count on the shared ladder, or -1 when it is off the ladder. */
const ladderOf = (pct: number): number => HINT_DISCOUNT.indexOf(pct);

interface HintResult {
	/** skillId → hint level, only where a level above 0 is known. */
	hints: Map<string, number>;
	/** Every skill whose hint state is known, including a known "no hint". */
	sourced: Set<string>;
}

/**
 * Hint levels, per skill: `skillTipsObserved[id].tipsDiscount` first (it is exactly
 * what the game charges for that skill, and this door is not subject to the writer's
 * 48-item list cap), the rows' own `HintLv` for any skill that door never reported.
 * Nothing is spread across a group - see the module header.
 */
function collectHints(rows: CareerRow[], tips: Record<string, any> | undefined, warnings: string[]): HintResult {
	const hints = new Map<string, number>();
	const sourced = new Set<string>();
	const known = (id: string) => !!(skilldata as Record<string, any>)[id];
	let offLadder = 0;
	let disagree = 0;

	for (const [id, t] of Object.entries(tips ?? {})) {
		if (!isNum(t?.tipsDiscount) || !known(id)) continue;
		const level = ladderOf(t.tipsDiscount);
		if (level < 0) { offLadder++; continue; }
		sourced.add(id);
		if (level > 0) hints.set(id, level);
	}
	for (const r of rows) {
		if (!isNum(r.SkillId) || !isNum(r.HintLv)) continue;
		const id = String(r.SkillId);
		if (!known(id)) continue;
		// Both sources speak the same ladder; where they disagree the per-skill
		// discount (already applied above) is the one the game is using. Only a
		// discount that is on the ladder can disagree with anything.
		const t = tips?.[id];
		const tipLevel = t && isNum(t.tipsDiscount) ? ladderOf(t.tipsDiscount) : -1;
		if (tipLevel >= 0 && HINT_DISCOUNT[tipLevel] !== HINT_DISCOUNT[clamp(Math.round(r.HintLv), 0, 5)]) disagree++;
		if (sourced.has(id)) continue;
		sourced.add(id);
		const level = clamp(Math.round(r.HintLv), 0, 5);
		if (level > 0) hints.set(id, level);
	}
	if (disagree) {
		warnings.push(`${disagree} skill(s) have a row hint level that disagrees with their own hint discount; the discount was used.`);
	}
	if (offLadder) {
		warnings.push(`${offLadder} skill(s) report a hint discount that is not on the 0/10/20/30/35/40 ladder; their hint level was left unset.`);
	}
	return { hints, sourced };
}

function displayName(cardId: string, charaId = ''): string {
	const entry = outfitEntry(cardId);
	if (entry) return entry.epithet ? `${entry.name} ${entry.epithet}` : entry.name;
	const uma = (umas as Record<string, any>)[charaId];
	if (!uma) return cardId || charaId || 'unknown uma';
	return Array.isArray(uma.name) ? (uma.name[1] ?? charaId) : charaId;
}

/** The outfit's entry in the local uma data, found by card id (`101002` is outfit 02 of 1010). */
function outfitEntry(cardId: string): { charaId: string; name: string; epithet?: string } | null {
	for (const [charaId, u] of Object.entries(umas as Record<string, any>)) {
		const outfit = u?.outfits?.[cardId];
		if (!outfit) continue;
		const name = Array.isArray(u.name) ? (u.name[1] ?? charaId) : charaId;
		return { charaId, name, epithet: typeof outfit === 'string' ? outfit : outfit.epithet };
	}
	return null;
}

/** The five stats, read from whichever object carries them. Returns how many came in. */
function applyStats(uma: Partial<UmaState>, src: Record<string, any>, warnings: string[]): number {
	const statMap: [string, string][] = [
		['speed', 'speed'], ['stamina', 'stamina'], ['power', 'power'],
		['guts', 'guts'], ['wisdom', 'wiz'],
	];
	let statsIn = 0;
	for (const [dest, key] of statMap) {
		if (isNum(src[key])) {
			(uma as Record<string, number>)[dest] = Math.round(src[key]);
			statsIn++;
		}
	}
	if (statsIn < statMap.length) warnings.push(`Only ${statsIn} of 5 stats were readable.`);
	return statsIn;
}

/**
 * Aptitudes and the running style, both read as the game's `ProperGrade` numbers
 * (1=G … 8=S) under the Hachimi names: `distanceShort` … `distanceLong`,
 * `groundTurf`, `runningStyle`, `styleNige`/`styleSenko`/`styleSashi`/`styleOikomi`.
 */
function applyAptitudes(uma: Partial<UmaState>, apt: Record<string, any>, warnings: string[]): void {
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
}

/** Game motivation 0..5 (None…Max) → app mood -2..2. */
function applyMood(uma: Partial<UmaState>, motivation: unknown): void {
	if (isNum(motivation)) {
		uma.mood = clamp(Math.round(motivation) - 3, -2, 2) as UmaState['mood'];
	}
}

/** The outfit's own unique skill id at either star tier (1-2 stars and 3+ stars use different ids). */
function uniqueIdsFor(cardId: unknown): Set<string> {
	if (!isNum(cardId)) return new Set();
	return new Set([uniqueSkillForUma(String(cardId), 1), uniqueSkillForUma(String(cardId), 3)].filter(Boolean));
}

/**
 * Convert a parsed career file of either format into app state. Returns null only
 * when the object is neither format. A file with holes in it converts with warnings.
 */
export function convertCareerDump(obj: any, file = 'career dump'): CareerImport | null {
	if (isCareerDump(obj)) return convertHachimiDump(obj, file);
	if (isUmadumpCareer(obj)) return convertUmadumpCareer(obj, file);
	return null;
}

function convertHachimiDump(dump: any, file: string): CareerImport {
	const warnings: string[] = [];
	if (isNum(dump.version) && dump.version !== CAREER_DUMP_VERSION) {
		warnings.push(`Dump format version ${dump.version}; this reader knows version ${CAREER_DUMP_VERSION}.`);
	}

	const uma: Partial<UmaState> = {};
	const c = dump.character ?? {};
	const apt = dump.aptitudes ?? {};
	const stats = dump.stats ?? {};

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
		// 0..4 limit breaks is 1 to 5 stars, and the star level picks which unique skill the app uses.
		uma.starCount = clamp(Math.round(c.limitBreakCount) + 1, 1, 5);
	}

	const statsIn = applyStats(uma, stats, warnings);
	applyAptitudes(uma, apt, warnings);
	applyMood(uma, c.motivation);

	// ── Skills: owned / offered / unique level ───────────────────────────────
	const { rows, sources, short } = collectRows(dump);
	if (!sources.length) {
		warnings.push('The dump has no skill rows: the skill-learning screen was never opened in that session, so nothing was captured.');
	} else if (short.length === sources.length) {
		// Every source is cut, so no list holds the whole career. One full source
		// is enough: the merge is by skill id.
		const detail = short.map((x) => `${x.key} ${x.rows} of ${x.count}`).join(', ');
		warnings.push(`The dump's skill rows arrived truncated (${detail}; the writer caps its list walks at 48), so learned and offered skills may be missing. Check the uma's skills and the pool after the import.`);
	}
	const known = (id: string) => !!(skilldata as Record<string, any>)[id];
	const owned: string[] = [];
	const offered: string[] = [];
	let dropped = 0;
	let uniqueLv = 0;
	// The unique skill id pattern depends on the outfit: 100xxx for outfit 01,
	// 110xxx for 02, 120xxx for 03, so only the outfit can name it.
	const uniqueIds = uniqueIdsFor(c.cardId);
	for (const r of rows) {
		if (!isNum(r.SkillId)) continue;
		const id = String(r.SkillId);
		if (!known(id)) { dropped++; continue; }
		if (r.IsGet === 1) {
			owned.push(id);
			// The outfit's unique skill row: its level is the app's uniqueLv.
			if (uniqueIds.has(id) && isNum(r.Level)) uniqueLv = Math.max(uniqueLv, clamp(Math.round(r.Level), 1, 6));
		} else {
			offered.push(id);
		}
	}
	if (owned.length) uma.skills = owned;
	if (uniqueLv) uma.uniqueLv = uniqueLv;
	if (dropped) warnings.push(`${dropped} skill id(s) in the dump are not in the local skill table and were skipped.`);

	const { hints, sourced } = collectHints(rows, dump.skillTipsObserved, warnings);

	// The writer caps every list walk at 48 items, so the hint TABLE can arrive short.
	// Whether that costs anything depends on the per-skill sources: a skill whose own
	// discount was read needs nothing from the table.
	const hintsTable = dump.skillHints;
	if (hintsTable && isNum(hintsTable.count) && isNum(hintsTable.shown) && hintsTable.count > hintsTable.shown) {
		const blind = [...offered, ...owned].filter((id) => !sourced.has(id));
		const head = `The dump's hint table arrived truncated (${hintsTable.shown} of ${hintsTable.count} entries; the writer caps its list walks at 48)`;
		warnings.push(blind.length
			? `${head}, and ${blind.length} skill(s) have no hint level from any source.`
			: `${head}, but every skill the career carries reported its own discount, so no hint level was lost.`);
	}

	// ── SP budget ────────────────────────────────────────────────────────────
	const budget = isNum(dump.skillPoint) ? Math.max(0, Math.round(dump.skillPoint)) : null;
	if (budget == null) warnings.push('Skill points were not readable, so the SP budget was left as it was.');

	const parts = [displayName(String(c.cardId ?? ''), String(c.charaId ?? ''))];
	if (uma.strategy) parts.push(`${uma.strategy} ${uma.strategyAptitude ?? ''}`.trim());
	if (statsIn) parts.push(`${uma.speed}/${uma.stamina}/${uma.power}/${uma.guts}/${uma.wisdom}`);
	if (owned.length) parts.push(`${owned.length} skill${owned.length > 1 ? 's' : ''}`);
	if (offered.length) parts.push(`${offered.length} offered`);
	if (budget != null) parts.push(`${budget} SP`);
	if (hints.size) parts.push(`${hints.size} hint levels`);

	return {
		file, uma, hints, budget, owned, offered, blocked: [],
		summary: parts.join(' · '),
		warnings,
	};
}

/**
 * Convert one umadump career snapshot (`career_data/<identity>/turns/turn_<turn>_<revision>.json`)
 * into app state. A file with holes in it converts with warnings instead.
 */
function convertUmadumpCareer(snap: any, file: string): CareerImport {
	const warnings: string[] = [];
	const c = snap.single_mode_load_common.chara_info ?? {};
	const uma: Partial<UmaState> = {};

	// ── Outfit + card level ───────────────────────────────────────────────────
	let outfitKnown = false;
	if (isNum(c.card_id)) {
		const outfitId = String(c.card_id);
		uma.outfitId = outfitId;
		outfitKnown = !!outfitEntry(outfitId);
		if (!outfitKnown) {
			warnings.push(`Outfit ${outfitId} is not in the local uma data; the build was imported without a portrait.`);
		}
	} else {
		warnings.push('No card_id in the snapshot, so the outfit was left as it was.');
	}
	if (isNum(c.rarity)) {
		// umadump copies the limit-break count here, so 0..4 is 1 to 5 stars.
		uma.starCount = clamp(Math.round(c.rarity) + 1, 1, 5);
	}

	const statsIn = applyStats(uma, c, warnings);
	applyAptitudes(uma, snapshotAptitudes(c), warnings);
	applyMood(uma, c.motivation);

	// ── Skills: owned, unique level, and what that career cannot learn ───────
	const known = (id: string) => !!(skilldata as Record<string, any>)[id];
	const owned: string[] = [];
	let dropped = 0;
	let uniqueLv = 0;
	const uniqueIds = uniqueIdsFor(c.card_id);
	for (const s of Array.isArray(c.skill_array) ? c.skill_array : []) {
		if (!isNum(s?.skill_id)) continue;
		const id = String(s.skill_id);
		if (!known(id)) { dropped++; continue; }
		owned.push(id);
		if (uniqueIds.has(id) && isNum(s.level)) uniqueLv = Math.max(uniqueLv, clamp(Math.round(s.level), 1, 6));
	}
	if (owned.length) uma.skills = owned;
	if (uniqueLv) uma.uniqueLv = uniqueLv;
	if (dropped) warnings.push(`${dropped} skill id(s) in the snapshot are not in the local skill table and were skipped.`);

	const blocked: string[] = [];
	for (const id of Array.isArray(c.disable_skill_id_array) ? c.disable_skill_id_array : []) {
		if (isNum(id) && known(String(id))) blocked.push(String(id));
	}

	const hints = snapshotHints(c.skill_tips_array, warnings);
	warnings.push('A snapshot has no skill offer list, so the Optimizer pool was left as it is. It shows every skill the app can offer, not only what this career could buy.');

	const budget = isNum(c.skill_point) ? Math.max(0, Math.round(c.skill_point)) : null;
	if (budget == null) warnings.push('Skill points were not readable, so the SP budget was left as it was.');

	const parts = [displayName(String(c.card_id ?? ''))];
	if (isNum(c.turn)) parts.push(`turn ${Math.round(c.turn)}`);
	if (uma.strategy) parts.push(`${uma.strategy} ${uma.strategyAptitude ?? ''}`.trim());
	if (statsIn) parts.push(`${uma.speed}/${uma.stamina}/${uma.power}/${uma.guts}/${uma.wisdom}`);
	if (owned.length) parts.push(`${owned.length} skill${owned.length > 1 ? 's' : ''}`);
	if (budget != null) parts.push(`${budget} SP`);
	if (hints.size) parts.push(`${hints.size} hint levels`);

	return {
		file, uma, hints, budget, owned, offered: [], blocked,
		summary: parts.join(' · '),
		warnings,
	};
}

/** The snapshot's `proper_*` grades under the names `applyAptitudes` reads. */
function snapshotAptitudes(c: Record<string, any>): Record<string, any> {
	return {
		distanceShort: c.proper_distance_short,
		distanceMile: c.proper_distance_mile,
		distanceMiddle: c.proper_distance_middle,
		distanceLong: c.proper_distance_long,
		groundTurf: c.proper_ground_turf,
		runningStyle: c.race_running_style,
		styleNige: c.proper_running_style_nige,
		styleSenko: c.proper_running_style_senko,
		styleSashi: c.proper_running_style_sashi,
		styleOikomi: c.proper_running_style_oikomi,
	};
}

/** Every local skill id in one (group, rarity) hint tier, built once per tier. */
const tierCache = new Map<string, string[]>();
function tierSkills(groupId: number, rarity: number): string[] {
	const key = `${groupId}|${rarity}`;
	let ids = tierCache.get(key);
	if (!ids) {
		const group = String(groupId);
		ids = Object.keys(skilldata).filter((id) =>
			String((skillmeta as Record<string, any>)[id]?.groupId ?? '') === group
			&& (skilldata as Record<string, any>)[id]?.rarity === rarity);
		tierCache.set(key, ids);
	}
	return ids;
}

/**
 * Hint levels from `skill_tips_array`: one entry per (group, rarity) tier the career
 * has hints on, and that tier is the unit the game tracks, so its level is set on
 * every local skill id inside it. A tier at level 0 is written too, which clears a
 * level a previous import left behind.
 */
function snapshotHints(tips: unknown, warnings: string[]): Map<string, number> {
	const hints = new Map<string, number>();
	if (!Array.isArray(tips)) {
		warnings.push('The snapshot has no skill_tips_array, so no hint levels were imported.');
		return hints;
	}
	let unknownTiers = 0;
	for (const t of tips) {
		if (!isNum(t?.group_id) || !isNum(t?.rarity) || !isNum(t?.level)) continue;
		const ids = tierSkills(Math.round(t.group_id), Math.round(t.rarity));
		if (!ids.length) { unknownTiers++; continue; }
		const level = clamp(Math.round(t.level), 0, HINT_DISCOUNT.length - 1);
		for (const id of ids) hints.set(id, level);
	}
	if (unknownTiers) {
		warnings.push(`${unknownTiers} hint tier(s) in the snapshot match no skill in the local skill table.`);
	}
	return hints;
}

/**
 * One-shot file picker. Resolves null when the user cancels, the file is neither
 * career format, or it does not parse. It never rejects, so the caller can just
 * show what came back.
 */
export function pickCareerDump(): Promise<CareerImport | null> {
	return new Promise((resolve) => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.json,application/json';
		// Cancelling the dialog fires `cancel`, never `change`.
		input.addEventListener('cancel', () => resolve(null));
		input.onchange = async () => {
			const file = (input.files && input.files[0]) || null;
			if (!file) { resolve(null); return; }
			let imp: CareerImport | null = null;
			let why = '';
			try {
				const parsed = JSON.parse(await file.text());
				imp = convertCareerDump(parsed, file.name);
				if (!imp && isUmadumpManifest(parsed)) {
					why = `${file.name} is the manifest of a umadump career archive. Pick one of its turns/turn_*.json files instead.`;
				} else if (!imp) {
					why = `${file.name} is neither a Hachimi career dump (it needs "kind": "${CAREER_DUMP_KIND}") nor a umadump career snapshot (it needs "single_mode_load_common").`;
				}
			} catch (e) {
				why = `${file.name} could not be read: ${e instanceof Error ? e.message : String(e)}`;
			}
			if (why) alert(why);
			resolve(imp);
		};
		input.click();
	});
}
