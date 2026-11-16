/**
 * Skill Optimizer Pane (SKILL-OPTIMIZER-PLAN Phase 2 UI).
 *
 * Minimal real UI over the optimizer engine in ./engines/globalsim/optimizer:
 * pick candidate skills + SP budget, choose objective/effort/seed, run the
 * anytime search with live progress, and read the verified shortlist with
 * honest ties ("≈ best" = CI of the paired difference contains 0).
 *
 * The pane owns only UI state; every number comes from runOptimizer's Stage G
 * verification (never from the search cache).
 */

import { h } from 'preact';
import { useState, useRef, useEffect, useMemo } from 'preact/hooks';

import { buildSpace, BuildSpace, activationCountSkill, simIdentity } from './engines/globalsim/optimizer/space';
import { BuildRefLite, createEvaluator, Evaluator } from './engines/globalsim/optimizer/evaluator';
import { createController, runOptimizer, SearchController } from './engines/globalsim/optimizer/search';
import { bookKey, saveBook, selectStarts } from './engines/globalsim/optimizer/book';
import { effortConfig } from './engines/globalsim/optimizer/config';
import type {
	ActivationTelemetry, AggregationKind, EffortPreset, MeanSem, ObjectiveKind, OptimizerProgress, OptimizerResult,
	ScenarioSpec, ScoredBuild,
} from './engines/globalsim/optimizer/types';
import type { ChartRaceConditions } from './engines/globalsim/chart';
import type { MobPreset } from './engines/globalsim/mobs';
import { ci95 } from './engines/globalsim/metrics';
import type { WorkerFactory } from './engines/globalsim/pool';
import { loadGlobalsimCourseIds } from './engines/globalsim/courses';
import { calculateSkillCost } from './skill-chart-utils';
import { pickCareerDump, type CareerImport } from './career-import';
import { convertUmaStateForWorker } from './simulation-utils';
import { HorseState } from '../../components/HorseDefTypes';
import { Grade, GroundCondition } from '../../uma-skill-tools/RaceParameters';
import { fromJS, Map as ImmMap } from 'immutable';
import skillnames from '../skillnames.json';

export interface OptimizerPaneProps {
	/** GlobalSim worker-pool factory (app-v2 globalsimWorkerFactory). */
	workerFactory: WorkerFactory;
	/** The current UmaState (uma1) — converted to HorseState here, exactly like the chart run. */
	uma: any;
	/** Offerable skill ids, already coverage-filtered by the caller. */
	candidates: string[];
	/** Merged GlobalSim skill table; null while the engine assets load. */
	skillData: unknown | null;
	/** courseData[courseId] — only .distance is read here. */
	course: { distance: number } & any;
	/** app-v2 holds courseId as a number; ChartRaceConditions accepts both. */
	courseId: string | number;
	/** Current UI race-condition values (same numeric enums the app holds). */
	conditions: { ground: number; weather: number; season: number; time: number };
	mobPreset: MobPreset;
	/** Fixed gate field index (app-v2 globalsimGate, "auto" → undefined): the
	 *  optimizer must race on the SAME gate the main sim / compare uses, not
	 *  always the per-seed auto-paired gate. */
	fixedGate?: number;
	/** groupId → learned skill id (app-v2 hasSkills). */
	ownedByGroup: Map<string, string>;
	/** skillHints (skill id → hint level). */
	hints: Map<string, number>;
	/** App base seed — pre-fills the seed input. */
	seed: number;
	/** "Open in Compare": hand the recommended build's added skills to the app,
	 *  which merges them onto a copy of the current uma as Uma 2 (optional). */
	onOpenInCompare?: (addedSkillIds: string[]) => void;
	/** A Hachimi career dump was imported: the app owns the uma and hint state, so
	 *  it applies those (stats, aptitudes, outfit, learned skills, hint levels). */
	onImportCareer?: (imp: CareerImport) => void;
}

/** skillnames values are arrays like ["JP", "EN"] — prefer last (EN), same as skill-chart-pane. */
const skillName = (id: string): string => {
	const names = (skillnames as Record<string, string[]>)[id];
	return names?.[names.length - 1] || names?.[0] || id;
};

const fmtN = (x: number | undefined | null, d = 2): string =>
	x != null && Number.isFinite(x) ? x.toFixed(d).replace('-0.00', '0.00') : '—';
const fmtPct = (x: number | undefined | null): string =>
	x != null && Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '—';

/** §E: an activation rate under this share of the races already run gets
 *  flagged (same amber as the stopped-early note). */
const LOW_ACTIVATION = 0.05;

/**
 * §E one skill's activation cell in the recommended-build table: the share
 * of the already-run (search) races it activated in (fired/seed, the same
 * rule as the skill chart). Zero reads "never fired", under 5% is flagged
 * amber, and no engine counts renders "—".
 */
