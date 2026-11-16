/**
 * GlobalSim input adapter (Phase 1 of the GlobalSim integration plan).
 *
 * Maps the v2 UI state (HorseState + race conditions, see
 * umalator-global/v2/simulation-utils.ts and components/HorseDefTypes.ts) to a
 * GlobalSim race-request JSON object. Contract: vendor/GlobalSim/docs/INTERFACE.md;
 * the settings profile (laneSelectionVersion … skillData) is merged verbatim from
 * ./profile-v77.json, copied from vendor/GlobalSim/examples/v77-race.jsonl.
 *
 * Rules enforced here (the engine is NOT a validation boundary — release builds
 * abort on panic, e.g. an unknown course, so everything is validated first):
 *
 *   - Stats are passed RAW. GlobalSim applies overcap halving (anything past
 *     1200 is halved) and mood itself (race_solver_builder.rs `adjust_overcap`
 *     / `base_stat`, lines 201-230) and hard-clamps the final base stat to
 *     [1, 2000] — the wiki's documented final bound. The adapter validates raw
 *     stats to finite numbers in [1, 2000] so callers never rely on that clamp
 *     to absorb junk input.
 *   - Skills are emitted as {"skillId","level","isUnique"}; the unique skill
 *     comes from uniqueSkillForUma(outfitId, starCount) with the horse's
 *     uniqueLv, everything else level 1 (same resolution the classic engine
 *     does in umalator/compare.ts:91-99).
 *   - forcedSkillPositions has no GlobalSim equivalent; positions are ignored
 *     and the caller is told through a warning so the UI can hide the control.
 *   - Determinism (§6.1): horses are emitted in canonical field order
 *     (ascending gateIndex, stable), and each horse's skill list is sorted in
 *     canonical order: ascending numeric skill_meta groupId first — matching
 *     compare.ts's "sort first by groupId so that white and gold versions of a
 *     skill get added in the same order" (umalator/compare.ts:73-76) — then
 *     ascending numeric skillId (compare.ts's `+a - +b` tiebreak).
 *   - Seeds are signed 32-bit integers (§6.3). The request carries one seed
 *     (required by PreparedRace::new), but each run overrides it via
 *     PreparedRace.run(seed).
 *
 * Errors are typed results, never thrown, for user-supplied data.
 */

import { HorseState, uniqueSkillForUma } from '../../../../components/HorseDefTypes';
import { GroundCondition, Weather, Season, Time, Grade } from '../../../../uma-skill-tools/RaceParameters';
import skillmeta from '../../../../skill_meta.json';
import profileV77 from './profile-v77.json';

// ── Enum mapping tables (uma-tools → GlobalSim) ─────────────────────────────
// uma-tools enums are numeric const enums (uma-skill-tools/RaceParameters.ts);
// GlobalSim parses these strings case-insensitively (vendor/GlobalSim/src/
// race_parameters.rs:51-107). Ground/weather/season/ground names coincide;
// Time and Grade use the engine's lowercase spellings ("midday" default,
// parse_grade accepts G1/G2/G3/OP/PREOP/MAIDEN/DEBUT/DAILY).

export const GROUND_TO_GLOBALSIM: Record<number, string> = {
	[GroundCondition.Good]: 'Good', // 良 — Firm
	[GroundCondition.Yielding]: 'Yielding', // 稍重 — Good
	[GroundCondition.Soft]: 'Soft', // 重
	[GroundCondition.Heavy]: 'Heavy', // 不良
};

export const WEATHER_TO_GLOBALSIM: Record<number, string> = {
	[Weather.Sunny]: 'Sunny',
	[Weather.Cloudy]: 'Cloudy',
	[Weather.Rainy]: 'Rainy',
	[Weather.Snowy]: 'Snowy',
};

export const SEASON_TO_GLOBALSIM: Record<number, string> = {
	[Season.Spring]: 'Spring',
	[Season.Summer]: 'Summer',
	[Season.Autumn]: 'Autumn',
	[Season.Winter]: 'Winter',
	[Season.Sakura]: 'Sakura',
};

export const TIME_TO_GLOBALSIM: Record<number, string> = {
	[Time.NoTime]: 'none',
	[Time.Morning]: 'morning',
	[Time.Midday]: 'midday',
	[Time.Evening]: 'evening',
	[Time.Night]: 'night',
};

