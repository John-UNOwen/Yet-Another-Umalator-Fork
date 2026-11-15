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

import { buildSpace, BuildSpace } from './engines/globalsim/optimizer/space';
import { createEvaluator, Evaluator } from './engines/globalsim/optimizer/evaluator';
import { createController, runOptimizer, SearchController } from './engines/globalsim/optimizer/search';
import { effortConfig } from './engines/globalsim/optimizer/config';
import type {
	EffortPreset, MeanSem, ObjectiveKind, OptimizerProgress, OptimizerResult,
	ScenarioSpec, ScoredBuild,
} from './engines/globalsim/optimizer/types';
import type { ChartRaceConditions } from './engines/globalsim/chart';
import type { MobPreset } from './engines/globalsim/mobs';
import { ci95 } from './engines/globalsim/metrics';
import type { WorkerFactory } from './engines/globalsim/pool';
import { loadGlobalsimCourseIds } from './engines/globalsim/courses';
import { calculateSkillCost } from './skill-chart-utils';
import { convertUmaStateForWorker } from './simulation-utils';
import { HorseState } from '../../components/HorseDefTypes';
import { Grade } from '../../uma-skill-tools/RaceParameters';
import { fromJS, Map as ImmMap } from 'immutable';
import skillnames from '../skillnames.json';

export interface OptimizerPaneProps {
	/** GlobalSim worker-pool factory (app-v2 globalsimWorkerFactory). */
	workerFactory: WorkerFactory;
	/** The current UmaState (uma1) — converted to HorseState here, exactly like the chart run. */
	uma: any;
	/** Offerable skill ids, already coverage-filtered by the caller. */
	candidates: string[];
	/** Merged engine skill table; null until the GlobalSim engine is loaded. */
	skillData: unknown | null;
	/** courseData[courseId] — only .distance is read here. */
	course: { distance: number } & any;
	/** app-v2 holds courseId as a number; ChartRaceConditions accepts both. */
	courseId: string | number;
	/** Current UI race-condition values (same numeric enums the app holds). */
	conditions: { ground: number; weather: number; season: number; time: number };
	mobPreset: MobPreset;
	/** groupId → learned skill id (app-v2 hasSkills). */
	ownedByGroup: Map<string, string>;
	/** skillHints (skill id → hint level). */
	hints: Map<string, number>;
	/** App base seed — pre-fills the seed input. */
	seed: number;
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

/** mean ± 95% CI half-width from a MeanSem: ci95 takes the STANDARD DEVIATION,
 *  so reconstruct it from the SEM (sd = sem·√n) — same math as search.ts pairedOf. */
const fmtMeanCi = (m: MeanSem | undefined, d = 2): string => {
	if (!m || !Number.isFinite(m.mean)) return '—';
	const sd = (Number.isFinite(m.sem) ? m.sem : 0) * Math.sqrt(Math.max(1, m.n));
	const [lo, hi] = ci95(m.mean, sd, m.n);
	const half = Number.isFinite(hi) ? (hi - lo) / 2 : NaN;
	return `${fmtN(m.mean, d)} ± ${fmtN(half, d)}`;
};

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
	const { workerFactory, uma, candidates, skillData, course, courseId, conditions, mobPreset, ownedByGroup, hints } = props;

	// ── UI state ──────────────────────────────────────────────────────────────
	const [chosen, setChosen] = useState<Set<string>>(() => new Set(candidates));
	const [filter, setFilter] = useState('');
	const [budget, setBudget] = useState(10000);
	const [objective, setObjective] = useState<ObjectiveKind>('p1');
	const [preset, setPreset] = useState<EffortPreset>('standard');
	const [seed, setSeed] = useState(props.seed);
	const [running, setRunning] = useState(false);
	const [progress, setProgress] = useState<OptimizerProgress | null>(null);
	const [result, setResult] = useState<OptimizerResult | null>(null);
	const [warnings, setWarnings] = useState<string[]>([]);
	const [message, setMessage] = useState<string | null>(null); // errors + hints share one line

	// ── run machinery ─────────────────────────────────────────────────────────
	const evRef = useRef<Evaluator | null>(null);
	const ctrlRef = useRef<SearchController | null>(null);
	const runningRef = useRef(false);
	const lastUiRef = useRef(0); // progress-throttle timestamp

