import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

import { program, Option } from 'commander';

program
	.option('--debug')
	.option('--dry-run-umas', 'preview umas.json localization changes without writing')
	.option('--dry-run-skillnames', 'preview skillnames.json official-name sync without writing')
	.addOption(new Option('--serve [port]', 'run development server on [port]').preset(8000).implies({debug: true}));

program.parse();
const options = program.opts();
const port = options.serve;
const isDev = process.env.CF_PAGES_BRANCH === 'dev' || process.env.CC_DEV === 'true' || port != null;
const serve = port != null;
const debug = !!options.debug;

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dirname, '..');

const redirectData = {
	name: 'redirectData',
	setup(build) {
		build.onResolve({filter: /^\.\.?(?:\/uma-skill-tools)?\/data\//}, args => ({
			path: path.join(dirname, args.path.split('/data/')[1])
		}));
		build.onResolve({filter: /skill_meta.json$/}, args => ({
			path: path.join(dirname, 'skill_meta.json')
		}));
		build.onResolve({filter: /umas.json$/}, args => ({
			path: path.join(dirname, 'umas.json')
		}));
	}
};

const mockAssertFn = debug ? 'console.assert' : 'function(){}';
const mockAssert = {
	name: 'mockAssert',
	setup(build) {
		build.onResolve({filter: /^node:assert$/}, args => ({
			path: args.path, namespace: 'mockAssert-ns'
		}));
		build.onLoad({filter: /.*/, namespace: 'mockAssert-ns'}, () => ({
			contents: 'module.exports={strict:'+mockAssertFn+'};',
			loader: 'js'
		}));
	}
};

const redirectTable = {
	name: 'redirectTable',
	setup(build) {
		build.onResolve({filter: /^@tanstack\//}, args => ({
			path: path.join(dirname, '..', 'vendor', args.path.slice(10), 'index.ts')
		}));
	}
};

const seedrandomPlugin = {
	name: 'seedrandomPlugin',
	setup(build) {
		build.onResolve({filter: /^seedrandom$/}, args => ({
			path: args.path,
			namespace: 'seedrandom-ns'
		}));
		build.onLoad({filter: /.*/, namespace: 'seedrandom-ns'}, () => ({
			contents: `
// Simple seedrandom implementation for browser
export default function seedrandom(seed) {
	let x = 0;
	let y = 0;
	let z = 0;
	let w = 0;

	function next() {
		const t = x ^ (x << 11);
		x = y;
		y = z;
		z = w;
		w = w ^ (w >>> 19) ^ (t ^ (t >>> 8));
		return (w >>> 0) / 0x100000000;
	}

	// Simple seed initialization
	const str = seed.toString();
	for (let i = 0; i < str.length; i++) {
		x = (x * 31 + str.charCodeAt(i)) >>> 0;
	}

	return next;
}
			`,
			loader: 'js'
		}));
	}
};

