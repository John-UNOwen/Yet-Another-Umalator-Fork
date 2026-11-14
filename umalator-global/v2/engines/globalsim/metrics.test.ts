/**
 * Tests for the GlobalSim compare metrics (Phase 4).
 *
 * Run: npm run test:globalsim-metrics  (from the repo root)
 *
 * All synthetic (no wasm): the tail grid, both margin methods and their sign
 * convention (positive = UMA 2 ahead, the umalator/compare.ts sign), the
 * order-independent aggregate merge, the 95% CI, medians, placing histograms,
 * HP-empty/rushing rates, representative-seed selection, and snapshot
 * building. The real-engine agreement of the two margin methods is checked
 * against live engine frames in compare.acceptance.test.ts (d).
 */

import test from 'tape';
import {
	LENGTH_M, TAIL_STEP, TAIL_SAMPLES, TAIL_WINDOW,
	samplePlayerTail, pairMargin, pairMarginFromFull, newAggregate, addPair, mergeAggregates,
	ci95, medianOf, summarizeAggregate, representativeSeeds, buildSkillActivationMap, buildSnapshotHalf,
	SeedCompactRecord, FullRunData,
} from './metrics';

// ── tail sampling ────────────────────────────────────────────────────────────

test('samplePlayerTail reproduces linear motion exactly on the grid', t => {
	const v = 12; // m/s
	const finish = 12.5;
	// Dense frames every 0.0666 s (engine dt), pos = v·t.
	const frames: { t: number; horses: { pos: number; speed: number }[] }[] = [];
	for (let t0 = 0; t0 <= finish + 1; t0 += 0.0666) {
		frames.push({ t: t0, horses: [{ pos: v * t0, speed: v }] });
	}
	const tail = samplePlayerTail(frames, 0, finish);
	t.equal(tail.length, TAIL_SAMPLES, 'fixed grid of 41 samples');
	t.equal(tail[0][0], 0, 'k=0 is the finish moment');
	for (let k = 0; k < TAIL_SAMPLES; k++) {
		const dt = k * TAIL_STEP;
		const tExpected = Math.max(0, finish - dt);
		t.ok(Math.abs(tail[k][0] - dt) < 1e-9, `sample ${k} dt`);
		t.ok(Math.abs(tail[k][1] - v * tExpected) < 1e-6, `sample ${k} position matches v·t (linear interp of linear motion is exact)`);
		t.ok(Math.abs(tail[k][2] - v) < 1e-6, `sample ${k} speed`);
	}
	t.end();
});

test('samplePlayerTail clamps the window at t = 0', t => {
	const frames: { t: number; horses: { pos: number; speed: number }[] }[] = [];
	for (let t0 = 0; t0 <= 5; t0 += 0.0666) frames.push({ t: t0, horses: [{ pos: 4 * t0, speed: 4 }] });
	const tail = samplePlayerTail(frames, 0, 5); // finish 5 s < TAIL_WINDOW
	const first = TAIL_SAMPLES - Math.ceil(5 / TAIL_STEP); // samples before t=0 clamp to t=0 pos
	t.ok(first > 0, 'some grid points precede the race start');
	t.ok(Math.abs(tail[TAIL_SAMPLES - 1][1]) < 1e-9, 'the last sample clamps to the start position 0');
	t.ok(Math.abs(tail[first - 1][1] - 0) < 1e-9, 'still 0 just before the clamp');
	t.end();
});

// ── regression: the backwards tail grid must INTERPOLATE, not back-extrapolate ─
//
// The grid walks BACKWARDS from the finish (k grows ⇒ t falls) while the engine
// frames are time-ASCENDING. The original estimator advanced a single forward
// pointer, so every grid point older than ~1 frame was a linear back-extrapolation
// from the finish-segment slope. On an accelerating runner that under-read the
// position by ~25 m at dt = 10 s (and up to −0.22 L of real-engine margin error).
// The fix walks the bracket down in lockstep, so interior grid points interpolate
// the frames that actually bracket them.

