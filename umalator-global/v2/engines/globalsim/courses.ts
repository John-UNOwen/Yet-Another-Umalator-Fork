/**
 * GlobalSim course-id table loader (Phase 4).
 *
 * The adapter validates course ids against the keys of GlobalSim's bundled
 * course table; the app fetches that key set from
 * /uma-tools/globalsim/courses.json (a tiny file the build generates from
 * vendor/GlobalSim/data/course_data.json — same /uma-tools/ prefix and
 * fetch-once-cache pattern as skills.ts).
 */

let pending: Promise<Set<string> | null> | null = null;

export function loadGlobalsimCourseIds(): Promise<Set<string> | null> {
	if (!pending) {
		pending = fetch('/uma-tools/globalsim/courses.json')
			.then(r => {
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				return r.json();
			})
			.then((ids: string[]) => new Set(ids))
			.catch(e => {
				console.warn('[GlobalSim] course table unavailable:', e);
				pending = null; // don't cache failures — the next caller retries
				return null;
			});
	}
	return pending;
}
