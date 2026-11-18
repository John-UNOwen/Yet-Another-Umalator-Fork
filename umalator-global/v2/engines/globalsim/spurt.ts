/**
 * Full spurt, judged in the app from what the engine already reports.
 *
 * At the start of the final leg the engine plans the last spurt
 * (vendor/GlobalSim/src/retail_spurt.rs `choose`). Result 1 is the full
 * spurt: maximum spurt speed from the current position, because the HP left
 * covers the rest of the race at that speed. Otherwise the plan delays the
 * spurt or lowers its speed (result 2), or gives it up (results 4 and 8).
 * The reply does not carry that result, so this file repeats the result-1
 * test with the engine's float32 arithmetic:
 *
 *   - Position and HP on the planning tick come from the engine's own frames
 *     (metrics.ts spurtPlanPoint, globalsim-wasm spurt_plan_point).
 *   - Speed and guts are rebuilt from the runner spec the request carried,
 *     plus the green stat skills the player activated in that race.
 *   - A heal after the final leg starts makes the engine plan again
 *     (race_solver_retail.rs, pending HP). The frames show each one as an HP
 *     rise (spurtHeals), and the race is full when any plan is.
 *
 * Each step names the engine function it ports. The constants are the
 * values of vendor/GlobalSim/data/global_parameters.json.
 *
 * Assumption: green stat skills fire at the gate, before the engine captures
 * the base target speed and the HP guts factor (true of every stat skill in
 * the table, whose conditions are race facts such as track or weather).
 * When a skill has several alternatives, its base-stat terms pick the one
 * that fired (Strong Steps by power). If alternatives that change speed or
 * guts differently remain, every combination is judged, and a race whose
 * combinations disagree gets no verdict.
 */
import type { GlobalSimRunner } from './adapter';

const f = Math.fround;

/** retail_physics.rs bounded_stat. */
const bounded = (v: number) => Math.min(2000, Math.max(1, v));
/** retail_physics.rs root: float argument, double sqrt, float result. */
const root = (v: number) => f(Math.sqrt(v));

// global_parameters.json, as float32.
const COURSE_BASE_SPEED = 20, COURSE_BASE_DISTANCE = 2000, COURSE_DISTANCE_RATE = 1000;
/** PhaseBaseTargetSpeedPerArray[style].End, then PerExArray[0].End for Oonige. */
const PHASE_END = [96.19999694824219, 97.5, 99.4000015258789, 100, 95];
const END_SPEED_SQRT = 500;                  // PhaseEndBaseTargetSpeedCoef
const ADD_SPEED = f(0.002);                  // addSpeedParamCoef
const SPURT_BASE_ADD = f(0.01);              // lastSpurtBaseTargetSpeedAddCoef
const SPURT_SPEED_SQRT = 500;                // LastSpurtTargetSpeedCoefSqrt
const SPURT_GUTS_COEF1 = 450;                // LastSpurtTargetSpeedGutsCoef1
const SPURT_GUTS_POW = f(0.597);             // LastSpurtTargetSpeedGutsPow
const SPURT_GUTS_COEF2 = f(0.0001);          // LastSpurtTargetSpeedGutsCoef2
const SPURT_TARGET_COEF = f(1.05);           // baseTargetSpeedCoef
const HP_GAP = 12, HP_GAP_POW = 144, HP_DEC_BASE = 20, HP_RATE_NORMAL = 1; // SpeedGapParam1, …Pow, HpDecBase, HpDecRateBaseNormal
const HP_GUTS_SQRT = 600, HP_GUTS_COEF = 200; // HpGutsCoefSqrt, HpGutsCoef
/** retail_spurt.rs SearchParameters::default().buffer. */
const SPURT_BUFFER = 60;

/** race_solver_builder.rs GROUND_SPEED_MODIFIER [surface][ground]. */
const GROUND_SPEED = [[0, 0, 0, 0, 0], [0, 0, 0, 0, -50], [0, 0, 0, 0, -50]];
/** hp_policy.rs HP_CONSUMPTION_GROUND_MODIFIER [surface][ground]. */
const HP_GROUND = [[0, 0, 0, 0, 0], [0, 1, 1, 1.02, 1.02], [0, 1, 1, 1.01, 1.02]];
/** Distance aptitude S..G → the engine's coefficient table index. */
const APTITUDE = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];
const APTITUDE_COEF = [10500, 10000, 9000, 8000, 6000, 4000, 2000, 1000];
const STRATEGY: Record<string, number> = { nige: 1, senkou: 2, sasi: 3, sashi: 3, oikomi: 4, oonige: 5 };
const GROUND: Record<string, number> = { good: 1, yielding: 2, soft: 3, heavy: 4 };

