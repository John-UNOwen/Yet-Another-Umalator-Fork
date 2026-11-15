/**
 * Simulation Settings Bar
 * Compact inline controls for simulation parameters
 *
 * Copyright (c) 2026 TheCing (https://github.com/TheCing/uma-tools)
 * Licensed under GPL-3.0-or-later
 */

import { h } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { Shuffle, Dices, Settings2, RotateCcw } from 'lucide-react';
import { Tooltip } from './components';
import type { SimEngine } from './storage';
import type { DuelingRates } from './simulation-utils';

const DEFAULT_DUELING_RATES: DuelingRates = {
	runaway: 10, frontRunner: 20, paceChaser: 30, lateSurger: 35, endCloser: 35,
};

// Front Runner (Nige) and Runaway (Oonige) are both early-returned by the
// solver's dueling check, so we don't render rows for them.
const STRATEGY_ROWS: Array<{ key: keyof DuelingRates; label: string; sub?: string }> = [
	{ key: 'runaway',     label: 'Runaway',      sub: 'Oonige' },
	{ key: 'frontRunner', label: 'Front Runner', sub: 'Nige' },
	{ key: 'paceChaser',  label: 'Pace Chaser',  sub: 'Senkou' },
	{ key: 'lateSurger',  label: 'Late Surger',  sub: 'Sashi' },
	{ key: 'endCloser',   label: 'End Closer',   sub: 'Oikomi' },
];

// Canonical SimEngine lives in storage.ts (engine-choice helpers + URL hash).
// 'globalsim' = the wasm full-field pipeline (compare = Phase 4, chart =
// Phase 5); Phase 7 disables the classic-only switches in GlobalSim mode —
// but only for the modes the wasm engine actually runs (Compare / Skill
// chart); Stamina always runs classic v2, so the switches stay live there.
export type { SimEngine };

interface SimSettingsProps {
	engine: SimEngine;
	setEngine: (v: SimEngine) => void;
	samples: number;
	setSamples: (v: number) => void;
	seed: number;
	setSeed: (v: number) => void;
	syncRng: boolean;
	setSyncRng: (v: boolean) => void;
	skillWisdomCheck: boolean;
	setSkillWisdomCheck: (v: boolean) => void;
	rushedKakari: boolean;
	setRushedKakari: (v: boolean) => void;
	leadCompetition: boolean;
	setLeadCompetition: (v: boolean) => void;
	competeFight: boolean;
	setCompeteFight: (v: boolean) => void;
	duelingRates: DuelingRates;
	setDuelingRates: (v: DuelingRates) => void;
	laneMovement: boolean;
	setLaneMovement: (v: boolean) => void;
	autoSeed: boolean;
	setAutoSeed: (v: boolean) => void;
	hideNotInGame: boolean;
	setHideNotInGame: (v: boolean) => void;
	/** Count of uma-tools skills missing from the active GlobalSim table (GlobalSim mode notice). */
	globalsimUncoveredCount?: number | null;
	/** GlobalSim worker count ('auto' = cores − 1, capped at 6; explicit 1..16; persisted by pool.ts). */
	threads?: 'auto' | number;
	setThreads?: (v: 'auto' | number) => void;
	/** Local sim server (CPU offload) — only rendered in GlobalSim mode. */
	simServer?: {
		url: string;
		setUrl: (v: string) => void;
		token: string;
		setToken: (v: string) => void;
		online: boolean;
		cores?: number;
		tokenNeeded: boolean;
		check: () => void;
	};
	mode?: string;
}

