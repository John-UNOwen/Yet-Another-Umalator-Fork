/**
 * Yet Another Umalator v2 - Modern Uma Musume Race Simulator
 *
 * Copyright (c) 2026 TheCing (https://github.com/TheCing/uma-tools)
 * Licensed under GPL-3.0-or-later
 */

declare const CC_DEV: boolean;

import { h, render, Fragment } from "preact";
import {
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
} from "preact/hooks";
import { IntlProvider } from "preact-i18n";

// Simulation utilities
import {
  convertUmaStateForWorker,
} from "./simulation-utils";
import { Grade } from "../../uma-skill-tools/RaceParameters";

// Skill chart utilities
import {
  applyExclusions,
  getBaseSkillsToTest,
  partitionPool,
  type PoolExclusion,
  type PoolSplit,
  withHintLevel,
} from "./skill-chart-utils";

import { RaceTrack, RegionDisplayType } from "../../components/RaceTrack";
import { RaceSummary } from "../../components/RaceSummary";
import { Language } from "../../components/Language";
import { BASE_PATH } from "../../components/base-path";
import {
  CustomSelect,
  Dropdown,
  Button,
  Tooltip,
  Settings,
  Play,
  GitCompare,
  Zap,
  X,
  ArrowLeftRight,
  Link,
} from "./components";
import { NotificationBanner } from "./components/NotificationBanner";
import {
  Users,
  MessageSquare,
  Minus,
  Plus,
  LayoutGrid,
  Wand2,
} from "lucide-react";
import { V2TrackSelect } from "./track-select";
import { CompactConditions, ConditionGroups, GlobalsimFieldControls } from "./conditions";
import { presets, visiblePresets, DEFAULT_PRESET, EventType } from "./presets";
import { V2UmaPanel, UmaState, defaultUmaState } from "./uma-panel";
import { TraineesTab } from "./trainees-tab";
import { UmasTab, UmasTabState, initialUmasTabState } from "./roster/umas-tab";
import { V2ResultsPane, CompareResults, RaceSnapshot, calcStats } from "./results-pane";
import { VelocityOverlay } from "./velocity-overlay";
import { SkillChartPane } from "./skill-chart-pane";
import { OptimizerPane, OptimizerControl } from "./optimizer-pane";
import { PoolExclusionList } from "./pool-exclusions";
import type { CareerImport } from "./career-import";
import { SkillChartDetail } from "./skill-chart-detail";
// import { PasswordGate } from "./PasswordGate";
import { FeedbackDrawer } from "./feedback-drawer";
import { SimulationSettings, SimCommonControls, SimAdvancedControls } from "./sim-settings";
import { loadGlobalsimSkillTable } from "./engines/globalsim/skills";
import { loadGlobalsimCourseIds } from "./engines/globalsim/courses";
import { runGlobalsimCompare } from "./engines/globalsim/compare";
import { runGlobalsimSkillChart } from "./engines/globalsim/chart";
import {
  resolveThreadCount,
  serverAwareThreadCount,
  loadThreadsOption,
  saveThreadsOption,
  setGpuCostModel,
  type ThreadsOption,
  type WorkerFactory,
} from "./engines/globalsim/pool";
import {
  SimWorker,
  pingSimServer,
  simAccessState,
  needsGestureFor,
  loadSimServerUrl,
  loadSimServerToken,
  saveSimServerSettings,
  simGpuFactory,
  simSessionFactory,
} from "./engines/globalsim/simLink";
import type { SimAccess } from "./engines/globalsim/simLink";
import type { GpuVerdict, LastJob } from "./engines/globalsim/lanePlan";
import { HorseState } from "../../components/HorseDefTypes";
import { fromJS, Map as ImmMap } from "immutable";
import mobPresets from "./engines/globalsim/mob-presets.json";
import { MobileNav, MobileView } from "./mobile-nav";
import {
  loadSession,
  saveSession,
  loadPreferences,
  savePreferences,
  copyShareableUrl,
  deserializeStateFromHash,
  validateAndParseUmaJson,
  COLOR_PALETTES,
  type ColorPalette,
} from "./storage";
import courseData from "../course_data.json";
import skilldata from "../skill_data.json";
import skillnames from "../skillnames.json";
import { skillDisplayName } from "./skill-name";
import skillmeta from "../../skill_meta.json";
import "./v2.css";

// Discord webhook for feedback submissions - configure via VITE_DISCORD_WEBHOOK environment variable
const DISCORD_FEEDBACK_WEBHOOK = import.meta.env.VITE_DISCORD_WEBHOOK || '';

// Feedback drawer feature flag. Defaults to enabled. Set VITE_ENABLE_FEEDBACK=false in
// .env.local (or the build environment) to hide the drawer + floating toggle entirely.
// Also auto-hides when no webhook URL is configured — submission would fail anyway.
const FEEDBACK_ENABLED =
  import.meta.env.VITE_ENABLE_FEEDBACK !== 'false' &&
  DISCORD_FEEDBACK_WEBHOOK !== '';

/**
 * Detect if a glyph renders as a "tofu" missing glyph rectangle.
 * Compares the rendered character against a known missing codepoint.
 */
function hasGlyph(char: string): boolean {
  if (typeof document === "undefined") return true; // SSR fallback

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return true;

  canvas.width = 50;
  canvas.height = 50;
  ctx.font = "32px sans-serif";
  ctx.textBaseline = "middle";

  // Render the test character
  ctx.clearRect(0, 0, 50, 50);
  ctx.fillText(char, 0, 25);
  const testData = ctx.getImageData(0, 0, 50, 50).data;

  // Render a known missing glyph (private use area character)
  ctx.clearRect(0, 0, 50, 50);
  ctx.fillText("\uFFFF", 0, 25);
  const missingData = ctx.getImageData(0, 0, 50, 50).data;

  // Compare pixel data - if they match, the glyph is missing
  let matchCount = 0;
  let totalPixels = 0;
  for (let i = 0; i < testData.length; i += 4) {
    if (testData[i + 3] > 0 || missingData[i + 3] > 0) {
      totalPixels++;
      if (
        Math.abs(testData[i] - missingData[i]) < 10 &&
        Math.abs(testData[i + 1] - missingData[i + 1]) < 10 &&
        Math.abs(testData[i + 2] - missingData[i + 2]) < 10 &&
        Math.abs(testData[i + 3] - missingData[i + 3]) < 10
      ) {
        matchCount++;
      }
    }
  }

  // If >90% similar to missing glyph, consider it unsupported
  return totalPixels === 0 || matchCount / totalPixels < 0.9;
}

// Corner arrow with fallback: ⮌ (U+2B8C) -> ↩ (U+21A9)
const CORNER_ARROW = hasGlyph("⮌") ? "⮌" : "↩";

// Single source for the skill-table load-failure notice: the table effect
// raises it when its retries are exhausted, and both run handlers refuse to
// start a run with the same message. All GlobalSim failure messages (this one
// included) surface in the shared results-area error block (globalsimError).
const GLOBALSIM_TABLE_FAIL_MSG =
  "GlobalSim skill table failed to load — reload the page";

// Minimal strings for RaceTrack
const STRINGS = {
  racetrack: {
    thresholds: "Stat thresholds: ",
    none: "​",
    inner: " (inner)",
    outer: " (outer)",
    outin: " (outer→inner)",
    orientation: ["", "(clockwise)", "(counterclockwise)", "", "(straight)"],
    turf: "Turf",
    dirt: "Dirt",
    straight: "Straight →",
    corner: `Corner ${CORNER_ARROW}{{n}}`,
    uphill: "Uphill ↗",
    downhill: "Downhill ↘",
    phase0: "Opening leg",
    phase1: "Middle leg",
    phase2: "Final leg",
    phase3: "Last spurt",
    short: {
      straight: "→",
      corner: `${CORNER_ARROW}{{n}}`,
      uphill: "↗",
      downhill: "↘",
    },
  },
  tracknames: {},
  coursedesc: {
    one: "{{distance}}m{{inout}}",
    many: "{{surface}} {{distance}}m{{inout}}",
  },
  ui: {
    stats: ["None", "Speed", "Stamina", "Power", "Guts", "Wit"],
    joiner: ", ",
  },
};

import tracknames from "../../uma-skill-tools/data/tracknames.json";
import { initAnalytics, setRunContext, track } from "./analytics";
Object.keys(tracknames).forEach(
  (k) => (STRINGS["tracknames"][k] = tracknames[k][1]),
);

const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

function MaintenanceTime() {
  const start = new Date('2026-03-03T07:00:00Z');
  const end = new Date('2026-03-03T09:00:00Z');
  return <>{timeFmt.format(start)} – {timeFmt.format(end)}, {dateFmt.format(start)}</>;
}

