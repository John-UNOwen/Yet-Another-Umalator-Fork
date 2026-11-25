// Native (napi-rs) drop-in for the globalsim-wasm wrapper, re-exposing the same
// JS API. globalsim-wasm catches engine panics and returns them as Err with an
// "engine panic: " prefix, which this layer maps to a JS Error of the same text.

use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi(js_name = "register_geometry")]
pub fn register_geometry(course_id: i32, json: String) -> Result<()> {
    globalsim_wasm::register_geometry(course_id, &json);
    // The gpu lane flattens its own copy of the same text, so kernel and CPU
    // lanes answer from one geometry, not from two trees of files.
    #[cfg(feature = "gpu")]
    if let Err(reason) = gpu_lane::register_geometry(course_id, &json) {
        return Err(Error::from_reason(format!(
            "gpu rejected course {course_id} geometry: {reason}"
        )));
    }
    Ok(())
}

/// Register the skill table this session shares (napi mirror of the wasm
/// wrapper's export). Requests that omit `skillData` prepare from it.
#[napi(js_name = "setSkillTable")]
pub fn set_skill_table(json: String) -> Result<()> {
    globalsim_wasm::set_skill_table(&json).map_err(Error::from_reason)
}
// PreparedRace is confined to the thread that created it and the addon is used
// on one thread, so satisfying napi's Send bound for JS-object storage is sound.
#[napi]
pub struct PreparedRace {
    inner: Option<globalsim_wasm::PreparedRace>,
}

unsafe impl Send for PreparedRace {}

const DEAD: &str = "handle is dead; create a new one";

#[napi]
impl PreparedRace {
    #[napi(constructor)]
    pub fn new(request_json: String) -> Result<Self> {
        let race = globalsim_wasm::PreparedRace::new(&request_json).map_err(Error::from_reason)?;
        Ok(Self { inner: Some(race) })
    }

    #[napi]
    pub fn run(&mut self, seed: i32) -> Result<String> {
        let race = self.inner.as_mut().ok_or_else(|| Error::from_reason(DEAD))?;
        race.run(seed).map_err(Error::from_reason)
    }

    #[napi(js_name = "run_compact")]
    pub fn run_compact(&mut self, seed: i32, track_skill_id: String, second_player_index: i32, distance: f64) -> Result<String> {
        let race = self.inner.as_mut().ok_or_else(|| Error::from_reason(DEAD))?;
        race.run_compact(seed, &track_skill_id, second_player_index, distance).map_err(Error::from_reason)
    }

    #[napi(js_name = "run_compact_gated")]
    pub fn run_compact_gated(&mut self, seed: i32, gate: i32, track_skill_id: String, second_player_index: i32, distance: f64) -> Result<String> {
        let race = self.inner.as_mut().ok_or_else(|| Error::from_reason(DEAD))?;
        race.run_compact_gated(seed, gate, &track_skill_id, second_player_index, distance).map_err(Error::from_reason)
    }

    #[napi]
    pub fn free(&mut self) {
        drop(self.inner.take());
    }
}

// ── gpu lane (only with --features gpu. Non-gpu builds export exactly the API above) ──

#[cfg(feature = "gpu")]
mod gpu_lane {
    use globalsim_gpu::facade::GpuRaces;
    use std::sync::Mutex;

    pub struct Slot {
        gpu: Option<Result<GpuRaces, String>>,
        // Registrations that arrived before the facade was built, applied at build.
        pending: Vec<(i32, String)>,
    }

    // GpuRaces is !Send by conservative inference (raw OpenCL handles). Same justification
    // as PreparedRace's: napi sync calls run on the single Node thread of the sim-server
    // child, so the Mutex only closes reentrant use, never crosses threads.
    unsafe impl Send for Slot {}

    static GPU: Mutex<Slot> = Mutex::new(Slot { gpu: None, pending: Vec::new() });

    /// One facade per process. Construction (device gate + engine data + kernel build) is
    /// attempted once: its result, success or named refusals, is fixed by the hardware.
    /// A facade build also applies the registrations held before it.
    pub fn with_gpu<T>(f: impl FnOnce(&mut GpuRaces) -> Result<T, String>) -> Result<T, String> {
        let mut slot = GPU.lock().unwrap_or_else(|p| p.into_inner());
        if slot.gpu.is_none() {
            slot.gpu = Some(GpuRaces::new().map_err(|e| format!("gpu unavailable: {e}")));
        }
        let pending = std::mem::take(&mut slot.pending);
        let entry = slot.gpu.as_mut().expect("gpu slot set above");
        if let Ok(gpu) = entry {
            let mut failed: Option<String> = None;
            for (course_id, text) in pending {
                if let Err(reason) = gpu.register_geometry(course_id, &text) {
                    if failed.is_none() {
                        failed = Some(format!("injected course {course_id} geometry rejected: {reason}"));
                    }
                }
            }
            if let Some(reason) = failed {
                return Err(reason);
            }
        }
        match entry {
            Ok(gpu) => f(gpu),
            Err(reason) => Err(reason.clone()),
        }
    }

