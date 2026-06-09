# wgpu + WGSL P5b — Decommission the Apple MSL render kernels — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. This is **destructive removal of a shipping path** — every precondition below is a HARD gate. Do NOT delete any MSL kernel until the GPU path is hardware-validated AND the default-flip has landed. Steps use `- [ ]`.

**Goal:** Remove the redundant Apple **MSL Metal kernels** (sharpen, nr_color, the blur they share) now that the WGSL chain renders them, collapsing GPU render math from 3 impls → 2 (Rust CPU oracle + WGSL). P5b of epic [#925](https://github.com/zubair-io/Maple/issues/925); closes [#1043](https://github.com/zubair-io/Maple/issues/1043). The web GLSL was already removed in **P5a (#1042/#1049)**; the Rust CPU core **stays** as the parity oracle + fallback.

---

## THE SAFETY FRAME — read before anything

The WGSL/GPU live path is currently **flag-OFF / dormant**. The **shipping** Apple render path is the hybrid CPU-FFI scene-linear chain + **two Metal kernels** (`MetalKernels.applySceneSharpen`, `applySceneNRColor`, sharing `applySeparableGaussianBlur`) + CIColorCube. **Deleting those kernels before the GPU path is validated AND the shipping default would break the product.**

**Order is `flip-then-delete`, never delete-then-flip.** The flag-flip makes WGSL the live default _with the old path still present as fallback_; only once that's proven in production-shaped builds do the deletions land.

### HARD preconditions — ALL must be true before any P5b deletion

- [ ] **iOS on-device validated** — #1028-A4 green: gpu xcframework + `-D MAPLE_GPU -Xcc -DMAPLE_GPU`, `MAPLE_GPU_LIVE=1`, devicectl deploy, slider drag, the **#1053 frame-time HUD** (`MAPLE_GPU_HUD=1`) reads ≤16ms target on the reference scene, and the GPU canvas matches the flag-off render.
- [ ] **Real WebGPU browser validated** — #1029-W3 green (parity within the web budgets + 16ms dehaze-off).
- [ ] **16ms perf met** — #1033 (on-GPU airlight, merged) + #1038 (web persistence, merged) confirmed on-device/in-browser, not just headless.
- [ ] **Flag flipped to default, in a production-shaped build, BEFORE deletion:**
  - **Apple:** the gpu xcframework is **built + committed** (today never committed; needs the #988 wgpu-vendoring decision), `MAPLE_GPU` defaulted-on for shipping, and `GpuLiveFlag.isEnabled` defaults true (today `false` unless `MAPLE_GPU_LIVE=1`).
  - **Web:** the `GPU_LIVE_RENDER_ENABLED` token defaulted true **and** the shipped wasm is the gpu-feature bundle (else the worker silently falls back to `render_bytes`).

---

## Classification — what goes, what stays

| Artifact                                   | Files                                                                                                                                                                         | Action                                                                                                                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MSL render kernels                         | `MapleCore/Sources/MapleCore/Metal/SceneNRColor.metal`, `SharpenLumaUSM.metal`, `SharpenEdgeMix.metal`, `SeparableGaussianBlur.metal`                                         | **DELETE** (after preconditions)                                                                                                                                                |
| Metal render wrappers                      | `MetalKernels.swift` — `applySceneSharpen`, `applySceneNRColor`, `applySeparableGaussianBlur` + their private kernel/pipeline/device loaders                                  | **DELETE (partial — see carve-out)**                                                                                                                                            |
| Unconditional call sites                   | `ImageEditPipeline.swift` (RAW 931/938, non-RAW 804/811) + comment refs in `GpuLiveParams.swift:31`, `PipelineRenderer.swift:923`, `RawCoreBridge.swift:19-20`                | **REMOVE**                                                                                                                                                                      |
| **AgX-LUT oracle (CARVE-OUT — KEEP)**      | `MetalKernels.swift` `agxLUTImage()`/`agxLUTBytes()`/`agxLUTImage(from:)`/`agxLUTFallback()`; bundled `Metal/agx_lut.bin`; `Package.swift:66 .copy("Metal")`                  | **KEEP** — cross-platform parity oracle (`testAppleBundledAgxLUTMatchesRustLUT`), NOT a render path. Do **not** `rm` the `Metal/` dir or delete `MetalKernels.swift` wholesale. |
| **Fallback companion (REQUIRED, same PR)** | `RawCoreBridge.swift` `stripAppleGPUStages` — `m.nrColor = 0` (108), `m.sharpenAmount = 0` (110)                                                                              | **UN-ZERO (decide)** — these are zeroed _because_ "Metal owns sharpen/nr_color." Removing Metal without this **silently drops sharpen + NR from the no-GPU fallback.**          |
| MSL tests                                  | `MetalKernelParityTests.swift`, `SceneLinearPipelineTests+{Sharpen,NoiseReduction,GaussianBlur}.swift`, the sharpen/NR/blur parts of `SceneLinearVisualRegressionTests.swift` | **Retarget to WGSL/Rust, or remove with the kernels.** KEEP `testAppleBundledAgxLUTMatchesRustLUT`.                                                                             |
| Rust CPU core, codegen                     | `raw-core/src/stages/*`, `raw-core/src/view/*`, `codegen/` (no `emit_msl`/`emit_glsl` — MSL was hand-authored)                                                                | **KEEP IN FULL** — the oracle/fallback.                                                                                                                                         |

---

## Tasks

### Task 1 — Decide + implement the fallback companion (A5)

**Files:** `RawCoreBridge.swift`.

- [ ] Pick ONE, state it explicitly in the PR: **(i)** un-zero `stripAppleGPUStages` (108/110) so the no-GPU fallback runs the Rust `sharpen.rs`/`noise_reduction.rs` stages — correct, pays the documented decode cost (nr_color@25 ~8.5s, sharpen@40 ~0.8s; acceptable for the headless/no-GPU oracle, NOT the live preview); **or (ii)** GPU path is the sole live-preview source + Rust stays export/headless-only, documenting that the no-GPU build has no live sharpen/NR.
- [ ] This is **not optional** — "delete the MSL files" alone is a silent fallback regression.

### Task 2 — Remove the MSL kernels + wrappers (carve-out preserved)

**Files:** the four `.metal` files; `MetalKernels.swift`; `ImageEditPipeline.swift`.

- [ ] Delete the four render `.metal` kernels. **Do NOT delete `Metal/agx_lut.bin`.**
- [ ] Delete `applySceneSharpen`/`applySceneNRColor`/`applySeparableGaussianBlur` + their private loaders from `MetalKernels.swift`; **keep** the `agxLUT*` accessors (consider renaming the surviving file to reflect its AgX-LUT-only role).
- [ ] Remove the unconditional Metal call sites in `ImageEditPipeline.swift` (804/811, 931/938); update the comment references.

### Task 3 — Retarget/remove the MSL tests

- [ ] Repoint `MetalKernelParityTests` + `SceneLinearPipelineTests+{Sharpen,NoiseReduction,GaussianBlur}` to the WGSL/Rust path, or remove with Task 2. **Keep** `testAppleBundledAgxLUTMatchesRustLUT` + any Rust-vs-GPU parity test.

### Task 4 — Verify (Apple is NOT cloud-CI-gated)

- [ ] `cd src/apple/Packages/MapleCore && swift build && swift test` — green (SourceKit "No such module" is indexer noise; the real build is authoritative).
- [ ] `xcodebuild -scheme "Maple Exposure" -destination 'platform=macOS' build` (flag-OFF default) — **BUILD SUCCEEDED** with the GPU path now the default (so the removed Metal path is genuinely unreferenced).
- [ ] The parity/fallback safety net stays GREEN (below).
- [ ] `git restore` any `RawPipeline.xcframework/Info.plist` build churn.

### Task 5 — PR

- [ ] Push; PR ready (not draft), base `main`, `Closes #1043`. Body: the A5 fallback decision, the carve-out confirmation (AgX-LUT oracle intact), the green safety-net gates, and the precondition checklist (all ticked).

---

## Parity / fallback safety net — GREEN on every P5b PR

- `src/scripts/test_color_pipeline.sh` (CIEDE2000 vs ACR refs; **ratchet budgets — no loosening**).
- The WGSL-vs-Rust per-stage parity (1e-4) + the Rust `glsl_port_matches_rust_lut`.
- Apple `testAppleBundledAgxLUTMatchesRustLUT` (the reason `agx_lut.bin` + the LUT accessors are carved out).
- Default (gpu-on-by-default now) `cargo build`/CI green; the Rust CPU core untouched.

## Don'ts

No deletion before ALL preconditions tick. Never delete-then-flip. Don't delete `Metal/agx_lut.bin` or the `agxLUT*` accessors. Don't touch `raw-core`. Don't skip the A5 fallback decision. No `tail`/pipe on build output.
