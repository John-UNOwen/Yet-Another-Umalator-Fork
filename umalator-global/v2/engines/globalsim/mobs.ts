/**
 * Mob field + gate assignment (Phase 3, decision D3).
 *
 * Every GlobalSim race has exactly 9 runners: the tested uma + 8 mobs from a
 * mob-presets.json preset. The tested uma's gate is drawn per seed from a
 * seed-derived RNG — identically for both races of a compare pair, because the
 * seed is the pairing key — and the mobs fill the remaining gates in preset
 * order. A fixed-gate mode overrides the draw.
 *
 * Mob runner objects use the adapter's runner fields; validation mirrors
 * adapter.ts's rules (the engine is not a validation boundary).
 */
import { CANONICAL_APTITUDES, CANONICAL_STRATEGIES, GlobalSimRunner, STAT_MAX, STAT_MIN } from './adapter';

export interface MobRunnerSpec {
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
	skills: { skillId: string; level: number; isUnique: boolean }[];
}

export interface MobPreset {
	name: string;
	comment?: string;
	runners: MobRunnerSpec[];
}

export const FIELD_SIZE = 9;

export type MobError = { field: string; message: string };

/** Validate + normalize the presets file. Returns presets keyed by id. */
export function parseMobPresets(json: unknown): { presets: Record<string, MobPreset>; errors: MobError[] } {
	const errors: MobError[] = [];
	const presets: Record<string, MobPreset> = {};
	if (!json || typeof json !== 'object') return { presets, errors: [{ field: '', message: 'mob presets must be an object of preset objects' }] };
	for (const [id, raw] of Object.entries(json as Record<string, unknown>)) {
		const p = raw as Partial<MobPreset>;
		if (!p || !Array.isArray(p.runners) || p.runners.length !== FIELD_SIZE - 1) {
			errors.push({ field: id, message: `preset "${id}" must have exactly ${FIELD_SIZE - 1} mob runners (9-runner fields, D3)` });
			continue;
		}
		p.runners.forEach((r, i) => {
			for (const stat of ['speed', 'stamina', 'power', 'guts', 'wisdom'] as const) {
				if (typeof r?.[stat] !== 'number' || !Number.isFinite(r[stat]) || r[stat] < STAT_MIN || r[stat] > STAT_MAX) {
					errors.push({ field: `${id}.runners[${i}].${stat}`, message: `must be a finite number in [${STAT_MIN}, ${STAT_MAX}]` });
				}
			}
			if (!CANONICAL_STRATEGIES.includes(r?.strategy as typeof CANONICAL_STRATEGIES[number])) {
				errors.push({ field: `${id}.runners[${i}].strategy`, message: `strategy must be one of ${CANONICAL_STRATEGIES.join('|')}` });
			}
			for (const apt of ['distanceAptitude', 'surfaceAptitude', 'strategyAptitude'] as const) {
				if (!CANONICAL_APTITUDES.includes(r?.[apt] as typeof CANONICAL_APTITUDES[number])) {
					errors.push({ field: `${id}.runners[${i}].${apt}`, message: `${apt} must be one of ${CANONICAL_APTITUDES.join('')}` });
				}
			}
			if (!Number.isInteger(r?.mood) || r.mood < -2 || r.mood > 2) {
				errors.push({ field: `${id}.runners[${i}].mood`, message: 'mood must be an integer in [-2, 2]' });
			}
			if (!Array.isArray(r?.skills)) {
				errors.push({ field: `${id}.runners[${i}].skills`, message: 'skills must be an array' });
			}
		});
		presets[id] = { name: p.name ?? id, comment: p.comment, runners: p.runners };
	}
	return { presets, errors };
}

/**
 * Seed-derived gate draw (mulberry32 over the unsigned seed). Deterministic;
 * the SAME seed for races A and B of a pair yields the SAME tested-uma gate.
 */
