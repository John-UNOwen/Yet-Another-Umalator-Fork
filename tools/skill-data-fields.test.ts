/**
 * umalator-global/skill_data.json must keep the fields the GlobalSim engine's
 * request parser reads: load_skill_value() requires alternatives, rarity,
 * condition, baseDuration, effects(type/target/modifier), and the retail-init
 * path requires an integer wisdomCheck for every skill a race carries. The JP
 * source table has no wisdomCheck, so a fast-forward or upstream sync that
 * drops it fails here instead of at engine prepare.
 *
 * The second test compares the field to the vendored engine table by id, so a
 * value drift (or a JP-only entry the engine cannot run) is caught too. It
 * skips when the vendor/GlobalSim submodule is not checked out.
 *
 * Run via: npm run test:skill-data-fields
 */
import test from 'tape';
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.join(__dirname, '..');
const skillData: Record<string, any> = JSON.parse(fs.readFileSync(path.join(repoRoot, 'umalator-global', 'skill_data.json'), 'utf8'));
const engineTablePath = path.join(repoRoot, 'vendor', 'GlobalSim', 'data', 'skill_data.json');

const isInt = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v);

test('skill_data.json carries every field the engine requires', t => {
	const problems: string[] = [];
	const entries = Object.entries(skillData);
	t.ok(entries.length > 1000, `${entries.length} skill entries present`);
	for (const [id, def] of entries) {
		if (!isInt(def.rarity)) problems.push(`${id}: rarity is not an integer`);
		if (!isInt(def.wisdomCheck) || (def.wisdomCheck !== 0 && def.wisdomCheck !== 1)) {
			problems.push(`${id}: wisdomCheck is not an integer 0/1 (${JSON.stringify(def.wisdomCheck)})`);
		}
		if (!Array.isArray(def.alternatives) || def.alternatives.length === 0) {
			problems.push(`${id}: alternatives is not a non-empty array`);
			continue;
		}
		for (const [i, alt] of def.alternatives.entries()) {
			const where = `${id}.alternatives[${i}]`;
			if (typeof alt.condition !== 'string') problems.push(`${where}: condition is not a string`);
			if (typeof alt.precondition !== 'undefined' && typeof alt.precondition !== 'string') problems.push(`${where}: precondition is not a string`);
			if (typeof alt.baseDuration !== 'number' || !Number.isFinite(alt.baseDuration)) problems.push(`${where}: baseDuration is not a number`);
			if (!Array.isArray(alt.effects)) { problems.push(`${where}: effects is not an array`); continue; }
			for (const [j, effect] of alt.effects.entries()) {
				const at = `${where}.effects[${j}]`;
				if (!isInt(effect?.type)) problems.push(`${at}: type is not an integer`);
				if (!isInt(effect?.target)) problems.push(`${at}: target is not an integer`);
				if (typeof effect?.modifier !== 'number' || !Number.isFinite(effect.modifier)) problems.push(`${at}: modifier is not a number`);
			}
		}
	}
	t.deepEqual(problems, [], 'every entry satisfies the engine-required fields');
	t.end();
});

test('skill_data.json wisdomCheck matches the vendored engine table by id', t => {
	if (!fs.existsSync(engineTablePath)) {
		t.skip('vendor/GlobalSim not checked out: run git submodule update --init to compare wisdomCheck');
		t.end();
		return;
	}
	const engineTable: Record<string, any> = JSON.parse(fs.readFileSync(engineTablePath, 'utf8'));
	const unmatched: string[] = [];
	const drift: string[] = [];
	for (const [id, def] of Object.entries(skillData)) {
		const engineDef = engineTable[id];
		if (!engineDef) { unmatched.push(id); continue; }
		if (def.wisdomCheck !== engineDef.wisdomCheck) drift.push(`${id}: app=${JSON.stringify(def.wisdomCheck)} engine=${JSON.stringify(engineDef.wisdomCheck)}`);
	}
	t.equal(unmatched.length, 0, `every skill id has an engine-table row${unmatched.length ? ` (missing: ${unmatched.slice(0, 10).join(', ')})` : ''}`);
	t.deepEqual(drift, [], 'no wisdomCheck drift from vendor/GlobalSim/data/skill_data.json');
	t.end();
});