function activationCell(id: string, act: ActivationTelemetry | undefined) {
	if (!act || act.seeds <= 0) {
		return <span style={{ opacity: 0.5 }} title="The engine reported no activation counts for these races">—</span>;
	}
	const fired = act.fired[id] ?? 0;
	const races = act.seeds.toLocaleString();
	if (fired === 0) {
		return <span style={{ color: '#d0a030' }} title={`Never activated in ${races} measured races`}>never fired</span>;
	}
	const rate = fired / act.seeds;
	return rate < LOW_ACTIVATION
		? <span style={{ color: '#d0a030' }} title={`Low activation: fired in only ${fmtPct(rate)} of ${races} measured races, under 5%`}>{fmtPct(rate)}</span>
		: <span title={`Fired in ${fmtPct(rate)} of ${races} measured races`}>{fmtPct(rate)}</span>;
}

/** mean ± 95% CI half-width from a MeanSem: ci95 takes the STANDARD DEVIATION,
 *  so reconstruct it from the SEM (sd = sem·√n) — same math as search.ts pairedOf. */
const fmtMeanCi = (m: MeanSem | undefined, d = 2): string => {
	if (!m || !Number.isFinite(m.mean)) return '—';
	const sd = (Number.isFinite(m.sem) ? m.sem : 0) * Math.sqrt(Math.max(1, m.n));
	const [lo, hi] = ci95(m.mean, sd, m.n);
	const half = Number.isFinite(hi) ? (hi - lo) / 2 : NaN;
	return `${fmtN(m.mean, d)} ± ${fmtN(half, d)}`;
};

/** Decimal places the objective value is shown with — a pure function of the
 *  objective (rates get 4, lengths/placings 2). Snapshotted per run so the
 *  finished table keeps the digits that match the run, not live state. */
const objDigitsOf = (o: ObjectiveKind): number => (o === 'p1' || o === 'pTop3' ? 4 : 2);

/** A finished run plus the objective/aggregation that produced it. Stored as
 *  ONE value so the finished table can never re-label a stored result with the
 *  live Objective/Aggregate dropdowns (the result numbers are frozen; the
 *  labels must be frozen with them — see the results render below). */
interface RunSnapshot {
	result: OptimizerResult;
	objective: ObjectiveKind;
	aggregation: AggregationKind;
	/** §G: whether that run searched the scenario set as one objective. */
	aggregated: boolean;
	objDigits: number;
}

const OBJECTIVES: { id: ObjectiveKind; label: string }[] = [
	{ id: 'p1', label: 'Win rate' },
	{ id: 'meanLead', label: 'Mean lead ℓ' },
	{ id: 'pTop3', label: 'P(top-3)' },
	{ id: 'meanPlacing', label: 'Mean placing' },
	{ id: 'gainVsCurrent', label: 'Gain vs current' },
];
const PRESETS: { id: EffortPreset; label: string }[] = [
	{ id: 'quick', label: 'Quick' },
	{ id: 'standard', label: 'Standard' },
	{ id: 'thorough', label: 'Thorough' },
	{ id: 'untilStopped', label: 'Until stopped' },
];
const AGGREGATIONS: { id: AggregationKind; label: string }[] = [
	{ id: 'mean', label: 'Average (mean)' },
	{ id: 'maximin', label: 'Worst case (maximin)' },
	{ id: 'blend', label: 'Blend (70% avg + 30% worst)' },
];
// Ground variants for the robustness scenario set (§6.3): same mob field,
// different footing, so a build must hold up across the ground the event might
// run on. Indexed; the current ground is always scenario 0.
const GROUND_LABEL: Record<number, string> = {
	[GroundCondition.Good]: 'Firm', [GroundCondition.Yielding]: 'Good',
	[GroundCondition.Soft]: 'Soft', [GroundCondition.Heavy]: 'Heavy',
};
const STAGE_LABEL: Record<OptimizerProgress['stage'], string> = {
	noise: 'Calibrating noise',
	screen: 'Screening options',
	knapsack: 'Knapsack starts',
	incontext: 'In-context search',
	local: 'Local search',
	verify: 'Verifying (fresh seeds)',
	done: 'Done',
	stopped: 'Stopped',
};

const inputStyle = {
	background: 'rgba(0,0,0,0.15)', color: 'inherit', border: '1px solid rgba(128,128,128,0.4)',
	borderRadius: 6, padding: '4px 8px', fontSize: 13,
} as const;
const labelStyle = { fontSize: 12, opacity: 0.8, display: 'block', marginBottom: 2 } as const;
const thStyle = { textAlign: 'left' as const, padding: '4px 8px', fontSize: 12, opacity: 0.75, whiteSpace: 'nowrap' as const };
const tdStyle = { padding: '4px 8px', fontSize: 13, verticalAlign: 'top' as const };

