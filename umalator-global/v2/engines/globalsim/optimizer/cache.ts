/**
 * Transposition table (SKILL-OPTIMIZER-PLAN §7.1): never evaluate the same
 * (scenario, simulation identity, seed) twice.
 *
 * - Key: namespace ‖ scenarioId ‖ identity. Search seeds and verification
 *   seeds live in SEPARATE namespaces (P3 — verification can never reuse a
 *   search seed, even by key collision of the two seed lists).
 * - Value: SeedValue slots INDEXED BY SEED POSITION in the scenario's seed
 *   list (§7.1 "indexed by seed position"), not arrival order — so merging
 *   chunks is deterministic under any thread count / completion order (§13.4).
 * - Raw SeedCompactRecords are folded to SeedValue on arrival (tail grid
 *   consumed by leadMarginL and dropped): ~40 B/seed, 100 MB ≈ 2M+ seeds.
 * - Eviction: LRU, exempting the pinned top-N keys (§14 Phase-1 memory cap).
 */

import type { SeedSlot } from './types';

export const NS_SEARCH = 's';
export const NS_VERIFY = 'v';

export interface CacheEntry {
	/** Slot per seed position; null = not evaluated yet (holes allowed). */
	values: SeedSlot[];
	/** Count of measured (non-null, non-'err') slots (maintained). */
	filled: number;
}

export interface CacheStats {
	entries: number;
	estimatedBytes: number;
	capBytes: number;
	evictions: number;
}

/** Rough per-entry byte estimate: slot array + key + object overhead. */
export function estimateBytes(key: string, slots: number): number {
	return 128 + key.length * 2 + slots * 32;
}

export class EvalCache {
	private map = new Map<string, CacheEntry>(); // Map iteration order = LRU order
	private bytes = 0;
	private evictions = 0;
	/** Seed counts requested per (ns, scenario) — search-list growth bookkeeping. */
	readonly seedDemand = new Map<string, number>();

	constructor(readonly capBytes: number) { }

	private key(ns: string, scenarioId: string, identity: string): string {
		return `${ns}\u0001${scenarioId}\u0001${identity}`;
	}

	/** Look up, touching LRU recency. */
	peek(ns: string, scenarioId: string, identity: string): CacheEntry | undefined {
		const k = this.key(ns, scenarioId, identity);
		const e = this.map.get(k);
		if (e) { this.map.delete(k); this.map.set(k, e); }
		return e;
	}

	/** Get (creating/growing to `slots` positions lazily). */
	ensure(ns: string, scenarioId: string, identity: string, slots: number): CacheEntry {
		const k = this.key(ns, scenarioId, identity);
		let e = this.map.get(k);
		if (e) {
			this.map.delete(k);
			if (e.values.length < slots) {
				// Grow: new trailing slots must be null (hole), not undefined,
				// so callers' `=== null` missing-seed filter sees them.
				const grow = slots - e.values.length;
				e.values.length = slots;
				e.values.fill(null, e.values.length - grow);
				this.bytes += grow * 32;
			}
			this.map.set(k, e);
		} else {
			e = { values: new Array<SeedSlot>(slots).fill(null), filled: 0 };
			this.bytes += estimateBytes(k, slots);
			this.map.set(k, e);
		}
		return e;
	}

	/** Fill one seed slot. 'err' marks a deterministic engine failure (never
	 *  refetched, never counted in statistics). */
	set(ns: string, scenarioId: string, identity: string, pos: number, value: SeedSlot): void {
		const e = this.ensure(ns, scenarioId, identity, pos + 1);
		if (e.values[pos] == null && value != null && value !== 'err') e.filled++;
		e.values[pos] = value;
		// Touch for LRU.
		const k = this.key(ns, scenarioId, identity);
		this.map.delete(k); this.map.set(k, e);
	}

	/**
	 * Evict LRU entries outside `pinKeys` until under cap. Returns evicted key
	 * count. Pinned entries are NEVER evicted (the cap can be temporarily
	 * exceeded by pinned data alone — search keeps its top builds on purpose).
	 */
	evict(pinKeys: ReadonlySet<string>): number {
		if (this.bytes <= this.capBytes) return 0;
		let n = 0;
		for (const k of [...this.map.keys()]) { // oldest first
			if (this.bytes <= this.capBytes) break;
			if (pinKeys.has(k)) continue;
			const e = this.map.get(k)!;
			this.bytes -= estimateBytes(k, e.values.length);
			this.map.delete(k);
			n++; this.evictions++;
		}
		return n;
	}

	stats(): CacheStats {
		return { entries: this.map.size, estimatedBytes: this.bytes, capBytes: this.capBytes, evictions: this.evictions };
	}

	/** Every cached identity in a namespace (surrogate training set). */
	identities(ns: string, scenarioId: string): string[] {
		const prefix = `${ns}\u0001${scenarioId}\u0001`;
		const out: string[] = [];
		for (const k of this.map.keys()) if (k.startsWith(prefix)) out.push(k.slice(prefix.length));
		return out;
	}

	/** Public key builder: eviction pins (search top-N) are keyed by this. */
	keyFor(ns: string, scenarioId: string, identity: string): string {
		return this.key(ns, scenarioId, identity);
	}

	clear(): void {
		this.map.clear();
		this.bytes = 0;
	}
}
