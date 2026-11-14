//! Thin wasm-bindgen surface over the pinned GlobalSim engine.
//!
//! Mirrors the host contract in vendor/GlobalSim/docs/IN-PROCESS.md:
//! `register_geometry` for `external-geometry` builds, one `PreparedRace` per
//! Web Worker confined to its thread, and a JSON reply per seed. GlobalSim is
//! consumed unmodified; anything engine-shaped that changes upstream shows up
//! here first.

use std::any::Any;
use std::panic::{catch_unwind, AssertUnwindSafe};
use wasm_bindgen::prelude::*;

/// Register captured course geometry: the exact contents of
/// `data/course_geometry/<course_id>.json` from the pinned GlobalSim.
/// Identity is verified by the engine when a race uses it, so mismatched
/// data fails preparation instead of substituting another track.
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

/// One prepared race plus a per-thread scratch buffer for JSON replies.
/// Confined to the thread (worker) that created it; run every seed of one
/// setup through the same handle.
#[wasm_bindgen]
pub struct PreparedRace {
    race: Option<globalsim::PreparedRace>,
    reply: String,
}

#[wasm_bindgen]
impl PreparedRace {
    /// Prepare a conventional JSON request (see vendor/GlobalSim/docs/INTERFACE.md).
    /// Only the seed changes between `run` calls; preparation cost is separate.
    #[wasm_bindgen(constructor)]
    pub fn new(request_json: &str) -> Result<PreparedRace, String> {
        let race = catch_unwind(AssertUnwindSafe(|| globalsim::PreparedRace::new(request_json)))
            .map_err(|payload| panic_text(payload.as_ref()))??;
        Ok(Self { race: Some(race), reply: String::new() })
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

    /// Release the preparation. Web Worker teardown also frees it; call this
    /// to free memory before a re-preparation on the same worker.
    pub fn free(self) {
        drop(self);
    }
}