// Regenerate not-in-game.json by diffing local data against Global master.mdb.
// When master.mdb is absent (e.g. on Cloudflare Pages CI), we leave the
// committed not-in-game.json alone — it's the source of truth at deploy time.
// (Previous behavior: fall back to diffing against `kachi-dev/master`, which
// is a different community fork and not authoritative for Global. That
// fallback could produce a wrong filter; it has been removed.)
function generateNotInGame() {
	const outPath = path.join(dirname, 'not-in-game.json');
	const masterDb = path.join(root, 'docs', 'master.mdb');

	if (!fs.existsSync(masterDb)) {
		const exists = fs.existsSync(outPath);
		console.log(
			`not-in-game.json: master.mdb not present — ${exists
				? 'leaving committed file alone'
				: 'no committed file either, writing empty list'}`
		);
		if (!exists) {
			fs.writeFileSync(outPath, JSON.stringify({ skills: [], outfits: [] }));
		}
		return;
	}

	try {
		const dbSkillsRaw = execSync(`sqlite3 "${masterDb}" "SELECT id FROM skill_data"`, { encoding: 'utf-8' });
		const dbSkills = new Set(dbSkillsRaw.trim().split('\n'));

		// docs/master.mdb is synced by hand and routinely lags the live client, which makes
		// already-released skills show a "Not in game" badge. Upstream regenerates their Global
		// skill_data.json from a current DB, so union their key set in.
		// UNION, not replace: upstream's generator drops scenario/bonus skills (its filter is
		// is_general_skill=1 OR rarity>=3), so swapping outright would wrongly flag skills the
		// mdb correctly reports as live. Refresh with tools/sync-global-live-skills.mjs.
		const livePath = path.join(dirname, 'global-live-skills.json');
		let upstreamLive = 0;
		if (fs.existsSync(livePath)) {
			const before = dbSkills.size;
			for (const id of JSON.parse(fs.readFileSync(livePath, 'utf-8')).skills || []) dbSkills.add(id);
			upstreamLive = dbSkills.size - before;
		}
		const dbOutfitsRaw = execSync(`sqlite3 "${masterDb}" "SELECT id FROM card_data"`, { encoding: 'utf-8' });
		const dbOutfits = new Set(dbOutfitsRaw.trim().split('\n'));

		const localSkills = JSON.parse(fs.readFileSync(path.join(dirname, 'skill_data.json'), 'utf-8'));
		const localUmas = JSON.parse(fs.readFileSync(path.join(dirname, 'umas.json'), 'utf-8'));
		const localOutfits = Object.keys(localUmas).flatMap(id => Object.keys(localUmas[id].outfits || {}));

		const outfits = localOutfits.filter(id => !dbOutfits.has(id));
		// A not-in-game outfit's own unique skills are not in game either, even when
		// global-live-skills.json lists them (upstream's list carries JP uniques).
		// The ids follow uniqueSkillForUma in components/HorseDefTypes.ts: the 3-star
		// unique, its 1-2 star form and the inherited (9xxxxx) copy.
		const ownedUniques = new Set(outfits.flatMap(oid => {
			const i = +oid.slice(1, -2), v = +oid.slice(-2);
			const base = 10000 * (v - 1) + i * 10 + 1;
			return [100000 + base, 10000 + base, 900000 + base].map(String);
		}));
		const result = {
			skills: Object.keys(localSkills).filter(id => !dbSkills.has(id) || ownedUniques.has(id)),
			outfits
		};

		fs.writeFileSync(outPath, JSON.stringify(result));
		console.log(`not-in-game.json (master.mdb): ${result.skills.length} skills, ${result.outfits.length} outfits`
			+ (upstreamLive ? ` (${upstreamLive} more counted live via global-live-skills.json)` : ''));
	} catch (e) {
		console.warn(`Failed to regenerate not-in-game.json: ${e.message}. Leaving existing file in place.`);
	}
}

generateNotInGame();

// The skills the game's skill screen never sells, which master.mdb marks with a
// negative grade_value. The career import keeps them out of a snapshot's skill pool.
// Read with node:sqlite like tools/skill-drift.ts, so the sqlite3 CLI is not needed.
function generateCareerUnbuyable() {
	const outPath = path.join(dirname, 'career-unbuyable.json');
	const masterDb = path.join(root, 'docs', 'master.mdb');

	if (!fs.existsSync(masterDb)) {
		const exists = fs.existsSync(outPath);
		console.log(
			`career-unbuyable.json: master.mdb not present, ${exists
				? 'leaving the committed file alone'
				: 'no committed file either, writing empty list'}`
		);
		if (!exists) {
			fs.writeFileSync(outPath, JSON.stringify({ skills: [] }));
		}
		return;
	}

	try {
		// Loaded lazily so a Node without node:sqlite only skips this file.
		const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
		const db = new DatabaseSync(masterDb, { readOnly: true });
		let skills;
		try {
			const rows = db.prepare('SELECT id FROM skill_data WHERE grade_value < 0 ORDER BY id').all();
			skills = rows.map(r => String(r.id));
		} finally {
			db.close();
		}
		fs.writeFileSync(outPath, JSON.stringify({ skills }));
		console.log(`career-unbuyable.json (master.mdb): ${skills.length} skills`);
	} catch (e) {
		console.warn(`Failed to regenerate career-unbuyable.json: ${e.message}. Leaving existing file in place.`);
	}
}

