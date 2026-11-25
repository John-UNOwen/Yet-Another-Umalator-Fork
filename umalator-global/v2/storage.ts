/**
 * V2 Storage Utilities
 * Save/load horse configurations to localStorage and JSON export/import
 *
 * Copyright (c) 2026 TheCing (https://github.com/TheCing/uma-tools)
 * Licensed under GPL-3.0-or-later
 */

import { UmaState, defaultUmaState } from './uma-panel';
import umas from '../umas.json'; // Use global version for English names
import skilldata from '../skill_data.json'; // Use Global version
import courseData from '../course_data.json';
import { tryParseImportText } from '../../components/gameExportParser';

// LocalStorage keys
const HORSE_SLOTS_KEY = 'umalator_v2_horse_slots';
const FOLDERS_KEY = 'umalator_v2_trainee_folders';
const SESSION_KEY = 'umalator_v2_session';
const PREFERENCES_KEY = 'umalator_v2_prefs';

// ============================================
// VALIDATION
// ============================================

const VALID_STRATEGIES = ['Nige', 'Senkou', 'Sasi', 'Oikomi', 'Oonige'];
const VALID_APTITUDES = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];

/**
 * Validate and parse JSON into UmaState
 */
export function validateAndParseUmaJson(json: any): UmaState | null {
	if (!json || typeof json !== 'object') return null;

	// Check required numeric fields
	const numericFields = ['speed', 'stamina', 'power', 'guts', 'wisdom', 'mood'];
	for (const field of numericFields) {
		// Finite too: NaN is a number, and the engine adapter rejects it on every run.
		if (typeof json[field] !== 'number' || !Number.isFinite(json[field])) return null;
	}

	// Check required string fields
	const stringFields = ['strategy', 'distanceAptitude', 'surfaceAptitude', 'strategyAptitude'];
	for (const field of stringFields) {
		if (typeof json[field] !== 'string') return null;
	}

	// Validate strategy
	if (!VALID_STRATEGIES.includes(json.strategy)) return null;

	// Validate aptitudes
	if (!VALID_APTITUDES.includes(json.distanceAptitude)) return null;
	if (!VALID_APTITUDES.includes(json.surfaceAptitude)) return null;
	if (!VALID_APTITUDES.includes(json.strategyAptitude)) return null;

	// Validate mood: an integer from -2 to 2, as the engine requires (a
	// fractional mood passed here and then failed every run).
	if (!Number.isInteger(json.mood) || json.mood < -2 || json.mood > 2) return null;

	// Validate skills is an array
	if (!Array.isArray(json.skills)) return null;

	// Filter valid skill IDs
	const validSkills = json.skills.filter((id: any) => {
		if (typeof id !== 'string') return false;
		const baseId = id.split('-')[0];
		return (skilldata as Record<string, any>)[baseId];
	});

	// Parse forcedSkillPositions - validate it's an object with string values
	let forcedSkillPositions: Record<string, string> = {};
	if (json.forcedSkillPositions && typeof json.forcedSkillPositions === 'object') {
		for (const [skillId, pos] of Object.entries(json.forcedSkillPositions)) {
			if (typeof pos === 'string' && pos.trim()) {
				forcedSkillPositions[skillId] = pos;
			}
		}
	}

	return {
		outfitId: typeof json.outfitId === 'string' ? json.outfitId : '',
		// Whole numbers, as the engine requires: a fractional value passed here
		// and then failed every run.
		starCount: Number.isFinite(json.starCount) ? Math.max(1, Math.min(5, Math.round(json.starCount))) : 3,
		uniqueLv: Number.isFinite(json.uniqueLv) ? Math.max(1, Math.min(6, Math.round(json.uniqueLv))) : 1, // 6 = adapter MAX_UNIQUE_LV
		// The game's stats are whole numbers, so a typed 1200.5 is rounded like the star count.
		speed: Math.max(1, Math.min(2000, Math.round(json.speed))),
		stamina: Math.max(1, Math.min(2000, Math.round(json.stamina))),
		power: Math.max(1, Math.min(2000, Math.round(json.power))),
		guts: Math.max(1, Math.min(2000, Math.round(json.guts))),
		wisdom: Math.max(1, Math.min(2000, Math.round(json.wisdom))),
		strategy: json.strategy,
		distanceAptitude: json.distanceAptitude,
		surfaceAptitude: json.surfaceAptitude,
		strategyAptitude: json.strategyAptitude,
		mood: json.mood,
		skills: validSkills,
		forcedSkillPositions,
	};
}