/** Effect types (race_solver_builder.rs valid_skill_type). */
const SPEED_UP = 1, GUTS_UP = 4, RECOVERY = 9, ALL_STATUS_UP = 32, RUNAWAY = 6;
/** How far (HP) a heal estimate may sit from a skill's exact heal and still be it.
 *  One tick's drain changes by far less; the smallest heal is tens of HP. */
const HEAL_MATCH_HP = 2;

/** The course fields the spurt plan reads (course_data.json, identical to the engine's table). */
export interface SpurtCourse {
	distance: number;
	surface: number;
	courseSetStatus: number[];
}

/** The record fields the judge reads (metrics.ts SeedCompactRecord). */
export interface SpurtRecord {
	spurtPlanPos?: number;
	spurtPlanHp?: number;
	spurtHeals?: Array<[number, number, number, number]>;
	spurtMaxHp?: number;
	skillActivations?: Record<string, number>;
}

/** Returns true for a full spurt, false for any other plan, null when it cannot tell. */
export type FullSpurtJudge = (rec: SpurtRecord) => boolean | null;

interface SkillEffect { type: number; modifier: number; levelModifiers?: number[] }
interface SkillEntry { alternatives?: { condition?: string; effects?: SkillEffect[] }[] }

/** retail_initialization.rs initial_base_wisdom over race_solver_builder.rs adjust_overcap. */
function baseStat(raw: number, mood: number): number {
	const over = raw > 1200 ? 1200 + (raw - 1200) / 2 : raw;
	const coefficient = f(f(10000 + 200 * Math.min(2, Math.max(-2, mood))) * f(0.0001));
	return bounded(f(f(over) * coefficient));
}

/** course_data.rs course_speed_modifier: a float accumulator from 1. */
function courseModifier(status: number[], base: number[]): number {
	const count = status.filter((s) => s !== 0).length;
	if (count === 0) return 1;
	let coefficient = f(1);
	for (const stat of status) {
		if (stat === 0) continue;
		const value = f(base[stat]);
		const term = value <= 300 ? f(0.05) : value <= 600 ? f(0.1) : value <= 900 ? f(0.15) : value <= 2000 ? f(0.2) : 0;
		coefficient = f(coefficient + f(term / count));
	}
	return coefficient;
}

/** race_solver_builder.rs retail_skill_value with the level multiplier. */
function skillValue(effect: SkillEffect, level: number): number {
	const lv = Math.min(10, Math.max(1, Math.trunc(level) || 1));
	const multiplier = effect.levelModifiers?.[lv - 1] ?? 1;
	const units = multiplier * 10000;
	const integral = Math.round(units);
	const coefficient = Math.abs(units - integral) < 1e-7 ? f(f(integral) * f(0.0001)) : f(multiplier);
	return f(f(f(effect.modifier) * f(0.0001)) * coefficient);
}

const COMPARE: Record<string, (a: number, b: number) => boolean> = {
	'==': (a, b) => a === b, '!=': (a, b) => a !== b, '>=': (a, b) => a >= b,
	'<=': (a, b) => a <= b, '>': (a, b) => a > b, '<': (a, b) => a < b,
};

/**
 * Whether an alternative's condition can hold, judged on its base-stat terms
 * only (`@` separates OR clauses, `&` joins AND terms, every other term
 * counts as true). This is how Strong Steps picks its alternative by power.
 */
function baseTermsHold(condition: string | undefined, baseStats: Record<string, number>): boolean {
	if (!condition) return true;
	return condition.split('@').some((clause) => clause.split('&').every((term) => {
		const m = /^(base_\w+)(==|!=|>=|<=|>|<)(-?\d+(?:\.\d+)?)$/.exec(term.trim());
		if (!m || !(m[1] in baseStats)) return true;
		return COMPARE[m[2]](baseStats[m[1]], Number(m[3]));
	}));
}

/** A skill's possible (speed, guts) additions, one per distinct alternative that can fire. */
function statOptions(skill: SkillEntry | undefined, level: number, baseStats: Record<string, number>): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	for (const alt of skill?.alternatives ?? []) {
		if (!baseTermsHold(alt.condition, baseStats)) continue;
		let speed = 0, guts = 0, any = false;
		for (const e of alt.effects ?? []) {
			if (e.type !== SPEED_UP && e.type !== GUTS_UP && e.type !== ALL_STATUS_UP) continue;
			any = true;
			const v = skillValue(e, level);
			if (e.type !== GUTS_UP) speed += v;
			if (e.type !== SPEED_UP) guts += v;
		}
		if (any && !out.some(([s, g]) => s === speed && g === guts)) out.push([speed, guts]);
	}
	return out;
}