export function SimulationSettings({
	engine,
	setEngine,
	samples,
	setSamples,
	seed,
	setSeed,
	syncRng,
	setSyncRng,
	skillWisdomCheck,
	setSkillWisdomCheck,
	rushedKakari,
	setRushedKakari,
	leadCompetition,
	setLeadCompetition,
	competeFight,
	setCompeteFight,
	duelingRates,
	setDuelingRates,
	laneMovement,
	setLaneMovement,
	autoSeed,
	setAutoSeed,
	hideNotInGame,
	setHideNotInGame,
	globalsimUncoveredCount,
	threads,
	setThreads,
	simServer,
	mode,
}: SimSettingsProps) {
	// Dueling rates popover
	const [ratesOpen, setRatesOpen] = useState(false);
	const ratesTriggerRef = useRef<HTMLButtonElement>(null);
	const ratesMenuRef = useRef<HTMLDivElement>(null);
	const [ratesPos, setRatesPos] = useState<{ top: number; left: number } | null>(null);

	useEffect(() => {
		if (!ratesOpen || !ratesTriggerRef.current) return;
		const rect = ratesTriggerRef.current.getBoundingClientRect();
		setRatesPos({ top: rect.bottom + 6, left: rect.left });
	}, [ratesOpen]);

	useEffect(() => {
		if (!ratesOpen) return;
		const close = (e: Event) => {
			const t = e.target as Node;
			if (ratesMenuRef.current?.contains(t)) return;
			if (ratesTriggerRef.current?.contains(t)) return;
			setRatesOpen(false);
		};
		document.addEventListener('pointerdown', close);
		const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setRatesOpen(false); };
		document.addEventListener('keydown', esc);
		return () => {
			document.removeEventListener('pointerdown', close);
			document.removeEventListener('keydown', esc);
		};
	}, [ratesOpen]);

	const updateRate = (key: keyof DuelingRates, value: number) => {
		const v = Math.max(0, Math.min(100, Math.round(value)));
		setDuelingRates({ ...duelingRates, [key]: v });
	};

	// Which pipeline the selected engine actually drives depends on the mode:
	// the wasm engine owns only Compare and the Skill chart. Stamina has no
	// GlobalSim path — it always posts a classic hpcalc carrying the live
	// switch values (app-v2.tsx hpcalc branch, which maps engine to 'v2'),
	// so in Stamina mode GlobalSim must NOT disable switches the run reads.
	const globalsimDisabled = engine === 'globalsim' && mode !== 'stamina';
	// v2-only mechanics are consumed by any run that dispatches classic v2 —
	// including Stamina under 'globalsim', whose options force engine 'v2'.
	const classicV2 = engine === 'v2' || (engine === 'globalsim' && mode === 'stamina');

	const handleSamplesChange = (e: Event) => {
		const val = parseInt((e.target as HTMLInputElement).value) || 500;
		setSamples(Math.max(1, Math.min(10000, val)));
	};

	const handleSeedChange = (e: Event) => {
		const val = parseInt((e.target as HTMLInputElement).value) || 0;
		setSeed(val);
	};

	const randomizeSeed = () => {
		setSeed(Math.floor(Math.random() * 0xFFFFFFFF));
	};

	return (
		<div class="v2-sim-settings">
			<div class="v2-sim-settings-group">
				<label class="v2-sim-label">
					Samples
					<input
						type="number"
						class="v2-sim-input"
						value={samples}
						onInput={handleSamplesChange}
						min={1}
						max={10000}
					/>
				</label>
			</div>

			<div class="v2-sim-settings-group">
				<label class="v2-sim-label">
					Seed
					<div class="v2-sim-seed-row">
						<input
							type="number"
							class="v2-sim-input v2-sim-seed-input"
							value={seed}
							onInput={handleSeedChange}
						/>
						<Tooltip content="Randomize seed" position="bottom">
							<button
								type="button"
								class="v2-sim-seed-btn"
								onClick={randomizeSeed}
							>
								<Shuffle size={14} />
							</button>
						</Tooltip>
						<Tooltip content="Auto-reroll seed on every run" position="bottom">
							<button
								type="button"
								class={`v2-sim-seed-btn ${autoSeed ? 'active' : ''}`}
								onClick={() => setAutoSeed(!autoSeed)}
							>
								<Dices size={14} />
							</button>
						</Tooltip>
					</div>
				</label>
			</div>

			<div class="v2-sim-divider" />

			<div class="v2-sim-toggles">
				{/* Switch audit — a switch is DISABLED (not hidden) only when the
				    run it would steer ignores its value: under engine === 'globalsim'
				    the wasm pipeline (engines/globalsim/) consumes NONE of the
				    switches below in Compare / Skill modes, so they disable with
				    'Not used by GlobalSim'. Stamina mode is the exception: it has
				    no GlobalSim path and always runs classic v2 hpcalc with these
				    switches' live values (app-v2.tsx hpcalc branch), so in Stamina
				    mode they stay enabled — disabling a switch the run reads would
				    only misreport its effect. (Wit Check is separately honest in
				    Stamina mode: forced ON there, hence disabled with its own tooltip.) */}
				<Tooltip content={globalsimDisabled ? 'Not used by GlobalSim' : 'Use same RNG sequence for both Uma'} position="bottom">
					<label class="v2-switch">
						<input
							type="checkbox"
							checked={syncRng}
							onChange={() => setSyncRng(!syncRng)}
							disabled={globalsimDisabled}
						/>
						<span class="v2-switch-slider" />
						<span class="v2-switch-label">Sync RNG</span>
					</label>
				</Tooltip>

				{/* Engine v1 is alpha123's published solver, vendored verbatim (see
				    tools/sync-upstream-engine.mjs); v2 is ours. Rush, dueling, lead competition
				    and lane movement exist only in v2, so they disable under v1 rather than
				    silently doing nothing. GlobalSim (beta) (integration plan Phases 2b–5)
				    runs Compare and the skill chart on the wasm full-field engine, gates
				    skills and outfits to the GlobalSim skill table, and — since Phase 7 —
				    disables every classic-only switch it ignores in Compare / Skill modes
				    ('Not used by GlobalSim'); in Stamina mode the switches stay live (see
				    the audit note above). */}
				<Tooltip content="v2 is our engine. v1 is alpha123's upstream engine — fewer mechanics, useful as a reference point. GlobalSim (beta) runs Compare and the skill chart on the GlobalSim full-field wasm engine, and gates skills and outfits to the GlobalSim skill table." position="bottom">
					<span class="v2-sim-label">
						Engine
						<span class="v2-engine-toggle" role="group" aria-label="Simulation engine">
							<button type="button" class={engine === 'v1' ? 'active' : ''} onClick={() => setEngine('v1')}>v1</button>
							<button type="button" class={engine === 'v2' ? 'active' : ''} onClick={() => setEngine('v2')}>v2</button>
							<button type="button" class={engine === 'globalsim' ? 'active' : ''} onClick={() => setEngine('globalsim')}>GlobalSim (beta)</button>
						</span>
					</span>
				</Tooltip>

				{/* Wit Check reaches only the classic solver's option. GlobalSim
				    applies the wisdomCheck field of its own skill table inside
				    the engine — no user switch exists for it there. */}
				<Tooltip content={mode === "stamina" ? "Always enabled in Stamina mode" : globalsimDisabled ? 'Not used by GlobalSim' : "Skills check wisdom for activation"} position="bottom">
					<label class="v2-switch">
						<input
							type="checkbox"
							checked={skillWisdomCheck}
							onChange={() => setSkillWisdomCheck(!skillWisdomCheck)}
							disabled={mode === "stamina" || globalsimDisabled}
						/>
						<span class="v2-switch-slider" />
						<span class="v2-switch-label">Wit Check</span>
					</label>
				</Tooltip>

				<Tooltip content={globalsimDisabled ? 'Not used by GlobalSim' : "Enable random rushing/kakari behavior"} position="bottom">
					<label class="v2-switch">
						<input
							type="checkbox"
							checked={rushedKakari && classicV2}
							onChange={() => setRushedKakari(!rushedKakari)}
							disabled={!classicV2}
						/>
						<span class="v2-switch-slider" />
						<span class="v2-switch-label">Rush/Kakari</span>
					</label>
				</Tooltip>

				<Tooltip content={globalsimDisabled ? 'Not used by GlobalSim' : "Enable spot struggle (position fighting)"} position="bottom">
					<label class="v2-switch">
						<input
							type="checkbox"
							checked={leadCompetition && classicV2}
							onChange={() => setLeadCompetition(!leadCompetition)}
							disabled={!classicV2}
						/>
						<span class="v2-switch-slider" />
						<span class="v2-switch-label">Spot Struggle</span>
					</label>
				</Tooltip>

				<div class="v2-dueling-control">
					<Tooltip content={globalsimDisabled ? 'Not used by GlobalSim' : "Enable dueling behavior"} position="bottom">
						<label class="v2-switch">
							<input
								type="checkbox"
								checked={competeFight && classicV2}
								onChange={() => setCompeteFight(!competeFight)}
								disabled={!classicV2}
							/>
							<span class="v2-switch-slider" />
							<span class="v2-switch-label">Dueling</span>
						</label>
					</Tooltip>
					<Tooltip content={globalsimDisabled ? 'Not used by GlobalSim' : "Edit per-strategy dueling rates"} position="bottom">
						<button
							ref={ratesTriggerRef}
							type="button"
							class={`v2-dueling-rates-btn ${ratesOpen ? 'open' : ''}`}
							disabled={!competeFight || !classicV2}
							onClick={() => setRatesOpen(o => !o)}
							aria-label="Edit dueling rates"
							aria-expanded={ratesOpen}
						>
							<Settings2 size={12} />
						</button>
					</Tooltip>
					{ratesOpen && ratesPos && createPortal(
						<div
							ref={ratesMenuRef}
							class="v2-dueling-rates-popover"
							style={{ position: 'fixed', top: `${ratesPos.top}px`, left: `${ratesPos.left}px` }}
							role="dialog"
							aria-label="Dueling rates"
						>
							<div class="v2-dueling-rates-header">
								<span class="v2-dueling-rates-title">Dueling rates</span>
								<button
									type="button"
									class="v2-dueling-rates-reset"
									title="Restore canonical defaults"
									onClick={() => setDuelingRates(DEFAULT_DUELING_RATES)}
								>
									<RotateCcw size={11} /> Reset
								</button>
							</div>
							<div class="v2-dueling-rates-rows">
								{STRATEGY_ROWS.map(row => {
									const value = duelingRates[row.key];
									return (
										<div class="v2-dueling-rates-row" key={row.key}>
											<label class="v2-dueling-rates-label">
												<span>{row.label}</span>
												{row.sub && <em>{row.sub}</em>}
											</label>
											<div class="v2-dueling-rates-input">
												<input
													type="range"
													min="0" max="100" step="1"
													value={value}
													onInput={e => updateRate(row.key, parseInt((e.target as HTMLInputElement).value))}
												/>
												<input
													type="number"
													min="0" max="100"
													value={value}
													onInput={e => updateRate(row.key, parseInt((e.target as HTMLInputElement).value || '0'))}
													class="v2-dueling-rates-num"
												/>
												<span class="v2-dueling-rates-pct">%</span>
											</div>
										</div>
									);
								})}
							</div>
							<p class="v2-dueling-rates-hint">
								Per-strategy chance to engage in a duel on the final straight.
								Settings persist locally.
							</p>
						</div>,
						document.body
					)}
				</div>

				<Tooltip content={globalsimDisabled ? 'Not used by GlobalSim' : "Enable lane movement simulation"} position="bottom">
					<label class="v2-switch">
						<input
							type="checkbox"
							checked={laneMovement && classicV2}
							onChange={() => setLaneMovement(!laneMovement)}
							disabled={!classicV2}
						/>
						<span class="v2-switch-slider" />
						<span class="v2-switch-label">Lane Movement</span>
					</label>
				</Tooltip>

				<Tooltip content="Only show skills and outfits currently in the Global game" position="bottom">
					<label class="v2-switch">
						<input
							type="checkbox"
							checked={hideNotInGame}
							onChange={() => setHideNotInGame(!hideNotInGame)}
						/>
						<span class="v2-switch-slider" />
						<span class="v2-switch-label">In-Game Only</span>
					</label>
				</Tooltip>

				{engine === 'globalsim' && setThreads && (
					<Tooltip content="Sim workers (Auto = CPU cores − 1, up to 6 in the browser tab; up to all cores with the local sim server)" position="bottom">
						<label class="v2-setting">
							<span class="v2-setting-label">Sim threads</span>
							<select
								class="v2-select v2-select-sm"
								value={String(threads ?? 'auto')}
								onChange={(e) => setThreads(e.currentTarget.value === 'auto' ? 'auto' : Number(e.currentTarget.value))}
							>
								<option value="auto">Auto</option>
								{Array.from({ length: 16 }, (_, i) => i + 1).map((n) => (
									<option key={n} value={String(n)}>{n}</option>
								))}
							</select>
						</label>
					</Tooltip>
				)}

				{engine === 'globalsim' && simServer && (
					<div class="v2-sim-server-row">
						<label class="v2-setting v2-sim-server-url">
							<span class="v2-setting-label">Sim server</span>
							<input
								type="text"
								class="v2-sim-input"
								value={simServer.url}
								placeholder="http://127.0.0.1:8765"
								onInput={(e) => simServer.setUrl(e.currentTarget.value)}
							/>
						</label>
						<label class="v2-setting v2-sim-server-token">
							<span class="v2-setting-label">Token</span>
							<input
								type="password"
								class="v2-sim-input"
								value={simServer.token}
								placeholder="—"
								onInput={(e) => simServer.setToken(e.currentTarget.value)}
							/>
						</label>
						<button class="v2-button v2-sim-server-check" onClick={simServer.check}>Check</button>
					</div>
				)}
				{engine === 'globalsim' && simServer && (
					<span class="v2-globalsim-notice v2-sim-server-status">
						{simServer.online
							? `Sim server connected — ${simServer.cores ?? 'all'} cores. Workers run outside the browser tab; Auto now uses every core with no tab-memory cost.`
							: simServer.tokenNeeded
								? 'Sim server needs its token — enter it above and press Check.'
								: 'Sim server not running. Double-click sim-server.bat to run sims on all your cores without browser-tab memory limits (restart it, then Check or reload).'}
					</span>
				)}

				{engine === 'globalsim' && (
					<span class="v2-globalsim-notice">
						Compare and skill chart run the GlobalSim full-field engine (9-runner mob field, margin in lengths, win rate).
						{typeof globalsimUncoveredCount === 'number' && (
							` ${globalsimUncoveredCount} skills not yet supported by GlobalSim.`
						)}
					</span>
				)}
			</div>
		</div>
	);
}