// ============================================
// LOCALSTORAGE SLOTS
// ============================================

export interface SavedSlot {
	name: string;
	data: UmaState;
	savedAt: number;
	memo?: string;  // User-editable notes
	folder?: string;  // Folder name, or undefined for ungrouped
}

// ============================================
// TRAINEE FOLDERS
// ============================================

export interface TraineeFolder {
	name: string;
	order: number;
	collapsed: boolean;
}

/**
 * Get all saved horse slots from localStorage (raw)
 */
export function getHorseSlots(): Record<string, { data: any; savedAt: number; memo?: string; folder?: string }> {
	try {
		const stored = localStorage.getItem(HORSE_SLOTS_KEY);
		return stored ? JSON.parse(stored) : {};
	} catch (e) {
		console.error('Failed to load horse slots:', e);
		return {};
	}
}

/**
 * Get all saved slots as an array with validated data
 */
export function getAllSavedSlots(): SavedSlot[] {
	const slots = getHorseSlots();
	const result: SavedSlot[] = [];

	for (const [name, slot] of Object.entries(slots)) {
		const data = validateAndParseUmaJson(slot.data);
		if (data) {
			result.push({
				name,
				data,
				savedAt: slot.savedAt || 0,
				memo: slot.memo || '',
				folder: slot.folder,
			});
		}
	}

	// Sort by savedAt descending (most recent first)
	return result.sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * Get list of saved slot names
 */
export function getSavedSlotNames(): string[] {
	const slots = getHorseSlots();
	return Object.keys(slots).sort((a, b) => {
		const timeA = slots[a].savedAt || 0;
		const timeB = slots[b].savedAt || 0;
		return timeB - timeA; // Most recent first
	});
}

/**
 * Save a horse to a named slot
 * If memo is not provided, preserves existing memo (for updates)
 */
export function saveHorseSlot(name: string, horse: UmaState, memo?: string, folder?: string): boolean {
	try {
		const slots = getHorseSlots();
		const existing = slots[name];

		slots[name] = {
			data: horse,
			savedAt: Date.now(),
			memo: memo !== undefined ? memo : existing?.memo || '',
			folder: folder !== undefined ? folder : existing?.folder,
		};
		localStorage.setItem(HORSE_SLOTS_KEY, JSON.stringify(slots));
		return true;
	} catch (e) {
		console.error('Failed to save horse slot:', e);
		return false;
	}
}

/**
 * Load a horse from a named slot
 */
export function loadHorseSlot(name: string): UmaState | null {
	const slots = getHorseSlots();
	if (!slots[name]) return null;
	return validateAndParseUmaJson(slots[name].data);
}

/**
 * Delete a horse slot by name
 */
export function deleteHorseSlot(name: string): boolean {
	try {
		const slots = getHorseSlots();
		delete slots[name];
		localStorage.setItem(HORSE_SLOTS_KEY, JSON.stringify(slots));
		return true;
	} catch (e) {
		console.error('Failed to delete horse slot:', e);
		return false;
	}
}

/**
 * Update the memo for a saved slot
 */
export function updateSlotMemo(name: string, memo: string): boolean {
	try {
		const slots = getHorseSlots();
		if (!slots[name]) return false;

		slots[name].memo = memo;
		localStorage.setItem(HORSE_SLOTS_KEY, JSON.stringify(slots));
		return true;
	} catch (e) {
		console.error('Failed to update slot memo:', e);
		return false;
	}
}

/**
 * Get all trainee folders sorted by order
 */
export function getFolders(): TraineeFolder[] {
	try {
		const stored = localStorage.getItem(FOLDERS_KEY);
		if (!stored) return [];
		const folders: Record<string, { order: number; collapsed: boolean }> = JSON.parse(stored);
		return Object.entries(folders)
			.map(([name, f]) => ({ name, order: f.order, collapsed: f.collapsed }))
			.sort((a, b) => a.order - b.order);
	} catch (e) {
		console.error('Failed to load folders:', e);
		return [];
	}
}

function saveFoldersRaw(folders: Record<string, { order: number; collapsed: boolean }>): void {
	localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders));
}

function loadFoldersRaw(): Record<string, { order: number; collapsed: boolean }> {
	try {
		const stored = localStorage.getItem(FOLDERS_KEY);
		return stored ? JSON.parse(stored) : {};
	} catch {
		return {};
	}
}

