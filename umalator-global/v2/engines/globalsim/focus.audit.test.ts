/**
 * Audit of focus.ts against GlobalSim itself: every skill the rules drop from the
 * pool must never fire in the engine on that setup.
 *
 * Runs the vendored stdin worker (vendor/GlobalSim/target/release/race_engine_rs_v2,
 * built with `cargo build --release --no-default-features`). Each request holds nine
 * runners with one excluded skill each, at level 3, over 200 seeds.
 *
 * The gate has to be able to fail, so it carries controls:
 * - a copy of 200042 with its condition forced to always==1 must fire, or the
 *   harness counts nothing and proves nothing
 * - two broken rule sets (OR read as AND, unknown atoms read as impossible) must
 *   drop skills the engine then fires
 *
 * Skips with a message when the worker binary is missing. Run via
 * npm run test:optimizer:slow.
 */
import test from 'tape';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { factOut, raceFacts, RaceConditions, RaceCourse, RaceFacts } from './focus';
import courseFile from '../../../course_data.json';
import skilldata from '../../../skill_data.json';

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const sim = path.join(repoRoot, 'vendor', 'GlobalSim');
const EXE = process.platform === 'win32' ? '.exe' : '';
const worker = path.join(sim, 'target', 'release', `race_engine_rs_v2${EXE}`);
const merged = JSON.parse(fs.readFileSync(path.join(repoRoot, 'globalsim', 'skills.merged.json'), 'utf8')) as Record<string, any>;

type Alt = { condition?: string; precondition?: string };
const table = skilldata as Record<string, { alternatives?: Alt[] }>;
const courses = courseFile as unknown as Record<string, RaceCourse>;

const STRATEGY = 'Senkou';
const CONDS: RaceConditions = { ground: 1, weather: 1, season: 1, time: 2 };
const ENGINE_CONDS = { groundCondition: 'Good', weather: 'Sunny', season: 'Spring', time: 'Midday' };
const SETUPS = ['10611', '10912', '10107'];
const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);
const RUNNERS = 9;

/** The skills the app can offer: learnable ids the engine table covers. */
const offerable = Object.keys(merged).filter(id => id.length === 6 && id[0] === '2' && table[id]).sort();

/**
 * A second reading of the rules, so the controls can break one piece at a time.
 * With both switches off it must agree with factOut exactly.
 */