    /// Inject the app's registered geometry into the facade. Direct when it
    /// exists, queued otherwise (the sim server opens the facade at session
    /// start, other hosts may register first). A facade that refused to build
    /// already names its refusal to every call.
    pub fn register_geometry(course_id: i32, json: &str) -> Result<(), String> {
        let mut slot = GPU.lock().unwrap_or_else(|p| p.into_inner());
        match &mut slot.gpu {
            Some(Ok(gpu)) => gpu.register_geometry(course_id, json),
            Some(Err(_)) => Ok(()),
            None => {
                slot.pending.push((course_id, json.to_string()));
                Ok(())
            }
        }
    }
}

#[cfg(feature = "gpu")]
#[napi(object)]
pub struct GpuReport {
    pub ok: bool,
    pub reasons: Vec<String>,
    /// Name of the gated device that took the lane, absent when it refused.
    pub device: Option<String>,
}

/// True once the GPU facade opens: device gate, engine data load and kernel build all passed.
/// `reasons` carries the refusal text when it did not, `device` names the lane's GPU.
#[cfg(feature = "gpu")]
#[napi(js_name = "gpuAvailable")]
pub fn gpu_available() -> GpuReport {
    // CL_DEVICE_NAME comes back raw, terminator included, so trim it here.
    match gpu_lane::with_gpu(|gpu| Ok(gpu.device().trim_end_matches('\0').to_string())) {
        Ok(device) => GpuReport { ok: true, reasons: Vec::new(), device: Some(device) },
        Err(reason) => GpuReport { ok: false, reasons: vec![reason], device: None },
    }
}

/// Device identity the gate judged, for the self-test report and the settings
/// panel: platform, name, driver version, compute units and fp configuration.
#[cfg(feature = "gpu")]
#[napi(js_name = "gpuDeviceReport")]
pub fn gpu_device_report() -> Result<String> {
    gpu_lane::with_gpu(|gpu| {
        let d = gpu.device_report();
        serde_json::to_string(&serde_json::json!({
            "platform": d.platform.trim_end_matches('\0'),
            "device": d.name.trim_end_matches('\0'),
            "driver": d.driver_version.trim_end_matches('\0'),
            "computeUnits": d.compute_units,
            "maxWorkGroupSize": d.max_work_group_size,
            "singleFpConfig": d.single_fp_config,
            "doubleFpConfig": d.double_fp_config,
        }))
        .map_err(|e| e.to_string())
    })
    .map_err(Error::from_reason)
}

/// Local work size for the self-test's sweep. 0 restores the pinned size.
#[cfg(feature = "gpu")]
#[napi(js_name = "gpuSetLocalWorkSize")]
pub fn gpu_set_local_work_size(size: u32) -> Result<()> {
    gpu_lane::with_gpu(|gpu| {
        gpu.set_local_work_size(if size == 0 { None } else { Some(size as usize) });
        Ok(())
    })
    .map_err(Error::from_reason)
}

/// The device's double-precision cost, from the same fma microkernels the dev
/// bench uses: four chains of 4,096 fma per work item, one warmup plus five
/// timed launches. A high f64/f32 ratio predicts a slow lane for this kernel.
#[cfg(feature = "gpu")]
#[napi(js_name = "gpuF64Ratio")]
pub fn gpu_f64_ratio() -> Result<String> {
    const COUNT: usize = 4096;
    const ITERATIONS: i32 = 4096;
    const REPEATS: usize = 5;
    let spike = globalsim_gpu::gpu::Spike::open().map_err(Error::from_reason)?;
    let f64_ms = spike.fma_probe(true, COUNT, ITERATIONS, REPEATS).map_err(Error::from_reason)?;
    let f32_ms = spike.fma_probe(false, COUNT, ITERATIONS, REPEATS).map_err(Error::from_reason)?;
    let gflops = |ms: f64| 2.0 * 4.0 * ITERATIONS as f64 * COUNT as f64 / (ms / 1000.0) / 1e9;
    serde_json::to_string(&serde_json::json!({
        "f32Ms": f32_ms,
        "f64Ms": f64_ms,
        "ratio": f64_ms / f32_ms,
        "f32GfPerSec": gflops(f32_ms),
        "f64GfPerSec": gflops(f64_ms),
        "workItems": COUNT,
        "iterations": ITERATIONS,
        "chains": 4,
        "repeats": REPEATS,
    }))
    .map_err(|e| Error::from_reason(e.to_string()))
}

