/**
 * GlobalSim compare metrics (Phase 4 of the GlobalSim integration plan).
 *
 * All functions here are pure and free of Worker/wasm imports so the pool and
 * the browser worker entry can share them, and node tests can exercise them
 * against real engine replies (see compare.acceptance.test.ts).
 *
 * ## Margin convention
 *
 * The margin for one paired seed is the classic バ身 (length) difference with
 * EXACTLY the sign convention of umalator/compare.ts: positive = UMA 2 ahead
 * (compare.ts computes `posDifference / 2.5` where posDifference is uma2's
 * position minus uma1's at the chosen sample frame; the skill chart relies on
 * positive = the tested variant's gain, and the Phase 4 acceptance requires
 * "adding a speed skill to uma2 ⇒ positive mean margin"). 1 length = 2.5 m,
 * same as compare.ts. A tie is margin === 0 and is counted separately from
 * both win rates.
 *
 * ## Margin methods
 *
 * - `marginFromFrames` (preferred, used for every sampling seed): the slower
 *   runner's position at the winner's finish moment, read from the frame data
 *   the engine returns. The wasm wrapper always emits dense frames
 *   (profile-v77.json keeps retainAllFrames: true), so the worker compresses
 *   them to a fixed per-seed tail grid (TAIL_STEP back from the player's
 *   finish, TAIL_WINDOW long) and this module interpolates linearly in it —
 *   sub-decimetre error on 0.25 s steps.
 * - `marginDeltaSpeed` (the Δt × final-speed fallback): Δt × the SLOWER
 *   runner's speed at the winner's finish moment. The per-runner GlobalSim
 *   results fields (finishOrder/finishTime/finishTimeRaw/gutsOrder/wizOrder/
 *   hpEmptyOnRace/startDelayTime/lastSpurtStart…/rushingStartCount/
 *   rushingPenaltyCount) contain NO final-speed field, so the speed is taken
 *   from the tail samples (a last-two-frames speed estimate at the winner's
 *   finish time — equivalent to the plan's "1-frame tail capture"). We use the
 *   SLOWER runner's speed rather than the winner's final speed because the
 *   gap the loser still has to cover at tA is covered at the LOSER's speed;
 *   that makes the two methods agree to O(a·Δt²) instead of
 *   Δt·(vWinner−vLoser), which is what the acceptance test checks.
 * - If the gap exceeds TAIL_WINDOW (only absurdly large margins; > 100 m),
 *   the loser's mean race speed (distance / finishTime) is used and the
 *   method is reported as 'delta-avg'.
 *
 * ## Warmup
 *
 * None. Every prepared race is a full retail race from the gate — nothing is
 * excluded (plan Phase 4 (e)).
 */

/** Length unit shared with umalator/compare.ts (1 バ身 = 2.5 m). */
export const LENGTH_M = 2.5;

/** Tail sample grid: step and window (seconds) the worker records backwards from the player's finish. */
export const TAIL_STEP = 0.25;
export const TAIL_WINDOW = 10.0;
export const TAIL_SAMPLES = Math.floor(TAIL_WINDOW / TAIL_STEP) + 1; // 41 samples, k = 0 … 40

/** Compact per-seed record the worker streams back for the sampling pass. */
export interface SeedCompactRecord {
	seed: number;
	/** Engine error text when this seed failed (all other fields then absent). */
	error?: string;
	finishTimeRaw?: number;
	finishOrder?: number;
	hpEmptyOnRace?: boolean | null;
	rushingStartCount?: number;
	rushingPenaltyCount?: number;
	lastSpurtStartDistance?: number;
	startDelayTime?: number;
	/**
	 * Phase 5 chart: the player's activation count of the preparation's
	 * trackSkillId (see workerCore PrepareMsg). Present only when the job
	 * tracked a skill; per-seed count of THAT skill's activations.
	 */
	activations?: number;
	/**
	 * Fixed grid sampled backwards from the player's own finish:
	 * [dtBeforeFinish, pos, speed] for dtBeforeFinish = k * TAIL_STEP,
	 * k = 0 … TAIL_SAMPLES-1 (clamped at t = 0). Null when the reply had no
	 * usable frames for the player (then only the Δt-avg method applies).
	 */
	tail?: number[][] | null;
}

