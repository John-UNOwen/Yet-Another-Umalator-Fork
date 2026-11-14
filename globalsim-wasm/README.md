# globalsim-wasm

Thin [wasm-bindgen](https://rustwasm.github.io/wasm-bindgen/) wrapper around the
GlobalSim engine pinned at `vendor/GlobalSim` (tag **v77**, commit `27a4d13`).
GlobalSim is consumed unmodified with `default-features = false,
features = ["external-geometry"]`; course geometry is registered at runtime
(`register_geometry`) instead of embedded, so the `.wasm` stays small and each
worker fetches only the course it needs.

## API (one instance per Web Worker)

| Export | Purpose |
|---|---|
| `register_geometry(courseId, jsonText)` | contents of `vendor/GlobalSim/data/course_geometry/<id>.json` |
| `new PreparedRace(requestJson)` | prepare once per setup; throws a string error on failure |
| `race.run(seedI32) -> jsonText` | one seed, full JSON reply; an engine panic becomes `"engine panic: …"` and kills the handle (recreate it) |
| `race.free()` | release early |

Panics are caught (`panic = "unwind"` here; upstream ships `abort`) instead of
trapping, so a bad input cannot silently kill a worker — but TypeScript must
still validate inputs first.

## Build

```sh
rustup target add wasm32-unknown-unknown
wasm-pack build --target web --release --out-dir pkg   # -> pkg/ (gitignored)
cargo build --release --example native_ref             # parity reference
```

## Phase 0 verification (2026-11-14)

`node test/phase0.mjs --seeds 200` (gitignored replies in `test/out/`):

* **Parity A:** wasm replies byte-identical to `native_ref` (same prepared API,
  native codegen) — 200 seeds × courses 10504/10606/10207, with frames.
* **Parity B:** wasm replies minus the `omitFrames` keys equal the native
  stdin worker with `omitFrames: true` (canonical JSON comparison).
* **Size:** `globalsim_wasm_bg.wasm` 1,658,547 B raw / 415,111 B gzip.

| Course | wasm ms/race (Node) | native ms/race | ratio | Chrome headless ms/race (avg/median) |
|---|---|---|---|---|
| 10504 | 7.75 | 6.93 | 1.12 | 7.39 / 7.3 |
| 10606 | 8.88 | 8.64 | 1.03 | 9.36 / 9.0 |
| 10207 | 6.47 | 6.03 | 1.07 | 6.36 / 6.3 |

Chrome numbers from `test/page/index.html` (`?auto=1&seeds=100&course=…`) via
puppeteer-core; prepare 4.5–12.8 ms per handle. Firefox and mobile-browser
timings were not measured (neither is available on the build machine) — open
`test/page/` from a served repo root on those devices and paste the JSON line
into this table.