generateCareerUnbuyable();

// The skill list each outfit brings to a career: master.mdb pairs card_data.available_skill_set_id
// with available_skill_set. The game offers these without a hint, gated on the uma's awakening level:
// each entry is [skillId, need_rank], where need_rank 0 is always offered and 2-5 needs that level.
function generateCareerCardSkills() {
	const outPath = path.join(dirname, 'career-card-skills.json');
	const masterDb = path.join(root, 'docs', 'master.mdb');

	if (!fs.existsSync(masterDb)) {
		const exists = fs.existsSync(outPath);
		console.log(
			`career-card-skills.json: master.mdb not present, ${exists
				? 'leaving the committed file alone'
				: 'no committed file either, writing empty list'}`
		);
		if (!exists) {
			fs.writeFileSync(outPath, JSON.stringify({}));
		}
		return;
	}

	try {
		const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
		const db = new DatabaseSync(masterDb, { readOnly: true });
		let byCard;
		try {
			const rows = db.prepare(
				`SELECT cd.id AS card, a.skill_id AS skill, a.need_rank AS needRank
				 FROM card_data cd JOIN available_skill_set a ON a.available_skill_set_id = cd.available_skill_set_id
				 ORDER BY cd.id, a.need_rank, a.id`
			).all();
			byCard = {};
			for (const r of rows) {
				const card = String(r.card);
				(byCard[card] ??= []).push([String(r.skill), Number(r.needRank)]);
			}
		} finally {
			db.close();
		}
		fs.writeFileSync(outPath, JSON.stringify(byCard));
		console.log(`career-card-skills.json (master.mdb): ${Object.keys(byCard).length} outfits`);
	} catch (e) {
		console.warn(`Failed to regenerate career-card-skills.json: ${e.message}. Leaving existing file in place.`);
	}
}

generateCareerCardSkills();

// Sync character/outfit names in umas.json from Global master.mdb.
// Outfits/charas not yet in the Global DB keep their existing (JP) strings;
// once they release on Global, the localized epithet replaces the JP one on
// the next build. Pass --dry-run-umas to preview without writing.
function syncUmaLocalizations() {
	const masterDb = path.join(root, 'docs', 'master.mdb');
	if (!fs.existsSync(masterDb)) {
		console.log('umas.json sync: master.mdb not present, skipping');
		return;
	}

	const dryRun = process.argv.includes('--dry-run-umas');
	const umasPath = path.join(dirname, 'umas.json');

	try {
	const umas = JSON.parse(fs.readFileSync(umasPath, 'utf-8'));

	// text_data category 5 = outfit epithet (e.g. "[Edomurasaki]")
	// text_data category 170 = character name (e.g. "Inari One")
	const epithetsRaw = execSync(
		`sqlite3 -separator $'\\t' "${masterDb}" "SELECT \\"index\\", text FROM text_data WHERE category = 5"`,
		{ encoding: 'utf-8' }
	);
	const epithets = new Map(
		epithetsRaw.trim().split('\n').filter(Boolean).map(line => {
			const tab = line.indexOf('\t');
			return [line.slice(0, tab), line.slice(tab + 1)];
		})
	);

	const namesRaw = execSync(
		`sqlite3 -separator $'\\t' "${masterDb}" "SELECT \\"index\\", text FROM text_data WHERE category = 170"`,
		{ encoding: 'utf-8' }
	);
	const names = new Map(
		namesRaw.trim().split('\n').filter(Boolean).map(line => {
			const tab = line.indexOf('\t');
			return [line.slice(0, tab), line.slice(tab + 1)];
		})
	);

	const changes = [];
	for (const [charaId, chara] of Object.entries(umas)) {
		const globalName = names.get(charaId);
		if (globalName && Array.isArray(chara.name) && chara.name[1] !== globalName) {
			changes.push(`${charaId} name: "${chara.name[1]}" → "${globalName}"`);
			chara.name[1] = globalName;
		}
		for (const [outfitId, current] of Object.entries(chara.outfits || {})) {
			const globalEpithet = epithets.get(outfitId);
			if (!globalEpithet) continue;
			// Outfits are stored either as the bare epithet string (fast-forwarded
			// chars) or as a full object with an `epithet` field (proper entries).
			if (typeof current === 'string') {
				if (current !== globalEpithet) {
					changes.push(`${outfitId}: "${current}" → "${globalEpithet}"`);
					chara.outfits[outfitId] = globalEpithet;
				}
			} else if (current && typeof current === 'object') {
				if (current.epithet !== globalEpithet) {
					changes.push(`${outfitId}: "${current.epithet}" → "${globalEpithet}"`);
					current.epithet = globalEpithet;
				}
			}
		}
	}

	if (changes.length === 0) {
		console.log('umas.json sync: no changes');
		return;
	}

	console.log(`umas.json sync: ${changes.length} change(s)${dryRun ? ' (dry run)' : ''}`);
	for (const c of changes) console.log(`  ${c}`);
	if (!dryRun) fs.writeFileSync(umasPath, JSON.stringify(umas, null, 2) + '\n');
	} catch (e) {
		// e.g. sqlite3 CLI not installed (Cloudflare build image) or a DB read
		// error. Non-fatal: keep the committed umas.json strings as-is, like
		// generateNotInGame() does for not-in-game.json.
		console.warn(`umas.json sync skipped: ${e.message}. Leaving existing file in place.`);
	}
}