export function deriveGate(seed: number, fieldSize: number = FIELD_SIZE): number {
	let a = (seed >>> 0) + 0x6D2B79F5;
	const next = () => {
		a |= 0; a = (a + 0x6D2B79F5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	// First draw consumed; skip nothing — one value is all we need.
	return Math.floor(next() * fieldSize);
}

/**
 * Head-to-head gate pair for one seed: the primary player sits at the seed's
 * drawn gate g and the secondary at the adjacent gate g+1 (wrapping). Each
 * seed runs a MIRRORED pair of races (race A = primary@ g / secondary@g+1,
 * race B swapped), so the small residual difference between adjacent stalls
 * cancels when the two margins are averaged.
 */
export function deriveGatePair(seed: number, fieldSize: number = FIELD_SIZE): [number, number] {
	const g = deriveGate(seed, fieldSize);
	return [g, (g + 1) % fieldSize];
}

/** Mobs fill every gate not taken by a player, ascending, preset order kept. */
function placeMobs(preset: MobPreset, playerGates: number[], mobCount: number): GlobalSimRunner[] {
	const openGates = [];
	for (let g = 0; g < FIELD_SIZE; g++) if (!playerGates.includes(g)) openGates.push(g);
	return preset.runners.slice(0, mobCount).map((r, i) => ({
		speed: r.speed, stamina: r.stamina, power: r.power, guts: r.guts, wisdom: r.wisdom,
		strategy: r.strategy,
		distanceAptitude: r.distanceAptitude, surfaceAptitude: r.surfaceAptitude, strategyAptitude: r.strategyAptitude,
		mood: r.mood,
		gateIndex: openGates[i],
		skills: r.skills,
	}));
}

/**
 * Build the mob field for one seed: the tested uma sits at its gate (drawn
 * from the seed, or fixed via fixedGate), and the preset's runners fill the
 * remaining gates in ascending order, keeping preset order among themselves.
 * Returns 0-based gateIndex-bearing GlobalSimRunner-shaped mobs.
 */
export function buildMobField(
	preset: MobPreset,
	seed: number,
	options: { fixedGate?: number } = {},
): { playerGate: number; mobs: GlobalSimRunner[]; errors: MobError[] } {
	const errors: MobError[] = [];
	let playerGate: number;
	if (options.fixedGate !== undefined) {
		if (!Number.isInteger(options.fixedGate) || options.fixedGate < 0 || options.fixedGate >= FIELD_SIZE) {
			errors.push({ field: 'fixedGate', message: `fixed gate must be an integer in [0, ${FIELD_SIZE - 1}]` });
			return { playerGate: 0, mobs: [], errors };
		}
		playerGate = options.fixedGate;
	} else {
		playerGate = deriveGate(seed);
	}
	const openGates = [];
	for (let g = 0; g < FIELD_SIZE; g++) if (g !== playerGate) openGates.push(g);
	const mobs = placeMobs(preset, [playerGate], openGates.length);
	return { playerGate, mobs, errors };
}

/**
 * Head-to-head mob field: two player gates are taken (primary @ gateA,
 * secondary @ gateB), and the preset's first FIELD_SIZE−2 = 7 mobs fill the
 * remaining gates ascending. With the Default preset (2×Nige, 2×Senkou,
 * 2×Sasi, 2×Oikomi) this keeps 2/2/2/1 of each style — the drop is fixed at
 * the preset's LAST runner so every mirrored race of the run shares exactly
 * the same field.
 */
export function buildH2hMobField(
	preset: MobPreset,
	gateA: number,
	gateB: number,
): { mobs: GlobalSimRunner[]; errors: MobError[] } {
	const errors: MobError[] = [];
	for (const [g, label] of [[gateA, 'gateA'], [gateB, 'gateB']] as const) {
		if (!Number.isInteger(g) || g < 0 || g >= FIELD_SIZE) {
			errors.push({ field: label, message: `gate must be an integer in [0, ${FIELD_SIZE - 1}]` });
		}
	}
	if (gateA === gateB) errors.push({ field: 'gateB', message: 'the two players cannot share a gate' });
	if (errors.length) return { mobs: [], errors };
	return { mobs: placeMobs(preset, [gateA, gateB], FIELD_SIZE - 2), errors };
}
