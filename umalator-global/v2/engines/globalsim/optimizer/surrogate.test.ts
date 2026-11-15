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
