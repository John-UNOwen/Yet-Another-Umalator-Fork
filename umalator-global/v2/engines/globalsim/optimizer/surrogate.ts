/**
 * Stage E — surrogate model (SKILL-OPTIMIZER-PLAN §8 E, §I corrections): a
 * Bayesian linear (ridge) model that scores a build's target (mean ℓ, or logit
 * P(1st)) from per-option indicators plus pairwise interaction terms, so the
 * search can order candidate moves and answer "what could this build be
 * worth?" in microseconds instead of races (P1: the surrogate only decides
 * what to simulate next, never the decision itself).
 *
 * The module is deliberately pure — it knows nothing about skills, the engine
 * or the cache. It fits a weighted design matrix and answers three questions:
 * `predict(selection) → {mean, se}`, `predictDiff(a, b) → {mean, se}` (§I:
 * the SE of a PREDICTED DIFFERENCE uses the covariance of the difference,
 * sqrt(dᵀΣd) — adding the two marginal SEs in quadrature counts every shared
 * feature twice and overstates the uncertainty 2–3×), and `synergyPairs()`
 * (the strongest positive interaction terms, for paired add/remove moves). A
 * closed-form posterior gives the SE the acquisition and the Δ-SE prune use.
 *
 * Features: intercept, one indicator per option that appears in the training
 * set, and pairwise terms for option pairs that co-occur in at least
 * `minPairCooccur` builds — capped at `pairCap` terms AND at n/4 (§I: pairs
 * are the wide block that memorizes; a pair term needs a quarter of the
 * sample count's worth of competition for its slot), the largest-magnitude
 * ridge coefficients surviving a cheap pre-fit (§8 E).
 *
 * §I regularization: sample weights are normalized to mean 1 before fitting
 * (inverse-variance weights in the hundreds silently switched the λ≈0.5 ridge
 * off — the prior died of scale, not of choice), pair columns carry a 10×
 * stronger prior than option columns, and the k-fold holdout never skips a
 * fold for having fewer rows than features (ridge is made for n < m; skipping
 * zeroed the wide model's R² exactly when it mattered).
 */

import { SURROGATE_LAMBDA, SURROGATE_PAIR_CAP, SURROGATE_PAIR_MIN_COOC, SURROGATE_PAIR_PRIOR } from './config';

/** Separator for pair-term keys: a control char that never appears in a skill id. */
const SEP = '\u0001';

export interface SurrogateSample {
	/** The build's option ids (order-insensitive). */
	selection: readonly string[];
	/** Regression target: mean ℓ (higher = better) or logit P(1st). */
	mean: number;
	/** Inverse-variance weight of the mean (n_seeds / var); ≤ 0 treated as 1.
	 *  Relative only: fitSurrogate normalizes the weights to mean 1 (§I). */
	weight: number;
}

export interface SurrogateOptions {
	lambda?: number;
	minPairCooccur?: number;
	pairCap?: number;
	/** Deterministic k-fold split for the reported holdout R². */
	folds?: number;
}

export interface SurrogatePrediction {
	mean: number;
	se: number;
}

export interface SurrogateModel {
	/** False when the design is degenerate / too small to answer anything. */
	readonly ok: boolean;
	readonly n: number;
	readonly terms: number;
	/** Weighted leave-group-out holdout R² (0.3 gate lives in the caller). */
	readonly r2: number;
	predict(selection: readonly string[]): SurrogatePrediction;
	/**
	 * Prediction of A − B (the unit the Δ-SE prune and the bandit prior act
	 * on). §I: the SE is sqrt(dᵀΣd) over the DIFFERENCE row — two builds
	 * share almost all of their features, so sqrt(se(A)² + se(B)²) counts
	 * every shared feature twice and is 2–3× too wide.
	 */
	predictDiff(a: readonly string[], b: readonly string[]): SurrogatePrediction;
	/** True when EVERY option is a learned feature (else `predict` ignores the
	 *  unseen ones and its estimate is untrustworthy — don't prune on it). */
	covers(selection: readonly string[]): boolean;
	/** Strongest positive pair interactions (synergy flags for pair moves). */
	synergyPairs(max: number, minCoef: number): { a: string; b: string; coef: number }[];
}

const pairKey = (a: string, b: string) => (a < b ? a + SEP + b : b + SEP + a);
const pairSplit = (k: string) => k.split(SEP) as [string, string];

/** Dense symmetric ridge solve: returns β and, with `withCov`, the (σ²-scaled) covariance.
 *  `lambda` is one penalty for every non-intercept column, or a per-column
 *  array (§I: the pair block takes a stronger prior than the options). */
