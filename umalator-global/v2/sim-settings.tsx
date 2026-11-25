/**
 * Simulation Settings
 * Compact inline controls for simulation parameters.
 *
 * Split into two pieces so the app can place them differently:
 *  - SimCommonControls  → always visible in the header (Samples, Seed, In-Game Only)
 *  - SimAdvancedControls → the collapsible "Advanced" strip (threads, sim server, notices)
 * SimulationSettings keeps both stacked for the mobile settings drawer.
 *
 * Copyright (c) 2026 TheCing (https://github.com/TheCing/uma-tools)
 * Licensed under GPL-3.0-or-later
 */

import { h } from 'preact';
import { Shuffle, Dices } from 'lucide-react';
import { Tooltip } from './components';
import { MAX_THREADS, serverAwareThreadCount } from './engines/globalsim/pool';
import { lanePlanOf, lastJobLine } from './engines/globalsim/lanePlan';
import type { GpuVerdict, LastJob } from './engines/globalsim/lanePlan';
import type { SimAccess } from './engines/globalsim/simLink';
import { needsGestureFor } from './engines/globalsim/simLink';

interface SimCommonProps {
	samples: number;
	setSamples: (v: number) => void;
	seed: number;
	setSeed: (v: number) => void;
	autoSeed: boolean;
	setAutoSeed: (v: boolean) => void;
	hideNotInGame: boolean;
	setHideNotInGame: (v: boolean) => void;
}

interface SimAdvancedProps {
	/** Count of uma-tools skills missing from the active GlobalSim table (notice). */
	globalsimUncoveredCount?: number | null;
	/** GlobalSim worker count ('auto' = every core − 1 for the UI, up to MAX_THREADS; explicit 1..MAX_THREADS; persisted by pool.ts). */
	threads?: 'auto' | number;
	setThreads?: (v: 'auto' | number) => void;
	/** Local sim server (CPU offload). */
	simServer?: {
		url: string;
		setUrl: (v: string) => void;
		token: string;
		setToken: (v: string) => void;
		online: boolean;
		cores?: number;
		/** The server answered but refused the token, so every call will 401. */
		tokenRejected: boolean;
		/** Chrome's Local Network Access state for this origin. */
		access: SimAccess;
		check: () => void;
		/** The server's gpu lane verdict (device, cost, or the refusal). */
		gpu?: GpuVerdict | null;
	};
	/** The last finished sim run, for the measured speed line. */
	lastJob?: LastJob | null;
}

type SimSettingsProps = SimCommonProps & SimAdvancedProps;

/** Always-visible sim parameters: Samples, Seed (+ reroll/auto), In-Game Only. */
export function SimCommonControls({
	samples,
	setSamples,
	seed,
	setSeed,
	autoSeed,
	setAutoSeed,
	hideNotInGame,
	setHideNotInGame,
}: SimCommonProps) {
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
		<div class="v2-sim-common">
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
		</div>
	);
}

/** Collapsible advanced strip: Sim threads, Sim server (url/token/check) and notices. */
export function SimAdvancedControls({
	globalsimUncoveredCount,
	threads,
	setThreads,
	simServer,
	lastJob,
}: SimAdvancedProps) {
	// The lane plan follows the server's own verdict: native threads, device,
	// measured launch cost, or the refusal that keeps it closed.
	const lanePlan = simServer
		? lanePlanOf({
			gpu: simServer.gpu ?? null,
			threads: serverAwareThreadCount(threads ?? 'auto', simServer.online),
			cores: simServer.cores,
		})
		: null;
	const jobLine = lastJobLine(lastJob);
	// The status has to name the real blocker. "not running" covers three
	// different faults here, and the browser's own refusal used to look like a
	// stopped server.
	const serverStatus = !simServer
		? null
		: simServer.online
			? simServer.tokenRejected
				? 'Sim server connected, but it rejected the token. Enter the token it was started with, then press Check.'
				: `Sim server connected: ${simServer.cores ?? 'all'} cores. Workers run outside the browser tab; Auto now uses every core with no tab-memory cost.`
			: simServer.access === 'denied'
				? "Chrome blocked this page from reaching your local server. Allow Local network in this site's settings, then press Check."
				: simServer.access === 'prompt' && needsGestureFor(simServer.url)
					? 'Press Check to use your local sim server. Chrome asks once for permission to reach it.'
					: 'Sim server not running. Start it, then press Check.';
	return (
		<div class="v2-sim-advanced">
			{setThreads && (
				<Tooltip content="Sim workers (Auto = every CPU core, minus one for the UI; the local sim server runs them outside the browser tab)" position="bottom">
					<label class="v2-setting">
						<span class="v2-setting-label">Sim threads</span>
						<select
							class="v2-select v2-select-sm"
							value={String(threads ?? 'auto')}
							onChange={(e) => setThreads(e.currentTarget.value === 'auto' ? 'auto' : Number(e.currentTarget.value))}
						>
							<option value="auto">Auto</option>
							{Array.from({ length: MAX_THREADS }, (_, i) => i + 1).map((n) => (
								<option key={n} value={String(n)}>{n}</option>
							))}
						</select>
					</label>
				</Tooltip>
			)}

			{simServer && (
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

			{serverStatus && (
				<span class="v2-globalsim-notice v2-sim-server-status">{serverStatus}</span>
			)}

			{simServer && simServer.online && lanePlan && (
				<span class={`v2-globalsim-notice v2-sim-server-lane v2-sim-lane-${lanePlan.state}`}>
					<strong>{lanePlan.headline}.</strong> {lanePlan.detail}
				</span>
			)}

			{jobLine && (
				<span class="v2-globalsim-notice v2-sim-last-job">{jobLine}</span>
			)}

			<span class="v2-globalsim-notice">
				Compare, skill chart and the optimizer run the GlobalSim full-field engine (9-runner mob field, margin in lengths, vs Base points).
				{typeof globalsimUncoveredCount === 'number' && (
					` ${globalsimUncoveredCount} skills not yet supported by GlobalSim.`
				)}
			</span>
		</div>
	);
}

/** Mobile settings drawer: common + advanced stacked. */
export function SimulationSettings(props: SimSettingsProps) {
	return (
		<div class="v2-sim-settings">
			<SimCommonControls {...props} />
			<SimAdvancedControls {...props} />
		</div>
	);
}
