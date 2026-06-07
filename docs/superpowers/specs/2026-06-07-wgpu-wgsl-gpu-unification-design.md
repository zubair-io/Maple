# Unify the GPU render path on wgpu + WGSL — design

- **Epic:** [#925](https://github.com/zubair-io/Maple/issues/925)
- **Date:** 2026-06-07
- **Status:** Approved — P0 to be built; P1–P5 planned (detail firms up after P0)
- **Update 2026-06-07:** iOS-device validation for P0 is **folded into P1** (it
  will be validated when P1 builds the GPU display-surface handoff that links
  `wgpu` into the xcframework) — per maintainer decision. **P0 now closes on
  macOS + WebGPU-browser parity**; P1 gains on-device iOS validation as an
  acceptance item.
- **Scope of this doc:** full epic roadmap (P0–P5) + detailed P0 spike design.

## Summary

Adopt **`wgpu` (Rust host) + WGSL (one shader source)** as Maple's unified GPU
compute backend for the render pipeline, running as **native Metal on Apple**
(macOS / iPadOS / iOS) and **WebGPU on the web**, with the existing Rust CPU core
retained as the parity oracle and fallback.

This collapses the per-pixel render math from **three hand-authored
implementations into two**, gives the web a real GPU path so it can meet the
slider-tick performance invariant, and keeps a single deterministic GPU
implementation that the parity gate can hold to the Rust reference.

This is **parity-preserving plumbing**. No color-math changes. No look changes.

## Motivation / current state

The per-pixel render math is currently authored up to **three times**:

- **Rust stage files** (`raw-core/src/stages/*.rs`, `raw-core/src/view/*`) — the
  CPU reference, run live on Apple via FFI and on web via WASM.
- **4 Apple Metal (MSL) kernels** (`MapleCore/.../Metal/*.metal`) — NR-color,
  NR-luma, sharpen, separable blur (the AgX MSL kernel was retired for parity).
- **7 web GLSL shaders** (`maple-common/.../webgl/shaders/*.ts`) — WB / scene
  tone / vibrance / saturation / AgX, parity-gated but **not wired into the live
  canvas**.

Consequences:

- **Apple** runs the scene-linear chain + AgX on the **CPU via one Rust FFI
  round-trip** plus 2 Metal kernels. Per-tick cost is dominated by the FFI
  round-trip and CPU stage work (e.g. NLM noise reduction is far over the 16 ms
  budget at preview resolution).
- **Web** re-runs the **entire pipeline in WASM-CPU per edit** (150 ms trailing
  debounce, **no fast phase**); by its own code comments it cannot meet the
  16 ms slider budget until a GPU path lands.
- Every new stage must be ported into MSL **and** GLSL separately, each gated
  independently — duplicated work and a doubled parity surface.

## Goals

- One WGSL shader source serves macOS, iPadOS, iOS (Metal) and the browser
  (WebGPU).
- GPU-resident chain: upload the decoded image once, ping-pong intermediate
  buffers, display straight from the GPU texture — no per-stage and no per-tick
  CPU readback. Readback only for export and parity diffs (infrequent).
- Every ported stage stays parity-gated against its Rust stage (CIEDE2000 /
  byte-parity, reusing the established 1e-4 pattern).
- Render constants stay single-sourced via codegen (extended to emit WGSL).

## Non-goals

- **No color-math changes.** Ported stages must match the Rust reference within
  existing budgets.
- **Not removing the Rust reference** — it stays as oracle + fallback (headless
  CI, no-GPU machines, browsers without WebGPU).
- **Not dropping the WebGL2/GLSL fragment path yet** — WGSL compute is
  WebGPU-only, so GLSL is retained as the fallback for the browser tail.
- **Decode / demosaic stay on CPU** for now (separate effort).

## Approach decision — where the wgpu code lives

**Chosen: feature-gate inside `raw-core` (+ `raw-wasm`), off by default.**

- A `gpu` feature pulls in `wgpu = "23"` (aligned with the existing pin in
  `docs/tickets/04-maple-panorama-spec.md`). `naga` (the WGSL→MSL/SPIR-V
  translator) is bundled inside `wgpu` — no separate dep.
- With the feature **off**, every shipping build and CI-without-GPU compiles
  exactly as today. This preserves the "raw-core is pure math" property for all
  default builds and satisfies the epic's "CI without a GPU still passes"
  criterion.
- Matches the issue verbatim ("Add wgpu to raw-core behind a feature flag").

Alternatives considered and deferred:

- **New `raw-gpu` crate.** Cleaner long-term boundary, but unnecessary
  scaffolding to _prove_ the approach. Introduce it in **P1** when the resource
  layer (buffer pool, ping-pong, surface handoff) actually grows — that is the
  natural home for a dedicated crate.
- **Throwaway example/bin.** Fastest proof, but lays no foundation P1 builds on.

## P0 — the spike (built now)

**Goal:** prove one stage runs GPU-resident via wgpu and matches the Rust
reference within parity budget, on **macOS (Metal backend) + a WebGPU browser**,
with iOS-device validation as a manual checkpoint.

**The stage — Exposure.** Scene-linear `rgb *= 2^EV`, alpha untouched. Chosen
because it is a pure per-channel multiply with **no LUT and no constants**: if
parity fails, the cause is the GPU plumbing, not the color math. The spike
implements exposure as a **standalone oracle**, deliberately _not_ wired into the
full decode pipeline (that integration is P1/P4) — so the spike isolates
plumbing only.

The real pipeline applies this exact operation as `be_gain =
baseline_exposure.exp2()` then a per-channel multiply
(`raw-core/src/pipeline/develop/mod.rs:217`), with user exposure stacking
additively in EV. The spike's oracle mirrors that multiply.

### Deliverables

1. **`gpu` feature** in `raw-core` and `raw-wasm`, **off by default**. Adds
   `wgpu = "23"` and, for the native blocking test, `pollster` (both optional,
   gated by the feature).
2. **CPU oracle** — `apply_exposure_gain(buf: &mut [f32], ev: f32)` computing
   `c *= ev.exp2()` per RGB channel (alpha untouched). Pure, no GPU.
3. **WGSL compute kernel** — `out.rgb = in.rgb * exp2(ev)`; `ev` in a uniform
   buffer; storage buffer(s) in/out; one dispatch over the pixel grid;
   GPU-resident (no intra-kernel readback).
4. **Native parity test** (`raw-core`, `gpu` feature) — a deterministic test
   buffer spanning values `< 1`, `= 1`, `> 1` (and near-zero / large to exercise
   float behavior); run the oracle vs the GPU kernel for `ev ∈ {-3, 0, +0.5,
+4}`; assert **max abs diff < 1e-4** (mirrors `glsl_port_matches_rust_lut` in
   `raw-core/src/view/agx.rs`). On macOS this runs wgpu→**Metal** — which is the
   macOS validation.
5. **Web harness** (`raw-wasm`, `gpu` feature) — a `wasm-bindgen` entry that
   runs the kernel on WebGPU and returns max-diff vs the CPU result; a minimal
   page that prints `PASS/FAIL + max diff`. Served by the existing Angular dev
   server (or a standalone static page).

### Dispatched vs. checkpoint

- **Dispatched** (one focused background agent — P0 is one cohesive spike, not a
  parallel fan-out): deps, oracle, WGSL kernel, native Metal parity test, web
  WebGPU harness, _attempt_ automated headless WebGPU validation, open a PR that
  closes the P0 ticket.
- **Checkpoint (human-in-the-loop):**
  - **iOS-device** validation — manual deploy (devicectl tunnel; device logs not
    capturable on this machine), so the agent cannot close it. Surfaced in-app.
  - **Web** validation **if** the agent's environment has no WebGPU-capable
    browser. The agent reports which path it took — no false "done."

### P0 acceptance

- Native exposure parity `< 1e-4` on macOS (wgpu→Metal).
- `cargo build -p raw-core --features gpu` and the wasm build with the feature
  both compile; **default builds are unchanged** (no wgpu pulled in; CI green).
- Web harness exists and passes on WebGPU (agent-run or checkpoint).
- iOS-device parity confirmed at the checkpoint.

### Deferred out of P0

- codegen→WGSL (exposure has no constants → P2).
- Resource layer / ping-pong / display-from-texture (P1).
- Live-path wiring (P4).

## Roadmap — P1–P5 (planned; detail firms up after P0)

| Phase                                   | Goal                                                                                                                                                                                                                                                                                                                                     | Key risk / dependency                                                                                              | Folds in         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------- |
| **P1 — Resource layer**                 | Upload-once + ping-pong buffers; display straight from the GPU texture (no readback); preview vs full-res handling; two-phase fast/refine wiring. Likely introduce the `raw-gpu` crate here.                                                                                                                                             | Unified-memory buffer storage modes on Apple Silicon; surface/texture handoff to the Apple display layer on device | —                |
| **P2 — Scene-linear chain → WGSL**      | Port the scene-linear stages (WB, scene tone controls, tone curves, vibrance, saturation, clarity, texture, dehaze, AgX, Rec.2020→sRGB display encode, Auto Profile curve + residual LUT). **Extend codegen to emit WGSL** so matrices/LUTs/curve coefficients stay single-source. Each stage parity-gated. Fan out one agent per stage. | Re-scopes #662 (MSL-only → WGSL, now Apple + web); codegen-WGSL golden-file test                                   | #662             |
| **P3 — Spatial filters → WGSL compute** | Port the over-budget kernels: NLM noise reduction (luma + color), sharpen / capture-sharpen (Richardson-Lucy).                                                                                                                                                                                                                           | Compute-shader correctness vs CPU NLM; meeting the perf budget                                                     | #312             |
| **P4 — Wire into live paths**           | Apple: replace the FFI-CPU chain + remaining MSL kernels with the wgpu path (closes the #661 round-trip gap). Web: replace the WASM-CPU live path with WebGPU (provides the GPU substrate Auto Profile previews need). Retain CPU + WebGL2 fallback.                                                                                     | Live perf (16 ms slider target / 50 ms hard limit); fallback selection logic                                       | #661, #394, #819 |
| **P5 — Decommission**                   | Retire the redundant MSL + GLSL implementations once parity holds on all targets.                                                                                                                                                                                                                                                        | Only after P4 is parity-green on every target                                                                      | —                |

Each phase lands as its own child PR closing its own ticket; the epic closes
when all phases are parity-green on every target.

## Parity strategy

- Reuse the established **1e-4** cross-platform tolerance for per-stage / per-LUT
  byte parity (the pattern in `raw-core/src/view/agx.rs`
  `glsl_port_matches_rust_lut` and the stage tests).
- Keep the end-to-end perceptual gate (`src/scripts/test_color_pipeline.sh`,
  CIEDE2000 vs ACR references, per-case budgets in `test-fixtures/budgets.json`)
  as the broad signal. **Budgets are a one-way ratchet.**
- Driver determinism: pin to the exact ops we author (no autotuning / kernel
  selection). The parity gate must catch any cross-driver float drift.

## Constants / codegen → WGSL (P2)

Render constants (Oklab, CAT16, AgX inset/outset, etc.) are currently
hand-duplicated across Rust / MSL / GLSL. P2 extends the existing Rust constant
codegen (`src/raw-pipeline/codegen/`, today emitting Swift / TS / SCSS) with a
`Wgsl` target + `emit_wgsl()`, following the existing `emit_swift` / `emit_ts`
pattern, and adds a golden-file CI check so the WGSL constants can never drift
from Rust. Not needed for P0 (exposure has no constants).

## Risks / open questions

- **WebGPU browser coverage** — keep the WebGL2/GLSL fragment path as the
  fallback for the tail; WGSL compute is WebGPU-only.
- **WebGPU in the agent's environment** — headless WebGPU may be unavailable;
  P0's web validation falls back to the manual checkpoint if so.
- **iOS integration** — fold `wgpu` into the Rust staticlib already linked via
  the xcframework; validate surface/texture handoff to the Apple display layer
  on device (P1). P0 only needs the native parity proof + an on-device run.
- **Readback for export / parity** — confirm it stays off the interactive path
  (export + tests only).
- **Unified memory** — use the appropriate `wgpu` buffer storage modes on Apple
  Silicon to avoid unnecessary copies (P1).
- **raw-core gains an optional platform dep** — acceptable because it is off by
  default; the "pure math" property holds for every shipping build.

## Epic-level acceptance criteria (from #925)

- Every ported stage passes the parity gate (CIEDE2000 / byte) vs the Rust
  reference on macOS, iOS, and WebGPU.
- **Web** meets the slider-tick invariant (16 ms target / 50 ms hard limit) on
  the reference scene at preview resolution, with a real fast phase and no
  per-tick WASM byte readback.
- **Apple** holds or improves slider-tick latency; the live display path
  performs no GPU→CPU readback.
- The Rust CPU reference is retained as oracle + fallback; CI without a GPU still
  passes.
- Render constants remain single-sourced via codegen (now including WGSL);
  golden-file test green.