function App() {
  // Load saved state on mount
  const savedSession = useRef(loadSession());
  const savedPrefs = useRef(loadPreferences());

  // Course and conditions
  const [courseId, setCourseId] = useState(
    savedSession.current?.courseId ?? DEFAULT_PRESET.courseId,
  );
  // A saved null is Custom (no preset), kept as null: `??` turned it into the
  // current Champions Meeting, whose course was not the one loaded.
  const [selectedPresetId, setSelectedPresetId] = useState<number | null>(
    savedSession.current
      ? savedSession.current.selectedPresetId
      : DEFAULT_PRESET.id,
  );
  const [ground, setGround] = useState(
    savedSession.current?.ground ?? DEFAULT_PRESET.ground,
  );
  const [weather, setWeather] = useState(
    savedSession.current?.weather ?? DEFAULT_PRESET.weather,
  );
  const [season, setSeason] = useState(
    savedSession.current?.season ?? DEFAULT_PRESET.season,
  );
  const [time, setTime] = useState(
    savedSession.current?.time ?? DEFAULT_PRESET.time,
  );

  // Preferences (persisted separately)
  const [darkMode, setDarkMode] = useState(savedPrefs.current.darkMode);
  // Glassmorphic surfaces. Orthogonal to darkMode: composes with both modes and all 6 accents.
  const [glassMode, setGlassMode] = useState(savedPrefs.current.glassMode);
  const [colorPalette, setColorPalette] = useState<ColorPalette>(
    savedPrefs.current.colorPalette,
  );
  const [uiScale, setUiScale] = useState(savedPrefs.current.uiScale);

  // Easter egg: "STILL" triggers yandere mode (dev only)
  const [yandereMode, setYandereMode] = useState(false);

  // Simulation settings
  const [samples, setSamples] = useState(savedSession.current?.samples ?? 500);
  const [mode, setMode] = useState<"compare" | "skill" | "optimizer">(
    savedSession.current?.mode ?? "compare",
  );
  // Set on the first render in Optimizer mode and never cleared: from then on
  // the pane stays mounted (hidden in the other modes), so a mode switch keeps
  // its results, pool choices and settings.
  const optimizerVisited = useRef(false);
  if (mode === "optimizer") optimizerVisited.current = true;
  const [seed, setSeed] = useState(() =>
    Math.floor(Math.random() * 0xffffffff),
  );
  // GlobalSim (wasm) is the only engine: compare AND the skill chart run the
  // full-field engine via engines/globalsim/pool.ts. The classic TS engine and
  // the v1/v2/GlobalSim selector were removed; the HP/stamina calculator that
  // only ever ran on classic was dropped with them.
  // Active GlobalSim skill table (keys of globalsim/skills.json, fetched once when
  // GlobalSim mode is enabled; null = classic behavior until it arrives).
  const [globalsimSkillIds, setGlobalsimSkillIds] = useState<Set<string> | null>(null);
  // Full merged table (engine skillData) — injected into workers once per run
  // so batch-1 supplement skills initialize in the engine (see skills.ts).
  const [globalsimSkillTable, setGlobalsimSkillTable] = useState<Record<string, unknown> | null>(null);
  const [globalsimUncoveredCount, setGlobalsimUncoveredCount] = useState<number | null>(null);
  // Skills removed from imported/loaded builds while in GlobalSim mode (inline note).
  const [globalsimDropped, setGlobalsimDropped] = useState(0);
  // True once the GlobalSim skill-table fetch failed even after its in-module
  // retries. Without the table every coverage gate is off (the adapter skips
  // its unknown-skill check and supplement-id jobs all fail), so runs are
  // refused and a persistent notice points at a reload.
  const [globalsimTableFailed, setGlobalsimTableFailed] = useState(false);
  // Visible surface for every GlobalSim runtime failure (failed asset fetch,
  // adapter buildErrors rejection, 'produced no results', wasm load) — set by
  // both run handlers' catches and by the skill-table effect, cleared when a
  // new run starts, on engine change, or on dismiss.
  const [globalsimError, setGlobalsimError] = useState<string | null>(null);
  // GlobalSim worker-pool size option (Phase 4 §4.1): persisted by pool.ts.
  const [globalsimThreads, setGlobalsimThreads] = useState<ThreadsOption>(() => loadThreadsOption());
  useEffect(() => { saveThreadsOption(globalsimThreads); }, [globalsimThreads]);

  // Local sim server (opt-in CPU offload, sim-server.ts): probed at startup,
  // re-checkable from Simulation settings. Online → workers become JSON pipes
  // to the local server (Auto = every core, no browser tab memory).
  const [simServerUrl, setSimServerUrl] = useState<string>(() => loadSimServerUrl());
  const [simServerToken, setSimServerToken] = useState<string>(() => loadSimServerToken());
  const [simServerOnline, setSimServerOnline] = useState(false);
  const [simServerCores, setSimServerCores] = useState<number | undefined>(undefined);
  // Chrome's Local Network Access gate for this origin. 'prompt' means the page
  // has never asked, and an ungestured request would be denied silently.
  const [simAccess, setSimAccess] = useState<SimAccess>("unknown");
  const [simServerTokenRejected, setSimServerTokenRejected] = useState(false);
  // The server's gpu verdict: the extra lane opens only when /ping reports a
  // usable (exact and batch-capable) device.
  const [simServerGpu, setSimServerGpu] = useState(false);
  const [simServerGpuPlan, setSimServerGpuPlan] = useState<GpuVerdict | null>(null);
  // The last finished GlobalSim run, shown under the lane plan in settings.
  const [lastSimJob, setLastSimJob] = useState<LastJob | null>(null);
  const gpuProbeRetryRef = useRef<number | null>(null);
  const checkSimServer = useCallback(async (opts?: { gesture?: boolean }) => {
    // A gesture can open Chrome's permission dialog, and the request stays
    // pending while it is up, so that path cannot use the 1.5 s probe budget.
    const r = await pingSimServer(simServerUrl, simServerToken, opts?.gesture ? { timeoutMs: 60_000 } : undefined);
    setSimServerOnline(r.ok);
    setSimServerCores(r.cores);
    setSimServerGpu(!!(r.gpu?.ok && r.gpu.batch));
    setSimServerGpuPlan(r.gpu ?? null);
    setSimServerTokenRejected(r.tokenRequired === true && r.authed === false);
    if (opts?.gesture) setSimAccess(await simAccessState());
    saveSimServerSettings(simServerUrl, simServerToken);
    // The startup check measured this device's launch floor and slope, so the
    // pool sizes its lane on those. No eager session: an open device costs the
    // CPU pool a measured 27% of its throughput.
    const floor = typeof r.gpu?.floorMs === "number" ? r.gpu.floorMs : null;
    const slope = typeof r.gpu?.slopeMsPerRace === "number" ? r.gpu.slopeMsPerRace : null;
    if (r.gpu?.ok && r.gpu.batch && floor !== null && slope !== null) {
      setGpuCostModel({ floor, slope });
    } else {
      setGpuCostModel(null);
    }
    // The startup check runs off the server's request path, so ask again while it
    // is pending or the lane would stay closed for the whole session.
    if (gpuProbeRetryRef.current !== null) { window.clearTimeout(gpuProbeRetryRef.current); gpuProbeRetryRef.current = null; }
    if (r.ok && r.gpu?.pending) {
      gpuProbeRetryRef.current = window.setTimeout(() => { gpuProbeRetryRef.current = null; void checkSimServer(); }, 3000);
    }
  }, [simServerUrl, simServerToken]);
  useEffect(() => {
    // Probing on load is what broke this: Chrome denies an ungestured loopback
    // request without a prompt and keeps that denial, so the dialog could never
    // appear for the Check that came later. Only an existing grant, a local
    // origin, or a browser without Local Network Access may probe here.
    let live = true;
    void simAccessState().then((access) => {
      if (!live) return;
      setSimAccess(access);
      if (access === "granted" || access === "unknown" || !needsGestureFor(simServerUrl)) void checkSimServer();
    });
    return () => {
      live = false;
      if (gpuProbeRetryRef.current !== null) window.clearTimeout(gpuProbeRetryRef.current);
    };
  }, []);
  // GlobalSim field selection (integration plan Phase 3): mob preset + gate mode.
  // The same seed and preset give the same field; "Auto" draws the tested uma's
  // gate per seed, identically for both races of a compare pair.
  const [globalsimFieldPreset, setGlobalsimFieldPreset] = useState("default");
  // Collapsible "Advanced" strip in the header (threads / sim server / notices).
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [globalsimGate, setGlobalsimGate] = useState<number | "auto">("auto");
  // Compare field layout: 'mob' isolates each build against 8 mobs; 'h2h'
  // races both umas together against 7 mobs (mirrored gate pairs). Compare
  // only — the skill chart always uses the mob layout.
  const [globalsimLayout, setGlobalsimLayout] = useState<"mob" | "h2h">("mob");
  // Paired random streams (engine pairedRandomStreams): both sides draw from
  // position/skill-keyed streams, so a one-skill delta keeps its draws and the
  // paired σ(lead) drops ~10×. Compare-only toggle; OFF = retail (official
  // parity). The Skill Chart is always paired (chart.ts default) — no toggle.
  const [globalsimPaired, setGlobalsimPaired] = useState(false);
  const globalsimFieldConfig = {
    preset: globalsimFieldPreset,
    setPreset: setGlobalsimFieldPreset,
    gate: globalsimGate,
    setGate: setGlobalsimGate,
    presets: Object.entries(mobPresets).map(([value, p]: [string, any]) => ({ value, label: `Field: ${p.name}` })),
    layout: globalsimLayout,
    setLayout: setGlobalsimLayout,
    showLayout: mode === "compare",
    paired: globalsimPaired,
    setPaired: setGlobalsimPaired,
    showPaired: mode === "compare",
  };
  useEffect(() => {
    if (globalsimSkillIds) return;
    let alive = true;
    loadGlobalsimSkillTable().then((table) => {
      if (!alive) return;
      if (!table) {
        // Retries inside skills.ts exhausted: record it so the run handlers
        // refuse to start a gated run without the table (engine toggling back
        // into globalsim re-runs this effect and retries the whole sequence),
        // and raise the notice in the shared results-area error surface.
        setGlobalsimTableFailed(true);
        setGlobalsimError(GLOBALSIM_TABLE_FAIL_MSG);
        return;
      }
      setGlobalsimTableFailed(false);
      // A late successful load (retry after an earlier failure) retires only
      // the table notice — an unrelated run error stays visible until cleared.
      setGlobalsimError((prev) => (prev === GLOBALSIM_TABLE_FAIL_MSG ? null : prev));
      const ids = new Set(Object.keys(table));
      setGlobalsimSkillIds(ids);
      setGlobalsimSkillTable(table);
      setGlobalsimUncoveredCount(
        Object.keys(skilldata).filter((id) => !ids.has(id)).length,
      );
    });
    return () => {
      alive = false;
    };
  }, [globalsimSkillIds]);
  const [autoSeed, setAutoSeed] = useState(false);

  // Panel visibility
  const [umaDrawerOpen, setUmaDrawerOpen] = useState(false);
  const [activeUmaTab, setActiveUmaTab] = useState<1 | 2 | "trainees" | "umas">(1);
  // Lifted so the roster/filters/sort survive the tab unmount that Load triggers.
  const [umasState, setUmasState] = useState<UmasTabState>(initialUmasTabState);
  const [summaryDrawerOpen, setSummaryDrawerOpen] = useState(false);
  const [feedbackDrawerOpen, setFeedbackDrawerOpen] = useState(false);

  // Mobile navigation
  const [mobileView, setMobileView] = useState<MobileView>("track");
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);

  // Velocity overlay toggles
  const [showVelocityOverlay, setShowVelocityOverlay] = useState(true);
  const [showHpOverlay, setShowHpOverlay] = useState(true);

  // Which run to display (mean/median/min/max)
  const [displayRun, setDisplayRun] = useState<
    "mean" | "median" | "min" | "max"
  >("median");


  // Simulation results
  const [isRunning, setIsRunning] = useState(false);
  // The Optimizer tab runs from the same RUN button: the pane hands over its
  // run/stop here and reports whether a search is going.
  const optimizerControl = useRef<OptimizerControl | null>(null);
  const [optimizerRunning, setOptimizerRunning] = useState(false);
  const [results, setResults] = useState<CompareResults | null>(null);

  // Skill chart results
  const [skillChartResults, setSkillChartResults] = useState<Map<string, any>>(
    new Map(),
  );
  const [skillChartProgress, setSkillChartProgress] = useState<{
    [workerId: number]: { round: number; total: number };
  }>({});
  const [completedWorkers, setCompletedWorkers] = useState(0);
  // Skill tab exclusion list (pool-exclusions.tsx): the master switch, the ids
  // put back by hand, and ids the awaited engine table dropped after the split.
  const [chartFocusOn, setChartFocusOn] = useState(true);
  const [chartIncluded, setChartIncluded] = useState<Set<string>>(() => new Set());
  const [skillChartLateOut, setSkillChartLateOut] = useState<PoolExclusion[]>([]);

  // Skill chart filters and state
  const [hideOwned, setHideOwned] = useState(false);
  const [hidePurple, setHidePurple] = useState(false);
  const [showUmaIcons, setShowUmaIcons] = useState(false);
  const [chartFastMode, setChartFastMode] = useState(false); // 2x faster, lower accuracy
  const [skillHints, setSkillHints] = useState<Map<string, number>>(new Map());
  const [hiddenSkills, setHiddenSkills] = useState<Set<string>>(new Set());
  const [hideNotInGame, setHideNotInGame] = useState(() => {
	const saved = localStorage.getItem('umalator_v2_hideNotInGame');
	return saved !== null ? saved === 'true' : true; // default: hidden
  });
  const [wideSkills, setWideSkills] = useState(() => localStorage.getItem('umalator_v2_wideSkills') !== 'false');
  const [selectedSkillForChart, setSelectedSkillForChart] = useState("");
  const [chartRunType, setChartRunType] = useState("medianrun");

  // Simulation runs go through the GlobalSim wasm worker pool (see the run
  // handlers). The classic TS simulator.worker.ts and its lazy worker pools
  // were removed with the classic engine.

  // Uma 1 state
  const [uma1, setUma1] = useState<UmaState>(
    savedSession.current?.uma1 ?? defaultUmaState,
  );

  // Uma 2 state (for compare mode)
  const [uma2, setUma2] = useState<UmaState>(
    savedSession.current?.uma2 ?? defaultUmaState,
  );

  // Per-uma-slot stash of the skills the coverage-gate drop effect below strips
  // from a working build (id -> its former forced position). GlobalSim is the
  // only engine now, so nothing is restored on an engine switch; the stash just
  // records what the drop effect removed.
  const globalsimDroppedStash = useRef<Array<Map<string, string | undefined>>>([
    new Map(),
    new Map(),
  ]);

  // Coverage gate (D5): uncovered skills must never reach the engine, so skills outside
  // the active table are dropped from any build state entering the app — session/URL-hash
  // restore, saved slots, JSON/paste/OCR imports, roster and preset loads.
  useEffect(() => {
    if (!globalsimSkillIds) return;
    const dropUncovered = (
      uma: UmaState,
      stash: Map<string, string | undefined>,
    ) => {
      const skills = uma.skills.filter((id) => globalsimSkillIds.has(id));
      if (skills.length === uma.skills.length) return;
      const forcedSkillPositions = { ...uma.forcedSkillPositions };
      for (const id of uma.skills) {
        if (!globalsimSkillIds.has(id)) {
          // undefined when the skill had no forced position (restore must not add one).
          stash.set(id, forcedSkillPositions[id]);
          delete forcedSkillPositions[id];
        }
      }
      setGlobalsimDropped((n) => n + uma.skills.length - skills.length);
      return { ...uma, skills, forcedSkillPositions };
    };
    const next1 = dropUncovered(uma1, globalsimDroppedStash.current[0]);
    if (next1) setUma1(next1);
    const next2 = dropUncovered(uma2, globalsimDroppedStash.current[1]);
    if (next2) setUma2(next2);
  }, [globalsimSkillIds, uma1, uma2]);

  // Map of groupId -> skillId for owned skills (for "Hide Owned" filter in skill chart)
  const hasSkills = useMemo(() => {
    const map = new Map<string, string>();
    uma1.skills.forEach((skillId) => {
      const groupId = (skillmeta as any)[skillId]?.groupId;
      if (groupId) {
        map.set(groupId, skillId);
      }
    });
    return map;
  }, [uma1.skills]);

  // ============================================
  // AUTO-SAVE EFFECTS
  // ============================================

  // Save session state (debounced)
  const saveTimeoutRef = useRef<number | null>(null);
  useEffect(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = window.setTimeout(() => {
      saveSession({
        courseId,
        selectedPresetId,
        ground,
        weather,
        season,
        time,
        samples,
        // All three modes persist as-is; loadSession normalizes unknown modes
        // back to "compare".
        mode: mode as "compare" | "skill" | "optimizer",
        uma1,
        uma2,
      });
    }, 500); // Debounce 500ms
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [
    courseId,
    selectedPresetId,
    ground,
    weather,
    season,
    time,
    samples,
    mode,
    uma1,
    uma2,
  ]);

  // Save preferences immediately
  useEffect(() => {
    savePreferences({ darkMode, glassMode, colorPalette, uiScale });
  }, [darkMode, glassMode, colorPalette, uiScale]);

  useEffect(() => {
	localStorage.setItem('umalator_v2_hideNotInGame', String(hideNotInGame));
  }, [hideNotInGame]);

  useEffect(() => {
	localStorage.setItem('umalator_v2_wideSkills', String(wideSkills));
  }, [wideSkills]);

  // Easter egg: detect "STILL" typed outside input fields (dev only, stripped in prod)
  useEffect(() => {
    if (!CC_DEV) return;
    let buffer = '';
    const TARGET = 'STILL';

    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in an input/textarea
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      // Only track letter keys
      if (e.key.length === 1 && /[a-zA-Z]/.test(e.key)) {
        buffer += e.key.toUpperCase();
        // Keep only last N characters
        if (buffer.length > TARGET.length) {
          buffer = buffer.slice(-TARGET.length);
        }
        // Check for match
        if (buffer === TARGET) {
          setYandereMode(prev => !prev);
          buffer = '';
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Load state from URL on mount (supports ?preset=X and hash-based state)
  useEffect(() => {
    // Check for preset query parameter first
    const urlParams = new URLSearchParams(window.location.search);
    const presetParam = urlParams.get("preset");
    if (presetParam) {
      const presetId = parseInt(presetParam, 10);
      const preset = presets.find((p) => p.id === presetId);
      if (preset) {
        setCourseId(preset.courseId);
        setGround(preset.ground);
        setWeather(preset.weather);
        setSeason(preset.season);
        setTime(preset.time);
        setSelectedPresetId(presetId);
        return; // Don't also load from hash
      }
    }

    // Otherwise, check for hash-based state
    const loadFromHash = async () => {
      if (window.location.hash) {
        const state = await deserializeStateFromHash(
          window.location.hash.slice(1),
        );
        if (state) {
          setCourseId(state.courseId);
          setGround(state.ground);
          setWeather(state.weather);
          setSeason(state.season);
          setTime(state.time);
          setSamples(state.samples);
          setUma1(state.uma1);
          setUma2(state.uma2);
          // Restore hint levels (older links omit this → empty map = all zero).
          setSkillHints(
            state.skillHints
              ? new Map(Object.entries(state.skillHints))
              : new Map(),
          );
          setSelectedPresetId(null);
        }
      }
    };
    loadFromHash();

    // Also handle hash changes
    const handleHashChange = () => loadFromHash();
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  // Note: Timeline drawer no longer auto-opens - user can open manually

  // ============================================
  // HANDLERS
  // ============================================

  // Handler to apply a preset
  const handlePresetSelect = useCallback((presetId: number | null) => {
    setSelectedPresetId(presetId);
    if (presetId !== null) {
      const preset = presets.find((p) => p.id === presetId);
      if (preset) {
        setCourseId(preset.courseId);
        setGround(preset.ground);
        setWeather(preset.weather);
        setSeason(preset.season);
        setTime(preset.time);
      }
    }
  }, []);

  const handleUma1Change = useCallback((updates: Partial<UmaState>) => {
    setUma1((prev) => ({ ...prev, ...updates }));
  }, []);

  const handleUma1Load = useCallback((state: UmaState) => {
    setUma1(state);
  }, []);

  const handleUma1Reset = useCallback(() => {
    setUma1(defaultUmaState);
  }, []);

  const handleUma2Change = useCallback((updates: Partial<UmaState>) => {
    setUma2((prev) => ({ ...prev, ...updates }));
  }, []);

  const handleUma2Load = useCallback((state: UmaState) => {
    setUma2(state);
  }, []);

  const handleUma2Reset = useCallback(() => {
    setUma2(defaultUmaState);
  }, []);

  const handleResetAll = useCallback(() => {
    setUma1(defaultUmaState);
    setUma2(defaultUmaState);
  }, []);

  const handleSwapUmas = useCallback(() => {
    setUma1(uma2);
    setUma2(uma1);
  }, [uma1, uma2]);

  // Optimizer "Open in Compare": copy the optimized uma (uma1) and apply the
  // recommended build's added skills (group-exclusive, same rule as the chart
  // double-click) as Uma 2, so it can be compared against the current build.
  const handleOpenInCompare = useCallback((addedSkillIds: string[]) => {
    setUma2(() => {
      let skills = [...uma1.skills];
      for (const skillId of addedSkillIds) {
        const groupId = (skillmeta as Record<string, { groupId?: string }>)[skillId]?.groupId;
        if (!groupId) continue;
        skills = skills.filter((id) => (skillmeta as Record<string, { groupId?: string }>)[id]?.groupId !== groupId);
        if (!skills.includes(skillId)) skills.push(skillId);
      }
      return { ...uma1, skills };
    });
    // Uma 2 only exists in Compare mode: without the switch the drawer selected
    // a tab that is not drawn and showed nothing.
    setMode("compare");
    setActiveUmaTab(2);
  }, [uma1]);

  // The Uma 2 tab is drawn only in Compare mode. Leaving Compare with it
  // selected would leave the drawer empty, so fall back to Uma 1.
  useEffect(() => {
    if (mode !== "compare" && activeUmaTab === 2) setActiveUmaTab(1);
  }, [mode, activeUmaTab]);

  // A career import (a Hachimi dump or a umadump snapshot) describes a real uma, so it
  // replaces the fields it carries and merges its hint levels into the shared hint state.
  // The merged build goes back through the app's own validator, so a file with a
  // bad value in it cannot push a stat out of range; if validation rejects it, the
  // previous uma is left alone.
  // Categories sent with each run event (course, distance, ground, style, preset).
  useEffect(() => {
    const course = courseData[courseId];
    const preset = selectedPresetId == null ? null : presets.find((p) => p.id === selectedPresetId);
    const kind = preset?.type === EventType.LOH ? "LOH" : "CM";
    setRunContext({
      courseId,
      trackName: course ? tracknames[course.raceTrackId]?.[1] : undefined,
      distance: course?.distance,
      distanceType: course?.distanceType,
      surface: course?.surface,
      ground,
      strategy: uma1.strategy,
      preset: preset ? { key: `${kind}-${preset.id}`, title: `${kind} ${preset.id} - ${preset.name}` } : null,
    });
  }, [courseId, ground, uma1.strategy, selectedPresetId]);

  const handleImportCareer = useCallback((imp: CareerImport) => {
    track("career-import");
    setUma1((prev) => validateAndParseUmaJson({ ...prev, ...imp.uma }) ?? prev);
    if (imp.hints.size) {
      setSkillHints((prev) => {
        const next = new Map(prev);
        for (const [id, level] of imp.hints) next.set(id, level);
        return next;
      });
    }
  }, []);

  // Skill info popover state
  const [popoverSkillId, setPopoverSkillId] = useState<string | null>(null);

  // Add skill from chart table (double-click)
  const handleAddSkillFromChart = useCallback((skillId: string) => {
    const groupId = skillmeta[skillId]?.groupId;
    if (!groupId) return;

    setUma1((prev) => {
      // Remove any existing skill in the same group, then add the new skill
      const filteredSkills = prev.skills.filter(
        (id) => skillmeta[id]?.groupId !== groupId,
      );
      return { ...prev, skills: [...filteredSkills, skillId] };
    });
  }, []);

  // Show skill info popover (click on skill icon)
  const handleShowSkillInfo = useCallback((skillId: string) => {
    setPopoverSkillId(skillId);
  }, []);

  // Close skill info popover on outside click
  useEffect(() => {
    const handleClick = () => setPopoverSkillId(null);
    document.body.addEventListener("click", handleClick);
    return () => document.body.removeEventListener("click", handleClick);
  }, []);

  // Notification banner — set NOTIFICATION_ID to show, or '' to hide
  const NOTIFICATION_ID = '';

  const [showNotification, setShowNotification] = useState(
    () => NOTIFICATION_ID !== '' && savedPrefs.current.notificationDismissed !== NOTIFICATION_ID,
  );

  const dismissNotification = useCallback(() => {
    setShowNotification(false);
    savePreferences({ notificationDismissed: NOTIFICATION_ID });
  }, []);

  // Publish where the control bar (+ the open Advanced strip) ends on screen as
  // --header-bottom. Nothing static can match it: the bar wraps to two or three
  // bands by width, the strip toggles, a banner shifts the bar down, and below
  // 1920px the page scrolls the bar away. The fixed drawers hang from this var,
  // so a stale value buries their headers under the bar (it sits above them).
  useEffect(() => {
    const root = document.documentElement;
    let raf = 0;
    let last = -1;
    const measure = () => {
      raf = 0;
      const header = document.querySelector(".v2-header");
      if (!header) return;
      const strip = document.querySelector(".v2-advanced-strip");
      const bottom = Math.max(
        0,
        Math.round(
          Math.max(
            header.getBoundingClientRect().bottom,
            strip?.getBoundingClientRect().bottom ?? 0,
          ),
        ),
      );
      if (bottom === last) return;
      last = bottom;
      root.style.setProperty("--header-bottom", `${bottom}px`);
    };
    // Coalesce: a resize/zoom pass fires the observer many times per frame.
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    schedule();
    const ro = new ResizeObserver(schedule);
    for (const el of [
      document.querySelector(".v2-header"),
      document.querySelector(".v2-advanced-strip"),
    ]) {
      if (el) ro.observe(el);
    }
    window.addEventListener("resize", schedule);
    // Scrolling measures at once: deferred a frame, the drawers trail the bar.
    window.addEventListener("scroll", measure, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", measure);
    };
  }, [advancedOpen, showNotification]);

  // Mobile view change handler
  const handleMobileViewChange = useCallback((view: MobileView) => {
    setMobileView(view);
    // Close all drawers first
    setUmaDrawerOpen(false);
    setSummaryDrawerOpen(false);
    setFeedbackDrawerOpen(false);
    setMobileSettingsOpen(false);

    // Open the appropriate drawer/panel
    switch (view) {
      case "uma":
        setUmaDrawerOpen(true);
        break;
      case "timeline":
        setSummaryDrawerOpen(true);
        break;
      case "settings":
        setMobileSettingsOpen(true);
        break;
      case "track":
      default:
        // Just close everything, show track
        break;
    }
  }, []);

  // GlobalSim worker-pool entry (Phase 4): the same bundler URL pattern as the
  // classic simWorker, and idle sessions come back from the warm cache.
  // Declared before handleRunSkillChart and handleRunSimulation, which use it.
  const globalsimWorkerFactory: WorkerFactory = useMemo(
    () =>
      simServerOnline
        ? simSessionFactory(simServerUrl, simServerToken)
        : () =>
            new Worker(new URL("./engines/globalsim/globalsim.worker.ts", import.meta.url), {
              type: "module",
            }),
    [simServerOnline, simServerUrl, simServerToken],
  );

  // The extra gpu lane's factory: one pinned gpu session, offered only when the
  // server reported a usable GPU. Without it the pools stay all-CPU.
  const globalsimGpuFactory: WorkerFactory | undefined = useMemo(
    () =>
      simServerOnline && simServerGpu
        ? simGpuFactory(simServerUrl, simServerToken)
        : undefined,
    [simServerOnline, simServerGpu, simServerUrl, simServerToken],
  );

  // Candidate skills for the Skill tab and the Skill Optimizer: one split for
  // both, with every dropped skill and its reason (pool-exclusions.tsx).
  const skillPool = useMemo((): PoolSplit => {
    const course = courseData[courseId];
    if (!course) return { kept: [], out: [] };
    const baseSkills = getBaseSkillsToTest(uma1, hideNotInGame);
    return partitionPool(
      baseSkills,
      uma1,
      course,
      { ground, weather, season, time },
      globalsimSkillIds,
    );
  }, [
    courseId,
    ground,
    weather,
    season,
    time,
    uma1,
    hideNotInGame,
    globalsimSkillIds,
  ]);

  // Run skill chart via 4 workers
  // GlobalSim chart (Phase 5): AbortController per run — starting a new run
  // cancels the previous pool (terminate workers, drop queues, reject).
  const chartAbortRef = useRef<AbortController | null>(null);
  const handleRunSkillChart = useCallback(() => {
    chartAbortRef.current?.abort();
    chartAbortRef.current = null;
    setIsRunning(true);
    track("skill-chart-run");
    setCompletedWorkers(0);
    setSkillChartResults(new Map());
    setSkillChartProgress({});
    setSelectedSkillForChart(""); // Clear selection when starting new run
    setGlobalsimError(null); // superseded by this run

    const course = courseData[courseId];
    if (!course) {
      console.error("[V2] Course not found:", courseId);
      setIsRunning(false);
      return;
    }

    // The skills to test: the shared split, plus anything the user put back
    // from the exclusion list. Not-in-game skills were already left out of the
    // base list, so no sim time goes to rows the chart would hide anyway.
    setSkillChartLateOut([]);
    const activateableSkills = applyExclusions(
      skillPool.kept,
      skillPool.out,
      chartFocusOn,
      chartIncluded,
    );

    if (activateableSkills.length === 0) {
      console.warn("[V2] No activateable skills found for this course");
      setIsRunning(false);
      return;
    }

    // GlobalSim chart: the chart runs through the wasm worker pool — a shared
    // per-seed baseline + one "+skill" variant per candidate, paired by seed.
    // Candidates are already activateable + coverage-filtered above.
    {
      const controller = new AbortController();
      chartAbortRef.current = controller;
      (async () => {
        // The skill table is mandatory in GlobalSim mode: without it the
        // coverage gate is off (unknown skills reach the engine, every
        // supplement-id job fails and the run ends with n=0). Never run
        // degraded — await the table, then fail visibly.
        if (globalsimTableFailed) {
          throw new Error(GLOBALSIM_TABLE_FAIL_MSG);
        }
        const skillTable = globalsimSkillTable ?? (await loadGlobalsimSkillTable());
        if (!skillTable) {
          setGlobalsimTableFailed(true);
          throw new Error(GLOBALSIM_TABLE_FAIL_MSG);
        }
        const knownSkillIds = globalsimSkillIds ?? new Set(Object.keys(skillTable));
        const courseIds = await loadGlobalsimCourseIds();
        if (!courseIds) {
          throw new Error(
            `GlobalSim course table unavailable (${BASE_PATH}/globalsim/courses.json) — run \`node umalator-global/build.mjs\` once to generate the GlobalSim assets.`,
          );
        }
        // UmaState → HorseState, same conversion as the GlobalSim compare path.
        const toHorseState = (u: typeof uma1) => {
          const w: any = convertUmaStateForWorker(u);
          return new HorseState({
            ...w,
            starCount: (u as any).starCount,
            uniqueLv: (u as any).uniqueLv,
          })
            .set("skills", fromJS(w.skills))
            .set("forcedSkillPositions", ImmMap(w.forcedSkillPositions || {}));
        };
        const chartSkills = activateableSkills.filter((id) => knownSkillIds.has(id));
        // Listed like every other exclusion, so nothing leaves the chart unseen.
        const lateOut = activateableSkills.filter((id) => !knownSkillIds.has(id));
        if (lateOut.length) {
          setSkillChartLateOut(lateOut.map((id) => ({ id, kind: "engine" as const, reason: "not in the engine skill table" })));
        }
        setSkillChartProgress({ 0: { round: 1, total: chartFastMode ? 1 : 2 } });
        // Paired draws are the chart's default (chart.ts): baseline and every
        // variant share their (seed, position, skill) streams — no toggle.
        const rows = await runGlobalsimSkillChart({
          uma: toHorseState(uma1),
          // Coverage filter by the awaited table (the split's filter was a
          // no-op while the table was still in flight).
          skills: chartSkills,
          courseId,
          distance: course.distance,
          ground,
          weather,
          season,
          time,
          grade: Grade.G1,
          knownSkillIds,
          skillData: skillTable,
          courseIds,
          mobPreset: (mobPresets as any)[globalsimFieldPreset] ?? (mobPresets as any)["default"],
          fixedGate: globalsimGate === "auto" ? undefined : globalsimGate,
          seedBase: seed || Math.floor(Math.random() * 0xFFFFFFFF),
          // The chart ignores the Samples field, exactly like the classic
          // engine (fixed 25+175, or 50 in fast mode). Samples belongs to
          // compare; letting it inflate the chart made a full GlobalSim run
          // ~2.5x longer than the classic equivalent for no screening benefit
          // (the round-1 filter decides what matters; compare is the deep dive).
          fastMode: chartFastMode,
          threads: serverAwareThreadCount(globalsimThreads, simServerOnline),
          workerFactory: globalsimWorkerFactory,
          cpuFactory: globalsimWorkerFactory,
          gpuFactory: globalsimGpuFactory,
          // Streaming rows → the existing chart table (fills progressively).
          onProgress: (rows) =>
            setSkillChartResults(new Map(rows.map((r) => [r.id, r]))),
          // Reuses the classic per-worker round progress display (id 0).
          onRound: (round, total) =>
            setSkillChartProgress({ 0: { round, total } }),
          onStats: (s) => setLastSimJob({ label: "Skill chart", ...s }),
          signal: controller.signal,
        });
        console.log("[GlobalSim] skill chart finished:", rows.length, "skills");
      })()
        .catch((e) => {
          if ((e as any)?.name === "AbortError") return; // superseded by a new run
          console.error("[GlobalSim] skill chart failed:", e);
          // Surface it: the chart pane otherwise just sits at its empty state.
          setGlobalsimError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (chartAbortRef.current === controller) chartAbortRef.current = null;
          setIsRunning(false);
        });
      return;
    }
  }, [
    courseId,
    ground,
    weather,
    season,
    time,
    uma1,
    seed,
    chartFastMode,
    globalsimSkillIds,
    globalsimSkillTable,
    globalsimTableFailed,
    samples,
    globalsimFieldPreset,
    globalsimGate,
    globalsimLayout,
    globalsimThreads,
    simServerOnline,
    globalsimWorkerFactory,
    skillPool,
    chartFocusOn,
    chartIncluded,
  ]);

  // Run simulation via worker
  const handleRunSimulation = useCallback(() => {
    // RUN starts the optimizer, and the same button stops it mid-run. The
    // pane stays mounted in the other modes and its run keeps going there, so
    // the button stops it from those modes too, instead of starting a second
    // run on the same workers.
    if (optimizerRunning) {
      optimizerControl.current?.stop();
      return;
    }
    if (mode === "optimizer") {
      // Auto-reroll covers optimizer runs like every other run. The new seed
      // goes to the run directly, since the state update lands after it starts.
      if (autoSeed) {
        const next = Math.floor(Math.random() * 0xFFFFFFFF);
        setSeed(next);
        optimizerControl.current?.run(next);
      } else optimizerControl.current?.run();
      return;
    }
    setGlobalsimError(null); // superseded by this run
    if (autoSeed) {
      setSeed(Math.floor(Math.random() * 0xFFFFFFFF));
    }
    if (mode === "compare") {
      setIsRunning(true);
      track("compare-run");
      setResults(null);

      const course = courseData[courseId];
      if (!course) {
        console.error("[V2] Course not found:", courseId);
        setIsRunning(false);
        return;
      }

      // GlobalSim compare: BOTH sides of the compare run through the wasm
      // worker pool (9-runner mob field, paired by seed).
      {
        (async () => {
          // The skill table is mandatory in GlobalSim mode (same reason as
          // the chart path): a missing table means no unknown-skill check and
          // a guaranteed n=0 failure. Never run degraded — await it, then
          // fail visibly instead of silently skipping the coverage gate.
          if (globalsimTableFailed) {
            throw new Error(GLOBALSIM_TABLE_FAIL_MSG);
          }
          const skillTable = globalsimSkillTable ?? (await loadGlobalsimSkillTable());
          if (!skillTable) {
            setGlobalsimTableFailed(true);
            throw new Error(GLOBALSIM_TABLE_FAIL_MSG);
          }
          const knownSkillIds = globalsimSkillIds ?? new Set(Object.keys(skillTable));
          const courseIds = await loadGlobalsimCourseIds();
          if (!courseIds) {
            throw new Error(
              `GlobalSim course table unavailable (${BASE_PATH}/globalsim/courses.json) — run \`node umalator-global/build.mjs\` once to generate the GlobalSim assets.`,
            );
          }
          // UmaState → HorseState, exactly like simulator.worker.ts's
          // convertToHorseState (plus starCount/uniqueLv, which the GlobalSim
          // adapter needs for the unique skill's level).
          const toHorseState = (u: typeof uma1) => {
            const w: any = convertUmaStateForWorker(u);
            return new HorseState({
              ...w,
              starCount: (u as any).starCount,
              uniqueLv: (u as any).uniqueLv,
            })
              .set("skills", fromJS(w.skills))
              .set("forcedSkillPositions", ImmMap(w.forcedSkillPositions || {}));
          };
          const res = await runGlobalsimCompare({
            uma1: toHorseState(uma1),
            uma2: toHorseState(uma2),
            courseId,
            distance: (courseData as any)[courseId]?.distance ?? 2000,
            ground,
            weather,
            season,
            time,
            grade: Grade.G1,
            knownSkillIds,
            skillData: skillTable,
            courseIds,
            mobPreset: (mobPresets as any)[globalsimFieldPreset] ?? (mobPresets as any)["default"],
            fixedGate: globalsimGate === "auto" ? undefined : globalsimGate,
            fieldLayout: globalsimLayout,
            // Off = retail (official parity); on = paired draws (lower noise).
            paired: globalsimPaired,
            seedBase: seed,
            sampleCount: samples,
            threads: serverAwareThreadCount(globalsimThreads, simServerOnline),
            workerFactory: globalsimWorkerFactory,
            cpuFactory: globalsimWorkerFactory,
            gpuFactory: globalsimGpuFactory,
            // Classic-shaped partial results — the existing pane paints them.
            onProgress: (partial) => setResults(partial as any),
            onStats: (s) => setLastSimJob({ label: "Compare", ...s }),
          });
          console.log("[GlobalSim] compare finished:", res.globalsim);
        })()
          .catch((e) => {
            console.error("[GlobalSim] compare failed:", e);
            // Surface it: the results pane otherwise just sits at its empty state.
            setGlobalsimError(e instanceof Error ? e.message : String(e));
          })
          .finally(() => setIsRunning(false));
        return;
      }
    } else if (mode === "skill") {
      // Skill chart mode
      handleRunSkillChart();
    }
  }, [
    mode,
    optimizerRunning,
    courseId,
    samples,
    ground,
    weather,
    season,
    time,
    uma1,
    uma2,
    seed,
    autoSeed,
    handleRunSkillChart,
    // GlobalSim compare path
    globalsimSkillIds,
    globalsimSkillTable,
    globalsimTableFailed,
    globalsimFieldPreset,
    globalsimGate,
    globalsimLayout,
    globalsimPaired,
    globalsimThreads,
    simServerOnline,
    globalsimWorkerFactory,
  ]);

  // Get current snapshot based on displayRun selection
  const currentSnapshot = useMemo(() => {
    if (!results?.runData) return null;
    switch (displayRun) {
      case "min":
        return results.runData.minrun;
      case "max":
        return results.runData.maxrun;
      case "mean":
        return results.runData.meanrun;
      case "median":
        return results.runData.medianrun;
    }
  }, [results, displayRun]);

  // Skill chart snapshot - selected skill's run data for visualization
  const skillChartSnapshot = useMemo(() => {
    if (mode !== "skill" || !selectedSkillForChart || !skillChartResults.has(selectedSkillForChart)) {
      return null;
    }
    const result = skillChartResults.get(selectedSkillForChart);
    if (!result?.runData) return null;

    // Get the selected run type (medianrun, minrun, maxrun, meanrun)
    return result.runData[chartRunType as keyof typeof result.runData] || result.runData.medianrun;
  }, [mode, selectedSkillForChart, skillChartResults, chartRunType]);

  // Extract skill activation regions from results for track visualization
  const skillRegions = useMemo(() => {
    // Use appropriate snapshot based on mode
    const snapshot = mode === "skill" ? skillChartSnapshot : currentSnapshot;
    if (!snapshot) return [];

    const colors = [
      { stroke: "#2a77c5", fill: "rgba(42, 119, 197, 0.3)" }, // Uma 1 - blue
      { stroke: "#c52a2a", fill: "rgba(197, 42, 42, 0.3)" }, // Uma 2 - red
    ];

    const NO_SHOW = ["skill_empty", "skill_heal"]; // Icons to hide
    const regions: any[] = [];

    // Process skill activations for both umas
    [0, 1].forEach((umaIndex) => {
      const skillMap = snapshot.sk?.[umaIndex];
      if (!skillMap || !(skillMap instanceof Map)) return;

      skillMap.forEach((activations: number[][], skillId: string) => {
        if (!activations || activations.length === 0) return;

        // Skip unwanted skill icons
        const iconId = skillmeta[skillId]?.iconId;
        if (NO_SHOW.includes(iconId)) return;

        const name = skillDisplayName(skillId);

        activations.forEach((ar: number[]) => {
          if (!ar || ar.length < 2) return;
          regions.push({
            type: RegionDisplayType.Textbox,
            color: colors[umaIndex],
            text: name,
            skillId,
            umaIndex,
            regions: [
              { start: ar[0], end: ar[1] !== -1 ? ar[1] : ar[0] + 100 },
            ],
          });
        });
      });
    });

    return regions;
  }, [mode, skillChartSnapshot, currentSnapshot]);

  // Build position keep labels from simulation results
  const posKeepLabels = useMemo(() => {
    if (!currentSnapshot) return [];

    const course = (courseData as any)[courseId];
    if (!course) return [];

    const posKeepColors = [
      { stroke: "rgb(42, 119, 197)", fill: "rgba(42, 119, 197, 0.6)" }, // Uma 1 - blue
      { stroke: "rgb(197, 42, 42)", fill: "rgba(197, 42, 42, 0.6)" }, // Uma 2 - red
    ];

    // Process posKeep data
    const posKeepData = (currentSnapshot.posKeep || [[], []]).flatMap(
      (posKeepArray: any[], umaIndex: number) => {
        if (!posKeepArray) return [];
        return posKeepArray.map((ar: number[]) => {
          const stateName =
            ar[2] === 1
              ? "PU"
              : ar[2] === 2
                ? "PDM"
                : ar[2] === 3
                  ? "SU"
                  : ar[2] === 4
                    ? "O"
                    : "Unknown";
          return {
            umaIndex,
            text: stateName,
            color: posKeepColors[umaIndex],
            start: ar[0],
            end: ar[1],
            duration: ar[1] - ar[0],
          };
        });
      },
    );

    // Process duel (compete fight) data
    const competeFightData: any[] = [];
    const competeFight = currentSnapshot.competeFight || [null, null];
    for (let umaIndex = 0; umaIndex < 2; umaIndex++) {
      const cf = competeFight[umaIndex];
      if (
        cf &&
        Array.isArray(cf) &&
        cf.length >= 2 &&
        (cf[0] !== 0 || cf[1] !== 0)
      ) {
        competeFightData.push({
          umaIndex,
          text: "Duel",
          color: posKeepColors[umaIndex],
          start: cf[0],
          end: cf[1],
          duration: cf[1] - cf[0],
        });
      }
    }

    // Process spot struggle (lead competition) data
    const leadCompetitionData: any[] = [];
    const leadComp = currentSnapshot.leadCompetition || [null, null];
    for (let umaIndex = 0; umaIndex < 2; umaIndex++) {
      const lc = leadComp[umaIndex];
      if (
        lc &&
        Array.isArray(lc) &&
        lc.length >= 2 &&
        (lc[0] !== 0 || lc[1] !== 0)
      ) {
        leadCompetitionData.push({
          umaIndex,
          text: "SS",
          color: posKeepColors[umaIndex],
          start: lc[0],
          end: lc[1],
          duration: lc[1] - lc[0],
        });
      }
    }

    // Process downhill activations
    const downhillData = (
      currentSnapshot.downhillActivations || [[], []]
    ).flatMap((downhillArray: [number, number][], umaIndex: number) => {
      if (!downhillArray) return [];
      return downhillArray.map((ar: number[]) => ({
        umaIndex,
        text: "DH",
        color: posKeepColors[umaIndex],
        start: ar[0],
        end: ar[1],
        duration: ar[1] - ar[0],
      }));
    });

    // Combine all labels
    const allLabels = [
      ...posKeepData,
      ...competeFightData,
      ...leadCompetitionData,
      ...downhillData,
    ];

    // Convert to positioned labels
    const tempLabels = allLabels.map((label) => ({
      ...label,
      x: (label.start / course.distance) * 960,
      width: (label.duration / course.distance) * 960,
      yOffset: 0,
    }));

    // Sort by x position
    tempLabels.sort((a, b) => a.x - b.x);

    // Calculate vertical offsets to avoid overlaps
    const posKeepLabelsFinal: any[] = [];
    for (let i = 0; i < tempLabels.length; i++) {
      const currentLabel = tempLabels[i];
      let maxYOffset = 40;

      for (let j = 0; j < i; j++) {
        const prevLabel = tempLabels[j];
        const overlap = !(
          currentLabel.x + currentLabel.width < prevLabel.x ||
          currentLabel.x > prevLabel.x + prevLabel.width
        );
        if (overlap) {
          maxYOffset = Math.max(maxYOffset, prevLabel.yOffset + 15);
        }
      }

      currentLabel.yOffset = maxYOffset;
      posKeepLabelsFinal.push(currentLabel);
    }

    return posKeepLabelsFinal;
  }, [currentSnapshot, courseId]);

  // Binary search helper for finding index at position
  const binSearch = useCallback((arr: number[], target: number) => {
    let lo = 0,
      hi = arr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, Math.min(lo, arr.length - 1));
  }, []);

  // Mouse move handler for velocity/HP readout
  const handleMouseMove = useCallback(
    (pct: number) => {
      const skillData = currentSnapshot;
      if (!skillData) return;

      const course = (courseData as any)[courseId];
      if (!course) return;

      const box = document.getElementById("rtMouseOverBox");
      if (box) box.style.display = "block";

      const x = pct * course.distance;
      const i0 = binSearch(skillData.p[0], x);
      const i1 = binSearch(skillData.p[1], x);

      const safeI0 = Math.max(0, Math.min(i0, skillData.v[0].length - 1));
      const safeI1 = Math.max(0, Math.min(i1, skillData.v[1].length - 1));

      const hp0 = skillData.hp?.[0]?.[safeI0]?.toFixed(0) ?? "N/A";
      const hp1 = skillData.hp?.[1]?.[safeI1]?.toFixed(0) ?? "N/A";

      const v1El = document.getElementById("rtV1");
      const v2El = document.getElementById("rtV2");
      if (v1El)
        v1El.textContent = `${skillData.v[0][safeI0].toFixed(2)} m/s  t=${skillData.t[0][safeI0].toFixed(2)}s  (${hp0} hp)`;
      if (v2El)
        v2El.textContent = `${skillData.v[1][safeI1].toFixed(2)} m/s  t=${skillData.t[1][safeI1].toFixed(2)}s  (${hp1} hp)`;
    },
    [currentSnapshot, courseId, binSearch],
  );

  const handleMouseLeave = useCallback(() => {
    const box = document.getElementById("rtMouseOverBox");
    if (box) box.style.display = "none";
  }, []);

  // Handle skill drag on race track to set forced positions
  const handleSkillDrag = useCallback(
    (skillId: string, umaIndex: number, newStart: number, _newEnd: number) => {
      const positionStr = newStart.toString();
      if (umaIndex === 0) {
        setUma1((prev) => ({
          ...prev,
          forcedSkillPositions: {
            ...prev.forcedSkillPositions,
            [skillId]: positionStr,
          },
        }));
      } else if (umaIndex === 1) {
        setUma2((prev) => ({
          ...prev,
          forcedSkillPositions: {
            ...prev.forcedSkillPositions,
            [skillId]: positionStr,
          },
        }));
      }
    },
    [],
  );

  // Wrap UmaState for RaceTrack compatibility (expects Immutable.js-style API)
  const wrapUmaForRaceTrack = useCallback(
    (uma: UmaState) => ({
      forcedSkillPositions: {
        has: (skillId: string) => skillId in uma.forcedSkillPositions,
        get: (skillId: string) => {
          const pos = uma.forcedSkillPositions[skillId];
          return pos ? parseInt(pos, 10) : undefined;
        },
      },
    }),
    [],
  );

  const uma1ForTrack = useMemo(
    () => wrapUmaForRaceTrack(uma1),
    [uma1, wrapUmaForRaceTrack],
  );
  const uma2ForTrack = useMemo(
    () => wrapUmaForRaceTrack(uma2),
    [uma2, wrapUmaForRaceTrack],
  );

  return (
    <Language.Provider value="en-global">
      <IntlProvider definition={STRINGS}>
          <div
            id="app-v2"
            class={`${darkMode ? "" : "light"} ${glassMode ? "glass" : ""} ${CC_DEV && yandereMode ? "yandere" : (colorPalette !== 'uma-green' ? colorPalette : '')} ${showNotification ? "v2-has-notification" : ""}`}
            style={{ "--ui-scale": uiScale / 100 } as any}
          >
            {showNotification && (
              <NotificationBanner onDismiss={dismissNotification}>
                Notice: Upcoming in-game maintenance period - <MaintenanceTime />.
              </NotificationBanner>
            )}

            {/* HEADER BAR - two rows via CSS grid: presets/track + mode/run/settings
                on top, race conditions and GlobalSim field controls below. */}
            <header class="v2-header">
              <div class="v2-header-left">
                <CustomSelect
                  value={selectedPresetId}
                  onChange={(val) => handlePresetSelect(val as number | null)}
                  options={[
                    { value: null, label: "Custom" },
                    // Dropdown is windowed to the current CM ± 5; any other CM
                    // is still loadable via ?preset=. If the active selection is
                    // outside the window (e.g. loaded from a URL), surface it too.
                    ...(selectedPresetId != null &&
                    !visiblePresets.some((p) => p.id === selectedPresetId)
                      ? presets
                          .filter((p) => p.id === selectedPresetId)
                          .map((p) => ({
                            value: p.id,
                            label: `CM ${p.id} - ${p.name}`,
                          }))
                      : []),
                    ...visiblePresets.map((p) => ({
                      value: p.id,
                      label: `CM ${p.id} - ${p.name}`,
                    })),
                  ]}
                  className="v2-preset-select"
                />
                <V2TrackSelect
                  courseid={courseId}
                  setCourseid={(id) => {
                    setSelectedPresetId(null);
                    setCourseId(id);
                  }}
                />
              </div>

              <div class="v2-header-center">
                <div class="v2-conditions">
                  <ConditionGroups
                    ground={ground}
                    setGround={(v) => {
                      setSelectedPresetId(null);
                      setGround(v);
                    }}
                    weather={weather}
                    setWeather={(v) => {
                      setSelectedPresetId(null);
                      setWeather(v);
                    }}
                    season={season}
                    setSeason={(v) => {
                      setSelectedPresetId(null);
                      setSeason(v);
                    }}
                    time={time}
                    setTime={(v) => {
                      setSelectedPresetId(null);
                      setTime(v);
                    }}
                  />
                </div>
              </div>

              <div class="v2-header-right">
                <div class="v2-mode-toggle">
                  <button
                    type="button"
                    class={mode === "compare" ? "active" : ""}
                    onClick={() => setMode("compare")}
                  >
                    <GitCompare size={14} />
                    Compare
                  </button>
                  <button
                    type="button"
                    class={mode === "skill" ? "active" : ""}
                    onClick={() => setMode("skill")}
                  >
                    <Zap size={14} />
                    Skill
                  </button>
                  <button
                    type="button"
                    class={mode === "optimizer" ? "active" : ""}
                    onClick={() => setMode("optimizer")}
                  >
                    <Wand2 size={14} />
                    Optimizer
                  </button>
                </div>
                <Button
                  variant="primary"
                  className="v2-run-btn"
                  icon={<Play size={14} />}
                  onClick={handleRunSimulation}
                  disabled={isRunning}
                >
                  {isRunning ? "Running..." : optimizerRunning ? (mode === "optimizer" ? "STOP" : "STOP OPTIMIZER") : "RUN"}
                </Button>
                <Dropdown
                  trigger={
                    <Button variant="secondary" className="v2-settings-btn">
                      <Settings size={16} />
                    </Button>
                  }
                  align="right"
                  items={[
                    {
                      id: "theme",
                      label: "",
                      custom: (
                        <div class="v2-theme-toggle">
                          <button
                            type="button"
                            class={`v2-theme-btn ${darkMode ? 'active' : ''}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setDarkMode(true);
                            }}
                          >
                            Dark
                          </button>
                          <button
                            type="button"
                            class={`v2-theme-btn ${!darkMode ? 'active' : ''}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setDarkMode(false);
                            }}
                          >
                            Light
                          </button>
                          {/* Glass is a separate axis, not a third mode: it layers on top of
                              whichever of Dark/Light is active, and on any accent. */}
                          <button
                            type="button"
                            class={`v2-theme-btn v2-theme-btn-glass ${glassMode ? 'active' : ''}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setGlassMode(!glassMode);
                            }}
                            title="Glassmorphic surfaces (works with Dark or Light)"
                          >
                            Glass
                          </button>
                        </div>
                      ),
                    },
                    {
                      id: "accent",
                      label: "",
                      custom: (
                        <div class="v2-color-toggle">
                          {COLOR_PALETTES.map((palette) => (
                            <button
                              key={palette}
                              type="button"
                              class={`v2-color-swatch ${palette} ${colorPalette === palette ? 'active' : ''}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                setColorPalette(palette);
                              }}
                              title={palette.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
                            />
                          ))}
                        </div>
                      ),
                    },
                    { id: "divider-scale", label: "", divider: true },
                    {
                      id: "zoom-control",
                      label: "",
                      custom: (
                        <div class="v2-zoom-control">
                          <button
                            type="button"
                            class="v2-zoom-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              setUiScale(Math.max(80, uiScale - 5));
                            }}
                            disabled={uiScale <= 80}
                          >
                            <Minus size={14} />
                          </button>
                          <span class="v2-zoom-value">{uiScale}%</span>
                          <button
                            type="button"
                            class="v2-zoom-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              setUiScale(Math.min(120, uiScale + 5));
                            }}
                            disabled={uiScale >= 120}
                          >
                            <Plus size={14} />
                          </button>
                        </div>
                      ),
                    },
                    { id: "divider-link", label: "", divider: true },
                    {
                      id: "copy-link",
                      label: "Copy Link",
                      icon: <Link size={16} />,
                      onClick: () => {
                        track("copy-link");
                        copyShareableUrl({
                          courseId,
                          ground,
                          weather,
                          season,
                          time,
                          samples,
                          uma1,
                          uma2,
                          // Only persist non-zero hint levels to keep the link compact.
                          skillHints: Object.fromEntries(
                            [...skillHints].filter(([, v]) => v > 0),
                          ),
                        });
                      },
                    },
                  ]}
                />
              </div>

              {/* Second header row: GlobalSim field + common sim params, with the
                  Advanced toggle on the right (threads / sim server / notices). */}
              <div class="v2-header-sub">
                <div class="v2-header-sub-left">
                  <GlobalsimFieldControls globalsimField={globalsimFieldConfig} />
                  <SimCommonControls
                    samples={samples}
                    setSamples={setSamples}
                    seed={seed}
                    setSeed={setSeed}
                    autoSeed={autoSeed}
                    setAutoSeed={setAutoSeed}
                    hideNotInGame={hideNotInGame}
                    setHideNotInGame={setHideNotInGame}
                  />
                </div>
                <button
                  type="button"
                  class={`v2-advanced-toggle ${advancedOpen ? "open" : ""}`}
                  onClick={() => setAdvancedOpen(!advancedOpen)}
                  aria-expanded={advancedOpen}
                >
                  {advancedOpen ? "Hide advanced" : "Advanced"}
                </button>
              </div>
            </header>

            {/* ADVANCED strip (collapsible) */}
            {advancedOpen && (
              <div class="v2-advanced-strip">
                <SimAdvancedControls
                  globalsimUncoveredCount={globalsimUncoveredCount}
                  threads={globalsimThreads}
                  setThreads={setGlobalsimThreads}
                  simServer={{
                    url: simServerUrl, setUrl: setSimServerUrl,
                    token: simServerToken, setToken: setSimServerToken,
                    online: simServerOnline, cores: simServerCores,
                    tokenRejected: simServerTokenRejected, access: simAccess,
                    check: () => { void checkSimServer({ gesture: true }); },
                    gpu: simServerGpuPlan,
                  }}
                  lastJob={lastSimJob}
                />
              </div>
            )}

            {/* Content area wrapper for widescreen layout */}
            <div class="v2-content-area">
              {/* MAIN CONTENT - RaceTrack takes center stage */}
              <main class="v2-main">
                {/* RaceTrack - Always visible (like v1) */}
                <div class="v2-track-container">
                  <RaceTrack
                    courseid={courseId}
                    width={960}
                    height={250}
                    xOffset={20}
                    yOffset={10}
                    yExtra={15}
                    mouseMove={handleMouseMove}
                    mouseLeave={handleMouseLeave}
                    onSkillDrag={handleSkillDrag}
                    regions={skillRegions}
                    posKeepLabels={posKeepLabels}
                    uma1={uma1ForTrack}
                    uma2={uma2ForTrack}
                  >
                    {/* Velocity overlay - use appropriate snapshot based on mode */}
                    {((mode === "compare" && currentSnapshot) || (mode === "skill" && skillChartSnapshot)) && (
                      <VelocityOverlay
                        data={mode === "skill" ? skillChartSnapshot : currentSnapshot}
                        courseDistance={
                          (courseData as any)[courseId]?.distance ?? 2000
                        }
                        width={960}
                        height={250}
                        xOffset={20}
                        showVelocity={showVelocityOverlay}
                        showHp={showHpOverlay}
                      />
                    )}

                    {/* Mouse-over readout box (same as v1) */}
                    <g id="rtMouseOverBox" class="v2-track-readout" style="display:none">
                      <text
                        id="rtV1"
                        x="25"
                        y="10"
                        fill="#4a9eff"
                        font-size="10px"
                      ></text>
                      <text
                        id="rtV2"
                        x="25"
                        y="20"
                        fill="#ff6b6b"
                        font-size="10px"
                      ></text>
                    </g>
                  </RaceTrack>

                  {/* Velocity toggle controls below track - show when there's data to display */}
                  {((mode === "compare" && results) || (mode === "skill" && skillChartSnapshot)) && (
                    <div class="v2-velocity-toggles">
                      <label class="v2-switch">
                        <input
                          type="checkbox"
                          checked={showVelocityOverlay}
                          onChange={(e) =>
                            setShowVelocityOverlay(
                              (e.target as HTMLInputElement).checked,
                            )
                          }
                        />
                        <span class="v2-switch-slider" />
                        <span class="v2-switch-label">Velocity</span>
                      </label>
                      <label class="v2-switch">
                        <input
                          type="checkbox"
                          checked={showHpOverlay}
                          onChange={(e) =>
                            setShowHpOverlay(
                              (e.target as HTMLInputElement).checked,
                            )
                          }
                        />
                        <span class="v2-switch-slider" />
                        <span class="v2-switch-label">HP</span>
                      </label>
                    </div>
                  )}
                </div>

                {/* Shared GlobalSim error surface: any runtime failure
                    (skills.json/courses.json/geometry/wasm fetch, adapter
                    buildErrors rejection, 'produced no results') lands here —
                    the compare/chart results pane would otherwise just sit at
                    its empty state with the error in the console only.
                    Dismissible; cleared by the next run or an engine switch. */}
                {globalsimError && (
                  <div
                    class="v2-globalsim-fail v2-globalsim-error"
                    role="alert"
                  >
                    <span>{globalsimError}</span>
                    <button
                      type="button"
                      class="v2-globalsim-error-dismiss"
                      aria-label="Dismiss error"
                      onClick={() => setGlobalsimError(null)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}

                {/* Mode-specific content below track */}
                {mode === "skill" ? (
                  <div class="v2-skill-chart-container">
                    {/* Filter controls */}
                    <div class="v2-skill-chart-controls">
                      <div class="v2-skill-chart-filters">
                        <label class="v2-switch">
                          <input
                            type="checkbox"
                            checked={hideOwned}
                            onChange={(e) =>
                              setHideOwned(
                                (e.target as HTMLInputElement).checked,
                              )
                            }
                          />
                          <span class="v2-switch-slider" />
                          <span class="v2-switch-label">Hide Owned</span>
                        </label>
                        <label class="v2-switch">
                          <input
                            type="checkbox"
                            checked={hidePurple}
                            onChange={(e) =>
                              setHidePurple(
                                (e.target as HTMLInputElement).checked,
                              )
                            }
                          />
                          <span class="v2-switch-slider" />
                          <span class="v2-switch-label">Hide Purple</span>
                        </label>
                        <label class="v2-switch">
                          <input
                            type="checkbox"
                            checked={showUmaIcons}
                            onChange={(e) =>
                              setShowUmaIcons(
                                (e.target as HTMLInputElement).checked,
                              )
                            }
                          />
                          <span class="v2-switch-slider" />
                          <span class="v2-switch-label">Uma Icons</span>
                        </label>
                        <label
                          class="v2-switch"
                          title="2x faster simulation with lower accuracy (50 samples vs 200)"
                        >
                          <input
                            type="checkbox"
                            checked={chartFastMode}
                            onChange={(e) =>
                              setChartFastMode(
                                (e.target as HTMLInputElement).checked,
                              )
                            }
                          />
                          <span class="v2-switch-slider" />
                          <span class="v2-switch-label">Fast ⚡</span>
                        </label>
                      </div>
                      <div class="v2-skill-chart-actions">
                        {skillHints.size > 0 && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setSkillHints(new Map())}
                          >
                            Reset Hints
                          </Button>
                        )}
                        {hiddenSkills.size > 0 && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setHiddenSkills(new Set())}
                          >
                            Show Hidden ({hiddenSkills.size})
                          </Button>
                        )}
                      </div>
                      {/* Progress indicator */}
                      {isRunning &&
                        Object.keys(skillChartProgress).length > 0 && (
                          <div class="v2-skill-chart-progress">
                            {Object.entries(skillChartProgress).map(
                              ([workerId, progress]) => (
                                <div key={workerId} class="v2-worker-progress">
                                  Worker {workerId}: Round {progress.round}/
                                  {progress.total}
                                </div>
                              ),
                            )}
                          </div>
                        )}
                    </div>

                    <PoolExclusionList
                      excluded={skillChartLateOut.length ? [...skillPool.out, ...skillChartLateOut] : skillPool.out}
                      included={chartIncluded}
                      onToggle={(id) =>
                        setChartIncluded((prev) => {
                          const next = new Set(prev);
                          if (next.has(id)) next.delete(id); else next.add(id);
                          return next;
                        })
                      }
                      focusOn={chartFocusOn}
                      onFocusChange={setChartFocusOn}
                      disabled={isRunning}
                      note="Changes apply on the next run."
                    />

                    {/* Skill chart table */}
                    {skillChartResults.size > 0 ? (
                      <SkillChartPane
                        data={Array.from(skillChartResults.values())}
                        courseDistance={
                          (courseData as any)[courseId]?.distance ?? 2000
                        }
                        hints={skillHints}
                        hasSkills={hasSkills}
                        updateHint={(id, hint) => {
                          setSkillHints((prev) => withHintLevel(prev, id, hint));
                        }}
                        onRunTypeChange={setChartRunType}
                        onSelectionChange={setSelectedSkillForChart}
                        onInfoClick={handleShowSkillInfo}
                        onDblClickRow={handleAddSkillFromChart}
                        expandedContent={(
                          skillId,
                          runData,
                          courseDistance,
                          sampleCount,
                        ) => (
                          <SkillChartDetail
                            skillId={skillId}
                            runData={runData}
                            courseDistance={courseDistance}
                            umaIndex={1}
                            sampleCount={sampleCount}
                          />
                        )}
                        showUmaIcons={showUmaIcons}
                        hideOwned={hideOwned}
                        hidePurple={hidePurple}
                        hideNotInGame={hideNotInGame}
                        globalsimSkillIds={globalsimSkillIds}
                        dirty={false}
                        selectedSkillId={selectedSkillForChart}
                        hiddenSkills={hiddenSkills}
                        onHideSkill={(id) => setHiddenSkills(prev => {
                          const next = new Set(prev);
                          next.add(id);
                          return next;
                        })}
                      />
                    ) : (
                      <div class="v2-skill-chart-empty">
                        {isRunning ? (
                          <div>
                            <Zap size={48} />
                            <h2>Running Skill Chart...</h2>
                            <p>
                              Testing skills across{" "}
                              {Object.keys(skillChartProgress).length} workers
                            </p>
                          </div>
                        ) : (
                          <div>
                            <Zap size={48} />
                            <h2>Skill Chart Mode</h2>
                            <p>
                              Click RUN to test all skills on the selected
                              course
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : mode !== "optimizer" ? (
                  /* RESULTS - Compare mode */
                  <V2ResultsPane
                    results={results}
                    isRunning={isRunning}
                    courseId={courseId}
                    onRunSimulation={handleRunSimulation}
                    displayRun={displayRun}
                    onDisplayRunChange={setDisplayRun}
                  />
                ) : null}

                {/* RESULTS - Skill Optimizer mode (GlobalSim engine). Mounted
                    from the first visit on and only hidden in the other modes:
                    its results and pool settings live in its own state, so
                    "Open in Compare" (a mode switch) must not unmount it. */}
                {optimizerVisited.current && (
                  <div style={{ display: mode === "optimizer" ? "contents" : "none" }}>
                  <OptimizerPane
                    workerFactory={globalsimWorkerFactory}
                    cpuFactory={globalsimWorkerFactory}
                    uma={uma1}
                    candidates={skillPool.kept}
                    excluded={skillPool.out}
                    skillData={globalsimSkillTable}
                    course={courseData[courseId]}
                    courseId={courseId}
                    conditions={{ ground, weather, season, time }}
                    onStrategyChange={(style) => handleUma1Change({ strategy: style as UmaState["strategy"] })}
                    mobPreset={
                      (mobPresets as any)[globalsimFieldPreset] ??
                      (mobPresets as any)["default"]
                    }
                    fixedGate={globalsimGate === "auto" ? undefined : globalsimGate}
                    ownedByGroup={hasSkills}
                    hints={skillHints}
                    seed={seed}
                    onSeedChange={setSeed}
                    onOpenInCompare={handleOpenInCompare}
                    onImportCareer={handleImportCareer}
                    onHintChange={(id, hint) => {
                      setSkillHints((prev) => withHintLevel(prev, id, hint));
                    }}
                    onResetHints={() => setSkillHints(new Map())}
                    controlRef={optimizerControl}
                    onRunningChange={setOptimizerRunning}
                  />
                  </div>
                )}
              </main>

              {/* UMA DRAWER - Slides in from left */}
              <aside class={`v2-uma-drawer ${umaDrawerOpen ? "open" : ""}`}>
                {/* Toggle tab attached to drawer edge */}
                <button
                  class="v2-uma-toggle"
                  onClick={() => setUmaDrawerOpen(!umaDrawerOpen)}
                >
                  ▶ Uma
                </button>

                <div class="v2-drawer-header">
                  <h2>Configure Uma</h2>
                  <button
                    onClick={() => {
                      setUmaDrawerOpen(false);
                      setMobileView("track");
                    }}
                  >
                    <X size={16} />
                  </button>
                </div>

                {/* Uma tabs */}
                <div class="v2-uma-tabs">
                  <button
                    type="button"
                    class={activeUmaTab === 1 ? "active" : ""}
                    onClick={() => setActiveUmaTab(1)}
                  >
                    Uma 1
                  </button>
                  {mode === "compare" && (
                    <>
                      <Tooltip content="Swap Uma 1 and Uma 2" position="bottom">
                        <button
                          type="button"
                          class="v2-uma-swap"
                          onClick={handleSwapUmas}
                        >
                          <ArrowLeftRight size={14} />
                        </button>
                      </Tooltip>
                      <button
                        type="button"
                        class={activeUmaTab === 2 ? "active" : ""}
                        onClick={() => setActiveUmaTab(2)}
                      >
                        Uma 2
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    class={`v2-uma-tab-trainees ${activeUmaTab === "trainees" ? "active" : ""}`}
                    onClick={() => setActiveUmaTab("trainees")}
                  >
                    <Users size={14} />
                    Saved
                  </button>
                  <button
                    type="button"
                    class={`v2-uma-tab-umas ${activeUmaTab === "umas" ? "active" : ""}`}
                    onClick={() => setActiveUmaTab("umas")}
                  >
                    <LayoutGrid size={14} />
                    Umas
                  </button>
                </div>

                <div class="v2-drawer-content">
                  {globalsimDropped > 0 && (
                    <div class="v2-globalsim-note v2-globalsim-note-dismissible">
                      <span>
                        Dropped {globalsimDropped} uncovered skill
                        {globalsimDropped === 1 ? "" : "s"} on import (not yet
                        supported by GlobalSim)
                      </span>
                      <button
                        type="button"
                        class="v2-globalsim-error-dismiss"
                        aria-label="Dismiss note"
                        onClick={() => setGlobalsimDropped(0)}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )}
                  {activeUmaTab === 1 && (
                    <V2UmaPanel
                      state={uma1}
                      onChange={handleUma1Change}
                      onLoad={handleUma1Load}
                      onReset={handleUma1Reset}
                      onResetAll={handleResetAll}
                      title={mode === "compare" ? "Umamusume 1" : "Umamusume"}
                      courseDistance={
                        (courseData as Record<string, { distance: number }>)[
                          courseId
                        ]?.distance
                      }
                      hideNotInGame={hideNotInGame}
                      wideSkills={wideSkills}
                      setWideSkills={setWideSkills}
                      globalsimSkillIds={globalsimSkillIds}
                    />
                  )}
                  {mode === "compare" && activeUmaTab === 2 && (
                    <V2UmaPanel
                      state={uma2}
                      onChange={handleUma2Change}
                      onLoad={handleUma2Load}
                      onReset={handleUma2Reset}
                      onResetAll={handleResetAll}
                      title="Umamusume 2"
                      courseDistance={
                        (courseData as Record<string, { distance: number }>)[
                          courseId
                        ]?.distance
                      }
                      hideNotInGame={hideNotInGame}
                      wideSkills={wideSkills}
                      setWideSkills={setWideSkills}
                      globalsimSkillIds={globalsimSkillIds}
                    />
                  )}
                  {activeUmaTab === "trainees" && (
                    <TraineesTab
                      onLoadToUma1={handleUma1Load}
                      onLoadToUma2={handleUma2Load}
                      currentMode={mode as "compare" | "skill" | "optimizer"}
                      currentUma1={uma1}
                      currentUma2={uma2}
                    />
                  )}
                  {activeUmaTab === "umas" && (
                    <UmasTab
                      state={umasState}
                      onStateChange={setUmasState}
                      onLoadToUma1={(s) => { handleUma1Load(s); setActiveUmaTab(1); }}
                      onLoadToUma2={(s) => { handleUma2Load(s); setActiveUmaTab(2); }}
                      currentMode={mode as "compare" | "skill" | "optimizer"}
                      course={courseData[courseId]}
                    />
                  )}
                </div>
              </aside>
            </div>
            {/* End v2-content-area */}

            {/* RACE SUMMARY DRAWER - Slides in from right */}
            <aside
              class={`v2-summary-drawer ${summaryDrawerOpen ? "open" : ""}`}
            >
              {/* Toggle tab attached to drawer edge */}
              <button
                class="v2-summary-toggle"
                onClick={() => setSummaryDrawerOpen(!summaryDrawerOpen)}
              >
                Timeline ◀
              </button>

              <div class="v2-drawer-header">
                <h2>Race Summary</h2>
                <button
                  onClick={() => {
                    setSummaryDrawerOpen(false);
                    setMobileView("track");
                  }}
                >
                  <X size={16} />
                </button>
              </div>

              <div class="v2-drawer-content">
                {results?.runData?.medianrun ? (
                  <RaceSummary
                    medianrun={results.runData.medianrun}
                    courseDistance={
                      (courseData as any)[courseId]?.distance ?? 2000
                    }
                    skillnames={skillnames}
                    result={calcStats(results.results).median}
                  />
                ) : (
                  <p
                    style={{
                      color: "var(--color-text-muted)",
                      textAlign: "center",
                      padding: "var(--space-lg)",
                    }}
                  >
                    Run a simulation to see the race timeline
                  </p>
                )}
              </div>
            </aside>

            {/* FOOTER */}
            <footer class="v2-footer">
              <details>
                <summary>About and credits</summary>
                <p>
                  Yet Another Umalator is licensed under{" "}
                <a
                  href="https://www.gnu.org/licenses/gpl-3.0.html"
                  target="_blank"
                  rel="noopener"
                >
                  GPL-3.0
                </a>
                .&nbsp; Credit to the original authors:&nbsp;
                <a
                  href="https://github.com/alpha123/uma-tools"
                  target="_blank"
                  rel="noopener"
                >
                  pecan (alpha123)
                </a>
                ,&nbsp;
                <a
                  href="https://github.com/kachi-dev/uma-tools"
                  target="_blank"
                  rel="noopener"
                >
                  the VFalator team (esp. kachi and Jecht)
                </a>
                ,&nbsp;and special thanks to the community at &nbsp;
                <a
                  href="https://discord.gg/moomoocows"
                  target="_blank"
                  rel="noopener"
                >
                  MooMooCord
                </a>
                .
              </p>
              <div class="v2-footer-links">
                <a
                  href="https://github.com/John-UNOwen/Yet-Another-Umalator-Fork"
                  target="_blank"
                  rel="noopener"
                >
                  GitHub
                </a>
                &nbsp;|&nbsp;
                <a
                  href="https://github.com/John-UNOwen/Yet-Another-Umalator-Fork/issues"
                  target="_blank"
                  rel="noopener"
                >
                  Feedback
                </a>
                &nbsp;|&nbsp;
                <a
                  href="https://github.com/daftuyda/GlobalSim"
                  target="_blank"
                  rel="noopener"
                >
                  GlobalSim engine
                </a>
              </div>
              </details>
            </footer>

            {/* Backdrop when drawer is open */}
            {umaDrawerOpen && (
              <div
                class="v2-backdrop"
                onClick={() => {
                  setUmaDrawerOpen(false);
                  setMobileView("track");
                }}
              />
            )}

            {/* Skill info popover */}
            {popoverSkillId && skillChartResults.has(popoverSkillId) && (
              <div
                class="v2-skill-popover"
                onClick={(e) => e.stopPropagation()}
              >
                <div class="v2-skill-popover-header">
                  <img
                    src={`${BASE_PATH}/icons/${skillmeta[popoverSkillId]?.iconId || popoverSkillId}.png`}
                    alt=""
                    class="v2-skill-popover-icon"
                  />
                  <span class="v2-skill-popover-name">
                    {skillDisplayName(popoverSkillId)}
                  </span>
                  <button
                    type="button"
                    class="v2-skill-popover-close"
                    onClick={() => setPopoverSkillId(null)}
                  >
                    <X size={16} />
                  </button>
                </div>
                <div class="v2-skill-popover-stats">
                  <span>
                    Median:{" "}
                    {skillChartResults.get(popoverSkillId)?.median.toFixed(2)}L
                  </span>
                  <span>
                    Mean:{" "}
                    {skillChartResults.get(popoverSkillId)?.mean.toFixed(2)}L
                  </span>
                  <span>
                    Range:{" "}
                    {skillChartResults.get(popoverSkillId)?.min.toFixed(2)} ~{" "}
                    {skillChartResults.get(popoverSkillId)?.max.toFixed(2)}L
                  </span>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    handleAddSkillFromChart(popoverSkillId);
                    setPopoverSkillId(null);
                  }}
                >
                  Add to Uma 1
                </Button>
              </div>
            )}

            {/* Feedback drawer (gated by VITE_ENABLE_FEEDBACK + webhook presence) */}
            {FEEDBACK_ENABLED && (
              <Fragment>
                <FeedbackDrawer
                  isOpen={feedbackDrawerOpen}
                  onClose={() => {
                    setFeedbackDrawerOpen(false);
                    setMobileView("track");
                  }}
                  webhookUrl={DISCORD_FEEDBACK_WEBHOOK}
                />
                {!feedbackDrawerOpen && (
                  <button
                    type="button"
                    class="v2-feedback-toggle"
                    onClick={() => setFeedbackDrawerOpen(true)}
                    aria-label="Send feedback"
                  >
                    <MessageSquare size={18} />
                    <span>Feedback</span>
                  </button>
                )}
              </Fragment>
            )}

            {/* Mobile bottom navigation */}
            <MobileNav
              activeView={mobileView}
              onViewChange={handleMobileViewChange}
              onRun={handleRunSimulation}
              isRunning={isRunning}
              runLabel={optimizerRunning ? (mode === "optimizer" ? "STOP" : "STOP OPTIMIZER") : undefined}
              hasResults={!!results}
            />

            {/* Mobile settings panel */}
            {mobileSettingsOpen && (
              <>
                <div
                  class="v2-backdrop v2-mobile-backdrop"
                  onClick={() => {
                    setMobileSettingsOpen(false);
                    setMobileView("track");
                  }}
                />
                <div class="v2-mobile-settings open">
                  <div class="v2-mobile-settings-header">
                    <h3>Settings</h3>
                    <button
                      type="button"
                      onClick={() => {
                        setMobileSettingsOpen(false);
                        setMobileView("track");
                      }}
                    >
                      <X size={16} />
                    </button>
                  </div>
                  <div class="v2-mobile-settings-content">
                    <div class="v2-mobile-settings-section">
                      <h4>Track & Course</h4>
                      <V2TrackSelect
                        courseid={courseId}
                        setCourseid={(id) => {
                          setSelectedPresetId(null);
                          setCourseId(id);
                        }}
                      />
                    </div>
                    <div class="v2-mobile-settings-section">
                      <h4>Mode</h4>
                      <div class="v2-mode-toggle" style={{ display: "flex" }}>
                        <button
                          type="button"
                          class={mode === "compare" ? "active" : ""}
                          onClick={() => setMode("compare")}
                        >
                          <GitCompare size={14} />
                          Compare
                        </button>
                        <button
                          type="button"
                          class={mode === "skill" ? "active" : ""}
                          onClick={() => setMode("skill")}
                        >
                          <Zap size={14} />
                          Skill
                        </button>
                        <button
                          type="button"
                          class={mode === "optimizer" ? "active" : ""}
                          onClick={() => setMode("optimizer")}
                        >
                          <Wand2 size={14} />
                          Optimizer
                        </button>
                      </div>
                    </div>
                    <div class="v2-mobile-settings-section">
                      <h4>Race Conditions</h4>
                      <CompactConditions
                        ground={ground}
                        setGround={(v) => {
                          setSelectedPresetId(null);
                          setGround(v);
                        }}
                        weather={weather}
                        setWeather={(v) => {
                          setSelectedPresetId(null);
                          setWeather(v);
                        }}
                        season={season}
                        setSeason={(v) => {
                          setSelectedPresetId(null);
                          setSeason(v);
                        }}
                        time={time}
                        setTime={(v) => {
                          setSelectedPresetId(null);
                          setTime(v);
                        }}
                        globalsimField={globalsimFieldConfig}
                      />
                    </div>
                    <div class="v2-mobile-settings-section">
                      <h4>Simulation</h4>
                      <SimulationSettings
                        samples={samples}
                        setSamples={setSamples}
                        seed={seed}
                        setSeed={setSeed}
                        autoSeed={autoSeed}
                        setAutoSeed={setAutoSeed}
                        hideNotInGame={hideNotInGame}
                        setHideNotInGame={setHideNotInGame}
                        globalsimUncoveredCount={globalsimUncoveredCount}
                        threads={globalsimThreads}
                        setThreads={setGlobalsimThreads}
                      />
                    </div>
                    <div class="v2-mobile-settings-section">
                      <h4>Appearance</h4>
                      <div class="v2-mobile-settings-row">
                        <label>{darkMode ? "Dark Mode" : "Light Mode"}</label>
                        <label class="v2-switch">
                          <input
                            type="checkbox"
                            checked={darkMode}
                            onChange={() => setDarkMode(!darkMode)}
                          />
                          <span class="v2-switch-slider" />
                        </label>
                      </div>
                      <div class="v2-mobile-settings-row">
                        <label>Glass</label>
                        <label class="v2-switch">
                          <input
                            type="checkbox"
                            checked={glassMode}
                            onChange={() => setGlassMode(!glassMode)}
                          />
                          <span class="v2-switch-slider" />
                        </label>
                      </div>
                      <div class="v2-mobile-settings-row v2-mobile-color-row">
                        <label>Color</label>
                        <div class="v2-color-toggle">
                          {COLOR_PALETTES.map((palette) => (
                            <button
                              key={palette}
                              type="button"
                              class={`v2-color-swatch ${palette} ${colorPalette === palette ? 'active' : ''}`}
                              onClick={() => setColorPalette(palette)}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                    {FEEDBACK_ENABLED && (
                      <div class="v2-mobile-settings-section">
                        <h4>Actions</h4>
                        <Button
                          variant="secondary"
                          className="v2-mobile-settings-btn"
                          onClick={() => setFeedbackDrawerOpen(true)}
                          icon={<MessageSquare size={14} />}
                        >
                          Send Feedback
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </IntlProvider>
    </Language.Provider>
  );
}

render(<App />, document.getElementById("app")!);
initAnalytics();

