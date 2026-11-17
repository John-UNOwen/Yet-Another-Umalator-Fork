/**
 * Which Global-live skills in umalator-global/skill_data.json no longer match
 * docs/master.mdb.
 *
 * skill_data.json is a JP superset: the skills live on Global plus the ones
 * fast-forwarded from JP. Only the live ones (ids present in the mdb) are
 * compared, and nothing is ever rewritten here: a drift report is the cue to
 * re-run the merge described in CLAUDE.md ("Keeping skill_data.json in sync").
 *
 * Reads the mdb with node:sqlite (Node 22.5 or later), so the sqlite3 CLI is
 * not needed.
 *
 *   npx ts-node --transpile-only tools/skill-drift.ts [path/to/master.mdb]
 *
 * Exit code 0 with no drift, 1 with drift, 2 when the mdb cannot be read.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO = path.resolve(__dirname, '..');
export const GLOBAL_MASTER_MDB = path.join(REPO, 'docs', 'master.mdb');
const SKILL_DATA = path.join(REPO, 'umalator-global', 'skill_data.json');

/**
 * make_skill_data.pl patch_modifier(): these scenario skills are stored at 1.2×
 * the mdb value on purpose, so the comparison applies the same factor.
 */
const SCENARIO_X1_2 = new Set([
	210011, 210012, 210021, 210022, 210031, 210032, 210041, 210042, 210051, 210052,
	210061, 210062, 210071, 210072, 210081, 210082,
	210261, 210262, 210271, 210272, 210281, 210282, 210291,
]);

/** node:sqlite's DatabaseSync, loaded lazily so a missing module only disables the check. */
export function openMasterMdb(file: string = GLOBAL_MASTER_MDB): any | null {
	if (!fs.existsSync(file)) return null;
	// A plain require keeps ts-node from needing node:sqlite type definitions.
	const { DatabaseSync } = require('node:sqlite');
	return new DatabaseSync(file, { readOnly: true });
}

/** Every id in one mdb table, as numbers. */
export function mdbIds(db: any, table: 'skill_data' | 'chara_data' | 'card_data'): Set<number> {
	return new Set((db.prepare(`SELECT id FROM ${table}`).all() as { id: number }[]).map(r => Number(r.id)));
}

interface Effect { type: number; modifier: number; target: number }
interface Alternative { precondition: string; condition: string; baseDuration: number; effects: Effect[] }

/** The alternatives make_skill_data.pl would emit for one mdb row (the fields compared). */
function alternativesFromRow(row: any): Alternative[] {
	const id = Number(row.id);
	const alts: Alternative[] = [];
	for (const k of [1, 2]) {
		const condition = String(row[`condition_${k}`] ?? '');
		if (k === 2 && (condition === '' || condition === '0')) continue;
		const effects: Effect[] = [];
		for (const e of [1, 2, 3]) {
			const type = Number(row[`ability_type_${k}_${e}`]);
			if (e > 1 && type === 0) continue;
			const raw = Number(row[`float_ability_value_${k}_${e}`]);
			effects.push({ type, modifier: SCENARIO_X1_2.has(id) ? raw * 1.2 : raw, target: Number(row[`target_type_${k}_${e}`]) });
		}
		alts.push({
			precondition: String(row[`precondition_${k}`] ?? ''),
			condition,
			baseDuration: Number(row[`float_ability_time_${k}`]),
			effects,
		});
	}
	return alts;
}

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

/** The fields of one skill that differ, empty when it matches. */
function diffSkill(json: any, mdb: Alternative[]): string[] {
	const alts: any[] = json?.alternatives ?? [];
	if (alts.length !== mdb.length) return [`alternatives (${alts.length} vs ${mdb.length} in master.mdb)`];
	const out: string[] = [];
	mdb.forEach((m, i) => {
		const j = alts[i];
		const at = mdb.length > 1 ? ` #${i + 1}` : '';
		if ((j.precondition ?? '') !== m.precondition) out.push(`precondition${at}`);
		if ((j.condition ?? '') !== m.condition) out.push(`condition${at}`);
		if (!close(Number(j.baseDuration), m.baseDuration)) out.push(`baseDuration${at}`);
		const je: any[] = j.effects ?? [];
		if (je.length !== m.effects.length
			|| m.effects.some((e, n) => Number(je[n].type) !== e.type || Number(je[n].target) !== e.target || !close(Number(je[n].modifier), e.modifier))) {
			out.push(`effects${at}`);
		}
	});
	return out;
}

export interface DriftReport {
	/** Live skills compared: ids in both skill_data.json and the mdb. */
	checked: number;
	drifted: { id: string; fields: string[] }[];
}

/** Compare the live skills of `skillData` against the mdb's skill_data table. */
export function liveSkillDrift(db: any, skillData: Record<string, any>): DriftReport {
	const rows = db.prepare('SELECT * FROM skill_data').all() as any[];
	const drifted: DriftReport['drifted'] = [];
	let checked = 0;
	for (const row of rows) {
		const id = String(row.id);
		if (!skillData[id]) continue;
		checked++;
		const fields = diffSkill(skillData[id], alternativesFromRow(row));
		if (fields.length) drifted.push({ id, fields });
	}
	drifted.sort((a, b) => Number(a.id) - Number(b.id));
	return { checked, drifted };
}

/** The report text, shared by this CLI and fast-forward-global.ts. */
export function formatDrift(report: DriftReport): string[] {
	if (!report.drifted.length) return [`  ${report.checked} Global-live skill(s) match master.mdb`];
	return [
		`⚠️ [STALE DATA] ${report.drifted.length} Global-live skill(s) no longer match master.mdb`,
		`  (of ${report.checked} live skills checked; re-run the merge in CLAUDE.md, skill_data.json was not changed)`,
		...report.drifted.map(d => `  ${d.id}: ${d.fields.join(', ')}`),
	];
}

if (require.main === module) {
	const file = process.argv[2] ? path.resolve(process.argv[2]) : GLOBAL_MASTER_MDB;
	let db: any;
	try {
		db = openMasterMdb(file);
	} catch (e: any) {
		console.error(`Could not open ${file}: ${e.message}`);
		process.exit(2);
	}
	if (!db) {
		console.error(`${file} not found. Pull it with tools/pull-master-mdb.sh.`);
		process.exit(2);
	}
	const report = liveSkillDrift(db, JSON.parse(fs.readFileSync(SKILL_DATA, 'utf8')));
	db.close();
	for (const line of formatDrift(report)) console.log(line);
	process.exit(report.drifted.length ? 1 : 0);
}
