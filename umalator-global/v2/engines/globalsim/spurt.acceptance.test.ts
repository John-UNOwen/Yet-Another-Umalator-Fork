/**
 * Full spurt judge (spurt.ts) against the REAL v77 engine.
 *
 * Run: npm run test:globalsim-spurt  (from the repo root)
 *
 * The oracle is a probe skill added to the player's request: condition
 * `lastspurt==2`, no wisdom check, no effect. The engine's lastspurt
 * condition reads 2 exactly when its current last spurt plan is result 1
 * (the full spurt), so the probe activates in the races the judge must call
 * full. The builds carry no recovery skill, so the plan is never redone
 * after the final leg starts and "current plan" is the first plan.
 *
 * A second check pins the planning point: on a full spurt the engine starts
 * spurting on the planning tick itself, so lastSpurtStartDistance equals
 * spurtPlanPos exactly.
 */

// Same CC_GLOBAL-before-import trick as adapter.test.ts.
(globalThis as any).CC_GLOBAL = true;

import test from 'tape';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { HorseState, SkillSet } from '../../../../components/HorseDefTypes';
import { GroundCondition, Weather, Season, Time } from '../../../../uma-skill-tools/RaceParameters';
import { parseMobPresets } from './mobs';
import { createGlobalsimWorkerCore, WasmApi } from './workerCore';
import { SeedCompactRecord } from './metrics';
import { buildCompareJobs, compareSpurtJudge, GlobalsimCompareInput } from './compare';

const repoRoot = path.resolve(__dirname, '../../../../');
const pkgDir = path.join(repoRoot, 'globalsim-wasm', 'pkg');
const geomDir = path.join(repoRoot, 'vendor', 'GlobalSim', 'data', 'course_geometry');
const courseIds: string[] = Object.keys(require(path.join(repoRoot, 'vendor/GlobalSim/data/course_data.json')));
const mobPreset = parseMobPresets(require('./mob-presets.json')).presets['default'];
const mergedTable = require(path.join(repoRoot, 'globalsim/skills.json'));
const knownSkillIds = new Set<string>(Object.keys(mergedTable));

const PROBE = '999990';
const probeTable = {
	...mergedTable,
	[PROBE]: {
		rarity: 1, wisdomCheck: 0, priority: 0, tags: [], isGeneralSkill: false,
		alternatives: [{
			condition: 'lastspurt==2', precondition: '', baseDuration: 0, durationUsage: 1, cooldown: 0,
			effects: [{ type: 0, target: 1, targetValue: 0, additionalActivate: 0, valueUsage: 1, modifier: 0 }],
		}],
	},
};

const BASE_SEED = 20261117;
const N = 50;

async function loadPkg(): Promise<WasmApi> {
	const dynImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>;
	const mod = await dynImport(pathToFileURL(path.join(pkgDir, 'globalsim_wasm.js')).href);
	const init = mod.default ?? mod.init;
	await init(fs.readFileSync(path.join(pkgDir, 'globalsim_wasm_bg.wasm')));
	return { register_geometry: (id: number, text: string) => mod.register_geometry(id, text), PreparedRace: mod.PreparedRace };
}

/** Drive workerCore (mode compact) for one prepared request. */
function runCore(request: any, seeds: number[], distance: number): Promise<SeedCompactRecord[]> {
	return new Promise((resolve, reject) => {
		const core = createGlobalsimWorkerCore({
			postMessage: (m: any) => queueMicrotask(() => {
				if (m.type === 'prepared') {
					if (!m.ok) reject(new Error(`prepare failed: ${m.error}`));
					else core.onMessage({ type: 'run', jobId: 'j1', seeds, mode: 'compact' });
				} else if (m.type === 'chunk') {
					if (m.ok) resolve(m.records);
					else reject(new Error(`chunk failed: ${m.error}`));
				}
			}),
			loadWasm: loadPkg,
			fetchText: (url) => fs.promises.readFile(path.join(geomDir, path.basename(url)), 'utf8'),
		});
		core.onMessage({ type: 'skillData', skillData: probeTable });
		core.onMessage({ type: 'prepare', id: 'p1', setupKey: 'k1', request, distance });
	});
}

interface Case {
	name: string;
	courseId: string;
	distance: number;
	ground: GroundCondition;
	stats: [number, number, number, number, number];
	strategy: string;
	distanceAptitude?: string;
	mood?: number;
	skills?: string[];
}