syncUmaLocalizations();

// Sync skill names in skillnames.json from Global master.mdb.
// Fast-forwarded (not-yet-Global) skills keep their community names; once a skill
// releases on Global, its official localized name (text_data category 47) replaces
// the community one on the next build. Only skills present in the Global DB's
// skill_data (i.e. in-game) are touched. Pass --dry-run-skillnames to preview.
function syncSkillNames() {
	const masterDb = path.join(root, 'docs', 'master.mdb');
	if (!fs.existsSync(masterDb)) {
		console.log('skillnames.json sync: master.mdb not present, skipping');
		return;
	}

	const dryRun = process.argv.includes('--dry-run-skillnames');
	const namesPath = path.join(dirname, 'skillnames.json');

	try {
		const skillnames = JSON.parse(fs.readFileSync(namesPath, 'utf-8'));

		// In-game skill IDs (present in the Global DB).
		const inGameRaw = execSync(`sqlite3 "${masterDb}" "SELECT id FROM skill_data"`, { encoding: 'utf-8' });
		const inGame = new Set(inGameRaw.trim().split('\n').filter(Boolean));

		// Official English skill names (text_data category 47), keyed by skill id.
		const officialRaw = execSync(
			`sqlite3 -separator $'\\t' "${masterDb}" "SELECT \\"index\\", text FROM text_data WHERE category = 47"`,
			{ encoding: 'utf-8' }
		);
		const official = new Map(
			officialRaw.trim().split('\n').filter(Boolean).map(line => {
				const tab = line.indexOf('\t');
				return [line.slice(0, tab), line.slice(tab + 1)];
			})
		);

		// Skills upstream also ships are named by tools/sync-upstream-data.mjs, which takes
		// upstream's strings: it regenerates from a current client DB while docs/master.mdb
		// is synced by hand and lags it by weeks. Overriding those here would undo genuine
		// Cygames renames -- this is exactly how 202401 "Lightning Surge" kept reverting to
		// the stale "Flash Forward". So only name skills upstream has no opinion on.
		let upstreamNamed = new Set();
		try {
			const livePath = path.join(dirname, 'global-live-skills.json');
			if (fs.existsSync(livePath)) upstreamNamed = new Set(JSON.parse(fs.readFileSync(livePath, 'utf-8')).skills || []);
		} catch { /* fall through: without the list, behave as before */ }

		const changes = [];
		for (const id of inGame) {
			if (upstreamNamed.has(id)) continue;
			const off = official.get(id);
			if (!off) continue;
			const cur = skillnames[id];
			if (Array.isArray(cur) && cur[0] !== off) {
				changes.push(`${id}: "${cur[0]}" → "${off}"`);
				cur[0] = off;
			}
		}

		if (changes.length === 0) {
			console.log('skillnames.json sync: no changes');
			return;
		}

		console.log(`skillnames.json sync: ${changes.length} change(s)${dryRun ? ' (dry run)' : ''}`);
		for (const c of changes) console.log(`  ${c}`);
		if (!dryRun) fs.writeFileSync(namesPath, JSON.stringify(skillnames, null, '\t') + '\n');
	} catch (e) {
		// e.g. sqlite3 CLI absent on the Cloudflare build image, or a DB read error.
		// Non-fatal: keep the committed skillnames.json as-is, like the other syncs.
		console.warn(`skillnames.json sync skipped: ${e.message}. Leaving existing file in place.`);
	}
}

