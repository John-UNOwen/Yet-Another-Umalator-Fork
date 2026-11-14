/**
 * Phase 2 skill-table tests: every skills-supplement.json entry must (a) be
 * accepted by the engine when prepared inside a race using the merged active
 * table, and (b) activate at least once across the smoke situations, so a
 * ported definition that parses but never triggers is caught here.
 *
 * Smoke situation: runner 0 of the v77 example field (which has no skills)
 * gets the skill and tries each strategy in turn, 4 seeds each, stopping at
 * the first style that activates — skills gated on running_style or field
 * position must light up in SOME situation.
 *
 * Runs the vendored stdin worker (vendor/GlobalSim/target/release/
 * race_engine_rs_v2.exe, built once with `cargo build --release
 * --no-default-features`) with omitFrames:true. Skips with a message when the
 * worker binary or merged table is missing.
 *
 * Run via: npm run test:globalsim-skills
 */
import test from 'tape';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

(globalThis as any).CC_GLOBAL = true;

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const sim = path.join(repoRoot, 'vendor', 'GlobalSim');
// Rust emits no .exe outside Windows — CI (ubuntu) builds plain binaries.
const EXE = process.platform === 'win32' ? '.exe' : '';
const worker = path.join(sim, 'target', 'release', `race_engine_rs_v2${EXE}`);
const mergedTable = path.join(repoRoot, 'globalsim', 'skills.merged.json');
const supplementPath = path.join(repoRoot, 'globalsim', 'skills-supplement.json');

const STYLES = ['Nige', 'Sasi', 'Oikomi'];
const COURSES = [10504, 10207]; // turf 2000 m + dirt 1700 m (ground_type==2 skills)
const SEEDS_PER_SITUATION = 4;

// Skills the smoke situations cannot stage (engine prepare parses their
// conditions cleanly — unknown conditions fail loudly as reply errors):
//   110271/910271 want an uphill (slope region) during phase 1 while within
//     10 m of the leader; no smoke course has that window.
//   110671/910671 want order_rate 40–80 % at 40–50 % race distance; the
//     example field's runner 0 is never mid-pack in that window.
const EXPECTED_NEVER = ['110271', '110671', '910271', '910671']; // supplement id order

test('supplement entries prepare and activate in the engine', (t) => {
	if (!fs.existsSync(worker) || !fs.existsSync(mergedTable)) {
		t.skip('worker binary or globalsim/skills.merged.json missing — run `cargo build --release --no-default-features` in vendor/GlobalSim and `node tools/globalsim-coverage.mjs --out globalsim/skills.merged.json`');
		t.end();
		return;
	}
	const supplement = JSON.parse(fs.readFileSync(supplementPath, 'utf8'));
	const skillData = JSON.parse(fs.readFileSync(mergedTable, 'utf8'));
	const example = JSON.parse(fs.readFileSync(path.join(sim, 'examples', 'v77-race.jsonl'), 'utf8').split('\n')[0]);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'globalsim-skills-'));
	const neverActivated: string[] = [];
	try {
		for (const id of Object.keys(supplement)) {
			// Runner 0 of the example field (which has no skills) gets the
			// skill and cycles situations — course then strategy — until the
			// skill activates: gated skills must light up in SOME situation.
			let totalActivations = 0, totalErrors = 0, totalSeeds = 0;
			const tried: string[] = [];
			for (const course of COURSES) for (const style of STYLES) {
				if (totalActivations > 0) break;
				tried.push(`${course}/${style}`);
				const seeds = Array.from({ length: SEEDS_PER_SITUATION }, (_, i) => 1000000 + totalSeeds + i);
				const request = {
					...example,
					courseId: course,
					skillData,
					retainAllFrames: false,
					omitFrames: true, // worker-only sampling key
					seeds,
					horses: example.horses.map((h: any, i: number) => i === 0
						? { ...h, strategy: style, skills: [...(h.skills ?? []), { skillId: id, level: 1, isUnique: false }] }
						: h),
				};
				const requestFile = path.join(dir, 'request.json');
				fs.writeFileSync(requestFile, JSON.stringify(request) + '\n');
				const r = spawnSync(worker, [], {
					input: fs.readFileSync(requestFile),
					maxBuffer: 1024 * 1024 * 1024, encoding: 'utf8',
				});
				t.equal(r.status, 0, `${id} ${course}/${style}: worker exit`);
				const replies = r.stdout.split('\n').filter((l: string) => l.length > 0);
				t.equal(replies.length, seeds.length, `${id} ${course}/${style}: one reply per seed`);
				for (const line of replies) {
					const reply = JSON.parse(line);
					if (reply.error) { totalErrors++; continue; }
					for (const ev of reply.skillEvents ?? []) if (String(ev.skillId ?? ev.id) === id) totalActivations++;
				}
				totalSeeds += seeds.length;
			}
			t.equal(totalErrors, 0, `${id}: no engine errors across ${totalSeeds} seeds`);
			if (totalActivations === 0) neverActivated.push(id);
			t.comment(`${id}: ${totalActivations} activation(s) across ${totalSeeds} seeds (${tried.length} situation(s))`);
		}
		t.same(neverActivated, EXPECTED_NEVER, 'skills that never activated must match the documented terrain-gated set');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	t.end();
});