/** Player frame slice the worker returns for representative runs. */
export interface FullRunData {
	seed: number;
	error?: string;
	finishTimeRaw?: number;
	finishOrder?: number;
	hpEmptyOnRace?: boolean | null;
	startDelayTime?: number;
	/** Player-only frame arrays, truncated at the frame whose t ≥ finishTimeRaw. */
	t?: number[];
	pos?: number[];
	speed?: number[];
	hp?: number[];
	/** Player skill activations (seconds); 'kakari' string events filtered out. */
	skillEvents?: { skillId: string; t: number; duration: number }[];
}

// ── tail sampling (runs in the worker; pure) ─────────────────────────────────

/**
 * Compress one engine reply's frames into the fixed per-seed tail grid.
 * frames is the reply's `frames` array ([{t, horses:[…9 tuples…]}], request
 * order after restore_request_order); playerIndex is reply.playerHorseIndex.
 */
export function samplePlayerTail(
	frames: { t: number; horses: { pos: number; speed: number }[] }[],
	playerIndex: number,
	finishTimeRaw: number,
): number[][] {
	// Player [t, pos, speed] samples inside the window [finish−WINDOW, finish].
	const from = Math.max(0, finishTimeRaw - TAIL_WINDOW);
	const slice: number[][] = [];
	for (let i = 0; i < frames.length; i++) {
		const t = frames[i].t;
		if (t < from) continue;
		if (t > finishTimeRaw) break;
		const h = frames[i].horses[playerIndex];
		if (!h) break;
		slice.push([t, h.pos, h.speed]);
	}
	const out: number[][] = [];
	if (slice.length === 0) return out;
	const n = slice.length;
	// A lone retained frame carries no slope to interpolate or extrapolate: every
	// grid point resolves to that constant sample (matches the old w=0 collapse).
	if (n === 1) {
		for (let k = 0; k < TAIL_SAMPLES; k++) out.push([k * TAIL_STEP, slice[0][1], slice[0][2]]);
		return out;
	}
	// The grid walks BACKWARDS in time (k grows ⇒ t falls from finishTimeRaw), while
	// slice is time-ASCENDING. Walk the bracket's LEFT index DOWN in lockstep with
	// the grid so each point interpolates the segment that actually brackets it;
	// only points outside the retained span extrapolate (finish end past
	// slice[n-1], oldest end before slice[0]).
	let lo = n - 2;
	for (let k = 0; k < TAIL_SAMPLES; k++) {
		const t = Math.max(0, finishTimeRaw - k * TAIL_STEP);
		while (lo > 0 && slice[lo][0] > t) lo--;
		const a = slice[lo];
		const b = slice[lo + 1];
		const w = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
		out.push([k * TAIL_STEP, a[1] + w * (b[1] - a[1]), a[2] + w * (b[2] - a[2])]);
	}
	return out;
}

/** Linear interpolation of one tail column (1 = pos, 2 = speed) at `dtBefore` seconds before finish. */
function tailAt(tail: number[][], dtBefore: number, col: number): number {
	const kf = dtBefore / TAIL_STEP;
	const k = Math.floor(kf);
	if (k >= tail.length - 1) return tail[tail.length - 1][col];
	const w = kf - k;
	return tail[k][col] + w * (tail[k + 1][col] - tail[k][col]);
}

// ── margin (pure; runs on the main thread per paired seed) ──────────────────

export type MarginMethod = 'tie' | 'frames' | 'delta-speed' | 'delta-avg';

export interface PairMargin {
	/** Lengths, positive = UMA 2 ahead (see the file header). */
	marginL: number;
	method: MarginMethod;
	/** Signed finish-time difference t(uma1) − t(uma2) (seconds). */
	deltaT: number;
}

