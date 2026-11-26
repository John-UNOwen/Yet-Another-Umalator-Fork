/**
 * Update check
 *
 * An open tab keeps running the bundle it loaded, but every run starts workers
 * that fetch the engine worker, the wasm and the skill table by fixed names, so
 * after a deploy an old page can drive a newer engine. The build writes its id
 * to version.json (vite.config.ts). The page re-reads that file when the tab
 * comes back into view, every 15 minutes, and before each run, and offers a
 * reload when the deployed id differs from its own.
 *
 * Licensed under GPL-3.0-or-later
 */

import { h } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { RefreshCw } from 'lucide-react';

declare const CC_BUILD_ID: string;
declare const CC_DEV: boolean;
// Undefined in builds without the define (the esbuild bundles): no checks then.
const OWN_BUILD = typeof CC_BUILD_ID !== 'undefined' ? CC_BUILD_ID : '';

const RECHECK_MS = 15 * 60 * 1000;
// Focus and run starts can come in bursts, so a check reuses a recent answer.
const MIN_GAP_MS = 60 * 1000;

async function deployedBuild(): Promise<string | null> {
	try {
		const url = new URL('version.json', document.baseURI);
		url.searchParams.set('t', String(Date.now()));
		const r = await fetch(url, { cache: 'no-store' });
		if (!r.ok) return null; // the dev server and older deploys have no file
		const j = await r.json();
		return typeof j?.build === 'string' ? j.build : null;
	} catch {
		return null; // offline: say nothing
	}
}

export interface UpdateState {
	/** A newer deploy is live and the banner is showing. */
	visible: boolean;
	/** Check now (throttled), for example before a run. Shows the banner again
	 *  after Later if the page is still out of date. */
	check: () => void;
	dismiss: () => void;
}

export function useUpdateCheck(): UpdateState {
	// Dev builds show the banner with ?update-preview, to look at it without a deploy.
	const [stale, setStale] = useState(() =>
		CC_DEV && new URLSearchParams(window.location.search).has('update-preview'));
	const [dismissed, setDismissed] = useState(false);
	const lastAt = useRef(0);

	const run = useCallback(async (force: boolean) => {
		if (!OWN_BUILD) return;
		const now = Date.now();
		if (!force && now - lastAt.current < MIN_GAP_MS) return;
		lastAt.current = now;
		const live = await deployedBuild();
		if (live && live !== OWN_BUILD) setStale(true);
	}, []);

	useEffect(() => {
		const onVisible = () => { if (document.visibilityState === 'visible') void run(false); };
		document.addEventListener('visibilitychange', onVisible);
		window.addEventListener('focus', onVisible);
		const timer = window.setInterval(() => void run(true), RECHECK_MS);
		return () => {
			document.removeEventListener('visibilitychange', onVisible);
			window.removeEventListener('focus', onVisible);
			window.clearInterval(timer);
		};
	}, [run]);

	const check = useCallback(() => {
		setDismissed(false);
		void run(false);
	}, [run]);
	const dismiss = useCallback(() => setDismissed(true), []);

	return { visible: stale && !dismissed, check, dismiss };
}

interface UpdateBannerProps {
	visible: boolean;
	/** A run is going: reloading now would end it. */
	busy: boolean;
	onDismiss: () => void;
}

export function UpdateBanner({ visible, busy, onDismiss }: UpdateBannerProps) {
	if (!visible) return null;
	// A body child, so no stacking context in the page can draw over it.
	return createPortal(
		<div class="v2-update-banner" role="status" aria-live="polite">
			<RefreshCw size={16} class="v2-update-banner-icon" aria-hidden="true" />
			<div class="v2-update-banner-text">
				<strong>A new version is available</strong>
				<span>
					{busy
						? 'Reload when your run finishes. Reloading now ends it.'
						: 'Reload to update. Your builds and settings are kept.'}
				</span>
			</div>
			<div class="v2-update-banner-actions">
				<button type="button" class="v2-button v2-button-ghost v2-button-sm" onClick={onDismiss}>
					Later
				</button>
				<button type="button" class="v2-button v2-button-primary v2-button-sm" onClick={() => window.location.reload()}>
					Reload
				</button>
			</div>
		</div>,
		document.body,
	);
}