/**
 * Create a new folder
 */
export function createFolder(name: string): boolean {
	try {
		const folders = loadFoldersRaw();
		if (folders[name]) return false; // Already exists
		const maxOrder = Object.values(folders).reduce((m, f) => Math.max(m, f.order), -1);
		folders[name] = { order: maxOrder + 1, collapsed: false };
		saveFoldersRaw(folders);
		return true;
	} catch (e) {
		console.error('Failed to create folder:', e);
		return false;
	}
}

/**
 * Delete a folder (ungroups contained builds, does not delete them)
 */
export function deleteFolder(name: string): boolean {
	try {
		const folders = loadFoldersRaw();
		delete folders[name];
		saveFoldersRaw(folders);

		// Ungroup all builds in this folder
		const slots = getHorseSlots();
		for (const slot of Object.values(slots)) {
			if (slot.folder === name) {
				delete slot.folder;
			}
		}
		localStorage.setItem(HORSE_SLOTS_KEY, JSON.stringify(slots));
		return true;
	} catch (e) {
		console.error('Failed to delete folder:', e);
		return false;
	}
}

/**
 * Rename a folder and update all slot references
 */
export function renameFolder(oldName: string, newName: string): boolean {
	if (!newName.trim() || oldName === newName) return false;
	try {
		const folders = loadFoldersRaw();
		if (!folders[oldName] || folders[newName]) return false;
		folders[newName] = folders[oldName];
		delete folders[oldName];
		saveFoldersRaw(folders);

		// Update slot references
		const slots = getHorseSlots();
		for (const slot of Object.values(slots)) {
			if (slot.folder === oldName) {
				slot.folder = newName;
			}
		}
		localStorage.setItem(HORSE_SLOTS_KEY, JSON.stringify(slots));
		return true;
	} catch (e) {
		console.error('Failed to rename folder:', e);
		return false;
	}
}

/**
 * Move a slot to a folder (or ungroup with null)
 */
export function moveSlotToFolder(slotName: string, folder: string | null): boolean {
	try {
		const slots = getHorseSlots();
		if (!slots[slotName]) return false;
		if (folder) {
			slots[slotName].folder = folder;
		} else {
			delete slots[slotName].folder;
		}
		localStorage.setItem(HORSE_SLOTS_KEY, JSON.stringify(slots));
		return true;
	} catch (e) {
		console.error('Failed to move slot to folder:', e);
		return false;
	}
}

/**
 * Toggle folder collapsed state
 */
export function toggleFolderCollapsed(name: string): boolean {
	try {
		const folders = loadFoldersRaw();
		if (!folders[name]) return false;
		folders[name].collapsed = !folders[name].collapsed;
		saveFoldersRaw(folders);
		return true;
	} catch (e) {
		console.error('Failed to toggle folder:', e);
		return false;
	}
}

// ============================================
// JSON EXPORT/IMPORT
// ============================================

/**
 * Export horse state as JSON file download
 */
export function downloadHorseJson(horse: UmaState): void {
	const blob = new Blob([JSON.stringify(horse, null, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;

	// Generate filename from character name
	let name = 'horse';
	if (horse.outfitId) {
		const uma = (umas as any)[horse.outfitId.slice(0, 4)];
		if (uma?.name?.[1]) {
			name = uma.name[1].replace(/\s+/g, '_');
		}
	}
	a.download = `${name}.json`;
	a.click();
	URL.revokeObjectURL(url);
}

/**
 * A parsed import candidate: one uma from one uploaded file.
 */
export interface ImportCandidate {
	name: string;     // source file name (display + fallback)
	data: UmaState;   // parsed + validated
}

/**
 * Open a MULTI-select JSON file picker, parse each file (one uma per file), and
 * return all valid candidates plus the names of files that failed to parse.
 * Never rejects; invalid files are skipped.
 */
export function importHorseJsonMulti(): Promise<{ candidates: ImportCandidate[]; skipped: string[] }> {
	return new Promise((resolve) => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.json,application/json';
		input.multiple = true;

		input.onchange = async (e) => {
			const files = Array.from((e.target as HTMLInputElement).files || []);
			if (files.length === 0) {
				resolve({ candidates: [], skipped: [] });
				return;
			}

			const candidates: ImportCandidate[] = [];
			const skipped: string[] = [];

			for (const file of files) {
				try {
					const text = await file.text();
					const json = tryParseImportText(text);
					const parsed = json ? validateAndParseUmaJson(json) : null;
					if (parsed) {
						candidates.push({ name: file.name, data: parsed });
					} else {
						skipped.push(file.name);
					}
				} catch (err) {
					console.error('Failed to parse JSON file:', file.name, err);
					skipped.push(file.name);
				}
			}

			resolve({ candidates, skipped });
		};

		input.oncancel = () => resolve({ candidates: [], skipped: [] });
		input.click();
	});
}

/**
 * Copy horse state to clipboard as JSON
 */
export async function copyHorseToClipboard(horse: UmaState): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(JSON.stringify(horse, null, 2));
		return true;
	} catch (e) {
		console.error('Failed to copy to clipboard:', e);
		return false;
	}
}