/**
 * Margin for one paired seed. recA is the race with UMA 1 in the field,
 * recB the race with UMA 2 (same seed ⇒ same mob field and gate).
 */
export function pairMargin(recA: SeedCompactRecord, recB: SeedCompactRecord, distanceM: number): PairMargin {
	const tA = recA.finishTimeRaw as number;
	const tB = recB.finishTimeRaw as number;
	const deltaT = tA - tB; // > 0 ⇒ uma2 finished earlier ⇒ positive margin
	if (Math.abs(deltaT) < 1e-9) return { marginL: 0, method: 'tie', deltaT };
	const sign = deltaT > 0 ? 1 : -1; // margin>0 = uma2 ahead (deltaT>0 ⇒ uma2's time is shorter)
	const loser = tA < tB ? recB : recA;
	const gap = Math.abs(deltaT);
	// Position method (preferred): the loser's position at the winner's finish time.
	if (loser.tail && loser.tail.length > 1 && gap <= TAIL_WINDOW) {
		const posAt = tailAt(loser.tail, gap, 1);
		return { marginL: sign * (distanceM - posAt) / LENGTH_M, method: 'frames', deltaT };
	}
	// The Δt × final-speed variant needs a speed the compact record may not
	// have (no per-runner final-speed field exists in the engine reply);
	// pairMarginFromFull / the worker-computed speed cover the frame-bearing
	// cases, so here the last resort is the loser's mean race speed.
	const meanSpeed = distanceM / Math.max(tA, tB);
	return { marginL: sign * meanSpeed * gap / LENGTH_M, method: 'delta-avg', deltaT };
}

/**
 * The Δt × final-speed margin computed straight from FullRunData frames — the
 * two-method comparison of acceptance test (d): frames margin vs the Δt
 * method, both evaluated on frame-bearing runs. Speed = slower runner's speed
 * at the winner's finish time interpolated from its dense frames.
 */
export function pairMarginFromFull(fullA: FullRunData, fullB: FullRunData, distanceM: number):
	{ frames: number; deltaSpeed: number; deltaT: number } {
	const tA = fullA.finishTimeRaw as number;
	const tB = fullB.finishTimeRaw as number;
	const deltaT = tA - tB;
	const sign = Math.abs(deltaT) < 1e-9 ? 0 : (deltaT > 0 ? 1 : -1); // >0 ⇒ uma2's time shorter ⇒ uma2 ahead
	const loser = tA < tB ? fullB : fullA;
	const at = (f: FullRunData, t: number, col: 'pos' | 'speed') => {
		const ts = f.t as number[]; const vals = f[col] as number[];
		let lo = 0, hi = ts.length - 1;
		while (lo + 1 < hi) { const m = (lo + hi) >> 1; if (ts[m] <= t) lo = m; else hi = m; }
		const w = ts[hi] > ts[lo] ? (t - ts[lo]) / (ts[hi] - ts[lo]) : 0;
		return vals[lo] + Math.min(1, Math.max(0, w)) * (vals[hi] - vals[lo]);
	};
	const tWin = Math.min(tA, tB);
	const framesL = sign * (distanceM - at(loser, tWin, 'pos')) / LENGTH_M;
	// Δt × final-speed: winner's finish time minus loser's finish time is how
	// long the loser still needs; multiply the loser's speed at the winner's
	// finish (final-speed sample of its own frames at that instant).
	const deltaSpeedL = sign * at(loser, tWin, 'speed') * Math.abs(deltaT) / LENGTH_M;
	return { frames: framesL, deltaSpeed: deltaSpeedL, deltaT };
}

// ── aggregates (order-independent merge; main thread) ───────────────────────

