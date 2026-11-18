/**
 * Skill Optimizer pane.
 *
 * Setup (SP, goal, effort, settings), the skill pool (each skill Off, Allowed
 * or Must have), live progress, and the verified results: one card per build,
 * and for the selected build what each of its skills is worth. The app's RUN
 * button starts and stops a run (controlRef).
 *
 * The pane owns only UI state. Every reported number comes from runOptimizer's
 * Stage G verification or from its per-build worth measurement, never from
 * the search's provisional estimates.
 */

import { h, Fragment } from 'preact';
import { useState, useRef, useEffect, useMemo } from 'preact/hooks';
import { Wand2 } from 'lucide-react';

import { buildSpace, BuildSpace, activationCountSkill, simIdentity } from './engines/globalsim/optimizer/space';
import { BuildRefLite, createEvaluator, Evaluator } from './engines/globalsim/optimizer/evaluator';
import { createController, runOptimizer, SearchController } from './engines/globalsim/optimizer/search';
import { bookCount, bookKey, clearBook, saveBook, selectStarts } from './engines/globalsim/optimizer/book';
import {
	applyTuning, CUSTOM_STARTS_MAX, DEFAULT_CUSTOM, effortConfig, KICK_GROW_AFTER, KICKS_PER_VISIT,
	SearchTuning, TUNING_LIMITS,
} from './engines/globalsim/optimizer/config';
import { SPREAD_MIN_DIFF_PICKS, SPREAD_NOISE } from './engines/globalsim/optimizer/knapsack';
import type {
	ActivationTelemetry, ContributionDiff, EffortPreset, MeanSem, ObjectiveKind, OptimizerProgress, OptimizerResult,
	ScenarioSpec, ScoredBuild,
} from './engines/globalsim/optimizer/types';
import { ciHalfWidth, resolvedDiff } from './engines/globalsim/optimizer/contributions';
import type { ChartRaceConditions } from './engines/globalsim/chart';
import type { MobPreset } from './engines/globalsim/mobs';
import { ci95 } from './engines/globalsim/metrics';
import type { WorkerFactory } from './engines/globalsim/pool';
import { loadGlobalsimCourseIds } from './engines/globalsim/courses';
import { applyExclusions, calculateSkillCost, hintDiscountPercent, hintLinkedIds, MAX_HINT_LEVEL, type PoolExclusion } from './skill-chart-utils';
import { PoolExclusionList } from './pool-exclusions';
import { STRATEGY_LABELS } from './uma-panel';
import { pickCareerDump, type CareerImport } from './career-import';
import { convertUmaStateForWorker } from './simulation-utils';
import {
	Badge, Button, CustomSelect, Dice5, Input, NumberInput, RotateCcw, Search, SegmentedControl, Switch, Trash2, Upload,
} from './components';
import { HorseState } from '../../components/HorseDefTypes';
import { BASE_PATH } from '../../components/base-path';
import { Grade } from '../../uma-skill-tools/RaceParameters';
import { fromJS, Map as ImmMap } from 'immutable';
import skillnames from '../skillnames.json';
import skillmeta from '../../skill_meta.json';

export interface OptimizerPaneProps {
	/** GlobalSim worker-pool factory (app-v2 globalsimWorkerFactory). */
	workerFactory: WorkerFactory;
	/** The current UmaState (uma1), converted to HorseState here like the chart run. */
	uma: any;
	/** Offerable skill ids, already coverage-filtered by the caller. */
	candidates: string[];
	/** Skills the caller left out of `candidates`, each with its reason (skill-chart-utils partitionPool). */
	excluded: PoolExclusion[];
	/** Merged GlobalSim skill table, null while the engine assets load. */
	skillData: unknown | null;
	/** courseData[courseId], only .distance is read here. */
	course: { distance: number } & any;
	/** app-v2 holds courseId as a number, ChartRaceConditions accepts both. */
	courseId: string | number;
	/** Current UI race-condition values (same numeric enums the app holds). */
	conditions: { ground: number; weather: number; season: number; time: number };
	/** Running-style focus: writes uma.strategy, the one value both the pool
	 *  filter (skill-chart-utils partitionPool) and the search's races read, so
	 *  they cannot end up filtered for one style and raced for another. */
	onStrategyChange?: (style: string) => void;
	mobPreset: MobPreset;
	/** Fixed gate field index (app-v2 globalsimGate, "auto" is undefined): the
	 *  optimizer races on the SAME gate the compare and chart runs use. */
	fixedGate?: number;
	/** groupId → learned skill id (app-v2 hasSkills). */
	ownedByGroup: Map<string, string>;
	/** skillHints (skill id → hint level). */
	hints: Map<string, number>;
	/** App base seed, pre-fills the seed input. */
	seed: number;
	/** "Open in Compare": hand a build's added skills to the app, which merges
	 *  them onto a copy of the current uma as Uma 2 (optional). */
	onOpenInCompare?: (addedSkillIds: string[]) => void;
	/** A Hachimi career dump was imported: the app owns the uma and hint state, so
	 *  it applies those (stats, aptitudes, outfit, learned skills, hint levels). */
	onImportCareer?: (imp: CareerImport) => void;
	/** Set one skill's hint level (0 to 5) in the app's shared hint state, the
	 *  same state the Skill tab's hint buttons write. */
	onHintChange?: (id: string, level: number) => void;
	/** Clear every hint level (the Skill tab's Reset Hints). */
	onResetHints?: () => void;
	/** Filled with this pane's run and stop, so the app's RUN button drives the
	 *  optimizer (the pane has no run button of its own). */
	controlRef?: { current: OptimizerControl | null };
	/** Called when a run starts and when it ends (also on unmount). */
	onRunningChange?: (running: boolean) => void;
}

/** What the app's RUN button calls while the Optimizer tab is open. */
export interface OptimizerControl {
	run(): void;
	stop(): void;
}

// ── skill display helpers ───────────────────────────────────────────────────

const meta = skillmeta as Record<string, { iconId?: string | number; groupId?: string }>;

/** skillnames values are arrays like ["JP", "EN"], prefer the last (EN), same as skill-chart-pane. */
const skillName = (id: string): string => {
	const names = (skillnames as Record<string, string[]>)[id];
	return names?.[names.length - 1] || names?.[0] || id;
};

const skillIcon = (id: string): string => `${BASE_PATH}/icons/${meta[id]?.iconId || 'skill_empty'}.png`;

/** Skill kinds for the pool's groups. Inherited uniques (9xxxxx ids) get their
 *  own group, the rest go by the icon family the game uses for the skill
 *  (1xxxx stat boosts, 2001x speed, 2002x recovery, 2004x acceleration, 3xxxx
 *  debuffs). */
type SkillKind = 'speed' | 'accel' | 'recovery' | 'debuff' | 'green' | 'other' | 'unique';
const KIND_ORDER: SkillKind[] = ['speed', 'accel', 'recovery', 'debuff', 'green', 'other', 'unique'];
const KIND_LABEL: Record<SkillKind, string> = {
	speed: 'Speed', accel: 'Acceleration', recovery: 'Recovery', debuff: 'Debuffs', green: 'Stat boosts', other: 'Other',
	unique: 'Inherited uniques',
};
function kindOf(id: string): SkillKind {
	if (id.startsWith('9')) return 'unique';
	const icon = String(meta[id]?.iconId ?? '');
	if (icon.startsWith('1')) return 'green';
	if (icon.startsWith('3')) return 'debuff';
	if (icon.startsWith('2001')) return 'speed';
	if (icon.startsWith('2002')) return 'recovery';
	if (icon.startsWith('2004')) return 'accel';
	return 'other';
}

function SkillChip(props: { id: string; tone?: 'added' | 'missing' | 'must' }) {
	const { id, tone } = props;
	return (
		<span class={`v2-opt-chip${tone ? ` ${tone}` : ''}`} title={`${skillName(id)} (${id})`}>
			<img src={skillIcon(id)} alt="" loading="lazy" />
			<span>{skillName(id)}</span>
		</span>
	);
}

