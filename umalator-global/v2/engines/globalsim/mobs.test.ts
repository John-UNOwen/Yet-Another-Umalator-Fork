/**
 * Phase 3 mob-field tests: every race is exactly 9 runners; the tested uma's
 * gate is seed-derived and IDENTICAL within a compare pair (same seed, two
 * races); mobs fill the remaining gates in fixed order; fixed-gate mode works
 * and validates.
 *
 * Run via: npm run test:globalsim-mobs
 */
// (globalThis).CC_GLOBAL must exist before the imports below are required:
// HorseDefTypes' Record defaults read this esbuild-time constant (see
// adapter.test.ts's note — statements before imports keep source order in CJS).
(globalThis as any).CC_GLOBAL = true;

import test from 'tape';
import * as fs from 'fs';
import * as path from 'path';
import { parseMobPresets, buildMobField, deriveGate, FIELD_SIZE } from './mobs';

const presetsFile = path.join(__dirname, 'mob-presets.json');
const raw = JSON.parse(fs.readFileSync(presetsFile, 'utf8'));

test('default preset parses cleanly', (t) => {
	const { presets, errors } = parseMobPresets(raw);
	t.same(errors, [], 'no parse errors');
	t.ok(presets['default'], 'default preset present');
	t.equal(presets['default'].runners.length, FIELD_SIZE - 1, '8 mob runners');
	const styles = presets['default'].runners.map((r: any) => r.strategy);
	for (const s of ['Nige', 'Senkou', 'Sasi', 'Oikomi']) {
		t.equal(styles.filter((x: string) => x === s).length, 2, `2 × ${s}`);
	}
	t.end();
});

test('preset validation rejects bad input', (t) => {
	const bad = JSON.parse(JSON.stringify(raw));
	bad.default.runners = bad.default.runners.slice(0, 7);
	t.ok(parseMobPresets(bad).errors.length > 0, 'wrong mob count rejected');
	const bad2 = JSON.parse(JSON.stringify(raw));
	bad2.default.runners[0].strategy = 'Sashi'; // engine alias, not canonical UI spelling
	t.ok(parseMobPresets(bad2).errors.length > 0, 'non-canonical strategy rejected');
	const bad3 = JSON.parse(JSON.stringify(raw));
	bad3.default.runners[2].speed = 2500;
	t.ok(parseMobPresets(bad3).errors.length > 0, 'out-of-range stat rejected');
	t.end();
});

test('field is 9 runners with unique gates', (t) => {
	const { presets } = parseMobPresets(raw);
	for (const seed of [0, 1, 12345, 2147483647, -2147483648]) {
		const { playerGate, mobs, errors } = buildMobField(presets['default'], seed);
		t.same(errors, [], `seed ${seed}: no errors`);
		t.equal(mobs.length, 8, `seed ${seed}: 8 mobs`);
		const gates = new Set([playerGate, ...mobs.map((m) => m.gateIndex)]);
		t.equal(gates.size, FIELD_SIZE, `seed ${seed}: 9 unique gates`);
		for (const g of gates) t.ok(g >= 0 && g < FIELD_SIZE, `seed ${seed}: gate ${g} in range`);
	}
	t.end();
});

test('same seed ⇒ same tested-uma gate in both races of a pair; field identical', (t) => {
	const { presets } = parseMobPresets(raw);
	for (const seed of [1000000, 1000001, 42]) {
		const raceA = buildMobField(presets['default'], seed);
		const raceB = buildMobField(presets['default'], seed);
		t.equal(raceA.playerGate, raceB.playerGate, `seed ${seed}: paired gate matches`);
		t.equal(JSON.stringify(raceA.mobs), JSON.stringify(raceB.mobs), `seed ${seed}: paired field matches`);
	}
	t.end();
});

test('gate draw spreads across seeds and is stable over repeats', (t) => {
	const seen = new Set<number>();
	for (let seed = 1000000; seed < 1000100; seed++) seen.add(deriveGate(seed));
	t.ok(seen.size === FIELD_SIZE, `100 consecutive seeds cover all ${FIELD_SIZE} gates (got ${seen.size})`);
	t.equal(deriveGate(1000000), deriveGate(1000000), 'repeat-stable');
	t.end();
});

test('fixed-gate mode', (t) => {
	const { presets } = parseMobPresets(raw);
	const { playerGate, mobs, errors } = buildMobField(presets['default'], 123, { fixedGate: 4 });
	t.same(errors, [], 'fixed gate accepted');
	t.equal(playerGate, 4, 'tested uma sits on the fixed gate');
	t.ok(!mobs.some((m) => m.gateIndex === 4), 'no mob on the player gate');
	const bad = buildMobField(presets['default'], 123, { fixedGate: 9 });
	t.ok(bad.errors.length > 0, 'out-of-range fixed gate rejected');
	t.end();
});