syncSkillNames();

// Generate v2/cm-presets.generated.json — Champions Meeting presets for Global.
// Global CM N replays JP CM N exactly (course + season/weather/ground/time),
// verified 1:1 against the shipped Global schedule. So:
//   - race conditions come from the JP DB (docs/master(1).mdb), available far ahead
//   - run dates come from the Global DB (authoritative) for CMs the client knows,
//     falling back to the hand/MANT-maintained v2/cm-dates.json for future CMs
//   - CM names are derived from the zodiac cycle (CM 1 = Taurus)
// A CM is only emitted once a Global date is resolvable; undated future CMs are
// skipped until their date is known.
function generateCMPresets() {
	const outPath = path.join(dirname, 'v2', 'cm-presets.generated.json');
	const jpDb = path.join(root, 'docs', 'master(1).mdb');
	const globalDb = path.join(root, 'docs', 'master.mdb');
	const datesPath = path.join(dirname, 'v2', 'cm-dates.json');

	if (!fs.existsSync(jpDb)) {
		const exists = fs.existsSync(outPath);
		console.log(
			`cm-presets: JP master.mdb (docs/master(1).mdb) not present — ${exists
				? 'leaving committed file alone'
				: 'no committed file either, skipping'}`
		);
		return;
	}

	try {
		// JP conditions per CM number (round 0 is representative; all rounds share conditions)
		const jpRaw = execSync(
			`sqlite3 -separator '|' "${jpDb}" "` +
			`SELECT cs.id, r.course_set, rc.season, rc.weather, rc.ground, ri.time ` +
			`FROM champions_schedule cs ` +
			`JOIN champions_race_condition crc ON crc.champions_id = cs.id AND crc.round_id = 0 ` +
			`JOIN race_instance ri ON ri.id = crc.race_instance_id ` +
			`JOIN race r ON r.id = ri.race_id ` +
			`JOIN race_condition rc ON rc.id = crc.race_condition_id ` +
			`ORDER BY cs.id"`,
			{ encoding: 'utf-8' }
		);
		const jp = new Map();
		for (const line of jpRaw.trim().split('\n').filter(Boolean)) {
			const [id, course, season, weather, ground, time] = line.split('|').map(Number);
			jp.set(id, { courseId: course, season, weather, ground, time });
		}

		// Authoritative Global run dates per CM number (when the client knows them)
		const globalDates = new Map();
		if (fs.existsSync(globalDb)) {
			const gRaw = execSync(
				`sqlite3 -separator '|' "${globalDb}" "SELECT id, strftime('%Y-%m-%d', start_date, 'unixepoch') FROM champions_schedule"`,
				{ encoding: 'utf-8' }
			);
			for (const line of gRaw.trim().split('\n').filter(Boolean)) {
				const [id, date] = line.split('|');
				globalDates.set(Number(id), date);
			}
		}

		// Hand/MANT date map for CMs beyond the Global client horizon
		let handDates = {};
		if (fs.existsSync(datesPath)) handDates = JSON.parse(fs.readFileSync(datesPath, 'utf-8'));

		const ZODIAC = ['Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo', 'Libra',
			'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces', 'Aries'];

		const out = [];
		for (const [id, cond] of jp) {
			const confirmed = globalDates.has(id);
			const date = globalDates.get(id) ?? handDates[id];
			if (!date) continue;  // no Global date known yet — can't place this event
			out.push({
				id,
				type: 0,  // EventType.CM
				name: `${ZODIAC[(id - 1) % 12]} Cup`,
				date,
				courseId: cond.courseId,
				season: cond.season,
				ground: cond.ground,
				weather: cond.weather,
				time: cond.time,
				confirmed,
			});
		}
		out.sort((a, b) => a.id - b.id);
		fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
		const nConfirmed = out.filter(p => p.confirmed).length;
		console.log(`cm-presets.generated.json: ${out.length} presets (${nConfirmed} confirmed, ${out.length - nConfirmed} from hand map)`);
	} catch (e) {
		console.warn(`Failed to regenerate cm-presets.generated.json: ${e.message}. Leaving existing file in place.`);
	}
}

