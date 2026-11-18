//! Thin wasm-bindgen wrapper around the pinned GlobalSim engine (v77).
//! GlobalSim is consumed UNMODIFIED; all glue lives here. See README.md.
//!
//! Two run modes on one handle:
//!   run()        — full JSON reply (frames included): representative runs,
//!                  velocity charts. Returns the engine reply verbatim.
//!   run_compact() — per-seed sampling reply (~1-2 KB): the compact record
//!                  metrics.ts/workerCore.ts extractCompact() would build from
//!                  the full reply — finish metadata, the 41×0.25 s tail grid,
//!                  optional h2h `opp` block, one-skill activation count and
//!                  the per-skill `skillActivations` map — computed HERE so the
//!                  multi-MB frames JSON is never
//!                  serialized at all (compare/skill-chart hot path).
//!                  Byte-parity with extractCompact is asserted by
//!                  compact-parity.test.ts against the real engine.

use std::any::Any;
use std::panic::{AssertUnwindSafe, catch_unwind};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn register_geometry(course_id: i32, json: &str) {
    globalsim::register_course_geometry(course_id, json.to_string());
}

fn panic_text(payload: &dyn Any) -> String {
    if let Some(text) = payload.downcast_ref::<String>() {
        format!("engine panic: {text}")
    } else if let Some(text) = payload.downcast_ref::<&str>() {
        format!("engine panic: {text}")
    } else {
        "engine panic".to_string()
    }
}

/// One prepared race plus per-thread scratch buffers for JSON replies.
/// Confined to the thread (worker) that created it; run every seed of one
/// setup through the same handle.
#[wasm_bindgen]
pub struct PreparedRace {
    race: Option<globalsim::PreparedRace>,
    reply: String,
    /// run_compact scratch: metadata-without-frames JSON + binary frame packet
    /// (kept between calls so their capacity is reused seed after seed).
    meta: String,
    packet: Vec<u8>,
}

#[wasm_bindgen]
impl PreparedRace {
    /// Prepare a conventional JSON request (see vendor/GlobalSim/docs/INTERFACE.md).
    /// Only the seed changes between `run` calls; preparation cost is separate.
    #[wasm_bindgen(constructor)]
    pub fn new(request_json: &str) -> Result<PreparedRace, String> {
        let race = catch_unwind(AssertUnwindSafe(|| globalsim::PreparedRace::new(request_json)))
            .map_err(|payload| panic_text(payload.as_ref()))??;
        Ok(Self { race: Some(race), reply: String::new(), meta: String::new(), packet: Vec::new() })
    }

    /// Simulate one independent seed and return the complete JSON reply.
    /// A seed outside the retail signed-32-bit range is rejected; an engine
    /// panic is returned as a `"engine panic: ..."` error and permanently
    /// kills this handle — the caller must create a new one.
    pub fn run(&mut self, seed: i32) -> Result<String, String> {
        let i64_seed = i64::from(seed);
        let race = self.race.as_mut().ok_or_else(|| "handle is dead; create a new one".to_string())?;
        let reply = &mut self.reply;
        let result = catch_unwind(AssertUnwindSafe(|| -> Result<(), String> {
            let simulation = race.run(i64_seed)?;
            simulation.write_json(reply);
            Ok(())
        }));
        match result {
            Ok(Ok(())) => Ok(std::mem::take(reply)),
            Ok(Err(error)) => Err(error),
            Err(payload) => {
                // The engine may have left this preparation inconsistent.
                drop(self.race.take());
                self.reply.clear();
                Err(panic_text(payload.as_ref()))
            }
        }
    }

