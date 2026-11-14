//! Native reference twin of the wasm wrapper for Phase 0 parity checks.
//! Runs the same public prepared API as `src/lib.rs` on the host arch.
//!
//! Usage: native_ref <request.json> <geometry.json>
//! Reads one seed per stdin line and writes one compact JSON reply per line,
//! mirroring the wasm `run(seed)` contract (panic aborts the process).

use globalsim::PreparedRace;
use std::io::{BufRead, Write};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let request_path = args.next().ok_or("usage: native_ref <request.json> <geometry.json>")?;
    let geometry_path = args.next().ok_or("usage: native_ref <request.json> <geometry.json>")?;
    let request = std::fs::read_to_string(&request_path)?;
    let request_value: serde_json::Value = serde_json::from_str(&request)?;
    let course_id = request_value.get("courseId").and_then(|v| v.as_i64()).ok_or("request needs courseId")? as i32;
    globalsim::register_course_geometry(course_id, std::fs::read_to_string(&geometry_path)?);

    let mut race = PreparedRace::new(&request)?;
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let mut reply = String::new();
    for line in stdin.lock().lines() {
        let line = line?;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let seed: i64 = line.parse()?;
        let simulation = race.run(seed)?;
        reply.clear();
        simulation.write_json(&mut reply);
        writeln!(out, "{reply}")?;
    }
    out.flush()?;
    Ok(())
}