export function OptimizerPane(props: OptimizerPaneProps) {
	const { workerFactory, uma, candidates, skillData, course, courseId, conditions, mobPreset, fixedGate, ownedByGroup, hints } = props;

	// ── UI state ──────────────────────────────────────────────────────────────
	const [chosen, setChosen] = useState<Set<string>>(() => new Set(candidates));
	const [filter, setFilter] = useState('');
	const [budget, setBudget] = useState(10000);
	const [objective, setObjective] = useState<ObjectiveKind>('p1');
	const [preset, setPreset] = useState<EffortPreset>('standard');
	const [seed, setSeed] = useState(props.seed);
	const [aggregation, setAggregation] = useState<AggregationKind>('mean');
	/** §G: with a maximin/blend robustness run, search the scenario set as one
	 *  aggregated objective instead of one search per scenario. */
	const [aggregated, setAggregated] = useState(true);
	/** Robustness scenario count (ground variants, §6.3): 1 = current only. */
	const [robustness, setRobustness] = useState(1);
	const [useBook, setUseBook] = useState(true);
	const [running, setRunning] = useState(false);
	const [progress, setProgress] = useState<OptimizerProgress | null>(null);
	/** Finished run + the objective/aggregation/digits that shaped it (one value
	 *  so the results table can't drift from live dropdowns after the run). */
	const [runResult, setRunResult] = useState<RunSnapshot | null>(null);
	const [warnings, setWarnings] = useState<string[]>([]);
	const [message, setMessage] = useState<string | null>(null); // errors + hints share one line

	// ── run machinery ─────────────────────────────────────────────────────────
	const evRef = useRef<Evaluator | null>(null);
	const ctrlRef = useRef<SearchController | null>(null);
	const runningRef = useRef(false);
	const lastUiRef = useRef(0); // progress-throttle timestamp
	// False once unmounted. app-v2 renders this pane only on the Optimizer tab, so
	// switching tabs unmounts it while a run is still in flight; every post-await
	// setState below is gated on this so nothing touches a dead component.
	const mountedRef = useRef(true);

	// The pane is conditionally mounted, so this cleanup can fire MID-RUN. Mark
	// unmounted, then hard-stop the in-flight work:
	//  - dispose() only RESOLVES the running pool batch (pool.ts running?.resolve()),
	//    which does NOT stop the search — the orphaned runOptimizer would keep going
	//    and ensurePool() would respawn a pool nothing later releases.
	//  - ctrl.stop() winds the pipeline down; abort() REJECTS the running batch so
	//    the current ensure() throws and the run unwinds immediately.
	// The pool THIS run created is released in run()'s finally (on the local ev),
	// which — unlike evRef.current here — always reaches it even after the ref is
	// nulled (that nulling is exactly the window the leak used to slip through).
	useEffect(() => () => {
		mountedRef.current = false;
		ctrlRef.current?.stop();
		evRef.current?.abort();
		evRef.current = null;
	}, []);

	// candidates arrives async (the skill table loads after mount): when the
	// list first becomes non-empty, default to everything chosen.
	const seededRef = useRef(false);
	useEffect(() => {
		if (!seededRef.current && candidates.length) {
			seededRef.current = true;
			setChosen(new Set(candidates));
		}
	}, [candidates]);

	const filtered = useMemo(() => {
		const q = filter.trim().toLowerCase();
		if (!q) return candidates;
		return candidates.filter((id) => id.includes(q) || skillName(id).toLowerCase().includes(q));
	}, [candidates, filter]);

	const chosenCost = useMemo(() => {
		let c = 0;
		for (const id of chosen) c += calculateSkillCost(id, hints, ownedByGroup);
		return c;
	}, [chosen, hints, ownedByGroup]);

	const toggle = (id: string) =>
		setChosen((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id); else next.add(id);
			return next;
		});

	const stop = () => ctrlRef.current?.stop();

	// ── career dump import ────────────────────────────────────────────────────
	/** The offer pool from an imported Hachimi career dump, kept as a set so the
	 *  selection is re-cut whenever `candidates` changes (the imported uma
	 *  re-derives that list, and it lands after this handler returns). */
	const [poolFilter, setPoolFilter] = useState<Set<string> | null>(null);
	const [career, setCareer] = useState<CareerImport | null>(null);
	useEffect(() => {
		if (!poolFilter || !candidates.length) return;
		setChosen(new Set(candidates.filter((id) => poolFilter.has(id))));
	}, [poolFilter, candidates]);

	const importCareer = async () => {
		if (runningRef.current) return;
		const imp = await pickCareerDump();
		if (!imp) return;
		props.onImportCareer?.(imp); // outfit, stats, aptitudes, learned skills, hint levels
		if (imp.budget != null) setBudget(imp.budget);
		setPoolFilter(imp.offered.length ? new Set(imp.offered) : null);
		setCareer(imp);
	};

	const run = async () => {
		if (runningRef.current || !skillData || !workerFactory) return;
		runningRef.current = true;
		setRunning(true);
		setMessage(null);
		setRunResult(null);
		setProgress(null);
		setWarnings([]);
		// A previous run's pool must not linger (spec: dispose before each new run).
		evRef.current?.dispose();
		evRef.current = null;

		const budgetUse = Math.max(0, Math.floor(Number(budget) || 0));
		const seedUse = Math.floor(Number(seed) || 0);
		const space: BuildSpace = buildSpace({
			purchasable: [...chosen], ownedByGroup, fixedIds: [], hints, budget: budgetUse,
		});
		setWarnings(space.warnings);
		if (space.error) {
			setMessage(space.error);
			runningRef.current = false; setRunning(false);
			return;
		}
		if (space.options.length === 0) {
			setMessage('No purchasable options in the chosen set (already owned, purple, or outside the active table) — nothing to search.');
			runningRef.current = false; setRunning(false);
			return;
		}
		if (!course) {
			setMessage('Course data unavailable.');
			runningRef.current = false; setRunning(false);
			return;
		}

		// UmaState → HorseState, the exact chart-run conversion (app-v2).
		const w: any = convertUmaStateForWorker(uma);
		const baseHorse = new HorseState({
			...w,
			starCount: (uma as any).starCount,
			uniqueLv: (uma as any).uniqueLv,
		})
			.set('skills', fromJS(w.skills))
			.set('forcedSkillPositions', ImmMap(w.forcedSkillPositions || {}));

		const ctrl = createController();
		ctrlRef.current = ctrl;
		// Hoisted so the finally disposes THIS run's pool (below), not evRef.current
		// — an unmount nulls evRef.current, so disposing through the ref would
		// strand whatever pool the (possibly orphaned) run still ends up creating.
		let ev: Evaluator | null = null;
		try {
			const courseIds = await loadGlobalsimCourseIds();
			if (!courseIds) {
				throw new Error(
					`GlobalSim course table unavailable (/globalsim/courses.json) — run \`node umalator-global/build.mjs\` once to generate the GlobalSim assets.`,
				);
			}
			const conds: ChartRaceConditions = {
				courseId,
				distance: course.distance,
				ground: conditions.ground as ChartRaceConditions['ground'],
				weather: conditions.weather as ChartRaceConditions['weather'],
				season: conditions.season as ChartRaceConditions['season'],
				time: conditions.time as ChartRaceConditions['time'],
				grade: Grade.G1,
				knownSkillIds: new Set(Object.keys(skillData as Record<string, unknown>)),
				skillData: skillData as Record<string, unknown>,
				courseIds,
				mobPreset,
				// The user's fixed gate (undefined = auto-paired per seed) — the
				// same wiring the compare/chart runs use in app-v2. Scenarios
				// spread this object, so every ground variant keeps the gate.
				fixedGate,
			};
			// §6.3 scenario set: scenario 0 is the current setup; the robustness
			// variants re-run the SAME mob field on different footing.
			const grounds = [conditions.ground];
			for (const g of [GroundCondition.Good, GroundCondition.Soft, GroundCondition.Heavy]) {
				if (grounds.length >= robustness) break;
				if (!grounds.includes(g)) grounds.push(g);
			}
			const scenarios: ScenarioSpec[] = grounds.map((g, i) => {
				const gc = { ...conds, ground: g as ChartRaceConditions['ground'] };
				return {
					id: i === 0 ? 'main' : `ground-${g}`,
					label: i === 0 ? 'Current setup' : `${GROUND_LABEL[g] ?? `ground ${g}`} field`,
					conds: gc, mobPreset,
				};
			});
			const scenarioIdxs = scenarios.map((_, i) => i);
			ev = createEvaluator({
				workerFactory, space, baseHorse, scenarios, baseSeed: seedUse, skillData,
				// Every optimizer race (Stages A–G) runs paired: the search is a
				// chain of paired comparisons, and paired draws cut σΔ(ℓ) ~10×.
				paired: true,
			});
			evRef.current = ev;

			// §8 A opening book: fingerprint the primary setup, seed the search
			// from prior strong builds for it (re-filtered to today's roster).
			const bk = bookKey({
				courseId: String(courseId), distance: course.distance,
				strategy: String((uma as any)?.strategy ?? ''), mobPresetId: String((mobPreset as any)?.id ?? (mobPreset as any)?.name ?? 'default'),
				ground: conditions.ground,
			});
			const bookStarts = useBook ? selectStarts(space, bk) : [];

			// gainVsCurrent measures the paired ℓ gain against the user's ACTUAL
			// build, so that objective needs the reference build in the SearchInput —
			// without it every objective value is a diff against nothing (NaN) and
			// nothing is measurable. The user's build = learned skills + locked
			// picks (+ uniques), and ALL of those are implicit in space.fixedIds —
			// learned ids ride on baseHorse, locked ids join fixedIds and the
			// simulated horse too — so the reference build IS the base build.
			// An empty selection keeps its identity and SP accounting exact (a
			// locked id in `selection` would double-charge forcedCost in costOf).
			let current: BuildRefLite | undefined;
			if (objective === 'gainVsCurrent') {
				current = { id: simIdentity(space, []), selection: [] };
			}

			const res = await runOptimizer(
				ev,
				{
					space, scenarioIdx: 0, scenarioIdxs, objective, aggregation, aggregatedSearch: aggregated,
					bookStarts, current, effort: effortConfig(preset),
				},
				ctrl,
				(p) => {
					// A mid-run unmount can still emit an event before the abort
					// rejection unwinds the run — never setState on a dead component.
					if (!mountedRef.current) return;
					// Stage events fire often; cap state updates at ~10/s (the
					// terminal 'done' event always passes through).
					const now = Date.now();
					if (p.stage === 'done' || now - lastUiRef.current >= 100) {
						lastUiRef.current = now;
						setProgress(p);
					}
				},
			);
			// A mid-run unmount aborts/rejects the run, so this is reached only when
			// the search actually completed while mounted. If the pane unmounted in
			// the tiny window between resolve and here, skip every post-await update
			// (and the book write) — the finally still releases the pool.
			if (!mountedRef.current) return;
			// Contract kept visible in the console next to the table (§13 debugging).
			console.log('[optimizer]', res);
			// Freeze the objective/aggregation/digits with the result: they are the
			// closure values this run actually searched under (same as the input at
			// runOptimizer above), so the finished table can never be relabelled by
			// later changes to the live dropdowns.
			setRunResult({ result: res, objective, aggregation, aggregated, objDigits: objDigitsOf(objective) });
			setProgress(null);
			if (useBook) {
				saveBook(bk, res.shortlist.slice(0, 5).map(r => ({
					selection: [...r.build.selection], value: r.obj.mean, savedAt: Date.now(),
				})));
			}
		} catch (e) {
			// A mid-run unmount routes the abort rejection here — never setState
			// once the component is gone; the finally still releases the pool.
			if (mountedRef.current) setMessage(e instanceof Error ? e.message : String(e));
		} finally {
			// Dispose the evaluator this run owns (its possibly-respawned pool) even
			// if the pane unmounted mid-run — the leak was releasing through the
			// (nulled) evRef.current instead. dispose() is idempotent on a dead pool.
			ev?.dispose();
			if (evRef.current === ev) evRef.current = null;
			ctrlRef.current = null;
			runningRef.current = false;
			if (mountedRef.current) setRunning(false);
		}
	};

	// ── guards ────────────────────────────────────────────────────────────────
	if (!skillData || !workerFactory) {
		return (
			<div class="v2-optimizer-pane" style={{ padding: 16 }}>
				<h2>Skill Optimizer</h2>
				<p style={{ opacity: 0.8 }}>The GlobalSim engine is still loading — the optimizer
					needs the merged skill table and the wasm worker pool.</p>
			</div>
		);
	}
	if (!candidates.length) {
		return (
			<div class="v2-optimizer-pane" style={{ padding: 16 }}>
				<h2>Skill Optimizer</h2>
				<p style={{ opacity: 0.8 }}>No candidate skills for this uma/course — nothing to optimize.</p>
			</div>
		);
	}

	const objDigits = objDigitsOf(objective); // live, for the provisional readout during a run

	return (
		<div class="v2-optimizer-pane" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
			<div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
				<h2 style={{ margin: 0 }}>Skill Optimizer</h2>
				<span style={{ fontSize: 12, opacity: 0.7 }}>
					SP-budgeted skill-build search vs a {mobPreset?.name ? `${mobPreset.name} field` : '9-runner field'} — reported numbers come from fresh verification seeds.
				</span>
			</div>

			{/* ── Controls ── */}
			<div class="v2-optimizer-controls" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
				<div>
					<label style={labelStyle}>SP budget</label>
					<input type="number" min={0} step={50} style={{ ...inputStyle, width: 90 }} value={budget}
						disabled={running} onInput={(e) => setBudget((e.target as HTMLInputElement).valueAsNumber as number)} />
				</div>
				<div>
					<label style={labelStyle}>Objective</label>
					<select style={inputStyle} disabled={running} value={objective}
						onChange={(e) => setObjective((e.target as HTMLSelectElement).value as ObjectiveKind)}>
						{OBJECTIVES.map((o) => <option value={o.id}>{o.label}</option>)}
					</select>
				</div>
				<div>
					<label style={labelStyle}>Effort</label>
					<select style={inputStyle} disabled={running} value={preset}
						onChange={(e) => setPreset((e.target as HTMLSelectElement).value as EffortPreset)}>
						{PRESETS.map((p) => <option value={p.id}>{p.label}</option>)}
					</select>
				</div>
				<div>
					<label style={labelStyle}>Seed</label>
					<input type="number" step={1} style={{ ...inputStyle, width: 130 }} value={seed}
						disabled={running} onInput={(e) => setSeed((e.target as HTMLInputElement).valueAsNumber as number)} />
				</div>
				<div>
					<label style={labelStyle}>Robustness</label>
					<select style={inputStyle} disabled={running} value={robustness}
						onChange={(e) => setRobustness(Number((e.target as HTMLSelectElement).value))}>
						<option value={1}>This setup only</option>
						<option value={2}>+ 1 ground variant</option>
						<option value={3}>+ 2 ground variants</option>
					</select>
				</div>
				<div style={{ display: robustness > 1 ? 'block' : 'none' }}>
					<label style={labelStyle}>Aggregate</label>
					<select style={inputStyle} disabled={running} value={aggregation}
						onChange={(e) => setAggregation((e.target as HTMLSelectElement).value as AggregationKind)}>
						{AGGREGATIONS.map((a) => <option value={a.id}>{a.label}</option>)}
					</select>
				</div>
				<label style={{ display: robustness > 1 && aggregation !== 'mean' ? 'flex' : 'none', gap: 6, alignItems: 'center', fontSize: 13, paddingBottom: 4, cursor: 'pointer' }}
					title="Search the scenario set as one objective instead of searching each scenario apart and picking afterwards: every candidate is simulated on every ground, and a build is only adopted when it improves the aggregated value, so a compromise that is top-5 on no single ground can still win. Verification still reports each scenario separately.">
					<input type="checkbox" checked={aggregated} disabled={running} onChange={() => setAggregated((v) => !v)} />
					<span style={{ opacity: 0.85 }}>One aggregated search</span>
				</label>
				<label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, paddingBottom: 4, cursor: 'pointer' }}>
					<input type="checkbox" checked={useBook} disabled={running} onChange={() => setUseBook((v) => !v)} />
					<span style={{ opacity: 0.85 }}>Use &amp; save opening book</span>
				</label>
				<button type="button" class="v2-optimizer-run" disabled={running}
					style={{ padding: '6px 16px', borderRadius: 6, cursor: running ? 'default' : 'pointer' }}
					onClick={run}>
					{running ? 'Running…' : 'Run'}
				</button>
				<button type="button" class="v2-optimizer-stop" disabled={!running}
					style={{ padding: '6px 16px', borderRadius: 6, cursor: running ? 'pointer' : 'default' }}
					onClick={stop}>
					Stop
				</button>
			</div>

			{/* ── Candidate picker ── */}
			<div class="v2-optimizer-candidates">
				<div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
					<input style={{ ...inputStyle, flex: '1 1 180px' }} placeholder="Filter skills…" value={filter}
						disabled={running} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
					<button type="button" class="v2-optimizer-import" style={inputStyle} disabled={running}
						title="Load a Hachimi career dump: sets the uma from that career (outfit, stats, aptitudes, mood, learned skills), takes its SP budget and hint levels, and limits the pool to the skills the game was offering"
						onClick={importCareer}>Import career dump…</button>
					<button type="button" style={inputStyle} disabled={running}
						onClick={() => setChosen((prev) => new Set([...prev, ...filtered]))}>Select all</button>
					<button type="button" style={inputStyle} disabled={running} onClick={() => setChosen(new Set())}>Clear</button>
					<span style={{ fontSize: 12, opacity: 0.8 }}>
						{chosen.size} chosen · Σcost {chosenCost} SP
					</span>
				</div>
				{career && (
					<div class="v2-optimizer-career" style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>
						<span>{career.summary}</span>
						{poolFilter && <span style={{ opacity: 0.7 }}> · pool limited to what that career was offering</span>}
						{career.warnings.length > 0 && (
							<details style={{ display: 'inline', marginLeft: 6 }}>
								<summary style={{ display: 'inline', cursor: 'pointer', opacity: 0.8 }}>
									{career.warnings.length} import note{career.warnings.length > 1 ? 's' : ''}
								</summary>
								<ul style={{ margin: '4px 0 0', paddingLeft: 20, opacity: 0.75 }}>
									{career.warnings.map((w) => <li>{w}</li>)}
								</ul>
							</details>
						)}
					</div>
				)}
				<div class="v2-optimizer-candidate-list"
					style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid rgba(128,128,128,0.3)', borderRadius: 6, padding: 4 }}>
					{filtered.map((id) => {
						const cost = calculateSkillCost(id, hints, ownedByGroup);
						return (
							<label key={id} class="v2-optimizer-candidate" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, padding: '2px 4px', cursor: 'pointer' }}>
								<input type="checkbox" checked={chosen.has(id)} disabled={running} onChange={() => toggle(id)} />
								<span style={{ flex: 1 }}>{skillName(id)}</span>
								<span style={{ opacity: 0.6, fontSize: 12 }}>{id}</span>
								<span style={{ minWidth: 52, textAlign: 'right' }}>{cost} SP</span>
							</label>
						);
					})}
				</div>
			</div>

			{/* ── Space warnings (collapsed) ── */}
			{warnings.length > 0 && (
				<details class="v2-optimizer-warnings" style={{ fontSize: 12 }}>
					<summary style={{ cursor: 'pointer', opacity: 0.8 }}>{warnings.length} space warning(s)</summary>
					<ul style={{ margin: '4px 0', paddingLeft: 20, opacity: 0.7 }}>
						{warnings.map((wmsg) => <li>{wmsg}</li>)}
					</ul>
				</details>
			)}

			{message && <div class="v2-optimizer-message" style={{ color: '#e06060', fontSize: 13 }}>{message}</div>}

			{/* ── Live progress ── */}
			{(running || progress) && progress && (
				<div class="v2-optimizer-progress" style={{ border: '1px solid rgba(128,128,128,0.3)', borderRadius: 6, padding: 8, fontSize: 13 }}>
					<div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'baseline' }}>
						<strong>{STAGE_LABEL[progress.stage]}</strong>
						<span>{progress.racesRun.toLocaleString()} races{(progress.racesPlanned ? ` / ${progress.racesPlanned.toLocaleString()} planned` : '')}</span>
						<span>{(progress.elapsedMs / 1000).toFixed(1)} s elapsed</span>
						{progress.etaMs != null && <span>≈ {(progress.etaMs / 1000).toFixed(0)} s left</span>}
						{progress.note && <span style={{ opacity: 0.7 }}>{progress.note}</span>}
					</div>
					{progress.best && (
						<div style={{ marginTop: 4, opacity: 0.85 }}>
							provisional best:{' '}
							{progress.best.build.selection.length
								? progress.best.build.selection.map(skillName).join(', ')
								: '(no additions)'}{' '}
							— {fmtMeanCi(progress.best.obj, objDigits)} · {progress.best.sp} SP
						</div>
					)}
				</div>
			)}

			{/* ── Results ── (rendered from the frozen snapshot, never live state) */}
			{runResult && (
				<OptimizerResults
					result={runResult.result} objective={runResult.objective} objDigits={runResult.objDigits}
					aggregation={runResult.aggregation} aggregated={runResult.aggregated}
					hints={hints} ownedByGroup={ownedByGroup}
					onOpenInCompare={props.onOpenInCompare}
				/>
			)}
		</div>
	);
}

