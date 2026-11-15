/**
 * Stage E — surrogate model (SKILL-OPTIMIZER-PLAN §8 E): a Bayesian linear
 * (ridge) model that scores a build's target (mean ℓ, or logit P(1st)) from
 * per-option indicators plus pairwise interaction terms, so Stage F can order
 * and prune thousands of candidate moves in microseconds instead of races (P1:
 * the surrogate only decides what to simulate next, never the decision itself).
 *
 * The module is deliberately pure — it knows nothing about skills, the engine
 * or the cache. It fits a weighted design matrix and answers two questions:
 * `predict(selection) → {mean, se}` and `synergyPairs()` (the strongest
 * positive interaction terms, for paired add/remove moves). A closed-form
 * posterior gives the SE the acquisition and the α/β-with-error-bars prune use.
 *
 * Features: intercept, one indicator per option that appears in the training
 * set, and pairwise terms for option pairs that co-occur in at least
 * `minPairCooccur` builds — capped at `pairCap` terms, the largest-magnitude
 * ridge coefficients surviving a cheap pre-fit (§8 E).
 */

import { SURROGATE_LAMBDA, SURROGATE_PAIR_CAP, SURROGATE_PAIR_MIN_COOC } from './config';

/** Separator for pair-term keys: a control char that never appears in a skill id. */
const SEP = '\u0001';

export interface SurrogateSample {
	/** The build's option ids (order-insensitive). */
	selection: readonly string[];
	/** Regression target: mean ℓ (higher = better) or logit P(1st). */
	mean: number;
	/** Inverse-variance weight of the mean (n_seeds / var); ≤ 0 treated as 1. */
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
	/** True when EVERY option is a learned feature (else `predict` ignores the
	 *  unseen ones and its estimate is untrustworthy — don't prune on it). */
	covers(selection: readonly string[]): boolean;
	/** Strongest positive pair interactions (synergy flags for pair moves). */
	synergyPairs(max: number, minCoef: number): { a: string; b: string; coef: number }[];
}

const pairKey = (a: string, b: string) => (a < b ? a + SEP + b : b + SEP + a);
const pairSplit = (k: string) => k.split(SEP) as [string, string];

/** Dense symmetric ridge solve: returns β and the (σ²-scaled) covariance. */
function ridgeFit(X: number[][], y: number[], w: number[], lambda: number): { beta: number[]; cov: number[][]; sigma2: number } | null {
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
	for (let j = 0; j < m; j++) A[j * m + j] += (j === 0 ? 1e-8 : lambda) + 1e-8;
	// Gauss-Jordan inverse (A | I → I | A⁻¹); β = A⁻¹b.
	const aug = new Float64Array(m * 2 * m);
	for (let r = 0; r < m; r++) {
		for (let c = 0; c < m; c++) aug[r * 2 * m + c] = A[r * m + c];
		aug[r * 2 * m + m + r] = 1;
	}
	for (let c = 0; c < m; c++) {
		let p = c, best = Math.abs(aug[c * 2 * m + c]);
		for (let r = c + 1; r < m; r++) { const v = Math.abs(aug[r * 2 * m + c]); if (v > best) { best = v; p = r; } }
		if (best < 1e-12) return null; // singular
		if (p !== c) for (let k = 0; k < 2 * m; k++) { const t = aug[c * 2 * m + k]; aug[c * 2 * m + k] = aug[p * 2 * m + k]; aug[p * 2 * m + k] = t; }
		const piv = aug[c * 2 * m + c];
		for (let k = 0; k < 2 * m; k++) aug[c * 2 * m + k] /= piv;
		for (let r = 0; r < m; r++) {
			if (r === c) continue;
			const f = aug[r * 2 * m + c];
			if (f === 0) continue;
			for (let k = 0; k < 2 * m; k++) aug[r * 2 * m + k] -= f * aug[c * 2 * m + k];
		}
	}
	const Ainv = new Float64Array(m * m);
	const beta = new Float64Array(m);
	for (let r = 0; r < m; r++) {
		beta[r] = 0;
		for (let c = 0; c < m; c++) { Ainv[r * m + c] = aug[r * 2 * m + m + c]; beta[r] += Ainv[r * m + c] * b[c]; }
	}
	// σ² = weighted SSR / dof.
	let ssr = 0;
	for (let i = 0; i < n; i++) { let f = 0; const xi = X[i]; for (let j = 0; j < m; j++) f += xi[j] * beta[j]; const e = y[i] - f; ssr += w[i] * e * e; }
	const sigma2 = Math.max(1e-9, ssr / Math.max(1, n - Math.min(m, n)));
	const cov: number[][] = [];
	for (let r = 0; r < m; r++) { const row = new Array<number>(m); for (let c = 0; c < m; c++) row[c] = sigma2 * Ainv[r * m + c]; cov.push(row); }
	return { beta: Array.from(beta), cov, sigma2 };
}