export interface CompareAggregate {
	n: number;                       // paired seeds with a margin
	margins: number[];               // every margin (median/quantiles; merge = concat → order-independent)
	ties: number;
	win2: number;                    // margin > 0 (uma2 ahead)
	win1: number;                    // margin < 0
	placing1: number[];              // finishOrder histograms (0-based place → count), 9 bins
	placing2: number[];
	hpEmpty1: number; hpEmptyN: number;   // hpEmptyOnRace === true count / non-null count
	hpEmpty2: number;
	rushSeeds1: number; rushSeeds2: number;       // seeds with rushingStartCount > 0
	rushStarts1: number; rushStarts2: number;     // total rushingStartCount
	/** Streaming running totals — fold in arrival order, so their last bits DO depend on
	 *  chunk delivery order; summarizeAggregate ignores them and re-sums the sorted margins. */
	marginSum: number; marginSumSq: number;
	minMargin: number; maxMargin: number;
	methodCounts: { frames: number; 'delta-speed': number; 'delta-avg': number; tie: number };
	seedErrors: number;              // per-seed engine errors (both variants counted)
}

export function newAggregate(): CompareAggregate {
	return {
		n: 0, margins: [], ties: 0, win2: 0, win1: 0,
		placing1: new Array(9).fill(0), placing2: new Array(9).fill(0),
		hpEmpty1: 0, hpEmpty2: 0, hpEmptyN: 0,
		rushSeeds1: 0, rushSeeds2: 0, rushStarts1: 0, rushStarts2: 0,
		marginSum: 0, marginSumSq: 0, minMargin: Infinity, maxMargin: -Infinity,
		methodCounts: { frames: 0, 'delta-speed': 0, 'delta-avg': 0, tie: 0 },
		seedErrors: 0,
	};
}

/** Record one paired seed into the aggregate (idempotent per call; merge order irrelevant). */
export function addPair(agg: CompareAggregate, recA: SeedCompactRecord, recB: SeedCompactRecord, distanceM: number): void {
	if (recA.error || recB.error) { agg.seedErrors += (recA.error ? 1 : 0) + (recB.error ? 1 : 0); return; }
	const m = pairMargin(recA, recB, distanceM);
	agg.n += 1;
	agg.margins.push(m.marginL);
	agg.marginSum += m.marginL;
	agg.marginSumSq += m.marginL * m.marginL;
	if (m.marginL < agg.minMargin) agg.minMargin = m.marginL;
	if (m.marginL > agg.maxMargin) agg.maxMargin = m.marginL;
	if (m.method === 'tie') agg.ties += 1;
	else if (m.marginL > 0) agg.win2 += 1;
	else agg.win1 += 1;
	agg.methodCounts[m.method] += 1;
	const oA = recA.finishOrder as number, oB = recB.finishOrder as number;
	if (oA >= 0 && oA < 9) agg.placing1[oA] += 1;
	if (oB >= 0 && oB < 9) agg.placing2[oB] += 1;
	if (recA.hpEmptyOnRace != null || recB.hpEmptyOnRace != null) {
		agg.hpEmptyN += 1;
		if (recA.hpEmptyOnRace === true) agg.hpEmpty1 += 1;
		if (recB.hpEmptyOnRace === true) agg.hpEmpty2 += 1;
	}
	if ((recA.rushingStartCount ?? 0) > 0) agg.rushSeeds1 += 1;
	if ((recB.rushingStartCount ?? 0) > 0) agg.rushSeeds2 += 1;
	agg.rushStarts1 += recA.rushingStartCount ?? 0;
	agg.rushStarts2 += recB.rushingStartCount ?? 0;
}