    /// Simulate one seed and return the COMPACT record JSON directly:
    /// exactly what workerCore.ts extractCompact() derives from the full
    /// reply — `{seed, finishTimeRaw, finishOrder, hpEmptyOnRace,
    /// rushingStartCount, rushingPenaltyCount, lastSpurtStartDistance,
    /// startDelayTime, tail}` (+ `opp` when `second_player_index >= 0`,
    /// + `activations` counting `track_skill_id` for the player, + the
    /// player's `spurtPlanPos`/`spurtPlanHp` when `distance` is the course
    /// length, with `spurtHeals`/`spurtMaxHp` when a final-leg heal redoes
    /// the plan), or `{seed, error}` for a per-seed failure. Frames never serialize:
    /// the tail grid is sampled here from the engine's numeric replay.
    /// Panic semantics match `run` (a panic kills the handle).
    pub fn run_compact(&mut self, seed: i32, track_skill_id: &str, second_player_index: i32, distance: f64) -> Result<String, String> {
        let i64_seed = i64::from(seed);
        let race = self.race.as_mut().ok_or_else(|| "handle is dead; create a new one".to_string())?;
        let meta = &mut self.meta;
        let packet = &mut self.packet;
        let result = catch_unwind(AssertUnwindSafe(|| -> Result<String, String> {
            meta.clear();
            packet.clear();
            let simulation = race.run(i64_seed)?;
            simulation.into_binary(meta, packet); // metadata = reply WITHOUT frames
            compact_record(meta, packet, seed as f64, track_skill_id, second_player_index, distance)
        }));
        match result {
            Ok(Ok(text)) => Ok(text),
            Ok(Err(error)) => Err(error),
            Err(payload) => {
                drop(self.race.take());
                self.reply.clear();
                meta.clear();
                packet.clear();
                Err(panic_text(payload.as_ref()))
            }
        }
    }

    /// Release the preparation. Web Worker teardown also frees it; call this
    /// to free memory before a re-preparation on the same worker.
    pub fn free(self) {
        drop(self);
    }
}

// ── compact record (mirrors workerCore.ts extractCompact + metrics.ts samplePlayerTail) ──

/// binary_replay::encode header: magic(8) + meta_len u64 + frame_count u32 +
/// horse_count u32 + payload_size u64, then the metadata JSON, then
/// frame_count × (t f64 + horse_count × [pos,speed,hp,lane,..] 6×f64).
const PACKET_MAGIC: &[u8; 8] = b"GSIMRP01";
const PACKET_HEADER: usize = 8 + 8 + 4 + 4 + 8;
const TAIL_STEP: f64 = 0.25;
const TAIL_WINDOW: f64 = 10.;
const TAIL_SAMPLES: usize = 41; // floor(TAIL_WINDOW / TAIL_STEP) + 1

fn packet_field(packet: &[u8], frame_count: usize, horse_count: usize, meta_len: usize, i: usize) -> Option<(f64, usize)> {
    let base = PACKET_HEADER + meta_len + i * (8 + horse_count * 48);
    let end = base + 8 + horse_count * 48;
    if end > packet.len() { return None; }
    let t = f64::from_le_bytes(packet[base..base + 8].try_into().ok()?);
    Some((t, base + 8))
}
fn packet_f64(packet: &[u8], off: usize, col: usize) -> Option<f64> {
    let at = off + col * 8;
    if at + 8 > packet.len() { return None; }
    Some(f64::from_le_bytes(packet[at..at + 8].try_into().ok()?))
}