function ridgeFit(X: number[][], y: number[], w: number[], lambda: number | number[], withCov = false): { beta: number[]; cov: number[][] | null; sigma2: number } | null {
	const n = X.length;
	const m = X[0]?.length ?? 0;
	if (!n || !m) return null;
	// Normal equations A = XᵀWX, b = XᵀWy.
	const A = new Float64Array(m * m);
	const b = new Float64Array(m);
	for (let i = 0; i < n; i++) {
		const xi = X[i], wi = w[i], yi = y[i];
		for (let j = 0; j < m; j++) {
			const xj = xi[j] * wi;
			if (xj === 0) continue;
			b[j] += xj * yi;
			const row = j * m;
			for (let k = 0; k < m; k++) A[row + k] += xj * xi[k];
		}
	}
	// Ridge penalty on every coefficient except the intercept (index 0); tiny
	// jitter keeps the Gram matrix invertible when an option never varies.
	for (let j = 0; j < m; j++) A[j * m + j] += (j === 0 ? 1e-8 : Array.isArray(lambda) ? lambda[j] : lambda) + 1e-8;
	// Cholesky A = L·Lᵀ (A = XᵀWX + ridge is symmetric positive definite), in
	// place in the lower triangle. ~m³/3 flops against the old Gauss–Jordan
	// inverse's ~2m³, and only the final fit (`withCov`) pays for A⁻¹ — the
	// pair pre-fit and the five CV folds need β alone. Measured on a 2,400-
	// sample, 421-term fit: 3.8 s → 0.84 s, same β / R² / SE to 6 decimals.
	const L = A;
	for (let j = 0; j < m; j++) {
		const rj = j * m;
		let d = L[rj + j];
		for (let k = 0; k < j; k++) d -= L[rj + k] * L[rj + k];
		if (!(d > 1e-12)) return null; // singular / not positive definite
		const ljj = Math.sqrt(d);
		L[rj + j] = ljj;
		for (let i = j + 1; i < m; i++) {
			const ri = i * m;
			let v = L[ri + j];
			for (let k = 0; k < j; k++) v -= L[ri + k] * L[rj + k];
			L[ri + j] = v / ljj;
		}
	}
	// β: L·z = b, then Lᵀ·β = z.
	const beta = new Float64Array(m);
	for (let i = 0; i < m; i++) {
		let v = b[i];
		for (let k = 0; k < i; k++) v -= L[i * m + k] * beta[k];
		beta[i] = v / L[i * m + i];
	}
	for (let i = m - 1; i >= 0; i--) {
		let v = beta[i];
		for (let k = i + 1; k < m; k++) v -= L[k * m + i] * beta[k];
		beta[i] = v / L[i * m + i];
	}
	let Ainv: Float64Array | null = null;
	if (withCov) {
		// L⁻¹ (lower) by forward substitution, then A⁻¹ = L⁻ᵀ·L⁻¹ (symmetric).
		const Li = new Float64Array(m * m);
		for (let c = 0; c < m; c++) {
			Li[c * m + c] = 1 / L[c * m + c];
			for (let i = c + 1; i < m; i++) {
				let v = 0;
				for (let k = c; k < i; k++) v -= L[i * m + k] * Li[k * m + c];
				Li[i * m + c] = v / L[i * m + i];
			}
		}
		Ainv = new Float64Array(m * m);
		for (let r = 0; r < m; r++) {
			for (let c = 0; c <= r; c++) {
				let v = 0;
				for (let k = r; k < m; k++) v += Li[k * m + r] * Li[k * m + c];
				Ainv[r * m + c] = v; Ainv[c * m + r] = v;
			}
		}
	}
	// σ² = weighted SSR / dof (in-sample: the residual scale of the fitted model).
	let ssr = 0;
	for (let i = 0; i < n; i++) { let f = 0; const xi = X[i]; for (let j = 0; j < m; j++) f += xi[j] * beta[j]; const e = y[i] - f; ssr += w[i] * e * e; }
	const sigma2 = Math.max(1e-9, ssr / Math.max(1, n - Math.min(m, n)));
	let cov: number[][] | null = null;
	if (Ainv) {
		cov = [];
		for (let r = 0; r < m; r++) { const row = new Array<number>(m); for (let c = 0; c < m; c++) row[c] = sigma2 * Ainv[r * m + c]; cov.push(row); }
	}
	return { beta: Array.from(beta), cov, sigma2 };
}