export const GRADE_TO_GLOBALSIM: Record<number, string> = {
	[Grade.G1]: 'g1',
	[Grade.G2]: 'g2',
	[Grade.G3]: 'g3',
	[Grade.OP]: 'op',
	[Grade.PreOP]: 'preop', // parse_grade: "PRE-OP" | "PREOP" | "PRE_OP"
	[Grade.Maiden]: 'maiden',
	[Grade.Debut]: 'debut',
	[Grade.Daily]: 'daily',
};

/** The five canonical strategy spellings (docs/INTERFACE.md "Required fields"). */
export const CANONICAL_STRATEGIES = ['Nige', 'Senkou', 'Sasi', 'Oikomi', 'Oonige'] as const;

/** Aptitude grades the engine accepts, S (best) through G (docs/INTERFACE.md). */
export const CANONICAL_APTITUDES = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;

/** Raw-stat bounds validated on input; the engine clamps the *final base stat*
 *  to [1, 2000] after overcap halving and motivation (race_solver_builder.rs:225-230). */
export const STAT_MIN = 1;
export const STAT_MAX = 2000;

/** GlobalSim requires signed 32-bit seeds for reconstructed initialization. */
export const SEED_MIN = -2147483648;
export const SEED_MAX = 2147483647;

// ── Types ────────────────────────────────────────────────────────────────────

export interface GlobalSimSkillEntry {
	skillId: string;
	level: number;
	isUnique: boolean;
}

/** One runner as it goes into the request's `horses` array (docs/INTERFACE.md
 *  "Required fields" + the optional fields the adapter always emits). */
export interface GlobalSimRunner {
	speed: number;
	stamina: number;
	power: number;
	guts: number;
	wisdom: number;
	strategy: string;
	distanceAptitude: string;
	surfaceAptitude: string;
	strategyAptitude: string;
	mood: number;
	gateIndex: number;
	skills: GlobalSimSkillEntry[];
}

/** The merged race request (profile keys + race keys), ready for PreparedRace.
 *  pairedRandomStreams is the engine's paired-draws flag (see AdapterConfig.paired);
 *  it is only ever present when true, so default requests stay byte-identical. */
export type GlobalSimRequest = Record<string, unknown> & { pairedRandomStreams?: boolean };

export interface AdapterRunnerInput {
	/** v2 UI horse state (Immutable Record from components/HorseDefTypes). */
	horse: HorseState;
	/** 0-based starting gate. Canonical field order is ascending gateIndex. */
	gateIndex: number;
	/** Exactly one runner in the race is the player's (sets playerHorseIndex). */
	isPlayer?: boolean;
}

export interface AdapterRaceInput {
	/** Key in GlobalSim's bundled course table (config.courseIds must contain it). */
	courseId: string | number;
	groundCondition: GroundCondition;
	weather: Weather;
	season: Season;
	time: Time;
	/** Defaults to Grade.G1 (the engine default, docs/INTERFACE.md). */
	grade?: Grade;
	/** Signed 32-bit; PreparedRace.run(seed) overrides it per seed. */
	seed: number;
	runners: AdapterRunnerInput[];
}

export interface AdapterConfig {
	/** Valid course ids = keys of vendor/GlobalSim/data/course_data.json
	 *  (fetched in the app, required in tests). */
	courseIds: ReadonlySet<string> | readonly string[];
	/** Optional coverage set (Phase 2 active skill table). When present, every
	 *  emitted skill id must be in it — skills GlobalSim lacks never reach the engine. */
	knownSkillIds?: ReadonlySet<string> | readonly string[];
	/**
	 * Engine skillData control (Phase 2 merged table):
	 *   undefined → profile-v77's embedded skillData (pure v70; byte-identical
	 *               to the pinned goldens);
	 *   object    → replace skillData with it (the merged active table, so the
	 *               21 batch-1 supplement skills initialize in the engine);
	 *   null      → OMIT the skillData key entirely: the worker injects the
	 *               table it received once via the pool's 'skillData' init
	 *               message (workerCore), keeping per-prepare payloads small.
	 */
	skillData?: Record<string, unknown> | null;
	/**
	 * Engine paired random streams (request key pairedRandomStreams):
	 *   true        → emit "pairedRandomStreams": true — per-skill / per-runner
	 *                 draws come from streams keyed by (race seed, runner
	 *                 position, skill), so two builds that differ by one skill
	 *                 keep their draws: the paired σ(lead) drops from ~2.1 L to
	 *                 <0.25 L while the single-run distributions stay the same.
	 *                 Only active in the retail profile (always on via
	 *                 profile-v77's experimentalRetail* flags).
	 *   false / unset → OMIT the key: the request is byte-identical to a
	 *                 pre-flag build, and the engine omits it from replies too.
	 */
	paired?: boolean;
}

