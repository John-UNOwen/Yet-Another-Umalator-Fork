# globalsim-native

Native Node (napi-rs) addon that drop-in replaces the globalsim-wasm engine
wrapper in the sim server. It exports the same JS API (register_geometry plus
PreparedRace with new, run, run_compact, and free). The engine and all glue stay
in globalsim-wasm, used unmodified, and engine panics become JS Errors.

Build from the repo root (needs Rust 1.100+ and MSVC. napi 3 loads the N-API
symbols at runtime, so no node.lib is needed):

    cargo build --release --manifest-path globalsim-native/Cargo.toml
    copy globalsim-native\target\release\globalsim_native.dll globalsim-native\globalsim_native.node

Test both backends (byte-compares run_compact output over seeds 1..100, then
times 1000 races each):

    node globalsim-native/test/parity-and-timing.mjs

Enable: start the sim server with NATIVE_ENGINE=1 to load this addon. Unset, it
loads the wasm pkg unchanged.

    $env:NATIVE_ENGINE = '1'
    npx ts-node --transpile-only --compiler-options "{\"moduleResolution\":\"node\",\"module\":\"commonjs\"}" umalator-global/v2/engines/globalsim/sim-server.ts

## GPU lane (--features gpu)

With the `gpu` feature the addon also exports `gpuAvailable() -> {ok, reasons}`,
`gpuRunCompact(request, seed, trackSkillId, secondPlayerIndex, distance)`, and
`gpuRunCompactBatch(request, seeds, trackSkillId, secondPlayerIndex, distance)`.
They run races through the GPU facade in the engine fork's gpu-backend checkout
and fold the meta+packet into the same compact_record as run_compact. The batch
export answers a whole seed chunk in one facade call (a JSON array of the same
records, in seed order), which the sim server's gpu child wires as
`run_compact_batch` so one pool chunk costs one launch instead of one per seed
(`SIM_SERVER_GPU_BATCH=0` keeps the per-seed lane). A race the kernel gates
answers `{"seed":…,"gpuFallback":"<reason>"}`. The pool re-runs those seeds on a
CPU backend (pool.ts cpuFactory). One facade instance lives for the process
(Mutex<Option>, the OpenCL handles keep to the Node thread, see the code
comment).

`register_geometry(courseId, json)` feeds the same text to both lanes: the CPU
handle (globalsim-wasm, unchanged) and, in gpu builds, the facade as the
kernel's geometry authority for the course (injected into a facade that
already exists, held and applied when the facade builds later). The kernel
then flattens the app's vendor copy, not the engine checkout's
`data/course_geometry` files, so the two trees cannot drift apart silently.
The file fallback stays for courses the app never registers (engine-side
standalone tests). If the engine-side verification rejects the text the export
throws, so the worker reports a prepare error instead of racing on a geometry
the kernel lane would refuse.

The facade arrives as a path dep on the vendored engine tree's own `gpu/` crate
(`../vendor/GlobalSim/gpu`), so the addon compiles one engine package and needs
no sibling checkout, plus the Intel oneAPI lib dir on LIB for the OpenCL link.
The gpu build and the wasm|native builds are separate: default features stay
without gpu, so CI never links OpenCL. Set the LIB prefix and build in one pass
with `node tools/setup-gpu-lane.mjs`
([Enable the GPU lane](../README.md#enable-the-gpu-lane) in the repo README).

    npm run build:globalsim-native-gpu    # cargo build --features gpu + copy

Enable per session: NATIVE_ENGINE=gpu (the sim server's gpu backend), or start
with SIM_SERVER_BACKENDS=wasm,gpu to rotate. Acceptance:
`npm run test:globalsim-backend-gpu` (skips with a printed reason on a machine
where the device gate refuses).