const CASES: Case[] = [
	// Nakayama 2500 (right-handed), spring, sunny: speed and guts greens fire.
	{ name: 'Senkou, greens, short of stamina', courseId: '10506', distance: 2500, ground: GroundCondition.Good,
		stats: [1150, 780, 1000, 600, 900], strategy: 'Senkou', skills: ['200011', '200171', '200211'] },
	{ name: 'Sasi, no greens, plenty of stamina', courseId: '10506', distance: 2500, ground: GroundCondition.Good,
		stats: [1150, 1000, 1000, 500, 900], strategy: 'Sasi', mood: 0 },
	{ name: 'Nige on heavy ground, B distance', courseId: '10506', distance: 2500, ground: GroundCondition.Heavy,
		stats: [1300, 760, 1000, 900, 800], strategy: 'Nige', distanceAptitude: 'B', mood: -1, skills: ['200011'] },
	// Kyoto 3000: a long race where the plan often falls short.
	{ name: 'Oikomi at 3000m', courseId: '10810', distance: 3000, ground: GroundCondition.Good,
		stats: [1200, 1350, 900, 700, 1000], strategy: 'Oikomi', skills: ['200171', '200211'] },
	// Runaway turns a Nige runner into Oonige (its own phase speed row).
	{ name: 'Oonige through Runaway', courseId: '10506', distance: 2500, ground: GroundCondition.Good,
		stats: [1200, 800, 1000, 700, 900], strategy: 'Nige', skills: ['202051'] },
	// Hanshin dirt 2000 (stamina and power course bonus) on soft ground.
	// Strong Steps adds 80 speed from base power 1200 and 60 below it, so
	// the judge must pick the alternative the engine fired.
	{ name: 'dirt, soft ground, Strong Steps at power 1100', courseId: '10913', distance: 2000, ground: GroundCondition.Soft,
		stats: [1150, 680, 1100, 700, 900], strategy: 'Senkou', skills: ['202331'] },
	{ name: 'dirt, soft ground, Strong Steps at power 1300', courseId: '10913', distance: 2000, ground: GroundCondition.Soft,
		stats: [1150, 680, 1300, 700, 900], strategy: 'Senkou', skills: ['202331'] },
];

for (const c of CASES) {
	test(`full spurt judge matches the engine: ${c.name}`, async t => {
		const [speed, stamina, power, guts, wisdom] = c.stats;
		const horse = new HorseState({
			speed, stamina, power, guts, wisdom,
			strategy: c.strategy, distanceAptitude: c.distanceAptitude ?? 'A', surfaceAptitude: 'A', strategyAptitude: 'A', mood: c.mood ?? 2,
		}).set('skills', SkillSet(c.skills ?? []));
		const input = {
			uma1: horse, uma2: horse,
			courseId: c.courseId, distance: c.distance,
			ground: c.ground, weather: Weather.Sunny, season: Season.Spring, time: Time.Midday,
			knownSkillIds, courseIds, mobPreset, skillData: mergedTable,
			seedBase: BASE_SEED, sampleCount: N, threads: 1, chunkSize: N,
		} as unknown as GlobalsimCompareInput;
		const seeds = Array.from({ length: N }, (_, i) => BASE_SEED + i * 7919);
		const built = buildCompareJobs(input, seeds, 'compact');
		t.equal(built.errors.length, 0, `job build errors: ${built.errors.join(' | ')}`);
		const judge = compareSpurtJudge(input, horse);
		t.ok(judge, 'judge built');

		let agree = 0, full = 0, judged = 0, startMatches = 0;
		const misses: string[] = [];
		for (const job of built.jobs.filter(j => j.id.startsWith('0|'))) {
			const request = JSON.parse(JSON.stringify(job.request));
			request.horses[request.playerHorseIndex].skills.push({ skillId: PROBE, level: 1, isUnique: false });
			const records = await runCore(request, job.seeds, c.distance);
			for (const r of records) {
				t.notOk(r.error, `seed ${r.seed} ran`);
				const engineFull = (r.skillActivations?.[PROBE] ?? 0) > 0;
				const verdict = judge!(r);
				if (verdict === null) continue;
				judged += 1;
				if (verdict === engineFull) agree += 1;
				else misses.push(`seed ${r.seed}: judge ${verdict}, engine ${engineFull}, pos ${r.spurtPlanPos}, hp ${r.spurtPlanHp}`);
				if (engineFull) {
					full += 1;
					if (r.lastSpurtStartDistance === r.spurtPlanPos) startMatches += 1;
				}
			}
		}
		t.comment(`${judged}/${N} judged, ${full} full spurts, ${agree} agree${misses.length ? '; ' + misses.slice(0, 3).join('; ') : ''}`);
		t.equal(judged, N, 'every race judged');
		t.equal(agree, judged, 'the judge agrees with the engine on every race');
		t.equal(startMatches, full, 'full spurts start on the planning tick (spurtPlanPos is the plan point)');
		t.end();
	});
}