const TERM = /^([a-z_][a-z_0-9]*)\s*(==|!=|>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/;
function outUnder(id: string, facts: RaceFacts, mode: { orAsAnd?: boolean; unknownImpossible?: boolean }): boolean {
	const alts = table[id]?.alternatives ?? [];
	if (!alts.length) return false;
	const branchOut = (branch: string) => branch.split('&').some(raw => {
		const term = raw.trim();
		const m = TERM.exec(term);
		if (!m) return false;
		const fact = facts.values[m[1]];
		if (fact === undefined || m[2] !== '==') return !!mode.unknownImpossible && fact === undefined;
		const want = Number(m[3]);
		return fact instanceof Set ? !fact.has(want) : fact !== want;
	});
	const condOut = (cond: string) => {
		const text = mode.orAsAnd ? cond.replace(/@/g, '&') : cond;
		const branches = text.split('@').filter(b => b.trim());
		return branches.length > 0 && branches.every(branchOut);
	};
	return alts.every(a => condOut(a.precondition ?? '') || condOut(a.condition ?? ''));
}

/** The engine's entry for a skill, with the fields it requires filled for skill_data.json copies. */
function engineEntry(id: string): any {
	if (merged[id]) return merged[id];
	return { wisdomCheck: 0, priority: 0, tags: [], isGeneralSkill: true, ...(table as any)[id] };
}

let template: any;
function loadTemplate(): any {
	if (template) return template;
	const ex = JSON.parse(fs.readFileSync(path.join(sim, 'examples', 'v77-race.jsonl'), 'utf8').split('\n')[0]);
	delete ex.retainAllFrames;
	delete ex.dataSignature;
	delete ex.seed;
	template = ex;
	return ex;
}

/** Activations per skill id over SEEDS, with each runner holding one of `ids`. */
function activations(courseId: string, ids: string[], overrides: Record<string, any> = {}): Map<string, number> {
	const ex = loadTemplate();
	const counts = new Map<string, number>(ids.map(id => [id, 0]));
	for (let i = 0; i < ids.length; i += RUNNERS) {
		const batch = ids.slice(i, i + RUNNERS);
		const skillData = { ...ex.skillData };
		for (const id of batch) skillData[id] = overrides[id] ?? engineEntry(id);
		const request = {
			...ex,
			...ENGINE_CONDS,
			courseId: Number(courseId),
			skillData,
			omitFrames: true,
			seeds: SEEDS,
			threads: 2,
			horses: ex.horses.map((h: any, r: number) => ({
				...h,
				strategy: STRATEGY,
				skills: r < batch.length ? [{ skillId: batch[r], level: 3 }] : [],
			})),
		};
		const res = spawnSync(worker, [], { input: JSON.stringify(request) + '\n', encoding: 'utf8', maxBuffer: 1 << 30 });
		if (res.status !== 0) throw new Error(`worker exit ${res.status}: ${res.stderr.slice(0, 400)}`);
		for (const line of res.stdout.split('\n')) {
			if (!line) continue;
			const reply = JSON.parse(line);
			if (reply.error) throw new Error(`engine error on ${courseId} [${batch}]: ${reply.error}`);
			// Attributed by skillId: non-numeric ids such as `kakari` are the engine's
			// own events, and counting by horseIndex would credit them to the skill.
			for (const ev of reply.skillEvents ?? []) {
				const sid = String(ev.skillId);
				if (counts.has(sid)) counts.set(sid, counts.get(sid)! + 1);
			}
		}
	}
	return counts;
}

const fired = (counts: Map<string, number>) => [...counts].filter(([, n]) => n > 0).map(([id]) => id);

test('the exclusion audit runs against the engine', t => {
	if (!fs.existsSync(worker)) {
		t.skip('worker binary missing: run `cargo build --release --no-default-features` in vendor/GlobalSim');
		t.end();
		return;
	}
	t.ok(offerable.length > 400, `${offerable.length} offerable skills`);

	const control = activations('10611', ['200042'], {
		'200042': { ...engineEntry('200042'), alternatives: engineEntry('200042').alternatives.map((a: any) => ({ ...a, condition: 'always==1', precondition: '' })) },
	});
	t.ok(control.get('200042')! > 0, `control: 200042 forced to always==1 fires (${control.get('200042')} activations)`);

	for (const courseId of SETUPS) {
		const facts = raceFacts(courses[courseId], CONDS, STRATEGY);
		const out = offerable.filter(id => factOut(id, facts) !== null);
		const local = offerable.filter(id => outUnder(id, facts, {}));
		t.deepEqual(local, out, `${courseId}: the audit's own reading of the rules matches factOut`);
		const wrong = fired(activations(courseId, out));
		t.comment(`${courseId}: ${out.length} of ${offerable.length} skills excluded`);
		t.deepEqual(wrong, [], `${courseId}: no excluded skill fires in the engine`);
	}
	t.end();
});

test('the audit catches broken rules', t => {
	if (!fs.existsSync(worker)) {
		t.skip('worker binary missing');
		t.end();
		return;
	}
	const courseId = '10611';
	const facts = raceFacts(courses[courseId], CONDS, STRATEGY);
	const real = new Set(offerable.filter(id => factOut(id, facts) !== null));
	for (const [name, mode] of [['OR read as AND', { orAsAnd: true }], ['unknown atoms read as impossible', { unknownImpossible: true }]] as const) {
		const extra = offerable.filter(id => !real.has(id) && outUnder(id, facts, mode));
		const wrong = fired(activations(courseId, extra));
		t.comment(`${name}: drops ${extra.length} more, of which ${wrong.length} fire (${wrong.slice(0, 8).join(', ')}${wrong.length > 8 ? ', …' : ''})`);
		t.ok(wrong.length > 0, `${name}: the audit reports violations`);
	}
	t.end();
});