/// metrics.ts samplePlayerTail — exact port (grid, clamp, bracket walk).
/// Returns the 41 [dtBefore, pos, speed] samples for one runner, or an empty
/// Vec when no frame was retained in the window.
fn sample_tail(packet: &[u8], frame_count: usize, horse_count: usize, meta_len: usize, player_index: usize, finish: f64) -> Vec<[f64; 3]> {
    let from = (finish - TAIL_WINDOW).max(0.);
    // Player [t, pos, speed] samples inside the window [finish−WINDOW, finish].
    let mut slice: Vec<[f64; 3]> = Vec::new();
    for i in 0..frame_count {
        let Some((t, row)) = packet_field(packet, frame_count, horse_count, meta_len, i) else { break };
        if t < from { continue; }
        if t > finish { break; }
        if player_index >= horse_count { break; } // JS: missing horse tuple → break
        // Each horse is 6 f64 starting at `row`: h[0]=pos, h[1]=speed.
        let col = player_index * 6;
        let pos = packet_f64(packet, row, col);
        let speed = packet_f64(packet, row, col + 1);
        match (pos, speed) { (Some(p), Some(s)) => slice.push([t, p, s]), _ => break }
    }
    let n = slice.len();
    if n == 0 { return Vec::new(); }
    let mut out = Vec::with_capacity(TAIL_SAMPLES);
    // A lone retained frame carries no slope: every grid point is that sample.
    if n == 1 {
        for k in 0..TAIL_SAMPLES { out.push([(k as f64) * TAIL_STEP, slice[0][1], slice[0][2]]); }
        return out;
    }
    // The grid walks BACKWARDS in time; walk the bracket's left index DOWN in
    // lockstep so each point interpolates the segment that brackets it.
    let mut lo: isize = n as isize - 2;
    for k in 0..TAIL_SAMPLES {
        let t = (finish - (k as f64) * TAIL_STEP).max(0.);
        while lo > 0 && slice[lo as usize][0] > t { lo -= 1; }
        let a = slice[lo as usize];
        let b = slice[lo as usize + 1];
        let w = if b[0] > a[0] { (t - a[0]) / (b[0] - a[0]) } else { 0. };
        out.push([(k as f64) * TAIL_STEP, a[1] + w * (b[1] - a[1]), a[2] + w * (b[2] - a[2])]);
    }
    out
}

/// Exact port of metrics.ts spurtPlanPoint. A runner's position and HP on the
/// tick the engine plans its last spurt. A tick sets the final-leg phase from
/// the position before that tick's move (race_solver_retail.rs), and the plan
/// runs at the start of the next tick, so it reads the frame after the first
/// one at or past the final-leg boundary: section × 16 in float32, as
/// retail_physics::phase_boundaries computes it. None without a course
/// length or past the last frame.
fn spurt_plan_point(packet: &[u8], frame_count: usize, horse_count: usize, meta_len: usize, index: usize, distance: f64) -> Option<([f64; 2], usize)> {
    if !(distance > 0.) || index >= horse_count { return None; }
    let boundary = ((distance as f32 / 24.) * 16.) as f64;
    let mut crossed = false;
    for i in 0..frame_count {
        let (_, row) = packet_field(packet, frame_count, horse_count, meta_len, i)?;
        let col = index * 6;
        let pos = packet_f64(packet, row, col)?;
        if crossed { return Some(([pos, packet_f64(packet, row, col + 2)?], i)); }
        if pos >= boundary { crossed = true; }
    }
    None
}

/// Exact port of metrics.ts spurtHeals: every HP rise from frame J-1 to J
/// after the plan frame, as [pos J-1, hp J-1, hp J, hp J-2 minus hp J-1],
/// up to the finish. Each one is a tick that redoes the spurt plan.
fn spurt_heals(packet: &[u8], frame_count: usize, horse_count: usize, meta_len: usize, index: usize, plan_frame: usize, distance: f64) -> Vec<[f64; 4]> {
    let mut out = Vec::new();
    let col = index * 6;
    let at = |i: usize| -> Option<(f64, f64)> {
        let (_, row) = packet_field(packet, frame_count, horse_count, meta_len, i)?;
        Some((packet_f64(packet, row, col)?, packet_f64(packet, row, col + 2)?))
    };
    for j in plan_frame + 1..frame_count {
        let (Some((pos, hp)), Some((_, next)), Some((_, before))) = (at(j - 1), at(j), at(j - 2)) else { break };
        if pos >= distance { break; }
        if next > hp { out.push([pos, hp, next, before - hp]); }
    }
    out
}

/// A runner's HP on the first frame: the race starts at maximum HP.
fn first_hp(packet: &[u8], frame_count: usize, horse_count: usize, meta_len: usize, index: usize) -> Option<f64> {
    let (_, row) = packet_field(packet, frame_count, horse_count, meta_len, 0)?;
    packet_f64(packet, row, index * 6 + 2)
}

/// serde_json Number → the string JS `String(num)` would produce (skill-id
/// matching only; ids are always positive integers in practice).
fn num_to_js_string(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() { i.to_string() }
    else if let Some(u) = n.as_u64() { u.to_string() }
    else { format!("{}", n.as_f64().unwrap_or(0.)) }
}

