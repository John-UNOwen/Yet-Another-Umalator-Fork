/**
 * The drift check against docs/master.mdb: the shipped data matches, and planted
 * drift on live skills is reported while JP-only entries are never compared.
 * Skips when docs/master.mdb is absent.
 *
 * Run via: npm run test:skill-drift
 */
import test from 'tape';
import * as fs from 'fs';
import * as path from 'path';
import { formatDrift, liveSkillDrift, mdbIds, openMasterMdb } from './skill-drift';

const skillData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'umalator-global', 'skill_data.json'), 'utf8'));

test('skill_data.json live skills against master.mdb', t => {
	const db = openMasterMdb();
	if (!db) {
		t.skip('docs/master.mdb missing: pull it with tools/pull-master-mdb.sh');
		t.end();
		return;
	}
	try {
		const live = mdbIds(db, 'skill_data');
		const clean = liveSkillDrift(db, skillData);
		t.ok(clean.checked > 600, `${clean.checked} live skills compared`);
		t.equal(clean.checked, Object.keys(skillData).filter(id => live.has(Number(id))).length, 'every live id in skill_data.json is compared');
		t.deepEqual(clean.drifted, [], 'the shipped skill_data.json matches master.mdb');

		// Plant the 2026-07-30 drift: 100051 back on its JP condition, a scenario
		// skill without its 1.2 patch, and a JP-only entry nobody can check.
		const planted = JSON.parse(JSON.stringify(skillData));
		planted['100051'].alternatives[0].condition = 'is_finalcorner==1&corner==0&order_rate<=30&behind_near_lane_time_set1>=1';
		const scenario = '210011';
		planted[scenario].alternatives[0].effects[0].modifier /= 1.2;
		const jpOnly = Object.keys(planted).find(id => !live.has(Number(id)))!;
		planted[jpOnly].alternatives[0].condition = 'always==1';

		const dirty = liveSkillDrift(db, planted);
		t.deepEqual(dirty.drifted, [
			{ id: '100051', fields: ['condition'] },
			{ id: scenario, fields: ['effects'] },
		], 'planted drift on live skills is reported, the JP-only edit is not');
		const text = formatDrift(dirty);
		t.equal(text[0], '⚠️ [STALE DATA] 2 Global-live skill(s) no longer match master.mdb', 'report headline');
		t.ok(text.some(l => l.includes('100051: condition')), 'report names the id and field');
	} finally {
		db.close();
	}
	t.end();
});
