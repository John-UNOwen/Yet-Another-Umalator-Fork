/**
 * Configurable site-asset base path — the ONE build-time setting behind what
 * used to be a hardcoded '/uma-tools' prefix across every app.
 *
 * Injected via the `globalThis.CC_BASE_PATH` esbuild/vite define (every
 * build.mjs define map + every vite config passes
 * JSON.stringify(process.env.CC_BASE_PATH ?? '/uma-tools')). Unset keeps the
 * historical '/uma-tools' byte-for-byte (Cloudflare Pages + dev servers today);
 * set it to '' to serve assets at the site root (custom domain / root deploy).
 *
 * Read off globalThis (no bare identifier) so this module also imports cleanly
 * under plain node/ts-node — there the fallback is what you get, and tests can
 * pre-set globalThis.CC_BASE_PATH before importing.
 */
export const BASE_PATH: string = (globalThis as any).CC_BASE_PATH ?? '/uma-tools';

/** The default base baked into data files (icons.json values etc.). */
const DEFAULT_BASE = '/uma-tools';

/**
 * Re-point a data-derived asset URL (icons.json values and anything else
 * fetched/served that embeds the default '/uma-tools' prefix) at the
 * configured BASE_PATH. Paths not under the default prefix are returned
 * unchanged, and under the default BASE_PATH this is an identity mapping
 * (byte-for-byte identical URLs).
 *
 * Non-string input (undefined/null: a `icons[id]` lookup for an id that has no
 * icons.json entry — imported/roster outfits carry unchecked ids, storage.ts)
 * is returned unchanged, so callers keep their `|| fallback` behavior instead
 * of throwing during render.
 */
export function resolveBase(raw: string): string {
	if (typeof raw !== 'string') return raw;
	return raw.startsWith(DEFAULT_BASE + '/') ? BASE_PATH + raw.slice(DEFAULT_BASE.length) : raw;
}
