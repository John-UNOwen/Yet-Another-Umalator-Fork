/**
 * The GPU lane plan for Simulation settings: what the sim server reports about
 * the machine, plus the native thread count the pool would run with it.
 */

export interface GpuVerdict {
	ok: boolean;
	batch?: boolean;
	reasons?: string[];
	device?: string | null;
	floorMs?: number | null;
	slopeMsPerRace?: number | null;
	parityOk?: boolean | null;
	pending?: boolean;
}

export interface LanePlan {
	state: 'pending' | 'on' | 'off';
	headline: string;
	detail: string;
}

/** Native threads with the lane on: it shares the cores - 1 budget, so past
 *  that one native thread makes room for it. Mirrors pool.ts slotCap. */
export function plannedNativeThreads(threads: number, cores: number, gpuOn: boolean): number {
	if (!gpuOn) return Math.max(1, threads);
	const budget = Math.max(1, Math.floor(cores) - 1);
	const native = Math.min(threads, budget);
	return native < budget ? native : Math.max(1, native - 1);
}

export function lanePlanOf(o: { gpu?: GpuVerdict | null; threads: number; cores?: number }): LanePlan {	const { gpu, threads } = o;
	const cores = o.cores && o.cores > 0 ? Math.floor(o.cores) : undefined;
	const coreText = cores !== undefined ? ` on ${cores} cores` : '';
	if (!gpu) {
		return {
			state: 'off',
			headline: 'GPU lane: not reported',
			detail: `The sim server did not report a GPU, so all races run on the native threads: ${threads}${coreText}.`,
		};
	}
	if (gpu.pending) {
		return {
			state: 'pending',
			headline: 'GPU lane: checking this machine',
			detail: `The sim server is testing the GPU now, which takes a few seconds. Native threads: ${threads}${coreText} until the check answers.`,
		};
	}
	if (!gpu.ok) {
		const reason = (gpu.reasons ?? []).filter(Boolean).join(', ') || 'the device gate refused it';
		return {
			state: 'off',
			headline: 'GPU lane: off',
			detail: `CPU lanes only. Native threads: ${threads}${coreText}. Reason: ${reason}.`,
		};
	}
	const native = plannedNativeThreads(threads, cores ?? threads + 1, true);
	const cost = gpu.floorMs != null && gpu.slopeMsPerRace != null
		? ` One launch costs about ${Math.round(gpu.floorMs)} ms plus ${gpu.slopeMsPerRace.toFixed(1)} ms per race.`
		: '';
	const parity = gpu.parityOk === false ? ' The startup guard race failed, so the lane stays closed.' : '';
	return {
		state: 'on',
		headline: `GPU lane: on (${gpu.device ?? 'exact device'})`,
		detail: `Native threads: ${native}${coreText}, plus the GPU lane when a job covers its launch floor.${cost}${parity}`,
	};
}

/** A finished sim run, as the settings panel reports it back. */
export interface LastJob {
	label: string;
	races: number;
	ms: number;
	threads: number;
}

/** The settings line for the last job, or null when no run has finished. */
export function lastJobLine(job?: LastJob | null): string | null {
	if (!job || !(job.races > 0) || !(job.ms > 0)) return null;
	const secs = job.ms >= 1000 ? `${(job.ms / 1000).toFixed(1)} s` : `${Math.round(job.ms)} ms`;
	const rate = Math.round(job.races / (job.ms / 1000));
	const threadText = `${job.threads} thread${job.threads === 1 ? '' : 's'}`;
	return `Last job: ${job.label}, ${job.races.toLocaleString('en-US')} races in ${secs} (${rate.toLocaleString('en-US')} races/s) on ${threadText}.`;
}
