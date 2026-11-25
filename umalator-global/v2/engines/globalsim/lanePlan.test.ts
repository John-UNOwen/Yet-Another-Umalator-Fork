/**
 * The Settings lane-plan line: what the server verdict turns into.
 * Run: npx ts-node ... umalator-global/v2/engines/globalsim/lanePlan.test.ts
 */

import test from 'tape';
import { lanePlanOf, lastJobLine, plannedNativeThreads } from './lanePlan';

test('lane plan: a ready device names itself and its measured cost', t => {
	const plan = lanePlanOf({
		gpu: { ok: true, device: 'Intel(R) Arc(TM) B580 Graphics', floorMs: 625, slopeMsPerRace: 2.96, parityOk: true },
		threads: 6, cores: 20,
	});
	t.equal(plan.state, 'on');
	t.ok(plan.headline.includes('B580'), 'the headline names the device');
	t.ok(plan.detail.includes('Native threads: 6'), 'six threads fit under the budget unchanged');
	t.ok(plan.detail.includes('625 ms'), 'the floor is shown');
	t.ok(plan.detail.includes('3.0 ms per race'), 'the slope is shown rounded');
	t.end();
});

test('lane plan: native threads make room for the lane at the top of the budget', t => {
	t.equal(plannedNativeThreads(6, 20, true), 6, 'a free core means the lane rides on top');
	t.equal(plannedNativeThreads(19, 20, true), 18, 'at cores - 1 the lane takes one slot');
	t.equal(plannedNativeThreads(19, 20, false), 19, 'no lane keeps every thread');
	t.equal(plannedNativeThreads(1, 20, true), 1, 'one thread stays one thread');
	const plan = lanePlanOf({ gpu: { ok: true, device: 'B580' }, threads: 19, cores: 20 });
	t.ok(plan.detail.includes('Native threads: 18'), 'the plan shows the budgeted count');
	t.end();
});

test('lane plan: a refusal says why the lane is off', t => {
	const plan = lanePlanOf({
		gpu: { ok: false, reasons: ['no GPU passes the exactness gate: A770: no cl_khr_fp64'] },
		threads: 19, cores: 20,
	});
	t.equal(plan.state, 'off');
	t.ok(plan.detail.includes('CPU lanes only'), 'the fallback is named');
	t.ok(plan.detail.includes('cl_khr_fp64'), 'the reason is kept');
	t.end();
});

test('lane plan: a pending check says so', t => {
	const plan = lanePlanOf({ gpu: { ok: false, pending: true }, threads: 6, cores: 20 });
	t.equal(plan.state, 'pending');
	t.ok(plan.headline.includes('checking'), 'the headline says it is checking');
	t.end();
});

test('lane plan: a server without a gpu field reports no lane', t => {
	const plan = lanePlanOf({ gpu: null, threads: 4 });
	t.equal(plan.state, 'off');
	t.ok(plan.detail.includes('4'), 'the thread count is still reported');
	t.end();
});

test('last job line: races, time, rate and the thread count', t => {
	t.equal(lastJobLine(null), null, 'no run means no line');
	t.equal(lastJobLine({ label: 'Skill chart', races: 0, ms: 500, threads: 1 }), null, 'a zero-race run adds nothing');
	const one = lastJobLine({ label: 'Skill chart', races: 4550, ms: 27900, threads: 1 });
	t.equal(one, 'Last job: Skill chart, 4,550 races in 27.9 s (163 races/s) on 1 thread.');
	const many = lastJobLine({ label: 'Compare', races: 1000, ms: 1600, threads: 19 });
	t.equal(many, 'Last job: Compare, 1,000 races in 1.6 s (625 races/s) on 19 threads.');
	const quick = lastJobLine({ label: 'Compare', races: 12, ms: 240, threads: 2 });
	t.equal(quick, 'Last job: Compare, 12 races in 240 ms (50 races/s) on 2 threads.');
	t.end();
});
