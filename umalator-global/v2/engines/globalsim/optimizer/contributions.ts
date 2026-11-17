/**
 * The worth of each skill in a finished build: that build against the same
 * build minus one skill, read out of the search's transposition cache. Every
 * local-search round races that neighbourhood (search.ts), so the numbers come
 * from races already paid for.
 */

import type { PairedDiff } from './evaluator';
import type { ContributionDiff, SkillContribution } from './types';

const diffOf = (d: PairedDiff | null): ContributionDiff | null =>
	d ? { mean: d.mean, ci95: d.ci95, seeds: d.n } : null;

/**
 * One row per skill of `selection`, in that order. `measure` returns the paired
 * differences for dropping that skill, null for either one the search never
 * raced (pruned before its first race, or evicted).
 */
export function contributionsOf(
	selection: readonly string[],
	measure: (id: string) => { lead: PairedDiff | null; win: PairedDiff | null },
): SkillContribution[] {
	return selection.map((id) => {
		const m = measure(id);
		return { id, lead: diffOf(m.lead), win: diffOf(m.win) };
	});
}

/** True when the 95% interval sits clear of zero, so the run resolved a difference. */
export function resolvedDiff(ci: readonly [number, number]): boolean {
	return Number.isFinite(ci[0]) && Number.isFinite(ci[1]) && (ci[1] < 0 || ci[0] > 0);
}

/** Half the 95% interval, the "±" a row prints. */
export function ciHalfWidth(ci: readonly [number, number]): number {
	return (ci[1] - ci[0]) / 2;
}