/** A pool row's cost with the Skill tab's hint buttons around it. A hint lowers
 *  the SP cost (10, 20, 30, 35, 40% at levels 1 to 5), and a ○ / ◎ pair moves
 *  together (withHintLevel). Without a setter it is the plain cost. */
function HintCost(props: { id: string; cost: number; hint: number; disabled: boolean; onChange?: (level: number) => void }) {
	const { id, cost, hint, disabled, onChange } = props;
	if (!onChange) return <span class="v2-opt-skill-cost">{cost} SP</span>;
	const name = skillName(id);
	const step = (d: 1 | -1) => onChange(Math.max(0, Math.min(MAX_HINT_LEVEL, hint + d)));
	const downOff = disabled || hint <= 0;
	const upOff = disabled || hint >= MAX_HINT_LEVEL;
	const partner = hintLinkedIds(id).find((x) => x !== id);
	const title = (hint > 0 ? `Hint level ${hint}: ${hintDiscountPercent(hint)}% off` : 'No hint: full price')
		+ (partner ? `. Shared with ${skillName(partner)}, as in the game` : '');
	return (
		<span class="v2-opt-hint" title={title}>
			<button type="button" class={`v2-hint-btn v2-hint-down${downOff ? ' disabled' : ''}`} disabled={downOff}
				aria-label={`Lower the hint level of ${name}`} onClick={() => step(-1)}>
				<div class="v2-hint-btn-bg"></div>
				<span class="v2-hint-btn-text">−</span>
			</button>
			<span class="v2-opt-skill-cost">{cost} SP</span>
			<button type="button" class={`v2-hint-btn v2-hint-up${upOff ? ' disabled' : ''}`} disabled={upOff}
				aria-label={`Raise the hint level of ${name}`} onClick={() => step(1)}>
				<div class="v2-hint-btn-bg"></div>
				<span class="v2-hint-btn-text">+</span>
			</button>
			<span class={`v2-opt-hint-level${hint > 0 ? '' : ' none'}`}>
				{hint > 0 ? `Lv${hint} −${hintDiscountPercent(hint)}%` : 'no hint'}
			</span>
		</span>
	);
}

// ── number formatting ───────────────────────────────────────────────────────

const fmtN = (x: number | undefined | null, d = 2): string =>
	x != null && Number.isFinite(x) ? x.toFixed(d).replace(/^-0\.(0+)$/, '0.$1') : '—';
const fmtPct = (x: number | undefined | null): string =>
	x != null && Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '—';

/** Mean ± 95% CI half-width from a MeanSem. ci95 takes the STANDARD DEVIATION,
 *  so it is rebuilt from the SEM (sd = sem·√n), the same math as search.ts pairedOf. */
const fmtMeanCi = (m: MeanSem | undefined, d = 2, scale = 1, unit = ''): string => {
	if (!m || !Number.isFinite(m.mean)) return '—';
	const sd = (Number.isFinite(m.sem) ? m.sem : 0) * Math.sqrt(Math.max(1, m.n));
	const [lo, hi] = ci95(m.mean, sd, m.n);
	const half = Number.isFinite(hi) ? (hi - lo) / 2 : NaN;
	return `${fmtN(m.mean * scale, d)} ± ${fmtN(half * scale, d)}${unit}`;
};