/** Merge two aggregates (commutative — the merge of streamed partials is order-independent). */
export function mergeAggregates(a: CompareAggregate, b: CompareAggregate): CompareAggregate {
	const out = newAggregate();
	out.n = a.n + b.n;
	out.margins = a.margins.concat(b.margins);
	out.ties = a.ties + b.ties; out.win2 = a.win2 + b.win2; out.win1 = a.win1 + b.win1;
	for (let i = 0; i < 9; i++) { out.placing1[i] = a.placing1[i] + b.placing1[i]; out.placing2[i] = a.placing2[i] + b.placing2[i]; }
	out.hpEmpty1 = a.hpEmpty1 + b.hpEmpty1; out.hpEmpty2 = a.hpEmpty2 + b.hpEmpty2; out.hpEmptyN = a.hpEmptyN + b.hpEmptyN;
	out.rushSeeds1 = a.rushSeeds1 + b.rushSeeds1; out.rushSeeds2 = a.rushSeeds2 + b.rushSeeds2;
	out.rushStarts1 = a.rushStarts1 + b.rushStarts1; out.rushStarts2 = a.rushStarts2 + b.rushStarts2;
	out.marginSum = a.marginSum + b.marginSum; out.marginSumSq = a.marginSumSq + b.marginSumSq;
	out.minMargin = Math.min(a.minMargin, b.minMargin); out.maxMargin = Math.max(a.maxMargin, b.maxMargin);
	(out.methodCounts as any).frames = a.methodCounts.frames + b.methodCounts.frames;
	(out.methodCounts as any)['delta-speed'] = a.methodCounts['delta-speed'] + b.methodCounts['delta-speed'];
	(out.methodCounts as any)['delta-avg'] = a.methodCounts['delta-avg'] + b.methodCounts['delta-avg'];
	out.methodCounts.tie = a.methodCounts.tie + b.methodCounts.tie;
	out.seedErrors = a.seedErrors + b.seedErrors;
	return out;
}

/** Normal-approximation 95% CI half-width for the mean of n samples (z = 1.96). */
export function ci95(mean: number, stdDev: number, n: number): [number, number] {
	if (n <= 0) return [NaN, NaN];
	const half = 1.96 * stdDev / Math.sqrt(n);
	return [mean - half, mean + half];
}

export interface CompareSummary {
	n: number;
	mean: number; median: number; min: number; max: number; stdDev: number;
	ci95: [number, number];
	winRateUma1: number; winRateUma2: number; tieRate: number;   // fractions of n
	placing1: number[]; placing2: number[];
	hpEmptyRate1: number; hpEmptyRate2: number;                  // fractions of hpEmptyN
	rushingRate1: number; rushingRate2: number;                   // fractions of n
	methodCounts: CompareAggregate['methodCounts'];
	seedErrors: number;
}