/**
 * Paste horse state from clipboard
 */
export async function pasteHorseFromClipboard(): Promise<UmaState | null> {
	try {
		const text = await navigator.clipboard.readText();
		const json = tryParseImportText(text);
		return json ? validateAndParseUmaJson(json) : null;
	} catch (e) {
		console.error('Failed to paste from clipboard:', e);
		return null;
	}
}

// ============================================
// SESSION STATE PERSISTENCE
// ============================================

/**
 * Full session state that gets auto-saved
 */
export interface SessionState {
	// Course & conditions
	courseId: number;
	selectedPresetId: number | null;
	ground: number;
	weather: number;
	season: number;
	time: number;
	// Simulation settings
	samples: number;
	mode: 'compare' | 'skill' | 'optimizer';
	// Uma states
	uma1: UmaState;
	uma2: UmaState;
	// The race seed and the GlobalSim field, so a reload repeats the same races
	field?: FieldSettings;
}

/** The settings beside the builds that decide which races run. */
export interface FieldSettings {
	seed?: number;
	paired?: boolean;
	layout?: 'mob' | 'h2h';
	gate?: number | 'auto';
	preset?: string;
}

/** The field settings a stored session or a link may carry. Anything out of
 *  range is dropped, so the app keeps its own value for that setting. */
export function parseFieldSettings(json: unknown): FieldSettings {
	if (!json || typeof json !== 'object') return {};
	const j = json as Record<string, unknown>;
	const out: FieldSettings = {};
	if (typeof j.seed === 'number' && Number.isInteger(j.seed) && j.seed >= 0 && j.seed <= 0xFFFFFFFF) out.seed = j.seed;
	if (typeof j.paired === 'boolean') out.paired = j.paired;
	if (j.layout === 'mob' || j.layout === 'h2h') out.layout = j.layout;
	if (j.gate === 'auto' || (typeof j.gate === 'number' && Number.isInteger(j.gate) && j.gate >= 0 && j.gate <= 8)) out.gate = j.gate;
	if (typeof j.preset === 'string' && j.preset.length <= 64) out.preset = j.preset;
	return out;
}

/** A race condition read from a session or a link: the value when it is a
 *  member of the engine's enum, else the default. An out-of-range value used
 *  to load and then fail every run, on every visit after. */
function conditionOf(v: unknown, lo: number, hi: number, fallback: number): number {
	return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : fallback;
}
const groundOf = (v: unknown) => conditionOf(v, 1, 4, 1); // GroundCondition
const weatherOf = (v: unknown) => conditionOf(v, 1, 4, 1); // Weather
const seasonOf = (v: unknown) => conditionOf(v, 1, 5, 4); // Season, Sakura = 5
const timeOf = (v: unknown) => conditionOf(v, 0, 4, 2); // Time

/**
 * Save session state to localStorage
 */
export function saveSession(state: SessionState): boolean {
	try {
		localStorage.setItem(SESSION_KEY, JSON.stringify(state));
		return true;
	} catch (e) {
		console.error('Failed to save session:', e);
		return false;
	}
}

/** The course to load: a stored or shared id only when the app has that course.
 *  Any other number (a hand-edited session, a crafted link) reaches RaceTrack's
 *  course lookup and blanks the page, so it falls back to the default course. */
export function knownCourseId(id: unknown, fallback = 10506): number {
	return typeof id === 'number' && Object.prototype.hasOwnProperty.call(courseData, String(id)) ? id : fallback;
}

/**
 * Load session state from localStorage
 */
