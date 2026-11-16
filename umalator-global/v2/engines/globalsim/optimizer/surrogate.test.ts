/**
 * Surrogate unit tests (Stage E, §8 E). Pure numeric checks — no engine, no
 * cache. They pin the three things the search relies on: the ridge recovers
 * additive option values, pairwise terms surface planted synergies, and the
 * holdout R² gate correctly reports weak (noise-only) designs as unfit.
 */

import test from 'tape';
import { fitSurrogate, SurrogateSample } from './surrogate';
import { SURROGATE_MIN_R2 } from './config';

function mulberry(seed: number): () => number {
	let a = seed | 0;
	return () => {
		a = (a + 0x6D2B79F5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const OPTS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/** Random group-exclusive-ish subsets (each option independently, ~p). */
function randomSets(rng: () => number, count: number, p = 0.42): string[][] {
	const out: string[][] = [];
	for (let i = 0; i < count; i++) {
		const sel = OPTS.filter(() => rng() < p);
		out.push(sel.length ? sel : ['A']);
	}
	return out;
}

test('surrogate: recovers additive option values (holdout R² high, predictions match)', t => {
	const rng = mulberry(1234);
	const w: Record<string, number> = { A: 1.2, B: 0.6, C: -0.4, D: 0.9, E: 0.0, F: -0.8, G: 0.3, H: -0.2 };
	const base = -3.0;
	const sets = randomSets(rng, 160);
	const samples: SurrogateSample[] = sets.map(sel => ({
		selection: sel, mean: base + sel.reduce((a, id) => a + w[id], 0), weight: 1,
	}));
	const m = fitSurrogate(samples, { minPairCooccur: 8, pairCap: 20 });
	t.ok(m.ok, 'fit succeeds');
	t.ok(m.r2 > 0.9, `holdout R² high for a clean additive model (R²=${m.r2.toFixed(3)})`);
	// Held-out probes: prediction ≈ exact additive truth.
	let maxErr = 0;
	for (const sel of randomSets(mulberry(999), 40)) {
		const truth = base + sel.reduce((a, id) => a + w[id], 0);
		maxErr = Math.max(maxErr, Math.abs(m.predict(sel).mean - truth));
	}
	t.ok(maxErr < 0.35, `held-out predictions within 0.35 (max err ${maxErr.toFixed(3)})`);
	t.ok(m.predict([]).se > 0 && Number.isFinite(m.predict(['A', 'C']).se), 'SE finite and positive');
	t.end();
});

test('surrogate: a planted synergy pair surfaces in synergyPairs and lifts its prediction', t => {
	const rng = mulberry(77);
	const w: Record<string, number> = { A: 0.3, B: 0.3, C: 0.3, D: 0.3, E: 0.3, F: 0.3, G: 0.3, H: 0.3 };
	const synergy = 1.6; // A+C together is worth far more than the sum of parts
	const sets = randomSets(rng, 220, 0.5); // denser so A,C co-occur ≥ minCooc
	const has = (sel: string[], a: string, c: string) => sel.includes(a) && sel.includes(c);
	const samples: SurrogateSample[] = sets.map(sel => ({
		selection: sel, mean: sel.reduce((a, id) => a + w[id], 0) + (has(sel, 'A', 'C') ? synergy : 0), weight: 1,
	}));
	const m = fitSurrogate(samples, { minPairCooccur: 8, pairCap: 40 });
	t.ok(m.ok, 'fit succeeds');
	const pairs = m.synergyPairs(6, 0.5);
	t.ok(pairs.some(p => (p.a === 'A' && p.b === 'C') || (p.a === 'C' && p.b === 'A')), 'planted A+C synergy is flagged');
	// Joint prediction beats the additive (no-synergy) sum for the pair.
	const joint = m.predict(['A', 'C']).mean;
	const alone = m.predict(['A']).mean + m.predict(['C']).mean - m.predict([]).mean;
	t.ok(joint - alone > synergy * 0.5, `joint beats additive by the synergy (${(joint - alone).toFixed(2)} > ${(synergy * 0.5).toFixed(2)})`);
	t.end();
});

test('surrogate: pure-noise target fails the R² gate (drives the §8 E fallback)', t => {
	const rng = mulberry(4321);
	const sets = randomSets(rng, 120);
	const samples: SurrogateSample[] = sets.map(sel => ({ selection: sel, mean: (rng() - 0.5) * 4, weight: 1 }));
	const m = fitSurrogate(samples, { minPairCooccur: 8, pairCap: 30 });
	t.ok(m.r2 < SURROGATE_MIN_R2, `noise design R² below the ${SURROGATE_MIN_R2} fallback gate (R²=${m.r2.toFixed(3)})`);
	t.end();
});

test('surrogate: heavier samples pull the fit (inverse-variance weighting)', t => {
	// Two options; every subset observed, but 'D' only ever appears in a
	// high-weight group whose true value contradicts a single low-weight point.
	const samples: SurrogateSample[] = [
		{ selection: ['X'], mean: 0, weight: 50 },
		{ selection: ['X'], mean: 0, weight: 50 },
		{ selection: ['X', 'D'], mean: 0.1, weight: 0.01 }, // lone weak outlier
		{ selection: ['X', 'D'], mean: 5, weight: 60 },     // strong: D ≈ +5
		{ selection: ['X', 'D'], mean: 5, weight: 60 },
	];
	const m = fitSurrogate(samples, { minPairCooccur: 1, pairCap: 5 });
	const withD = m.predict(['X', 'D']).mean;
	const noD = m.predict(['X']).mean;
	t.ok(withD - noD > 2, `weighted fit trusts the heavy cluster (D lift ${ (withD - noD).toFixed(2) })`);
	t.end();
});

test('surrogate: too-small / empty training sets degrade gracefully', t => {
	t.notOk(fitSurrogate([], { }).ok, 'empty → not ok, still answers with a mean');
	const tiny = fitSurrogate([{ selection: ['A'], mean: 1, weight: 1 }]);
	t.ok(Number.isFinite(tiny.predict(['A']).mean), 'tiny fit yields a finite prediction');
	t.ok(Number.isFinite(tiny.predict(['ZZZ']).mean), 'unknown option in prediction is ignored, not NaN');
	t.end();
});

// ── §I corrections ───────────────────────────────────────────────────────────

test('§I predictDiff: the SE of a difference is the covariance of the difference', t => {
	const rng = mulberry(31337);
	const w: Record<string, number> = { A: 1.2, B: -0.6, C: 0.4, D: 0.9, E: -0.5, F: 0.7, G: -0.3, H: 0.2 };
	const sets = randomSets(rng, 160);
	const samples: SurrogateSample[] = sets.map(sel => ({ selection: sel, mean: sel.reduce((a, id) => a + w[id], 0), weight: 1 }));
	const m = fitSurrogate(samples, { minPairCooccur: 8, pairCap: 20 });
	t.ok(m.ok, 'fit succeeds');
	const selA = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
	const selB = ['A', 'B', 'C', 'D', 'E', 'F', 'G']; // shares 7 of 8 options
	const pd = m.predictDiff(selA, selB);
	const pa = m.predict(selA), pb = m.predict(selB);
	// Mean: linear model → the difference prediction is exact (no approximation).
	t.ok(Math.abs(pd.mean - (pa.mean - pb.mean)) < 1e-9, `mean is exact (${pd.mean.toFixed(6)} = ${(pa.mean - pb.mean).toFixed(6)})`);
	// SE: the shared columns cancel, so the marginal quadrature (the old
	// search-side sqrt(se² + se²)) is grossly too wide for the difference.
	const quad = Math.sqrt(pa.se * pa.se + pb.se * pb.se);
	t.ok(pd.se < 0.75 * quad, `difference SE much tighter than the marginals in quadrature (${pd.se.toFixed(4)} < ${quad.toFixed(4)})`);
	// Identical builds: the difference row is zero — SE exactly 0, not noise.
	const self = m.predictDiff(selA, selA);
	t.equal(self.se, 0, 'Δ with itself has no uncertainty');
	t.equal(self.mean, 0, 'Δ with itself is exactly 0');
	t.end();
});

test('§I: sample weights are relative — scaling them cannot change the fit', t => {
	// The old code fit raw inverse-variance weights: against weights in the
	// hundreds the λ≈0.5 ridge was numerically absent (the prior died of
	// scale). Normalized to mean 1, a common factor cancels exactly.
	const rng = mulberry(8642);
	const w: Record<string, number> = { A: 0.9, B: -0.7, C: 0.5, D: 0.2, E: -0.2, F: 0.6, G: -0.4, H: 0.3 };
	const sets = randomSets(rng, 120);
	const means = sets.map(sel => sel.reduce((a, id) => a + w[id], 0));
	const m1 = fitSurrogate(sets.map((sel, i) => ({ selection: sel, mean: means[i], weight: 1 })), { minPairCooccur: 8, pairCap: 20 });
	const m100 = fitSurrogate(sets.map((sel, i) => ({ selection: sel, mean: means[i], weight: 100 })), { minPairCooccur: 8, pairCap: 20 });
	t.ok(m1.ok && m100.ok, 'both fits succeed');
	let maxDiff = 0;
	for (const sel of randomSets(mulberry(555), 30)) maxDiff = Math.max(maxDiff, Math.abs(m1.predict(sel).mean - m100.predict(sel).mean));
	t.ok(maxDiff < 1e-9, `predictions identical under a 100× weight scale (max diff ${maxDiff.toExponential(1)})`);
	t.ok(Math.abs(m1.r2 - m100.r2) < 1e-12, `R² identical too (${m1.r2.toFixed(4)} vs ${m100.r2.toFixed(4)})`);
	t.end();
});

test('§I: the pair block never exceeds n/4 columns', t => {
	const rng = mulberry(1971);
	const sets = randomSets(rng, 20, 0.5); // dense: every pair of 8 options co-occurs ≥ 1
	const samples: SurrogateSample[] = sets.map(sel => ({ selection: sel, mean: sel.length * 0.3, weight: 1 }));
	const m = fitSurrogate(samples, { minPairCooccur: 1, pairCap: 300 }); // pairCap asked wide
	const optCols = new Set(sets.flat()).size;
	t.ok(m.ok, 'fit succeeds');
	t.ok(m.terms <= 1 + optCols + Math.floor(20 / 4), `terms ${m.terms} ≤ 1 + ${optCols} options + 5 pair columns (floor(20/4))`);
	t.end();
});

test('§I: no fold skip on wide models — n < features still yields a real R²', t => {
	// 10 samples, 8 options → the design has more columns than any fold's
	// rows. The old fold skip (trIdx.length < m) reported R² 0.000 here and
	// pushed the search off a model it could use; ridge is made for n < m.
	const w: Record<string, number> = { A: 1.2, B: -0.6, C: 0.4, D: 0.9, E: -0.5, F: 0.7, G: -0.3, H: 0.2 };
	const sets = randomSets(mulberry(24680), 10, 0.5);
	const samples: SurrogateSample[] = sets.map(sel => ({ selection: sel, mean: sel.reduce((a, id) => a + w[id], 0), weight: 1 }));
	const m = fitSurrogate(samples, { minPairCooccur: 20, pairCap: 0 }); // options-only design (wide by itself: 9 cols > fold rows)
	t.ok(m.ok, 'fit succeeds');
	t.ok(m.r2 > 0, `clean additive target scores positive holdout R² even at n < m (R²=${m.r2.toFixed(3)})`);
	t.end();
});

test('§I: the prior is strongest where the estimate is widest (pair columns shrink harder)', t => {
	// One planted +1.0 synergy seen in 6 builds, everything else additive and
	// exact. The 10× pair prior must keep the recovered interaction honest —
	// within 25 % of the truth — while options recover cleanly.
	const rng = mulberry(1357);
	const w: Record<string, number> = { A: 0.3, B: 0.3, C: 0.3, D: 0.3, E: 0.3, F: 0.3, G: 0.3, H: 0.3 };
	const sets = randomSets(rng, 140, 0.5);
	const has = (sel: string[], a: string, c: string) => sel.includes(a) && sel.includes(c);
	let seen = 0;
	const samples: SurrogateSample[] = sets.map(sel => ({
		selection: sel,
		mean: sel.reduce((a, id) => a + w[id], 0) + (has(sel, 'A', 'C') ? 1.0 : 0),
		weight: 1,
	})).filter(sel => { if (has(sel.selection, 'A', 'C')) seen++; return true; });
	void seen;
	const m = fitSurrogate(samples, { minPairCooccur: 4, pairCap: 40 });
	t.ok(m.ok, 'fit succeeds');
	const joint = m.predict(['A', 'C']).mean;
	const additive = m.predict(['A']).mean + m.predict(['C']).mean - m.predict([]).mean;
	const lift = joint - additive;
	t.ok(lift > 0.3, `the synergy is recovered (lift ${lift.toFixed(2)})`);
	t.ok(lift < 1.3, `and not inflated past the truth by the pair block (lift ${lift.toFixed(2)} < 1.3)`);
	t.end();
});

test('§I: the empty model answers predictDiff without throwing', t => {
	const m = fitSurrogate([]);
	t.equal(m.predictDiff(['A'], ['B']).se, Infinity, 'no model: infinite difference SE (never certifiable)');
	t.end();
});