/** 75 s → "1 min 15 s", 3,700 s → "1 h 1 min". */
function fmtDuration(ms: number): string {
	const sec = Math.max(0, Math.round(ms / 1000));
	if (sec < 60) return `${sec} s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min} min ${sec % 60} s`;
	return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** A time estimate, rounded to what it can promise: 5 s steps under a minute,
 *  10 s steps under 10 minutes, whole minutes after that. */
function fmtEstimate(ms: number): string {
	const sec = Math.max(0, ms / 1000);
	if (sec < 60) return `${Math.max(5, Math.round(sec / 5) * 5)} s`;
	if (sec < 600) {
		const s = Math.round(sec / 10) * 10;
		return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
	}
	const min = Math.round(sec / 60);
	return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`;
}

// ── goal, effort and stage vocabulary ───────────────────────────────────────

interface GoalInfo { id: ObjectiveKind; label: string; short: string; rate: boolean; unit: string }
const GOALS: GoalInfo[] = [
	{ id: 'p1', label: 'Win rate', short: 'Win rate', rate: true, unit: '' },
	{ id: 'pTop3', label: 'Top-3 rate', short: 'Top-3 rate', rate: true, unit: '' },
	{ id: 'meanLead', label: 'Margin vs winner', short: 'Margin', rate: false, unit: ' L' },
	{ id: 'meanPlacing', label: 'Average placing', short: 'Avg placing', rate: false, unit: '' },
	{ id: 'gainVsCurrent', label: 'Gain over current', short: 'Gain', rate: false, unit: ' L' },
];
const goalOf = (o: ObjectiveKind): GoalInfo => GOALS.find((g) => g.id === o) ?? GOALS[0];
/** A goal's value as shown: rates as percentages, the rest in their own unit. */
const fmtGoal = (m: MeanSem | undefined, o: ObjectiveKind): string => {
	const g = goalOf(o);
	return g.rate ? fmtMeanCi(m, 1, 100, '%') : fmtMeanCi(m, 2, 1, g.unit);
};

const PRESETS: { value: EffortPreset; label: string }[] = [
	{ value: 'quick', label: 'Quick' },
	{ value: 'standard', label: 'Standard' },
	{ value: 'thorough', label: 'Thorough' },
	{ value: 'custom', label: 'Custom' },
	{ value: 'untilStopped', label: 'Until stopped' },
];
function effortHint(preset: EffortPreset, starts: number, minutes: number): string {
	switch (preset) {
		case 'quick': return 'About 1 minute of searching, 1 starting build.';
		case 'standard': return 'About 5 minutes of searching, 3 starting builds.';
		case 'thorough': return 'About 20 minutes of searching, 5 starting builds.';
		case 'custom': return minutes > 0
			? `About ${minutes} minutes of searching, ${starts} starting builds.`
			: `${starts} starting builds, no time limit.`;
		case 'untilStopped': return 'Keeps searching until you press STOP.';
	}
}

const STAGE_LABEL: Record<OptimizerProgress['stage'], string> = {
	noise: 'Measuring race noise',
	screen: 'Testing each skill alone',
	knapsack: 'Picking starting builds',
	incontext: 'Testing skills inside builds',
	local: 'Improving builds',
	verify: 'Checking the best builds on new races',
	done: 'Done',
	stopped: 'Stopped',
};
/** The order the pipeline runs its stages in, for the "step k of n" label. */
const STAGE_ORDER: OptimizerProgress['stage'][] = ['noise', 'screen', 'knapsack', 'incontext', 'local', 'verify'];

/** The engine's progress notes in the pane's words. */
const plainNote = (note?: string): string | undefined => note
	?.replace(/\brestart (\d+)\/(\d+)/g, 'start $1 of $2')
	.replace(/\brestart (\d+)\b/g, 'start $1')
	.replace(/(\d+) restart points/, '$1 starting builds')
	.replace(/ILS kick (\d+)\/(\d+)/g, 'shake-up $1 of $2')
	.replace(/ILS kick/g, 'shake-up')
	.replace(/ N2\b/g, ' two-skill swaps')
	.replace(/\bclimb\b/g, 'improving')
	.replace(/(\d+)\/(\d+) moves screened/, '$1 of $2 changes tested')
	.replace(/verifying (\d+)\/(\d+) seeds/, 'checking on $1 of up to $2 races');

// ── result cells ────────────────────────────────────────────────────────────

/** 95% half-width of one skill's worth × √races, from a real end-of-career
 *  run (200 races gave about ±0.25 L), so the hint can say how tight a count is. */
const WORTH_SPREAD_L = 3.5;

/** An activation rate under this share of the races run gets flagged. */
const LOW_ACTIVATION = 0.05;

/** One skill's activation share in the races already run for its build (fired
 *  per race, the skill chart's rule). Zero reads "never", under 5% is flagged. */
function activationCell(id: string, act: ActivationTelemetry | undefined) {
	if (!act || act.seeds <= 0) {
		return <span class="v2-opt-muted" title="The engine reported no activation counts for these races">—</span>;
	}
	const fired = act.fired[id] ?? 0;
	const races = act.seeds.toLocaleString();
	if (fired === 0) return <span class="v2-opt-warn" title={`Never activated in ${races} races`}>never</span>;
	const rate = fired / act.seeds;
	return rate < LOW_ACTIVATION
		? <span class="v2-opt-warn" title={`Fired in only ${fmtPct(rate)} of ${races} races, under 5%`}>{fmtPct(rate)}</span>
		: <span title={`Fired in ${fmtPct(rate)} of ${races} races`}>{fmtPct(rate)}</span>;
}

/** One skill's worth as a bar on a shared scale: the bar is the mean, the thin
 *  line the 95% interval, and the vertical line zero. An interval over zero is
 *  drawn faint: the run cannot tell that skill from no effect. */
function WorthBar(props: { d: ContributionDiff | null; lo: number; hi: number }) {
	const { d, lo, hi } = props;
	if (!d) return <span class="v2-opt-muted" title="This drop was never raced, so the run holds no number for it">not measured</span>;
	const span = hi - lo || 1;
	const pos = (x: number) => `${(((Math.min(hi, Math.max(lo, x)) - lo) / span) * 100).toFixed(2)}%`;
	const zero = pos(0);
	const resolved = resolvedDiff(d.ci95);
	const left = d.mean >= 0 ? zero : pos(d.mean);
	const width = `${((Math.abs(d.mean) / span) * 100).toFixed(2)}%`;
	return (
		<div class={`v2-opt-worth-cell${resolved ? '' : ' unresolved'}`}
			title={`${d.seeds.toLocaleString()} shared races${resolved ? '' : ': the 95% interval holds 0, so this is indistinguishable from no effect'}`}>
			<div class="v2-opt-bar">
				<span class="v2-opt-bar-ci" style={{ left: pos(d.ci95[0]), width: `${((Math.min(hi, d.ci95[1]) - Math.max(lo, d.ci95[0])) / span * 100).toFixed(2)}%` }} />
				<span class={`v2-opt-bar-fill${d.mean < 0 ? ' neg' : ''}`} style={{ left, width }} />
				<span class="v2-opt-bar-zero" style={{ left: zero }} />
			</div>
			<span class="v2-opt-worth-text">
				{fmtN(d.mean)} ± {fmtN(ciHalfWidth(d.ci95))} L{resolved ? '' : ' ≈0'}
			</span>
		</div>
	);
}

/** A finished run plus what shaped it. Stored as ONE value so the finished
 *  results can never be relabelled by later changes to the live controls. */
interface RunSnapshot {
	result: OptimizerResult;
	objective: ObjectiveKind;
	/** Skills that stayed out of that run's pool. */
	leftOut: number;
	/** SP held back from that run's budget. */
	reserve: number;
	/** Must-have skills of that run (in every build, outside `selection`). */
	mustHave: string[];
	/** Hint levels the run priced skills with, so later hint changes cannot
	 *  re-price the finished results. */
	hints: Map<string, number>;
}

/** Advanced settings: null keeps the preset's value. */
interface AdvancedSettings {
	deltaMinL: number | null;
	verifySeeds: number | null;
	kicksPerStart: number | null;
	kickGrowAfter: number | null;
	spreadMinDiff: number | null;
	spreadNoise: number | null;
}
const NO_ADVANCED: AdvancedSettings = {
	deltaMinL: null, verifySeeds: null, kicksPerStart: null, kickGrowAfter: null, spreadMinDiff: null, spreadNoise: null,
};

type PoolState = 'off' | 'allow' | 'must';
const POOL_OPTIONS = (disabled: boolean) => [
	{ value: 'off' as PoolState, label: 'Off', title: 'Never buy this skill', disabled },
	{ value: 'allow' as PoolState, label: 'Allow', title: 'The search may buy this skill', disabled },
	{ value: 'must' as PoolState, label: 'Must', title: 'Buy this skill in every build', disabled },
];

export function OptimizerPane(props: OptimizerPaneProps) {
	const { workerFactory, uma, skillData, course, courseId, conditions, mobPreset, fixedGate, ownedByGroup, hints, excluded } = props;

	// ── UI state ──────────────────────────────────────────────────────────────
	/** Allowed skills. A must-have skill lives in `mustHave` instead. */
	const [chosen, setChosen] = useState<Set<string>>(() => new Set(props.candidates));
	const [mustHave, setMustHave] = useState<Set<string>>(() => new Set());
	const [filter, setFilter] = useState('');
	const [budget, setBudget] = useState(10000);
	const [reserve, setReserve] = useState(0);
	const [objective, setObjective] = useState<ObjectiveKind>('p1');
	const [preset, setPreset] = useState<EffortPreset>('standard');
	/** Custom effort: starting builds and a time limit in minutes (0 = none). */
	const [customStarts, setCustomStarts] = useState(DEFAULT_CUSTOM.starts);
	const [customMinutes, setCustomMinutes] = useState(DEFAULT_CUSTOM.minutes);
	const [buildsShown, setBuildsShown] = useState(5);
	const [worthRaces, setWorthRaces] = useState(500);
	const [advanced, setAdvanced] = useState<AdvancedSettings>(NO_ADVANCED);
	const [seed, setSeed] = useState(props.seed);
	const [useBook, setUseBook] = useState(true);
	/** Wider search: spread-out starting builds and kicks that grow. */
	const [wideSearch, setWideSearch] = useState(false);
	const [running, setRunningState] = useState(false);
	const onRunningChange = props.onRunningChange;
	const setRunning = (v: boolean) => {
		setRunningState(v);
		onRunningChange?.(v);
	};
	const [progress, setProgress] = useState<LiveProgress | null>(null);
	const [runResult, setRunResult] = useState<RunSnapshot | null>(null);
	const [warnings, setWarnings] = useState<string[]>([]);
	const [message, setMessage] = useState<string | null>(null); // errors and hints share one line
	/** Exclusion list: the master switch and the ids put back by hand. */
	const [focusOn, setFocusOn] = useState(true);
	const [included, setIncluded] = useState<Set<string>>(() => new Set());
	/** Bumped when the opening book changes, so its count re-reads. */
	const [bookTick, setBookTick] = useState(0);

	/** How an imported career narrows the pool: its offer list, which only a Hachimi
	 *  dump carries, and the skills that career cannot learn. */
	const [poolFilter, setPoolFilter] = useState<Set<string> | null>(null);
	const [poolBlock, setPoolBlock] = useState<Set<string>>(() => new Set());

	/** The caller's candidates plus whatever the user took back from the exclusions. */
	const withBack = useMemo(
		() => applyExclusions(props.candidates, excluded, focusOn, included),
		[props.candidates, excluded, focusOn, included],
	);
	/** The pool this pane offers. The career rule is applied here, not to the
	 *  selection, so a skill that career cannot buy cannot come back through
	 *  "Allow all" or a later re-derivation of the candidate list. */
	const candidates = useMemo(
		() => withBack.filter((id) => (!poolFilter || poolFilter.has(id)) && !poolBlock.has(id)),
		[withBack, poolFilter, poolBlock],
	);
	const leftOut = excluded.length - (withBack.length - props.candidates.length);

	// ── run machinery ─────────────────────────────────────────────────────────
	const evRef = useRef<Evaluator | null>(null);
	const ctrlRef = useRef<SearchController | null>(null);
	const runningRef = useRef(false);
	const lastUiRef = useRef(0); // progress-throttle timestamp
	const heldUiRef = useRef<OptimizerProgress | null>(null); // newest event the throttle held back
	const flushUiRef = useRef<number | null>(null); // timer that shows it when the gap ends
	// False once unmounted. app-v2 renders this pane only on the Optimizer tab, so
	// switching tabs unmounts it while a run is still in flight. Every post-await
	// setState below is gated on this so nothing touches a dead component.
	const mountedRef = useRef(true);

	// The pane is conditionally mounted, so this cleanup can fire MID-RUN. Mark
	// unmounted, then hard-stop the in-flight work:
	//  - dispose() only RESOLVES the running pool batch, which does NOT stop the
	//    search, so the orphaned runOptimizer would keep going.
	//  - ctrl.stop() winds the pipeline down, abort() REJECTS the running batch so
	//    the current ensure() throws and the run unwinds immediately.
	// The pool THIS run created is released in run()'s finally, on the local ev.
	useEffect(() => () => {
		mountedRef.current = false;
		props.onRunningChange?.(false);
		if (props.controlRef) props.controlRef.current = null;
		ctrlRef.current?.stop();
		evRef.current?.abort();
		evRef.current = null;
	}, []);

	// candidates arrives async (the skill table loads after mount): the first
	// non-empty list defaults to all allowed. A skill newly in the pool (put
	// back, or freed by a focus change) joins as allowed, and one leaving drops
	// out of both sets.
	const seededRef = useRef(false);
	const pooledRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		// The app passes an empty list for a moment while it re-derives the pool
		// (a layout change does it). Remembering that empty list would make every
		// skill "new" on the next one and allow them all again, wiping the
		// user's choices, so an empty list is skipped.
		if (!candidates.length) return;
		const before = pooledRef.current;
		const now = new Set(candidates);
		pooledRef.current = now;
		if (!seededRef.current) {
			seededRef.current = true;
			setChosen(new Set(candidates));
			return;
		}
		setChosen((prev) => {
			const next = new Set([...prev].filter((id) => now.has(id)));
			for (const id of candidates) if (!before.has(id) && !mustHave.has(id)) next.add(id);
			return next.size === prev.size && [...next].every((id) => prev.has(id)) ? prev : next;
		});
		setMustHave((prev) => {
			const next = new Set([...prev].filter((id) => now.has(id)));
			return next.size === prev.size ? prev : next;
		});
	}, [candidates, excluded]);

	const stateOf = (id: string): PoolState => (mustHave.has(id) ? 'must' : chosen.has(id) ? 'allow' : 'off');
	const setState = (id: string, s: PoolState) => {
		setChosen((prev) => {
			const next = new Set(prev);
			if (s === 'allow') next.add(id); else next.delete(id);
			return next;
		});
		setMustHave((prev) => {
			const next = new Set(prev);
			if (s === 'must') next.add(id); else next.delete(id);
			return next;
		});
	};

	const filtered = useMemo(() => {
		const q = filter.trim().toLowerCase();
		if (!q) return candidates;
		return candidates.filter((id) => id.includes(q) || skillName(id).toLowerCase().includes(q));
	}, [candidates, filter]);

	/** The filtered pool, grouped by skill kind, cheapest first inside a group. */
	const grouped = useMemo(() => {
		const by = new Map<SkillKind, { id: string; cost: number }[]>();
		for (const id of filtered) {
			const k = kindOf(id);
			if (!by.has(k)) by.set(k, []);
			by.get(k)!.push({ id, cost: calculateSkillCost(id, hints, ownedByGroup) });
		}
		for (const list of by.values()) list.sort((a, b) => skillName(a.id).localeCompare(skillName(b.id)));
		return KIND_ORDER.filter((k) => by.has(k)).map((k) => ({ kind: k, skills: by.get(k)! }));
	}, [filtered, hints, ownedByGroup]);

	const costOfIds = (ids: Iterable<string>) => {
		let c = 0;
		for (const id of ids) c += calculateSkillCost(id, hints, ownedByGroup);
		return c;
	};
	const allowedCost = useMemo(() => costOfIds(chosen), [chosen, hints, ownedByGroup]);
	/** Pool skills with a hint level set. */
	const hintedInPool = useMemo(() => candidates.filter((id) => (hints.get(id) ?? 0) > 0).length, [candidates, hints]);
	const mustCost = useMemo(() => costOfIds(mustHave), [mustHave, hints, ownedByGroup]);
	const spendable = Math.max(0, (Number(budget) || 0) - (Number(reserve) || 0));

	const stop = () => ctrlRef.current?.stop();

	// ── opening book ──────────────────────────────────────────────────────────
	/** The book's key for the race as set up now (the run computes the same). */
	const bookKeyNow = (): string | null => course ? bookKey({
		courseId: String(courseId), distance: course.distance,
		strategy: String((uma as any)?.strategy ?? ''), mobPresetId: String((mobPreset as any)?.id ?? (mobPreset as any)?.name ?? 'default'),
		ground: conditions.ground,
	}) : null;
	const bk = bookKeyNow();
	const savedBuilds = useMemo(() => (bk ? bookCount(bk) : 0), [bk, bookTick]);

	// ── career import ─────────────────────────────────────────────────────────
	const [career, setCareer] = useState<CareerImport | null>(null);
	/** Of the skills the app would offer, how many that career cannot learn. */
	const blockedOut = useMemo(() => withBack.filter((id) => poolBlock.has(id)).length, [withBack, poolBlock]);

	const importCareer = async () => {
		if (runningRef.current) return;
		const imp = await pickCareerDump();
		if (!imp) return;
		props.onImportCareer?.(imp); // outfit, stats, aptitudes, learned skills, hint levels
		if (imp.budget != null) setBudget(imp.budget);
		setPoolFilter(imp.offered.length ? new Set(imp.offered) : null);
		setPoolBlock(new Set(imp.blocked));
		setCareer(imp);
	};

	/** The user's settings for applyTuning. Blank advanced fields keep the preset. */
	const tuningNow = (): SearchTuning => ({
		buildsShown, contribSeeds: worthRaces,
		deltaMinL: advanced.deltaMinL ?? undefined,
		verifySeeds: advanced.verifySeeds ?? undefined,
		kicksPerStart: advanced.kicksPerStart ?? undefined,
		kickGrowAfter: advanced.kickGrowAfter ?? undefined,
		spreadMinDiff: advanced.spreadMinDiff ?? undefined,
		spreadNoise: advanced.spreadNoise ?? undefined,
	});

	const run = async () => {
		if (runningRef.current || !skillData || !workerFactory) return;
		runningRef.current = true;
		setRunning(true);
		setMessage(null);
		setRunResult(null);
		setProgress(null);
		setWarnings([]);
		// A previous run's pool must not linger (dispose before each new run).
		evRef.current?.dispose();
		evRef.current = null;

		const reserveUse = Math.max(0, Math.floor(Number(reserve) || 0));
		const budgetUse = Math.max(0, Math.floor(Number(budget) || 0) - reserveUse);
		const runLeftOut = leftOut;
		const runMust = [...mustHave];
		const runHints = new Map(hints);
		const seedUse = Math.floor(Number(seed) || 0);
		// Must-have skills are locks: always in, their cost reserved once
		// (space.ts include), so they never appear in a build's `selection`.
		const space: BuildSpace = buildSpace({
			purchasable: [...chosen, ...runMust], include: runMust, ownedByGroup, fixedIds: [], hints, budget: budgetUse,
		});
		setWarnings(space.warnings);
		const fail = (msg: string) => {
			setMessage(msg);
			runningRef.current = false; setRunning(false);
		};
		if (space.error) return fail(space.error);
		if (space.forcedCost > budgetUse) {
			return fail(`The must-have skills cost ${space.forcedCost} SP, more than the ${budgetUse} SP left after the reserve.`);
		}
		if (space.options.length === 0 && !runMust.length) {
			return fail('No skill in the pool can be bought (already owned, purple, or outside the active table), so there is nothing to search.');
		}
		if (!course) return fail('Course data unavailable.');

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
		// Hoisted so the finally disposes THIS run's pool, not evRef.current: an
		// unmount nulls evRef.current, so disposing through the ref would strand
		// whatever pool the (possibly orphaned) run still ends up creating.
		let ev: Evaluator | null = null;
		try {
			const courseIds = await loadGlobalsimCourseIds();
			if (!courseIds) {
				throw new Error(
					`GlobalSim course table unavailable (/globalsim/courses.json). Run \`node umalator-global/build.mjs\` once to generate the GlobalSim assets.`,
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
				// The user's fixed gate (undefined = auto-paired per seed), the same
				// wiring the compare and chart runs use in app-v2.
				fixedGate,
			};
			// One scenario: the race the user set up.
			const scenarios: ScenarioSpec[] = [{ id: 'main', label: 'Current setup', conds, mobPreset }];
			ev = createEvaluator({
				workerFactory, space, baseHorse, scenarios, baseSeed: seedUse, skillData,
				// Every optimizer race runs paired: the search is a chain of paired
				// comparisons, and paired draws cut σΔ(ℓ) about 10×.
				paired: true,
			});
			evRef.current = ev;

			// Opening book: seed the search from prior strong builds for this race
			// (re-filtered to today's roster).
			const key = bookKeyNow()!;
			const bookStarts = useBook ? selectStarts(space, key) : [];

			// gainVsCurrent pairs every build against the user's ACTUAL build. That
			// build is the base build: learned skills ride on baseHorse and
			// must-have skills join fixedIds, so an empty selection is the
			// reference (a must-have id in `selection` would double-charge it).
			let current: BuildRefLite | undefined;
			if (objective === 'gainVsCurrent') {
				current = { id: simIdentity(space, []), selection: [] };
			}

			const res = await runOptimizer(
				ev,
				{
					space, scenarioIdx: 0, objective, aggregation: 'mean',
					bookStarts, current,
					effort: applyTuning(effortConfig(preset, { starts: customStarts, minutes: customMinutes }), tuningNow()),
					wideSearch, wideSearchSeed: seedUse,
				},
				ctrl,
				(p) => {
					// A mid-run unmount can still emit before the abort unwinds the run.
					if (!mountedRef.current) return;
					// Stage events fire often: cap state updates at about 10/s. The
					// newest event held back is shown when the gap ends, so a long
					// quiet stretch never leaves an older one on screen (the terminal
					// 'done' event always passes straight through).
					const show = (q: OptimizerProgress) => {
						lastUiRef.current = Date.now();
						setProgress({ ...q, receivedAt: lastUiRef.current });
					};
					const wait = 100 - (Date.now() - lastUiRef.current);
					if (p.stage === 'done' || wait <= 0) {
						if (flushUiRef.current != null) window.clearTimeout(flushUiRef.current);
						flushUiRef.current = null;
						show(p);
						return;
					}
					heldUiRef.current = p;
					if (flushUiRef.current == null) {
						flushUiRef.current = window.setTimeout(() => {
							flushUiRef.current = null;
							const q = heldUiRef.current;
							heldUiRef.current = null;
							if (q && mountedRef.current && runningRef.current) show(q);
						}, wait);
					}
				},
			);
			if (!mountedRef.current) return;
			console.log('[optimizer]', res);
			setRunResult({ result: res, objective, leftOut: runLeftOut, reserve: reserveUse, mustHave: runMust, hints: runHints });
			setProgress(null);
			if (useBook) {
				saveBook(key, res.shortlist.slice(0, 5).map(r => ({
					selection: [...r.build.selection], value: r.obj.mean, savedAt: Date.now(),
				})));
				setBookTick((t) => t + 1);
			}
		} catch (e) {
			// A mid-run unmount routes the abort rejection here: never setState
			// once the component is gone. The finally still releases the pool.
			if (mountedRef.current) setMessage(e instanceof Error ? e.message : String(e));
		} finally {
			// Engine job failures the search worked around: never silent.
			const jobErrors = ev?.jobErrorLog() ?? [];
			if (jobErrors.length && mountedRef.current) {
				setWarnings((prev) => [...prev, ...jobErrors.map(({ error, count }) =>
					`Engine job failed ${count}× (seeds retried, then dropped after 3 failures): ${error}`)]);
			}
			ev?.dispose();
			if (evRef.current === ev) evRef.current = null;
			if (flushUiRef.current != null) window.clearTimeout(flushUiRef.current);
			flushUiRef.current = null;
			heldUiRef.current = null;
			ctrlRef.current = null;
			runningRef.current = false;
			if (mountedRef.current) setRunning(false);
		}
	};
	// The app's RUN button reaches the latest run and stop through this ref.
	if (props.controlRef) props.controlRef.current = { run: () => { void run(); }, stop };

	// ── guards ────────────────────────────────────────────────────────────────
	if (!skillData || !workerFactory) {
		return (
			<div class="v2-optimizer">
				<div class="v2-opt-card v2-opt-empty">
					<div class="v2-results-placeholder">
						<Wand2 size={40} />
						<h2>Skill Optimizer</h2>
						<p>The GlobalSim engine is still loading. The optimizer needs the skill table and the engine workers.</p>
					</div>
				</div>
			</div>
		);
	}
	const exclusionList = (
		<PoolExclusionList
			excluded={excluded} included={included}
			onToggle={(id) => setIncluded((prev) => {
				const next = new Set(prev);
				if (next.has(id)) next.delete(id); else next.add(id);
				return next;
			})}
			focusOn={focusOn} onFocusChange={setFocusOn} disabled={running}
		/>
	);

	const cfgNow = effortConfig(preset, { starts: customStarts, minutes: customMinutes });
	const fieldName = mobPreset?.name ? (/field$/i.test(mobPreset.name) ? mobPreset.name : `${mobPreset.name} field`) : '9-runner field';
	const setAdv = (k: keyof AdvancedSettings) => (v: number | null) => setAdvanced((a) => ({ ...a, [k]: v }));
	const advancedChanged = Object.values(advanced).some((v) => v != null);
	const L = TUNING_LIMITS;

	return (
		<div class="v2-optimizer">
			{/* ── Setup ── */}
			<section class="v2-opt-card v2-opt-setup">
				<header class="v2-opt-card-header">
					<h2>Skill Optimizer</h2>
					<span class="v2-opt-subtitle">Finds the skills worth buying with your SP, raced against the {fieldName}.</span>
				</header>
				<div class="v2-opt-fields">
					<NumberInput label="SP budget" value={budget} min={0} step={50} suffix="SP" disabled={running}
						onChange={(v) => setBudget(v ?? 0)} />
					<NumberInput label="Keep in reserve" value={reserve} min={0} step={50} suffix="SP" disabled={running}
						helperText="Not spent by any build"
						onChange={(v) => setReserve(v ?? 0)} />
					<div class="v2-input-field">
						<label class="v2-input-label">Running style</label>
						<CustomSelect value={String(uma.strategy)} disabled={running}
							options={Object.entries(STRATEGY_LABELS).map(([v, l]) => ({ value: v, label: l as string }))}
							onChange={(v) => props.onStrategyChange?.(String(v))} />
					</div>
					<div class="v2-input-field">
						<label class="v2-input-label">Goal</label>
						<CustomSelect value={objective} disabled={running}
							options={GOALS.map((g) => ({ value: g.id, label: g.label }))}
							onChange={(v) => setObjective(v as ObjectiveKind)} />
					</div>
					<NumberInput label="Builds shown" value={buildsShown} min={L.buildsShown.min} max={L.buildsShown.max} step={1} disabled={running}
						helperText="Best builds checked and listed"
						onChange={(v) => setBuildsShown(v ?? 5)} />
					<NumberInput label="Races per skill worth" value={worthRaces} min={L.contribSeeds.min} max={L.contribSeeds.max} step={100} disabled={running}
						helperText={`Typically ±${fmtN(WORTH_SPREAD_L / Math.sqrt(Math.max(1, worthRaces)), 2)} L per skill`}
						onChange={(v) => setWorthRaces(v ?? 500)} />
				</div>

				<div class="v2-opt-effort">
					<div class="v2-input-field">
						<label class="v2-input-label">Effort</label>
						<SegmentedControl<EffortPreset> value={preset} size="sm" ariaLabel="Effort"
							options={PRESETS.map((p) => ({ ...p, disabled: running }))}
							onChange={setPreset} />
						<div class="v2-input-helper">{effortHint(preset, customStarts, customMinutes)} Checking the results comes after.</div>
					</div>
					{preset === 'custom' && (
						<Fragment>
							<NumberInput label="Starting builds" value={customStarts} min={1} max={CUSTOM_STARTS_MAX} step={1} disabled={running}
								onChange={(v) => setCustomStarts(v ?? 1)} />
							<NumberInput label="Time limit" value={customMinutes} min={0} step={5} suffix="min" disabled={running}
								helperText="0 means no limit"
								onChange={(v) => setCustomMinutes(v ?? 0)} />
						</Fragment>
					)}
				</div>

				<div class="v2-opt-switches">
					<Switch checked={wideSearch} disabled={running} onChange={setWideSearch}
						label={<span title="Starting builds are held further apart and half of them come from a shuffled knapsack, and a shake-up that keeps failing swaps more skills. Each start covers more ground, so give the run more time.">Wider search</span>} />
					<Switch checked={useBook} disabled={running} onChange={setUseBook}
						label={<span title="Start from the best builds earlier runs found for this race, and save this run's best builds for next time.">Use saved builds{savedBuilds ? ` (${savedBuilds})` : ''}</span>} />
				</div>

				<details class="v2-opt-advanced">
					<summary>Advanced settings{advancedChanged ? ' · changed' : ''}</summary>
					<div class="v2-opt-fields">
						<NumberInput label="Smallest gain" value={advanced.deltaMinL} allowEmpty precision={3}
							min={L.deltaMinL.min} max={L.deltaMinL.max} step={0.01} suffix="L" placeholder={String(cfgNow.deltaMinL)} disabled={running}
							helperText="Smaller gains are not chased. Lower finds more, but each takes more races to prove"
							onChange={setAdv('deltaMinL')} />
						<NumberInput label="Checking races" value={advanced.verifySeeds} allowEmpty
							min={L.verifySeeds.min} max={L.verifySeeds.max} step={500} placeholder={String(cfgNow.gSeedsMin)} disabled={running}
							helperText="Per build. Grows up to 4× while the top two stay tied"
							onChange={setAdv('verifySeeds')} />
						<NumberInput label="Shake-ups per start" value={advanced.kicksPerStart} allowEmpty
							min={L.kicksPerStart.min} max={L.kicksPerStart.max} step={1}
							placeholder={String(Number.isFinite(cfgNow.kicks) ? cfgNow.kicks : KICKS_PER_VISIT)} disabled={running}
							helperText="Random swaps that try to escape a peak"
							onChange={setAdv('kicksPerStart')} />
						<NumberInput label="Grow shake-ups after" value={advanced.kickGrowAfter} allowEmpty
							min={L.kickGrowAfter.min} max={L.kickGrowAfter.max} step={1} suffix="fails" placeholder={String(KICK_GROW_AFTER)}
							disabled={running || !wideSearch} helperText="Wider search only"
							onChange={setAdv('kickGrowAfter')} />
						<NumberInput label="Start spread" value={advanced.spreadMinDiff} allowEmpty
							min={L.spreadMinDiff.min} max={L.spreadMinDiff.max} step={1} suffix="skills" placeholder={String(SPREAD_MIN_DIFF_PICKS)}
							disabled={running || !wideSearch} helperText="Wider search only: how different starts must be"
							onChange={setAdv('spreadMinDiff')} />
						<NumberInput label="Shuffle strength" value={advanced.spreadNoise} allowEmpty precision={2}
							min={L.spreadNoise.min} max={L.spreadNoise.max} step={0.25} placeholder={String(SPREAD_NOISE)}
							disabled={running || !wideSearch} helperText="Wider search only: noise on shuffled starts"
							onChange={setAdv('spreadNoise')} />
						<NumberInput label="Seed" value={seed} step={1} disabled={running} className="v2-opt-seed"
							helperText={Number.isFinite(cfgNow.timeBudgetMs)
								// The search shares its time limit out by the clock, so a
								// timed run moves with machine speed and load.
								? 'Repeats a run only without a time limit'
								: 'The same seed and settings repeat a run'}
							suffix={
								<button type="button" class="v2-opt-seed-dice" disabled={running} title="New random seed" aria-label="New random seed"
									onClick={() => setSeed(Math.floor(Math.random() * 0xffffffff))}>
									<Dice5 size={16} />
								</button>
							}
							onChange={(v) => setSeed(v ?? 0)} />
						<div class="v2-input-field">
							<label class="v2-input-label">Saved builds</label>
							<div class="v2-opt-inline v2-opt-input-row">
								<span class="v2-opt-muted">{savedBuilds} saved</span>
								<Button size="sm" variant="ghost" disabled={running || !savedBuilds || !bk} icon={<Trash2 size={14} />}
									onClick={() => { if (bk) { clearBook(bk); setBookTick((t) => t + 1); } }}>Forget</Button>
							</div>
							<div class="v2-input-helper">For this race. Used when "Use saved builds" is on</div>
						</div>
					</div>
					{advancedChanged && (
						<Button size="sm" variant="ghost" icon={<RotateCcw size={14} />} disabled={running}
							onClick={() => setAdvanced(NO_ADVANCED)}>Back to the preset's values</Button>
					)}
				</details>
			</section>

			{/* ── Skill pool ── */}
			<section class="v2-opt-card v2-opt-pool">
				<header class="v2-opt-card-header">
					<h3>Skill pool</h3>
					<span class="v2-opt-subtitle">
						{chosen.size} allowed · {mustHave.size} must have{hintedInPool ? ` · ${hintedInPool} hinted` : ''} · {allowedCost.toLocaleString()} SP to buy every allowed skill
						{mustHave.size ? ` · must-haves cost ${mustCost.toLocaleString()} SP` : ''} · {spendable.toLocaleString()} SP to spend
					</span>
				</header>
				{mustCost > spendable && (
					<div class="v2-opt-notice warn">The must-have skills cost more than the SP left after the reserve.</div>
				)}
				<div class="v2-opt-toolbar">
					<Input value={filter} placeholder="Filter skills…" iconLeft={<Search size={14} />} disabled={running}
						className="v2-opt-filter" onInput={setFilter} />
					<Button size="sm" variant="secondary" icon={<Upload size={14} />} disabled={running} onClick={importCareer}
						title="Load a Hachimi career dump or a umadump career snapshot: sets the uma from that career (outfit, stats, aptitudes, mood, learned skills) and takes its SP budget and hint levels. A Hachimi dump also limits the pool to what that career was offering, while a snapshot removes only the skills it cannot learn">
						Import career
					</Button>
					<Button size="sm" variant="ghost" disabled={running}
						onClick={() => setChosen((prev) => new Set([...prev, ...filtered.filter((id) => !mustHave.has(id))]))}>Allow all</Button>
					<Button size="sm" variant="ghost" disabled={running}
						onClick={() => {
							const shown = new Set(filtered);
							setChosen((prev) => new Set([...prev].filter((id) => !shown.has(id))));
							setMustHave((prev) => new Set([...prev].filter((id) => !shown.has(id))));
						}}>None</Button>
					{props.onResetHints && hintedInPool > 0 && (
						<Button size="sm" variant="ghost" disabled={running} title="Set every hint level back to none (also clears the Skill tab's hints)"
							onClick={props.onResetHints}>Clear hints</Button>
					)}
				</div>
				{career && (
					<div class="v2-opt-career">
						<span>{career.summary}</span>
						{poolFilter && <span class="v2-opt-muted"> · pool limited to what that career was offering</span>}
						{blockedOut > 0 && <span class="v2-opt-muted"> · {blockedOut} skill(s) that career cannot learn are out of the pool</span>}
						{career.warnings.length > 0 && (
							<details class="v2-opt-inline-details">
								<summary>{career.warnings.length} import note{career.warnings.length > 1 ? 's' : ''}</summary>
								<ul>{career.warnings.map((w) => <li>{w}</li>)}</ul>
							</details>
						)}
					</div>
				)}
				{candidates.length === 0 ? (
					<div class="v2-opt-muted">No candidate skills for this uma and course, so there is nothing to optimize.</div>
				) : (
					<div class="v2-opt-pool-list">
						{grouped.map(({ kind, skills }) => (
							<div class="v2-opt-pool-group" key={kind}>
								<div class="v2-opt-pool-group-title">{KIND_LABEL[kind]} · {skills.length}</div>
								{skills.map(({ id, cost }) => {
									const st = stateOf(id);
									return (
										<div class={`v2-opt-skill ${st}`} key={id}>
											<img src={skillIcon(id)} alt="" loading="lazy" />
											<span class="v2-opt-skill-name" title={id}>{skillName(id)}</span>
											<HintCost id={id} cost={cost} hint={hints.get(id) ?? 0} disabled={running}
												onChange={props.onHintChange && ((lv) => props.onHintChange!(id, lv))} />
											<SegmentedControl<PoolState> value={st} size="sm" ariaLabel={`${skillName(id)}: off, allow or must have`}
												options={POOL_OPTIONS(running)} onChange={(s) => setState(id, s)} />
										</div>
									);
								})}
							</div>
						))}
					</div>
				)}
				{exclusionList}
				{warnings.length > 0 && (
					<details class="v2-opt-inline-details">
						<summary>{warnings.length} warning{warnings.length > 1 ? 's' : ''}</summary>
						<ul>{warnings.map((wmsg) => <li>{wmsg}</li>)}</ul>
					</details>
				)}
			</section>

			{message && <div class="v2-opt-notice error" role="alert">{message}</div>}

			{/* ── Live progress ── */}
			{running && (
				<section class="v2-opt-card v2-opt-progress">
					{progress ? <ProgressView progress={progress} objective={objective} untilStopped={preset === 'untilStopped'}
						limitMs={cfgNow.timeBudgetMs} />
						: <div class="v2-opt-muted">Starting the engine…</div>}
					<div class="v2-opt-muted">Press STOP at the top to end the run early and check what it has found.</div>
				</section>
			)}

			{/* ── Results (from the frozen snapshot, never live state) ── */}
			{runResult ? (
				<OptimizerResults snapshot={runResult} hints={runResult.hints} ownedByGroup={ownedByGroup} onOpenInCompare={props.onOpenInCompare} />
			) : !running && (
				<section class="v2-opt-card v2-opt-empty">
					<div class="v2-results-placeholder">
						<Wand2 size={40} />
						<p>Set the SP and the skill pool, then press RUN at the top.</p>
					</div>
				</section>
			)}
		</div>
	);
}