export function loadSession(): SessionState | null {
	try {
		const stored = localStorage.getItem(SESSION_KEY);
		if (!stored) return null;

		const json = JSON.parse(stored);

		// Validate and return with defaults for missing fields
		return {
			courseId: knownCourseId(json.courseId),
			selectedPresetId: json.selectedPresetId ?? null,
			ground: groundOf(json.ground),
			weather: weatherOf(json.weather),
			season: seasonOf(json.season),
			time: timeOf(json.time),
			samples: typeof json.samples === 'number' ? Math.max(1, Math.min(10000, json.samples)) : 500,
			// All three modes come back as saved (Optimizer used to load as Compare).
			mode: json.mode === 'skill' || json.mode === 'optimizer' ? json.mode : 'compare',
			uma1: validateAndParseUmaJson(json.uma1) || defaultUmaState,
			uma2: validateAndParseUmaJson(json.uma2) || defaultUmaState,
			field: parseFieldSettings(json.field),
		};
	} catch (e) {
		console.error('Failed to load session:', e);
		return null;
	}
}

/**
 * Clear session state
 */
export function clearSession(): void {
	try {
		localStorage.removeItem(SESSION_KEY);
	} catch (e) {
		console.error('Failed to clear session:', e);
	}
}

// ============================================
// USER PREFERENCES
// ============================================

/**
 * Valid color palette names
 */
export type ColorPalette = 'uma-green' | 'sage-green' | 'vibrant-coral' | 'majorelle-blue' | 'alice-blue' | 'vintage-grape';

export const COLOR_PALETTES: ColorPalette[] = ['uma-green', 'sage-green', 'vibrant-coral', 'majorelle-blue', 'alice-blue', 'vintage-grape'];

/**
 * User preferences that persist across sessions
 */
export interface Preferences {
	darkMode: boolean;
	/** Glassmorphic surfaces. Orthogonal to darkMode -- composes with both modes and every accent. */
	glassMode: boolean;
	colorPalette: ColorPalette;
	notificationDismissed: string; // ID of the last dismissed notification, or '' if none
	uiScale: number; // UI scale percentage (80-120, default 100)
}

const DEFAULT_PREFERENCES: Preferences = {
	darkMode: true,
	glassMode: false,
	colorPalette: 'sage-green',
	notificationDismissed: '',
	uiScale: 100,
};

/**
 * Save user preferences
 */
export function savePreferences(prefs: Partial<Preferences>): boolean {
	try {
		const current = loadPreferences();
		const updated = { ...current, ...prefs };
		localStorage.setItem(PREFERENCES_KEY, JSON.stringify(updated));
		return true;
	} catch (e) {
		console.error('Failed to save preferences:', e);
		return false;
	}
}

/**
 * Load user preferences
 */
export function loadPreferences(): Preferences {
	try {
		const stored = localStorage.getItem(PREFERENCES_KEY);
		if (!stored) return DEFAULT_PREFERENCES;

		const json = JSON.parse(stored);

		// Migrate old classicGreen boolean to colorPalette string
		let colorPalette: ColorPalette = DEFAULT_PREFERENCES.colorPalette;
		if (typeof json.colorPalette === 'string' && COLOR_PALETTES.includes(json.colorPalette)) {
			colorPalette = json.colorPalette;
		} else if (typeof json.classicGreen === 'boolean') {
			// Migration: old classicGreen=true -> sage-green
			colorPalette = json.classicGreen ? 'sage-green' : 'uma-green';
		}

		return {
			darkMode: typeof json.darkMode === 'boolean' ? json.darkMode : DEFAULT_PREFERENCES.darkMode,
			glassMode: typeof json.glassMode === 'boolean' ? json.glassMode : DEFAULT_PREFERENCES.glassMode,
			colorPalette,
			notificationDismissed: typeof json.notificationDismissed === 'string' ? json.notificationDismissed : DEFAULT_PREFERENCES.notificationDismissed,
			uiScale: typeof json.uiScale === 'number' && json.uiScale >= 80 && json.uiScale <= 120 ? json.uiScale : DEFAULT_PREFERENCES.uiScale,
		};
	} catch (e) {
		console.error('Failed to load preferences:', e);
		return DEFAULT_PREFERENCES;
	}
}

// ============================================
// URL STATE SERIALIZATION
// ============================================

/**
 * State that can be shared via URL
 */