generateCMPresets();

// Build the GlobalSim active skill table (v70 validated ∪ globalsim/skills-supplement.json)
// into globalsim/skills.json at the site root, where the v2 app fetches it as
// /uma-tools/globalsim/skills.json for its GlobalSim-mode skill gating (integration plan
// Phase 2). The same tool run is the coverage gate: a live-on-Global skill missing from
// the active table (or a malformed supplement) fails the build loudly rather than
// shipping a silent hole in the table.
function generateGlobalsimSkills() {
	const tool = path.join(root, 'tools', 'globalsim-coverage.mjs');
	const outPath = path.join(root, 'globalsim', 'skills.json');
	fs.mkdirSync(path.dirname(outPath), { recursive: true });
	let stdout;
	try {
		stdout = execSync(`node "${tool}" --out "${outPath}"`, { encoding: 'utf-8' });
	} catch (e) {
		const tail = `${e.stdout || ''}\n${e.stderr || ''}`.split('\n').filter(l => /^(ERROR|COVERAGE:)/.test(l)).join('\n');
		throw new Error(`globalsim/skills.json generation failed (node tools/globalsim-coverage.mjs):\n${tail || e.message}`);
	}
	const summary = stdout.split('\n').filter(l => /^(WARN |COVERAGE:)/.test(l)).join(' | ');
	console.log(`globalsim/skills.json: ${summary || 'generated'}`);
}

generateGlobalsimSkills();

