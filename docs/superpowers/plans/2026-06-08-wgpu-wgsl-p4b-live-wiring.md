# wgpu + WGSL P4b — Wire the GPU chain into the LIVE render paths — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`. This is **integration**, not new render math — the wgpu+WGSL chain is merged and parity-verified (112 `raw-gpu` tests). P4b makes the live preview render via the GPU chain instead of the CPU, behind a flag, with the CPU/WebGL2/Metal paths kept as fallback.

**Goal:** Replace the per-tick CPU render with the GPU-resident wgpu chain on Apple + web — gated behind the `gpu` feature + a runtime flag, fallback paths intact (deletion is P5). P4 of epic [#925](https://github.com/zubair-io/Maple/issues/925); closes [#992](https://github.com/zubair-io/Maple/issues/992).

**Base:** the merged foundation on `main` (P0–P4a + P1b). The render math is DONE — `build_full_chain_passes` / `build_split` / `FullChainInputs` / `BoxedPasses` (`raw-gpu/src/full_chain.rs`), `ChainRunner`/`CancelToken` (`chain.rs`), the spatial scratch substrate (`spatial.rs`), `GpuContext` with ~35 cached pipelines (`context.rs`), the P1b `present_test_pattern` wgpu→CAMetalLayer bridge (`present.rs`), the `gpu`-gated FFI (`raw-ffi/src/gpu.rs`).

---

## Decomposition — THREE sub-phases, three PRs, stacked on a merged base

| Phase         | Scope                                                                                                                                                                    | Depends on                        | Autonomy                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- | ---------------------------------------------------- |
| **P4b-core**  | Gated live-chain builder, on-GPU airlight reduction, `dither_and_quantize` WGSL, pooled persistent live-session runner, `gpu`-gated FFI. **Headless.**                   | merged full_chain                 | **Fully autonomous** (native parity harness)         |
| **P4b-apple** | `gpu`-gated present FFI + chain-output→CAMetalLayer blit + two-phase wiring in `ImageEditPipeline`, behind a flag. Replaces FFI-CPU chain + Metal kernels + CIColorCube. | **P4b-core + P1b (#988, merged)** | Autonomous to the **device + 16ms** checkpoints      |
| **P4b-web**   | `gpu`-gated wasm `render_*_gpu` + WebGPU-canvas present, reusing the existing re-render effect. Replaces WASM-CPU `render_bytes`.                                        | **P4b-core + P1c (#989)**         | Autonomous to the **real-WebGPU-browser** checkpoint |

**Sequencing:** P4b-core lands first (unblocks both). P4b-apple follows core (P1b merged). P4b-web forks after core but **gates on P1c #989**. P4b-apple and P4b-web both base on the merged-to-main P4b-core.

**Fallback (all phases):** the CPU paths (web `render_bytes`, apple `apply_scene_linear_chain_f32`) and the Apple Metal / web WebGL2 paths **REMAIN** as fallback — deletion is **P5**. The GPU live path is gated behind `gpu` (Rust, already wired) + a runtime flag per platform (Swift `#if MAPLE_GPU` + launch-arg, mirroring `GpuDebugView`; Angular env flag). Flag OFF = today's behavior, byte-for-byte.

---

## The two correctness risks (design for them, don't discover them)

### Risk A — per-stage short-circuit gating (the #1 risk; P4b-core)

The composed GPU chain runs **every pass unconditionally**; Rust `develop` / the per-tick chain skip no-op stages (each stage's `apply` early-returns at default values). `full_chain/tests.rs` proves this divergence is **by design** and states the short-circuit is the **caller's job** ("the P4b live chain, NOT this composition layer"). Without gating, neutral-slider output diverges ~3.7e-3 (the gamma OETF amplifies tiny upstream diffs).

**Exact gate predicates** (read from `raw-core/src/stages/*`), replicated in the new builder wrapper:

- `vibrance`, `saturation`, `clarity`, `texture`, `dehaze`: `slider.abs() < 1e-3` → omit.
- `white_balance::apply`: `(temp - 6500).abs() < 0.5 && tint.abs() < 0.5` → omit.
- `scene_tone_controls`: omit only if **all** of `exposure.abs() < 1e-6 && {highlights,shadows,whites,blacks}.abs() < 1e-3` (`mod.rs:22-28`).
- `tone_curves`: omit only if no parametric field `≥ 1e-3` **AND** `tone_curve_{luma,red,green,blue}.is_identity()` (`mod.rs:82-102`).
- `sharpen`: `amount.abs() < 1e-3` → omit. `nr_luminance` / `nr_color`: `< 1e-3` → omit.
- `capture_sharpening`: **already gated** in `build_split` via `Option` — generalize that pattern.
- View-tail (`agx`, `display_encode`, `srgb_gamma`, `auto_profile_curve`, `residual_lut`) and `dither`: **always run**.

The gating must NOT go inside the merged `build_split` (its tests assert specific pass counts). It belongs in a **new wrapper** (`build_live_chain(inputs) -> BoxedPasses`) that decides pass inclusion from the live `AdjustmentModel`, delegating construction to the existing `build_split` primitives.

### Risk B — on-GPU dehaze airlight (P4b-core)

Airlight depends on mid-chain pixel content (post-texture buffer) → cannot be precomputed at decode. The headless path computes it CPU-side via a **mid-chain readback** (`build_split` → readback → `compute_airlight` → suffix). The live loop **cannot pay a per-tick readback** → needs an **on-GPU reduction**. `compute_airlight` (`raw-gpu/src/dehaze.rs`) is a **sort + top-0.1%-of-dark-channel average** (NOT a max) — bit-matching its tie-breaking on-GPU is infeasible. Plan: **(a) correctness-first** reuse the readback (correct, slow, parity-green); **(b)** replace with a **histogram/percentile reduction** gated within a stated tolerance on a **realistic** fixture (not 8×8). Reduction comes AFTER the readback path proves end-to-end correctness.

### The decode-boundary contract (pin before P4b-apple)

Apple decode (`maple_render_file_scene_linear_f32` → `develop_scene_linear_from_raw_with_quality_cancellable`) **bakes `auto_exposure` + `capture_sharpening`** into the cached buffer (`develop/mod.rs` stages 05 + 04b). `RawCoreBridge.withStrippedXMP` strips the live-tweakable fields (WB/tone/vibrance/nr) so the per-tick chain re-applies them, keeps `highlightRecovery`, forces `sharpenAmount`/`nrColor` to 0 (Metal owns those today). **Therefore the live wgpu chain on Apple MUST:** pass **`capture_sharpening: None`** (already baked → including it = double-apply, zero harness coverage); **not** re-run `auto_exposure`; derive WB to match develop's **absolute** `white_balance::apply` (NOT `apply_delta`) — the chain is canonical-absolute on the D65/6500K-landed buffer. **Reviewer flag (expected, correct divergence):** GPU live output differs from today's pixels because sharpen + nr_color move into the scene-linear chain at canonical positions and Auto Profile applies as separate curve+LUT passes instead of a pre-composed `CIColorCube`. This is convergence toward canonical `render`, not a regression.

---

## Part 1 — P4b-core (fully autonomous; native-headless parity gate)

Files under `src/raw-pipeline/raw-gpu/src/` and `src/raw-pipeline/raw-ffi/src/`. Every commit ends with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Commit each task (don't risk a socket crash losing work).

### Task C1 — Gated live-chain builder + the neutral/single-stage parity gate (proves Risk A)

**Files:** Create `raw-gpu/src/live_chain.rs` (+ `live_chain/tests.rs`); modify `raw-gpu/src/lib.rs` (register `mod live_chain;` + `pub use`).

- [ ] `pub fn build_live_chain(inputs: &FullChainInputs) -> BoxedPasses` applying the Risk-A predicates to decide pass inclusion, delegating to the existing `build_split` primitives. Add `build_live_split(...) -> (BoxedPasses, BoxedPasses)` for the airlight split (mirrors `build_split`).
- [ ] **Test (the hole `full_chain/tests.rs` deliberately leaves):** (a) **neutral** `AdjustmentModel` → assert the builder omits every no-op pass (pass-count + name/type assertion) AND GPU output matches `develop`+`render`'s neutral output within `1e-4`; (b) **single-stage-active** cases (one slider past threshold at a time) → each includes exactly that pass and matches the CPU stage. Reuse the `cpu_oracle` harness pattern but drive it from a real `AdjustmentModel` through the canonical stage `apply` fns (which DO short-circuit) so GPU-gated == CPU-short-circuited.
- [ ] Run `cargo test -p raw-gpu live_chain` (no output piping; generous timeout). Commit.

### Task C2 — Port `dither_and_quantize` to WGSL (f32 scene → u8 display)

**Files:** Create `raw-gpu/src/dither.rs` + `dither.wgsl`; modify `context.rs` (add `dither_pipeline: OnceCell<…>`), `lib.rs`.

- [ ] Port `raw_core::view::encode::dither_and_quantize` exactly: ordered Bayer-matrix LSB dither, `dst = (c*255 + bayer_offset_lsb(x,y) + 0.5).clamp(0,255) as u8`, same `(x,y)` recovery from the linear index, same offset on all three channels (neutral stays neutral). Output a `u8` RGB(A) buffer (a dedicated terminal encode — output type changes from f32-RGBA). Add the lazy `dither_pipeline` to `GpuContext`.
- [ ] **Test:** GPU dither vs `dither_and_quantize` byte-exact (±1 LSB tolerance only if a float-eval ordering diff appears — document it) over a structured f32 buffer spanning `[0,1]` + the knee.
- [ ] `cargo test -p raw-gpu dither`. Commit.

### Task C3 — Persistent pooled live-session runner + GPU-resident image handle

**Files:** Create `raw-gpu/src/live_session.rs`; modify `chain.rs` / `spatial.rs` (thread an optional pool through `encode`), `lib.rs`.

- [ ] `LiveSession` owns the uploaded `GpuImage` (upload-once, GPU-resident across ticks), the ping-pong pair, AND a **dims-keyed scratch/uniform/bind-group pool**. Expose `render_to_buffer(&self, inputs, cancel)` (correctness-first: one end-of-run readback or an owned output buffer).
- [ ] **The pooling refactor is the substantive part** (CLAUDE.md: "allocation inside the render loop … does not ship"). Today `ChainRunner::new` allocs two buffers per construction; `spatial.rs::encode_simple` allocs a uniform + bind group **per dispatch**; spatial/dehaze/NR `Pass::encode` alloc ~6–12 scratch planes per encode. Thread a frame arena/pool (new optional `&Pool` param, or a dims-keyed pool on `GpuContext`/`LiveSession`) so a re-render at stable dims allocates **zero** new GPU resources. Keep **≤4 storage buffers per stage**.
- [ ] **Test:** instrument allocations (counter/label or test-only hook) — a second `render_to_buffer` at the same dims = **0 buffer/bind-group allocations**; output bit-identical to the first. Sequence LAST in core (perf-shaped). Commit.

### Task C4 — `gpu`-gated FFI surface for the live session

**Files:** Modify `raw-ffi/src/gpu.rs` (+ extend the `MapleAdjustmentParams` shape from `scene_linear_chain.rs`).

- [ ] Add a session lifecycle + render entry mirroring the existing `maple_*` shape. Extend the params struct to carry what `FullChainInputs` needs beyond the current 18 fields: `tone_curves` inputs, `sharpen_radius/detail/masking`, `nr_color`, the Auto Profile `profile_curve_flat` + `residual_lut_{size,data}`. Entry: upload f32 RGBA + params → `build_live_chain` → run on `LiveSession` → write back (present variant is per-platform).
- [ ] **Test:** host parity — the FFI entry's output matches `render`/`develop` within `1e-4` across mild + aggressive `AdjustmentModel`s (mirror `gpu.rs`'s `gpu_exposure_parity_within_1e_4`). `cargo build -p raw-ffi --features gpu`; confirm default `cargo build -p raw-ffi` unchanged. Commit.

### Task C5 — On-GPU airlight reduction (Risk B), correctness-first then optimized

**Files:** Modify `raw-gpu/src/live_session.rs` / `dehaze.rs`; create `dehaze_airlight.wgsl`.

- [ ] **C5a (correctness-first):** wire the live dehaze split to the **headless readback** airlight path (`build_live_split` → readback → `compute_airlight` → suffix). Parity-green, pays a readback — documented as a stepping stone.
- [ ] **C5b (the real kernel):** `dehaze_airlight.wgsl` + orchestration — an on-GPU reduction approximating `compute_airlight` (dark-channel histogram → percentile threshold → masked average of the original at the top-0.1% positions), producing the airlight uniform **without leaving the device**.
- [ ] **Test:** GPU-reduction airlight vs `compute_airlight` within a **stated tolerance** on a **realistic** fixture (scaled `scene_linear_rgba` or a fixture-gated real image), and the full dehaze stage end-to-end within budget. Document why bit-exactness isn't the gate. Commit.

### Task C6 — P4b-core PR

- [ ] Push `claude/wgpu-p4b-core`; PR **ready (not draft)**, base `main`, `Closes` the P4b-core sub-issue. Body: neutral-parity number (gating proof), airlight tolerance, zero-alloc-rerun proof, dither parity number.

---

## Part 2 — P4b-apple (autonomous to device + perf checkpoints)

Files under `src/apple/Packages/MapleCore/Sources/MapleCore/` and `raw-ffi/src/gpu.rs`. Base the merged P4b-core.

### Task A1 — `gpu`-gated present FFI: chain output → CAMetalLayer (extend P1b's `present.rs`)

- [ ] Extend `raw-gpu/src/present.rs` from `present_test_pattern` to a **chain-output present**: sample/blit the `LiveSession`'s final f32 storage buffer into the surface texture (fullscreen-triangle sampling pass — the storage-buffer→surface-texture seam). Run **quantize + optional dither** (Task C2's WGSL) for the 8-bit `Bgra8Unorm` surface (`pick_surface_format` already prefers non-sRGB 8-bit). Colorspace tag set authoritatively on the Swift side (as P1b does).
- [ ] Add `#[cfg(target_vendor = "apple")] maple_gpu_present_chain(session, layer, params, …)` to `raw-ffi/src/gpu.rs`, mirroring `maple_gpu_present_test_pattern`.
- [ ] **Autonomous test:** macOS host — the presented texture read back and diffed (CIEDE2000) vs the CPU `render` reference within budget, OR a `MapleUITests` screenshot diff (note the keychain/TouchID first-run caveat — if it blocks headless, build+commit the test and report a macOS UITest checkpoint; do not fake a pass). Commit.

### Task A2 — Surface the Auto Profile curve + residual-LUT as raw artifacts (CIColorCube replacement)

- [ ] The wgpu chain needs `FullChainInputs.profile_curve_flat` + `residual_lut_{size,data}` (separate passes), but Apple fits them into a pre-composed 33³ cube (`AutoProfileLUT.swift` / `maple_compute_auto_profile_lut`). Add/confirm a `gpu`-gated FFI returning the **raw fitted curve + residual LUT** (`fit_profile_curve_from_raw` + `fit_auto_profile_from_raw`, already `pub use` in `render/mod.rs`) so they plumb into `FullChainInputs`.
- [ ] **Test:** host parity — curve+LUT-as-two-passes output matches the cube-composed output within tolerance. Commit.

### Task A3 — Rewire `ImageEditPipeline.processSceneLinear` two-phase orchestration behind the flag

- [ ] Behind a runtime flag (`#if MAPLE_GPU` + launch-arg/setting, OFF in shipping, mirroring `GpuDebugView`), replace the per-tick CoreImage graph (steps 2–13) with: upload decoded buffer once → drive `LiveSession` via the C4/A1 FFI → present to the `CAMetalLayer`. Pass `capture_sharpening: None`, absolute WB, AE-already-baked (decode-boundary contract above).
- [ ] **Preserve the two-phase contract:** fast viewport-res pass, **cancellable** by mapping the existing `RenderCancelFlag.swift` (`Arc<AtomicBool>`-shaped) onto the chain's `CancelToken` (`requestCancel()` → `CancelToken::cancel()`); → **150ms-debounced** full-res refine. Reuse the existing debounce/generation-guard machinery. Keep the CPU+Metal path as the flag-off fallback.
- [ ] **Autonomous test:** `ImageEditPipelineTests` — flag-on vs flag-off (CPU) parity within tolerance at a fixed viewport size; cancel-mid-refine drops the stale result. Commit.

### Task A4 — USER CHECKPOINT: iOS on-device + 16ms perf (NOT agent-closable)

- [ ] Document the steps (`MAPLE_XCFRAMEWORK_GPU=1 … --release` xcframework, devicectl deploy, toggle the flag, drive sliders, read the in-app frame-time HUD). Device logs not capturable → surface in-app; synthetic taps blocked. 16ms target / 50ms hard limit on the reference scene set. **Owned by maintainer + assistant.**

### Task A5 — P4b-apple PR

- [ ] Push `claude/wgpu-p4b-apple`, base the merged P4b-core, `Closes` the P4b-apple sub-issue. Body: macOS present-parity number, curve/LUT-vs-cube finding, flag-gating confirmation, pending iOS-device + 16ms checkpoints.

---

## Part 3 — P4b-web (autonomous to the real-WebGPU-browser checkpoint; **depends on P1c #989**)

Files under `src/raw-pipeline/raw-wasm/src/` and `src/web/projects/maple-common/src/lib/`. Base the merged P4b-core.

### Task W1 — `gpu`-gated wasm `render_*_gpu` entry driving `full_chain`

- [ ] Extend `raw-wasm/src/gpu.rs` (today only `exposure_gpu_parity`) with `render_bytes_gpu(bytes, ext, xmp)`: decode (reuse existing) → upload → drive `build_live_chain` on the async `LiveSession` (wasm uses `run_async`/`new_async`) → run the **dither WGSL terminal (C2)** → u8 RGB matching `render_bytes`. Auto Profile applies via the chain's curve+LUT passes.
- [ ] **Test:** wasm parity — `render_bytes_gpu` u8 vs `render_bytes` within the per-fixture web budgets (this is where **dither is parity-gated**). Commit.

### Task W2 — WebGPU-canvas present + swap the live render path

- [ ] Once **P1c #989** lands the WebGPU canvas surface: in `raw-pipeline.worker.ts`, swap `render_bytes` → `render_bytes_gpu` behind an Angular env/runtime flag; present to P1c's WebGPU context on the **display-p3** canvas (today `image-canvas.component.ts` uses a 2D context + `ctx.drawImage`).
- [ ] **The re-render-on-edit gap is STALE/already-closed** (#846 — `image-canvas.component.ts` re-renders on adjustment change, 150ms-debounced via a `renderGeneration` effect). **Reuse** that effect; only swap the worker entry + present target.
- [ ] **Test:** the existing canvas re-render path drives the GPU entry; output matches the CPU bitmap within budget. Commit.

### Task W3 — USER CHECKPOINT: real WebGPU browser + perf (NOT agent-closable)

- [ ] WebGPU parity + the 16ms slider-tick budget need a **real WebGPU browser** (headless CI WebGPU unreliable). Document the manual verification (flag-on, drive sliders, confirm parity vs CPU canvas + frame time).

### Task W4 — P4b-web PR

- [ ] Push `claude/wgpu-p4b-web`, base the merged P4b-core; note the hard dependency on #989 landing. Body: wasm u8 parity number, the stale-gap note (#846 already re-renders), pending real-browser + perf checkpoints.

---

## Acceptance

- **P4b-core:** neutral `AdjustmentModel` GPU-gated output matches `develop`+`render` within `1e-4` (Risk A closed); single-stage-active parity; dither byte-parity; on-GPU airlight within tolerance on a realistic image (Risk B); zero-alloc re-render at stable dims; default `raw-ffi` build unchanged (wgpu-free).
- **P4b-apple:** macOS present parity vs CPU `render`; flag-off == today byte-for-byte; iOS device + 16ms (user checkpoint).
- **P4b-web:** wasm `render_bytes_gpu` within web budgets; flag-off == today; real-browser + perf (user checkpoint).

## Don'ts

No gating inside the merged `build_split` (a new wrapper). No `capture_sharpening` / `auto_exposure` re-apply on Apple (baked at decode). No `apply_delta` WB for the GPU path (canonical-absolute). No render-loop allocation (pool). No deleting the CPU/Metal/WebGL2 fallbacks (that's P5). No `gpu` in the default/shipping build. No `tail`/pipe on build output. Don't fake device/browser checkpoints.
