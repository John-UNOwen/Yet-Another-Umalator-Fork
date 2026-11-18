/**
 * Import a uma from screenshots, recognised on this device: a worker runs PP-OCR over each image, the
 * parser modules turn the lines into a uma, and nothing leaves the machine unless the cloud fallback is
 * opened. Several screenshots of one uma are combined, so a list too long for one screen still imports.
 *
 * Copyright (c) 2026 TheCing (https://github.com/TheCing/uma-tools)
 * Licensed under GPL-3.0-or-later
 */

import { h, Fragment } from 'preact';
import { useState, useRef, useEffect, useCallback, useMemo } from 'preact/hooks';
import { Modal, Button, CustomSelect } from './components';
import { Upload, Loader2, Plus, Cloud, Check, AlertTriangle } from 'lucide-react';

import { BASE_PATH } from '../../components/base-path';
import { mapCharacterNameToOutfitId, mapOutfitNameToId } from '../../components/GeminiOCR';
import { GRADES } from '../../components/screenshot-ocr/aptitudes';
import type { Grade } from '../../components/screenshot-ocr/aptitudes';
import { DISTANCE_KEYS, skillKey, styleAptitudeOf, umaFromRead } from '../../components/screenshot-ocr/build';
import type { Edits, Strategy, UmaDraft } from '../../components/screenshot-ocr/build';
import { gaps, mergeReads } from '../../components/screenshot-ocr/merge';
import type { MergedRead, Read, SkillRead } from '../../components/screenshot-ocr/merge';
import { STAT_LABELS } from '../../components/screenshot-ocr/layout';
import type { AptitudeKey, StatKey } from '../../components/screenshot-ocr/layout';
import type { Box } from '../../components/screenshot-ocr/contract';
import type { NameEntry } from '../../components/screenshot-ocr/matcher';
import { manifestKey } from '../../components/screenshot-ocr/model-cache';
import type { ScanResult, StatNote } from '../../components/screenshot-ocr/scan';

import skillnames from '../skillnames.json';
import notInGame from '../not-in-game.json';
import { validateAndParseUmaJson } from './storage';
import type { UmaState } from './uma-panel';
import { GeminiOcrModal } from './gemini-ocr-step';

interface OCRModalProps {
	isOpen: boolean;
	onClose: () => void;
	onConfirm: (state: UmaState) => void;
}

/** The pool a skill line can be matched against: this fork's names, minus what the player cannot have.
 *  skillnames.json keeps the live name first, so index 0 is what a screen shows. */
const OFFERED: NameEntry[] = Object.entries(skillnames as Record<string, string | string[]>)
	.map(([id, v]) => ({ id, name: Array.isArray(v) ? v[0] : v }))
	.filter((e) => !(notInGame as { skills: string[] }).skills.includes(e.id) && /[a-z]/i.test(e.name));
const NAME_OF = new Map(OFFERED.map((e) => [e.id, e.name]));

const APTITUDE_OPTIONS = GRADES.map((g) => ({ value: g, label: g }));
const STRATEGY_OPTIONS = [
	{ value: 'Nige', label: 'Front Runner' },
	{ value: 'Senkou', label: 'Pace Chaser' },
	{ value: 'Sasi', label: 'Late Surger' },
	{ value: 'Oikomi', label: 'End Closer' },
];

export function OCRModal(props: OCRModalProps) {
	const [cloud, setCloud] = useState(false);
	if (cloud) return <GeminiOcrModal {...props} />;
	return <DeviceModal {...props} onCloud={() => setCloud(true)} />;
}

interface Shot {
	url: string;
	bytes: ArrayBuffer;
	size: number;
}

type Phase = 'pick' | 'ask' | 'work' | 'review';
interface Progress {
	stage: string;
	done: number;
	total: number;
}

/** The review screen's own fields, on top of what `umaFromRead` consumes. */
interface UiEdits extends Edits {
	epithet: string;
	outfitId: string;
}

const EMPTY_EDITS: UiEdits = {
	stats: {},
	aptitudes: {},
	strategy: 'Senkou',
	epithet: '',
	outfitId: '',
	starCount: 3,
	uniqueLv: 1,
	skills: {},
};

/**
 * Which screenshot a combined skill row came from: the one that read that text at that place. Rows keep
 * their boxes from the shot they were read from, so the crop the user checks is the real one.
 */
function shotOf(pairs: readonly { url: string; read: Read }[], skill: SkillRead): string {
	const found = pairs.find((p) => p.read.skills?.some((s) => s.text === skill.text && s.box?.x === skill.box?.x && s.box?.y === skill.box?.y));
	return (found ?? pairs[0])?.url ?? '';
}