// GlobalSim static assets for dev + Pages (integration plan Phase 4):
//   globalsim/wasm/      ← globalsim-wasm/pkg (the wasm-bindgen build)
//   globalsim/geometry/  ← vendor/GlobalSim/data/course_geometry/*.json (33 MB,
//                          skip-if-exists — they only change when the submodule moves)
//   globalsim/courses.json ← the engine course-id list the v2 adapter validates against
// The worker loads them at /uma-tools/globalsim/… — the same prefix rewrite
// skills.json uses (dev server strip, Vite dev plugin, Pages _redirects).
function generateGlobalsimAssets() {
	const site = path.join(root, 'globalsim');
	const pkgDir = path.join(root, 'globalsim-wasm', 'pkg');
	const wasmDst = path.join(site, 'wasm');
	fs.mkdirSync(wasmDst, { recursive: true });

	// (i) wasm pkg — copy when built; else try wasm-pack (PATH only — no
	// hardcoded user paths); else WARN loudly and continue: classic mode is
	// unaffected, GlobalSim compare fails at run time with a clear message.
	const pkgFiles = ['globalsim_wasm.js', 'globalsim_wasm_bg.wasm', 'globalsim_wasm.d.ts', 'globalsim_wasm_bg.wasm.d.ts'];
	const havePkg = fs.existsSync(path.join(pkgDir, 'globalsim_wasm.js')) && fs.existsSync(path.join(pkgDir, 'globalsim_wasm_bg.wasm'));
	if (!havePkg) {
		try {
			execSync('wasm-pack --version', { stdio: 'ignore' });
			console.log('globalsim/wasm: pkg missing — running wasm-pack build (globalsim-wasm, target web)…');
			execSync('wasm-pack build --target web --release --out-dir pkg', { cwd: path.join(root, 'globalsim-wasm'), stdio: 'inherit' });
		} catch {
			console.warn('*** globalsim-wasm/pkg is missing and wasm-pack is unavailable — /globalsim/wasm/ NOT updated.');
			console.warn('*** Classic modes are unaffected; GlobalSim compare will fail until you run:');
			console.warn('***   cd globalsim-wasm && wasm-pack build --target web --release --out-dir pkg');
		}
	}
	let copied = 0;
	for (const f of pkgFiles) {
		const src = path.join(pkgDir, f);
		if (!fs.existsSync(src)) continue;
		fs.copyFileSync(src, path.join(wasmDst, f));
		copied++;
	}
	if (copied) console.log(`globalsim/wasm: ${copied} pkg file(s) copied`);

	// (ii) course geometry (33 MB) — cheap skip-if-exists copy; the files are
	// pinned by the submodule, so an existing copy is never stale in practice.
	const geomSrc = path.join(root, 'vendor', 'GlobalSim', 'data', 'course_geometry');
	const geomDst = path.join(site, 'geometry');
	if (fs.existsSync(geomSrc)) {
		fs.mkdirSync(geomDst, { recursive: true });
		let gCopied = 0, gSkipped = 0;
		for (const f of fs.readdirSync(geomSrc).filter(f => f.endsWith('.json'))) {
			const dst = path.join(geomDst, f);
			if (fs.existsSync(dst)) { gSkipped++; continue; }
			fs.copyFileSync(path.join(geomSrc, f), dst);
			gCopied++;
		}
		console.log(`globalsim/geometry: ${gCopied} copied, ${gSkipped} up-to-date`);
	} else {
		console.warn('*** vendor/GlobalSim/data/course_geometry missing (submodule not checked out?) — geometry files NOT updated.');
	}

	// (iii) courses.json — the adapter's course-id validation set (tiny).
	const courseDataPath = path.join(root, 'vendor', 'GlobalSim', 'data', 'course_data.json');
	if (fs.existsSync(courseDataPath)) {
		const ids = Object.keys(JSON.parse(fs.readFileSync(courseDataPath, 'utf-8')));
		fs.writeFileSync(path.join(site, 'courses.json'), JSON.stringify(ids) + '\n');
		console.log(`globalsim/courses.json: ${ids.length} course ids`);
	}
}

generateGlobalsimAssets();

// v1 was retired 2026-08-27; its routes now serve v2 at the root (see _redirects).
// Only the v2 bundle is built here.

// v2 experimental build options
// Note: v2 uses npm @tanstack/react-table directly (v8 API), not the vendor files (v9 alpha API)
// Note: v2 production uses Vite (see build-all.sh), this is for dev server only
const buildOptionsV2 = {
	entryPoints: [{in: './v2/app-v2.tsx', out: 'v2/bundle-v2'}],
	bundle: true,
	minify: !debug,
	outdir: '.',
	write: !serve,
	format: 'esm',  // v2 uses import.meta (env vars, worker URLs) — legal only in ESM output
	define: {CC_DEBUG: debug.toString(), CC_GLOBAL: 'true', CC_DEV: isDev.toString(), CC_OCR_PROXY: JSON.stringify(process.env.OCR_PROXY_URL || ''), CC_TURNSTILE_SITEKEY: JSON.stringify(process.env.TURNSTILE_SITEKEY || ''), CC_COW_SKIN: JSON.stringify(process.env.COW_SKIN || ''), CC_GOATCOUNTER: JSON.stringify(process.env.GOATCOUNTER_CODE || ''), 'globalThis.CC_BASE_PATH': JSON.stringify(process.env.CC_BASE_PATH ?? '/uma-tools')},
	external: ['*.ttf'],
	plugins: [redirectData, mockAssert, seedrandomPlugin],  // No redirectTable - use npm packages
};