export interface ShareableState {
	courseId: number;
	ground: number;
	weather: number;
	season: number;
	time: number;
	samples: number;
	uma1: UmaState;
	uma2: UmaState;
	skillHints?: Record<string, number>;  // skill id → hint level; only non-zero saved. Optional for backward compat with older links.
	// Optional so older links still load: the mode and the settings that decide
	// which races run, so the receiver measures the same experiment.
	mode?: 'compare' | 'skill' | 'optimizer';
	field?: FieldSettings;
}

// A hash starting with this prefix is plain base64 JSON, written by browsers
// without CompressionStream (iOS Safari below 16.4, Firefox below 113). Every
// other hash is the gzip form. Base64 never contains '~', so the two cannot clash.
const PLAIN_HASH_PREFIX = '~';
// The largest link JSON the app reads. A real link is a few KB, and gzip packs
// text about 1000:1, so a crafted hash could otherwise expand to gigabytes.
const MAX_HASH_JSON = 1_000_000;

const toBase64 = (bytes: Uint8Array): string => {
	let bin = '';
	for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(bin);
};
const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

/** True when this browser can read the gzip share links other browsers write. */
export function canReadCompressedLinks(): boolean {
	return typeof DecompressionStream !== 'undefined';
}

/**
 * Serialize state to a compressed URL hash
 */
export async function serializeStateToHash(state: ShareableState): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(state));
	if (typeof CompressionStream === 'undefined') return PLAIN_HASH_PREFIX + encodeURIComponent(toBase64(bytes));
	const zipped = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
	const buf = new Uint8Array(await new Response(zipped).arrayBuffer());
	return encodeURIComponent(toBase64(buf));
}

/** Reads a hash into its JSON text, or throws. */
async function hashJson(hash: string): Promise<string> {
	if (hash.startsWith(PLAIN_HASH_PREFIX)) {
		const json = new TextDecoder().decode(fromBase64(decodeURIComponent(hash.slice(PLAIN_HASH_PREFIX.length))));
		if (json.length > MAX_HASH_JSON) throw new Error('share link too large');
		return json;
	}
	if (!canReadCompressedLinks()) throw new Error('this browser cannot read compressed share links');
	const unzipped = new Blob([fromBase64(decodeURIComponent(hash)) as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
	const reader = unzipped.getReader();
	const dec = new TextDecoder();
	let json = '';
	for (;;) {
		const result = await reader.read();
		if (result.done) break;
		json += dec.decode(result.value, { stream: true });
		if (json.length > MAX_HASH_JSON) {
			await reader.cancel();
			throw new Error('share link too large');
		}
	}
	return json + dec.decode();
}

/**
 * Deserialize state from a URL hash
 */
export async function deserializeStateFromHash(hash: string): Promise<ShareableState | null> {
	try {
		const parsed = JSON.parse(await hashJson(hash));

		// Validate and return
		const uma1 = validateAndParseUmaJson(parsed.uma1);
		const uma2 = validateAndParseUmaJson(parsed.uma2);
		if (!uma1 || !uma2) return null;

		return {
			courseId: knownCourseId(parsed.courseId),
			ground: groundOf(parsed.ground),
			weather: weatherOf(parsed.weather),
			season: seasonOf(parsed.season),
			time: timeOf(parsed.time),
			// Clamp like the Samples input (sim-settings.tsx) — a crafted link
			// must not hand globalsimSeedList a huge unclamped count (§6.3).
			samples: typeof parsed.samples === 'number' ? Math.max(1, Math.min(10000, parsed.samples)) : 500,
			uma1,
			uma2,
			skillHints: (parsed.skillHints && typeof parsed.skillHints === 'object') ? parsed.skillHints : {},
			mode: parsed.mode === 'compare' || parsed.mode === 'skill' || parsed.mode === 'optimizer' ? parsed.mode : undefined,
			field: parseFieldSettings(parsed.field),
		};
	} catch (e) {
		console.error('Failed to deserialize state from hash:', e);
		return null;
	}
}

/**
 * Build the shareable URL and copy it. `url` is set even when the clipboard
 * write fails (no permission, an insecure page), so the caller can show it.
 */
export async function copyShareableUrl(state: ShareableState): Promise<{ copied: boolean; url: string | null }> {
	let url: string | null = null;
	try {
		const hash = await serializeStateToHash(state);
		url = window.location.protocol + '//' + window.location.host + window.location.pathname + '#' + hash;
		await navigator.clipboard.writeText(url);
		return { copied: true, url };
	} catch (e) {
		console.error('Failed to copy shareable URL:', e);
		return { copied: false, url };
	}
}
