/**
 * Skill Chart Pane Component
 *
 * Copyright (c) 2026 TheCing (https://github.com/TheCing/uma-tools)
 * Licensed under GPL-3.0-or-later
 *
 * Main table for skill chart mode with TanStack table
 */

import { h, Fragment } from 'preact';
import { useState, useMemo, useEffect, useId, useRef } from 'preact/hooks';
import { EyeOff } from 'lucide-react';
import {
	type ColumnDef, type SortingState,
	useReactTable, flexRender, getSortedRowModel, getCoreRowModel
} from '@tanstack/react-table';

import type { SkillChartResult } from './skill-chart-types';
import { calculateSkillCost, isPurpleSkill, umaForUniqueSkill } from './skill-chart-utils';
import { skillDisplayName } from './skill-name';
import skillmeta from '../../skill_meta.json';
import umas from '../../umas.json';
import icons from '../../icons.json';
import notInGame from '../not-in-game.json';
import { BASE_PATH, resolveBase } from '../../components/base-path';

interface SkillChartPaneProps {
	data: SkillChartResult[];
	courseDistance: number;
	hints: Map<string, number>;
	hasSkills: Map<string, string>;
	updateHint: (id: string, hint: number) => void;
	onRunTypeChange: (type: string) => void;
	onSelectionChange: (skillId: string) => void;
	onInfoClick: (skillId: string) => void;
	onDblClickRow: (skillId: string) => void;
	expandedContent?: (skillId: string, runData: any, courseDistance: number, sampleCount?: number) => any;
	showUmaIcons: boolean;
	hideOwned: boolean;
	hidePurple: boolean;
	hideNotInGame: boolean;
	/** GlobalSim mode: active skill table — rows outside it are hidden (decision D5). */
	globalsimSkillIds?: ReadonlySet<string> | null;
	dirty?: boolean;
	selectedSkillId?: string;
	hiddenSkills: Set<string>;
	onHideSkill: (skillId: string) => void;
}

/**
 * Format bashin value for display
 */
function formatBasinn(info: any) {
	return info.getValue().toFixed(2).replace('-0.00', '0.00') + ' L';
}

/**
 * GlobalSim rows (Phase 5): Mean shows the paired-seed margin mean ± half
 * the 95% CI in lengths. Missing values render as em-dashes (the existing
 * per-engine unavailable pattern, see results-pane).
 */
function formatMeanCell(info: any) {
	const gs = info.row.original.globalsim;
	if (!gs) return formatBasinn(info);
	const mean = info.getValue() as number;
	const half = Number.isFinite(gs.ci95[0]) && Number.isFinite(gs.ci95[1]) ? (gs.ci95[1] - gs.ci95[0]) / 2 : NaN;
	const title = `GlobalSim margin: mean ± 95% CI · ${gs.n} paired seeds · ahead ${(gs.winRate * 100).toFixed(1)}% / behind ${(gs.lossRate * 100).toFixed(1)}% / tie ${(gs.tieRate * 100).toFixed(1)}%`;
	return (
		<span class="v2-gs-chart-mean" title={title}>
			{Number.isFinite(mean) ? `${mean.toFixed(2).replace('-0.00', '0.00')} ±${Number.isFinite(half) ? half.toFixed(2) : '—'} L` : '—'}
		</span>
	);
}

/**
 * Skill name cell with icon
 */
function SkillNameCell(props: { id: string; showUmaIcons: boolean }) {
	const { id, showUmaIcons } = props;

	// Debug: log if id is missing
	if (!id) {
		console.warn('[SkillNameCell] Missing skill id');
		return <div class="v2-skill-chart-skill-name"><span>???</span></div>;
	}

	const name = skillDisplayName(id);

	if (showUmaIcons) {
		const umaId = umaForUniqueSkill(id);
		if (umaId && icons[umaId]) {
			return (
				<div class="v2-skill-chart-skill-name">
					<img src={resolveBase(icons[umaId])} alt="" />
					<span>{name}</span>
				</div>
			);
		}
	}

	return (
		<div class="v2-skill-chart-skill-name">
			<img src={`${BASE_PATH}/icons/${skillmeta[id]?.iconId || 'skill_empty'}.png`} alt="" />
			<span>{name}</span>
		</div>
	);
}

/**
 * SP Cost cell with hint adjustment buttons
 */
