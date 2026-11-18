/**
 * User settings on top of the effort presets (applyTuning): no settings leaves
 * a preset untouched, values clamp to TUNING_LIMITS, and each setting lands on
 * the field the search reads.
 */

import test from 'tape';
import {
	applyTuning, effortConfig, KICK_GROW_AFTER, kickLevelOf, SEED_LIST_SIZE, STANDARD, THOROUGH, TUNING_LIMITS, UNTIL_STOPPED,
} from './config';

test('applyTuning without settings returns the preset unchanged', t => {
	for (const p of ['quick', 'standard', 'thorough', 'custom', 'untilStopped'] as const) {
		const cfg = effortConfig(p);
		t.deepEqual(applyTuning(cfg), cfg, `${p}: identical`);
		t.deepEqual(applyTuning(cfg, { deltaMinL: undefined, verifySeeds: NaN }), cfg, `${p}: blank and NaN fields are ignored`);
	}
	t.end();
});

test('applyTuning puts each setting on the field the search reads', t => {
	const c = applyTuning(STANDARD, {
		deltaMinL: 0.01, verifySeeds: 800, contribSeeds: 500, buildsShown: 8,
		kicksPerStart: 6, kickGrowAfter: 2, spreadMinDiff: 4, spreadNoise: 0.5,
	});
	t.equal(c.deltaMinL, 0.01, 'smallest gain');
	t.equal(c.gSeedsMin, 800, 'verification races');
	t.equal(c.gSeedsCap, 3200, 'verification cap grows to 4x');
	t.equal(c.contribSeeds, 500, 'worth races');
	t.equal(c.shortlistSize, 8, 'builds shown');
	t.equal(c.kicks, 6, 'a finite preset takes the kick count directly');
	t.equal(c.kicksPerVisit, undefined, 'and has no per-visit count');
	t.equal(c.kickGrowAfter, 2, 'kick growth');
	t.equal(c.spreadMinDiff, 4, 'start spread');
	t.equal(c.spreadNoise, 0.5, 'spread noise');
	t.equal(STANDARD.deltaMinL, 0.03, 'the preset object itself is not changed');
	const u = applyTuning(UNTIL_STOPPED, { kicksPerStart: 4 });
	t.equal(u.kicks, Infinity, 'Until stopped keeps kicking pass after pass');
	t.equal(u.kicksPerVisit, 4, 'so the setting is the count per visit');
	t.equal(applyTuning(UNTIL_STOPPED, { kicksPerStart: 0 }).kicksPerVisit, 0, 'and 0 there means no kicks, as on a finite preset');
	t.end();
});

test('applyTuning clamps to TUNING_LIMITS and rounds counts', t => {
	const lo = applyTuning(THOROUGH, {
		deltaMinL: 0, verifySeeds: 1, contribSeeds: 1, buildsShown: 0,
		kicksPerStart: -3, kickGrowAfter: 0, spreadMinDiff: 0, spreadNoise: -1,
	});
	const L = TUNING_LIMITS;
	t.equal(lo.deltaMinL, L.deltaMinL.min, 'smallest gain floor');
	t.equal(lo.gSeedsMin, L.verifySeeds.min, 'verification floor');
	t.equal(lo.contribSeeds, L.contribSeeds.min, 'worth floor');
	t.equal(lo.shortlistSize, L.buildsShown.min, 'builds shown floor');
	t.equal(lo.kicks, L.kicksPerStart.min, 'kicks floor');
	t.equal(lo.kickGrowAfter, L.kickGrowAfter.min, 'growth floor');
	t.equal(lo.spreadMinDiff, L.spreadMinDiff.min, 'spread floor');
	t.equal(lo.spreadNoise, L.spreadNoise.min, 'noise floor');
	const hi = applyTuning(THOROUGH, { verifySeeds: 1e9, buildsShown: 7.6 });
	t.equal(hi.gSeedsMin, L.verifySeeds.max, 'verification ceiling');
	t.ok(hi.gSeedsCap <= SEED_LIST_SIZE, 'the cap stays inside the verify seed list');
	// Finding 1: every allowed setting, not just the ceiling.
	for (const v of [5_001, 8_000, L.verifySeeds.max]) {
		const c = applyTuning(THOROUGH, { verifySeeds: v });
		t.ok(c.gSeedsCap <= SEED_LIST_SIZE && c.gSeedsMin <= c.gSeedsCap, `verifySeeds ${v}: cap ${c.gSeedsCap} fits the list`);
	}
	t.equal(hi.shortlistSize, 8, 'counts round');
	t.end();
});

test('kickLevelOf takes the growth setting', t => {
	t.equal(kickLevelOf(KICK_GROW_AFTER), 1, 'default threshold');
	t.equal(kickLevelOf(2, 2), 1, 'grows after 2 with a setting of 2');
	t.equal(kickLevelOf(1, 2), 0, 'not before');
	t.equal(kickLevelOf(5, 0), 2, 'a setting of 0 counts as 1');
	t.end();
});