/// `x ?? fallback` at JSON level: null/absent → the fallback value, else passthrough.
fn or<'a>(v: Option<&'a serde_json::Value>, fallback: serde_json::Value) -> serde_json::Value {
    match v { Some(serde_json::Value::Null) | None => fallback, Some(x) => x.clone() }
}

fn finish_block(meta: &serde_json::Value, index: usize, second: bool) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let results = meta.get("results").and_then(|v| v.as_array());
    let res = results.and_then(|a| a.get(index)).and_then(|v| v.as_object());
    let res = match res { Some(r) => r, None => return Err(if second { "second".into() } else { String::new() }) };
    let finish = match res.get("finishTimeRaw").and_then(|v| v.as_f64()) {
        Some(f) => f,
        None => return Err(if second { "second".into() } else { String::new() }),
    };
    let mut out = serde_json::Map::new();
    out.insert("finishTimeRaw".into(), serde_json::json!(finish));
    out.insert("finishOrder".into(), res.get("finishOrder").cloned().unwrap_or(serde_json::Value::Null));
    out.insert("hpEmptyOnRace".into(), or(res.get("hpEmptyOnRace"), serde_json::Value::Null));
    out.insert("rushingStartCount".into(), or(res.get("rushingStartCount"), serde_json::json!(0)));
    out.insert("rushingPenaltyCount".into(), or(res.get("rushingPenaltyCount"), serde_json::json!(0)));
    out.insert("lastSpurtStartDistance".into(), or(res.get("lastSpurtStartDistance"), serde_json::Value::Null));
    out.insert("startDelayTime".into(), or(res.get("startDelayTime"), serde_json::json!(0)));
    Ok(out)
}