/// Install the session skill table (step 5): requests that omit `skillData`
/// answer from it, so the table crosses the wire and parses once per session
/// instead of once per request text.
#[cfg(feature = "gpu")]
#[napi(js_name = "gpuSetSkillTable")]
pub fn gpu_set_skill_table(table: String) -> Result<()> {
    gpu_lane::with_gpu(|gpu| gpu.set_skill_table(&table)).map_err(Error::from_reason)
}

/// Fold one BatchOutcome into the compact-record text, exactly the way the wasm
/// run_compact path answers. A refused race becomes {"seed":…,"gpuFallback":"…"}.
/// The record text is copied through untouched, so batched and per-seed answers
/// stay byte-identical by construction.
// The prelude's Result is napi's, so this fold helper names std's Result for its String error.
#[cfg(feature = "gpu")]
fn outcome_record(outcome: globalsim_gpu::facade::BatchOutcome, seed: i32, track_skill_id: &str, second_player_index: i32, distance: f64) -> std::result::Result<String, String> {
    if let Some(reason) = outcome.fallback {
        return serde_json::to_string(&serde_json::json!({ "seed": seed, "gpuFallback": reason }))
            .map_err(|e| e.to_string());
    }
    let meta = outcome.meta.ok_or_else(|| "gpu: outcome without meta".to_string())?;
    let packet = outcome.packet.ok_or_else(|| "gpu: outcome without packet".to_string())?;
    globalsim_wasm::compact_record(&meta, &packet, seed as f64, track_skill_id, second_player_index, distance)
}

/// One race on the GPU lane, folded into compact_record exactly like the wasm run_compact path.
/// A kernel-gated race returns {"seed":...,"gpuFallback":"<reason>"}. The pool reruns that seed
/// on a CPU backend.
#[cfg(feature = "gpu")]
#[napi(js_name = "gpuRunCompact")]
pub fn gpu_run_compact(request: String, seed: i32, track_skill_id: String, second_player_index: i32, distance: f64) -> Result<String> {
    // One runner count per launch (the kernel's uniform grid), so batches stay single-race.
    let outcomes = gpu_lane::with_gpu(|gpu| gpu.run_batch(&[request], &[seed])).map_err(Error::from_reason)?;
    let outcome = outcomes.into_iter().next().ok_or_else(|| Error::from_reason("gpu: empty batch outcome"))?;
    outcome_record(outcome, seed, &track_skill_id, second_player_index, distance).map_err(Error::from_reason)
}

/// A whole seed chunk on the GPU lane in ONE facade call (run_repeated prepares once and
/// rewrites only the seed word). Returns a JSON array of the same compact
/// records gpuRunCompact returns, in seed order. Refused seeds carry {seed, gpuFallback}
/// and the pool rerun lane takes them as usual. One request for the whole chunk keeps the
/// kernel's uniform runner-count requirement true by construction. Out-of-i32 seeds never
/// enter this call (the caller keeps them on the CPU lane).
#[cfg(feature = "gpu")]
#[napi(js_name = "gpuRunCompactBatch")]
pub fn gpu_run_compact_batch(request: String, seeds: Vec<i32>, track_skill_id: String, second_player_index: i32, distance: f64) -> Result<String> {
    if seeds.is_empty() {
        return Ok("[]".to_string());
    }
    let outcomes = gpu_lane::with_gpu(|gpu| gpu.run_repeated(&request, &seeds)).map_err(Error::from_reason)?;
    if outcomes.len() != seeds.len() {
        return Err(Error::from_reason(format!("gpu: batch returned {} records for {} seeds", outcomes.len(), seeds.len())));
    }
    let mut out = String::from("[");
    for (&seed, outcome) in seeds.iter().zip(outcomes) {
        let record = outcome_record(outcome, seed, &track_skill_id, second_player_index, distance).map_err(Error::from_reason)?;
        if out.len() > 1 {
            out.push(',');
        }
        out.push_str(&record);
    }
    out.push(']');
    Ok(out)
}

