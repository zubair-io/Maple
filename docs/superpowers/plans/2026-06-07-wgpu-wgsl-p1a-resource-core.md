# wgpu + WGSL P1a — GPU resource core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn the P0 one-shot exposure kernel into a reusable **GPU-resident resource layer** — `raw-gpu` crate with upload-once image, ping-pong buffer pool, a multi-pass chain runner, and cancellable preview/full-res plumbing — proven headless by an N-pass exposure chain at `< 1e-4` with zero inter-pass readback. P1a of epic [#925](https://github.com/zubair-io/Maple/issues/925); closes [#987](https://github.com/zubair-io/Maple/issues/987).

**Architecture:** Extract a new `raw-gpu` workspace crate that owns all GPU code (the P0 exposure oracle + WGSL + runner move here). It exposes a `GpuContext` (device/queue), a `GpuImage` (scene-linear RGBA uploaded **once**), a `Pass` trait + `ExposurePass`, and a `ChainRunner` that ping-pongs two storage buffers across an ordered list of passes with a **single** final readback. `raw-core` drops its `gpu` module; `raw-wasm`'s `gpu` feature depends on `raw-gpu` directly. Everything stays behind the `gpu` feature, **OFF by default**.

**Tech stack:** Rust, `wgpu = "23"` (already pinned by P0), `pollster`, `futures-channel`, `bytemuck`.

**Design doc:** `docs/superpowers/specs/2026-06-07-wgpu-wgsl-gpu-unification-design.md` (see "P1 decomposition & execution order").