export function fitSurrogate(samples: readonly SurrogateSample[], opts: SurrogateOptions = {}): SurrogateModel {
	const lambda = opts.lambda ?? SURROGATE_LAMBDA;
	const minCooc = opts.minPairCooccur ?? SURROGATE_PAIR_MIN_COOC;
	// §I: the pair block never exceeds a quarter of the samples — pair terms
	// are the widest coefficients (fewest co-occurrences behind them), and
	// hand-fitting them on thin evidence is exactly how the old model turned
	// 50-seed noise into ±0.6 L "synergies".
	const pairCap = Math.min(opts.pairCap ?? SURROGATE_PAIR_CAP, Math.floor(samples.length / 4));
	const folds = Math.max(2, Math.min(opts.folds ?? 5, 10));

	// Option universe from the training set (stable, insertion-independent order).
	const optIndex = new Map<string, number>();
	const cooc = new Map<string, number>();
	for (const s of samples) {
		const uniq = [...new Set(s.selection)].sort();
		for (const id of uniq) if (!optIndex.has(id)) optIndex.set(id, optIndex.size);
		for (let a = 0; a < uniq.length; a++) for (let c = a + 1; c < uniq.length; c++) {
			const key = pairKey(uniq[a], uniq[c]);
			cooc.set(key, (cooc.get(key) ?? 0) + 1);
		}
	}
	// §I: inverse-variance weights reach the hundreds (n/σ² over 200+ seeds),
	// and against raw weights of 2000 the λ≈0.5 ridge penalty is numerically
	// absent — the prior died of scale. Normalize to mean 1 first; λ then
	// means what it says (in units of one average observation).
	const weights = samples.map(s => s.weight > 0 ? s.weight : 1);
	const wAvg = weights.reduce((a, z) => a + z, 0) / Math.max(1, weights.length);
	const normW = weights.map(z => z / (wAvg || 1));
	// Candidate pairs: frequent co-occurrence only. Over-supplied → keep the
	// most frequent for a cheap pre-fit, then the largest ridge coefficients
	// survive into the final model (§8 E).
	let pairs = [...cooc.entries()].filter(([, c]) => c >= minCooc).map(([k]) => k);
	const empty: SurrogateModel = { ok: false, n: samples.length, terms: 0, r2: 0, predict: () => ({ mean: samples.length ? wmean(samples) : 0, se: Infinity }), predictDiff: () => ({ mean: 0, se: Infinity }), covers: () => false, synergyPairs: () => [] };
	if (optIndex.size === 0) return empty;

	const buildMatrix = (pairList: string[]) => {
		const pIndex = new Map<string, number>();
		pairList.forEach((k, i) => pIndex.set(k, i));
		const m = 1 + optIndex.size + pairList.length;
		const X = new Array<number[]>(samples.length);
		const y = new Array<number>(samples.length);
		const w = new Array<number>(samples.length);
		for (let i = 0; i < samples.length; i++) {
			const row = new Array<number>(m).fill(0);
			row[0] = 1;
			for (const id of samples[i].selection) { const oi = optIndex.get(id); if (oi !== undefined) row[1 + oi] = 1; }
			const present = new Set(samples[i].selection);
			for (const key of pairList) { if (matches(key, present)) row[1 + optIndex.size + pIndex.get(key)!] = 1; }
			X[i] = row; y[i] = samples[i].mean; w[i] = normW[i];
		}
		return { X, y, w, m };
	};
	// §I per-column prior: λ on option columns, 10λ on the pair columns —
	// the prior is strongest exactly where the estimate is widest.
	const penFor = (m: number) => new Array<number>(m).fill(0).map((_, j) => (j === 0 || j <= optIndex.size ? lambda : lambda * SURROGATE_PAIR_PRIOR));

	if (pairs.length > pairCap) {
		pairs = pairs.sort((a, c) => (cooc.get(c)! - cooc.get(a)!) || (a < c ? -1 : 1)).slice(0, pairCap * 3);
		if (pairs.length > pairCap) {
			// Pre-fit with all candidates, keep the pairCap largest |coef|.
			const pre = buildMatrix(pairs);
			const fit = ridgeFit(pre.X, pre.y, pre.w, penFor(pre.m));
			if (fit) {
				const offs = 1 + optIndex.size;
				pairs = pairs
					.map((k, i) => ({ k, c: Math.abs(fit.beta[offs + i]) }))
					.sort((a, z) => z.c - a.c).slice(0, pairCap).map(x => x.k);
			} else pairs = pairs.slice(0, pairCap);
		}
	}
	// Final pair vocabulary (fixed for predictions and folds) + its lookup.
	const pIndex = new Map<string, number>();
	pairs.forEach((k, i) => pIndex.set(k, i));

	const { X, y, w, m } = buildMatrix(pairs);
	const full = ridgeFit(X, y, w, penFor(m), true);
	if (!full || m < 1) return { ...empty, terms: m };

	// Deterministic k-fold holdout R² (weighted), the §8 E debug gate.
	// §I: no more `trIdx.length < m` fold skip — ridge exists to handle
	// fewer rows than features; skipping made a wide model report R² 0.000
	// and pushed the search onto the in-context fallback it could beat.
	let ssTot = 0, ssRes = 0;
	const wsum = w.reduce((a, z) => a + z, 0) || 1;
	const ybar = y.reduce((a, z, i) => a + z * w[i], 0) / wsum;
	for (let f = 0; f < folds; f++) {
		const trIdx: number[] = [], teIdx: number[] = [];
		for (let i = 0; i < samples.length; i++) (i % folds === f ? teIdx : trIdx).push(i);
		if (!teIdx.length) continue;
		const sub = (idx: number[]) => idx.map(i => ({ row: X[i], y: y[i], w: w[i] }));
		const tr = sub(trIdx);
		const fit = ridgeFit(tr.map(t => t.row), tr.map(t => t.y), tr.map(t => t.w), penFor(m));
		if (!fit) { for (const i of teIdx) ssRes += w[i] * (y[i] - ybar) ** 2; continue; }
		for (const i of teIdx) { let f2 = 0; const row = X[i]; for (let j = 0; j < m; j++) f2 += row[j] * fit.beta[j]; ssRes += w[i] * (y[i] - f2) ** 2; }
	}
	for (let i = 0; i < samples.length; i++) ssTot += w[i] * (y[i] - ybar) ** 2;
	const r2 = ssTot > 1e-12 ? Math.max(-1, 1 - ssRes / ssTot) : 0;

	/** One-hot design row of a selection (§I hot path: keyed lookup, no scan). */
	const rowOf = (selection: readonly string[]): number[] => {
		const present = new Set(selection);
		const row = new Array<number>(m).fill(0);
		row[0] = 1;
		for (const id of selection) { const oi = optIndex.get(id); if (oi !== undefined) row[1 + oi] = 1; }
		for (const key of pairs) { if (!matches(key, present)) continue; const pj = pIndex.get(key); if (pj !== undefined) row[1 + optIndex.size + pj] = 1; }
		return row;
	};
	/** SE = sqrt(xᵀ Σ x), zero-skipping (the design row is sparse). */
	const seOf = (row: readonly number[], scale = 1): number => {
		let v = 0;
		for (let j = 0; j < m; j++) { if (row[j] === 0) continue; let acc = 0; const covj = full.cov![j]; for (let k = 0; k < m; k++) acc += covj[k] * row[k]; v += row[j] * acc; }
		return Math.sqrt(Math.max(0, v * scale));
	};
	// §I predictive scale for Δ-SEs: in-sample σ² measures the fit's residuals,
	// not the model's error — near a saturated design (the early fits: one row
	// per option, 25-seed screens) the residuals shrink while the predictions
	// are still worthless. A Δ-SE bound cuts candidates without racing them, so
	// it rides on the measured holdout MSE (the very quantity r2 comes from):
	// where the model is weak the bound self-silences, where it is tight it bites.
	const predScale = Math.max(1, (ssRes / (wsum || 1)) / full.sigma2);
	const predict = (selection: readonly string[]): SurrogatePrediction => {
		const row = rowOf(selection);
		let mean = 0;
		for (let j = 0; j < m; j++) mean += row[j] * full.beta[j];
		return { mean, se: seOf(row) };
	};
	const predictDiff = (a: readonly string[], b: readonly string[]): SurrogatePrediction => {
		const ra = rowOf(a), rb = rowOf(b);
		// d = row(a) − row(b): shared features cancel, the posterior variance
		// of the difference is dᵀΣd (§I — not the marginals in quadrature).
		const d = new Array<number>(m);
		let mean = 0;
		for (let j = 0; j < m; j++) { d[j] = ra[j] - rb[j]; mean += d[j] * full.beta[j]; }
		return { mean, se: seOf(d, predScale) };
	};
	const covers = (selection: readonly string[]) => selection.every(id => optIndex.has(id));

	const synergyPairs = (max: number, minCoef: number) => {
		const offs = 1 + optIndex.size;
		return pairs
			.map((k, i) => ({ k, coef: full.beta[offs + i] }))
			.filter(x => x.coef >= minCoef)
			.sort((a, z) => z.coef - a.coef)
			.slice(0, max)
			.map(x => { const [a, b] = pairSplit(x.k); return { a, b, coef: x.coef }; });
	};

	return { ok: true, n: samples.length, terms: m, r2, predict, predictDiff, covers, synergyPairs };
}

/** A pair term fires when BOTH its options are present. */
function matches(key: string, present: Set<string>): boolean {
	const sep = key.indexOf(SEP);
	if (sep < 0) return false;
	return present.has(key.slice(0, sep)) && present.has(key.slice(sep + 1));
}
function wmean(samples: readonly SurrogateSample[]): number {
	let s = 0, wsum = 0;
	for (const x of samples) { const w = x.weight > 0 ? x.weight : 1; s += x.mean * w; wsum += w; }
	return wsum ? s / wsum : 0;
}