/** A progress event and when the pane received it, so the clock can tick on
 *  between events. */
type LiveProgress = OptimizerProgress & { receivedAt: number };

/** Live progress: the stage, a bar of time spent against the estimated total,
 *  timing and the provisional best build. The clock and the time left tick
 *  every second between events. Until stopped has no end, so its bar only
 *  names the stage. The search moves back and forth between the testing and
 *  improving stages for every starting build, so the step shows where it is
 *  now, not how much is done. */
function ProgressView(props: { progress: LiveProgress; objective: ObjectiveKind; untilStopped: boolean; limitMs: number }) {
	const { progress, objective, untilStopped, limitMs } = props;
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, []);
	const since = Math.max(0, now - progress.receivedAt);
	const elapsed = progress.elapsedMs + since;
	const left = progress.etaMs != null ? Math.max(0, progress.etaMs - since) : null;
	const step = STAGE_ORDER.indexOf(progress.stage);
	const done = progress.stage === 'done';
	const frac = done ? 1 : left != null ? Math.min(0.99, elapsed / Math.max(1, elapsed + left)) : null;
	const note = plainNote(progress.note);
	return (
		<Fragment>
			<div class="v2-opt-progress-head">
				<strong>{STAGE_LABEL[progress.stage]}</strong>
				<span class="v2-opt-muted">
					{step >= 0 ? `step ${step + 1} of ${STAGE_ORDER.length} · ` : ''}
					{progress.racesRun.toLocaleString()} races · {fmtDuration(elapsed)}
					{left != null ? ` of about ${fmtEstimate(elapsed + left)} · ${left < 5000 ? 'finishing' : `about ${fmtEstimate(left)} left`}` : ''}
				</span>
			</div>
			<div class={`v2-opt-progressbar${frac == null ? ' indeterminate' : ''}`} role="progressbar"
				aria-valuemin={0} aria-valuemax={100} aria-valuenow={frac == null ? undefined : Math.round(frac * 100)}>
				<span style={{ width: frac == null ? '100%' : `${(frac * 100).toFixed(1)}%` }} />
			</div>
			{(note || (frac == null && untilStopped)) && (
				<div class="v2-opt-muted">{note}{frac == null && untilStopped ? `${note ? ' · ' : ''}runs until you press STOP` : ''}</div>
			)}
			{progress.etaCapped && Number.isFinite(limitMs) && (
				<div class="v2-opt-muted">
					The search will likely run into its {fmtEstimate(limitMs)} time limit, then check the best builds.
					A longer limit would let it try more.
				</div>
			)}
			{progress.best && (
				<div class="v2-opt-provisional">
					<span class="v2-opt-muted">Best so far: {fmtGoal(progress.best.obj, objective)} · {progress.best.sp} SP (not yet checked)</span>
					<div class="v2-opt-chips">
						{progress.best.build.selection.length
							? progress.best.build.selection.map((id) => <SkillChip id={id} key={id} />)
							: <span class="v2-opt-muted">no skills added</span>}
					</div>
				</div>
			)}
		</Fragment>
	);
}