**Headless only.** No platform display surface, no Swift, no web — those are P1b (#988) / P1c (#989). Do not touch the live edit path (P4).

---

## wgpu API note (carry P0's lesson forward)

P0 found `wgpu 23.0.1`'s `request_device` **still takes the trace-path arg** (`None` as the 2nd argument) — the plan-vs-reality drift was real. Reuse P0's working `run_exposure_gpu_async` setup verbatim as the starting point for `GpuContext`; **adjust host-side calls to the compiler**, never the WGSL or the parity math. Confirm against `https://docs.rs/wgpu/23` if needed.

---

## File structure

| File                                                | Responsibility                                                                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `src/raw-pipeline/Cargo.toml` (modify)              | Add `raw-gpu` to `[workspace] members`                                                                           |
| `src/raw-pipeline/raw-gpu/Cargo.toml` (create)      | New crate; `wgpu`/`pollster`/`futures-channel`/`bytemuck` deps; no default features pull GPU into dependents     |
| `src/raw-pipeline/raw-gpu/src/lib.rs` (create)      | Crate root; re-exports `GpuContext`, `GpuImage`, `Pass`, `ChainRunner`, `ExposurePass`, `apply_exposure_gain`    |
| `src/raw-pipeline/raw-gpu/src/context.rs` (create)  | `GpuContext` (instance/adapter/device/queue), native `block_on` + shared async                                   |
| `src/raw-pipeline/raw-gpu/src/image.rs` (create)    | `GpuImage` — upload-once scene-linear RGBA → GPU storage buffer + dims; final readback helper                    |
| `src/raw-pipeline/raw-gpu/src/chain.rs` (create)    | `Pass` trait, `ChainRunner` (ping-pong two buffers across passes; one final readback; cancellation token)        |
| `src/raw-pipeline/raw-gpu/src/exposure.rs` (create) | `ExposurePass { ev }` + `apply_exposure_gain` oracle (moved from P0)                                             |
| `src/raw-pipeline/raw-gpu/src/exposure.wgsl` (move) | The P0 kernel, moved here                                                                                        |
| `src/raw-pipeline/raw-core/Cargo.toml` (modify)     | `gpu` feature → `["dep:raw-gpu"]`; drop wgpu/pollster/futures-channel direct deps                                |
| `src/raw-pipeline/raw-core/src/lib.rs` (modify)     | Remove `#[cfg(feature="gpu")] pub mod gpu;` (re-export `pub use raw_gpu as gpu;` only if needed for back-compat) |
| `src/raw-pipeline/raw-core/src/gpu/` (delete)       | Module contents move to `raw-gpu`                                                                                |
| `src/raw-pipeline/raw-wasm/Cargo.toml` (modify)     | `gpu` feature → depend on `raw-gpu` instead of `raw-core/gpu`                                                    |
| `src/raw-pipeline/raw-wasm/src/gpu.rs` (modify)     | Call `raw_gpu::*` instead of `raw_core::gpu::*`                                                                  |

---

## Task 1: Scaffold `raw-gpu` and migrate the P0 kernel (no behavior change)

**Goal:** move P0's gpu code into a new crate; prove the existing exposure parity test still passes and default builds are unchanged.

- [ ] **Step 1: Add the crate to the workspace.** In `src/raw-pipeline/Cargo.toml`, add `"raw-gpu"` to `[workspace] members`.

- [ ] **Step 2: Create `raw-gpu/Cargo.toml`** with `wgpu = "23"`, `pollster = "0.4"`, `futures-channel = "0.3"`, `bytemuck` (workspace). No `[features]` needed — the crate is only ever a dependency of the `gpu` features in raw-core/raw-wasm, so its presence in the tree is already gated by those.

- [ ] **Step 3: Move P0 code.** Move `raw-core/src/gpu/exposure.wgsl` → `raw-gpu/src/exposure.wgsl`. Split `raw-core/src/gpu/mod.rs` into `raw-gpu/src/exposure.rs` (`apply_exposure_gain` + the kernel dispatch) and the runner scaffolding into `context.rs`. Re-export from `raw-gpu/src/lib.rs`. Delete `raw-core/src/gpu/`.

- [ ] **Step 4: Rewire dependents.**
  - `raw-core/Cargo.toml`: `gpu = ["dep:raw-gpu"]`; remove the direct `wgpu`/`pollster`/`futures-channel` deps; add `raw-gpu = { path = "../raw-gpu", optional = true }`.
  - `raw-core/src/lib.rs`: remove the `pub mod gpu;` line.
  - `raw-wasm/Cargo.toml`: `gpu = ["dep:raw-gpu", "dep:wasm-bindgen-futures"]`; add `raw-gpu = { path = "../raw-gpu", optional = true }`.
  - `raw-wasm/src/gpu.rs`: `raw_core::gpu::run_exposure_gpu_async` → `raw_gpu::run_exposure_gpu_async`; same for `apply_exposure_gain`.

- [ ] **Step 5: Move the P0 parity test** into `raw-gpu` (`exposure.rs` `#[cfg(test)]`). Run it (NO output piping; generous timeout for the first wgpu compile):

```bash
cd src/raw-pipeline && cargo test -p raw-gpu wgsl_exposure_matches_cpu_oracle_within_1e_4 -- --nocapture
```

Expected: PASS, same numbers as P0 (`0 / 0 / 2.38e-7 / 0`).

- [ ] **Step 6: Prove default builds unchanged.**

```bash
cd src/raw-pipeline && cargo build -p raw-core && cargo build -p raw-wasm --target wasm32-unknown-unknown
cargo tree -p raw-core -i wgpu   # expect "did not match any packages"
cargo build -p raw-core --features gpu && cargo build -p raw-wasm --target wasm32-unknown-unknown --features gpu
```

Expected: default builds clean with wgpu absent; `--features gpu` builds clean (now via raw-gpu).

- [ ] **Step 7: Commit** (append the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer to every commit in this plan).

---

## Task 2: `GpuImage` — upload-once

**Goal:** a handle holding the image on the GPU, uploaded once, with a readback helper for tests/export.

- [ ] **Step 1: Failing test** in `image.rs`: upload a deterministic RGBA `f32` buffer, read it straight back, assert byte-identity.

```rust
#[test]
fn gpu_image_uploads_and_reads_back_identity() {
    let ctx = GpuContext::new_blocking();
    let input = test_buffer(256);                 // shared helper, RGBA f32
    let img = GpuImage::upload(&ctx, &input, 16, 16);
    let out = img.read_back_blocking(&ctx);
    assert_eq!(input, out);
}
```

- [ ] **Step 2:** Implement `GpuContext` (wrap P0's instance/adapter/device/queue setup; expose `new_blocking()` for native + the shared async) and `GpuImage { buffer, width, height }` with `upload(&ctx, &[f32], w, h)` (creates a STORAGE|COPY_SRC|COPY_DST buffer via `create_buffer_init`) and `read_back_blocking(&ctx) -> Vec<f32>` (copy to a MAP_READ buffer, map, cast). Run the test → PASS.

- [ ] **Step 3: Commit.**

---

## Task 3: Ping-pong `ChainRunner`

**Goal:** run an ordered list of passes, alternating two GPU buffers, with exactly one readback at the end.

- [ ] **Step 1: Failing test** in `chain.rs`: a 2-pass **identity** chain (a pass that copies in→out unchanged) round-trips the input.

```rust
#[test]
fn chain_runner_two_identity_passes_round_trip() {
    let ctx = GpuContext::new_blocking();
    let input = test_buffer(256);
    let img = GpuImage::upload(&ctx, &input, 16, 16);
    let runner = ChainRunner::new(&ctx, &img);
    let out = runner.run_blocking(&[&IdentityPass, &IdentityPass]);
    assert_eq!(input, out);
}
```

- [ ] **Step 2:** Define `trait Pass { fn encode(&self, ctx: &GpuContext, enc: &mut CommandEncoder, src: &Buffer, dst: &Buffer, dims: (u32,u32)); }`. Implement `ChainRunner` holding **two** ping-pong buffers (A/B) sized to the image; for pass `i`, bind `src = buffers[i%2]`, `dst = buffers[(i+1)%2]`; submit **once** after encoding all passes (or per pass, but **no map between passes**); a single `copy_buffer_to_buffer` + map after the last pass. Add a private `IdentityPass` test helper. Run → PASS.

- [ ] **Step 3: Assert zero inter-pass readback** — structurally: `ChainRunner` exposes a `readback_count` (incremented only in the final map) and the test asserts it equals `1` after an N-pass run. Run → PASS.

- [ ] **Step 4: Commit.**

---

## Task 4: N-pass exposure chain + parity (the headless proof)

- [ ] **Step 1: Failing test:** an N-pass chain of `ExposurePass(ev_i)` equals the CPU oracle composed over all passes, `< 1e-4`.

```rust
#[test]
fn n_pass_exposure_chain_matches_composed_oracle_within_1e_4() {
    let ctx = GpuContext::new_blocking();
    let input = test_buffer(256);
    let evs = [0.5_f32, -1.0, 2.0];               // 3 passes; composed gain = 2^(0.5-1+2)
    let img = GpuImage::upload(&ctx, &input, 16, 16);
    let passes: Vec<ExposurePass> = evs.iter().map(|&ev| ExposurePass { ev }).collect();
    let gpu = ChainRunner::new(&ctx, &img)
        .run_blocking(&passes.iter().map(|p| p as &dyn Pass).collect::<Vec<_>>());
    let mut cpu = input.clone();
    for &ev in &evs { apply_exposure_gain(&mut cpu, ev); }
    let max = cpu.iter().zip(&gpu).map(|(a,b)|(a-b).abs()).fold(0.0_f32, f32::max);
    assert!(max < 1e-4, "n-pass max abs diff {max}");
    assert_eq!(ChainRunner::new(&ctx, &img).last_readback_count(), 1);
}
```

- [ ] **Step 2:** Implement `ExposurePass { ev }` as a `Pass` (reuse the P0 WGSL/pipeline; `ev` in the params uniform). Run → PASS. This is the **headless P1a proof**: a real multi-pass GPU-resident chain, parity-locked, single readback.

- [ ] **Step 3: Commit.**

---

## Task 5: Preview/full-res + cancellation plumbing

- [ ] **Step 1: Failing tests:**
  - `GpuImage::upload` works at two sizes (e.g. 16×16 "full" and an 8×8 "preview"), each round-tripping.
  - A `CancelToken` (an `Arc<AtomicBool>` / generation counter) checked by `ChainRunner` between passes: when cancelled before pass 2, `run_blocking` returns `None` (or `Err(Cancelled)`).

```rust
#[test]
fn chain_runner_cancels_between_passes() {
    let ctx = GpuContext::new_blocking();
    let img = GpuImage::upload(&ctx, &test_buffer(256), 16, 16);
    let token = CancelToken::new();
    token.cancel();                                  // pre-cancelled
    let runner = ChainRunner::new(&ctx, &img);
    let out = runner.run_cancellable(&[&ExposurePass{ev:1.0}, &ExposurePass{ev:1.0}], &token);
    assert!(out.is_none());
}
```

- [ ] **Step 2:** Implement the two-size upload (just parameterized dims — downscaling the _pixels_ is the caller's job, P4) and `run_cancellable(passes, &CancelToken) -> Option<Vec<f32>>` that checks the token before each pass-encode and bails. Run → PASS.

- [ ] **Step 3:** Update the module docs to state the two-phase contract (preview = small upload, refine = full upload; cancellation via the token; the _resolution-selection policy_ and live wiring are P4). Commit.

---

## Task 6: Open the PR (stacked on #978)

- [ ] **Step 1:** Push the branch (the dispatch will tell you the exact branch name).
- [ ] **Step 2:** Open the PR **ready (not draft)**, `Closes #987`, **base = `claude/upbeat-fermi-7dc030`** (it stacks on #978; note in the body it should be rebased/retargeted to `main` after #978 merges). Body: summary, the headless parity numbers, the readback-count assertion, default-build-unchanged evidence, and a line that this is headless-only (no display surface; P1b/P1c next).

---

## Self-review

**Spec coverage:** `raw-gpu` crate → Task 1; upload-once → Task 2; ping-pong + zero inter-pass readback → Task 3 (+ readback_count assert); multi-pass parity proof → Task 4; preview/full-res + cancellable two-phase → Task 5. Off-by-default preserved → Task 1 Step 6. Headless-only / no live wiring → stated throughout. Acceptance items from #987 all mapped.

**Placeholder scan:** no vague steps; every test has concrete code. Buffer-pool _internals_ are intentionally left to the implementer (with the wgpu-drift note) — the API shape (`GpuContext`, `GpuImage`, `Pass`, `ChainRunner`, `ExposurePass`, `CancelToken`) and the parity contract are fixed here. That is design latitude, not a placeholder.

**Type consistency:** `apply_exposure_gain(&mut [f32], f32)`, `GpuImage::upload(&ctx, &[f32], u32, u32)`, `ChainRunner::run_blocking(&[&dyn Pass]) -> Vec<f32>`, `run_cancellable(&[&dyn Pass], &CancelToken) -> Option<Vec<f32>>`, `last_readback_count() -> u32` used consistently across Tasks 2–5.