/// One group of a multi-request compact launch: the seeds that run one of the
/// payload's request texts, plus the record fold options for every seed.
#[cfg(feature = "gpu")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawGroup {
    /// Index into the payload's `requests` list.
    r: usize,
    seeds: Vec<i32>,
    #[serde(default)]
    track_skill_id: String,
    #[serde(default = "minus_one")]
    second_player_index: i32,
    #[serde(default)]
    distance: f64,
}

#[cfg(feature = "gpu")]
fn minus_one() -> i32 {
    -1
}

#[cfg(feature = "gpu")]
#[derive(serde::Deserialize)]
struct RawGroups {
    requests: Vec<String>,
    groups: Vec<RawGroup>,
}

/// Several setup keys in one compact launch. The payload is
/// `{"requests": [text...], "groups": [{r, seeds, trackSkillId?, secondPlayerIndex?, distance?}...]}`:
/// each request text prepares once however many groups name it, and the races
/// of groups that agree on runner count and kept frame-row count launch
/// together. Returns a JSON array of the same compact records
/// gpuRunCompactBatch returns, in group order and seed order within a group
/// (refused seeds as {seed, gpuFallback}), so the caller can split records back
/// to each job positionally. A group whose request is refused flags only its
/// own seeds.
#[cfg(feature = "gpu")]
#[napi(js_name = "gpuRunCompactGroups")]
pub fn gpu_run_compact_groups(payload: String) -> Result<String> {
    let parsed: RawGroups = serde_json::from_str(&payload)
        .map_err(|e| Error::from_reason(format!("gpu groups: {e}")))?;
    if parsed.requests.is_empty() || parsed.groups.is_empty() {
        return Ok("[]".to_string());
    }
    let groups: Vec<globalsim_gpu::facade::CompactGroup> = parsed
        .groups
        .iter()
        .map(|group| globalsim_gpu::facade::CompactGroup {
            request_index: group.r,
            seeds: group.seeds.clone(),
            track_skill_id: group.track_skill_id.clone(),
            second_player_index: group.second_player_index,
            distance: group.distance,
        })
        .collect();
    let total: usize = groups.iter().map(|group| group.seeds.len()).sum();
    let outcomes = gpu_lane::with_gpu(|gpu| gpu.run_compact_groups(&parsed.requests, &groups))
        .map_err(Error::from_reason)?;
    if outcomes.len() != total {
        return Err(Error::from_reason(format!(
            "gpu: group launch returned {} records for {total} seeds",
            outcomes.len()
        )));
    }
    let mut out = String::from("[");
    let mut at = 0usize;
    for group in &groups {
        for &seed in &group.seeds {
            let outcome = &outcomes[at];
            at += 1;
            if out.len() > 1 {
                out.push(',');
            }
            match (&outcome.record, &outcome.fallback) {
                (Some(record), None) => out.push_str(record),
                (_, Some(reason)) => {
                    let text = serde_json::to_string(&serde_json::json!({
                        "seed": seed,
                        "gpuFallback": reason,
                    }))
                    .map_err(|e| Error::from_reason(e.to_string()))?;
                    out.push_str(&text);
                }
                _ => {
                    return Err(Error::from_reason(
                        "gpu: group outcome with neither record nor fallback".to_string(),
                    ))
                }
            }
        }
    }
    out.push(']');
    Ok(out)
}

// ── startup check (M4) ────────────────────────────────────────────────────────

/// The canned guard race: one request line of the engine's v77 example. It
/// carries its own skill table, so the probe needs nothing from the app.
#[cfg(feature = "gpu")]
const PROBE_REQUEST_LINE: &str = include_str!("../../vendor/GlobalSim/examples/v77-race.jsonl");

/// The probe race's course, and the geometry both lanes must flatten (the app's
/// CPU engine is the external-geometry build, so it registers text at runtime).
#[cfg(feature = "gpu")]
const PROBE_COURSE: i32 = 10504;
#[cfg(feature = "gpu")]
const PROBE_GEOMETRY: &str = include_str!("../../vendor/GlobalSim/data/course_geometry/10504.json");

#[cfg(feature = "gpu")]
const PROBE_SEED: i32 = 20261115;
// Widths from the lane's real chunks: a lane sizes its first chunk at about
// 1,000 to 2,000 races, and a slope fitted at 64/512 overstated the marginal cost.
#[cfg(feature = "gpu")]
const PROBE_SMALL: usize = 1000;
#[cfg(feature = "gpu")]
const PROBE_LARGE: usize = 2000;

