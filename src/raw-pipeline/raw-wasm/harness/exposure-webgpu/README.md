# WebGPU exposure parity harness (#925 P0)

Validates the WGSL exposure kernel on WebGPU against the CPU oracle (1e-4 gate).

## Build

```bash
cd src/raw-pipeline/raw-wasm
RUSTFLAGS="" wasm-pack build --target web \
    --out-dir harness/exposure-webgpu/pkg --release -- --features gpu
```

`RUSTFLAGS=""` is deliberate: `raw-wasm/.cargo/config.toml` compiles every
wasm32 target with `+atomics,+bulk-memory` + `--shared-memory` for the threaded
shipping build, but a shared-memory module only instantiates in a
`crossOriginIsolated` page (COOP/COEP headers) — which `python3 -m http.server`
does not send, so `init()` would throw before any WebGPU code runs. The override
neutralizes those flags. This harness is single-threaded (the work is on the
GPU), so it needs neither atomics nor the rayon thread pool, and builds on
**stable** with no `-Z build-std`.

## Run

```bash
cd src/raw-pipeline/raw-wasm/harness/exposure-webgpu
python3 -m http.server 8765
```

Open `http://localhost:8765/` in a **WebGPU-capable browser** (Chrome/Edge ≥ 113,
or Safari Technology Preview). Each EV row must read `PASS`; the page ends with
`OVERALL: PASS`. `window.__MAPLE_PARITY_RESULT` carries the same text for
automated scraping.