export interface AdapterError {
	code: AdapterErrorCode;
	/** Field path for the offending value, e.g. "horses[3].speed" or "courseId". */
	field: string;
	message: string;
}

export type AdapterErrorCode =
	| 'bad-course' | 'unknown-course'
	| 'bad-condition' | 'bad-time' | 'bad-grade'
	| 'bad-seed' | 'bad-runners' | 'bad-gate' | 'multiple-players'
	| 'bad-stat' | 'bad-strategy' | 'bad-aptitude' | 'bad-mood' | 'bad-skill'
	| 'unknown-skill' | 'bad-uniqueLv';

export type AdapterWarningCode = 'forced-skill-positions-ignored';

export interface AdapterWarning {
	code: AdapterWarningCode;
	message: string;
}

export type AdapterResult<T> =
	| { ok: true; value: T; warnings: AdapterWarning[] }
	| { ok: false; errors: AdapterError[] };

// ── Validation helpers ───────────────────────────────────────────────────────

function toIdSet(ids: ReadonlySet<string> | readonly string[]): ReadonlySet<string> {
	return ids instanceof Set ? ids : new Set(ids);
}

function statError(v: unknown, field: string): AdapterError | null {
	if (typeof v !== 'number' || !Number.isFinite(v) || v < STAT_MIN || v > STAT_MAX) {
		return { code: 'bad-stat', field, message: `${field} must be a finite number in [${STAT_MIN}, ${STAT_MAX}] (got ${JSON.stringify(v)}); GlobalSim halves overcap past 1200 and clamps base stats to [1, 2000] itself` };
	}
	return null;
}

// ── Skill ordering (determinism, plan §6.1) ──────────────────────────────────

/** groupId as a number for sorting; unknown skills sort after known ones. */
function groupIdNum(id: string): number {
	const g = Number((skillmeta as Record<string, { groupId?: string }>)[id]?.groupId);
	return Number.isFinite(g) ? g : Number.MAX_SAFE_INTEGER;
}

/**
 * Canonical skill order (plan §6.1: "skills sorted the way compare.ts sorts
 * common skills"). compare.ts sorts by common-groupId order then `+a - +b`
 * (umalator/compare.ts:73-76); with one runner every skill is "common", so the
 * canonical form is ascending numeric groupId (keeps a skill's white/gold pair
 * adjacent and order-stable), then ascending numeric skillId.
 */
export function canonicalSkillOrder(ids: readonly string[]): string[] {
	return [...ids].sort((a, b) => groupIdNum(a) - groupIdNum(b) || +a - +b);
}

/**
 * Map one HorseState to a GlobalSim runner (stats RAW — no overcap/mood/ground
 * pre-adjustment; GlobalSim applies those itself). The unique skill from
 * uniqueSkillForUma(outfitId, starCount) carries the horse's uniqueLv and
 * isUnique: true; every other skill is level 1. forcedSkillPositions are
 * dropped (no GlobalSim equivalent) with a warning.
 */