/// The server's startup check: the gated device, a guard race against the CPU
/// engine, and the device's measured launch floor and slope.
#[cfg(feature = "gpu")]
#[napi(object)]
pub struct GpuProbeReport {
    pub ok: bool,
    pub reasons: Vec<String>,
    pub device: Option<String>,
    /// True when the GPU lane's compact record matched the CPU engine's.
    pub parity_ok: Option<bool>,
    pub parity_detail: Option<String>,
    /// Fixed cost of one launch on this device, ms.
    pub floor_ms: Option<f64>,
    /// Marginal cost of one race on this device, ms.
    pub slope_ms_per_race: Option<f64>,
}

#[cfg(feature = "gpu")]
fn probe_races(
    gpu: &mut globalsim_gpu::facade::GpuRaces,
) -> std::result::Result<GpuProbeReport, String> {
    let request = PROBE_REQUEST_LINE
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .ok_or_else(|| "gpu probe fixture has no request line".to_string())?;
    globalsim_wasm::register_geometry(PROBE_COURSE, PROBE_GEOMETRY);
    gpu.register_geometry(PROBE_COURSE, PROBE_GEOMETRY)?;
    let run = |gpu: &mut globalsim_gpu::facade::GpuRaces, n: usize| -> std::result::Result<(f64, Vec<String>), String> {
        let seeds: Vec<i32> = (0..n).map(|i| PROBE_SEED + i as i32).collect();
        let started = std::time::Instant::now();
        let outcomes = gpu.run_repeated(request, &seeds)?;
        let ms = started.elapsed().as_secs_f64() * 1000.;
        if outcomes.len() != seeds.len() {
            return Err(format!("gpu probe: {} records for {n} seeds", outcomes.len()));
        }
        let mut records = Vec::with_capacity(n);
        for (outcome, &seed) in outcomes.into_iter().zip(&seeds) {
            records.push(outcome_record(outcome, seed, "", -1, 0.0)?);
        }
        Ok((ms, records))
    };
    // Guard race: the same request on the app's CPU engine, folded the same way.
    let mut cpu = globalsim_wasm::PreparedRace::new(request)
        .map_err(|e| format!("gpu probe: CPU prepare failed: {e}"))?;
    let cpu_record = cpu
        .run_compact(PROBE_SEED, "", -1, 0.0)
        .map_err(|e| format!("gpu probe: CPU run failed: {e}"))?;
    // One warm call pays the kernel build and the request cache, and carries
    // the parity seed, so the timed calls below measure the steady lane.
    let (_warm_ms, warm_records) = run(gpu, 1)?;
    let parity_ok = warm_records.first().map(|r| *r == cpu_record).unwrap_or(false);
    let parity_detail = if parity_ok {
        None
    } else {
        Some(format!("compact record differs from the CPU engine for seed {PROBE_SEED}"))
    };
    // Two widths, each measured twice, minimum taken to cut startup noise.
    let mut small = f64::INFINITY;
    let mut large = f64::INFINITY;
    for _ in 0..2 {
        small = small.min(run(gpu, PROBE_SMALL)?.0);
        large = large.min(run(gpu, PROBE_LARGE)?.0);
    }
    let slope = (large - small) / (PROBE_LARGE - PROBE_SMALL) as f64;
    let slope = if slope.is_finite() && slope > 0.0 { slope } else { 0.0 };
    let floor = (small - slope * PROBE_SMALL as f64).max(0.0);
    let mut reasons = Vec::new();
    if !parity_ok {
        reasons.push(parity_detail.clone().unwrap_or_else(|| "parity failed".to_string()));
    }
    Ok(GpuProbeReport {
        ok: parity_ok,
        reasons,
        device: None,
        parity_ok: Some(parity_ok),
        parity_detail,
        floor_ms: Some(floor),
        slope_ms_per_race: Some(slope),
    })
}

/// The startup check the sim server runs once per run: device gate, one guard
/// race against the CPU engine, and a short width probe for this device.
#[cfg(feature = "gpu")]
#[napi(js_name = "gpuProbe")]
pub fn gpu_probe() -> GpuProbeReport {
    match gpu_lane::with_gpu(|gpu| {
        // CL_DEVICE_NAME comes back raw, terminator included, so trim it here.
        let device = gpu.device().trim_end_matches('\0').to_string();
        let mut report = probe_races(gpu)?;
        report.device = Some(device);
        Ok(report)
    }) {
        Ok(report) => report,
        Err(reason) => GpuProbeReport {
            ok: false,
            reasons: vec![reason],
            device: None,
            parity_ok: None,
            parity_detail: None,
            floor_ms: None,
            slope_ms_per_race: None,
        },
    }
}