function SkillCostCell(props: {
	id: string;
	hint: number;
	hints: Map<string, number>;
	ownedSkills: Map<string, string>;
	updateHint: (id: string, hint: number) => void;
}) {
	const { id, hint, hints, ownedSkills, updateHint } = props;
	const cost = calculateSkillCost(id, hints, ownedSkills);

	return (
		<Fragment>
			<button
				class={`v2-hint-btn v2-hint-down${hint === 0 ? ' disabled' : ''}`}
				disabled={hint === 0}
				onClick={() => updateHint(id, hint - 1)}
				type="button"
			>
				<div class="v2-hint-btn-bg"></div>
				<span class="v2-hint-btn-text">−</span>
			</button>
			<span class="v2-hinted-cost">{cost}</span>
			<button
				class={`v2-hint-btn v2-hint-up${hint === 5 ? ' disabled' : ''}`}
				disabled={hint === 5}
				onClick={() => updateHint(id, hint + 1)}
				type="button"
			>
				<div class="v2-hint-btn-bg"></div>
				<span class="v2-hint-btn-text">+</span>
			</button>
			{hint > 0 && <span class="v2-hint-level">{hint}</span>}
		</Fragment>
	);
}

/**
 * Render sortable header with radio button for run type selection
 */
function headerRenderer(
	radioGroup: string,
	selectedType: string,
	type: string,
	text: string,
	onClick: (type: string) => void
) {
	function click(e: Event) {
		e.stopPropagation();
		onClick(type);
	}
	return (c: any) => (
		<div class="v2-skill-chart-header">
			<input
				type="radio"
				name={radioGroup}
				checked={selectedType === type}
				title={`Show ${text.toLowerCase()} on chart`}
				onClick={click}
			/>
			<span onClick={c.header.column.getToggleSortingHandler()}>{text}</span>
		</div>
	);
}

/**
 * Main Skill Chart Table Component
 */
