/**
 * Type definitions for Skill Chart mode
 *
 * Skill Chart tests individual skills on a base uma to calculate
 * efficiency metrics (min/max/mean/median bashin gain, SP cost, L/SP ratio)
 */

import type { RaceSnapshot } from './results-pane';

/**
 * Additive GlobalSim block on a chart row (Phase 5). Present only on rows
 * produced by engines/globalsim/chart.ts; classic rows never have it, so the
 * classic table renders exactly as before. Sign convention matches compare
 * metrics: min/max/mean/median are margin lengths, positive = the skill helps.
 */
export interface SkillChartGlobalsim {
  /** Paired seeds with a margin so far (streams up during the run). */
  n: number;
  /** 95% CI on the mean margin, lengths. [NaN, NaN] before the first pair. */
  ci95: [number, number];
  /** Share of paired seeds where margin > 0 / < 0 / === 0 (fractions of n). */
  winRate: number;
  lossRate: number;
  tieRate: number;
  /** Player activations of the TESTED skill per sampled seed (mean; rate = share of seeds with ≥1). */
  activationMean?: number;
  activationRate?: number;
  /** Per-seed engine errors counted into this row. */
  seedErrors: number;
  /** 1 = round-1-only sample, 2 = refilled through round 2 (sampleCount differs). */
  round: number;
}

/**
 * Single skill test result
 */
export interface SkillChartResult {
  id: string;
  min: number;
  max: number;
  mean: number;
  median: number;
  results: number[];  // Sorted bashin differences
  /** Samples behind min/max/mean/median (classic rows set it too, untyped). */
  sampleCount?: number;
  /** GlobalSim engine rows only — see SkillChartGlobalsim. */
  globalsim?: SkillChartGlobalsim;
  runData: {
    minrun: RaceSnapshot;
    maxrun: RaceSnapshot;
    meanrun: RaceSnapshot;
    medianrun: RaceSnapshot;
    allruns: {
      sk: [Map<string, number[][]>, Map<string, number[][]>];
      skBasinn: [Map<string, [number, number][]>, Map<string, [number, number][]>];
      totalRuns: number;
    };
  };
}

/**
 * Aggregated chart results for all skills
 */
export interface SkillChartResults {
  skills: Map<string, SkillChartResult>;
  progress: {
    round: number;
    total: number;
    skillsProcessed: number;
    skillsTotal: number;
  };
}

/**
 * Worker message types for skill chart mode
 */
export type ChartWorkerMessage =
  | { msg: 'chart', data: ChartRequestData }
  | { msg: 'chart-cancel' };

export type ChartWorkerResponse =
  | { type: 'chart-progress', workerId: number, round: number, total: number }
  | { type: 'chart-update', workerId: number, results: Map<string, SkillChartResult> }
  | { type: 'chart-complete', workerId: number };

export interface ChartRequestData {
  skills: string[];
  course: any;  // CourseData
  racedef: any;  // RaceParameters
  uma: any;  // Serialized HorseState
  pacer: any | null;
  options: {
    seed: number;
    posKeepMode: number;  // PosKeepMode.Approximate
    skillWisdomCheck: false;
    rushedKakari: false;
    mode: 'chart';
  };
  /** Fast mode: 50 samples per skill, no filtering. 2x faster but lower accuracy. */
  fastMode?: boolean;
}

/**
 * Progress tracking for worker pool
 */
export interface WorkerProgress {
  [workerId: number]: {
    round: number;
    total: number;
  };
}

/**
 * Skill chart filters
 */
export interface SkillChartFilters {
  hideOwned: boolean;
  hidePurple: boolean;
  showUmaIcons: boolean;
}
