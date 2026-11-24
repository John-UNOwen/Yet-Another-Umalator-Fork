/**
 * Stage A — opening book (SKILL-OPTIMIZER-PLAN §8 A): remember strong builds
 * so a repeat of the same kind of setup starts the search near a known-good
 * point instead of from scratch. Purely a client cache (localStorage) keyed by
 * a coarse scenario fingerprint; it NEVER changes a decision (P1) — it only
 * contributes starting candidates, and only ones affordable with the CURRENT
 * purchasable list.
 *
 * Key: (course, distance category, strategy, mob preset, ground). Value: the
 * last few high-ranked builds (their option-id selections). A shipped JSON of
 * preset builds can be merged in later; the loader accepts any BookEntry[].
 */

import { BOOK_STORAGE_KEY } from './config';
import { BuildSpace } from './space';

export interface BookEntry {
	/** Option-id selection (simulation identity is derived on use). */
	selection: string[];
	/** Objective value at save time (for display / ordering only). */
	value?: number;
	/** When saved (ms epoch). */
	savedAt?: number;
}

/** The coarse fingerprint a book is shared across. Distance is bucketed so a
 *  near-distance change reuses the right neighbours; strategy + preset +
 *  ground move the optimum, so they split the key. */
export interface BookKey {
	courseId: string;
	distanceBand: string;
	strategy: string;
	mobPresetId: string;
	ground: string | number;
}

const DISTANCE_BANDS: [number, string][] = [[1200, 'sprint'], [1800, 'mile'], [2400, 'medium'], [3200, 'long'], [Infinity, 'extended']];

export function distanceBand(distance: number): string {
	for (const [hi, name] of DISTANCE_BANDS) if (distance <= hi) return name;
	return 'extended';
}

export function bookKey(k: { courseId: string; distance: number; strategy: string; mobPresetId: string; ground: string | number }): string {
	const band = distanceBand(k.distance);
	return `${k.courseId}|${band}|${k.strategy}|${k.mobPresetId}|${k.ground}`;
}

interface BookFile {
	version: 1;
	entries: Record<string, BookEntry[]>;
}

function emptyFile(): BookFile { return { version: 1, entries: {} }; }

/** Read + JSON-parse the book. Missing key (or localStorage, or bad JSON) →
 *  empty; the optimizer must never break because the book is unusable. */
export function loadBook(store?: Pick<Storage, 'getItem'>): BookFile {
	try {
		const raw = (store ?? globalThis.localStorage)?.getItem?.(BOOK_STORAGE_KEY);
		if (!raw) return emptyFile();
		const parsed = JSON.parse(raw);
		if (!parsed || parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object') return emptyFile();
		// Keep only well-formed entries, so one bad entry (an older format, or a
		// hand edit) is dropped instead of breaking every run for that race.
		const entries: Record<string, BookEntry[]> = {};
		for (const [key, list] of Object.entries(parsed.entries)) {
			if (!Array.isArray(list)) continue;
			const ok = list.filter((e: any): e is BookEntry => !!e && Array.isArray(e.selection)
				&& e.selection.every((id: unknown) => typeof id === 'string'));
			if (ok.length) entries[key] = ok;
		}
		return { version: 1, entries };
	} catch {
		return emptyFile();
	}
}

/** Merge-save the run's top builds under `key` (most-recent first, capped). */
export function saveBook(key: string, entries: BookEntry[], cap = 5, store?: Pick<Storage, 'setItem' | 'getItem'>): void {
	try {
		const s = store ?? globalThis.localStorage;
		if (!s?.setItem) return;
		const file = loadBook(store);
		const seen = new Map<string, BookEntry>();
		for (const e of [...entries, ...(file.entries[key] ?? [])]) {
			const id = [...e.selection].sort().join(',');
			if (id && !seen.has(id)) seen.set(id, e);
			if (seen.size >= cap) break;
		}
		file.entries[key] = [...seen.values()];
		s.setItem(BOOK_STORAGE_KEY, JSON.stringify(file));
	} catch {
		/* quota / disabled storage: the book is best-effort, never fatal */
	}
}

/** Saved builds under `key` (0 when there are none or storage is unusable). */
export function bookCount(key: string, store?: Pick<Storage, 'getItem'>): number {
	return loadBook(store).entries[key]?.length ?? 0;
}

/** Forget the saved builds under `key`. Best-effort like saveBook. */
export function clearBook(key: string, store?: Pick<Storage, 'setItem' | 'getItem'>): void {
	try {
		const s = store ?? globalThis.localStorage;
		if (!s?.setItem) return;
		const file = loadBook(store);
		if (!(key in file.entries)) return;
		delete file.entries[key];
		s.setItem(BOOK_STORAGE_KEY, JSON.stringify(file));
	} catch {
		/* disabled storage: nothing saved, nothing to clear */
	}
}

/** Book entries for `key` that are legal for the CURRENT space: affordable and
 *  one-per-group. These become extra Stage C restart candidates. A saved build
 *  whose skills are no longer purchasable (or now over budget) is skipped. */
export function selectStarts(space: BuildSpace, key: string, store?: Pick<Storage, 'getItem'>): string[][] {
	const entries = loadBook(store).entries[key] ?? [];
	const out: string[][] = [];
	const byId = space.byId;
	for (const e of entries) {
		const sel = e.selection.filter(id => byId.has(id) && !byId.get(id)?.forced);
		if (!sel.length) continue;
		// one option per group + within budget against the current roster.
		const groups = new Set<string>();
		let cost = 0;
		let ok = true;
		for (const id of sel) {
			const opt = byId.get(id)!;
			if (groups.has(opt.groupId)) { ok = false; break; }
			groups.add(opt.groupId);
			cost += opt.cost;
		}
		if (!ok || cost > space.budget) continue;
		const sorted = [...sel].sort();
		if (!out.some(s => s.join() === sorted.join())) out.push(sorted);
	}
	return out;
}