function DeviceModal({ isOpen, onClose, onConfirm, onCloud }: OCRModalProps & { onCloud: () => void }) {
	const [shots, setShots] = useState<Shot[]>([]);
	const [results, setResults] = useState<ScanResult[]>([]);
	const [phase, setPhase] = useState<Phase>('pick');
	const [progress, setProgress] = useState<Progress | null>(null);
	const [downloadBytes, setDownloadBytes] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [edits, setEdits] = useState<UiEdits>(EMPTY_EDITS);

	const fileRef = useRef<HTMLInputElement>(null);
	const zoneRef = useRef<HTMLDivElement>(null);
	const workerRef = useRef<Worker | null>(null);
	const waitingRef = useRef(new Map<number, { resolve: (r: ScanResult) => void; reject: (e: Error) => void }>());

	useEffect(() => {
		if (!isOpen) return;
		setShots([]);
		setResults([]);
		setPhase('pick');
		setProgress(null);
		setDownloadBytes(null);
		setError(null);
		setEdits(EMPTY_EDITS);
	}, [isOpen]);

	const merged = useMemo(() => mergeReads(results.map((r) => r.read)), [results]);
	const missing = useMemo(() => gaps(merged), [merged]);

	const worker = useCallback((): Worker => {
		if (workerRef.current) return workerRef.current;
		const w = new Worker(new URL('../../components/screenshot-ocr/ocr.worker.ts', import.meta.url), { type: 'module' });
		w.onmessage = (e: MessageEvent) => {
			const m = e.data as { type: string; id?: number; result?: ScanResult; message?: string } & Partial<Progress>;
			if (m.type === 'progress') setProgress({ stage: m.stage!, done: m.done!, total: m.total! });
			else if (m.type === 'scanned') {
				const held = waitingRef.current.get(m.id!);
				waitingRef.current.delete(m.id!);
				if (held) held.resolve(m.result!);
			} else if (m.type === 'failed') {
				for (const held of waitingRef.current.values()) held.reject(new Error(m.message ?? 'the reader failed'));
				waitingRef.current.clear();
			}
		};
		w.onerror = (e) => {
			for (const held of waitingRef.current.values()) held.reject(new Error(e.message));
			waitingRef.current.clear();
		};
		workerRef.current = w;
		return w;
	}, []);

	const scanAll = useCallback(async (list: readonly Shot[]) => {
		const w = worker();
		w.postMessage({ type: 'prepare', names: OFFERED });
		const found: ScanResult[] = [];
		try {
			for (const [i, shot] of list.entries()) {
				setProgress({ stage: 'read', done: i, total: list.length });
				found.push(await new Promise<ScanResult>((resolve, reject) => {
					const id = waitingRef.current.size + 1000 + i;
					waitingRef.current.set(id, { resolve, reject });
					w.postMessage({ type: 'scan', id, source: shot.bytes }, [shot.bytes]);
				}));
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPhase('pick');
			return;
		}
		setResults((held) => [...held, ...found]);
		setPhase('review');
	}, [worker]);

	const start = useCallback(async (list: readonly Shot[]) => {
		setError(null);
		setProgress(null);
		try {
			const r = await fetch(`${BASE_PATH}/ocr/MANIFEST.json`, { cache: 'no-store' });
			if (!r.ok) throw new Error(`The model list did not load (HTTP ${r.status}).`);
			const manifest = await r.json();
			const total = (manifest.assets as { bytes: number }[]).reduce((n, a) => n + a.bytes, 0);
			const stored = typeof caches !== 'undefined' && await caches.has('ocr-' + manifestKey(manifest));
			if (stored) await scanAll(list);
			else {
				setDownloadBytes(total);
				setPhase('ask');
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPhase('pick');
		}
	}, [scanAll]);

	const addFiles = useCallback((files: File[]) => {
		const images = [...files].filter((f) => f.type.startsWith('image/'));
		if (!images.length) return;
		setError(null);
		setPhase('pick');
		for (const file of images) {
			file.arrayBuffer().then((bytes) => {
				setShots((held) => [...held, { url: URL.createObjectURL(file), bytes, size: file.size }]);
			});
		}
	}, []);

	const onDrop = useCallback((e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		zoneRef.current?.classList.remove('dragover');
		if (e.dataTransfer?.files?.length) addFiles(Array.from(e.dataTransfer.files));
	}, [addFiles]);

	useEffect(() => {
		if (!isOpen) return;
		const onPaste = (e: ClipboardEvent) => {
			const files = e.clipboardData?.files;
			if (files?.length) addFiles(Array.from(files));
		};
		document.addEventListener('paste', onPaste);
		return () => document.removeEventListener('paste', onPaste);
	}, [isOpen, addFiles]);

	const edit = useCallback(<K extends keyof UiEdits>(field: K, value: UiEdits[K]) => setEdits((held) => ({ ...held, [field]: value })), []);
	const setStat = useCallback((label: StatKey, value: number) => setEdits((held) => ({ ...held, stats: { ...held.stats, [label]: value } })), []);
	const setAptitude = useCallback((key: AptitudeKey, value: Grade) => setEdits((held) => ({ ...held, aptitudes: { ...held.aptitudes, [key]: value } })), []);
	// The panel keeps one distance grade, so choosing one stands in for the four cells the read fills in.
	const setDistance = useCallback((value: Grade) => setEdits((held) => {
		const aptitudes = { ...held.aptitudes };
		for (const key of DISTANCE_KEYS) aptitudes[key] = value;
		return { ...held, aptitudes };
	}), []);
	const setSkill = useCallback((key: string, value: { pick?: string; off?: boolean }) => setEdits((held) => ({
		...held,
		skills: { ...held.skills, [key]: { ...held.skills[key], ...value } },
	})), []);

	const outfit = useMemo(() => {
		const typed = edits.epithet || merged.epithet.value || '';
		const id = edits.outfitId || mapOutfitNameToId(typed) || mapCharacterNameToOutfitId(merged.name.value ?? '');
		return { typed, id };
	}, [edits.epithet, edits.outfitId, merged]);

	// The draft the fields show is the draft that gets validated, so the defaults live in one module.
	const draft = useMemo(() => {
		const { epithet, ...typed } = edits;
		return umaFromRead(merged, { ...typed, outfitId: outfit.id });
	}, [merged, edits, outfit.id]);

	const load = useCallback(() => {
		const state = validateAndParseUmaJson(draft);
		if (!state) setError('That build did not pass validation. Check the stats and the aptitudes.');
		else {
			onConfirm(state);
			onClose();
		}
	}, [draft, onConfirm, onClose]);

	const percent = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

	const footer = phase === 'review' ? (
		<>
			<Button variant="ghost" onClick={() => setPhase('pick')} icon={<Plus size={14} />}>Add a screenshot</Button>
			<Button variant="primary" onClick={load} icon={<Check size={14} />}>Load build</Button>
		</>
	) : phase === 'ask' ? (
		<>
			<Button variant="ghost" onClick={() => setPhase('pick')}>Cancel</Button>
			<Button variant="primary" onClick={() => scanAll(shots)}>Download and read</Button>
		</>
	) : (
		<>
			<Button variant="ghost" onClick={onClose}>Cancel</Button>
			<Button variant="primary" onClick={() => start(shots)} disabled={!shots.length || phase === 'work'} icon={phase === 'work' ? <Loader2 size={14} class="v2-ocr-spinner" /> : <Upload size={14} />}>
				{phase === 'work' ? 'Reading...' : 'Read screenshots'}
			</Button>
		</>
	);

	return (
		<Modal isOpen={isOpen} onClose={onClose} title="Import from Screenshot" footer={footer} size="xl" className="v2-ocr-modal">
			{phase === 'ask' ? (
				<div class="v2-ocr-section">
					<label class="v2-ocr-label">Recognition models</label>
					<p>
						Nothing is installed on this site for reading screenshots yet. About {(downloadBytes! / 1048576).toFixed(1)} MB of
						PP-OCR models are fetched once, checked against their published checksums, and kept for next time. Reading happens on this
						device either way.
					</p>
					<div class="v2-ocr-review-item">
						<Button variant="ghost" onClick={onCloud} icon={<Cloud size={14} />}>Use cloud OCR instead (needs API key)</Button>
					</div>
				</div>
			) : phase === 'work' ? (
				<div class="v2-ocr-section">
					<label class="v2-ocr-label">{progress?.stage === 'assets' ? 'Fetching models' : progress?.stage === 'models' ? 'Loading models' : 'Reading screenshots'}</label>
					<div class="v2-ocr-dropzone" style={{ cursor: 'default' }}>
						<Loader2 size={28} class="v2-ocr-spinner" />
						<span>
							{progress?.stage === 'assets' ? `${(progress.done / 1048576).toFixed(1)} of ${(progress.total / 1048576).toFixed(1)} MB` : `${progress?.done ?? 0} of ${progress?.total ?? 0}`}
							{' '}({percent}%)
						</span>
					</div>
				</div>
			) : phase === 'review' ? (
				<Review merged={merged} missing={missing} pairs={results.map((r, i) => ({ url: shots[i]?.url ?? '', read: r.read }))} notes={results.flatMap((r) => r.statNotes)} draft={draft} skills={edits.skills} edit={edit} setStat={setStat} setAptitude={setAptitude} setDistance={setDistance} setSkill={setSkill} outfit={outfit} onOutfit={(v) => { edit('epithet', v); edit('outfitId', ''); }} />
			) : (
				<div class="v2-ocr-upload">
					<div class="v2-ocr-section">
						<label class="v2-ocr-label">Screenshots of the Details dialog</label>
						<div
							ref={zoneRef}
							class={`v2-ocr-dropzone ${shots.length ? 'has-image' : ''}`}
							onClick={() => fileRef.current?.click()}
							onDragOver={(e: DragEvent) => { e.preventDefault(); zoneRef.current?.classList.add('dragover'); }}
							onDragLeave={(e: DragEvent) => { e.preventDefault(); zoneRef.current?.classList.remove('dragover'); }}
							onDrop={onDrop}
						>
							{shots.length ? (
								<div class="v2-ocr-skill-list">
									{shots.map((s, i) => <img key={i} src={s.url} alt={`Screenshot ${i + 1}`} class="v2-ocr-preview" style={{ maxHeight: '160px', marginRight: '6px' }} />)}
								</div>
							) : (
								<div class="v2-ocr-dropzone-content">
									<Upload size={32} class="v2-ocr-dropzone-icon" />
									<span>Click to select, drag & drop, or paste. Two shots of one dialog, or a scrolled list, are combined.</span>
								</div>
							)}
						</div>
						<input ref={fileRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={(e) => addFiles(Array.from((e.target as HTMLInputElement).files ?? []))} />
					</div>
					<div class="v2-ocr-section">
						<div class="v2-ocr-review-item">
							<Button variant="ghost" onClick={onCloud} icon={<Cloud size={14} />}>Use cloud OCR (needs API key)</Button>
						</div>
					</div>
					{error && <div class="v2-ocr-error">{error}</div>}
				</div>
			)}
		</Modal>
	);
}

const STAT_FIELD: Record<StatKey, keyof UmaDraft> = { Speed: 'speed', Stamina: 'stamina', Power: 'power', Guts: 'guts', Wit: 'wisdom' };

function Review({ merged, missing, pairs, notes, draft, skills, edit, setStat, setAptitude, setDistance, setSkill, outfit, onOutfit }: {
	merged: MergedRead;
	missing: string[];
	pairs: readonly { url: string; read: Read }[];
	notes: readonly StatNote[];
	draft: UmaDraft;
	skills: UiEdits['skills'];
	edit: <K extends keyof UiEdits>(field: K, value: UiEdits[K]) => void;
	setStat: (label: StatKey, value: number) => void;
	setAptitude: (key: AptitudeKey, value: Grade) => void;
	setDistance: (value: Grade) => void;
	setSkill: (key: string, value: { pick?: string; off?: boolean }) => void;
	outfit: { typed: string; id: string };
	onOutfit: (value: string) => void;
}) {
	const byStat = new Map(notes.map((n) => [n.stat, n]));
	const skillOptions = (s: SkillRead) => s.match.ids.map((id) => ({ value: id, label: NAME_OF.get(id) ?? id }));

	return (
		<div class="v2-ocr-review">
			<div class="v2-ocr-review-layout">
				<div class="v2-ocr-review-data-section">
					<label class="v2-ocr-label">From {merged.screenshots} screenshot{merged.screenshots === 1 ? '' : 's'}</label>
					<div class="v2-ocr-review-grid">
						<div class="v2-ocr-review-item">
							<span class="v2-ocr-review-key">Outfit:</span>
							<input class="v2-ocr-input" value={outfit.typed} onInput={(e) => onOutfit((e.target as HTMLInputElement).value)} />
							<span class="v2-ocr-review-value">{outfit.id ? `id ${outfit.id}` : 'not recognised'}</span>
						</div>
						{STAT_LABELS.map((label) => {
							const note = byStat.get(label);
							return (
								<div class="v2-ocr-review-item">
									<span class="v2-ocr-review-key">{label}:</span>
									<input
										class="v2-ocr-input"
										type="number"
										value={draft[STAT_FIELD[label]] as number}
										onInput={(e) => setStat(label, Number((e.target as HTMLInputElement).value))}
									/>
									{note && !note.agreed && <span title={`The digit reader saw ${note.masked.join(' ')} in the box for “${note.text}”`}><AlertTriangle size={14} /></span>}
									{merged.stats[label].other.length > 0 && <span class="v2-ocr-review-value">other shot said {merged.stats[label].other.join(', ')}</span>}
								</div>
							);
						})}
						<div class="v2-ocr-review-item">
							<span class="v2-ocr-review-key">Surface:</span>
							<CustomSelect value={draft.surfaceAptitude} onChange={(v) => setAptitude('turf', v as Grade)} options={APTITUDE_OPTIONS} className="v2-ocr-select-small" />
						</div>
						<div class="v2-ocr-review-item">
							<span class="v2-ocr-review-key">Distance:</span>
							<CustomSelect value={draft.distanceAptitude} onChange={(v) => setDistance(v as Grade)} options={APTITUDE_OPTIONS} className="v2-ocr-select-small" />
						</div>
						<div class="v2-ocr-review-item">
							<span class="v2-ocr-review-key">Strategy:</span>
							<CustomSelect value={draft.strategy} onChange={(v) => edit('strategy', String(v) as Strategy)} options={STRATEGY_OPTIONS} className="v2-ocr-select-strategy" />
						</div>
						<div class="v2-ocr-review-item">
							<span class="v2-ocr-review-key">Style apt:</span>
							<CustomSelect value={draft.strategyAptitude} onChange={(v) => setAptitude(styleAptitudeOf(draft.strategy), v as Grade)} options={APTITUDE_OPTIONS} className="v2-ocr-select-small" />
						</div>
						<div class="v2-ocr-review-item">
							<span class="v2-ocr-review-key">Stars:</span>
							<CustomSelect value={String(draft.starCount)} onChange={(v) => edit('starCount', Number(v))} options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }))} className="v2-ocr-select-small" />
							<span class="v2-ocr-review-value">the dialog does not show this</span>
						</div>
						<div class="v2-ocr-review-item">
							<span class="v2-ocr-review-key">Unique lv:</span>
							<CustomSelect value={String(draft.uniqueLv)} onChange={(v) => edit('uniqueLv', Number(v))} options={[1, 2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: String(n) }))} className="v2-ocr-select-small" />
						</div>
						<div class="v2-ocr-review-item v2-ocr-review-skills">
							<span class="v2-ocr-review-key">Skills ({merged.skills.length}):</span>
							<div class="v2-ocr-skill-list">
								{merged.skills.map((s) => {
									const key = skillKey(s);
									const choice = skills?.[key];
									const picked = choice?.pick ?? s.match.id ?? s.match.ids[0];
									return (
										<div class="v2-ocr-review-item" key={key} style={{ width: '100%' }}>
											<label class="v2-ocr-checkbox">
												<input type="checkbox" checked={!choice?.off} onChange={(e) => setSkill(key, { off: !(e.target as HTMLInputElement).checked })} />
											</label>
											{s.box && <Crop url={shotOf(pairs, s)} box={s.box} />}
											{skillOptions(s).length > 1 ? (
												<CustomSelect value={picked} onChange={(v) => setSkill(key, { pick: String(v) })} options={skillOptions(s)} className="v2-ocr-select-small" />
											) : (
												<span class="v2-ocr-review-value">{NAME_OF.get(picked) ?? picked}</span>
											)}
											{s.match.id === null && <span class="v2-ocr-review-value">which one? ({s.match.why ?? 'level'})</span>}
											{s.level !== null && <span class="v2-ocr-review-value">Lvl {s.level}</span>}
										</div>
									);
								})}
							</div>
						</div>
						{missing.length > 0 && <div class="v2-ocr-review-item"><span class="v2-ocr-review-value">Not read, set them in the panel after importing: {missing.join(', ')}</span></div>}
					</div>
				</div>
			</div>
		</div>
	);
}

/** A crop of the screenshot, cut with CSS so nothing is copied or re-encoded. */
function Crop({ url, box, width = 170 }: { url: string; box: Box; width?: number }) {
	const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
	useEffect(() => {
		const img = new Image();
		img.onload = () => setNatural({ w: img.naturalWidth, h: img.naturalHeight });
		img.src = url;
	}, [url]);
	if (!natural) return null;
	const k = width / box.w;
	return (
		<span style={{ display: 'inline-block', width: `${width}px`, height: `${Math.max(14, Math.round(box.h * k))}px`, overflow: 'hidden', verticalAlign: 'middle', marginRight: '6px' }}>
			<img src={url} alt="" style={{ display: 'block', position: 'relative', width: `${Math.round(natural.w * k)}px`, marginLeft: `${-Math.round(box.x * k)}px`, marginTop: `${-Math.round(box.y * k)}px` }} />
		</span>
	);
}
