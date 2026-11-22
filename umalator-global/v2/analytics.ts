/**
 * Cookieless usage counts through GoatCounter (https://www.goatcounter.com).
 *
 * The site code comes from the GOATCOUNTER_CODE build variable, baked in as
 * CC_GOATCOUNTER. Builds without it (local dev, forks) load nothing and send
 * nothing. GoatCounter also ignores localhost on its own.
 *
 * What is sent: the page path and query (so `?preset=8` shows up, the hash
 * with a shared build never does), the bare event names below, and with each
 * run a few category events (course, distance, ground, running style, preset).
 * No stats, skills or results. An ad blocker or a failed load turns every call
 * into a no-op, so analytics can never break the app.
 */

declare const CC_GOATCOUNTER: string;

export type AnalyticsEvent =
	| 'compare-run'
	| 'skill-chart-run'
	| 'optimizer-run'
	| 'copy-link'
	| 'ocr-import'
	| 'career-import';

/** Run events also send the current run's category events. */
const RUN_EVENTS: ReadonlySet<AnalyticsEvent> = new Set(['compare-run', 'skill-chart-run', 'optimizer-run']);

type Hit = { path: string; title: string };
type GoatCounter = { count: (vars: { path: string; title?: string; event?: boolean }) => void };

// The site code is the subdomain label. "umalator", "umalator.goatcounter.com" and
// "https://umalator.goatcounter.com/" all mean the same site; anything else is unset.
const rawCode = (typeof CC_GOATCOUNTER === 'string' ? CC_GOATCOUNTER : '')
	.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\.goatcounter\.com\/?.*$/, '');
const code = /^[a-z0-9-]{1,63}$/.test(rawCode) ? rawCode : '';

// Hits fired before count.js has loaded wait here, and are flushed on load.
const queue: Hit[] = [];
let runContext: Hit[] = [];

function counter(): GoatCounter | undefined {
	return (window as unknown as { goatcounter?: GoatCounter }).goatcounter;
}

function send(hit: Hit): void {
	try {
		counter()?.count({ path: hit.path, title: hit.title, event: true });
	} catch {
		// Analytics must never surface an error to the user.
	}
}

function hit(h: Hit): void {
	if (counter()) send(h);
	else if (queue.length < 40) queue.push(h);
}

/** Loads count.js, which counts the page view. Call once at startup. */
export function initAnalytics(): void {
	if (!code || typeof document === 'undefined') return;
	const s = document.createElement('script');
	s.async = true;
	s.src = 'https://gc.zgo.at/count.js';
	s.dataset.goatcounter = `https://${code}.goatcounter.com/count`;
	s.onload = () => queue.splice(0).forEach(send);
	document.head.appendChild(s);
}

/** Counts one usage event; a run event also counts the current run context. */
export function track(name: AnalyticsEvent): void {
	if (!code) return;
	hit({ path: name, title: name });
	if (RUN_EVENTS.has(name)) runContext.forEach(hit);
}

// --- Run categories ----------------------------------------------------------

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Global English names. The engine's GroundCondition.Good is the game's 良, Global "Firm".
const DISTANCE = ['', 'Sprint', 'Mile', 'Medium', 'Long'];
const SURFACE = ['', 'Turf', 'Dirt'];
const GROUND = ['', 'Firm', 'Good', 'Soft', 'Heavy'];
const STYLE: Record<string, string> = {
	Nige: 'Front Runner',
	Senkou: 'Pace Chaser',
	Sasi: 'Late Surger',
	Oikomi: 'End Closer',
	Oonige: 'Runaway',
};

export interface RunContextInput {
	courseId: number | string;
	trackName?: string;
	distance?: number;
	distanceType?: number;
	surface?: number;
	ground?: number;
	strategy?: string;
	/** e.g. "CM 22" plus the event name; omitted for a custom race. */
	preset?: { key: string; title: string } | null;
}

/**
 * Sets the categories sent with every run event: one hit each for the course,
 * distance class, ground, running style and preset. Low-cardinality labels only,
 * so each shows up as one row with a count in the GoatCounter dashboard.
 */
export function setRunContext(c: RunContextInput): void {
	const out: Hit[] = [];
	const surface = SURFACE[c.surface ?? 0] ?? '';
	const courseTitle = [c.trackName, c.distance ? `${c.distance}m` : '', surface].filter(Boolean).join(' ');
	out.push({ path: `course/${c.courseId}`, title: courseTitle || `Course ${c.courseId}` });
	const distance = DISTANCE[c.distanceType ?? 0];
	if (distance) out.push({ path: `distance/${slug(distance)}`, title: distance });
	const ground = GROUND[c.ground ?? 0];
	if (ground) out.push({ path: `ground/${slug(ground)}`, title: ground });
	const style = c.strategy ? STYLE[c.strategy] : undefined;
	if (style) out.push({ path: `style/${slug(style)}`, title: style });
	out.push(c.preset
		? { path: `preset/${slug(c.preset.key)}`, title: c.preset.title }
		: { path: 'preset/custom', title: 'Custom race' });
	runContext = out;
}