export function SkillChartPane(props: SkillChartPaneProps) {
	const radioGroup = useId();
	const [selectedType, setSelectedType] = useState('median');

	function headerClick(type: string) {
		setSelectedType(type);
		props.onRunTypeChange(type + 'run');
	}

	// Filter data based on hideOwned and hidePurple
	const filteredData = useMemo(() => {
		let data = props.data;

		if (props.hideOwned) {
			data = data.filter(row => {
				const groupId = skillmeta[row.id]?.groupId;
				if (!groupId) return true;
				return !props.hasSkills.has(groupId);
			});
		}

		if (props.hidePurple) {
			data = data.filter(row => !isPurpleSkill(row.id));
		}

		if (props.hideNotInGame && notInGame.skills.length > 0) {
			const notInGameSet = new Set(notInGame.skills);
			data = data.filter(row => !notInGameSet.has(row.id));
		}

		// GlobalSim mode: uncovered skills never reach the engine, so no rows for them.
		if (props.globalsimSkillIds) {
			const active = props.globalsimSkillIds;
			data = data.filter(row => active.has(row.id));
		}

		if (props.hiddenSkills.size > 0) {
			data = data.filter(row => !props.hiddenSkills.has(row.id));
		}

		return data;
	}, [props.data, props.hideOwned, props.hidePurple, props.hideNotInGame, props.globalsimSkillIds, props.hasSkills, props.hiddenSkills]);

	// GlobalSim rows present? (Phase 5) Gates the extra columns on/off; the
	// classic table (v1/v2 engine data) never carries a globalsim block.
	const gsActive = useMemo(() => props.data.some(r => !!r.globalsim), [props.data]);

	const columns: ColumnDef<SkillChartResult, any>[] = useMemo(() => [{
		id: 'hide',
		header: () => null,
		accessorKey: 'id',
		cell: (info) => (
			<button
				class="v2-skill-hide-btn"
				title="Hide skill"
				type="button"
				onClick={(e) => { e.stopPropagation(); props.onHideSkill(info.getValue()); }}
			>
				<EyeOff size={12} />
			</button>
		),
		enableSorting: false,
		size: 28,
	}, {
		header: () => <span>Skill name</span>,
		accessorKey: 'id',
		cell: (info) => <SkillNameCell id={info.getValue()} showUmaIcons={props.showUmaIcons} />,
		// Sort by the name the cell shows. It sorted by the first entry and
		// showed the last, and never returned 0 for equal names.
		sortingFn: (a, b, _) => skillDisplayName(a.getValue('id')).localeCompare(skillDisplayName(b.getValue('id')))
	}, {
		header: headerRenderer(radioGroup, selectedType, 'min', 'Minimum', headerClick),
		accessorKey: 'min',
		cell: formatBasinn
	}, {
		header: headerRenderer(radioGroup, selectedType, 'max', 'Maximum', headerClick),
		accessorKey: 'max',
		cell: formatBasinn,
		sortDescFirst: true
	}, {
		header: headerRenderer(radioGroup, selectedType, 'mean', 'Mean', headerClick),
		accessorKey: 'mean',
		cell: formatMeanCell,
		sortDescFirst: true
	}, {
		header: headerRenderer(radioGroup, selectedType, 'median', 'Median', headerClick),
		accessorKey: 'median',
		cell: formatBasinn,
		sortDescFirst: true
	},
	// GlobalSim-only extra columns (Phase 5). Absent unless a row carries a
	// globalsim block, so the classic table — columns and rows — renders as
	// before. Mean margin stays the primary margin sort (classic behavior).
	...(gsActive ? [{
		header: (c: any) => <span onClick={c.header.column.getToggleSortingHandler()}>Fires</span>,
		id: 'gsact',
		accessorFn: (row: SkillChartResult) => row.globalsim?.activationRate ?? NaN,
		cell: (info: any) => {
			const gs = info.row.original.globalsim;
			const rate = gs?.activationRate;
			if (!gs || rate == null || !Number.isFinite(rate)) return <span title="Activation tracking unavailable for this engine/row">—</span>;
			const mean = gs.activationMean;
			return <span title={`${Number.isFinite(mean as number) ? (mean as number).toFixed(2) : '—'} activations per race`}>{`${(rate * 100).toFixed(0)}%`}</span>;
		},
		sortingFn: (a: any, b: any) => {
			const x = a.getValue('gsact'); const y = b.getValue('gsact');
			const xf = Number.isFinite(x); const yf = Number.isFinite(y);
			return xf && yf ? +(y < x) - +(x < y) : +xf - +yf;
		},
		sortDescFirst: true,
	}, {
		header: (c: any) => <span onClick={c.header.column.getToggleSortingHandler()} title="pts vs the 50% neutral point; not a race win rate">vs Base</span>,
		id: 'gsbase',
		// Sorting on winRate is monotone in (winRate - 0.5), so the accessor can
		// stay the raw rate and keep the existing NaN-to-bottom ordering.
		accessorFn: (row: SkillChartResult) => row.globalsim?.winRate ?? NaN,
		cell: (info: any) => {
			const gs = info.row.original.globalsim;
			if (!gs) return <span>—</span>;
			if (!Number.isFinite(gs.winRate)) return <span>—</span>;
			const pts = gs.winRate * 100 - 50;
			// Same -0 guard as formatBasinn: -0.4 pts shows as "0", not "-0".
			const shown = Math.abs(pts) < 0.5 ? '0' : `${pts > 0 ? '+' : '-'}${Math.abs(pts).toFixed(0)}`;
			return (
				<span title={`${pts >= 0 ? '+' : '-'}${Math.abs(pts).toFixed(1)} pts · ahead ${(gs.winRate * 100).toFixed(1)}% · behind ${(gs.lossRate * 100).toFixed(1)}% · tie ${(gs.tieRate * 100).toFixed(1)}%`}>
					{shown}
				</span>
			);
		},
		sortingFn: (a: any, b: any) => {
			const x = a.getValue('gsbase'); const y = b.getValue('gsbase');
			const xf = Number.isFinite(x); const yf = Number.isFinite(y);
			return xf && yf ? +(y < x) - +(x < y) : +xf - +yf;
		},
		sortDescFirst: true,
	}] satisfies ColumnDef<SkillChartResult, any>[] : []),
	{
		header: (c) => <span onClick={c.header.column.getToggleSortingHandler()}>SP Cost</span>,
		id: 'spcost',
		accessorFn: (row) => ({ id: row.id, hint: props.hints.get(row.id) || 0 }),
		cell: (info) => (
			<SkillCostCell
				{...info.getValue()}
				hints={props.hints}
				ownedSkills={props.hasSkills}
				updateHint={props.updateHint}
			/>
		),
		sortingFn: (a, b) => {
			const ac = calculateSkillCost(a.getValue('id'), props.hints, props.hasSkills);
			const bc = calculateSkillCost(b.getValue('id'), props.hints, props.hasSkills);
			return +(bc < ac) - +(ac < bc);
		},
		sortDescFirst: false
	}, {
		header: (c) => <span onClick={c.header.column.getToggleSortingHandler()}>L / SP</span>,
		id: 'bsp',
		accessorFn: (row) => row.mean / calculateSkillCost(row.id, props.hints, props.hasSkills),
		cell: (info) => {
			const x = info.getValue();
			return <span>{Number.isFinite(x) ? x.toFixed(6) : '--'}</span>;
		},
		sortingFn: (a, b) => {
			const x = a.getValue('bsp');
			const y = b.getValue('bsp');
			const xf = Number.isFinite(x);
			const yf = Number.isFinite(y);
			return xf && yf ? +(y < x) - +(x < y) : +xf - +yf;
		},
		sortDescFirst: true
	}], [selectedType, props.showUmaIcons, props.hints, props.hasSkills, radioGroup, props.onHideSkill, gsActive]);

	const [sorting, setSorting] = useState<SortingState>([{ id: 'median', desc: true }]);

	const table = useReactTable({
		columns,
		data: filteredData,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		onSortingChange: setSorting,
		enableSortingRemoval: false,
		state: { sorting }
	});

	function handleClick(e: MouseEvent) {
		const tr = (e.target as HTMLElement).closest('tr');
		if (tr == null) return;
		e.stopPropagation();

		const id = tr.dataset.skillid;
		if (!id) return;

		if ((e.target as HTMLElement).tagName === 'IMG') {
			props.onInfoClick(id);
			return;
		}

		// Single click: update track visualization
		props.onSelectionChange(id);
	}

	function handleDblClick(e: MouseEvent) {
		const tr = (e.target as HTMLElement).closest('tr');
		if (tr == null) return;
		e.stopPropagation();
		e.preventDefault();

		const id = tr.dataset.skillid;
		if (!id) return;

		if ((e.target as HTMLElement).tagName === 'IMG') {
			return;
		}

		// Double click: add skill to uma
		props.onDblClickRow(id);
	}

	// IntersectionObserver virtualization — only render cells for visible rows.
	// The observer is created ONCE per mount. It used to be memoized on
	// props.data, and the parent streams a fresh Array.from(...) per paint, so
	// every streamed chart update disconnected the observer and re-observed
	// every row (and left in-view rows unobserved, since only the placeholder
	// branch had a ref). The effect runs after refs are attached, so
	// root.current is the real scroll container; its initial sweep adopts the
	// rows rendered before the effect ran, and the ref callbacks (on both row
	// branches, observe() is a no-op for already-observed elements) adopt rows
	// mounted/reused by later data updates — no teardown, no re-observation.
	const root = useRef<HTMLDivElement>(null);
	const inView = useRef(new Map<string, boolean>());
	const [, forceRerender] = useState(false);
	const obsRef = useRef<IntersectionObserver | null>(null);
	const observeRow = (el: Element | null) => { if (el) obsRef.current?.observe(el); };
	useEffect(() => {
		const obs = new IntersectionObserver((entries) => {
			entries.forEach(entry => inView.current.set((entry.target as HTMLElement).dataset.skillid!, entry.isIntersecting));
			forceRerender({} as any);
		}, {
			root: root.current,
			rootMargin: "68px 0px 68px 0px"
		});
		obsRef.current = obs;
		root.current?.querySelectorAll('tr[data-skillid]').forEach(el => obs.observe(el));
		return () => {
			obs.disconnect();
			obsRef.current = null;
		};
	}, []);

	return (
		<div class={`v2-skill-chart-wrapper${props.dirty ? ' dirty' : ''}`} ref={root}>
			<table class="v2-skill-chart-table">
				{gsActive && (
					<caption class="v2-skill-chart-note" style={{ captionSide: 'top', textAlign: 'left', fontSize: 12, opacity: 0.75, padding: '4px 8px' }}>
						Each number is what this one skill adds when swapped into the current build
						(replacing an owned skill from its group), at level 3, against the current field on this setup.
						It is not a general rating of the skill. SP Cost is what it costs this build with your hints.
					</caption>
				)}
				<thead>
					{table.getHeaderGroups().map(headerGroup => (
						<tr key={headerGroup.id}>
							{headerGroup.headers.map(header => (
								<th key={header.id} colSpan={header.colSpan}>
									{!header.isPlaceholder && (
										<div
											class={`v2-column-header ${({
												'asc': 'sorted-asc',
												'desc': 'sorted-desc',
												'false': ''
											})[header.column.getIsSorted() as string]}`}
											title={header.column.getCanSort() ? ({
												'asc': 'Sort ascending',
												'desc': 'Sort descending',
												'false': 'Clear sort'
											})[header.column.getNextSortingOrder() as string] : ''}
										>
											{flexRender(header.column.columnDef.header, header.getContext())}
										</div>
									)}
								</th>
							))}
						</tr>
					))}
				</thead>
				<tbody onClick={handleClick} onDblClick={handleDblClick}>
					{table.getRowModel().rows.map(row => {
						const id = row.getValue('id') as string;

						if (inView.current.get(id)) {
							return (
								<tr key={row.id} data-skillid={id} ref={observeRow} class={props.selectedSkillId === id ? 'selected' : ''}>
									{row.getAllCells().map(cell => (
										<td key={cell.id}>
											{flexRender(cell.column.columnDef.cell, cell.getContext())}
										</td>
									))}
								</tr>
							);
						} else {
							return <tr key={row.id} data-skillid={id} ref={observeRow}>{skillDisplayName(id)}</tr>;
						}
					})}
				</tbody>
			</table>
		</div>
	);
}
