/**
 * The list of skills that left a candidate pool, shared by the Skill tab and the
 * Skill Optimizer: one line per skill with the reason, an "include anyway" box per
 * skill, and a master switch for the filter.
 */
import { h } from 'preact';
import type { PoolExclusion } from './skill-chart-utils';
import skillnames from '../skillnames.json';

const skillName = (id: string): string => {
	const names = (skillnames as Record<string, string[]>)[id];
	return names?.[names.length - 1] || names?.[0] || id;
};

export interface PoolExclusionListProps {
	excluded: readonly PoolExclusion[];
	/** Ids the user put back into the pool. */
	included: ReadonlySet<string>;
	onToggle: (id: string) => void;
	/** The master switch: off puts every skill back except the ones the engine cannot run. */
	focusOn: boolean;
	onFocusChange: (on: boolean) => void;
	disabled?: boolean;
	/** Extra line under the switch, e.g. when changes apply. */
	note?: string;
}

export function PoolExclusionList(props: PoolExclusionListProps) {
	const { excluded, included, onToggle, focusOn, onFocusChange, disabled, note } = props;
	if (!excluded.length) return null;
	const back = excluded.filter(e => e.kind !== 'engine' && (!focusOn || included.has(e.id))).length;
	const leftOut = excluded.length - back;
	return (
		<details class="v2-pool-exclusions" style={{ fontSize: 12 }}>
			<summary style={{ cursor: 'pointer', opacity: 0.8 }}>
				{leftOut} skill{leftOut === 1 ? '' : 's'} left the pool
				{back > 0 ? ` · ${back} put back` : ''}
			</summary>
			<label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '4px 0', cursor: 'pointer' }}
				title="Leave out skills whose own condition cannot hold in this race, or that the app check finds no activation window for. Turning this off puts them all back, so the run simulates them too.">
				<input type="checkbox" checked={focusOn} disabled={disabled} onChange={() => onFocusChange(!focusOn)} />
				<span>Leave out skills that cannot fire here</span>
			</label>
			{note && <div style={{ opacity: 0.7, marginBottom: 4 }}>{note}</div>}
			<div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid rgba(128,128,128,0.3)', borderRadius: 6, padding: 4 }}>
				{excluded.map(e => {
					const engine = e.kind === 'engine';
					return (
						<label key={e.id} class="v2-pool-exclusion" style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '2px 4px', cursor: engine ? 'default' : 'pointer', opacity: engine ? 0.6 : 1 }}
							title={engine ? 'The engine has no definition for this skill, so it cannot be simulated' : 'Include anyway'}>
							<input type="checkbox" checked={!engine && (!focusOn || included.has(e.id))}
								disabled={disabled || engine || !focusOn} onChange={() => onToggle(e.id)} />
							<span style={{ flex: '0 1 auto' }}>{skillName(e.id)}</span>
							<span style={{ flex: 1, opacity: 0.7 }}>{e.reason}</span>
							<span style={{ opacity: 0.5 }}>{e.id}</span>
						</label>
					);
				})}
			</div>
		</details>
	);
}