/**
 * Module-level fetch behavior (no engine needed): a transient skills.json
 * failure must not permanently disable the coverage gate — the loader retries
 * with capped backoff, and only a fully exhausted sequence returns null (and
 * that failure is not cached: the next caller starts a fresh sequence).
 */
test('skill table fetch retries transient failures with capped backoff', async (t) => {
	const { loadGlobalsimSkillTable, loadGlobalsimSkillIds, SKILL_TABLE_RETRY_DELAYS_MS } = await import('./skills');
	const origFetch = globalThis.fetch;
	const origSetTimeout = globalThis.setTimeout;
	try {
		// Collapse the real backoff so the test is instant; record the delays.
		const delays: number[] = [];
		globalThis.setTimeout = ((fn: () => void, ms?: number) => {
			delays.push(ms ?? 0);
			fn();
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;

		// Sequence 1: every attempt fails → null after 1 + 3 retries, backoff
		// capped at the documented delays.
		let calls = 0;
		globalThis.fetch = (() => {
			calls++;
			return Promise.reject(new Error('transient'));
		}) as unknown as typeof fetch;
		t.equal(await loadGlobalsimSkillTable(), null, 'exhausted sequence returns null');
		t.equal(calls, 1 + SKILL_TABLE_RETRY_DELAYS_MS.length, 'one attempt + capped retries (3 retries)');
		t.deepEqual(delays, SKILL_TABLE_RETRY_DELAYS_MS, 'backoff delays are the capped sequence');

		// Sequence 2 (fresh caller — failures are never cached): one transient
		// blip then success → the table arrives despite the blip.
		const table = { '100001': {}, '200002': {} };
		globalThis.fetch = (() => {
			calls++;
			if (calls % 2 === 1) return Promise.reject(new Error('transient blip'));
			return Promise.resolve({ ok: true, json: async () => table });
		}) as unknown as typeof fetch;
		const ids = await loadGlobalsimSkillIds();
		t.ok(ids, 'transient blip then success returns the ids');
		t.same([...(ids as Set<string>)].sort(), ['100001', '200002'], 'ids are the table keys');
		const callsAfterLoad = calls;
		t.deepEqual(await loadGlobalsimSkillTable(), table, 'success is cached for the session');
		t.equal(calls, callsAfterLoad, 'cached success triggers no further fetch');
	} finally {
		globalThis.fetch = origFetch;
		globalThis.setTimeout = origSetTimeout;
	}
	t.end();
});
