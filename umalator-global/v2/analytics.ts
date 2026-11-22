/**
 * Cookieless usage counts through GoatCounter (https://www.goatcounter.com).
 *
 * The site code comes from the GOATCOUNTER_CODE build variable, baked in as
 * CC_GOATCOUNTER. Builds without it (local dev, forks) load nothing and send
 * nothing. GoatCounter also ignores localhost on its own.
 *
 * What is sent: the page path and query (so `?preset=8` shows up, the hash
 * with a shared build never does), the bare event names below, and one hit per
 * run naming its preset, course, ground, distance class and running style.
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

const RUN_MODE: Partial<Record<AnalyticsEvent, string>> = {
	'compare-run': 'Compare',
	'skill-chart-run': 'Skill chart',
	'optimizer-run': 'Optimizer',
};

/**
 * Counts one usage event. A run is a single hit whose path carries every run
 * category (run/<mode>/<preset>/<course>/<ground>/<distance>/<style>): GoatCounter
 * drops hits sent in a quick burst, so separate category hits lost the last ones.
 * The dashboard's path filter totals any one category (e.g. "pace-chaser").
 */
export function track(name: AnalyticsEvent): void {
	if (!code) return;
	const mode = RUN_MODE[name];
	if (!mode) {
		hit({ path: name, title: name });
		return;
	}
	hit({
		path: ['run', slug(mode), ...runContext.map((p) => p.path)].join('/'),
		title: [mode, ...runContext.map((p) => p.title)].join(' · '),
	});
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
 * Sets the categories that go into every run hit, in path order: preset,
 * course, ground, distance class, running style. Each part is a short
 * lowercase slug for the path and a readable label for the title.
 */
export function setRunContext(c: RunContextInput): void {
	const out: Hit[] = [];
	out.push(c.preset
		? { path: slug(c.preset.key), title: c.preset.title }
		: { path: 'custom', title: 'Custom race' });
	const surface = SURFACE[c.surface ?? 0] ?? '';
	const course = [c.trackName, c.distance ? `${c.distance}m` : '', surface].filter(Boolean).join(' ');
	out.push(course ? { path: slug(course), title: course } : { path: `course-${c.courseId}`, title: `Course ${c.courseId}` });
	const ground = GROUND[c.ground ?? 0];
	if (ground) out.push({ path: slug(ground), title: ground });
	const distance = DISTANCE[c.distanceType ?? 0];
	if (distance) out.push({ path: slug(distance), title: distance });
	const style = c.strategy ? STYLE[c.strategy] : undefined;
	if (style) out.push({ path: slug(style), title: style });
	runContext = out;
}