export function medianOf(sorted: number[]): number {
	const n = sorted.length;
	if (n === 0) return NaN;
	const mid = Math.floor(n / 2);
	return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Finalise an aggregate into display stats. */
export function summarizeAggregate(agg: CompareAggregate): CompareSummary {
	const n = agg.n;
	// Sum over the SORTED margins (also the median's array), not over the
	// streaming agg.marginSum/marginSumSq: float addition is not associative, and
	// those running totals fold in pool chunk-arrival order, so two runs of the
	// same seed list with different arrival orders could differ by last-ULP bits
	// in mean/stdDev/CI. The sorted multiset is identical for any arrival order,
	// which makes the displayed mean/CI schedule-independent.
	const sorted = agg.margins.slice().sort((a, b) => a - b);
	let marginSum = 0, marginSumSq = 0;
	for (const m of sorted) { marginSum += m; marginSumSq += m * m; }
	const mean = n > 0 ? marginSum / n : NaN;
	// Sample (Bessel ÷(n−1)) variance: streaming n is small (chart round 1 = 25) and the
	// population ÷n σ makes the CI too narrow there. n === 1 keeps σ = 0 → zero-width [mean, mean] CI.
	const variance = n > 1 ? Math.max(0, (marginSumSq - n * mean * mean) / (n - 1)) : 0;
	const stdDev = Math.sqrt(variance);
	return {
		n, mean, median: medianOf(sorted),
		min: n > 0 ? agg.minMargin : NaN, max: n > 0 ? agg.maxMargin : NaN,
		stdDev, ci95: ci95(mean, stdDev, n),
		winRateUma1: n ? agg.win1 / n : NaN, winRateUma2: n ? agg.win2 / n : NaN, tieRate: n ? agg.ties / n : NaN,
		placing1: agg.placing1.slice(), placing2: agg.placing2.slice(),
		hpEmptyRate1: agg.hpEmptyN ? agg.hpEmpty1 / agg.hpEmptyN : NaN,
		hpEmptyRate2: agg.hpEmptyN ? agg.hpEmpty2 / agg.hpEmptyN : NaN,
		rushingRate1: n ? agg.rushSeeds1 / n : NaN,
		rushingRate2: n ? agg.rushSeeds2 / n : NaN,
		methodCounts: { ...agg.methodCounts },
		seedErrors: agg.seedErrors,
	};
}

/** Representative-run seeds: min / median / mean / max margin (by margin, tied to the seed holding it). */
export function representativeSeeds(marginBySeed: Map<number, number>): { min: number; median: number; mean: number; max: number } {
	const entries = [...marginBySeed.entries()].sort((a, b) => a[1] - b[1]);
	const n = entries.length;
	if (n === 0) return { min: NaN, median: NaN, mean: NaN, max: NaN };
	const closest = (target: number): number => {
		let best = entries[0];
		for (const e of entries) if (Math.abs(e[1] - target) < Math.abs(best[1] - target)) best = e;
		return best[0];
	};
	const meanM = entries.reduce((s, e) => s + e[1], 0) / n;
	return { min: entries[0][0], median: closest(medianOf(entries.map(e => e[1]))), mean: closest(meanM), max: entries[n - 1][0] };
}

// ── representative-run snapshot building ─────────────────────────────────────

/**
 * Build the classic skill-activation map (RaceSnapshot.sk format: skillId →
 * [activationPos, endPos]) for one full run. endPos is the player's position
 * at t + duration clamped to the course distance (mirrors compare.ts's
 * getActivator/getDeactivator, which also stores Math.min(pos, distance)).
 */
export function buildSkillActivationMap(
	full: FullRunData,
	distanceM: number,
): Map<string, number[][]> {
	const map = new Map<string, number[][]>();
	if (!full.skillEvents || !full.t || !full.pos) return map;
	const posAt = (t: number): number => {
		const ts = full.t as number[]; const ps = full.pos as number[];
		if (t <= ts[0]) return ps[0];
		const last = ts[ts.length - 1];
		if (t >= last) return Math.min(ps[ps.length - 1], distanceM);
		let lo = 0, hi = ts.length - 1;
		while (lo + 1 < hi) { const m = (lo + hi) >> 1; if (ts[m] <= t) lo = m; else hi = m; }
		const w = (t - ts[lo]) / (ts[hi] - ts[lo]);
		return ps[lo] + w * (ps[hi] - ps[lo]);
	};
	for (const ev of full.skillEvents) {
		const start = posAt(ev.t);
		const end = ev.duration > 0 ? Math.min(posAt(ev.t + ev.duration), distanceM) : start;
		const row = map.get(ev.skillId) || [];
		row.push([start, end, Math.round(ev.duration * 100) / 100]);
		map.set(ev.skillId, row);
	}
	return map;
}

/**
 * One full run → the per-uma frame arrays the classic RaceSnapshot uses
 * (t/p/v/hp per runner index). The compare facade combines the two races'
 * arrays into the classic pair snapshot ([uma1 arrays from race A, uma2
 * arrays from race B]; velocity-overlay scales each index independently,
 * exactly like the classic path).
 */
export interface SnapshotHalf {
	t: number[]; p: number[]; v: number[]; hp: number[];
	sdly: number; sk: Map<string, number[][]>;
}

export function buildSnapshotHalf(full: FullRunData, distanceM: number): SnapshotHalf {
	return {
		t: full.t ? full.t.slice() : [],
		p: full.pos ? full.pos.slice() : [],
		v: full.speed ? full.speed.slice() : [],
		hp: full.hp ? full.hp.slice() : [],
		sdly: full.startDelayTime ?? 0,
		sk: buildSkillActivationMap(full, distanceM),
	};
}