	// Release the worker pool on unmount (the cache is internal, nothing to keep).
	useEffect(() => () => {
		evRef.current?.dispose();
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

	const run = async () => {
		if (runningRef.current || !skillData || !workerFactory) return;
		runningRef.current = true;
		setRunning(true);
		setMessage(null);
		setResult(null);
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
			};
			const scenarios: ScenarioSpec[] = [{ id: 'main', label: 'Current setup', conds, mobPreset }];
			const ev = createEvaluator({
				workerFactory, space, baseHorse, scenarios, baseSeed: seedUse, skillData,
			});
			evRef.current = ev;

			const res = await runOptimizer(
				ev,
				{ space, scenarioIdx: 0, objective, aggregation: 'mean', effort: effortConfig(preset) },
				ctrl,
				(p) => {
					// Stage events fire often; cap state updates at ~10/s (the
					// terminal 'done' event always passes through).
					const now = Date.now();
					if (p.stage === 'done' || now - lastUiRef.current >= 100) {
						lastUiRef.current = now;
						setProgress(p);
					}
				},
			);
			// Contract kept visible in the console next to the table (§13 debugging).
			console.log('[optimizer]', res);
			setResult(res);
			setProgress(null);
		} catch (e) {
			setMessage(e instanceof Error ? e.message : String(e));
		} finally {
			evRef.current?.dispose();
			evRef.current = null;
			ctrlRef.current = null;
			runningRef.current = false;
			setRunning(false);
		}
	};

	// ── guards ────────────────────────────────────────────────────────────────
	if (!skillData || !workerFactory) {
		return (
			<div class="v2-optimizer-pane" style={{ padding: 16 }}>
				<h2>Skill Optimizer</h2>
				<p style={{ opacity: 0.8 }}>Load the GlobalSim engine first (engine switch in Settings) — the optimizer
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

	const objDigits = objective === 'p1' || objective === 'pTop3' ? 4 : 2;

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
					<button type="button" style={inputStyle} disabled={running}
						onClick={() => setChosen((prev) => new Set([...prev, ...filtered]))}>Select all</button>
					<button type="button" style={inputStyle} disabled={running} onClick={() => setChosen(new Set())}>Clear</button>
					<span style={{ fontSize: 12, opacity: 0.8 }}>
						{chosen.size} chosen · Σcost {chosenCost} SP
					</span>
				</div>
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

			{/* ── Results ── */}
			{result && <OptimizerResults result={result} objective={objective} objDigits={objDigits} />}
		</div>
	);
}

function OptimizerResults(props: { result: OptimizerResult; objective: ObjectiveKind; objDigits: number }) {
	const { result, objective, objDigits } = props;
	const objLabel = OBJECTIVES.find((o) => o.id === objective)?.label ?? objective;
	return (
		<div class="v2-optimizer-results">
			<table class="v2-optimizer-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
				<thead>
					<tr>
						<th style={thStyle}>#</th>
						<th style={thStyle}>Skills</th>
						<th style={{ ...thStyle, textAlign: 'right' }}>SP spent / left</th>
						<th style={{ ...thStyle, textAlign: 'right' }}>{objLabel} (95% CI)</th>
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
							<td style={{ ...tdStyle, textAlign: 'right' }}>{fmtPct(row.stats?.win.mean)}</td>
							<td style={{ ...tdStyle, textAlign: 'right' }}>{fmtPct(row.stats?.top3.mean)}</td>
							<td style={{ ...tdStyle, textAlign: 'right' }}>{fmtN(row.stats?.lead.mean)}</td>
						</tr>
					))}
				</tbody>
			</table>
			<div class="v2-optimizer-footnote" style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
				verification: {result.verificationSeeds.toLocaleString()} fresh seeds · noise σΔ(ℓ) {fmtN(result.noise.sigmaDeltaLead)} L
				{result.stoppedEarly && (
					<span style={{ color: '#d0a030', marginLeft: 10 }}>
						Stopped early — results come from the short Stage G verification only.
					</span>
				)}
			</div>
		</div>
	);
}
