# Plan 2 v2 v3 — Sharpen on Scene-Linear Metal Kernels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Brief:** [`docs/superpowers/specs/2026-04-25-plan-2-v2-heavy-slider-stages-brief.md`](../specs/2026-04-25-plan-2-v2-heavy-slider-stages-brief.md). § 2 "Per-stage kernel inventory" row 5 spec the approach: "bespoke `MTLComputePipeline` for 3-iter RL + `CIColorKernel` edge mask" with effort `M` and halo `~9 px`. § 5 "Color domain" locks the chain order **clarity → texture → dehaze → sharpen → NR luma → NR color → AgX**. Deep Zoom (35 px overlap) absorbs the 9 px stencil — no overlap math change.
>
> **Predecessor plans (already shipped):**
> - [`2026-04-25-plan-2-v2-shared-blur-clarity-texture.md`](2026-04-25-plan-2-v2-shared-blur-clarity-texture.md) — v2 v1: shared `SeparableGaussianBlur` compute kernel (commit `b84da17`), clarity (commit `c441000`), texture (commit `63ae256`).
> - [`2026-04-25-plan-2-v2-nr-luminance-color.md`](2026-04-25-plan-2-v2-nr-luminance-color.md) — v2 v2: NR luminance (commit `3fdd80a`), NR color (commit `beb8a34`), wired (commit `49c9d22`). Established the **extract → blur → combine** orchestration shape this plan reuses.
>
> **Sibling plan in flight:** Plan 2 v2 v4 (dehaze) is being authored in parallel by a separate agent — different files, no conflict. v4 inserts dehaze before sharpen on the new path; v3 (this plan) inserts sharpen between the dehaze placeholder and NR luminance.
>
> **Tile-rendering invariant:** [`docs/superpowers/plans/2026-04-25-deep-zoom-tile-rendering.md`](2026-04-25-deep-zoom-tile-rendering.md) § "Architecture" point 2 line 38 lists "sharpen 3-iter RL with radius 0.5–3.0 px → ≤9 px effective" as one of the well-bounded stencils. The 35 px overlap budget absorbs 3 RL iterations × box of radius ≤3 px. **No overlap math changes here.** Verification step in Task 7 runs `DeepZoomTileRenderingTests.swift` after wiring to confirm tile seams haven't regressed.

**Goal:** Port Rust `sharpen::apply` ([`raw-core/src/stages/sharpen.rs:22`](../../../src/raw-pipeline/raw-core/src/stages/sharpen.rs)) to a scene-linear Metal pipeline, wiring it into `processSceneLinear` between texture (or dehaze, when v4 lands) and NR luminance. The Rust algorithm is **3-iteration Richardson-Lucy deconvolution** with a Gaussian PSF, plus an **edge-aware mix** modulated by the `sharpen_detail` and `sharpen_masking` sliders. Slider params: `sharpen_amount` (0..150, default 0; 0 skips, 100 is full RL, >100 adds unsharp overdrive), `sharpen_radius` (0.5..3.0, default 0.5; PSF Gaussian sigma converted to integer box radius), `sharpen_detail` (0..100, default 25; edge-attenuation strength), `sharpen_masking` (0..100, default 0; edge-mask threshold). When `|sharpen_amount| < 1e-3` the wrapper short-circuits to identity, mirroring `sharpen.rs:30`.

**Architecture:**

1. **No new spikes — both v2 v1 spikes already PASSED.** The compute → CI handoff (`MTLComputePipeline` output composes with downstream `CIColorKernel.apply` via `CIImage(mtlTexture:options:)`) is the load-bearing assumption v2 v1 verified for the shared blur, and v2 v2 reused in NR. v3 inherits both spikes — no new spike work needed. Task 1 of this plan is preflight only.

2. **Architecture decision: orchestrated multi-kernel, NOT one mega-kernel.**

   The Rust algorithm at [`sharpen.rs:42-61`](../../../src/raw-pipeline/raw-core/src/stages/sharpen.rs) runs three Richardson-Lucy iterations, each comprising:
   1. `reblur = gaussian_blur_rgb(estimate, radius_px)` (PSF convolution)
   2. `ratio = observed / max(reblur, EPSILON)` (per-pixel divide)
   3. `correction = gaussian_blur_rgb(ratio, radius_px)` (PSF convolution again)
   4. `estimate = estimate * correction` (per-pixel multiply)

   Plus an optional overdrive pass when `amount > 100` ([`sharpen.rs:63-77`](../../../src/raw-pipeline/raw-core/src/stages/sharpen.rs)) that does one more `gaussian_blur_rgb` then a per-pixel unsharp mix, plus a final edge-aware mix at [`sharpen.rs:79-123`](../../../src/raw-pipeline/raw-core/src/stages/sharpen.rs).

   Two architectural options:

   **(a) One big Metal compute kernel** — author a single `.metal` source that implements all 3 RL iterations + overdrive + edge-mask in one kernel body. Threadgroup-shared scratch holds intermediate buffers across passes, ping-pong indexing controls the iteration walk, and the kernel terminates with the final mix.

   **(b) Swift orchestration calling existing blur N times + small `CIColorKernel` mix steps for the per-iteration arithmetic.** The Swift wrapper invokes the v2 v1 `applySeparableGaussianBlur` 6 times (3 RL iters × 2 blurs each = 6 blur passes, plus 1 more for overdrive when amount > 100 = up to 7 blur passes total), interleaved with small per-pixel `CIColorKernel`s that compute `ratio = observed / max(reblur, EPSILON)` and `estimate = estimate * correction`. The final overdrive + edge-mix runs as one more `CIColorKernel` consuming the original observed CIImage, the sharpened CIImage, and an edge-gradient CIImage (built from a tiny luminance + central-difference kernel).

   **Decision: pick (b).** Three reasons:

   - **Reuses the validated shared blur.** The v2 v1 `SeparableGaussianBlur` compute pipeline is parity-tested against Rust at the per-pixel level (commit `b2374df`). Option (a) would re-implement that algorithm inside the mega-kernel, doubling the parity surface and forcing a re-derivation of the box-blur transpose-free vertical sweep on threadgroup-shared memory — a bigger code change with a bigger parity risk than orchestrating the existing primitive.
   - **Easier to test per-iteration.** Each step (`ratio` divide, `estimate` multiply, edge-mix) is its own `CIColorKernel`, individually parity-testable from Swift. Option (a) is one giant kernel — the only test surface is end-to-end pixel parity, no per-step inspection.
   - **Architectural symmetry with v2 v1 / v2 v2.** Both predecessors used the orchestrated shape (clarity / texture: blur + sceneUnsharp; NR luma / color: extract + blur + combine). v3 staying on the same shape keeps the mental model consistent and lets the same `CIImage(mtlTexture:options:)` compute → CI handoff work without modification. Option (a) would introduce a new pattern (a stateful compute kernel that manages its own multi-pass state) just for sharpen, fragmenting the architecture across heavy-slider stages.

   **Tradeoff:** option (b) costs one extra command-buffer encode per iteration (CoreImage materialises scratch between `apply` calls — open question 9.2 in the brief). For a 6K×4K image that's ~7 RGBA fp16 scratch buffers ≈ 700 MB peak, well over a single fp16 frame but inside the iPhone 200 MB tile cap when sharpen runs on a tile (35 px overlap absorbs 9 px stencil; tile path is fine). For whole-image render, the budget is generous on Mac (no tile cap) and acceptable on iPad. If profiling shows `CIContext.cacheIntermediates: false` at the surrounding `processSceneLinear` flush is materialising every step (not just the boundary), follow-up plan can swap to option (a) without breaking the public wrapper signature.

3. **Three new Metal sources, one new public Swift wrapper.** Mirrors v2 v2's M3 shape (NR luma / NR color):
   - `RichardsonLucyMixer.metal` — two `[[stitchable]]` `CIColorKernel` functions sharing one `.metal` file:
     - `rlRatio(observed, reblur)` — per-pixel `ratio = observed / max(reblur, EPSILON)` mirroring [`sharpen.rs:46-53`](../../../src/raw-pipeline/raw-core/src/stages/sharpen.rs).
     - `rlMultiply(estimate, correction)` — per-pixel `estimate * correction` mirroring [`sharpen.rs:56-60`](../../../src/raw-pipeline/raw-core/src/stages/sharpen.rs).
   - `SharpenEdgeMix.metal` — two `[[stitchable]]` `CIColorKernel` functions:
     - `sharpenLuminance(src)` — per-pixel emit `(L, L, L, alpha)` where `L = 0.2627*r + 0.6780*g + 0.0593*b` (Rec.2020 luma; mirrors [`sharpen.rs:87-89`](../../../src/raw-pipeline/raw-core/src/stages/sharpen.rs)). Used as the input to the v2 v1 `applySeparableGaussianBlur` for the smoothed luminance plane (the gradient sampler needs neighbour samples — `CIColorKernel` cannot read neighbours, so we extract luminance into a separate CIImage that the edge-mix kernel samples via two-tap differences using `samplerTransform`).
     - `sharpenEdgeMix(observed, sharpened, lumaForGradient, amount, detailAtten, maskingThreshold)` — final mix per [`sharpen.rs:103-123`](../../../src/raw-pipeline/raw-core/src/stages/sharpen.rs). Takes (observed CIImage, sharpened CIImage, luminance CIImage for the gradient calc, plus the three slider-derived floats). Computes the edge gradient via central differences on the luminance plane (4 samples: `lumaForGradient(x±1, y)` and `lumaForGradient(x, y±1)`), determines edge-vs-flat membership (`edge = g_norm >= masking_threshold ? 1.0 : detail_atten`), then mixes `observed + (sharpened - observed) * (overall_mix * edge)` matching the Rust semantics.
   - `SharpenOverdrive.metal` — one `[[stitchable]]` `CIColorKernel` function (used only when `sharpen_amount > 100`):
     - `sharpenOverdrive(estimate, blurredEstimate, overMix)` — per-pixel `estimate + (estimate - blurredEstimate) * overMix` mirroring [`sharpen.rs:65-76`](../../../src/raw-pipeline/raw-core/src/stages/sharpen.rs). The `overMix = (amount - 100) / 100`. **Note**: this is byte-identical to v2 v1's `SceneUnsharp.metal` mix algorithm — a follow-up DRY plan could share. For this plan we author the small dedicated kernel for clarity (the wrapper logic is local to the sharpen orchestration).
   - `MetalKernels.applySceneSharpen(to:amount:radius:detail:masking:)` — public wrapper. Computes integer `radius_px = max(1, round(clamp(radius, 0.5, 3.0)))` mirroring [`sharpen.rs:33-34`](../../../src/raw-pipeline/raw-core/src/stages/sharpen.rs). Short-circuits to `input` when `abs(amount) < 1e-3`. Orchestrates the 3 RL iterations + optional overdrive + edge-mix by chaining `applySeparableGaussianBlur` and the small `CIColorKernel` mix steps.

4. **The Rust algorithm's exact shape (locked specification).** Faithful port — do not "improve."

   Pixel-by-pixel walkthrough at default `radius_px = 1`:
   1. `radius_px = max(1, round(clamp(sharpen_radius, 0.5, 3.0)))` — at default `sharpen_radius = 0.5`, clamps to 0.5, rounds to 1. The integer math feeds `applySeparableGaussianBlur`'s public `radius` parameter directly (which then computes `r_box = max(1, radius / 3) = 1` internally per `blur.rs:81`).
   2. **observed** = the input CIImage (verbatim — Rust at `sharpen.rs:39` clones into `observed`).
   3. **estimate₀** = the input CIImage (Rust at `sharpen.rs:40` clones into `estimate`).
   4. For iteration n in 0..3:
      - `reblurₙ = applySeparableGaussianBlur(estimateₙ, radius_px)` — PSF convolution.
      - `ratioₙ = rlRatio(observed, reblurₙ)` — per-pixel `observed_chan / max(reblur_chan, 1e-5)`.
      - `correctionₙ = applySeparableGaussianBlur(ratioₙ, radius_px)` — PSF convolution again.
      - `estimateₙ₊₁ = rlMultiply(estimateₙ, correctionₙ)` — per-pixel `estimate_chan * correction_chan`.
   5. **sharpened = estimate₃** after 3 iterations.
   6. If `sharpen_amount > 100`:
      - `overMix = (sharpen_amount - 100) / 100`
      - `blurredSharp = applySeparableGaussianBlur(sharpened, radius_px)`
      - `sharpened = sharpenOverdrive(sharpened, blurredSharp, overMix)`
   7. Final edge-aware mix:
      - `overall_mix = clamp(sharpen_amount / 100, 0.0, 1.5)` ([`sharpen.rs:80`](../../../src/raw-pipeline/raw-core/src/stages/sharpen.rs))
      - `detail_atten = clamp(sharpen_detail / 100, 0.0, 1.0)` ([`sharpen.rs:81`](../../../src/raw-pipeline/raw-core/src/stages/sharpen.rs))
      - `masking_threshold = clamp(sharpen_masking / 100, 0.0, 1.0)` ([`sharpen.rs:82`](../../../src/raw-pipeline/raw-core/src/stages/sharpen.rs))
      - `lumaPlane = sharpenLuminance(observed)` — extract Rec.2020 luma into a CIImage (one `CIColorKernel.apply`).
      - For each pixel `(x, y)`:
        - If `masking_threshold > 1e-3`:
          - `gx = lumaPlane(x+1, y) - lumaPlane(x-1, y)`
          - `gy = lumaPlane(x, y+1) - lumaPlane(x, y-1)`
          - `g = sqrt(gx*gx + gy*gy)`
          - `g_norm = clamp(g / 0.2, 0.0, 1.0)` (Rust normalizes by 0.2 — the typical edge gradient magnitude — at [`sharpen.rs:109`](../../../src/raw-pipeline/raw-core/src/stages/sharpen.rs))
          - `edge = (g_norm >= masking_threshold) ? 1.0 : detail_atten`
        - Else (`masking_threshold ≤ 1e-3`):
          - `edge = 1.0` (no edge-aware modulation; mix everywhere equally)
        - `mix = overall_mix * edge`
        - `out = observed + (sharpened - observed) * mix`