function OptimizerResults(props: {
	snapshot: RunSnapshot; hints: Map<string, number>; ownedByGroup: Map<string, string>; onOpenInCompare?: (ids: string[]) => void;
}) {
	const { snapshot, hints, ownedByGroup, onOpenInCompare } = props;
	const { result, objective, leftOut, reserve, mustHave } = snapshot;
	const goal = goalOf(objective);
	const refId = result.reference?.build.id;
	const builds = result.shortlist.filter((r) => r.build.id !== refId);
	const [sel, setSel] = useState(0);
	const selected = builds[Math.min(sel, builds.length - 1)] ?? builds[0];
	const best = builds[0];
	const bestSet = new Set(best?.build.selection ?? []);

	// Win rate and top-3 rate can only rank builds that sometimes win or place.
	// An end-of-career uma with nothing bought often does neither against a
	// full field, and then every build ties at 0.
	const allZero = goal.rate && builds.length > 0 && builds.every((r) => r.obj.mean === 0);
	const bestLead = Math.max(...builds.map((r) => r.stats?.lead.mean ?? -Infinity));

	return (
		<section class="v2-opt-card v2-opt-results">
			<header class="v2-opt-card-header">
				<h3>Results</h3>
				<span class="v2-opt-subtitle">
					Ranked by {(result.rankedByLead ? goalOf('meanLead') : goal).label.toLowerCase()}, checked on {result.verificationSeeds.toLocaleString()} new races per build.
					Click a build to see what each skill is worth.
				</span>
			</header>
			{allZero && (
				<div class="v2-opt-notice warn" role="status">
					<strong>No build {objective === 'p1' ? 'won' : 'placed in the top 3 in'} a single race against this field.</strong>{' '}
					{Number.isFinite(bestLead) ? `The best one still finished ${fmtN(Math.abs(bestLead), 1)} lengths behind the winner. ` : ''}
					That is normal at the end of a career with nothing bought yet, but it means the {goal.short.toLowerCase()} cannot tell
					these builds apart.{' '}
					{result.rankedByLead
						? <>So they are ordered by how much ground they gain instead, as <strong>Margin vs winner</strong> would rank them.</>
						: <>So they are a tie, not a ranking. Set the goal to <strong>Margin vs winner</strong> to rank builds by how much ground they gain.</>}
				</div>
			)}
			{result.stoppedEarly && (
				<div class="v2-opt-notice warn">Stopped early: the builds were only checked on a short run of new races.</div>
			)}
			{mustHave.length > 0 && (
				<div class="v2-opt-must">
					<span class="v2-opt-muted">In every build (must have):</span>
					<div class="v2-opt-chips">{mustHave.map((id) => <SkillChip id={id} tone="must" key={id} />)}</div>
				</div>
			)}

			<div class="v2-opt-builds">
				{builds.map((row, i) => {
					const isSel = row === selected;
					const missing = i > 0 ? [...bestSet].filter((id) => !row.build.selection.includes(id)) : [];
					const pick = () => setSel(i);
					return (
						<div class={`v2-opt-build${isSel ? ' selected' : ''}`} key={row.build.id} role="button" tabIndex={0}
							aria-pressed={isSel} onClick={pick}
							onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } }}>
							<div class="v2-opt-build-head">
								<span class="v2-opt-build-rank">#{i + 1}</span>
								{i === 0 && <Badge variant="primary" size="sm">Recommended</Badge>}
								{i > 0 && row.tiedWithBest && (
									<Badge variant="neutral" size="sm" outline title="The 95% interval of its difference from #1 holds 0, so the two cannot be told apart">
										Tie with #1
									</Badge>
								)}
								<span class="v2-opt-build-score" title={`${goal.label}, mean ± 95% interval`}>{fmtGoal(row.obj, objective)}</span>
							</div>
							<div class="v2-opt-build-stats">
								<span>Win {fmtPct(row.stats?.win.mean)}</span>
								<span>Top-3 {fmtPct(row.stats?.top3.mean)}</span>
								<span>Margin {fmtN(row.stats?.lead.mean)} L</span>
								<span>{row.sp.toLocaleString()} SP · {row.leftover.toLocaleString()} spare{reserve ? ` + ${reserve.toLocaleString()} reserved` : ''}</span>
								<span>{row.build.selection.length} skill{row.build.selection.length === 1 ? '' : 's'}</span>
							</div>
							<div class="v2-opt-chips">
								{row.build.selection.length
									? row.build.selection.map((id) => <SkillChip id={id} key={id} tone={i > 0 && !bestSet.has(id) ? 'added' : undefined} />)
									: <span class="v2-opt-muted">no skills added</span>}
							</div>
							{missing.length > 0 && (
								<div class="v2-opt-missing">
									<span class="v2-opt-muted">Not in this build, but in #1:</span>
									<div class="v2-opt-chips">{missing.map((id) => <SkillChip id={id} key={id} tone="missing" />)}</div>
								</div>
							)}
						</div>
					);
				})}
			</div>

			{result.reference && (
				<div class="v2-opt-reference">
					<span class="v2-opt-muted">Your current build{mustHave.length ? ' (with the must-have skills)' : ''}:</span>{' '}
					margin {fmtN(result.reference.stats?.lead.mean)} L · win {fmtPct(result.reference.stats?.win.mean)} · top-3 {fmtPct(result.reference.stats?.top3.mean)}
				</div>
			)}

			{selected && (
				<BuildBreakdown row={selected} rank={builds.indexOf(selected) + 1} mustHave={mustHave}
					hints={hints} ownedByGroup={ownedByGroup} onOpenInCompare={onOpenInCompare} />
			)}

			<div class="v2-opt-footnote">
				{result.verificationSeeds.toLocaleString()} checking races per build · race noise σΔ {fmtN(result.noise.sigmaDeltaLead)} L
				{leftOut > 0 ? ` · ${leftOut} skill${leftOut === 1 ? '' : 's'} left the pool before the search` : ''}
			</div>
		</section>
	);
}

