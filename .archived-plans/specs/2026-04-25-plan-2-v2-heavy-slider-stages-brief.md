# Plan 2 v2 — Heavy Slider Stages on Scene-Linear Metal Kernels (Design Brief)

Plan 2 v1 ([`.archived-plans/plans/2026-04-25-plan-2-dev-chain-metal-kernels.md`](../plans/2026-04-25-plan-2-dev-chain-metal-kernels.md)) shipped white balance, scene tone controls, vibrance, saturation, AgX, and sidecar threading. Commit `04099d2` made `useSceneLinear = true` permanent. The legacy `applyFilters` chain at [`ImageEditPipeline.swift:512`](../../../src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift) is unreachable on the default path but still in the tree. Plan 2 v2 ports the remaining six heavy-slider stages and deletes `applyFilters`.

## 1. Shared blur kernel design

Every Rust stage except dehaze leans on `gaussian_blur_rgb` ([`blur.rs:89`](../../../src/raw-pipeline/raw-core/src/stages/blur.rs)) — a 3-pass separable box-blur Gaussian approximation (Wells 1986). M4 should standardize a single Apple primitive that mirrors this exactly: identical `r_box = (radius/3).max(1)` and three sequential horizontal+vertical box passes. Parity is bit-budget critical; any deviation re-opens the ΔE harness.

**Recommendation: a `MTLComputePipeline` `SeparableGaussianBlur`, NOT a `CIKernel`.** Reasons grounded in [`MetalKernels.swift:174-240`](../../../src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift):

- Existing kernels are all `CIColorKernel` (per-pixel) or `CIKernel` with a sampler (AgX LUT). `CIKernel` cannot author a stateful 6-pass convolution that retains intermediate buffers — each `apply` builds one ROI graph.
- A 3-pass approximation requires 6 dispatches (3 H + 3 V) plus transpose scratch (mirrors `tmp_col` at [`blur.rs:49`](../../../src/raw-pipeline/raw-core/src/stages/blur.rs)). A `MTLCommandBuffer` of 6 compute encodes is the natural shape.
- Downstream stages consume the blur as input to a per-pixel mix. Wrap compute output in a `CIImage` via `CIImage(mtlTexture:)` and feed the existing `CIColorKernel` chain. Hybrid is one-way: compute → CI, never CI → compute mid-chain.

Trade-off: bypasses CoreImage's tile auto-planner for the blur itself. Consequence: full-image fp16 RGBA scratch (~30 MB at 6K×4K, fine vs the 200 MB iPhone tile cap), but downstream `CIColorKernel`s still tile.

## 2. Per-stage kernel inventory

| Rust source | Apple kernel | Approach | Effort | Halo |
|---|---|---|---|---|
| [`clarity.rs:10`](../../../src/raw-pipeline/raw-core/src/stages/clarity.rs) | `SceneClarity` | shared blur + `CIColorKernel` mix | S | 40 px |
| [`texture.rs:10`](../../../src/raw-pipeline/raw-core/src/stages/texture.rs) | `SceneTexture` | shared blur + `CIColorKernel` mix | XS | 3 px |
| [`noise_reduction.rs:24`](../../../src/raw-pipeline/raw-core/src/stages/noise_reduction.rs) | `SceneNRLuminance` | Oklab roundtrip + shared blur on L | S | ≤2 px |
| [`noise_reduction.rs:64`](../../../src/raw-pipeline/raw-core/src/stages/noise_reduction.rs) | `SceneNRColor` | Oklab roundtrip + shared blur on a/b | S | ≤4 px |
| [`sharpen.rs:33`](../../../src/raw-pipeline/raw-core/src/stages/sharpen.rs) | `SceneSharpen` | bespoke `MTLComputePipeline` for 3-iter RL + `CIColorKernel` edge mask | M | ~9 px |
| [`dehaze.rs:144`](../../../src/raw-pipeline/raw-core/src/stages/dehaze.rs) | `SceneDehaze` | 3 compute dispatches: dark-channel min-filter, atmospheric-light reduction, guided-filter | L | 67 px |

## 3. Tile-rendering composition

The Deep Zoom plan ([`.archived-plans/plans/2026-04-25-deep-zoom-tile-rendering.md:14-15`](../plans/2026-04-25-deep-zoom-tile-rendering.md)) already locks 35 px overlap, sized for clarity's 39-px effective tail (40 / 3 × 3 box passes). Widening overlap to 67 px would push waste from 22.6% to 38.6% on 512² tiles — material throughput cost.

**Recommendation (a): keep dehaze on whole-image render at deep zoom; do not widen overlap.** This matches the existing tile FFI fallback at [`pipeline.rs` § "Dehaze fallback"](../plans/2026-04-25-deep-zoom-tile-rendering.md): when `model.dehaze != 0`, the tile entry already returns `MAPLE_TILE_UNSUPPORTED_DEHAZE` and the UI clamps `maxPixelScale` to fit-zoom. Plan 2 v2 inherits that behavior — `SceneDehaze` runs whole-image only. Clarity (40 px radius) is the binding constraint and stays inside the 35-px budget; texture (3 px), NR luma (≤2 px), NR color (≤4 px), and sharpen (~9 px) are all comfortably tile-safe.