test('samplePlayerTail interpolates real frames on an accelerating trajectory', t => {
	// pos(t) = 8t + 0.25t² (accelerating), dense 0.0666 s frames.
	const pos = (x: number) => 8 * x + 0.25 * x * x;
	const spd = (x: number) => 8 + 0.5 * x;
	const finish = 20; // finish > TAIL_WINDOW so the whole window holds frames
	const frames: { t: number; horses: { pos: number; speed: number }[] }[] = [];
	for (let t0 = 0; t0 <= finish + 1; t0 += 0.0666) frames.push({ t: t0, horses: [{ pos: pos(t0), speed: spd(t0) }] });
	const tail = samplePlayerTail(frames, 0, finish);
	t.equal(tail.length, TAIL_SAMPLES, 'fixed grid of 41 samples');

	// Independent ground truth: linear interpolation of the two frames bracketing
	// each grid time (the same frames samplePlayerTail is allowed to use — the
	// window [finish−WINDOW, finish], clamped at t=0).
	const from = Math.max(0, finish - TAIL_WINDOW);
	const slice = frames.filter(f => f.t >= from && f.t <= finish);
	const first = slice[0].t, last = slice[slice.length - 1].t;
	const interpPos = (x: number) => {
		let i = 0; while (i + 1 < slice.length && slice[i + 1].t < x) i++;
		const a = slice[i], b = slice[Math.min(i + 1, slice.length - 1)];
		return b.t > a.t ? a.horses[0].pos + (x - a.t) / (b.t - a.t) * (b.horses[0].pos - a.horses[0].pos) : a.horses[0].pos;
	};
	let interiorChecked = 0;
	for (let k = 0; k < TAIL_SAMPLES; k++) {
		const tTrue = Math.max(0, finish - k * TAIL_STEP);
		// (1) Grid value tracks the TRUE accelerating position (back-extrapolation
		//     missed this by up to ~25 m at the deep end).
		t.ok(Math.abs(tail[k][1] - pos(tTrue)) < 0.02, `k=${k}: grid position matches true pos (err ${(tail[k][1] - pos(tTrue)).toFixed(4)} m)`);
		t.ok(Math.abs(tail[k][2] - spd(tTrue)) < 0.02, `k=${k}: grid speed matches true speed`);
		// (2) Every interior grid point is EXACTLY the linear interpolation of the
		//     bracketing frames (edge points outside the retained span extrapolate).
		if (tTrue >= first && tTrue <= last) {
			t.ok(Math.abs(tail[k][1] - interpPos(tTrue)) < 1e-9, `k=${k}: interior grid == frame linear interpolation`);
			interiorChecked++;
		}
	}
	t.ok(interiorChecked > TAIL_SAMPLES / 2, `most grid points are interior (checked ${interiorChecked})`);
	// (3) Explicit deep-end guard: at dt = 10 s the old estimator read 80.27 m
	//     against a true 105.0 m — assert it is now within one frame of truth.
	t.ok(Math.abs(tail[TAIL_SAMPLES - 1][1] - pos(from)) < 0.02, 'deepest grid point is interpolated, not back-extrapolated');
	t.end();
});