export function toGlobalSimRunner(
	horse: HorseState,
	gateIndex: number,
	config?: AdapterConfig,
	fieldBase = 'horse'
): AdapterResult<GlobalSimRunner> {
	const errors: AdapterError[] = [];
	const warnings: AdapterWarning[] = [];

	for (const stat of ['speed', 'stamina', 'power', 'guts', 'wisdom'] as const) {
		const err = statError(horse.get(stat), `${fieldBase}.${stat}`);
		if (err) errors.push(err);
	}

	const strategy = horse.get('strategy');
	if (!CANONICAL_STRATEGIES.includes(strategy as (typeof CANONICAL_STRATEGIES)[number])) {
		errors.push({ code: 'bad-strategy', field: `${fieldBase}.strategy`, message: `strategy must be one of ${CANONICAL_STRATEGIES.join('|')} (got ${JSON.stringify(strategy)})` });
	}
	for (const apt of ['distanceAptitude', 'surfaceAptitude', 'strategyAptitude'] as const) {
		const v = horse.get(apt);
		if (!CANONICAL_APTITUDES.includes(v as (typeof CANONICAL_APTITUDES)[number])) {
			errors.push({ code: 'bad-aptitude', field: `${fieldBase}.${apt}`, message: `${apt} must be one of ${CANONICAL_APTITUDES.join('')}` });
		}
	}

	const mood = horse.get('mood');
	if (!Number.isInteger(mood) || mood < -2 || mood > 2) {
		errors.push({ code: 'bad-mood', field: `${fieldBase}.mood`, message: `mood must be an integer in [-2, 2] (got ${JSON.stringify(mood)})` });
	}

	if (!Number.isInteger(gateIndex) || gateIndex < 0) {
		errors.push({ code: 'bad-gate', field: `${fieldBase}.gateIndex`, message: `gateIndex must be a nonnegative integer (got ${JSON.stringify(gateIndex)})` });
	}

	// Unique skill: same lookup the classic compare path uses (compare.ts:88).
	const uniqueId = uniqueSkillForUma(horse.get('outfitId'), horse.get('starCount'));
	const uniqueLv = horse.get('uniqueLv');
	if (uniqueId && (!Number.isInteger(uniqueLv) || uniqueLv < 1 || uniqueLv > 3)) {
		errors.push({ code: 'bad-uniqueLv', field: `${fieldBase}.uniqueLv`, message: `uniqueLv must be an integer in [1, 3] when a unique skill is present (got ${JSON.stringify(uniqueLv)})` });
	}

	// HorseState.skills is an Immutable Map keyed by groupId (values = skill ids),
	// exactly what compare.ts flattens with Array.from(sk.values()) (compare.ts:36).
	const rawIds: string[] = Array.from(horse.get('skills').values()) as string[];
	const known = config?.knownSkillIds ? toIdSet(config.knownSkillIds) : null;
	const skillEntries: GlobalSimSkillEntry[] = [];
	for (const id of canonicalSkillOrder(rawIds)) {
		if (typeof id !== 'string' || !/^\d+$/.test(id)) {
			errors.push({ code: 'bad-skill', field: `${fieldBase}.skills`, message: `skill id must be a non-empty numeric string (got ${JSON.stringify(id)})` });
			continue;
		}
		if (known && !known.has(id)) {
			errors.push({ code: 'unknown-skill', field: `${fieldBase}.skills`, message: `skill ${id} is not in the active GlobalSim skill table` });
			continue;
		}
		const isUnique = id === uniqueId;
		// Debuff copies repeat an id in the SkillSet (groupId-0, groupId-1, ...);
		// emit one entry per copy, like the classic engine adds one per copy.
		skillEntries.push({ skillId: id, level: isUnique ? uniqueLv : 1, isUnique });
	}

	const forced = horse.get('forcedSkillPositions');
	if (forced.count() > 0) {
		warnings.push({ code: 'forced-skill-positions-ignored', message: `${fieldBase} has ${forced.count()} forced skill position(s); GlobalSim has no forced-position equivalent and they are ignored — hide the control in GlobalSim mode` });
	}

	if (errors.length) return { ok: false, errors };
	return {
		ok: true,
		warnings,
		value: {
			// Raw stats: GlobalSim applies overcap halving, mood and ground itself.
			speed: horse.get('speed'),
			stamina: horse.get('stamina'),
			power: horse.get('power'),
			guts: horse.get('guts'),
			wisdom: horse.get('wisdom'),
			strategy,
			distanceAptitude: horse.get('distanceAptitude'),
			surfaceAptitude: horse.get('surfaceAptitude'),
			strategyAptitude: horse.get('strategyAptitude'),
			mood,
			gateIndex,
			skills: skillEntries,
		},
	};
}

// ── Race request ─────────────────────────────────────────────────────────────

/**
 * Build the complete GlobalSim race request: race fields merged over the
 * validated v77 runtime profile (./profile-v77.json — every non-race settings
 * key of examples/v77-race.jsonl verbatim, skillData included until Phase 2
 * replaces it). Runners are emitted in canonical order (ascending gateIndex,
 * stable); playerHorseIndex is the tested player runner's post-sort index.
 * Never throws on user data — returns typed errors.
 */