## 4. Sequencing milestones

- **M1 — Shared blur.** `SeparableGaussianBlur` `MTLComputePipeline` + `MetalKernels.applySeparableGaussianBlur(to:radius:)` returning a `CIImage`. Parity test against `gaussian_blur_rgb`.
- **M2 — Clarity + texture.** Both unsharp mask in scene-linear Rec.2020. A single `extern "C" float4 sceneUnsharp(coreimage::sampler_h src, coreimage::sampler_h blurred, float amount)` mix kernel covers both — only radius differs. Visible slider behavior on the new path.
- **M3 — NR luminance + NR color.** Oklab roundtrip via existing matrices ([§ 7](#7-whitebalance--chroma-round-trip)) + shared blur on the L or a/b plane. Integer-radius math from [`noise_reduction.rs:24,64`](../../../src/raw-pipeline/raw-core/src/stages/noise_reduction.rs).
- **M4 — Sharpen.** Bespoke `MTLComputePipeline` for the 3-iter Richardson-Lucy update; reuses shared blur as the PSF convolution. Edge-aware mix as a final `CIColorKernel`.
- **M5 — Dehaze.** Three compute dispatches: 15×15 dark-channel min-filter, atmospheric-light top-0.1% reduction, 60-radius guided filter. Deferred until M1-M4 prove the architecture.
- **M6 — Delete legacy.** Strip `applyFilters` ([`ImageEditPipeline.swift:512`](../../../src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift)). Retire `MAPLE_SKIP_SWIFT_AGX` ([`ImageEditPipeline.swift:679`](../../../src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift)) and `MAPLE_SKIP_SWIFT_FILTERS` ([`ImageEditPipeline.swift:520`](../../../src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift)). Commit `04099d2` already removed `MAPLE_SKIP_PRESCALE`; M6 finishes the cleanup.

## 5. Color domain

All six Rust stages run scene-linear Rec.2020 — confirmed at [`pipeline.rs:127-132`](../../../src/raw-pipeline/raw-core/src/pipeline.rs) (clarity → texture → dehaze → sharpen → nr_luminance → nr_color all consume the post-saturation scene-linear `Image`). Apple kernels execute identically. No display-domain ops, no AgX precondition. Order on the new path becomes: WB → tone → vibrance → saturation → **clarity → texture → dehaze → sharpen → NR luma → NR color** → AgX.

## 6. Sidecar plumbing

Already done. Plan 2 v1 M3 threaded `xmpPath` through `decodeSceneLinear` (commit `bc66da0`) and the live `AdjustmentModel` reaches `processSceneLinear` ([`ImageEditPipeline.swift:291`](../../../src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift)). The new kernels read `model.clarity`, `model.texture`, `model.dehaze`, `model.sharpen_*`, `model.nr_luminance`, `model.nr_color` directly. No FFI changes.

## 7. WhiteBalance + chroma round-trip

NR luma and NR color need Oklab. The Oklab matrices (`M_rec2020_to_lms`, `M_lms_to_oklab`, etc.) live in [`SceneVibrance.metal:16-38`](../../../src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneVibrance.metal) and are duplicated in `SceneSaturation.metal` per Plan 2 v1's note that "Metal doesn't share `constant` globals between .metal files." 

**Recommendation: extract `oklab.metal` and `#include` it from each consumer.** Apple's CIKernel Metal preprocessor supports `#include` when the included file ships in the same `.copy("Metal")` bundle — verify this in M1 (it's the lowest-risk place to land it). Falls back to copy-paste if `CIKernel.kernels(withMetalString:)` doesn't resolve includes from the SwiftPM resource bundle.

## 8. Open questions

- **Does CoreImage compose a `MTLComputePipeline` output cleanly with downstream `CIColorKernel`s via `CIImage(mtlTexture:)`?** This is the load-bearing assumption for the M1 architecture.
- **For sharpen's 3-iter RL, does CoreImage's planner re-fuse the chain when each iteration is a separate `CIKernel.apply` call** — or does it materialise scratch on every step? Profile early.
- **Atmospheric-light reduction (top 0.1% of dark-channel pixels, [`dehaze.rs:29`](../../../src/raw-pipeline/raw-core/src/stages/dehaze.rs)) is whole-image.** A two-pass dispatch (per-tile partial reductions → final whole-image reduce) is standard, but Metal threadgroup-shared parallel-reduce primitives need verification against the Rust scalar's deterministic sort.
- **Does `#include` from a Metal source compiled via `CIKernel.kernels(withMetalString:)` resolve relative to `Bundle.module/Metal/`?** If not, `oklab.metal` becomes a copy-paste in each kernel.

## 9. Recommended cut for Plan 2 v2 v1

**M1 (shared blur) + M2 (clarity + texture).** Smallest plan that ships visible slider behavior on the new path. Clarity is the most-used heavy slider in the legacy chain and the binding tile-overlap constraint — proving it on the new path validates both the shared-blur architecture and the Deep Zoom math in one shot. Texture rides for free. NR (M3), sharpen (M4), dehaze (M5), and the `applyFilters` deletion (M6) become separate plans, each with their own ΔE budget gate.