test('compact tail margin matches the dense-frame ground truth (synthetic, no wasm)', t => {
	// Two self-consistent accelerating runners over D = 200 m: pos(t) = v0·t +
	// 0.25t², finish solved from pos = D. UMA 2 (v0 = 12) beats UMA 1 (v0 = 8) by
	// ~3.4 s — a gap where the back-extrapolation bug skewed the compact margin
	// by ~1.1 L. Compact = pairMargin over samplePlayerTail grids; dense =
	// pairMarginFromFull over the raw frame arrays. They must agree tightly.
	const D = 200;
	const finishAt = (v0: number) => (-v0 + Math.sqrt(v0 * v0 + 4 * 0.25 * D)) / (2 * 0.25);
	const run = (v0: number) => {
		const fin = finishAt(v0);
		const t: number[] = [], pos: number[] = [], speed: number[] = [];
		for (let x = 0; x <= fin + 1e-9; x += 0.0666) { t.push(x); pos.push(v0 * x + 0.25 * x * x); speed.push(v0 + 0.5 * x); }
		const frames = t.map((x, i) => ({ t: x, horses: [{ pos: pos[i], speed: speed[i] }] }));
		return { fin, frames, t, pos, speed };
	};
	const A = run(8), B = run(12);
	const recA: SeedCompactRecord = { seed: 1, finishTimeRaw: A.fin, tail: samplePlayerTail(A.frames, 0, A.fin) };
	const recB: SeedCompactRecord = { seed: 1, finishTimeRaw: B.fin, tail: samplePlayerTail(B.frames, 0, B.fin) };
	const fullA: FullRunData = { seed: 1, finishTimeRaw: A.fin, t: A.t, pos: A.pos, speed: A.speed };
	const fullB: FullRunData = { seed: 1, finishTimeRaw: B.fin, t: B.t, pos: B.pos, speed: B.speed };

	const compact = pairMargin(recA, recB, D);
	const dense = pairMarginFromFull(fullA, fullB, D);
	t.equal(compact.method, 'frames', 'gap within the tail window ⇒ frame-based margin');
	t.ok(dense.deltaT > 0 && compact.marginL > 0, 'uma2 ahead ⇒ positive margin on both paths');
	t.ok(Math.abs(compact.marginL - dense.frames) < 0.05,
		`compact (grid-interpolated) margin ${compact.marginL.toFixed(4)} L agrees with dense truth ${dense.frames.toFixed(4)} L within 0.05 L (Δ ${Math.abs(compact.marginL - dense.frames).toFixed(5)})`);
	t.end();
});

// ── margin ───────────────────────────────────────────────────────────────────

/** Linear tail generator: pos(dt) = p0 − slope·dt (dt in seconds before finish). */
function linearTail(p0: number, slope: number): number[][] {
	return Array.from({ length: TAIL_SAMPLES }, (_, k) => {
		const dt = k * TAIL_STEP;
		return [dt, p0 - slope * dt, slope];
	});
}

function rec(t: number, over: Partial<SeedCompactRecord> = {}): SeedCompactRecord {
	return { seed: 1, finishTimeRaw: t, finishOrder: 0, hpEmptyOnRace: null, rushingStartCount: 0, ...over };
}

test('identical finish times are an exact tie (margin 0, separate method)', t => {
	const a = rec(10, { finishOrder: 3 });
	const b = rec(10, { finishOrder: 3, tail: linearTail(1990, 10) });
	const m = pairMargin(a, b, 2000);
	t.equal(m.marginL, 0, 'margin exactly 0');
	t.equal(m.method, 'tie');
	t.equal(m.deltaT, 0);
	t.end();
});

test('frames margin: UMA 2 faster ⇒ positive (compare.ts sign convention)', t => {
	// UMA 1 finishes at 12.0 s, UMA 2 at 11.5 s ⇒ UMA 2 ahead ⇒ positive.
	// The margin reads the LOSER's (UMA 1's) position at UMA 2's finish
	// instant = 0.5 s BEFORE UMA 1's own finish → tail grid dt = gap = 0.5.
	const loserTail = linearTail(1990, 20); // pos(dt) = 1990 − 20·dt ⇒ at dt=0.5 pos = 1980
	const a = rec(12.0, { tail: loserTail });
	const b = rec(11.5, { tail: linearTail(2000, 10) });
	const m = pairMargin(a, b, 2000);
	t.ok(m.marginL > 0, `positive margin (got ${m.marginL})`);
	t.equal(m.method, 'frames');
	t.equal(m.marginL, (2000 - 1980) / LENGTH_M, 'exactly (distance − loser pos at winner finish)/2.5');
	t.equal(m.marginL, 8, '20 m = 8 lengths');
	t.end();
});

test('frames margin: UMA 1 faster ⇒ negative', t => {
	const a = rec(11.5, { tail: linearTail(2000, 10) });   // winner
	const b = rec(12.0, { tail: linearTail(1990, 20) });   // loser: pos at dt=0.5 → 1980
	const m = pairMargin(a, b, 2000);
	t.ok(m.marginL < 0, `negative margin (got ${m.marginL})`);
	t.equal(m.method, 'frames');
	t.equal(m.marginL, -8);
	t.end();
});