function OptimizerResults(props: {
	result: OptimizerResult; objective: ObjectiveKind; objDigits: number; aggregation: AggregationKind;
	aggregated: boolean;
	hints: Map<string, number>; ownedByGroup: Map<string, string>; onOpenInCompare?: (ids: string[]) => void;
}) {
	const { result, objective, objDigits, aggregation, aggregated, hints, ownedByGroup, onOpenInCompare } = props;
	const objLabel = OBJECTIVES.find((o) => o.id === objective)?.label ?? objective;
	const aggLabel = AGGREGATIONS.find((a) => a.id === aggregation)?.label ?? aggregation;
	const multi = (result.best.perScenario?.length ?? 0) > 1;
	const best = result.best;
	const openCompare = () => onOpenInCompare?.([...best.build.selection]);
	return (
		<div class="v2-optimizer-results">
			<table class="v2-optimizer-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
				<thead>
					<tr>
						<th style={thStyle}>#</th>
						<th style={thStyle}>Skills</th>
						<th style={{ ...thStyle, textAlign: 'right' }}>SP spent / left</th>
						<th style={{ ...thStyle, textAlign: 'right' }}>{objLabel} (95% CI){multi ? ` · ${aggLabel}` : ''}</th>
						{multi && <th style={{ ...thStyle, textAlign: 'right' }} title="Objective on the single worst scenario (the maximin floor)">worst scenario</th>}
						<th style={{ ...thStyle, textAlign: 'right' }}>P(1st)</th>
						<th style={{ ...thStyle, textAlign: 'right' }}>P(top-3)</th>
						<th style={{ ...thStyle, textAlign: 'right' }}>mean ℓ</th>
					</tr>
				</thead>
				<tbody>
					{result.shortlist.map((row: ScoredBuild, i: number) => (
						<tr class="v2-optimizer-row" key={`${row.build.id}#${i}`}>
							<td style={tdStyle}>
								{i + 1}
								{i > 0 && row.tiedWithBest && (
									<span class="v2-optimizer-tie" title="Statistically indistinguishable from the recommended build (CI of the paired difference contains 0)"
										style={{ marginLeft: 6, fontSize: 11, padding: '1px 5px', borderRadius: 4, border: '1px solid rgba(128,128,128,0.5)', opacity: 0.8 }}>
										≈ best
									</span>
								)}
							</td>
							<td style={tdStyle}>
								{row.build.selection.length ? row.build.selection.map(skillName).join(', ') : '(no additions)'}
							</td>
							<td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>{row.sp} / {row.leftover}</td>
							<td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap', fontWeight: i === 0 ? 600 : 400 }}>
								{fmtMeanCi(row.obj, objDigits)}
							</td>
							{multi && (() => {
								const vals = (row.perScenario ?? []).map(ps => ps.obj.mean).filter(Number.isFinite);
								return <td style={{ ...tdStyle, textAlign: 'right' }}>{vals.length ? fmtN(Math.min(...vals), objDigits) : '—'}</td>;
							})()}
							<td style={{ ...tdStyle, textAlign: 'right' }}>{fmtPct(row.stats?.win.mean)}</td>
							<td style={{ ...tdStyle, textAlign: 'right' }}>{fmtPct(row.stats?.top3.mean)}</td>
							<td style={{ ...tdStyle, textAlign: 'right' }}>{fmtN(row.stats?.lead.mean)}</td>
						</tr>
					))}
				</tbody>
			</table>
			{best.build.selection.length > 0 && (
				<details class="v2-optimizer-inbuild" open style={{ marginTop: 8, fontSize: 13 }}>
					<summary style={{ cursor: 'pointer', opacity: 0.85 }}>
						Recommended build · {best.build.selection.length} skill{best.build.selection.length > 1 ? 's' : ''} · {best.sp} SP
						{multi ? ` · worst scenario ${fmtN(Math.min(...(best.perScenario ?? []).map(p => p.obj.mean).filter(Number.isFinite)), objDigits)}` : ''}
					</summary>
					<table style={{ marginTop: 6, borderCollapse: 'collapse' }}>
						<thead>
							<tr>
								<th style={thStyle}>Skill</th>
								<th style={{ ...thStyle, textAlign: 'right' }}>SP</th>
								<th style={{ ...thStyle, textAlign: 'right' }} title="Share of the races the optimizer already ran in which this skill activated (search seeds, no extra races). Under 5% is flagged.">Activation</th>
							</tr>
						</thead>
						<tbody>
							{best.build.selection.map((id) => (
								<tr key={id}>
									<td style={tdStyle}>
										{skillName(id)}
										{activationCountSkill(id) && <span title="Its condition reads an activate_count_* condition: it can only fire after other skills have, so the pipeline can only judge it from measured rates">*</span>}
									</td>
									<td style={{ ...tdStyle, textAlign: 'right' }}>{calculateSkillCost(id, hints, ownedByGroup)} SP</td>
									<td style={{ ...tdStyle, textAlign: 'right' }}>{activationCell(id, result.bestActivations)}</td>
								</tr>
							))}
						</tbody>
					</table>
					{best.build.selection.some(activationCountSkill) && (
						<div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
							* activation depends on earlier activations (activate_count condition): the rate shown is measured from races, not predicted
						</div>
					)}
					{multi && best.perScenario && (
						<div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
							per scenario: {best.perScenario.map(ps => `${ps.id} ${fmtN(ps.obj.mean, objDigits)}`).join(' · ')}
						</div>
					)}
					{onOpenInCompare && (
						<button type="button" class="v2-optimizer-compare" style={{ marginTop: 8, padding: '5px 12px', borderRadius: 6, cursor: 'pointer' }}
							title="Load this build onto a copy of your current uma as Uma 2, to compare against it"
							onClick={openCompare}>
							Open in Compare →
						</button>
					)}
				</details>
			)}
			<div class="v2-optimizer-footnote" style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
				verification: {result.verificationSeeds.toLocaleString()} fresh seeds · noise σΔ(ℓ) {fmtN(result.noise.sigmaDeltaLead)} L
				{multi ? ` · ${aggregated ? 'one aggregated search, aggregated by ' : 'scenarios searched apart, aggregated by '}${aggLabel.toLowerCase()}` : ''}
				{result.stoppedEarly && (
					<span style={{ color: '#d0a030', marginLeft: 10 }}>
						Stopped early — results come from the short Stage G verification only.
					</span>
				)}
			</div>
		</div>
	);
}