/** race_solver.rs add_stat_modifier: an unclamped float sum, clamped on store. */
function addStat(start: number, mods: number[]): number {
	let value = f(start);
	for (const m of mods) value = f(value + f(m));
	return bounded(value);
}

/**
 * Build a judge for one runner on one course. `skillData` is the engine
 * table the race ran with (compare's input.skillData, else profile-v77's).
 * Returns null when the runner cannot be judged (an unknown style, aptitude
 * or ground).
 */
export function fullSpurtJudge(
	runner: GlobalSimRunner,
	course: SpurtCourse,
	ground: string,
	skillData: Record<string, unknown>,
): FullSpurtJudge | null {
	const table = skillData as Record<string, SkillEntry>;
	let strategy = STRATEGY[runner.strategy.toLowerCase()];
	const aptIndex = APTITUDE.indexOf(runner.distanceAptitude.toUpperCase());
	const groundIndex = GROUND[ground.toLowerCase()];
	const surface = course.surface;
	if (!strategy || aptIndex < 0 || !groundIndex || !(surface === 1 || surface === 2) || !(course.distance > 0)) return null;
	// race_solver_builder.rs prepare: a Nige runner with a Runaway effect learned runs as Oonige.
	if (strategy === 1 && runner.skills.some((s) => table[s.skillId]?.alternatives?.some((a) => a.effects?.some((e) => e.type === RUNAWAY)))) strategy = 5;

	const levels = new Map(runner.skills.map((s) => [s.skillId, s.level]));
	const base = [0, runner.speed, runner.stamina, runner.power, runner.guts, runner.wisdom].map((v, i) => (i ? baseStat(v, runner.mood) : 0));
	// race_solver_builder.rs prepare: skill conditions see the base stats truncated.
	const conditionStats: Record<string, number> = {
		base_speed: Math.trunc(base[1]), base_stamina: Math.trunc(base[2]), base_power: Math.trunc(base[3]),
		base_guts: Math.trunc(base[4]), base_wiz: Math.trunc(base[5]),
	};
	const modifier = courseModifier(course.courseSetStatus ?? [], base);
	// race_solver_builder.rs build_adjusted_stats_for_mode (speed and guts only).
	const speed0 = bounded(f(base[1] * modifier + GROUND_SPEED[surface][groundIndex]));
	const guts0 = bounded(base[4]);

	const distance = f(course.distance);
	// retail_physics.rs course_speed.
	const courseSpeed = f(COURSE_BASE_SPEED - f(f(distance - COURSE_BASE_DISTANCE) / COURSE_DISTANCE_RATE));
	const aptitude = f(APTITUDE_COEF[aptIndex] * f(0.0001));
	const hpGround = f(HP_GROUND[surface][groundIndex]);

	/** retail_physics.rs base_target_speed for phase 2. */
	const baseTargetSpeed2 = (speed: number) => {
		const endAdd = f((root(f(bounded(speed) * END_SPEED_SQRT)) * aptitude) * ADD_SPEED);
		return f((f(PHASE_END[strategy - 1]) * f(0.01)) * courseSpeed + endAdd);
	};
	/** retail_physics.rs maximum_spurt_speed. */
	const maximumSpurtSpeed = (speed: number, guts: number) => {
		const baseSpeed = f(baseTargetSpeed2(speed) + courseSpeed * SPURT_BASE_ADD);
		const addition = (root(f(bounded(speed) * SPURT_SPEED_SQRT)) * aptitude) * ADD_SPEED;
		const gutsAdd = f(Math.pow(f(bounded(guts) * SPURT_GUTS_COEF1), SPURT_GUTS_POW)) * SPURT_GUTS_COEF2;
		return f((baseSpeed * SPURT_TARGET_COEF + addition) + gutsAdd);
	};

	/** The plan verdict for one (speed, guts) pair at one planning point. */
	const judge = (speed: number, guts: number, pos: number, hp: number): boolean => {
		// retail_physics.rs hp_guts_factor and hp_per_second_with_guts_factor (last leg, no state).
		const gutsFactor = f(1 + HP_GUTS_COEF / root(f(bounded(guts) * HP_GUTS_SQRT)));
		const cost = (v: number) => {
			const gap = f(f(v - courseSpeed) + HP_GAP);
			const value = f(((f(f(gap * gap) / HP_GAP_POW)) * HP_DEC_BASE * HP_RATE_NORMAL) * hpGround);
			return f(value * gutsFactor);
		};
		// retail_spurt.rs choose: the result-4 test, then the result-1 test.
		const bts = baseTargetSpeed2(speed);
		const max = maximumSpurtSpeed(speed, guts);
		const remaining = Math.max(0, f(f(distance - f(pos)) - SPURT_BUFFER));
		if (hp < f(f(remaining / bts) * cost(bts))) return false;
		return hp >= f((remaining / max) * cost(max));
	};

	// Green sets repeat across races, so their (speed, guts) pairs are cached.
	const pairsByGreens = new Map<string, Array<[number, number]> | null>();
	const pairsFor = (activations: Record<string, number> | undefined): Array<[number, number]> | null => {
		const greens: Array<Array<[number, number]>> = [];
		const keys: string[] = [];
		for (const id of Object.keys(activations ?? {}).sort()) {
			const options = statOptions(table[id], levels.get(id) ?? 1, conditionStats);
			if (!options.length) continue;
			// A self activation applies its effects once per count.
			for (let i = 0; i < (activations![id] || 0); i++) { greens.push(options); keys.push(id); }
		}
		const key = keys.join(',');
		const hit = pairsByGreens.get(key);
		if (hit !== undefined) return hit;
		let combos: Array<{ speed: number[]; guts: number[] }> = [{ speed: [], guts: [] }];
		for (const options of greens) {
			combos = combos.flatMap((c) => options.map(([s, g]) => ({ speed: s ? [...c.speed, s] : c.speed, guts: g ? [...c.guts, g] : c.guts })));
			if (combos.length > 16) { pairsByGreens.set(key, null); return null; }
		}
		const pairs = combos.map((c): [number, number] => [addStat(speed0, c.speed), addStat(guts0, c.guts)]);
		pairsByGreens.set(key, pairs);
		return pairs;
	};

	/** Every heal one activation of a skill can give, as a fraction of max HP. */
	const healOptions = (id: string): number[] => {
		const out: number[] = [];
		for (const alt of table[id]?.alternatives ?? []) {
			if (!baseTermsHold(alt.condition, conditionStats)) continue;
			for (const e of alt.effects ?? []) {
				if (e.type !== RECOVERY || !(e.modifier > 0)) continue;
				const v = skillValue(e, levels.get(id) ?? 1);
				if (!out.includes(v)) out.push(v);
			}
		}
		return out;
	};

	/**
	 * The HP each redone plan saw. A heal tick applies the heal before its own
	 * drain, so the frames show heal minus drain. The heal is the player's own
	 * recovery that matches (race_solver.rs: max HP × value, summed in float32),
	 * which gives the planning HP exactly. When none matches (a rival's drain on
	 * the same tick, say) the drain of the tick before stands in for it.
	 */
	const replanHps = (rec: SpurtRecord): Array<[number, number]> => {
		const heals = rec.spurtHeals;
		if (!heals?.length) return [];
		const maxHp = f(rec.spurtMaxHp ?? NaN);
		const amounts: number[] = [];
		for (const id of Object.keys(rec.skillActivations ?? {})) {
			for (const v of healOptions(id)) amounts.push(f(maxHp * f(v)));
		}
		const sums = [...amounts];
		for (let i = 0; i < amounts.length; i++) for (let j = i + 1; j < amounts.length; j++) sums.push(f(amounts[i] + amounts[j]));
		return heals.map(([pos, before, after, drain]): [number, number] => {
			const estimate = after - before + drain;
			let heal = estimate;
			let best = HEAL_MATCH_HP;
			for (const s of sums) if (Math.abs(s - estimate) < best) { best = Math.abs(s - estimate); heal = s; }
			const hp = Math.max(0, Math.min(maxHp, f(f(before) + f(heal))));
			return [pos, Number.isFinite(hp) ? hp : f(before + estimate)];
		});
	};

	return (rec) => {
		const pos = rec.spurtPlanPos, hp = rec.spurtPlanHp;
		if (typeof pos !== 'number' || typeof hp !== 'number' || !Number.isFinite(pos) || !Number.isFinite(hp)) return null;
		const pairs = pairsFor(rec.skillActivations);
		if (!pairs) return null;
		// retail_spurt.rs SpurtState.update: a redone plan that comes out full
		// replaces the current one, and the lastspurt condition reads it from
		// then on, so the race counts as full when any plan is.
		const plans: Array<[number, number]> = [[pos, f(hp)], ...replanHps(rec)];
		const verdict = (speed: number, guts: number) => plans.some(([p, h]) => judge(speed, guts, p, h));
		const first = verdict(pairs[0][0], pairs[0][1]);
		for (let i = 1; i < pairs.length; i++) if (verdict(pairs[i][0], pairs[i][1]) !== first) return null;
		return first;
	};
}