test('margin falls back to delta-avg without frames or beyond the window', t => {
	// No tail on the loser → delta-avg with the loser's mean race speed.
	const a = rec(10, { tail: null });
	const b = rec(10.5, { tail: null });
	const m = pairMargin(a, b, 2000); // uma1 finished earlier ⇒ negative margin
	t.equal(m.method, 'delta-avg');
	const meanSpeed = 2000 / 10.5;
	t.ok(Math.abs(m.marginL + meanSpeed * 0.5 / LENGTH_M) < 1e-12, 'Δt × loser mean speed / 2.5, negative');

	// Gap beyond TAIL_WINDOW (both tails present) → still delta-avg.
	const far = pairMargin(rec(10 + TAIL_WINDOW + 0.1, { tail: linearTail(1990, 10) }), rec(10, { tail: linearTail(2000, 10) }), 2000);
	t.equal(far.method, 'delta-avg', 'huge gap falls back');
	t.ok(far.marginL > 0, 'sign still uma2-ahead');
	t.end();
});

test('pairMarginFromFull: frames vs Δt×speed agree on constant-speed motion', t => {
	// UMA 2 wins (tB < tA). Loser is UMA 1: constant 950 m/s, so pos(t)=950t
	// is self-consistent and finishTimeRaw = 2000/950 — the two methods then
	// agree exactly (zero acceleration).
	const tA = 2000 / 950;
	const a: FullRunData = { seed: 1, finishTimeRaw: tA, t: [0, 1, 2, tA], pos: [0, 950, 1900, 2000], speed: [950, 950, 950, 950], hp: [20, 20, 20, 20] };
	const b: FullRunData = { seed: 1, finishTimeRaw: 2.0, t: [0, 1, 2], pos: [0, 1000, 2000], speed: [1000, 1000, 1000], hp: [20, 20, 20] };
	const m = pairMarginFromFull(a, b, 2000);
	t.ok(m.deltaT > 0, 'uma1 slower ⇒ deltaT > 0');
	t.ok(m.frames > 0 && m.deltaSpeed > 0, 'uma2 ahead ⇒ both margins positive');
	t.ok(Math.abs(m.frames - m.deltaSpeed) < 1e-9, `constant-speed runs: methods agree exactly (${m.frames} vs ${m.deltaSpeed})`);
	t.ok(Math.abs(m.frames - 40) < 1e-9, 'value: loser 100 m behind at winner finish = 40 L');
	t.end();
});

// ── aggregates ───────────────────────────────────────────────────────────────

test('addPair counts wins/ties/histograms/rates correctly', t => {
	const agg = newAggregate();
	const mk = (tA: number, tB: number, oA: number, oB: number, hpA: boolean | null, hpB: boolean | null, rushA: number, rushB: number): [SeedCompactRecord, SeedCompactRecord] => [
		rec(tA, { finishOrder: oA, tail: linearTail(2000, 10), hpEmptyOnRace: hpA, rushingStartCount: rushA }),
		rec(tB, { finishOrder: oB, tail: linearTail(2000, 10), hpEmptyOnRace: hpB, rushingStartCount: rushB }),
	];
	// gap 0.25 s, loser tail pos at dt 0.25 = 2000−10×0.25 = 1997.5 → ±1 L
	addPair(agg, ...mk(10.25, 10, 0, 1, false, true, 0, 1), 2000);   // uma2 wins +1 L, hp-empty uma2, rushing uma2
	addPair(agg, ...mk(10, 10.25, 2, 4, true, false, 2, 0), 2000);   // uma1 wins −1 L, hp-empty uma1, rushing uma1
	addPair(agg, ...mk(10, 10, 8, 8, null, null, 0, 0), 2000);       // tie
	addPair(agg, rec(10, { error: 'engine error' }), rec(10.25, {}), 2000); // seed error counted, no pair
	const s = summarizeAggregate(agg);
	t.equal(s.n, 3);
	t.equal(agg.ties, 1);
	t.equal(agg.win2, 1);
	t.equal(agg.win1, 1);
	t.equal(s.tieRate, 1 / 3);
	t.equal(s.winRateUma2, 1 / 3);
	t.equal(s.winRateUma1, 1 / 3);
	t.deepEqual(agg.placing1, [1, 0, 1, 0, 0, 0, 0, 0, 1]);
	t.deepEqual(agg.placing2, [0, 1, 0, 0, 1, 0, 0, 0, 1]);
	t.equal(s.hpEmptyRate1, 0.5, '1 of 2 non-null pairs');
	t.equal(s.hpEmptyRate2, 0.5);
	t.equal(s.rushingRate1, 1 / 3, '1 of 3 paired seeds');
	t.equal(s.rushingRate2, 1 / 3);
	t.equal(s.seedErrors, 1);
	t.equal(agg.methodCounts.frames, 2);
	t.equal(agg.methodCounts.tie, 1);
	t.end();
});