/// The error record strings extractCompact emits, mapped from a sentinel Err.
fn record_error(seed: f64, second: bool) -> String {
    let msg = if second { "reply has no second player finishTimeRaw" } else { "reply has no player finishTimeRaw" };
    format!(r#"{{"seed":{},"error":"{}"}}"#, seed, msg)
}

fn compact_record(meta: &str, packet: &[u8], seed: f64, track_skill_id: &str, second_player_index: i32, distance: f64) -> Result<String, String> {
    if packet.get(..8).map_or(true, |m| m != PACKET_MAGIC) {
        return Ok(format!(r#"{{"seed":{},"error":"compact: unexpected packet magic"}}"#, seed));
    }
    let u = |o: usize, n: usize| -> u64 {
        let mut v = 0u64;
        for i in 0..n { v |= (packet[o + i] as u64) << (8 * i); }
        v
    };
    let meta_len = u(8, 8) as usize;
    let frame_count = u(16, 4) as usize;
    let horse_count = u(20, 4) as usize;

    let v: serde_json::Value = match serde_json::from_str(meta) {
        Ok(v) => v,
        Err(e) => return Ok(format!(r#"{{"seed":{},"error":"compact: metadata parse failed: {}"}}"#, seed, e)),
    };
    let pi = v.get("playerHorseIndex").and_then(|x| x.as_f64()).map(|x| x as usize);
    let pi = match pi { Some(p) => p, None => return Ok(record_error(seed, false)) };

    let own = match finish_block(&v, pi, false) {
        Ok(b) => b,
        Err(_) => return Ok(record_error(seed, false)),
    };
    let finish = own.get("finishTimeRaw").and_then(|x| x.as_f64()).unwrap_or(0.);
    let mut out = serde_json::Map::new();
    out.insert("seed".into(), serde_json::json!(seed));
    for (k, val) in own {
        if k == "finishTimeRaw" || k == "finishOrder" || k == "hpEmptyOnRace" || k == "rushingStartCount"
            || k == "rushingPenaltyCount" || k == "lastSpurtStartDistance" || k == "startDelayTime"
        { out.insert(k, val); }
    }
    let tail = sample_tail(packet, frame_count, horse_count, meta_len, pi, finish);
    out.insert("tail".into(), if tail.is_empty() { serde_json::Value::Null } else { serde_json::json!(tail) });
    if let Some(([pos, hp], plan_frame)) = spurt_plan_point(packet, frame_count, horse_count, meta_len, pi, distance) {
        out.insert("spurtPlanPos".into(), serde_json::json!(pos));
        out.insert("spurtPlanHp".into(), serde_json::json!(hp));
        let heals = spurt_heals(packet, frame_count, horse_count, meta_len, pi, plan_frame, distance);
        if !heals.is_empty() {
            out.insert("spurtHeals".into(), serde_json::json!(heals));
            out.insert("spurtMaxHp".into(), serde_json::json!(first_hp(packet, frame_count, horse_count, meta_len, pi)));
        }
    }

    // Lead-margin proxy field (metrics.leadMarginL; optimizer screening) —
    // rival = every field runner except the player. Key presence and value
    // selection mirror the JS extractCompact loop exactly (compact-parity).
    if let Some(results) = v.get("results").and_then(|x| x.as_array()) {
        let mut best_rival: Option<f64> = None;
        for (i, r) in results.iter().enumerate() {
            if i == pi { continue; }
            if let Some(t) = r.get("finishTimeRaw").and_then(|x| x.as_f64()) {
                if t.is_finite() && best_rival.map_or(true, |b| t < b) { best_rival = Some(t); }
            }
        }
        if let Some(t) = best_rival {
            out.insert("bestRivalFinishTimeRaw".into(), serde_json::json!(t));
        }
    }

    if second_player_index >= 0 {
        let si = second_player_index as usize;
        let mut opp = match finish_block(&v, si, true) {
            Ok(b) => b,
            Err(_) => return Ok(record_error(seed, true)),
        };
        let opp_finish = opp.get("finishTimeRaw").and_then(|x| x.as_f64()).unwrap_or(0.);
        let opp_tail = sample_tail(packet, frame_count, horse_count, meta_len, si, opp_finish);
        opp.insert("tail".into(), if opp_tail.is_empty() { serde_json::Value::Null } else { serde_json::json!(opp_tail) });
        out.insert("opp".into(), serde_json::Value::Object(opp));
    }

    // Player skill activations from the metadata reply's skill events.
    // `skillActivations` counts every skill the player activated this race,
    // per skill id (a skill that never activated gets no entry). The
    // optimizer cache folds these into a per-build activation report (§E),
    // so a skill's activation rate comes from the races already run instead
    // of costing extra ones. `activations` keeps the skill-chart column-4
    // count of the one tracked id. Key presence and id text mirror the JS
    // extractCompact fallback exactly (compact-parity pins the two paths).
    if let Some(events) = v.get("skillEvents").and_then(|x| x.as_array()) {
        let mut per_skill: Vec<(String, usize)> = Vec::new();
        let mut n = 0usize;
        for ev in events {
            let horse_index_matches = ev.get("horseIndex").and_then(|x| x.as_f64()).map(|x| x as usize) == Some(pi);
            if !horse_index_matches { continue; }
            // JS: String(ev.skillId ?? ev.id) — numeric or string,
            // falling back to `id` when skillId is absent/null.
            let id = |key: &str| -> Option<String> {
                let v = ev.get(key)?;
                if v.is_null() { return None; }
                match v.as_number() { Some(num) => Some(num_to_js_string(num)), None => v.as_str().map(|s| s.to_string()) }
            };
            let id = match id("skillId") { Some(s) => s, None => match id("id") { Some(s) => s, None => continue } };
            if !track_skill_id.is_empty() && id == track_skill_id { n += 1; }
            match per_skill.iter_mut().find(|(k, _)| *k == id) {
                Some((_, c)) => *c += 1,
                None => per_skill.push((id, 1)),
            }
        }
        per_skill.sort(); // sorted keys: stable output regardless of event order
        let mut map = serde_json::Map::new();
        for (k, c) in per_skill { map.insert(k, serde_json::json!(c)); }
        out.insert("skillActivations".into(), serde_json::Value::Object(map));
        if !track_skill_id.is_empty() { out.insert("activations".into(), serde_json::json!(n)); }
    }

    Ok(serde_json::to_string(&serde_json::Value::Object(out)).unwrap_or_else(|_| format!(r#"{{"seed":{},"error":"compact: serialize failed"}}"#, seed)))
}