export function buildGlobalSimRequest(input: AdapterRaceInput, config: AdapterConfig): AdapterResult<GlobalSimRequest> {
	const errors: AdapterError[] = [];
	const warnings: AdapterWarning[] = [];

	const courseIds = toIdSet(config.courseIds);
	const courseIdNum = typeof input.courseId === 'number' ? input.courseId : Number(input.courseId);
	if (!Number.isSafeInteger(courseIdNum) || courseIdNum <= 0) {
		errors.push({ code: 'bad-course', field: 'courseId', message: `courseId must be a positive integer (got ${JSON.stringify(input.courseId)})` });
	} else if (!courseIds.has(String(courseIdNum))) {
		errors.push({ code: 'unknown-course', field: 'courseId', message: `courseId ${courseIdNum} is not in GlobalSim's bundled course table (unknown courses panic the engine)` });
	}

	const ground = GROUND_TO_GLOBALSIM[input.groundCondition];
	if (!ground) errors.push({ code: 'bad-condition', field: 'groundCondition', message: `groundCondition must be Good|Yielding|Soft|Heavy (enum 1-4)` });
	const weather = WEATHER_TO_GLOBALSIM[input.weather];
	if (!weather) errors.push({ code: 'bad-condition', field: 'weather', message: `weather must be Sunny|Cloudy|Rainy|Snowy (enum 1-4)` });
	const season = SEASON_TO_GLOBALSIM[input.season];
	if (!season) errors.push({ code: 'bad-condition', field: 'season', message: `season must be Spring|Summer|Autumn|Winter|Sakura (enum 1-5)` });
	const time = TIME_TO_GLOBALSIM[input.time];
	if (!time) errors.push({ code: 'bad-time', field: 'time', message: `time must be NoTime|Morning|Midday|Evening|Night (enum 0-4)` });
	const grade = input.grade == null ? GRADE_TO_GLOBALSIM[Grade.G1] : GRADE_TO_GLOBALSIM[input.grade];
	if (!grade) errors.push({ code: 'bad-grade', field: 'grade', message: `grade is not a known uma-tools Grade value` });

	if (!Number.isInteger(input.seed) || input.seed < SEED_MIN || input.seed > SEED_MAX) {
		errors.push({ code: 'bad-seed', field: 'seed', message: `seed must be a signed 32-bit integer (got ${JSON.stringify(input.seed)})` });
	}

	const runnersIn = input.runners ?? [];
	if (runnersIn.length === 0) {
		errors.push({ code: 'bad-runners', field: 'runners', message: 'a race needs at least one runner' });
	}
	const players = runnersIn.filter(r => r.isPlayer).length;
	if (players !== 1) {
		errors.push({ code: 'multiple-players', field: 'runners', message: `exactly one runner must have isPlayer: true (got ${players})` });
	}
	const gates = new Set<number>();
	runnersIn.forEach((r, i) => {
		if (gates.has(r.gateIndex)) errors.push({ code: 'bad-gate', field: `runners[${i}].gateIndex`, message: `duplicate gateIndex ${r.gateIndex}` });
		gates.add(r.gateIndex);
	});

	if (errors.length) return { ok: false, errors };

	// Map every runner; merge child errors with runners[i] field prefixes.
	const runnersOut: GlobalSimRunner[] = [];
	runnersIn.forEach((r, i) => {
		const res = toGlobalSimRunner(r.horse, r.gateIndex, config, `runners[${i}]`);
		// `=== true` not truthiness: the repo type-checks with strictNullChecks off,
		// where a bare discriminant check does not narrow the union.
		if (res.ok === true) { warnings.push(...res.warnings); runnersOut.push(res.value); }
		else errors.push(...res.errors);
	});
	if (errors.length) return { ok: false, errors };

	// Canonical field order: ascending gateIndex (stable). playerHorseIndex is
	// the tested uma's index after that ordering.
	const order = runnersIn.map((_, i) => i)
		.sort((a, b) => runnersIn[a].gateIndex - runnersIn[b].gateIndex);
	const horses = order.map(i => runnersOut[i]);
	const playerHorseIndex = order.findIndex(i => runnersIn[i].isPlayer);

	// Fixed key order keeps the serialized request byte-stable for a given input.
	const request: GlobalSimRequest = { ...profileV77 };
	if (config.skillData === null) delete (request as Partial<GlobalSimRequest>).skillData;
	else if (config.skillData) request.skillData = config.skillData as GlobalSimRequest['skillData'];
	// Only true emits the key — a default request stays byte-identical to
	// pre-flag traffic (the engine omits the key from replies the same way).
	if (config.paired === true) request.pairedRandomStreams = true;
	request.seed = input.seed;
	request.courseId = courseIdNum;
	request.groundCondition = ground;
	request.weather = weather;
	request.season = season;
	request.time = time;
	request.grade = grade;
	request.playerHorseIndex = playerHorseIndex;
	request.horses = horses;

	return { ok: true, warnings, value: request };
}