test('aggregate merge is commutative and order-independent', t => {
	const one = newAggregate();
	const a = newAggregate();
	const b = newAggregate();
	const mk = (tA: number, tB: number): [SeedCompactRecord, SeedCompactRecord] =>
		[rec(tA, { finishOrder: 1, tail: linearTail(2000, 10) }), rec(tB, { finishOrder: 3, tail: linearTail(2000, 10) })];
	const pairs: [number, number][] = [[10.25, 10], [10, 10.75], [9.5, 10.5], [10, 10]];
	pairs.forEach(([x, y], i) => {
		addPair(one, ...mk(x, y), 2000);
		if (i % 2 === 0) addPair(a, ...mk(x, y), 2000); else addPair(b, ...mk(x, y), 2000);
	});
	const merged = mergeAggregates(a, b);
	t.deepEqual(summarizeAggregate(merged), summarizeAggregate(one), 'same summary merged-in-any-order vs sequential');
	t.deepEqual(summarizeAggregate(mergeAggregates(b, a)), summarizeAggregate(one), 'commutative');
	t.end();
});

test('ci95 and median math', t => {
	const [lo, hi] = ci95(1, 2, 100);
	t.ok(Math.abs((hi - lo) / 2 - 1.96 * 2 / 10) < 1e-12, 'half-width = 1.96·σ/√n');
	t.ok(Math.abs((lo + hi) / 2 - 1) < 1e-12, 'centred on the mean');
	t.ok(Number.isNaN(ci95(1, 1, 0)[0]), 'n=0 → NaN');
	// summarizeAggregate pins n=1 at σ = 0, so the single-seed CI is zero-width [mean, mean].
	t.deepEqual(summarizeAggregate({ ...newAggregate(), n: 1, margins: [0.4], marginSum: 0.4, marginSumSq: 0.16, minMargin: 0.4, maxMargin: 0.4 }).ci95, [0.4, 0.4], 'n=1 → zero-width [mean, mean] CI');
	t.equal(medianOf([1, 2, 3]), 2);
	t.equal(medianOf([1, 2, 3, 4]), 2.5);
	t.ok(Number.isNaN(medianOf([])));
	t.end();
});

