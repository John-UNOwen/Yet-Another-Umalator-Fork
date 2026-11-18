import skillnames from '../skillnames.json';

/** The name to show for a skill. skillnames.json keeps the live name first and any retired name after it,
 *  so index 0 is what the game calls it now. Readers that took the last element showed retired names. */
export function skillDisplayName(id: string, fallback = id): string {
	return (skillnames as Record<string, string[]>)[id]?.[0] ?? fallback;
}