export function fitSurrogate(samples: readonly SurrogateSample[], opts: SurrogateOptions = {}): SurrogateModel {
	const lambda = opts.lambda ?? SURROGATE_LAMBDA;
	const minCooc = opts.minPairCooccur ?? SURROGATE_PAIR_MIN_COOC;
	const pairCap = opts.pairCap ?? SURROGATE_PAIR_CAP;
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
	// Candidate pairs: frequent co-occurrence only. Over-supplied → keep the
	// most frequent for a cheap pre-fit, then the largest ridge coefficients
	// survive into the final model (§8 E).
	let pairs = [...cooc.entries()].filter(([, c]) => c >= minCooc).map(([k]) => k);
	const empty: SurrogateModel = { ok: false, n: samples.length, terms: 0, r2: 0, predict: () => ({ mean: samples.length ? wmean(samples) : 0, se: Infinity }), covers: () => false, synergyPairs: () => [] };
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
			X[i] = row; y[i] = samples[i].mean; w[i] = samples[i].weight > 0 ? samples[i].weight : 1;
		}
		return { X, y, w, m };
	};

	if (pairs.length > pairCap * 3) {
		pairs = pairs.sort((a, c) => (cooc.get(c)! - cooc.get(a)!) || (a < c ? -1 : 1)).slice(0, pairCap * 3);
		if (pairs.length > pairCap) {
			// Pre-fit with all candidates, keep the pairCap largest |coef|.
			const pre = buildMatrix(pairs);
			const fit = ridgeFit(pre.X, pre.y, pre.w, lambda);
			if (fit) {
				const offs = 1 + optIndex.size;
				pairs = pairs
					.map((k, i) => ({ k, c: Math.abs(fit.beta[offs + i]) }))
					.sort((a, z) => z.c - a.c).slice(0, pairCap).map(x => x.k);
			} else pairs = pairs.slice(0, pairCap);
		}
	}

	const { X, y, w, m } = buildMatrix(pairs);
	const full = ridgeFit(X, y, w, lambda);
	if (!full || m < 1) return { ...empty, terms: m };

	// Deterministic k-fold holdout R² (weighted), the §8 E debug gate.
	let ssTot = 0, ssRes = 0;
	const wsum = w.reduce((a, z) => a + z, 0) || 1;
	const ybar = y.reduce((a, z, i) => a + z * w[i], 0) / wsum;
	for (let f = 0; f < folds; f++) {
		const trIdx: number[] = [], teIdx: number[] = [];
		for (let i = 0; i < samples.length; i++) (i % folds === f ? teIdx : trIdx).push(i);
		if (!teIdx.length || trIdx.length < m) { // too few to fit this fold: skip its residual
			for (const i of teIdx) ssRes += w[i] * (y[i] - ybar) ** 2;
			continue;
		}
		const sub = (idx: number[]) => idx.map(i => ({ row: X[i], y: y[i], w: w[i] }));
		const tr = sub(trIdx);
		const fit = ridgeFit(tr.map(t => t.row), tr.map(t => t.y), tr.map(t => t.w), lambda);
		if (!fit) { for (const i of teIdx) ssRes += w[i] * (y[i] - ybar) ** 2; continue; }
		for (const i of teIdx) { let f2 = 0; const row = X[i]; for (let j = 0; j < m; j++) f2 += row[j] * fit.beta[j]; ssRes += w[i] * (y[i] - f2) ** 2; }
	}
	for (let i = 0; i < samples.length; i++) ssTot += w[i] * (y[i] - ybar) ** 2;
	const r2 = ssTot > 1e-12 ? Math.max(-1, 1 - ssRes / ssTot) : 0;

	const predict = (selection: readonly string[]): SurrogatePrediction => {
		const present = new Set(selection);
		const row = new Array<number>(m).fill(0);
		row[0] = 1;
		for (const id of selection) { const oi = optIndex.get(id); if (oi !== undefined) row[1 + oi] = 1; }
		for (const key of pairs) if (matches(key, present)) row[1 + optIndex.size + pIndexOf(key)] = 1;
		let mean = 0;
		for (let j = 0; j < m; j++) mean += row[j] * full.beta[j];
		// SE = sqrt(xᵀ Σ x).
		let v = 0;
		for (let j = 0; j < m; j++) { if (row[j] === 0) continue; let acc = 0; const covj = full.cov[j]; for (let k = 0; k < m; k++) acc += covj[k] * row[k]; v += row[j] * acc; }
		return { mean, se: Math.sqrt(Math.max(0, v)) };
	};
	const pIndexOf = (key: string) => pairs.indexOf(key);
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

	return { ok: true, n: samples.length, terms: m, r2, predict, covers, synergyPairs };
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