const MIME_TYPES = {
	'.html': 'text/html; charset=UTF-8',
	'.css': 'text/css',
	'.js': 'text/javascript',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.otf': 'font/otf',
	'.ttf': 'font/ttf',
	'.woff': 'font/woff'
};

const ARTIFACTS = ['bundle-v2.js', 'bundle-v2.css'];

function runServer(ctx, port) {
	const requestCount = new Map(ARTIFACTS.map(f => [f, 0]));
	let buildCount = 0;
	let output = null;
	// Dev-server asset prefix strip: the site-asset base (default '/uma-tools',
	// configurable via CC_BASE_PATH). Assets live at the project root here, so we
	// strip the base off asset requests. CC_BASE_PATH='' means served at root — no strip.
	const assetBases = ['/uma-tools', process.env.CC_BASE_PATH]
		.filter(b => b && b.length > 0)
		.map(b => b.replace(/^\//, '') + '/')
		.filter((v, i, a) => a.indexOf(v) === i);
	http.createServer(async (req, res) => {
		// Raw request URLs keep '..' segments and path.join(root, url) would
		// normalize them out of root — refuse them (same guard as mechanics-explorer).
		if ((req.url || '').includes('..')) { res.writeHead(400).end('Bad request'); return; }
		let url = req.url.endsWith('/') ? req.url + 'index.html' : req.url;
		// Strip leading slash for path.join to work correctly
		if (url.startsWith('/')) url = url.slice(1);
		// Strip the asset base prefix if present (for local dev - assets are at root)
		for (const b of assetBases) {
			if (url.startsWith(b)) { url = url.slice(b.length); break; }
		}
		// Strip umalator-global/ prefix for artifact matching
		let artifactKey = url;
		if (artifactKey.startsWith('umalator-global/')) artifactKey = artifactKey.slice('umalator-global/'.length);
		const filename = path.basename(url);
		// Skill-visualizer has its own pre-built bundles on disk — skip artifact matching
		const isSkillVis = artifactKey.startsWith('skill-visualizer/');
		// Check if this is a v2 artifact or main artifact
		const isV2Artifact = artifactKey.startsWith('v2/') && ARTIFACTS.some(a => artifactKey.endsWith(a.replace('bundle-v2', 'bundle-v2')));
		const artifactName = isV2Artifact ? path.basename(artifactKey) : filename;
		if (!isSkillVis && ARTIFACTS.indexOf(artifactName) > -1) {
			const requestN = requestCount.get(artifactName) + 1;
			requestCount.set(artifactName, requestN);
			if (requestN != buildCount) {
				buildCount += 1;
				console.log(`rebuilding ... => ${buildCount}`);
				// NOTE: i feel like we should call ctx.cancel() here in case the previous build is running,
				// but doing so causes the rebuild to not pick up new changes for some reason? slightly confused,
				// perhaps using the API wrong
				//await ctx.cancel();
				output = new Promise(async resolve => {
					const result = await ctx.rebuild();
					resolve(new Map(result.outputFiles.map(o => [path.basename(o.path), o.contents])));
				});
			}
			console.log(`GET ${req.url} 200 OK => ${requestN}`);
			const artifact = (await output).get(artifactName);
			res.writeHead(200, {
				'Content-type': MIME_TYPES[path.extname(filename)],
				'Content-length': artifact.length
			}).end(artifact);
		} else {
			const fp = path.join(root, url);
			const exists = await fs.promises.access(fp).then(() => true, () => false);
			if (exists) {
				console.log(`GET ${req.url} 200 OK`);
				res.writeHead(200, {'Content-type': MIME_TYPES[path.extname(filename)] || 'application/octet-stream'});
				fs.createReadStream(fp).pipe(res);
			} else {
				console.log(`GET ${req.url} 404 Not Found`)
				res.writeHead(404).end();
			}
		}
	}).listen(port);
}

if (serve) {
	const ctxV2 = await esbuild.context(buildOptionsV2);
	runServer(ctxV2, port);
	console.log(`Serving on http://[::]:${port}/ ...`);
	console.log(`  v2: use Vite — cd v2 && npm run dev`);
} else {
	await esbuild.build(buildOptionsV2);
}