test('summarizeAggregate matches hand-computed stats', t => {
	const agg = newAggregate();
	// Margin via a 0.5 s gap: loser tail pos(dt) = 2000 − slope·dt, so the
	// margin is slope·0.5/2.5 lengths ⇒ slope = |margin| × 5.
	const mkPair = (marginL: number): [SeedCompactRecord, SeedCompactRecord] => {
		if (marginL === 0) return [rec(10), rec(10)];
		// UMA 1's record comes first in the pair; the loser always takes 10.5 s.
		const loser = rec(10.5, { tail: linearTail(2000, Math.abs(marginL) * LENGTH_M / 0.5) });
		const winner = rec(10, { tail: linearTail(2000, 10) });
		return marginL > 0 ? [loser, winner] : [winner, loser];
	};
	for (const m of [2, -1, 0, 1]) addPair(agg, ...mkPair(m), 2000);
	const s = summarizeAggregate(agg);
	t.equal(s.n, 4);
	t.ok(Math.abs(s.mean - 0.5) < 1e-12, 'mean 0.5');
	t.ok(Math.abs(s.median - 0.5) < 1e-12, 'median (−1,0,1,2) = 0.5');
	t.equal(s.min, -1);
	t.equal(s.max, 2);
	// margins (−1, 0, 1, 2): mean 0.5, Σx² = 6 ⇒ sample σ² = (6 − 4·0.25)/3 = 5/3.
	t.ok(Math.abs(s.stdDev - Math.sqrt(5 / 3)) < 1e-12, 'sample σ = √(5/3) (÷(n−1), not ÷n)');
	t.ok(Math.abs(s.ci95[0] - (0.5 - 1.96 * Math.sqrt(5 / 3) / 2)) < 1e-12, 'CI low');
	t.ok(Math.abs(s.ci95[1] - (0.5 + 1.96 * Math.sqrt(5 / 3) / 2)) < 1e-12, 'CI high');
	t.end();
});

// ── representative seeds ─────────────────────────────────────────────────────

test('representativeSeeds picks min/median/mean/max holders', t => {
	// margins sorted: −3 (s1), −1 (s5), 0.5 (s3), 1 (s2), 2 (s4). mean=−0.2.
	// median (odd n) = 0.5 → s3. mean target −0.2: |−1−−0.2|=0.8 vs |0.5−−0.2|=0.7 → s3.
	const map = new Map<number, number>([[1, -3], [2, 1], [3, 0.5], [4, 2], [5, -1]]);
	const r = representativeSeeds(map);
	t.equal(r.min, 1, 'most negative margin');
	t.equal(r.max, 4, 'most positive margin');
	t.equal(r.median, 3, 'median holder');
	t.equal(r.mean, 3, 'closest to the mean −0.2 is seed3 (0.5, gap 0.7) vs seed5 (−1, gap 0.8)');
	t.deepEqual(representativeSeeds(new Map()), { min: NaN, median: NaN, mean: NaN, max: NaN });
	t.end();
});

// ── snapshots ────────────────────────────────────────────────────────────────

test('buildSkillActivationMap maps activations to [startPos, endPos, dur], clamped', t => {
	const full: FullRunData = {
		seed: 7, finishTimeRaw: 10,
		t: [0, 5, 10], pos: [0, 1000, 2000], speed: [10, 10, 10], hp: [24, 24, 24],
		skillEvents: [
			{ skillId: '101', t: 5, duration: 2 },        // end pos 1400
			{ skillId: '101', t: 9, duration: 3 },        // end past finish → clamp to 2000
			{ skillId: '202', t: 1, duration: 0 },        // zero duration → start==end
		],
	};
	const map = buildSkillActivationMap(full, 2000);
	t.deepEqual(map.get('101'), [[1000, 1400, 2], [1800, 2000, 3]], 'two activations, second clamped');
	t.deepEqual(map.get('202'), [[200, 200, 0]]);
	t.end();
});

test('buildSnapshotHalf copies frame arrays and carries delay/sk', t => {
	const full: FullRunData = {
		seed: 1, finishTimeRaw: 1, t: [0, 1], pos: [0, 2000], speed: [2000, 2000], hp: [24, 24],
		startDelayTime: 0.15, skillEvents: [{ skillId: '301', t: 0.5, duration: 1 }],
	};
	const half = buildSnapshotHalf(full, 2000);
	t.deepEqual(half.t, [0, 1]);
	t.deepEqual(half.p, [0, 2000]);
	t.deepEqual(half.v, [2000, 2000]);
	t.deepEqual(half.hp, [24, 24]);
	t.equal(half.sdly, 0.15);
	t.deepEqual([...half.sk.keys()], ['301']);
	const src = full.t as number[]; src.push(99);
	t.equal(half.t.length, 2, 'frames are copies (later mutation does not leak)');
	t.end();
});