/** What each skill of one build is worth: the build against the same build
 *  without that skill, on shared races, sorted from most to least. */
function BuildBreakdown(props: {
	row: ScoredBuild; rank: number; mustHave: string[];
	hints: Map<string, number>; ownedByGroup: Map<string, string>; onOpenInCompare?: (ids: string[]) => void;
}) {
	const { row, rank, mustHave, hints, ownedByGroup, onOpenInCompare } = props;
	const contribs = new Map((row.contributions ?? []).map((c) => [c.id, c]));
	const items = row.build.selection.map((id) => {
		const cost = calculateSkillCost(id, hints, ownedByGroup);
		const d = contribs.get(id)?.lead ?? null;
		return { id, cost, d, win: contribs.get(id)?.win ?? null };
	}).sort((a, b) => (b.d?.mean ?? -Infinity) - (a.d?.mean ?? -Infinity));
	const ends = items.flatMap((x) => (x.d ? [x.d.ci95[0], x.d.ci95[1]] : [])).filter(Number.isFinite);
	const lo = Math.min(0, ...ends);
	const hi = Math.max(0, ...ends, 0.1);
	if (!row.build.selection.length) {
		return <div class="v2-opt-breakdown v2-opt-muted">Build #{rank} adds no skills, so there is nothing to break down.</div>;
	}
	return (
		<div class="v2-opt-breakdown">
			<div class="v2-opt-breakdown-head">
				<h4>Build #{rank} · {row.build.selection.length} skill{row.build.selection.length === 1 ? '' : 's'} · {row.sp.toLocaleString()} SP</h4>
				{onOpenInCompare && (
					<Button size="sm" variant="secondary" title="Load this build onto a copy of your current uma as Uma 2, to compare against it"
						onClick={() => onOpenInCompare([...mustHave, ...row.build.selection])}>
						Open in Compare
					</Button>
				)}
			</div>
			<div class="v2-opt-table-wrap">
				<table class="v2-opt-worth">
					<thead>
						<tr>
							<th>Skill</th>
							<th class="num">SP</th>
							<th class="num" title="Share of this build's races in which the skill activated. Under 5% is flagged.">Fires</th>
							<th title="How much ground the build loses without this skill, in lengths. The bar is the average, the thin line the 95% interval. A faint bar crosses zero, so the run cannot tell it from no effect.">Worth if dropped</th>
							<th class="num" title="Worth per 100 SP spent on the skill">Per 100 SP</th>
						</tr>
					</thead>
					<tbody>
						{items.map(({ id, cost, d, win }) => (
							<tr key={id} title={win ? `Win rate without it: ${fmtN(-win.mean * 100, 1)} ± ${fmtN(ciHalfWidth(win.ci95) * 100, 1)} points` : undefined}>
								<td>
									<div class="v2-opt-skill-cell">
										<img src={skillIcon(id)} alt="" loading="lazy" />
										<span>{skillName(id)}</span>
										{activationCountSkill(id) && <span class="v2-opt-muted" title="It only fires after other skills have, so its rate is measured from races, not predicted">*</span>}
									</div>
								</td>
								<td class="num">{cost}</td>
								<td class="num">{activationCell(id, row.activations)}</td>
								<td><WorthBar d={d} lo={lo} hi={hi} /></td>
								<td class="num">{d && cost > 0 ? `${fmtN((d.mean / cost) * 100)} L` : '—'}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<div class="v2-opt-footnote">
				Worth is measured on the same races with and without the skill. Skills overlap, so the worths do not add up to the build's total.
				{row.build.selection.some(activationCountSkill) ? ' * fires only after other skills have, so its rate comes from races.' : ''}
			</div>
		</div>
	);
}