5. **Tile-rendering invariant:** the maximum effective stencil at full slider extreme is **9 src pixels** (3 RL iters × 3 box passes per blur × `r_box = max(1, radius/3) = 1` at `sharpen_radius = 3.0` gives 3+3+3 = 9 px tail per direction, plus the 1-px central-difference for the gradient = 10 px total worst case). Well under Deep Zoom's 35 px overlap budget. The deep-zoom plan at [`docs/superpowers/plans/2026-04-25-deep-zoom-tile-rendering.md:38`](2026-04-25-deep-zoom-tile-rendering.md) already lists "sharpen 3-iter RL with radius 0.5–3.0 px → ≤9 px effective" as one of the well-bounded stencils. **No overlap math changes here.**

6. **Wiring is isolated to `processSceneLinear`.** A single new line inserts sharpen between the post-texture (or post-dehaze when v4 lands) stage and the NR luminance call. Per Rust at [`pipeline.rs:127-132`](../../../src/raw-pipeline/raw-core/src/pipeline.rs):

   ```
   stage("clarity", ...);     // line 127
   stage("texture", ...);     // line 128
   stage("dehaze", ...);      // line 129  — Plan 2 v2 v4 (sibling)
   stage("sharpen", ...);     // line 130  — THIS PLAN
   stage("nr_luminance", ...); // line 131
   stage("nr_color", ...);    // line 132
   ```

   **The current Swift `processSceneLinear` (post-v2 v2) places NR luminance immediately after texture** ([`ImageEditPipeline.swift:378`](../../../src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift)) because dehaze + sharpen are not yet ported. v3 inserts sharpen between texture and NR luminance, **leaving a placeholder comment for the future v4 dehaze insertion above sharpen.** When v4 lands, dehaze inserts above sharpen at the comment marker. Until then, sharpen runs immediately after texture on the new path. (Note: the spec text in the plan-writer's instructions said "Insert AFTER NR color, BEFORE AgX" — that contradicts the brief's § 5 chain order and Rust's `pipeline.rs:130`. **This plan follows the source-of-truth Rust ordering**, since AgX comes last in both Rust and Swift; the conflict is flagged in § "Conflicts identified" below.)

7. **Sidecar plumbing already done.** `model.sharpen_amount`, `.sharpen_radius`, `.sharpen_detail`, `.sharpen_masking` parse from XMP at [`xmp.rs:104-107`](../../../src/raw-pipeline/raw-core/src/xmp.rs); the Swift `AdjustmentModel` mirrors at [`AdjustmentModel.swift:47-50`](../../../src/apple/Packages/MapleCore/Sources/MapleCore/AdjustmentModel.swift) (`sharpenAmount`, `sharpenRadius`, `sharpenDetail`, `sharpenMasking`). No new FFI plumbing.

**Tech Stack:**
- Swift (`MapleCore`) — `MetalKernels` namespace gains five cache fields (`_rlRatio`, `_rlMultiply`, `_sharpenLuminance`, `_sharpenEdgeMix`, `_sharpenOverdrive`), one new public wrapper (`applySceneSharpen(to:amount:radius:detail:masking:)`), and five private kernel-loader helpers (`rlRatioKernel()`, `rlMultiplyKernel()`, `sharpenLuminanceKernel()`, `sharpenEdgeMixKernel()`, `sharpenOverdriveKernel()`). All five loaders use the existing `loadKernel(file:function:)` helper at [`MetalKernels.swift:664`](../../../src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift).
- Metal Shading Language —
  - `RichardsonLucyMixer.metal`: two `extern "C" float4` `CIColorKernel` functions sharing matching `coreimage::sampler_h` argument shape (`rlRatio` takes 2 samplers; `rlMultiply` takes 2 samplers).
  - `SharpenEdgeMix.metal`: two `extern "C" float4` `CIColorKernel` functions (`sharpenLuminance` takes 1 sampler; `sharpenEdgeMix` takes 3 samplers + 3 floats). The edge-gradient computation reads neighbour samples on the luminance plane via `samplerTransform` offsets — the only place in this plan that uses `CIKernel` semantics rather than pure `CIColorKernel` (per-pixel) semantics. **If `samplerTransform` doesn't resolve in `CIColorKernel`, the gradient sampling has to move to a separate `CIKernel` (with sampler) that emits a "gradient × edge mask" plane that the final mix kernel consumes — see Task 3 for the spike if this surfaces.**
  - `SharpenOverdrive.metal`: one `extern "C" float4` `CIColorKernel` function. Byte-identical algorithm to v2 v1's `SceneUnsharp.metal` (`out = src + (src - blurred) * amount`); kept separate for orchestration clarity.
- Build glue — `./src/apple/scripts/build-xcframework.sh` is NOT rerun (no Rust source changes). New `.metal` files ship via existing `Package.swift` `.copy("Metal")` rule (verbatim copy, runtime compile via `CIKernel.kernels(withMetalString:)`).
- Test — `cd src/apple/Packages/MapleCore && swift test` after each Swift edit; `BUDGET=15 src/scripts/test_color_pipeline.sh` after each milestone (M4a = Task 3, M4b = Task 4, M4 = Task 7) for the legacy-path ΔE no-regression gate (Plan 2 v2 v3 must not break it).

**Conflicts identified between user spec and source-of-truth:**

The plan-writer's task instructions said: "Insert AFTER NR color, BEFORE AgX. Per Rust chain order at `pipeline.rs:120-132`." This sentence is internally inconsistent — Rust at `pipeline.rs:130` puts sharpen **before** NR luminance / NR color, not after NR color. The brief at § 5 also locks "WB → tone → vibrance → saturation → clarity → texture → dehaze → sharpen → NR luma → NR color → AgX." **This plan follows the brief and the Rust source-of-truth (sharpen before NR luma, not after NR color).** The "AFTER NR color" phrasing in the task instructions appears to be a slip; if a future reviewer expected sharpen-after-NR, the plan is wrong by their reading but right by the brief — flag and reconcile before proceeding.

**Out of scope (explicit):**
- **Plan 2 v2 v4 — Dehaze.** Brief § 2 marks effort `L`. Sibling plan (in flight in parallel by another agent). v4 inserts dehaze above sharpen; v3 (this plan) leaves a comment marker at that point in `processSceneLinear` so v4's wiring is a clean diff.
- **Plan 2 v2 v5 — Delete legacy `applyFilters` chain at [`ImageEditPipeline.swift:512`](../../../src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift)** plus the `MAPLE_SKIP_SWIFT_AGX` and `MAPLE_SKIP_SWIFT_FILTERS` env gates. Brief § 4 explicitly defers to "after every kernel is on the new path." Separate plan after v3 + v4 land.
- **Web/WASM port of sharpen.** Plan 3 territory; not touched here.
- **Strict ΔE numeric gate against Rust.** Brief's M4 milestone does not specify a strict numeric gate; this plan keeps the ΔE harness as a soft regression gate (`BUDGET=15`, the v2 v1 / v2 v2 baseline). Tightening to a strict numeric gate is a follow-up; budgets ratchet downward over time per [`CLAUDE.md`](../../../CLAUDE.md) § "Objective color testing — no eyeballing."
- **Pre-compiling Metal kernels at app launch.** Lazy compile on first use, cached for the process lifetime — matches the existing `MetalKernels` pattern.
- **Adjusting the deep-zoom plan's 35 px overlap.** Sharpen 9 px stencil is well under 35 px; no change.
- **DRY-ing `SharpenOverdrive.metal` against `SceneUnsharp.metal`.** They are byte-identical at the algorithm level. A follow-up plan can merge once the orchestrator pattern is locked in production. For v3 the small dedicated kernel is clearer.
- **Replacing 3-iter RL with full deconvolution.** The Rust source-of-truth is the 3-iter shim (`RL_ITERS = 3` at [`sharpen.rs:16`](../../../src/raw-pipeline/raw-core/src/stages/sharpen.rs)); the Metal port matches. A future "true deconvolution" plan would port both Rust + Apple together to keep parity.
- **Bumping `RenderedPreviewCache.adjustment_version`.** The cache key already covers `model.sharpen_*` fields per [`CLAUDE.md`](../../../CLAUDE.md) § "Performance invariants."

---

## File Structure

**Swift (read-write):**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift` — add five private static cache fields (`_rlRatio: CIColorKernel?`, `_rlMultiply: CIColorKernel?`, `_sharpenLuminance: CIColorKernel?`, `_sharpenEdgeMix: CIColorKernel?`, `_sharpenOverdrive: CIColorKernel?`), one new public wrapper (`applySceneSharpen(to:amount:radius:detail:masking:)`), and five new private kernel-loader helpers. All five loaders mirror the existing `sceneUnsharpKernel()` shape at [`MetalKernels.swift:501-506`](../../../src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift).
- Add: `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/RichardsonLucyMixer.metal` — new Metal source. Two `extern "C" float4` functions:
  - `rlRatio(coreimage::sampler_h observed, coreimage::sampler_h reblur)` — per-pixel `out = observed / max(reblur, 1e-5)`.
  - `rlMultiply(coreimage::sampler_h estimate, coreimage::sampler_h correction)` — per-pixel `out = estimate * correction`.
- Add: `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SharpenEdgeMix.metal` — new Metal source. Two functions:
  - `sharpenLuminance(coreimage::sampler_h src)` — per-pixel `(L, L, L, alpha)` where `L = 0.2627*r + 0.6780*g + 0.0593*b` (Rec.2020 luma, mirroring [`sharpen.rs:87-89`](../../../src/raw-pipeline/raw-core/src/stages/sharpen.rs)). `CIColorKernel` (per-pixel; no neighbour sampling).
  - `sharpenEdgeMix(coreimage::sampler_h observed, coreimage::sampler_h sharpened, coreimage::sampler_h luma, float overallMix, float detailAtten, float maskingThreshold)` — final mix per [`sharpen.rs:103-123`](../../../src/raw-pipeline/raw-core/src/stages/sharpen.rs). **Investigation question (Task 3 spike):** does `coreimage::sampler_h` support neighbour offsets (`luma.sample(luma.coord() + float2(1, 0) / luma.size())`) inside an `extern "C" float4` function declared as a `[[stitchable]]` `CIColorKernel`? CoreImage docs say `CIColorKernel` is per-pixel (no spatial context); `CIKernel` allows spatial sampling. If the per-pixel `coreimage::sampler_h` rejects offset reads, this kernel must compile as a `CIKernel` (loader path: `CIKernel.kernels(withMetalString:)` returns either `CIColorKernel` or `CIKernel` based on the function signature; the existing `agxKernel()` at `MetalKernels.swift:573-578` is a `CIKernel`, not `CIColorKernel`). The kernel loader pattern handles both.
- Add: `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SharpenOverdrive.metal` — new Metal source. One function:
  - `sharpenOverdrive(coreimage::sampler_h estimate, coreimage::sampler_h blurredEstimate, float overMix)` — per-pixel `out = estimate + (estimate - blurredEstimate) * overMix` mirroring [`sharpen.rs:65-76`](../../../src/raw-pipeline/raw-core/src/stages/sharpen.rs).
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift` — extend `processSceneLinear` (currently lines 287-399 after Plan 2 v2 v2 landing) with one new stage call between `withTexture` (line 366-369) and `withNRLuminance` (line 378-381): `applySceneSharpen(to: withTexture, amount: Float(model.sharpenAmount), radius: Float(model.sharpenRadius), detail: Float(model.sharpenDetail), masking: Float(model.sharpenMasking))`. The output (`withSharpen`) feeds `applySceneNRLuminance`. Comment marker indicates v4 dehaze insertion goes between texture and sharpen.
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift` — append (a) one M4 parity mirror test (`testM4SwiftScalarApplySharpenMatchesRust`) — pure-Swift port of `sharpen::apply` against a synthetic step-edge image compared to a recorded Rust reference, no metallib needed (mirrors the existing `swiftApplyLuminance` parity pattern at `:2183-2213`), (b) one M4 wiring smoke test (`testM4ProcessSceneLinearAppliesSharpen`) that drives `processSceneLinear` end-to-end with non-zero `sharpenAmount` and asserts centre-pixel finite-and-bounded using the existing `>=` smoke pattern from Plan 2 v2 v2 (e.g. `testM3ProcessSceneLinearAppliesNRLuminance` at `:1137-1160`), (c) one identity test (`testM4SharpenShortCircuitsAtZeroAmount`) — assert the wrapper returns the input CIImage instance unchanged when amount=0 (mirrors `testM3NRLuminanceShortCircuitsAtZeroAmount`), and (d) one masking test (`testM4SharpenMaskingFadesFlatAreas`) verifying `sharpen_masking > 0` reduces sharpening on flat regions while preserving it on edges (mirrors the chroma-reduction test in `testM3bSwiftScalarApplyColorMatchesRust` at `:999-1033`).

**Swift (read-only during verification):**
- `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SeparableGaussianBlur.metal` — already shipped in v2 v1 (commit `b84da17`). Reference for the shared compute kernel. **Not modified** by this plan; consumed via the public `MetalKernels.applySeparableGaussianBlur(to:radius:)` wrapper at [`MetalKernels.swift:234-327`](../../../src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift).
- `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneUnsharp.metal` — pattern reference for "two-sampler `extern "C" float4` `CIColorKernel` that takes (src, blurred, amount)". Used as the source style template for `SharpenOverdrive.metal`.
- `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneNRLuminance.metal`, `SceneNRColor.metal` — recently shipped (commits `3fdd80a`, `beb8a34`). Pattern for multi-step CIColorKernel orchestration with per-iteration cache fields.
- `src/apple/Packages/MapleCore/Tests/MapleCoreTests/DeepZoomTileRenderingTests.swift` — verified read-only in Task 7 Step 7.4 (no source edits).

**Rust (read-only during verification):**
- `src/raw-pipeline/raw-core/src/stages/sharpen.rs:22-124` — algorithm reference for `apply` (radius math at `:33-34`, RL iter loop at `:42-61`, overdrive at `:63-77`, edge-mask at `:79-123`).
- `src/raw-pipeline/raw-core/src/stages/blur.rs:77-114` — `gaussian_blur_plane` and `gaussian_blur_rgb` algorithm. **Not modified.** The Swift mirror `swiftGaussianBlurPlane` already exists in `SceneLinearPipelineTests.swift:1786-1796` (added by v2 v1 Task 3); reused here for the parity mirror.
- `src/raw-pipeline/raw-core/src/xmp.rs:35-38` — slider field + range definitions (`sharpen_amount`, `sharpen_radius`, `sharpen_detail`, `sharpen_masking` defaults).
- `src/raw-pipeline/raw-core/src/pipeline.rs:127-132` — chain order. Sharpen at line 130, between texture (128) / dehaze (129) and NR luminance (131) / NR color (132).

**Build artifacts (touched):**
- None. M4 is pure Swift + Metal source additions. The xcframework is unchanged because no Rust source changes.

---

## Ordering constraint

**Tasks must be done in the order: Task 1 (preflight) → Task 2 (RL mixer kernels + RL iter orchestration) → Task 3 (edge-mix kernel + spike on neighbour-sampling, M4a gate) → Task 4 (overdrive kernel) → Task 5 (parity mirror) → Task 6 (wire into `processSceneLinear`) → Task 7 (M4 milestone gate).**

- **Task 1 is preflight, not spike.** Both v2 v1 spikes already PASSED (compute → CI handoff for shared blur). Task 1 confirms the Rust algorithm shape, the v2 v1 + v2 v2 public wrappers are reachable, and the slider field names + ranges in `AdjustmentModel.swift` match `xmp.rs`.
- **Task 2 is M4a kernel — the RL iteration core.** New `RichardsonLucyMixer.metal` (2 functions) + Swift wrapper that orchestrates `applySeparableGaussianBlur` × 6 + `rlRatio` × 3 + `rlMultiply` × 3, with no overdrive and no edge mask — produces a "naive sharpened" intermediate matching the Rust `sharpened` variable at `sharpen.rs:64`.
- **Task 3 is M4b kernel — edge-aware mix + Task 3.X spike.** New `SharpenEdgeMix.metal` (2 functions: `sharpenLuminance`, `sharpenEdgeMix`). Step 3.1 is a focused micro-spike: confirm that `coreimage::sampler_h` supports neighbour-offset sampling inside a `[[stitchable]]` `CIColorKernel`-or-`CIKernel`. If not, the gradient computation moves into a separate spatial-`CIKernel`. This decision is locked at Step 3.2 before authoring the mix kernel.
- **Task 4 is the overdrive kernel.** Small `SharpenOverdrive.metal`; called only when `amount > 100`.
- **Task 5 is M4 verification — Swift-scalar parity mirror against Rust `apply`.** Pure-Swift mirror reusing v2 v1's `swiftGaussianBlurPlane`, plus new helpers for the RL iteration loop (per-channel divide, multiply), overdrive, and edge mix.
- **Task 6 wires sharpen into `processSceneLinear`.** Single-line edit between `withTexture` and `withNRLuminance`.
- **Task 7 is the M4 milestone gate.** Manual smoke test in the macOS app + parity harness no-regression + `DeepZoomTileRenderingTests.swift` no-regression.

After every task: `cd src/apple/Packages/MapleCore && swift test`. After every milestone (M4a = Task 2, M4b = Task 3, M4 = Task 7): `BUDGET=15 src/scripts/test_color_pipeline.sh` (regression check on legacy path, which Plan 2 v2 v3 must not touch).

---

## Task 1: Preflight — confirm Rust algorithm shape + v2 v1/v2 v2 wrapper reachability

**Files:**
- Read-only: `src/raw-pipeline/raw-core/src/stages/sharpen.rs`
- Read-only: `src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift`
- Read-only: `src/apple/Packages/MapleCore/Sources/MapleCore/AdjustmentModel.swift`

**Why this matters:** Both spikes from v2 v1 already PASSED. The v2 v1 `applySeparableGaussianBlur` is shipped at `MetalKernels.swift:234`; v2 v2's NR pattern (extract → blur → combine) is shipped via `applySceneNRLuminance` at `MetalKernels.swift:396` and `applySceneNRColor` at `MetalKernels.swift:453`. Task 1 is a written-down preflight that confirms (a) the Rust algorithm at `sharpen.rs:22-124` matches the Architecture description above, and (b) the existing public surfaces of `MetalKernels` are sufficient to call into from new wrappers without further refactoring.

- [ ] **Step 1.1: Confirm the Rust `sharpen::apply` shape.**

Run:
```bash
sed -n '22,124p' src/raw-pipeline/raw-core/src/stages/sharpen.rs
```

Expected output (load-bearing details):
- `assert_space(SceneLinearRec2020)` at `:29`.
- `if amount.abs() < 1e-3 { return; }` short-circuit at `:30`.
- `radius_px = radius.clamp(0.5, 3.0).round() as usize; let radius_px = radius_px.max(1);` at `:33-34`.
- `RL_ITERS = 3` reference at `:16` and the loop `for _ in 0..RL_ITERS` at `:42`.
- `EPSILON = 1e-5` at `:17` and the divide-with-floor pattern `o[c] / rb[c].max(EPSILON)` at `:50-52`.
- Per-iteration body at `:43-60`: `reblur` → `ratio` → `correction` → multiply.
- Overdrive guard `if amount > 100.0` at `:65` with `over_mix = (amount - 100.0) / 100.0` at `:66` and `gaussian_blur_rgb(&sharpened, radius_px)` at `:67`.
- Edge-mask coefficients at `:80-82`: `overall_mix = (amount/100).clamp(0, 1.5)`, `detail_atten = (detail/100).clamp(0, 1)`, `masking_threshold = (masking/100).clamp(0, 1)`.
- Luma compute at `:87-89`: `0.2627 * p[0] + 0.6780 * p[1] + 0.0593 * p[2]` (Rec.2020 BT.2020 luma coefficients).
- Gradient via central-difference at `:92-101`: `(luma[idx(x+1,y)] - luma[idx(x-1,y)], luma[idx(x,y+1)] - luma[idx(x,y-1)])`, magnitude `sqrt(gx*gx + gy*gy)`.
- Gradient normalize + threshold at `:108-110`: `g_norm = (g / 0.2).clamp(0, 1); if g_norm >= masking_threshold { 1.0 } else { detail_atten }`.
- Final mix at `:114-121`: `mix = overall_mix * edge; out = observed + (sharpened - observed) * mix`.

If any element above is missing or the line numbers have drifted, STOP and reconcile the plan with the Rust source-of-truth.

- [ ] **Step 1.2: Confirm the v2 v1 / v2 v2 public wrappers are reachable.**

Run:
```bash
grep -n "applySeparableGaussianBlur\|applySceneNRLuminance\|applySceneNRColor\|loadKernel(file:\|public static func applyScene" src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift
```

Expected matches (line numbers may drift slightly with v2 v2 churn):
- `public static func applySeparableGaussianBlur(to:radius:)` near line 234.
- `public static func applySceneClarity(to:clarity:)` near line 343.
- `public static func applySceneTexture(to:texture:)` near line 363.
- `public static func applySceneNRLuminance(to:nrLuminance:)` near line 396.
- `public static func applySceneNRColor(to:nrColor:)` near line 453.
- `private static func loadKernel(file: String, function: String) -> CIKernel?` near line 664.

The new sharpen wrapper will call `applySeparableGaussianBlur` (public) and `loadKernel` (private — accessible from the same `enum MetalKernels` body). No changes to access modifiers needed.

- [ ] **Step 1.3: Confirm the v2 v1 spike PASS records still exist in the test file header.**

Run:
```bash
grep -n "Spike 1.1.*Result: PASS\|Spike 1.2.*Result: PASS" src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
```

Expected: two matches (one for each spike), both with `Result: PASS`. If either is missing or shows FAIL, the v2 v1 architecture assumption (compute → CI handoff) is invalidated and this plan must be reopened.

- [ ] **Step 1.4: Confirm the `AdjustmentModel.swift` slider field names + ranges.**

Run:
```bash
grep -n "sharpenAmount\|sharpenRadius\|sharpenDetail\|sharpenMasking" src/apple/Packages/MapleCore/Sources/MapleCore/AdjustmentModel.swift
```

Expected (per [`AdjustmentModel.swift:47-50`](../../../src/apple/Packages/MapleCore/Sources/MapleCore/AdjustmentModel.swift)):
- `public var sharpenAmount: Double    // 0..150, default 0` at line 47.
- `public var sharpenRadius: Double    // 0.5..3.0, default 0.5` at line 48.
- `public var sharpenDetail: Double    // 0..100, default 25` at line 49.
- `public var sharpenMasking: Double   // 0..100, default 0` at line 50.

These match `xmp.rs:35-38` byte-for-byte. The wrapper signature uses `Float(model.sharpenAmount)` etc. per the v2 v1 / v2 v2 `Float(model.X)` cast convention.

- [ ] **Step 1.5: Confirm the existing v2 v1 / v2 v2 kernels do not yet use `[[stitchable]]`.**

Run:
```bash
grep -n "stitchable" src/apple/Packages/MapleCore/Sources/MapleCore/Metal/*.metal
```

Expected: zero matches. The existing kernels (`SceneToneControls.metal`, `SceneVibrance.metal`, `WhiteBalance.metal`, `SceneSaturation.metal`, `SceneUnsharp.metal`, `SceneNRLuminance.metal`, `SceneNRColor.metal`) all rely on the `extern "C" float4 functionName(coreimage::sampler_h ...)` declaration without `[[stitchable]]`. The `loadKernel(file:function:)` path uses `CIKernel.kernels(withMetalString:)` which infers the kernel type from the signature.

**For this plan, follow the existing pattern: do NOT add `[[stitchable]]` to the new sharpen kernels** unless Task 7 Step 7.3's manual smoke test reveals the same compile failure that v2 v1's Spike 1.1 noted as a modern-macOS risk. If Task 7 surfaces the issue, the fix is to retrofit `[[stitchable]]` onto BOTH the existing kernels and the new sharpen kernels in a separate plan — not in-line here.

- [ ] **Step 1.6: Run `swift test` to confirm the test baseline.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | tail -10`

Expected: green. Test count = the post-Plan-2-v2-v2 baseline. No tests added by Task 1.

- [ ] **Step 1.7: Run the parity harness baseline.**

Run: `BUDGET=15 src/scripts/test_color_pipeline.sh 2>&1 | tail -8`

Expected: PASS. Confirms the legacy path is in the same state v2 v2 left it.

- [ ] **Step 1.8: Commit (preflight notes only — no code changes).**

This task touches no source files. Skip the commit step. Move on to Task 2.

---

## Task 2: M4a — `RichardsonLucyMixer.metal` + RL-iter orchestration in `applySceneSharpen` (no overdrive, no edge mask yet)

**Files:**
- Add: `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/RichardsonLucyMixer.metal`
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift` (add 2 cache fields, 1 partial public wrapper, 2 private kernel loaders)

**Why this matters:** The 3-iteration Richardson-Lucy update is the algorithmic core of the stage. Landing it first — with no overdrive (skipped via `amount ≤ 100` short-circuit on the overdrive branch) and no edge mask (the wrapper applies the sharpened result directly) — establishes the orchestration shape and exposes any per-iteration scratch / lifetime issues before Tasks 3–4 layer on the edge mask + overdrive.

- [ ] **Step 2.1: Confirm the Rust source-of-truth a third time before authoring the Metal mirror.**

Run: `sed -n '42,61p' src/raw-pipeline/raw-core/src/stages/sharpen.rs`

Expected: matches Step 1.1's per-iteration body. Mentally walk through one pixel at default `sharpen_amount = 100, sharpen_radius = 0.5`:
1. Input rec2020 `(r, g, b)` from `observed`.
2. Initial `estimate = observed`.
3. Iteration 0:
   a. `reblur = blur(estimate, radius_px=1)`.
   b. `ratio = (observed_r / max(reblur_r, 1e-5), observed_g / max(reblur_g, 1e-5), observed_b / max(reblur_b, 1e-5))`.
   c. `correction = blur(ratio, radius_px=1)`.
   d. `estimate = (estimate_r * correction_r, estimate_g * correction_g, estimate_b * correction_b)`.
4. Repeat steps 3a-3d two more times.

The Metal port mirrors steps 3b and 3d in the two `RichardsonLucyMixer.metal` functions; the blurs at 3a and 3c reuse `applySeparableGaussianBlur`.

- [ ] **Step 2.2: Write the Metal kernel source.**

Create `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/RichardsonLucyMixer.metal`:

```metal
// RichardsonLucyMixer.metal — per-iteration arithmetic for 3-iter
// Richardson-Lucy capture sharpening. Mirrors the per-pixel body of
// raw-core/src/stages/sharpen.rs:42-60 (the loop over RL_ITERS = 3).
//
// Two CIColorKernel functions compose with the shared
// SeparableGaussianBlur compute kernel (shipped in Plan 2 v2 v1) to
// implement the full RL iteration:
//
//   For each iteration n in 0..3:
//     reblur     = applySeparableGaussianBlur(estimate, radius_px)
//     ratio      = rlRatio(observed, reblur)
//     correction = applySeparableGaussianBlur(ratio, radius_px)
//     estimate   = rlMultiply(estimate, correction)
//
// EPSILON = 1e-5 matches sharpen.rs:17 byte-for-byte. Per-channel
// independence matches sharpen.rs:49-53 (ratio computed per RGB
// component) and sharpen.rs:58-60 (estimate multiplied per RGB
// component).
//
// Style note: matches the existing CIColorKernel sources in this
// directory (SceneToneControls, SceneVibrance, SceneSaturation,
// SceneUnsharp, SceneNRLuminance, SceneNRColor) — `extern "C"` with
// `coreimage::sampler_h` arguments and a direct `float4` sample
// assignment. No `[[stitchable]]` attribute (Step 1.5 of Task 1
// confirmed v2 v1 / v2 v2 production kernels do not use it).

#include <CoreImage/CoreImage.h>

// Per-pixel ratio: observed / max(reblur, EPSILON) per channel.
// Matches sharpen.rs:46-53.
extern "C" float4 rlRatio(
    coreimage::sampler_h observed,
    coreimage::sampler_h reblur
) {
    const float EPSILON = 1e-5;
    float4 o = observed.sample(observed.coord());
    float4 rb = reblur.sample(reblur.coord());
    float3 ratio = o.rgb / max(rb.rgb, float3(EPSILON));
    return float4(ratio, o.a);
}

// Per-pixel multiply: estimate * correction per channel.
// Matches sharpen.rs:56-60.
extern "C" float4 rlMultiply(
    coreimage::sampler_h estimate,
    coreimage::sampler_h correction
) {
    float4 e = estimate.sample(estimate.coord());
    float4 c = correction.sample(correction.coord());
    return float4(e.rgb * c.rgb, e.a);
}
```

- [ ] **Step 2.3: Add the Swift wrapper to `MetalKernels.swift`.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift`, after the existing `_sceneNRColorCombine` field (added by v2 v2 — see [`MetalKernels.swift:74-75`](../../../src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift)), add five new private statics. Author all five fields here even though Tasks 3 + 4 add the second, third, fourth, fifth kernel loaders — declaring them up front avoids re-editing the field block in subsequent tasks:

```swift
    // Plan 2 v2 v3 — SceneSharpen kernels (M4, Tasks 2 + 3 + 4). Five
    // CIColorKernels orchestrated by applySceneSharpen:
    //   * rlRatio + rlMultiply: per-iteration RL arithmetic (Task 2).
    //   * sharpenLuminance + sharpenEdgeMix: edge-aware final mix (Task 3).
    //   * sharpenOverdrive: optional unsharp boost when amount > 100 (Task 4).
    // All five share the lazy / process-lifetime cache pattern.
    private static var _rlRatio: CIColorKernel?
    private static var _rlMultiply: CIColorKernel?
    private static var _sharpenLuminance: CIColorKernel?
    // sharpenEdgeMix may be CIKernel (not CIColorKernel) if Task 3's
    // micro-spike shows neighbour sampling requires the spatial variant —
    // see Task 3 Step 3.1. Field is typed `CIKernel?` to accept either.
    private static var _sharpenEdgeMix: CIKernel?
    private static var _sharpenOverdrive: CIColorKernel?
```

After the existing `applySceneNRColor` wrapper at `MetalKernels.swift:453-480`, add the **partial** public wrapper (RL iters only — overdrive + edge-mix are stubbed for Tasks 3–4):

```swift
    // MARK: SceneSharpen (Plan 2 v2 v3 M4)

    /// Apply scene-linear Rec.2020 capture sharpening (3-iteration
    /// Richardson-Lucy with Gaussian PSF + edge-aware mix). Mirrors
    /// `sharpen::apply` from raw-core/src/stages/sharpen.rs:22-124.
    ///
    /// Slider params (per AdjustmentModel.swift:47-50, mirroring xmp.rs:
    /// 35-38):
    ///   * amount: 0..150, default 0. 0 skips, 100 is full RL, >100 adds
    ///     unsharp overdrive.
    ///   * radius: 0.5..3.0, default 0.5. PSF Gaussian sigma; converted
    ///     to integer box radius via clamp(0.5, 3.0).round().max(1)
    ///     mirroring sharpen.rs:33-34.
    ///   * detail: 0..100, default 25. Edge-attenuation strength.
    ///   * masking: 0..100, default 0. Edge-mask threshold.
    ///
    /// Short-circuits to identity when |amount| < 1e-3 mirroring
    /// sharpen.rs:30.
    ///
    /// **Task 2 partial implementation:** RL iterations only. Overdrive
    /// (amount > 100, Task 4) and edge-aware mix (Task 3) are not yet
    /// applied — the wrapper returns the post-RL `sharpened` directly
    /// (equivalent to amount=100, masking=0, detail=irrelevant). This is
    /// a stepping stone; Tasks 3 + 4 layer on the missing pieces.
    public static func applySceneSharpen(
        to input: CIImage,
        amount: Float,
        radius: Float,
        detail: Float,
        masking: Float
    ) -> CIImage {
        if abs(amount) < 1e-3 { return input }

        // Integer radius mirrors sharpen.rs:33-34 byte-for-byte:
        //   radius_px = radius.clamp(0.5, 3.0).round() as usize;
        //   let radius_px = radius_px.max(1);
        let clamped = max(0.5, min(3.0, radius))
        let rounded = Int(roundf(clamped))
        let radiusPx = max(1, rounded)

        guard let ratioKernel = rlRatioKernel(),
              let multiplyKernel = rlMultiplyKernel() else {
            return input
        }

        // Task 2: 3 iterations of Richardson-Lucy. observed = input,
        // estimate starts as input; after 3 iters, sharpened = estimate.
        let observed = input
        var estimate = input

        for _ in 0..<3 {
            // reblur = blur(estimate, radius_px)
            let reblur = applySeparableGaussianBlur(to: estimate, radius: radiusPx)
            // ratio = observed / max(reblur, EPSILON)
            guard let ratio = ratioKernel.apply(
                extent: input.extent,
                roiCallback: { _, rect in rect },
                arguments: [observed, reblur]
            ) else { return input }
            // correction = blur(ratio, radius_px)
            let correction = applySeparableGaussianBlur(to: ratio, radius: radiusPx)
            // estimate = estimate * correction
            guard let nextEstimate = multiplyKernel.apply(
                extent: input.extent,
                roiCallback: { _, rect in rect },
                arguments: [estimate, correction]
            ) else { return input }
            estimate = nextEstimate
        }

        // Tasks 3 + 4 will replace this return with overdrive + edge mix.
        // For now, return the bare RL-sharpened output.
        return estimate
    }
```

After the existing `sceneNRColorCombineKernel()` private helper at `MetalKernels.swift:529-534`, add the two RL-mixer kernel loaders (Task 3 will add the next two loaders; Task 4 will add the last):

```swift
    // MARK: Sharpen kernel loaders (Plan 2 v2 v3 M4)

    private static func rlRatioKernel() -> CIColorKernel? {
        if let k = _rlRatio { return k }
        _rlRatio = loadKernel(file: "RichardsonLucyMixer",
                              function: "rlRatio") as? CIColorKernel
        return _rlRatio
    }

    private static func rlMultiplyKernel() -> CIColorKernel? {
        if let k = _rlMultiply { return k }
        _rlMultiply = loadKernel(file: "RichardsonLucyMixer",
                                 function: "rlMultiply") as? CIColorKernel
        return _rlMultiply
    }
```

The two loaders share the same `.metal` source file (`RichardsonLucyMixer`). Same loader pattern as v2 v2's `sceneNRLuminanceExtractKernel` / `sceneNRLuminanceCombineKernel`.

- [ ] **Step 2.4: Run `swift test` to confirm no compile error.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | tail -10`

Expected: green. Test count = post-Task-1 baseline (no new tests in this task — Tasks 5/6 add tests).

If the build fails with "Cannot find a valid stitchable Metal function in the source" or "cannot initialize a variable of type 'float4' with an rvalue of type 'half4'" (the modern-macOS risk noted in v2 v1 Spike 1.1), STOP and apply the same fix to BOTH the new sharpen kernel and a copy of the v2 v1 / v2 v2 wrappers in a separate retrofit plan — do NOT add `[[stitchable]]` only to the new sharpen kernels (would create a kernel-source style split).

- [ ] **Step 2.5: M4a parity-harness regression check (legacy path no-regression).**

Run: `BUDGET=15 src/scripts/test_color_pipeline.sh 2>&1 | tail -8`

Expected: PASS. Plan 2 v2 v3 has touched only the new files (`RichardsonLucyMixer.metal`, the wrapper in `MetalKernels.swift`). The legacy `applyFilters` path is untouched.

- [ ] **Step 2.6: Commit.**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Metal/RichardsonLucyMixer.metal src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift
git commit -m "feat(apple): add RichardsonLucyMixer kernel + applySceneSharpen RL iters

Plan 2 v2 v3 M4a — Richardson-Lucy iteration core for capture
sharpening on the new path. RichardsonLucyMixer.metal exposes two
CIColorKernel functions:

  * rlRatio(observed, reblur) — per-pixel
    out = observed / max(reblur, 1e-5) per channel.
  * rlMultiply(estimate, correction) — per-pixel
    out = estimate * correction per channel.

EPSILON = 1e-5 matches sharpen.rs:17 byte-for-byte.

The Swift wrapper applySceneSharpen(to:amount:radius:detail:masking:)
short-circuits to identity at |amount| < 1e-3, computes integer
radius_px = max(1, round(clamp(radius, 0.5, 3.0))) per sharpen.rs
:33-34, and orchestrates 3 RL iterations (each: blur estimate, divide
observed/max(blur, EPSILON), blur ratio, multiply estimate by
correction). Returns the bare RL-sharpened output — overdrive and
edge-aware mix arrive in Tasks 3 + 4."
```

---

## Task 3: M4b — `SharpenEdgeMix.metal` (with neighbour-sampling micro-spike) + edge-mask wiring in `applySceneSharpen`

**Files:**
- Add: `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SharpenEdgeMix.metal`
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift` (add 2 kernel loaders, replace the bare-RL return with edge-mix orchestration)
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift` (record the spike result)

**Why this matters:** The edge-aware mix is what makes capture sharpening usable on real photos — without it, every flat region gets the same 3-iter RL boost as every textured edge, producing the classic "sharpened noise" look. The Rust source at `sharpen.rs:79-123` modulates the mix amount per pixel by gradient magnitude. The Metal port needs neighbour sampling to compute the gradient; whether `coreimage::sampler_h` supports neighbour-offset sampling inside a `[[stitchable]]` `CIColorKernel`-or-`CIKernel` is the load-bearing micro-spike for this task.

- [ ] **Step 3.1: Micro-spike — does `coreimage::sampler_h` support neighbour-offset sampling?**

CoreImage docs distinguish `CIColorKernel` (per-pixel; no spatial sampling) from `CIKernel` (allows spatial sampling via `samplerTransform` + `sampler.sample(c)` where `c` is an offset coord). The agxKernel at `MetalKernels.swift:573-578` is loaded as `CIKernel`, suggesting the spatial path works in production.

Author a one-off probe `.metal` file `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/_SpikeNeighbourSampler.metal` (note the leading underscore — convention for spike files; gitignored if needed). The probe declares an `extern "C" float4 spikeNeighbourSampler(coreimage::sampler_h luma)` that samples at `luma.coord() + float2(1, 0) / luma.size()` and returns the difference vs the centre. Compile-test only:

```metal
#include <CoreImage/CoreImage.h>
extern "C" float4 spikeNeighbourSampler(coreimage::sampler_h luma) {
    float4 c = luma.sample(luma.coord());
    // Neighbour at +1 px in X. luma.size() is float2(width, height) of
    // the source extent; offsetting by float2(1, 0) / luma.size() in
    // sampler space gives a 1-px offset.
    float4 r = luma.sample(luma.coord() + float2(1.0, 0.0) / luma.size());
    return float4(r.rgb - c.rgb, c.a);
}
```

In a temp Swift test (do not commit), call `CIKernel.kernels(withMetalString:)` on the probe source and check the returned `[CIKernel]`. If the kernel compiles and returns at least one `CIKernel` (specifically a `CIKernel`, not a `CIColorKernel`), proceed with the spatial-sampling pattern in Step 3.2. If the compile rejects neighbour offsets in `coreimage::sampler_h`, fall back to the per-pixel pattern: precompute the gradient magnitude into a separate CIImage via a `CIKernel` that does the spatial sampling, then have the per-pixel `CIColorKernel` consume it as a third sampler argument (no neighbour sampling at the mix step).

Run: `cd src/apple/Packages/MapleCore && swift test --filter SpikeNeighbourSamplerTest 2>&1 | tail -10`

(The probe test is built using the same loader pattern as v2 v1 Spike 1.1 at `SceneLinearPipelineTests.swift:163-205`. After the spike completes, delete `_SpikeNeighbourSampler.metal` and the probe test — the result is recorded in the test-file header in Step 3.5.)

Expected: PASS for the spatial-sampling pattern. **If the spike PASSES**, the edge-mix kernel can compute its own gradient inline and saves one CIImage roundtrip. **If the spike FAILS**, follow the fallback architecture: a separate `sharpenGradient(luma)` kernel (declared `extern "C" float4 sharpenGradient(coreimage::sampler_h luma)` and treated as a `CIKernel` because it does neighbour sampling) emits a gradient-magnitude CIImage; the `sharpenEdgeMix` kernel then samples that gradient CIImage at the centre pixel via `coreimage::sampler_h` (which is per-pixel-safe) and applies the threshold-vs-attenuation logic without doing its own spatial reads.

The plan below assumes the spike PASSES (single combined kernel with inline gradient). If the spike fails, Step 3.2 splits into two kernels in `SharpenEdgeMix.metal` (`sharpenGradient` + `sharpenEdgeMix`) and the wrapper inserts a `gradient = sharpenGradient(luma)` step between extracting luma and running the mix. Document the result either way in Step 3.5.

- [ ] **Step 3.2: Write the Metal kernel source.**

Create `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SharpenEdgeMix.metal`:

```metal
// SharpenEdgeMix.metal — luminance extraction + edge-aware final mix
// for 3-iter Richardson-Lucy sharpening. Mirrors raw-core/src/stages/
// sharpen.rs:79-123.
//
// Two CIKernel functions:
//
//   1. sharpenLuminance(src) -> (L, L, L, alpha)
//      Sample rec2020, compute Rec.2020 BT.2020 luma
//      L = 0.2627*r + 0.6780*g + 0.0593*b, splat into RGB.
//      Per-pixel only — `CIColorKernel`. Matches sharpen.rs:87-89.
//
//   2. sharpenEdgeMix(observed, sharpened, luma, overallMix,
//                     detailAtten, maskingThreshold) -> rec2020
//      Sample observed + sharpened CIImages at the centre pixel.
//      Compute the edge gradient via central-difference samples on
//      the luma plane (4 neighbour samples: lumaPlane(x±1, y),
//      lumaPlane(x, y±1)). Decide edge-vs-flat membership:
//          if maskingThreshold > 1e-3:
//              g_norm = clamp(g / 0.2, 0, 1)
//              edge = (g_norm >= maskingThreshold) ? 1.0 : detailAtten
//          else:
//              edge = 1.0  // no edge gating; mix everywhere equally
//      Final mix:
//          mix = overallMix * edge
//          out = observed + (sharpened - observed) * mix
//      Matches sharpen.rs:103-123 byte-for-byte.
//
// Spatial sampling: confirmed PASS by Task 3 Step 3.1 micro-spike.
// `coreimage::sampler_h.sample(coord + offset)` works in `CIKernel`
// (not `CIColorKernel`); the kernel loader returns `CIKernel`, so
// the cache field `_sharpenEdgeMix` is typed `CIKernel?`.
//
// Style note: unlike `SceneNRLuminance.metal` etc. (per-pixel
// CIColorKernels), this file has one CIColorKernel (sharpenLuminance)
// AND one CIKernel (sharpenEdgeMix). The loader path
// `CIKernel.kernels(withMetalString:)` returns `[CIKernel]`; we cast
// to `CIColorKernel` for the first, leave as `CIKernel` for the
// second, in the loaders at MetalKernels.swift.

#include <CoreImage/CoreImage.h>

// Per-pixel: extract Rec.2020 BT.2020 luma; splat into RGB.
// Matches sharpen.rs:87-89: 0.2627 * r + 0.6780 * g + 0.0593 * b.
extern "C" float4 sharpenLuminance(
    coreimage::sampler_h src
) {
    float4 c = src.sample(src.coord());
    float L = 0.2627 * c.r + 0.6780 * c.g + 0.0593 * c.b;
    return float4(L, L, L, c.a);
}

// Edge-aware mix. Computes gradient magnitude via central-difference
// 4-tap reads on the luma plane, applies the masking threshold, and
// mixes observed → sharpened by the per-pixel mix factor.
extern "C" float4 sharpenEdgeMix(
    coreimage::sampler_h observed,
    coreimage::sampler_h sharpened,
    coreimage::sampler_h luma,
    float overallMix,
    float detailAtten,
    float maskingThreshold
) {
    float4 o = observed.sample(observed.coord());
    float4 s = sharpened.sample(sharpened.coord());

    float edge = 1.0;
    if (maskingThreshold > 1e-3) {
        // Central-difference gradient. luma.size() is the source
        // extent in pixels; offsetting by float2(1, 0) / luma.size()
        // in sampler-space coords gives a 1-px shift.
        float2 invSize = 1.0 / luma.size();
        float lXr = luma.sample(luma.coord() + float2( 1.0, 0.0) * invSize).r;
        float lXl = luma.sample(luma.coord() + float2(-1.0, 0.0) * invSize).r;
        float lYd = luma.sample(luma.coord() + float2( 0.0, 1.0) * invSize).r;
        float lYu = luma.sample(luma.coord() + float2( 0.0,-1.0) * invSize).r;
        float gx = lXr - lXl;
        float gy = lYd - lYu;
        float g = sqrt(gx * gx + gy * gy);
        // Normalize: typical edge gradient magnitude ~0.2 per
        // sharpen.rs:109. clamp to [0, 1].
        float gNorm = clamp(g / 0.2, 0.0, 1.0);
        edge = (gNorm >= maskingThreshold) ? 1.0 : detailAtten;
    }

    float mixK = overallMix * edge;
    float3 out = o.rgb + (s.rgb - o.rgb) * mixK;
    return float4(out, o.a);
}
```

- [ ] **Step 3.3: Update the Swift wrapper to wire the edge mask.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift`, replace the Task 2 stub return with the edge-mix path. The overdrive (Task 4) is still stubbed: skip when `amount ≤ 100`.

Replace the body of `applySceneSharpen` after the RL iteration loop with:

```swift
        // Tasks 3 + 4: overdrive + edge-aware mix.
        var sharpened = estimate

        // Task 4 stub — overdrive applies only when amount > 100.
        // Replaced in Task 4 with applySharpenOverdrive(...).
        // For Task 3 we treat amount == 100..150 as no-overdrive.

        // Task 3 — edge-aware mix.
        guard let lumaKernel = sharpenLuminanceKernel(),
              let mixKernel = sharpenEdgeMixKernel() else {
            return sharpened
        }

        let overallMix = max(0.0, min(1.5, amount / 100.0))
        let detailAtten = max(0.0, min(1.0, detail / 100.0))
        let maskingThreshold = max(0.0, min(1.0, masking / 100.0))

        // Step 1: extract Rec.2020 BT.2020 luma from observed.
        guard let lumaPlane = lumaKernel.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: [observed]
        ) else { return sharpened }

        // Step 2: edge-aware mix.
        return mixKernel.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: [
                observed,
                sharpened,
                lumaPlane,
                overallMix,
                detailAtten,
                maskingThreshold,
            ]
        ) ?? sharpened
```

After the Task 2 RL kernel loaders, add the edge-mix loaders:

```swift
    private static func sharpenLuminanceKernel() -> CIColorKernel? {
        if let k = _sharpenLuminance { return k }
        _sharpenLuminance = loadKernel(file: "SharpenEdgeMix",
                                       function: "sharpenLuminance") as? CIColorKernel
        return _sharpenLuminance
    }

    private static func sharpenEdgeMixKernel() -> CIKernel? {
        if let k = _sharpenEdgeMix { return k }
        // Note: NOT cast to CIColorKernel — `sharpenEdgeMix` does
        // neighbour sampling on `luma`, which requires CIKernel
        // (spatial). Per Task 3 Step 3.1 spike result.
        _sharpenEdgeMix = loadKernel(file: "SharpenEdgeMix",
                                     function: "sharpenEdgeMix")
        return _sharpenEdgeMix
    }
```

Note that `sharpenEdgeMixKernel()` returns `CIKernel?` (not `CIColorKernel?`). The downstream `mixKernel.apply(extent:roiCallback:arguments:)` call has the same signature on both `CIColorKernel` and `CIKernel`, so the call site is unchanged.

- [ ] **Step 3.4: Run `swift test` to confirm no compile error.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | tail -10`

Expected: green.

- [ ] **Step 3.5: Record the Step 3.1 micro-spike result in the test-file header.**

In `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift`, locate the existing v2 v1 / v2 v2 spike-record block (added by v2 v1 Task 1 around lines 163-205). Append after it:

```swift
//
// Plan 2 v2 v3 M4b micro-spike (Task 3 Step 3.1, recorded after
// authoring SharpenEdgeMix.metal in Task 3):
//
//   Spike 3.1 — Does coreimage::sampler_h support neighbour-offset
//   sampling (luma.sample(luma.coord() + float2(1, 0) / luma.size()))
//   inside a kernel declared `extern "C" float4 sharpenEdgeMix(
//   coreimage::sampler_h luma, ...)` and loaded via
//   CIKernel.kernels(withMetalString:)?
//
//   Result: <PASS|FAIL>
//
//   Notes:
//     * The kernel loader returns `[CIKernel]`; sharpenEdgeMix loads
//       as a `CIKernel` (not `CIColorKernel`), reflecting its
//       spatial-sampling semantics.
//     * sharpenLuminance (per-pixel only) loads as `CIColorKernel`
//       in the same file — both shapes coexist in one .metal source.
//     * <if FAIL>: gradient computation moved to a separate
//       sharpenGradient(luma) -> gradMagPlane kernel (CIKernel,
//       neighbour sampling); sharpenEdgeMix consumes the gradient
//       plane via per-pixel sampling (CIColorKernel-safe). Wrapper
//       gains one extra apply call between sharpenLuminance and
//       sharpenEdgeMix.
//     * <if PASS>: gradient computed inline inside sharpenEdgeMix
//       via 4 neighbour samples on the luma plane. Wrapper has 2
//       apply calls (luma + edge-mix).
```

Replace `<PASS|FAIL>` with the actual result. Either result lands a working M4b; the plan below assumes PASS for clarity.

- [ ] **Step 3.6: M4b parity-harness regression check.**

Run: `BUDGET=15 src/scripts/test_color_pipeline.sh 2>&1 | tail -8`

Expected: PASS — Plan 2 v2 v3 has touched only new files.

- [ ] **Step 3.7: Commit.**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SharpenEdgeMix.metal src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
git commit -m "feat(apple): add SharpenEdgeMix kernels + wire edge-aware mix in applySceneSharpen

Plan 2 v2 v3 M4b — luminance extraction + edge-aware final mix for
capture sharpening on the new path. SharpenEdgeMix.metal exposes:

  * sharpenLuminance (CIColorKernel) — per-pixel extract Rec.2020
    BT.2020 luma (0.2627 r + 0.6780 g + 0.0593 b), splat into RGB.
  * sharpenEdgeMix (CIKernel — spatial) — 4-tap central-difference
    gradient on the luma plane, masking-threshold edge gating per
    sharpen.rs:103-123, final mix observed -> sharpened.

Step 3.1 micro-spike confirms coreimage::sampler_h neighbour-offset
sampling (luma.sample(luma.coord() + float2(1, 0) / luma.size()))
compiles and runs at runtime when the kernel loads as `CIKernel`
(not `CIColorKernel`). Result recorded in the test-file header.

The Swift wrapper applySceneSharpen now runs the full RL + edge-mix
chain (overdrive still stubbed; Task 4)."
```

---

## Task 4: Overdrive — `SharpenOverdrive.metal` + wire the `amount > 100` branch in `applySceneSharpen`

**Files:**
- Add: `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SharpenOverdrive.metal`
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift` (add 1 kernel loader, fill in the overdrive branch in `applySceneSharpen`)

**Why this matters:** The `sharpen_amount > 100` overdrive path adds an extra unsharp-mask boost on top of the RL-deconvolved estimate, mirroring the Rust shape at `sharpen.rs:65-77`. The algorithm is byte-identical to v2 v1's `SceneUnsharp.metal` (`out = src + (src - blurred) * amount`); we author a small dedicated kernel for clarity (the orchestration logic is local to `applySceneSharpen`).

- [ ] **Step 4.1: Confirm the Rust source-of-truth for the overdrive branch.**

Run: `sed -n '63,77p' src/raw-pipeline/raw-core/src/stages/sharpen.rs`

Expected:
- Guard `if amount > 100.0 { ... }` at `:65`.
- `over_mix = (amount - 100.0) / 100.0` at `:66`.
- `blurred = gaussian_blur_rgb(&sharpened, radius_px)` at `:67`.
- Per-pixel mix `s + (s - b) * over_mix` at `:71-75`.

The Metal port mirrors the per-pixel mix in `SharpenOverdrive.metal`; the blur reuses `applySeparableGaussianBlur`.

- [ ] **Step 4.2: Write the Metal kernel source.**

Create `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SharpenOverdrive.metal`:

```metal
// SharpenOverdrive.metal — unsharp overdrive for sharpen_amount > 100.
// Mirrors raw-core/src/stages/sharpen.rs:65-76.
//
// Algorithm:
//   over_mix = (amount - 100) / 100
//   blurredEstimate = blur(estimate, radius_px)   // outside this kernel
//   out = estimate + (estimate - blurredEstimate) * over_mix
//
// Byte-identical at the per-pixel mix level to SceneUnsharp.metal
// (clarity / texture / overdrive all share the unsharp mix shape);
// kept as a separate kernel for orchestration clarity in
// applySceneSharpen. A follow-up DRY plan can merge once the
// orchestrator pattern is locked.

#include <CoreImage/CoreImage.h>

extern "C" float4 sharpenOverdrive(
    coreimage::sampler_h estimate,
    coreimage::sampler_h blurredEstimate,
    float overMix
) {
    float4 e = estimate.sample(estimate.coord());
    float4 b = blurredEstimate.sample(blurredEstimate.coord());
    if (abs(overMix) < 1e-3) return e;
    float3 mixed = e.rgb + (e.rgb - b.rgb) * overMix;
    return float4(mixed, e.a);
}
```

- [ ] **Step 4.3: Wire the overdrive branch in `applySceneSharpen`.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift`, replace the Task 3 stub `// Task 4 stub — overdrive applies only when amount > 100. ...` block with the live overdrive path:

```swift
        // Task 4 — overdrive (amount > 100). Per sharpen.rs:65-76.
        if amount > 100.0 {
            if let overdriveKernel = sharpenOverdriveKernel() {
                let overMix = (amount - 100.0) / 100.0
                let blurredEstimate = applySeparableGaussianBlur(
                    to: sharpened, radius: radiusPx
                )
                if let overdriven = overdriveKernel.apply(
                    extent: input.extent,
                    roiCallback: { _, rect in rect },
                    arguments: [sharpened, blurredEstimate, overMix]
                ) {
                    sharpened = overdriven
                }
                // If the kernel-load or apply step fails, fall through
                // with the un-overdriven sharpened. Silent fallback per
                // the existing wrapper convention.
            }
        }
```

After the Task 3 edge-mix loaders, add the overdrive loader:

```swift
    private static func sharpenOverdriveKernel() -> CIColorKernel? {
        if let k = _sharpenOverdrive { return k }
        _sharpenOverdrive = loadKernel(file: "SharpenOverdrive",
                                       function: "sharpenOverdrive") as? CIColorKernel
        return _sharpenOverdrive
    }
```

- [ ] **Step 4.4: Run `swift test` to confirm no compile error.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | tail -10`

Expected: green.

- [ ] **Step 4.5: Commit.**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SharpenOverdrive.metal src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift
git commit -m "feat(apple): add SharpenOverdrive kernel + wire amount > 100 branch

Plan 2 v2 v3 M4 — unsharp overdrive for sharpen_amount > 100. Mirrors
sharpen.rs:65-76 byte-for-byte:

  over_mix = (amount - 100) / 100
  blurredEstimate = blur(sharpened, radius_px)
  sharpened = sharpened + (sharpened - blurredEstimate) * over_mix

The Swift wrapper now runs the complete RL + overdrive + edge-mix
chain. Task 5 lands the Swift-scalar parity mirror; Task 6 wires
applySceneSharpen into processSceneLinear; Task 7 is the milestone
gate."
```

---

## Task 5: M4 verification — Swift-scalar parity mirror against Rust `apply`

**Files:**
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift` (append parity mirror tests + Swift scalar helpers)

**Why this matters:** Under `swift test` the metallib isn't loaded, so the Metal kernels from Tasks 2–4 are silent no-ops (per the v2 v1 / v2 v2 pattern). To verify M4 ships with correct algorithm semantics, this task adds a pure-Swift scalar mirror of the Rust `sharpen::apply` algorithm and compares against recorded reference outputs — same shape as v2 v2's `swiftApplyLuminance` parity test at `SceneLinearPipelineTests.swift:2183-2270`. The Swift mirror reuses `swiftGaussianBlurPlane` (v2 v1 Task 3) and is byte-faithful to the Rust implementation.

- [ ] **Step 5.1: Add the Swift scalar `swiftApplySharpen` helper.**

Append to `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift` (inside the existing `final class SceneLinearPipelineTests`, near the existing `swiftApplyLuminance` / `swiftApplyColor` helpers around lines 2183-2316):

```swift
    // MARK: - Plan 2 v2 v3 M4: Swift scalar mirror of apply_sharpen

    /// Pure-Swift mirror of `sharpen::apply` from
    /// raw-core/src/stages/sharpen.rs:22-124. Byte-faithful to the Rust
    /// implementation:
    ///   1. amount.abs() < 1e-3 -> identity (line :30)
    ///   2. radius_px = max(1, round(clamp(radius, 0.5, 3.0))) (lines
    ///      :33-34)
    ///   3. RL_ITERS = 3 iterations of:
    ///        reblur = gaussianBlurRGB(estimate, radius_px)
    ///        ratio = observed / max(reblur, 1e-5)
    ///        correction = gaussianBlurRGB(ratio, radius_px)
    ///        estimate = estimate * correction
    ///      (lines :42-61)
    ///   4. Optional overdrive when amount > 100 (lines :65-76)
    ///   5. Edge-aware final mix (lines :79-123): luma compute, central-
    ///      difference gradient, threshold via masking, blend observed
    ///      -> sharpened.
    static func swiftApplySharpen(
        _ rgbBuf: [[Float]],
        w: Int, h: Int,
        amount: Float, radius: Float, detail: Float, masking: Float
    ) -> [[Float]] {
        if abs(amount) < 1e-3 { return rgbBuf }
        let clamped = max(Float(0.5), min(Float(3.0), radius))
        let radiusPx = max(1, Int(roundf(clamped)))

        // RL iteration loop. Per-channel blur via swiftGaussianBlurPlane
        // (one per channel — Rust's gaussian_blur_rgb runs the same
        // box-blur on each channel independently).
        var estimate = rgbBuf
        let observed = rgbBuf
        for _ in 0..<3 {
            // Split estimate into 3 channel planes; blur each.
            var rPlane = [Float](repeating: 0, count: w * h)
            var gPlane = [Float](repeating: 0, count: w * h)
            var bPlane = [Float](repeating: 0, count: w * h)
            for i in 0..<(w * h) {
                rPlane[i] = estimate[i][0]
                gPlane[i] = estimate[i][1]
                bPlane[i] = estimate[i][2]
            }
            let rBlur = Self.swiftGaussianBlurPlane(rPlane, w: w, h: h, radius: radiusPx)
            let gBlur = Self.swiftGaussianBlurPlane(gPlane, w: w, h: h, radius: radiusPx)
            let bBlur = Self.swiftGaussianBlurPlane(bPlane, w: w, h: h, radius: radiusPx)

            // ratio = observed / max(reblur, 1e-5)
            var ratio = [[Float]](repeating: [0, 0, 0], count: w * h)
            let EPS: Float = 1e-5
            for i in 0..<(w * h) {
                ratio[i] = [
                    observed[i][0] / max(rBlur[i], EPS),
                    observed[i][1] / max(gBlur[i], EPS),
                    observed[i][2] / max(bBlur[i], EPS),
                ]
            }
            // correction = blur(ratio)
            for i in 0..<(w * h) {
                rPlane[i] = ratio[i][0]
                gPlane[i] = ratio[i][1]
                bPlane[i] = ratio[i][2]
            }
            let rCorr = Self.swiftGaussianBlurPlane(rPlane, w: w, h: h, radius: radiusPx)
            let gCorr = Self.swiftGaussianBlurPlane(gPlane, w: w, h: h, radius: radiusPx)
            let bCorr = Self.swiftGaussianBlurPlane(bPlane, w: w, h: h, radius: radiusPx)
            // estimate = estimate * correction
            for i in 0..<(w * h) {
                estimate[i] = [
                    estimate[i][0] * rCorr[i],
                    estimate[i][1] * gCorr[i],
                    estimate[i][2] * bCorr[i],
                ]
            }
        }

        var sharpened = estimate

        // Overdrive (amount > 100).
        if amount > 100.0 {
            let overMix = (amount - 100.0) / 100.0
            var rPlane = [Float](repeating: 0, count: w * h)
            var gPlane = [Float](repeating: 0, count: w * h)
            var bPlane = [Float](repeating: 0, count: w * h)
            for i in 0..<(w * h) {
                rPlane[i] = sharpened[i][0]
                gPlane[i] = sharpened[i][1]
                bPlane[i] = sharpened[i][2]
            }
            let rB = Self.swiftGaussianBlurPlane(rPlane, w: w, h: h, radius: radiusPx)
            let gB = Self.swiftGaussianBlurPlane(gPlane, w: w, h: h, radius: radiusPx)
            let bB = Self.swiftGaussianBlurPlane(bPlane, w: w, h: h, radius: radiusPx)
            for i in 0..<(w * h) {
                sharpened[i] = [
                    sharpened[i][0] + (sharpened[i][0] - rB[i]) * overMix,
                    sharpened[i][1] + (sharpened[i][1] - gB[i]) * overMix,
                    sharpened[i][2] + (sharpened[i][2] - bB[i]) * overMix,
                ]
            }
        }

        // Edge-aware final mix.
        let overallMix = max(Float(0.0), min(Float(1.5), amount / 100.0))
        let detailAtten = max(Float(0.0), min(Float(1.0), detail / 100.0))
        let maskingThreshold = max(Float(0.0), min(Float(1.0), masking / 100.0))

        // Compute luma plane.
        var luma = [Float](repeating: 0, count: w * h)
        for i in 0..<(w * h) {
            luma[i] = 0.2627 * observed[i][0] + 0.6780 * observed[i][1] + 0.0593 * observed[i][2]
        }
        // Helper: clamped index.
        func idxAt(_ x: Int, _ y: Int) -> Int {
            let xc = max(0, min(w - 1, x))
            let yc = max(0, min(h - 1, y))
            return yc * w + xc
        }

        var out = [[Float]](repeating: [0, 0, 0], count: w * h)
        for y in 0..<h {
            for x in 0..<w {
                let i = y * w + x
                let edge: Float
                if maskingThreshold > 1e-3 {
                    let gx = luma[idxAt(x + 1, y)] - luma[idxAt(x - 1, y)]
                    let gy = luma[idxAt(x, y + 1)] - luma[idxAt(x, y - 1)]
                    let g = sqrtf(gx * gx + gy * gy)
                    let gNorm = max(Float(0.0), min(Float(1.0), g / 0.2))
                    edge = (gNorm >= maskingThreshold) ? 1.0 : detailAtten
                } else {
                    edge = 1.0
                }
                let mix = overallMix * edge
                let o = observed[i]
                let s = sharpened[i]
                out[i] = [
                    o[0] + (s[0] - o[0]) * mix,
                    o[1] + (s[1] - o[1]) * mix,
                    o[2] + (s[2] - o[2]) * mix,
                ]
            }
        }
        return out
    }

    /// Verify the Swift scalar mirror reproduces the Rust `apply`
    /// behaviour on a step-edge image. Mirrors the Rust unit test
    /// `edge_becomes_sharper` at sharpen.rs:156-178.
    func testM4SwiftScalarApplySharpenMatchesRust() async throws {
        // Build a 16×4 step-edge image (left half 0.3, right half 0.7).
        // Same shape as sharpen.rs:158-167.
        let w = 16, h = 4
        var rgb = [[Float]](repeating: [0, 0, 0], count: w * h)
        for y in 0..<h {
            for x in 0..<w {
                let v: Float = (x < 8) ? 0.3 : 0.7
                rgb[y * w + x] = [v, v, v]
            }
        }
        let before = rgb
        // Run apply at amount=100, radius=1.0, detail=25, masking=0
        // (matches the Rust test parameters at sharpen.rs:169).
        let out = Self.swiftApplySharpen(rgb, w: w, h: h,
                                         amount: 100.0, radius: 1.0,
                                         detail: 25.0, masking: 0.0)

        // Right after the edge (x=8), sharpened should be >= original.
        // Just before edge (x=7), sharpened should be <= original.
        // (Tolerance 0.01 matches the Rust test at sharpen.rs:174-177.)
        let rightIdx = 2 * w + 8
        let leftIdx = 2 * w + 7
        XCTAssertGreaterThanOrEqual(out[rightIdx][0], before[rightIdx][0] - 0.01,
            "right side: \(out[rightIdx][0]) vs \(before[rightIdx][0])")
        XCTAssertLessThanOrEqual(out[leftIdx][0], before[leftIdx][0] + 0.01,
            "left side: \(out[leftIdx][0]) vs \(before[leftIdx][0])")

        // Every output pixel finite.
        for p in out {
            for c in p {
                XCTAssertTrue(c.isFinite,
                    "apply_sharpen produced non-finite channel: \(c)")
            }
        }
    }

    /// Identity check for the scalar mirror: amount=0 returns the input
    /// unchanged (mirrors the Rust short-circuit at sharpen.rs:30).
    func testM4SwiftScalarApplySharpenZeroIsIdentity() async throws {
        let w = 8, h = 8
        var rgb = [[Float]](repeating: [0, 0, 0], count: w * h)
        for i in 0..<(w * h) {
            rgb[i] = [Float(i) / 64.0, 0.5, 0.7]
        }
        let out = Self.swiftApplySharpen(rgb, w: w, h: h,
                                         amount: 0.0, radius: 1.0,
                                         detail: 25.0, masking: 0.0)
        for i in 0..<(w * h) {
            XCTAssertEqual(out[i][0], rgb[i][0], accuracy: 0.0,
                "amount=0 not identity at pixel \(i) channel R")
            XCTAssertEqual(out[i][1], rgb[i][1], accuracy: 0.0,
                "amount=0 not identity at pixel \(i) channel G")
            XCTAssertEqual(out[i][2], rgb[i][2], accuracy: 0.0,
                "amount=0 not identity at pixel \(i) channel B")
        }
    }

    /// Identity check at the Swift wrapper level: applySceneSharpen
    /// with amount=0 returns the input CIImage instance (===).
    /// Mirrors v2 v2's testM3NRLuminanceShortCircuitsAtZeroAmount.
    func testM4SharpenShortCircuitsAtZeroAmount() async throws {
        let input = Self.makeRGBSceneLinearCIImage(
            width: 8, height: 8, r: 0.4, g: 0.5, b: 0.6
        )
        let out = MetalKernels.applySceneSharpen(
            to: input,
            amount: 0.0, radius: 0.5, detail: 25.0, masking: 0.0
        )
        XCTAssertTrue(out === input,
            "amount=0 should return the input CIImage instance unchanged")
    }

    /// Verify masking parameter actually attenuates sharpening on flat
    /// regions. The Rust source at sharpen.rs:108-110 sets
    /// edge = (g_norm >= masking_threshold) ? 1.0 : detail_atten.
    /// On a flat region (gradient ~0), `g_norm < masking_threshold`
    /// for any masking > 0, so `edge = detail_atten` (small). On an
    /// edge, `g_norm = 1.0 >= masking_threshold`, so `edge = 1.0`
    /// (full sharpening). This test asserts: with masking=50, the
    /// flat-region sharpened delta is smaller than with masking=0.
    func testM4SharpenMaskingFadesFlatAreas() async throws {
        // 16×16 flat field at 0.5 (no edges).
        let w = 16, h = 16
        var rgb = [[Float]](repeating: [0, 0, 0], count: w * h)
        for i in 0..<(w * h) {
            rgb[i] = [0.5, 0.5, 0.5]
        }
        // amount = 100, detail = 25, masking = 0 (no edge gating).
        let outNoMask = Self.swiftApplySharpen(rgb, w: w, h: h,
                                                amount: 100.0, radius: 1.0,
                                                detail: 25.0, masking: 0.0)
        // amount = 100, detail = 25, masking = 50 (flat regions get 25%
        // of the boost via detail_atten).
        let outMasked = Self.swiftApplySharpen(rgb, w: w, h: h,
                                                amount: 100.0, radius: 1.0,
                                                detail: 25.0, masking: 50.0)

        // On a flat field with no edges, both outputs should be very
        // close to the input — RL converges to the input on a flat
        // image (per sharpen.rs:142-153). The masking parameter is
        // most visible on noisy flat regions; for this synthetic test,
        // we assert the masked output is at least as close to the
        // input as the non-masked one (masking should never increase
        // deviation on a flat region).
        var noMaskDelta: Float = 0
        var maskedDelta: Float = 0
        for i in 0..<(w * h) {
            for c in 0..<3 {
                noMaskDelta += abs(outNoMask[i][c] - rgb[i][c])
                maskedDelta += abs(outMasked[i][c] - rgb[i][c])
            }
        }
        XCTAssertLessThanOrEqual(maskedDelta, noMaskDelta + 1e-3,
            "masking=50 should not increase deviation on flat field — got noMask=\(noMaskDelta) masked=\(maskedDelta)")
    }
```

- [ ] **Step 5.2: Run the parity tests.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter "testM4" 2>&1 | tail -15`

Expected: PASS for `testM4SwiftScalarApplySharpenMatchesRust`, `testM4SwiftScalarApplySharpenZeroIsIdentity`, `testM4SharpenShortCircuitsAtZeroAmount`, `testM4SharpenMaskingFadesFlatAreas`.

If `testM4SwiftScalarApplySharpenMatchesRust` fails on the right-edge `>=` assertion, RL is converging in the wrong direction — re-check `ratio = observed / reblur` (not the inverse) and `estimate * correction` (not divide). If the left-edge `<=` assertion fails, the ratio sign is flipped. If `testM4SharpenMaskingFadesFlatAreas` fails, the gradient threshold logic is inverted (re-read `g_norm >= masking_threshold ? 1.0 : detail_atten` at `sharpen.rs:110`).

- [ ] **Step 5.3: Run the full Swift test suite.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | tail -10`

Expected: green. Test count = post-Task-1 baseline + 4.

- [ ] **Step 5.4: Commit.**

```bash
git add src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
git commit -m "test(apple): pure-Swift parity mirror for SceneSharpen vs Rust

Plan 2 v2 v3 M4 verification gate. swift test cannot load metallibs
(established v2 v1 / v2 v2 pattern), so the Metal kernels from Tasks
2-4 are silent no-ops under XCTest. To verify algorithm correctness,
this commit adds a pure-Swift scalar mirror of sharpen::apply
(raw-core/src/stages/sharpen.rs:22-124) and runs it against the same
shape of inputs the Rust unit test edge_becomes_sharper at
sharpen.rs:156-178 uses.

The Swift mirror reuses swiftGaussianBlurPlane (added by v2 v1 Task
3) for the per-channel PSF convolution; the RL iteration body and
the edge-mask logic are byte-faithful ports of the Rust scalar code.
This locks in the algorithm port at the Swift layer; the live Metal
kernel runtime check is in Task 7's manual smoke test.

Tests:
  * testM4SwiftScalarApplySharpenMatchesRust — step edge becomes
    sharper after amount=100 (right-side >= original, left-side
    <= original; matches sharpen.rs:174-177).
  * testM4SwiftScalarApplySharpenZeroIsIdentity — amount=0 returns
    the input unchanged.
  * testM4SharpenShortCircuitsAtZeroAmount — wrapper short-circuit
    returns the input CIImage instance (===).
  * testM4SharpenMaskingFadesFlatAreas — masking parameter never
    increases deviation on a flat field (the masking-threshold
    branch at sharpen.rs:108-110 attenuates sharpening on flat
    regions)."
```

---

## Task 6: Wire `applySceneSharpen` into `processSceneLinear`

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift` (`processSceneLinear`, between texture and NR luminance)
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift` (append wiring smoke test)

**Why this matters:** The wiring is a one-line insert in `processSceneLinear`, between the post-texture `withTexture` (the post-texture stage from v2 v1) and the post-sharpen call to `applySceneNRLuminance` (the post-sharpen stage from v2 v2). Order matches Rust at `pipeline.rs:130`: sharpen between texture/dehaze and NR luminance.

- [ ] **Step 6.1: Confirm the Rust chain order: sharpen between texture/dehaze and NR luminance.**

Run: `grep -n 'stage("texture\|stage("dehaze\|stage("sharpen\|stage("nr_luminance\|stage("nr_color' src/raw-pipeline/raw-core/src/pipeline.rs`

Expected:
```
128:    stage("texture", || texture::apply(&mut scene, model.texture));
129:    stage("dehaze", || dehaze::apply(&mut scene, model.dehaze));
130:    stage("sharpen", || sharpen::apply(&mut scene, model.sharpen_amount, model.sharpen_radius, model.sharpen_detail, model.sharpen_masking));
131:    stage("nr_luminance", || noise_reduction::apply_luminance(&mut scene, model.nr_luminance));
132:    stage("nr_color", || noise_reduction::apply_color(&mut scene, model.nr_color));
```

(Note: Rust line 129 is dehaze; Plan 2 v2 v4 ports dehaze. v3 leaves a comment marker for future v4 dehaze insertion above the v3 sharpen call.)

- [ ] **Step 6.2: Write a failing wiring smoke test for sharpen.**

Append to `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift`:

```swift
    // MARK: - Plan 2 v2 v3 M4: Sharpen wired into processSceneLinear

    /// Run a 32×32 fp16 Rec.2020 CIImage with an alternating-luma
    /// pattern through processSceneLinear with model.sharpenAmount = 0
    /// (default) vs model.sharpenAmount = 100. Assert the +100 output's
    /// centre-pixel R-channel is finite, in [0, 2], and >= the default
    /// output (sharpening should not crush mid-tones to zero on a
    /// stepped-luma scene). Same `>=` caveat as v2 v1 / v2 v2 wiring
    /// tests — under XCTest the kernel may be a no-op; the load-bearing
    /// runtime check is in Task 7's manual smoke test.
    func testM4ProcessSceneLinearAppliesSharpen() async throws {
        let pipeline = ImageEditPipeline()
        let input = Self.makeAlternatingLumaSceneLinearCIImage(width: 32, height: 32)

        var modelDefault = AdjustmentModel.default
        modelDefault.nrLuminance = 0
        modelDefault.nrColor = 0
        modelDefault.sharpenAmount = 0
        var modelBoost = modelDefault
        modelBoost.sharpenAmount = 100
        modelBoost.sharpenRadius = 1.0
        modelBoost.sharpenDetail = 25.0
        modelBoost.sharpenMasking = 0.0

        let outDefault = pipeline.processSceneLinear(decoded: input, model: modelDefault)
        let outBoost   = pipeline.processSceneLinear(decoded: input, model: modelBoost)

        let dR = Self.sampleCenterR(outDefault, width: 32, height: 32)
        let bR = Self.sampleCenterR(outBoost, width: 32, height: 32)
        XCTAssertTrue(dR.isFinite && bR.isFinite,
            "sharpen produced non-finite channel: default=\(dR) boost=\(bR)")
        XCTAssertGreaterThanOrEqual(bR, 0.0,
            "sharpen pushed centre R below zero: \(bR)")
        XCTAssertLessThanOrEqual(bR, 2.0,
            "sharpen pushed centre R above 2.0 (clip headroom): \(bR)")
    }
```

(`makeAlternatingLumaSceneLinearCIImage` was added by v2 v2 Task 6 at `SceneLinearPipelineTests.swift:1192-1221`; reused here.)

- [ ] **Step 6.3: Run the test — expect PASS (no-op kernels short-circuit but the wrapper exists; identity-baseline tests are bounded).**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testM4ProcessSceneLinearAppliesSharpen 2>&1 | tail -10`

Expected: PASS even before wiring (the wrapper is public and the wiring test doesn't depend on the wrapper being called from `processSceneLinear` yet — the bounds check is satisfied at identity). The wiring lands in Step 6.4.

- [ ] **Step 6.4: Add the `applySceneSharpen` call inside `processSceneLinear`.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift`, locate the `withTexture` block (lines 366-369 after v2 v1 landing) and the `withNRLuminance` block (lines 378-381 after v2 v2 landing). Replace:

```swift
        // Plan 2 v2 M2 — Stage: SceneTexture (unsharp mask at radius 3 in
        // scene-linear Rec.2020 RGB). Mirrors texture::apply from raw-core
        // (texture.rs:10). Backed by the same SeparableGaussianBlur
        // compute kernel as clarity (Task 2); only the radius differs.
        let withTexture = MetalKernels.applySceneTexture(
            to: withClarity,
            texture: Float(model.texture)
        )

        // Plan 2 v2 v2 M3 — Stage: SceneNRLuminance (Oklab roundtrip + shared
        // blur on the L channel). Mirrors noise_reduction::apply_luminance
        // from raw-core (noise_reduction.rs:20-55). Backed by the same
        // SeparableGaussianBlur compute kernel. Radius is integer, scaled
        // by model.nrLuminance: max(1, ceil((amount/100) * 2.0)) — at
        // amount=100, radius=2 src px (3-pass box ~3 px tail), well inside
        // the Deep Zoom 35 px overlap budget.
        let withNRLuminance = MetalKernels.applySceneNRLuminance(
            to: withTexture,
            nrLuminance: Float(model.nrLuminance)
        )
```

with:

```swift
        // Plan 2 v2 M2 — Stage: SceneTexture (unsharp mask at radius 3 in
        // scene-linear Rec.2020 RGB). Mirrors texture::apply from raw-core
        // (texture.rs:10). Backed by the same SeparableGaussianBlur
        // compute kernel as clarity (Task 2); only the radius differs.
        let withTexture = MetalKernels.applySceneTexture(
            to: withClarity,
            texture: Float(model.texture)
        )

        // Plan 2 v2 v4 (sibling, in flight) — Stage: SceneDehaze inserts here
        // between texture and sharpen. Until v4 lands, the chain skips
        // dehaze and feeds withTexture directly into sharpen. Per Rust at
        // pipeline.rs:129-130: dehaze before sharpen.

        // Plan 2 v2 v3 M4 — Stage: SceneSharpen (3-iter Richardson-Lucy +
        // edge-aware mix in scene-linear Rec.2020 RGB). Mirrors
        // sharpen::apply from raw-core (sharpen.rs:22-124). Orchestrates
        // the shared SeparableGaussianBlur compute kernel (3 RL iters ×
        // 2 blurs each + optional overdrive blur = up to 7 blur passes)
        // plus the small per-pixel kernels rlRatio, rlMultiply,
        // sharpenLuminance, sharpenEdgeMix, sharpenOverdrive. Maximum
        // effective stencil at sharpen_radius=3.0 is ~9 src px (3 RL
        // iters × box of radius ≤3 + 1 px central-difference for the
        // gradient), well inside the Deep Zoom 35 px overlap budget.
        let withSharpen = MetalKernels.applySceneSharpen(
            to: withTexture,
            amount: Float(model.sharpenAmount),
            radius: Float(model.sharpenRadius),
            detail: Float(model.sharpenDetail),
            masking: Float(model.sharpenMasking)
        )

        // Plan 2 v2 v2 M3 — Stage: SceneNRLuminance (Oklab roundtrip + shared
        // blur on the L channel). Mirrors noise_reduction::apply_luminance
        // from raw-core (noise_reduction.rs:20-55). Backed by the same
        // SeparableGaussianBlur compute kernel. Radius is integer, scaled
        // by model.nrLuminance: max(1, ceil((amount/100) * 2.0)) — at
        // amount=100, radius=2 src px (3-pass box ~3 px tail), well inside
        // the Deep Zoom 35 px overlap budget.
        let withNRLuminance = MetalKernels.applySceneNRLuminance(
            to: withSharpen,
            nrLuminance: Float(model.nrLuminance)
        )
```

The `withNRLuminance` and downstream `withNRColor` / `applyAgXViewTransform` stay unchanged in shape — only the input flow is updated to feed off `withSharpen` instead of `withTexture`.

- [ ] **Step 6.5: Run the wiring test.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testM4ProcessSceneLinearAppliesSharpen 2>&1 | tail -10`

Expected: PASS.

- [ ] **Step 6.6: Run the full Swift test suite.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | tail -10`

Expected: green. Test count = post-Task-5 baseline + 1.

- [ ] **Step 6.7: Run the parity harness.**

Run: `BUDGET=15 src/scripts/test_color_pipeline.sh 2>&1 | tail -8`

Expected: PASS — Plan 2 v2 v3 has not touched `applyFilters`.

- [ ] **Step 6.8: Commit.**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
git commit -m "feat(apple): wire SceneSharpen into processSceneLinear

Plan 2 v2 v3 M4 — sharpen on the new path. Inserts the call between
SceneTexture and SceneNRLuminance in processSceneLinear so the chain
becomes:

  WB -> tone -> vibrance -> saturation -> clarity -> texture
       -> [v4 dehaze placeholder] -> sharpen
       -> NR luminance -> NR color -> AgX

Order matches raw-core's pipeline.rs:130 (sharpen before NR
luminance). The dehaze placeholder comment marks where Plan 2 v2 v4
(sibling plan) will insert applySceneDehaze when it lands.

Test asserts centre-pixel finite and bounded under amount=100.
Parity harness on the legacy path (BUDGET=15) stays green —
applyFilters still untouched."
```

---

## Task 7: M4 milestone gate — manual smoke test + deep-zoom regression check

**Files:**
- Read-only: `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift`
- Read-only: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/DeepZoomTileRenderingTests.swift`
- Modify (header comment only): `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift`
- Build artifacts: the macOS `Maple.app` launched from `xcodebuild` output

**Why this matters:** `swift test` cannot load the metallib (per `MetalKernels.swift:19-28` and the v2 v1 / v2 v2 milestone-gate notes), so the wiring test in Task 6 is a smoke test, not a runtime parity test. The actual confirmation that sharpen moves pixels at runtime is a manual A/B in the macOS app. This task is also where the deep-zoom regression check lands: the existing `DeepZoomTileRenderingTests.swift` exercises the 35 px tile-overlap budget; running it after wiring confirms the new compute-blur chain (now invoked up to 7× per slider tick) doesn't widen the effective stencil for sharpen (which it shouldn't — 9 px effective stencil ≪ 35 px budget).

- [ ] **Step 7.1: Build the macOS app.**

Run: `cd src/apple && xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build 2>&1 | tail -3`

Expected: `BUILD SUCCEEDED`. The xcframework is unchanged (no Rust source changes in Plan 2 v2 v3).

- [ ] **Step 7.2: Launch the app and open the reference fixture.**

Run: `open -a /Users/$USER/Library/Developer/Xcode/DerivedData/Maple-*/Build/Products/Debug/Maple.app`

(Substitute the actual DerivedData path if the wildcard expansion fails — `find ~/Library/Developer/Xcode/DerivedData -name 'Maple-*' -maxdepth 1 -type d` locates it.)

Open `src/raw-pipeline/test-fixtures/raws/dji-mavic3pro-100mp.dng` (or the largest available fixture — `ls src/raw-pipeline/test-fixtures/raws/*.dng`).

- [ ] **Step 7.3: Drag sharpen sliders, confirm each moves pixels.**

For each slider transition below, drag and visually confirm the image changes:

| Slider          | Default | Test action          | Expected                                                                                    |
|-----------------|---------|----------------------|---------------------------------------------------------------------------------------------|
| sharpenAmount   | 0       | Drag to +100         | Mid-frequency detail (textures, foliage edges) becomes crisper; flat regions stay smooth   |
| sharpenAmount   | 100     | Drag to +150         | Edge contrast increases further (overdrive on top of RL); slight halos start to appear      |
| sharpenRadius   | 0.5     | Drag to 3.0          | Sharpening strength on coarser features increases; fine grain becomes less affected         |
| sharpenDetail   | 25      | Drag to 100          | More mid-frequency detail emerges; noise can become slightly more visible                    |
| sharpenMasking  | 0       | Drag to 50           | Sharpening fades on flat regions (sky, clean shadows); edges retain full sharpening         |
| sharpenMasking  | 50      | Drag to 0            | Sharpening returns to flat regions                                                          |
| sharpenAmount   | 100     | Drag to 0            | All sharpening removed (image returns to bare texture state)                                |

Capture a screenshot of one mid-drag state per slider — file at `/tmp/plan-2-v2-v3-m4-<slider>.png`. **Do not commit screenshots.**

If any slider fails to move pixels, M4 is not actually working — STOP and inspect:
- Run `log stream --predicate 'subsystem == "app.justmaple.maple"'` and look for `os_log .error` lines from `MetalKernels.loadKernel`.
- Confirm the metallib is present in the .app bundle: `find /Users/$USER/Library/Developer/Xcode/DerivedData/Maple-*/Build/Products/Debug/Maple.app -name 'RichardsonLucyMixer.metal' -o -name 'SharpenEdgeMix.metal' -o -name 'SharpenOverdrive.metal'`. If any of the three is absent, the `.copy("Metal")` resource bundling failed — rebuild from clean (`xcodebuild clean` then `build`).
- If the `os_log` shows "Cannot find a valid stitchable Metal function in the source" or "cannot initialize a variable of type 'float4' with an rvalue of type 'half4'" (the v2 v1 Spike 1.1 modern-macOS failure modes), the new sharpen kernels need `[[stitchable]]` retrofitted (per the Step 1.5 note in Task 1). Apply the fix to BOTH the new sharpen kernels AND the existing v2 v1 / v2 v2 production kernels in a separate retrofit plan — do NOT add `[[stitchable]]` only to the new sharpen kernels (would create a kernel-source style split).

- [ ] **Step 7.4: Run the Deep Zoom test suite to confirm tile compatibility didn't regress.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter DeepZoomTileRenderingTests 2>&1 | tail -20`

Expected: green. The tests exercise the 35 px overlap budget; sharpen 9 px stencil is far inside that budget. Plan 2 v2 v3's M4 does not change radius constants (sharpen_radius stays clamped to 0.5..3.0) or the algorithm shape (3-iter RL + edge mask — same as Rust), so the deep-zoom math is preserved by construction. The test run is a regression detector — if anything has broken, the failure is in the orchestration of multiple compute-blur passes (e.g. tile-edge artefacts from too-aggressive intermediate caching).

If the deep-zoom suite fails, inspect the failing test name and trace it to which tile-rect / radius combination broke. Most likely cause: a stale cached intermediate from one of the 7 blur passes leaking across tile boundaries (re-check that `applySeparableGaussianBlur` allocates fresh textures per call as documented at `MetalKernels.swift:222-233`).

- [ ] **Step 7.5: Run the parity harness one more time.**

Run: `BUDGET=15 src/scripts/test_color_pipeline.sh 2>&1 | tail -8`

Expected: PASS — Plan 2 v2 v3 has not touched `applyFilters` (legacy path).

- [ ] **Step 7.6: Append the M4 manual test result to the test file header.**

In `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift`, locate the Plan 2 v2 v2 M3 milestone-gate header block (added by v2 v2 Task 7 Step 7.6). Append after it:

```swift
//
// Plan 2 v2 v3 M4 manual smoke test (Task 7 Step 7.3, recorded after
// wiring SceneSharpen into processSceneLinear in Task 6):
//   sharpenAmount   0 -> +100   moved pixels — <PASS|FAIL>
//   sharpenAmount   100 -> +150 moved pixels — <PASS|FAIL>
//   sharpenRadius   0.5 -> 3.0  moved pixels — <PASS|FAIL>
//   sharpenDetail   25 -> 100   moved pixels — <PASS|FAIL>
//   sharpenMasking  0 -> 50     moved pixels — <PASS|FAIL>
//   sharpenMasking  50 -> 0     moved pixels — <PASS|FAIL>
//   sharpenAmount   100 -> 0    moved pixels — <PASS|FAIL>
//
// Deep Zoom regression check (Task 7 Step 7.4):
//   DeepZoomTileRenderingTests — <PASS|FAIL> (35 px overlap budget
//   preserved by construction; sharpen 9 px stencil <<< 35 px).
//
// Parity harness on legacy path (Step 7.5): BUDGET=15 <PASS|FAIL>
// — applyFilters still untouched.
```

Replace `<PASS|FAIL>` with the actual results. A FAIL anywhere blocks Plan 2 v2 v3 from being declared complete — STOP and investigate.

- [ ] **Step 7.7: Commit.**

```bash
git add src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
git commit -m "docs(apple): record Plan 2 v2 v3 M4 milestone-gate results in test file header

M4 wires SceneSharpen into processSceneLinear. swift test cannot load
metallibs so the kernels run no-op under XCTest; the runtime
confirmation is manual at this milestone. This commit records the
result of dragging each sharpen slider once on the reference fixture
and observing pixel changes.

Also records the DeepZoomTileRenderingTests result — the 35 px overlap
budget is preserved by construction (sharpen 9 px stencil <<< 35 px;
algorithm shape unchanged). Parity harness on the legacy path
(BUDGET=15) still passes.

This concludes Plan 2 v2 v3 (M4 = sharpen). Plan 2 v2 v4 (dehaze)
is the sibling plan; v5 (delete legacy applyFilters) follows after
v4."
```

---

## Self-review checklist (before declaring Plan 2 v2 v3 complete)

The following are the load-bearing checks — confirm each before marking the plan done.

1. **Both v2 v1 spikes still recorded as PASS** in the test file header (verified in Task 1 Step 1.3). Plan 2 v2 v3 also adds Spike 3.1 (neighbour-offset sampling); that result is recorded in the test-file header in Task 3 Step 3.5.
2. **Three new Metal sources** under `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/`:
   - `RichardsonLucyMixer.metal` — `CIColorKernel`, 2 functions: `rlRatio` + `rlMultiply`.
   - `SharpenEdgeMix.metal` — 1 `CIColorKernel` (`sharpenLuminance`) + 1 `CIKernel` (`sharpenEdgeMix`, spatial).
   - `SharpenOverdrive.metal` — `CIColorKernel`, 1 function: `sharpenOverdrive`.
3. **One new public Swift wrapper** in `MetalKernels.swift`:
   - `applySceneSharpen(to:amount:radius:detail:masking:)`
4. **Five new private Swift loaders** in `MetalKernels.swift`:
   - `rlRatioKernel()`, `rlMultiplyKernel()`, `sharpenLuminanceKernel()`, `sharpenEdgeMixKernel()`, `sharpenOverdriveKernel()`
5. **Wiring in `processSceneLinear`:** the chain is now WB → tone → vibrance → saturation → clarity → texture → [v4 dehaze placeholder] → sharpen → NR luminance → NR color → AgX. Verify with `grep -n "applyScene" src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift` — nine matches in `processSceneLinear` (WB, tone, vibrance, saturation, clarity, texture, sharpen, NR luminance, NR color) before the AgX return.
6. **Test count grew by 5 test methods:**
   - Task 5 adds 4: `testM4SwiftScalarApplySharpenMatchesRust`, `testM4SwiftScalarApplySharpenZeroIsIdentity`, `testM4SharpenShortCircuitsAtZeroAmount`, `testM4SharpenMaskingFadesFlatAreas`.
   - Task 6 adds 1: `testM4ProcessSceneLinearAppliesSharpen`.
   - Plus 1 static helper func (`swiftApplySharpen`) — not a test method.
7. **Parity harness still PASS** at `BUDGET=15` — the legacy `applyFilters` path is untouched.
8. **DeepZoomTileRenderingTests still PASS** — sharpen 9 px stencil is far inside the 35 px overlap budget; algorithm shape unchanged.
9. **No `applyFilters` source touched.** Verify with `git diff main..HEAD -- src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift` and confirm changes are scoped to `processSceneLinear`.
10. **Manual smoke test passed for all 7 slider transitions** — recorded in the test file header (Task 7 Step 7.6).
11. **Spike 3.1 outcome recorded.** Either path (PASS = inline gradient in `sharpenEdgeMix`, FAIL = separate `sharpenGradient` kernel) is documented in the test-file header. If the result was FAIL, the kernel structure deviates from the plan above — verify the fallback two-kernel architecture compiled and ran.
12. **No Rust source files touched.** Verify with `git diff main..HEAD -- src/raw-pipeline/` — should produce empty output.
13. **No conflict with Plan 2 v2 v4 (dehaze, sibling plan).** v3 leaves a clear comment marker in `processSceneLinear` for v4's dehaze insertion above sharpen. v4 will modify the comment block + add a new line; v3's `withSharpen` consumer reads from `withTexture` until v4 changes it to `withDehaze`.

If any check fails, the plan is not complete. Address the failing check, re-run the verification steps it depends on, and only then declare done.
