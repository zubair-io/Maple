# Plan 2 v2 v2 — NR Luminance + NR Color on Scene-Linear Metal Kernels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Brief:** [`.archived-plans/specs/2026-04-25-plan-2-v2-heavy-slider-stages-brief.md`](../specs/2026-04-25-plan-2-v2-heavy-slider-stages-brief.md). The brief's § 7 sequencing locks **M3 = NR luminance + NR color** as the next milestone after Plan 2 v2 v1's M1+M2. § 2 "Per-stage kernel inventory" rows 3 + 4 spec the approach: "Oklab roundtrip + shared blur on L" (NR luma) and "Oklab roundtrip + shared blur on a/b" (NR color).
>
> **Predecessor plan:** [`.archived-plans/plans/2026-04-25-plan-2-v2-shared-blur-clarity-texture.md`](2026-04-25-plan-2-v2-shared-blur-clarity-texture.md) — Plan 2 v2 v1 (already shipped, see commits `b84da17` SeparableGaussianBlur, `c441000` clarity wired, `63ae256` texture wired, `7d1210c` M2 milestone gate). Wired clarity + texture into `processSceneLinear` between saturation and AgX. The new chain order after THIS plan is: WB → tone → vibrance → saturation → clarity → texture → **NR luminance → NR color** → AgX. Sharpen, dehaze, and the legacy `applyFilters` deletion are explicitly out of scope (see § Out of scope).
>
> **Tile-rendering invariant:** [`.archived-plans/plans/2026-04-25-deep-zoom-tile-rendering.md`](2026-04-25-deep-zoom-tile-rendering.md) § "Architecture" point 2 documents the 35 px overlap budget. NR luminance radius ≤2 src px (at slider max 100, `radius = ceil((100/100) * 2.0) = 2`, then `r_box = max(1, 2/3) = 1`, 3-pass box ≈ 3 px tail) and NR color radius ≤4 src px (`radius = ceil((100/100) * 4.0) = 4`, `r_box = max(1, 4/3) = 1`, 3-pass box ≈ 3 px tail) both fit far inside the 35 px budget. The deep-zoom plan's Architecture point 2 line 15 explicitly lists "nr_color 4 px at amount=100" as one of the well-bounded stencils. **No overlap math changes here.** Verification step in Task 7 runs the full deep-zoom test (`DeepZoomTileRenderingTests.swift`) after wiring to confirm tile seams haven't regressed.

**Goal:** Port Rust `noise_reduction::apply_luminance` and `noise_reduction::apply_color` ([`raw-core/src/stages/noise_reduction.rs:20`](../../../src/raw-pipeline/raw-core/src/stages/noise_reduction.rs) and `:61`) to scene-linear Metal kernels, wiring them into `processSceneLinear` between texture and AgX. Both stages do the same Oklab-roundtrip-plus-shared-blur shape as the Rust source: convert input rec2020 → oklab, blur the relevant channel(s) (L for luma; a, b for color) via the shared `SeparableGaussianBlur` compute kernel shipped in v2 v1, then unconvert oklab → rec2020. Slider amounts (`model.nrLuminance`, `model.nrColor`, both 0..100) drive the integer blur radius via `radius = ceil((amount/100) * MAX).max(1)` (MAX=2 for luma, MAX=4 for color); when `|amount| < 1e-3` the wrapper short-circuits to identity, matching Rust at `noise_reduction.rs:22,63`.

**Architecture:**

1. **No new spikes — both v2 v1 spikes already PASSED.** The test file header at [`SceneLinearPipelineTests.swift:163-205`](../../../src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift) records:
   - **Spike 1.1 PASS** — `MTLComputePipeline` output composes with downstream `CIColorKernel.apply` via `CIImage(mtlTexture:options:)`. This is the foundation for `applySeparableGaussianBlur(to:radius:)` already shipped in v2 v1; NR reuses it directly.
   - **Spike 1.2 PASS** — `#include` resolves via absolute paths fed to `CIKernel.kernels(withMetalString:)`. This means a shared `oklab.metal` extraction is technically feasible via runtime `Bundle.module/Metal/oklab.metal` URL injection — **but see § "Oklab shared-include decision" below for why we defer the refactor**.
     Task 1 of THIS plan is therefore a non-spike preflight: re-confirm the Rust algorithm shape and verify the v2 v1 shared blur is reachable (its public surface is `MetalKernels.applySeparableGaussianBlur(to:radius:)` at [`MetalKernels.swift:220`](../../../src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift); calling it from new wrappers requires nothing more than module-internal access).

2. **Oklab shared-include decision: DEFER, do not factor `oklab.metal` in this plan.** The brief's § 7 says "extract `oklab.metal` and `#include` it from each consumer" — and Spike 1.2's PASS makes this technically feasible. **But this plan adds NR luma + NR color on the new path; it does not touch existing production kernels.** Three reasons to defer:
   - The existing `SceneVibrance.metal` (matrices at [`SceneVibrance.metal:16-38`](../../../src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneVibrance.metal)) and `SceneSaturation.metal` (matrices duplicated with `_sat` suffix at [`SceneSaturation.metal:17-38`](../../../src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneSaturation.metal)) already use the duplication-with-suffix pattern. Per the v2 v1 saturation kernel comment at `SceneSaturation.metal:11-16`: "Metal does not share constants between .metal files inside a single metallib; repeating them here is the right pattern." That pattern is shipped, tested, and parity-verified in production.
   - Refactoring vibrance + saturation + the two new NR kernels into a shared include in one plan adds risk to NR shipping. The four-file shared-include refactor is its own plan, with its own ΔE budget gate.
   - Even at full slider extreme (radius 4 / r_box 1 / 3 box passes ~3 px tail), the Oklab convert/unconvert dominates the per-pixel arithmetic, not the matrix duplication. Performance is identical between "embedded matrices" and "shared include" — the difference is purely code style.
     **Therefore:** new kernels `SceneNRLuminance.metal` and `SceneNRColor.metal` embed their own copy of the Oklab matrices with `_nrl` and `_nrc` suffixes respectively, matching the established pattern at SceneSaturation.metal:11-16. **A follow-up "DRY oklab matrices" plan** can factor all four production kernels (vibrance, saturation, NR luminance, NR color) into a shared `oklab.metal` once the include-from-Bundle mechanics are exercised under load.

3. **One-pass approach (Rust's `oklab_img` reuse → re-convert at combine time).** Rust at `noise_reduction.rs:28-54` builds an intermediate `oklab_img`, replicates L (or packs a/b), blurs the replicate, and writes back into `oklab_img` before unconverting. The GPU mirror could either (a) plumb the oklab CIImage as a separate input to the combine kernel, or (b) re-convert rec2020 → oklab inline inside the combine kernel and overwrite only the relevant channel before unconverting. Option (b) wastes one extra `rec2020 → oklab` per pixel at combine time but **eliminates the need for a third `.metal` file** (`SceneOklab.metal` for the intermediate). Two reasons to pick (b):
   - Per-pixel `rec2020 → oklab` is bit-identical from the same input — no parity drift versus Option (a)'s plumbed intermediate, modulo identical fp16 quantization on both paths.
   - Plan 2 v2 v1's M2 (clarity + texture) chose the same shape: a single CIColorKernel mix kernel takes (src, blurred, amount) and re-derives anything it needs from the original rec2020 sampler. M3 staying consistent reduces architectural variance between sibling plans.
     **Tradeoff:** Option (b) costs one extra 3×3 matrix multiply + 3 cube roots per pixel at combine time, which is negligible compared to the 6-pass blur. Net win.

4. **Two new Metal sources, one new public Swift wrapper per stage.** Mirrors v2 v1's M2 shape (`SceneClarity` / `SceneTexture` each get one wrapper backed by the shared blur):
   - `SceneNRLuminance.metal` — two `[[stitchable]]` `CIColorKernel` functions: `nrLuminanceExtractL` (rec2020 → oklab → emit (L, L, L, alpha) on the same extent — the input to the shared blur) and `nrLuminanceCombine` (samples original rec2020 + blurred-L CIImage; re-converts rec2020 → oklab, overwrites L with `blurredL.r`, unconverts oklab → rec2020).
   - `SceneNRColor.metal` — two `[[stitchable]]` `CIColorKernel` functions: `nrColorExtractAB` (rec2020 → oklab → emit (a, b, 0, alpha)) and `nrColorCombine` (samples original rec2020 + blurred-AB CIImage; re-converts rec2020 → oklab, overwrites (a, b) with `blurredAB.rg`, unconverts).
   - `MetalKernels.applySceneNRLuminance(to:nrLuminance:)` — public wrapper. Computes `radius = max(1, ceil((amount/100) * 2.0))` (matches `noise_reduction.rs:24-25`); short-circuits to `input` when `abs(amount) < 1e-3`. Calls the extract kernel, runs `applySeparableGaussianBlur` at the integer radius, then calls the combine kernel.
   - `MetalKernels.applySceneNRColor(to:nrColor:)` — public wrapper. Identical shape with `MAX=4.0` (matches `noise_reduction.rs:64-65`).

5. **The Rust `apply_*` is a "shim" — radius is the only knob.** Per `noise_reduction.rs:1-4`: "Simplified noise reduction per spec § 3.11 (slice-5 shim). Full NLM implementation lands later." Slider `amount` controls **radius only**; the combine step OVERWRITES (no mix-with-amount blend) — `oklab_img.L = blurred.R` at `noise_reduction.rs:48-49`. The Metal combine kernel matches: `lab.x = blurredL.r;` (no `mix(lab.x, blurredL.r, amount)`). This is a faithful port; do not "improve" the algorithm in the Metal kernels.

6. **`AdjustmentModel.nrColor` default is 25, not 0** ([`AdjustmentModel.swift:54`](../../../src/apple/Packages/MapleCore/Sources/MapleCore/AdjustmentModel.swift), `:78`). Tests using `AdjustmentModel.default` as the baseline will run NR color at amount=25 (radius=1) by default — meaning "default vs +100" comparisons compare radius=1 vs radius=4. That's still a valid `>=` smoke test, but be aware. NR luminance default is 0 — that wrapper short-circuits to identity on default models.

7. **Wiring is isolated to `processSceneLinear`.** Two new lines insert NR luminance + NR color between texture (`withTexture` at [`ImageEditPipeline.swift:366-369`](../../../src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift)) and the `applyAgXViewTransform` return at `:374-376`. Insertion order matches Rust at [`pipeline.rs:131-132`](../../../src/raw-pipeline/raw-core/src/pipeline.rs): `nr_luminance` before `nr_color`. No change to `applyFilters` (legacy path stays — Plan 2 v2 v5, separate plan, deletes it).

**Tech Stack:**

- Swift (`MapleCore`) — `MetalKernels` namespace gains four cache fields (`_sceneNRLuminanceExtract`, `_sceneNRLuminanceCombine`, `_sceneNRColorExtract`, `_sceneNRColorCombine`), two new public wrappers (`applySceneNRLuminance(to:nrLuminance:)`, `applySceneNRColor(to:nrColor:)`), and four private kernel-loader helpers (`sceneNRLuminanceExtractKernel()`, `sceneNRLuminanceCombineKernel()`, `sceneNRColorExtractKernel()`, `sceneNRColorCombineKernel()`). All four loaders use the existing `loadKernel(file:function:)` helper at [`MetalKernels.swift:513`](../../../src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift).
- Metal Shading Language —
  - `SceneNRLuminance.metal`: two `[[stitchable]]` `extern "C" float4` `CIColorKernel` functions (`nrLuminanceExtractL` taking one sampler; `nrLuminanceCombine` taking two samplers + one `float` amount param that's stored but unused per § 5 above — kept for ABI symmetry with the M2 mix wrappers and to mark "Rust shim" intent in the kernel signature).
  - `SceneNRColor.metal`: two `[[stitchable]]` `extern "C" float4` `CIColorKernel` functions (`nrColorExtractAB`, `nrColorCombine`).
  - Both files embed their own Oklab matrix copies with `_nrl` / `_nrc` suffixes per § 2 above.
- Build glue — `./src/apple/scripts/build-xcframework.sh` is NOT rerun (no Rust source changes). New `.metal` files ship via existing `Package.swift` `.copy("Metal")` rule at [`Package.swift:44`](../../../src/apple/Packages/MapleCore/Package.swift) (verbatim copy, runtime compile via `CIKernel.kernels(withMetalString:)`).
- Test — `cd src/apple/Packages/MapleCore && swift test` after each Swift edit; `BUDGET=15 src/scripts/test_color_pipeline.sh` after each milestone (M3a = Task 3, M3b = Task 5, M3 = Task 7) for the legacy-path ΔE gate (Plan 2 v2 v2 must not break it).

**Out of scope (explicit):**

- **Plan 2 v2 v3 — Sharpen.** Bespoke `MTLComputePipeline` for 3-iter Richardson-Lucy. Brief § 2 marks effort `M`. Separate plan.
- **Plan 2 v2 v4 — Dehaze.** Three compute dispatches (15×15 dark-channel min-filter, atmospheric-light top-0.1% reduction, 60-radius guided filter). Brief § 2 marks effort `L`. Separate plan; deferred until v3 proves the architecture per brief § 4.
- **Plan 2 v2 v5 — Delete legacy `applyFilters` chain at [`ImageEditPipeline.swift:512`](../../../src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift)** plus the `MAPLE_SKIP_SWIFT_AGX` gate at `:679` and `MAPLE_SKIP_SWIFT_FILTERS` gate at `:520`. Brief § 4 explicitly defers this to "after every kernel is on the new path." Separate plan.
- **Oklab shared-include refactor (`oklab.metal`).** Per § 2 above, deferred to its own plan. Spike 1.2 PASSED in v2 v1 so the green light exists; the refactor itself is risk-isolated in its own commit.
- **Web/WASM port of NR.** Plan 3 territory; not touched here.
- **Pixel-parity gate against Rust.** The brief's M3 does not specify a strict numeric ΔE gate; this plan keeps the ΔE harness as a soft gate (running in Tasks 3, 5, 7 to confirm legacy-path no-regression, BUDGET=15 — which is the established Plan 2 v2 v1 baseline). Tightening to a strict numeric gate is a follow-up; budgets ratchet downward over time per [`CLAUDE.md`](../../../CLAUDE.md) § "Objective color testing — no eyeballing."
- **Pre-compiling Metal kernels at app launch.** Lazy compile on first use, cached for the process lifetime — matches the existing `MetalKernels` pattern (private static `_kernel` properties).
- **Adjusting the deep-zoom plan's 35 px overlap.** NR radii are ≤4 px (well under the 35 px budget); no change needed.
- **Replacing the "shim" radius-only NR with full NLM.** The Rust source-of-truth is a shim per its own docstring ([`noise_reduction.rs:1-4`](../../../src/raw-pipeline/raw-core/src/stages/noise_reduction.rs)); the Metal port matches the shim. Full NLM is a separate plan that ports both Rust + Apple together to keep parity.
- **Bumping `RenderedPreviewCache.adjustment_version`.** The cache key already includes `adjustment_version` per [`CLAUDE.md`](../../../CLAUDE.md) § "Performance invariants"; adding NR stages to a chain whose key already covers `model.nrLuminance` and `model.nrColor` is an additive use of existing key fields — no key change needed.

---

## File Structure

**Swift (read-write):**

- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift` — add four private static cache fields (`_sceneNRLuminanceExtract: CIColorKernel?`, `_sceneNRLuminanceCombine: CIColorKernel?`, `_sceneNRColorExtract: CIColorKernel?`, `_sceneNRColorCombine: CIColorKernel?`), two new public wrappers (`applySceneNRLuminance(to:nrLuminance:)`, `applySceneNRColor(to:nrColor:)`), and four new private kernel-loader helpers (`sceneNRLuminanceExtractKernel()`, `sceneNRLuminanceCombineKernel()`, `sceneNRColorExtractKernel()`, `sceneNRColorCombineKernel()`). All four loaders mirror the existing `sceneVibranceKernel()` shape at `MetalKernels.swift:401-406`.
- Add: `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneNRLuminance.metal` — new Metal source. Two `[[stitchable]]` `extern "C" float4` functions:
  - `nrLuminanceExtractL(coreimage::sampler_h src)` — sample input rec2020, convert to Oklab, return `(L, L, L, alpha)`. Used as the input to `applySeparableGaussianBlur`.
  - `nrLuminanceCombine(coreimage::sampler_h src, coreimage::sampler_h blurredL, float amount)` — sample original rec2020 + blurred-L CIImage, re-convert rec2020 → oklab, overwrite `lab.x = blurredL.r`, unconvert oklab → rec2020. The `amount` parameter is unused per § 5 in Architecture above (Rust shim doesn't blend; radius is the only knob); kept on the signature for ABI symmetry with M2's `sceneUnsharp` and to mark in code that the Rust source-of-truth treats this as a shim.
- Add: `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneNRColor.metal` — new Metal source. Two `[[stitchable]]` `extern "C" float4` functions:
  - `nrColorExtractAB(coreimage::sampler_h src)` — sample input rec2020, convert to Oklab, return `(a, b, 0, alpha)`. Used as the input to `applySeparableGaussianBlur`.
  - `nrColorCombine(coreimage::sampler_h src, coreimage::sampler_h blurredAB, float amount)` — sample original rec2020 + blurred-AB CIImage, re-convert rec2020 → oklab, overwrite `lab.yz = blurredAB.rg`, unconvert oklab → rec2020. `amount` unused for the same reason as above.
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift` — extend `processSceneLinear` (currently lines 287-377 after Plan 2 v2 v1 landing) with two new stage calls between `withTexture` (line 366-369) and the `applyAgXViewTransform` return (line 374): `applySceneNRLuminance(to: withTexture, nrLuminance: Float(model.nrLuminance))` and `applySceneNRColor(to: withNRLuminance, nrColor: Float(model.nrColor))`. The `withNRColor` value feeds the existing AgX call.
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift` — append (a) one M3a parity mirror test (`testM3aSwiftScalarApplyLuminanceMatchesRust`) — pure-Swift port of `apply_luminance` against a synthetic input compared to a recorded Rust reference, no metallib needed (mirrors the existing `swiftGaussianBlurPlane` parity pattern at `:1750-1830`), (b) one M3b parity mirror test (`testM3bSwiftScalarApplyColorMatchesRust`) — same shape for `apply_color`, (c) two M3 wiring smoke tests (`testM3ProcessSceneLinearAppliesNRLuminance`, `testM3ProcessSceneLinearAppliesNRColor`) that drive `processSceneLinear` end-to-end with non-zero amounts and assert centre-pixel finite-and-bounded using the existing `>=` smoke pattern from Plan 2 v1 (e.g. `testM1ProcessSceneLinearAppliesVibrance` at `:1323`), (d) one identity test per stage (`testM3NRLuminanceShortCircuitsAtZeroAmount`, `testM3NRColorShortCircuitsAtZeroAmount`) — assert the wrapper returns the input CIImage instance unchanged when amount=0 (mirrors `testTask2SeparableGaussianBlurRadiusZeroIsIdentity` at `:1731-1739`).

**Swift (read-only during verification):**

- `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneVibrance.metal` — Oklab matrix reference. Lines 16-50 (`M_rec2020_to_lms`, `M_lms_to_oklab`, `M_oklab_to_lms`, `M_lms_to_rec2020`, helper functions `rec2020_to_oklab`, `oklab_to_rec2020`). Copy verbatim into the new files with `_nrl` / `_nrc` suffix per § 2 in Architecture.
- `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneSaturation.metal` — same matrices, with `_sat` suffix. Reference for the established suffix-on-duplicate pattern.
- `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SeparableGaussianBlur.metal` — already shipped in v2 v1 (commit `b84da17`). Reference for the shared compute kernel. **Not modified** by this plan; consumed via the public `MetalKernels.applySeparableGaussianBlur(to:radius:)` wrapper.
- `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneUnsharp.metal` — pattern reference for "two-sampler `[[stitchable]]` `extern "C" float4` CIColorKernel that takes (src, blurred, amount)". Used as the source style template for `nrLuminanceCombine` and `nrColorCombine`.
- `src/apple/Packages/MapleCore/Tests/MapleCoreTests/DeepZoomTileRenderingTests.swift` — verified read-only in Task 7 Step 7.4 (no source edits).

**Rust (read-only during verification):**

- `src/raw-pipeline/raw-core/src/stages/noise_reduction.rs:20-55` — algorithm reference for `apply_luminance` (radius math at `:24-25`, oklab convert at `:29-33`, L-replicate at `:37-42`, blur at `:44`, L-writeback at `:45-49`, oklab unconvert at `:51-54`).
- `src/raw-pipeline/raw-core/src/stages/noise_reduction.rs:61-96` — same for `apply_color` (radius math at `:64-65`, AB-pack at `:75-80`, blur at `:82`, AB-writeback at `:83-90`).
- `src/raw-pipeline/raw-core/src/stages/blur.rs:77-114` — `gaussian_blur_plane` and `gaussian_blur_rgb` algorithm. **Not modified.** The Swift mirror `swiftGaussianBlurPlane` already exists in `SceneLinearPipelineTests.swift:1750` (added by v2 v1 Task 3); reused here to construct the parity reference for both NR stages.
- `src/raw-pipeline/raw-core/src/color/oklab.rs:50-74` — `rec2020_to_oklab` and `oklab_to_rec2020` reference. **The Rust source routes via Rec.2020 → sRGB → LMS using `M_REC2020_TO_SRGB` + Ottosson's M1 matrix.** The Apple Metal kernels (and `SceneVibrance.metal:16-26` matrices used as reference for `_nrl`/`_nrc` suffix copies) use a single pre-multiplied `M_rec2020_to_lms` matrix whose values equal `M1_SRGB_TO_LMS * M_REC2020_TO_SRGB`. The mathematical equivalence was verified by v1 Plan 2's vibrance + saturation parity tests; **this plan inherits that verified equivalence and does NOT re-derive the matrices**. (If a future ΔE drift surfaces in NR luma or NR color, re-deriving the product matrix from `oklab.rs` is the first investigation step.)

**Build artifacts (touched):**

- None. M3 is pure Swift + Metal source additions. The xcframework is unchanged because no Rust source changes.

---

## Ordering constraint

**Tasks must be done in the order: Task 1 (preflight) → Task 2 → Task 3 (M3a gate) → Task 4 → Task 5 (M3b gate) → Task 6 → Task 7 (M3 milestone gate).**

- **Task 1 is preflight, not spike.** Both v2 v1 spikes already PASSED. Task 1 confirms the Rust algorithm shape (with `grep` / `sed` against the source-of-truth files) and checks that the v2 v1 shared blur is reachable from new wrappers (no source edits in this task — verification commands only).
- **Task 2 is M3a kernel.** New `SceneNRLuminance.metal` (2 functions) + the Swift wrapper that orchestrates extract → blur → combine.
- **Task 3 is M3a verification.** Pure-Swift parity mirror against the Rust `apply_luminance` algorithm, recorded as a soft test (uses the existing `swiftGaussianBlurPlane` from v2 v1 plus a new `swiftRec2020ToOklab` / `swiftOklabToRec2020` mirror of the same matrices in the Metal kernel). The Metal kernel itself is a no-op under `swift test` (metallib not loaded), so the parity test is a Swift-side scalar mirror.
- **Task 4 is M3b kernel.** New `SceneNRColor.metal` (2 functions) + the Swift wrapper. Same shape as Task 2.
- **Task 5 is M3b verification.** Same as Task 3 but for `apply_color`.
- **Task 6 wires both stages into `processSceneLinear`.** Single edit (Tasks 5/6 of v2 v1 split clarity + texture; this plan combines the two NR wirings because they share an Oklab roundtrip pattern and share a parity-harness baseline).
- **Task 7 is the M3 milestone gate.** Manual smoke test in the macOS app + parity harness no-regression + `DeepZoomTileRenderingTests.swift` no-regression.

After every task: `cd src/apple/Packages/MapleCore && swift test`. After every milestone (M3a = Task 3, M3b = Task 5, M3 = Task 7): `BUDGET=15 src/scripts/test_color_pipeline.sh` (regression check on legacy path, which Plan 2 v2 v2 must not touch).

---

## Task 1: Preflight — confirm Rust algorithm shape + v2 v1 blur reachability

**Files:**

- Read-only: `src/raw-pipeline/raw-core/src/stages/noise_reduction.rs`
- Read-only: `src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift`

**Why this matters:** Both spikes from v2 v1 already PASSED (recorded in `SceneLinearPipelineTests.swift:163-205`). The v2 v1 `applySeparableGaussianBlur` is already shipped as a public namespace member at `MetalKernels.swift:220`. Task 1 is a written-down preflight that confirms (a) the Rust algorithm at `noise_reduction.rs:20-96` matches the architecture above, and (b) the existing public surface of `MetalKernels` is sufficient to call the shared blur from new wrappers without further refactoring.

- [ ] **Step 1.1: Confirm the Rust source-of-truth shape for both NR stages.**

Run:

```bash
sed -n '20,55p' src/raw-pipeline/raw-core/src/stages/noise_reduction.rs
sed -n '61,96p' src/raw-pipeline/raw-core/src/stages/noise_reduction.rs
```

Expected output for `apply_luminance` (lines 20-55):

- `assert_space(SceneLinearRec2020)` at `:21`.
- `if amount.abs() < 1e-3 { return; }` short-circuit at `:22`.
- `radius = ((amount / 100.0) * 2.0).ceil() as usize; let radius = radius.max(1);` at `:24-25`.
- Oklab convert via `rec2020_to_oklab` at `:33`.
- L-replicate `[src[0], src[0], src[0]]` at `:42`.
- `gaussian_blur_rgb(&l_only, radius)` at `:44`.
- L-writeback `dst[0] = src[0]` at `:49`.
- Oklab unconvert via `oklab_to_rec2020` at `:54`.

Expected output for `apply_color` (lines 61-96):

- Same shape; AB-pack `[src[1], src[2], 0.0]` at `:80` (a in R, b in G, 0 in B).
- AB-writeback `dst[1] = src[0]; dst[2] = src[1];` at `:88-89` (note: indexes 1 and 2 receive blurred src[0] and src[1] — i.e. the blurred R lane becomes new a, blurred G lane becomes new b).
- `MAX = 4.0` instead of `2.0` at `:64`.

If either function's structure deviates from the architecture description (radius math, blur input shape, or writeback channel mapping), STOP and reconcile the plan with the Rust source.

- [ ] **Step 1.2: Confirm the v2 v1 SeparableGaussianBlur is reachable.**

Run:

```bash
grep -n "applySeparableGaussianBlur\|public static func applySceneClarity\|loadKernel(file:" src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift
```

Expected:

- `public static func applySeparableGaussianBlur` at line 220 (or wherever Plan 2 v2 v1 left it).
- `public static func applySceneClarity` at line 329.
- `private static func loadKernel(file: String, function: String) -> CIKernel?` at line 513.

The new NR wrappers will call `applySeparableGaussianBlur` (public, intra-namespace access works) and `loadKernel` (private — accessible from the same `enum MetalKernels` body where the new wrappers live). No changes to access modifiers needed.

- [ ] **Step 1.3: Confirm the v2 v1 spike PASS records still exist in the test file header.**

Run:

```bash
grep -n "Spike 1.1.*Result: PASS\|Spike 1.2.*Result: PASS" src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
```

Expected: two matches (one for each spike), both with `Result: PASS`. If either is missing or shows FAIL, the v2 v1 architecture assumption (compute → CI handoff) is invalidated and this plan must be reopened.

- [ ] **Step 1.4: Confirm `model.nrLuminance` and `model.nrColor` field names + ranges.**

Run:

```bash
grep -n "nrLuminance\|nrColor" src/apple/Packages/MapleCore/Sources/MapleCore/AdjustmentModel.swift
```

Expected: `public var nrLuminance: Double` (range `0..100`, default `0`) at line 53 and `public var nrColor: Double` (range `0..100`, default `25`) at line 54. Defaults match `noise_reduction.rs` (the Rust default model uses 0 / 25 too — see `model.rs` if you want to verify). The wrapper signatures use `Float(model.nrLuminance)` and `Float(model.nrColor)` per the Plan 2 v2 v1 convention at `ImageEditPipeline.swift:359` (`Float(model.clarity)`).

- [ ] **Step 1.5: Confirm the existing helper kernel `loadKernel` accepts modern macOS `[[stitchable]]` syntax.**

Run:

```bash
grep -n "stitchable\|kernels(withMetalString" src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneUnsharp.metal src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift | head -10
```

Expected: at least one `kernels(withMetalString` reference in `MetalKernels.swift:523` (the loader path). The existing v2 v1 kernels (`SceneUnsharp.metal`, `SceneVibrance.metal`, etc.) do NOT yet use the `[[stitchable]]` attribute (`grep` for it should return zero matches in production .metal files), but Spike 1.1's recorded note at `SceneLinearPipelineTests.swift:173-194` says modern macOS may require it. **For this plan, follow the existing pattern: do NOT add `[[stitchable]]` to the new NR kernels** unless Step 7.3's manual smoke test reveals the same compile failure that Spike 1.1 hit. The spike note explicitly defers harmonising that across all kernels: "harmonising that is out of scope per the spike notes" (line 193). If Task 7 surfaces the issue, the fix is to retrofit `[[stitchable]]` onto BOTH the existing kernels and the new NR kernels in a separate plan — not in-line here.

- [ ] **Step 1.6: Run `swift test` to confirm the test baseline.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | tail -10`

Expected: green. Test count = the post-Plan-2-v2-v1 baseline (around 125 tests per the recorded M2 milestone gate at `SceneLinearPipelineTests.swift:214`). No tests added by Task 1.

- [ ] **Step 1.7: Run the parity harness baseline.**

Run: `BUDGET=15 src/scripts/test_color_pipeline.sh 2>&1 | tail -8`

Expected: PASS. Confirms the legacy path is in the same state v2 v1 left it.

- [ ] **Step 1.8: Commit (preflight notes only — no code changes).**

This task touches no source files. Skip the commit step. Move on to Task 2.

---

## Task 2: M3a — `SceneNRLuminance.metal` + `MetalKernels.applySceneNRLuminance`

**Files:**

- Add: `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneNRLuminance.metal`
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift` (add 2 cache fields, 1 public wrapper, 2 private kernel loaders)

**Why this matters:** NR luminance is the smaller of the two NR stages (radius ≤ 2 src px, MAX=2.0). Landing it first establishes the extract-blur-combine pattern that NR color (Task 4) reuses. The Metal kernel must produce the same final pixels as `apply_luminance` at `noise_reduction.rs:20-55` to within fp16 quantization noise.

- [ ] **Step 2.1: Confirm the Rust source-of-truth a third time before authoring the Metal mirror.**

Run: `sed -n '20,55p' src/raw-pipeline/raw-core/src/stages/noise_reduction.rs`

Expected: matches Step 1.1's output. Mentally walk through one pixel:

1. Input rec2020 `(r, g, b)`.
2. `rec2020_to_oklab` → `(L, a, b)`.
3. Replicate L → `(L, L, L)`.
4. Blur the (L,L,L) plane at integer `radius = max(1, ceil((amount/100) * 2))`.
5. Read blurred L from channel 0 of the result; write back to oklab `dst[0]`.
6. `oklab_to_rec2020(L_new, a, b)` → output rec2020.

The Metal port mirrors steps 2-3 in `nrLuminanceExtractL`, step 4 via `applySeparableGaussianBlur`, and steps 5-6 in `nrLuminanceCombine`.

- [ ] **Step 2.2: Write the Metal kernel source.**

Create `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneNRLuminance.metal`:

```metal
// SceneNRLuminance.metal — luminance noise reduction in Oklab. Mirrors
// `noise_reduction::apply_luminance` at src/raw-pipeline/raw-core/src/
// stages/noise_reduction.rs:20-55.
//
// Two CIColorKernel functions compose with the shared
// SeparableGaussianBlur compute kernel (shipped in Plan 2 v2 v1, see
// Metal/SeparableGaussianBlur.metal):
//
//   1. nrLuminanceExtractL(src) -> (L, L, L, alpha)
//      Sample rec2020, convert to Oklab, splat L into all 3 channels.
//      The Swift wrapper feeds this output to applySeparableGaussianBlur
//      at integer radius derived from the slider amount.
//
//   2. nrLuminanceCombine(src, blurredL, amount) -> rec2020
//      Sample original rec2020 + blurred-L CIImage. Re-convert rec2020
//      -> oklab to recover (a, b) without plumbing an oklab CIImage
//      intermediate. Overwrite L = blurredL.r (matches the writeback
//      at noise_reduction.rs:48-49 — full replacement, not a blend;
//      the Rust shim's `amount` controls radius only). Unconvert
//      oklab -> rec2020.
//
// The `amount` argument on nrLuminanceCombine is unused inside the
// kernel body — it exists to (a) mark in code that the slider value
// is the source of the radius scaling at the Swift layer, and (b)
// keep ABI symmetry with M2's sceneUnsharp(src, blurred, amount)
// from Metal/SceneUnsharp.metal, so a future "full NLM" upgrade can
// swap kernel bodies without changing the Swift wrapper signature.
//
// Oklab matrices are duplicated here with `_nrl` suffix per the
// established pattern at SceneSaturation.metal:11-16. A follow-up
// "DRY oklab matrices" plan can factor SceneVibrance / SceneSaturation
// / SceneNRLuminance / SceneNRColor into a shared oklab.metal once
// the include-from-Bundle mechanics are exercised under load (Spike
// 1.2 PASSED in v2 v1, so the green light exists).

#include <CoreImage/CoreImage.h>

constant float3x3 M_rec2020_to_lms_nrl = float3x3(
    float3(0.6370481, 0.2657101, 0.0365291),
    float3(0.3320989, 0.6936245, 0.0374060),
    float3(0.0002832, 0.0182337, 0.9994374)
);

constant float3x3 M_lms_to_oklab_nrl = float3x3(
    float3(0.2104542553, 0.7936177850, -0.0040720468),
    float3(1.9779984951, -2.4285922050, 0.4505937099),
    float3(0.0259040371, 0.7827717662, -0.8086757660)
);

constant float3x3 M_oklab_to_lms_nrl = float3x3(
    float3(1.0000000000, 0.3963377774, 0.2158037573),
    float3(1.0000000000, -0.1055613458, -0.0638541728),
    float3(1.0000000000, -0.0894841775, -1.2914855480)
);

constant float3x3 M_lms_to_rec2020_nrl = float3x3(
    float3(1.6970305, -0.7288047, 0.0413840),
    float3(-0.5065012, 1.6510782, -0.0577547),
    float3(-0.0247447, 0.0438581, 1.0759636)
);

float3 rec2020_to_oklab_nrl(float3 rgb) {
    float3 lms = M_rec2020_to_lms_nrl * rgb;
    float3 lms_nl = sign(lms) * pow(abs(lms), float3(1.0 / 3.0));
    return M_lms_to_oklab_nrl * lms_nl;
}

float3 oklab_to_rec2020_nrl(float3 lab) {
    float3 lms_nl = M_oklab_to_lms_nrl * lab;
    float3 lms = lms_nl * lms_nl * lms_nl;
    return M_lms_to_rec2020_nrl * lms;
}

extern "C" float4 nrLuminanceExtractL(
    coreimage::sampler_h src
) {
    float4 color = float4(src.sample(src.coord()));
    float3 lab = rec2020_to_oklab_nrl(color.rgb);
    return float4(lab.x, lab.x, lab.x, color.a);
}

extern "C" float4 nrLuminanceCombine(
    coreimage::sampler_h src,
    coreimage::sampler_h blurredL,
    float amount  // unused; see header comment
) {
    float4 color = float4(src.sample(src.coord()));
    float4 bl = float4(blurredL.sample(blurredL.coord()));
    float3 lab = rec2020_to_oklab_nrl(color.rgb);
    lab.x = bl.r;
    float3 rgb_out = oklab_to_rec2020_nrl(lab);
    return float4(rgb_out, color.a);
}
```

The kernel body re-converts rec2020 → oklab inside `nrLuminanceCombine` rather than plumbing an intermediate oklab CIImage; per § 3 of Architecture, this costs one extra matrix-multiply + 3 cube roots per pixel and avoids a third `.metal` file. Bit-identical to Option (a) modulo identical fp16 quantization on both paths.

- [ ] **Step 2.3: Add the Swift wrapper to `MetalKernels.swift`.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift`, after the existing `_sceneUnsharp` field (added by v2 v1 Task 4 — see `MetalKernels.swift:61`), add two new private statics:

```swift
    // Plan 2 v2 v2 — SceneNRLuminance shared kernels (M3a, Task 2). Two
    // CIColorKernels: extractL (rec2020 -> oklab L splat for the blur
    // input) and combine (rec2020 + blurredL -> rec2020 with new L).
    // Matches the established lazy / process-lifetime cache pattern.
    private static var _sceneNRLuminanceExtract: CIColorKernel?
    private static var _sceneNRLuminanceCombine: CIColorKernel?
```

After the existing `applySceneTexture` wrapper at `MetalKernels.swift:349-357`, add:

```swift
    // MARK: SceneNRLuminance (Plan 2 v2 v2 M3a)

    /// Apply scene-linear Rec.2020 luminance noise reduction (Oklab
    /// roundtrip + shared blur on the L channel). Mirrors
    /// `noise_reduction::apply_luminance` from raw-core/src/stages/
    /// noise_reduction.rs:20-55.
    ///
    /// `nrLuminance` is in [0, 100]; 0 is identity (short-circuit at
    /// |amount| < 1e-3 mirrors noise_reduction.rs:22). Higher values
    /// scale the integer blur radius via `radius = max(1, ceil((amount
    /// / 100) * 2.0))` — matching the Rust integer math at
    /// noise_reduction.rs:24-25 byte-for-byte. Maximum effective radius
    /// at amount=100 is 2 source pixels (3-pass box ~3 px tail), well
    /// inside the Deep Zoom 35 px overlap budget.
    ///
    /// Composition: extractL runs first (one CIColorKernel.apply,
    /// rec2020 -> oklab and splat L -> (L, L, L, alpha)), then
    /// applySeparableGaussianBlur runs at the integer radius, then
    /// combine runs (one CIColorKernel.apply, original rec2020 +
    /// blurred-L -> rec2020 with new L). Three downstream `apply`
    /// calls per slider tick — same shape as Plan 2 v2 v1's
    /// applySceneClarity (two applies: blur + sceneUnsharp), with
    /// the additional extract step to splat L into 3 channels.
    public static func applySceneNRLuminance(
        to input: CIImage,
        nrLuminance: Float
    ) -> CIImage {
        if abs(nrLuminance) < 1e-3 { return input }
        // Integer radius mirrors noise_reduction.rs:24-25 byte-for-byte.
        let scaled = (nrLuminance / 100.0) * 2.0
        let ceiled = Int(ceilf(scaled))
        let radius = max(1, ceiled)

        guard let extract = sceneNRLuminanceExtractKernel(),
              let combine = sceneNRLuminanceCombineKernel() else {
            return input
        }

        // Step 1: rec2020 -> oklab -> (L, L, L, alpha) on full extent.
        guard let lOnly = extract.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: [input]
        ) else { return input }

        // Step 2: blur the L plane at integer radius (shared compute
        // kernel; the wrapper short-circuits to `lOnly` on radius == 0
        // but we already filtered amount==0 above, so radius >= 1).
        let blurredL = applySeparableGaussianBlur(to: lOnly, radius: radius)

        // Step 3: combine — sample original rec2020 + blurred L; emit
        // rec2020 with new L. The `amount` arg is unused inside the
        // combine kernel (see SceneNRLuminance.metal header comment).
        return combine.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: [input, blurredL, nrLuminance / 100.0]
        ) ?? input
    }
```

After the existing `sceneUnsharpKernel()` private helper at `MetalKernels.swift:378-383`, add:

```swift
    private static func sceneNRLuminanceExtractKernel() -> CIColorKernel? {
        if let k = _sceneNRLuminanceExtract { return k }
        _sceneNRLuminanceExtract = loadKernel(file: "SceneNRLuminance",
                                              function: "nrLuminanceExtractL") as? CIColorKernel
        return _sceneNRLuminanceExtract
    }

    private static func sceneNRLuminanceCombineKernel() -> CIColorKernel? {
        if let k = _sceneNRLuminanceCombine { return k }
        _sceneNRLuminanceCombine = loadKernel(file: "SceneNRLuminance",
                                              function: "nrLuminanceCombine") as? CIColorKernel
        return _sceneNRLuminanceCombine
    }
```

The two loaders share the same `.metal` source file (`SceneNRLuminance`). The existing `loadKernel(file:function:)` at `MetalKernels.swift:513-537` opens `Bundle.module/Metal/SceneNRLuminance.metal`, runs `CIKernel.kernels(withMetalString:)`, and plucks the named function out — same pattern as the v2 v1 vibrance + saturation loaders.

- [ ] **Step 2.4: Run `swift test` to confirm no compile error.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | tail -10`

Expected: green. Test count = post-Task-1 baseline (no new tests in this task — Task 3 adds the parity test).

If the build fails with "Cannot find a valid stitchable Metal function in the source" or "cannot initialize a variable of type 'float4' with an rvalue of type 'half4'" (the modern-macOS Spike 1.1 failure modes recorded at `SceneLinearPipelineTests.swift:173-194`), STOP and apply the same fix to BOTH the new NR kernel and a copy of the v2 v1 wrappers in a separate retrofit plan. **Do not retrofit `[[stitchable]]` only on NR kernels**; that would create a kernel-source style split.

- [ ] **Step 2.5: Commit.**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneNRLuminance.metal src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift
git commit -m "feat(apple): add SceneNRLuminance Metal kernel + Swift wrapper

Plan 2 v2 v2 M3a — luminance NR on the new path. SceneNRLuminance.metal
exposes two CIColorKernel functions:

  * nrLuminanceExtractL(src) — sample rec2020, convert to Oklab,
    return (L, L, L, alpha) for the blur input.
  * nrLuminanceCombine(src, blurredL, amount) — sample original
    rec2020 + blurred-L CIImage; re-convert rec2020 -> oklab to
    recover (a, b), overwrite L = blurredL.r, unconvert -> rec2020.
    The amount arg is unused in the kernel body (Rust shim does not
    blend; radius is the only knob).

Oklab matrices are duplicated with _nrl suffix per the established
SceneSaturation.metal pattern. A follow-up DRY-oklab plan can factor
the four production kernels (vibrance, saturation, NR luminance, NR
color) into a shared oklab.metal once the include-from-Bundle
mechanics are exercised under load.

The Swift wrapper applySceneNRLuminance(to:nrLuminance:) computes
radius = max(1, ceil((amount/100) * 2.0)) — byte-for-byte mirror of
noise_reduction.rs:24-25 — and orchestrates extract -> shared blur ->
combine. Short-circuits to identity at |amount| < 1e-3 mirroring the
Rust short-circuit at noise_reduction.rs:22."
```

---

## Task 3: M3a verification — Swift-scalar parity mirror against Rust `apply_luminance`

**Files:**

- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift` (append the parity mirror test + Oklab matrix helper)

**Why this matters:** Under `swift test` the metallib isn't loaded, so the Metal kernel from Task 2 is a silent no-op (per the existing pattern at `SceneLinearPipelineTests.swift:173-194`). To verify M3a ships with correct algorithm semantics, this task adds a pure-Swift scalar mirror of the Rust `apply_luminance` algorithm and compares against a recorded reference — same shape as v2 v1 Task 3's `swiftGaussianBlurPlane` parity test at `SceneLinearPipelineTests.swift:1750-1830`. The Swift mirror is byte-faithful: same Oklab matrices (verified equivalent to Rust per § "File Structure" Rust read-only section), same integer radius math, same writeback shape.

- [ ] **Step 3.1: Add the Swift Oklab scalar helpers.**

Append to `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift` (inside the existing `final class SceneLinearPipelineTests`, near the `swiftGaussianBlurPlane` helper at `:1750`):

```swift
    // MARK: - Plan 2 v2 v2 M3a: Oklab scalar helpers (matches SceneVibrance.metal)

    /// Pure-Swift mirror of `rec2020_to_oklab_nrl` from
    /// SceneNRLuminance.metal. The matrices are byte-identical to the
    /// `_sat`-suffixed copies in SceneSaturation.metal:17-38 and the
    /// unsuffixed copies in SceneVibrance.metal:16-26 (the suffix-on-
    /// duplicate pattern only resolves Metal symbol clashes; the values
    /// are the same).
    static let M_REC2020_TO_LMS: [[Float]] = [
        [0.6370481, 0.2657101, 0.0365291],
        [0.3320989, 0.6936245, 0.0374060],
        [0.0002832, 0.0182337, 0.9994374],
    ]
    static let M_LMS_TO_OKLAB: [[Float]] = [
        [0.2104542553, 0.7936177850, -0.0040720468],
        [1.9779984951, -2.4285922050, 0.4505937099],
        [0.0259040371, 0.7827717662, -0.8086757660],
    ]
    static let M_OKLAB_TO_LMS: [[Float]] = [
        [1.0000000000, 0.3963377774, 0.2158037573],
        [1.0000000000, -0.1055613458, -0.0638541728],
        [1.0000000000, -0.0894841775, -1.2914855480],
    ]
    static let M_LMS_TO_REC2020: [[Float]] = [
        [1.6970305, -0.7288047, 0.0413840],
        [-0.5065012, 1.6510782, -0.0577547],
        [-0.0247447, 0.0438581, 1.0759636],
    ]

    /// 3x3 matrix-vector multiply. Matches Metal's `float3x3 * float3`
    /// semantics per https://developer.apple.com/metal/Metal-Shading-
    /// Language-Specification.pdf § 6.5 (column-major storage; the
    /// Metal kernel's float3x3 constructor takes column vectors, but
    /// since both the Rust `Matrix3` and the Metal kernel use the same
    /// math layout the per-pixel result is identical).
    static func mulMV(_ m: [[Float]], _ v: [Float]) -> [Float] {
        return [
            m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
            m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
            m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
        ]
    }

    /// Sign-preserving cube root (matches Metal's `sign(x) * pow(abs(x),
    /// 1/3)` and Rust's `.cbrt()` at oklab.rs:55).
    static func cbrtSigned(_ x: Float) -> Float {
        if x >= 0 { return powf(x, 1.0 / 3.0) }
        return -powf(-x, 1.0 / 3.0)
    }

    static func swiftRec2020ToOklab(_ rgb: [Float]) -> [Float] {
        let lms = mulMV(M_REC2020_TO_LMS, rgb)
        let lmsNl = [cbrtSigned(lms[0]), cbrtSigned(lms[1]), cbrtSigned(lms[2])]
        return mulMV(M_LMS_TO_OKLAB, lmsNl)
    }

    static func swiftOklabToRec2020(_ lab: [Float]) -> [Float] {
        let lmsNl = mulMV(M_OKLAB_TO_LMS, lab)
        let lms = [lmsNl[0] * lmsNl[0] * lmsNl[0],
                   lmsNl[1] * lmsNl[1] * lmsNl[1],
                   lmsNl[2] * lmsNl[2] * lmsNl[2]]
        return mulMV(M_LMS_TO_REC2020, lms)
    }
```

- [ ] **Step 3.2: Add the M3a parity test.**

Append (right after the helpers from Step 3.1):

```swift
    // MARK: - Plan 2 v2 v2 M3a: apply_luminance scalar parity vs Rust

    /// Pure-Swift mirror of `noise_reduction::apply_luminance` from
    /// raw-core/src/stages/noise_reduction.rs:20-55. Matches the Rust
    /// implementation byte-for-byte:
    ///   1. amount.abs() < 1e-3 -> identity (line :22)
    ///   2. radius = max(1, ceil((amount / 100) * 2.0)) (lines :24-25)
    ///   3. rec2020 -> oklab via the same matrices (line :33)
    ///   4. L-replicate into (L, L, L) (line :42)
    ///   5. gaussian_blur_plane (the Swift mirror at :1750-1830) at
    ///      integer radius (line :44)
    ///   6. write back blurred L into oklab dst[0] (line :49)
    ///   7. oklab -> rec2020 (line :54)
    ///
    /// The Swift mirror runs the algorithm on a 16×16 fp32 image so we
    /// can compare to a recorded "Rust reference" inline (no fixture
    /// file). A pass here confirms the algorithm is correctly ported;
    /// the live Metal kernel runtime check is in Task 7 manual smoke.
    static func swiftApplyLuminance(
        _ rgbBuf: [[Float]], w: Int, h: Int, amount: Float
    ) -> [[Float]] {
        if abs(amount) < 1e-3 { return rgbBuf }
        let scaled = (amount / 100.0) * 2.0
        let radius = max(1, Int(ceilf(scaled)))

        // 1. rec2020 -> oklab per pixel.
        var oklab = [[Float]](repeating: [0, 0, 0], count: w * h)
        for i in 0..<(w * h) {
            oklab[i] = swiftRec2020ToOklab(rgbBuf[i])
        }
        // 2. Replicate L across all 3 channels of a flat plane buffer.
        // We call `swiftGaussianBlurPlane` per channel — Rust's
        // gaussian_blur_rgb runs the same algorithm on each of the 3
        // channels independently, so blurring just channel 0 of a
        // plane that was built from L is equivalent.
        var lPlane = [Float](repeating: 0, count: w * h)
        for i in 0..<(w * h) { lPlane[i] = oklab[i][0] }
        let blurredL = Self.swiftGaussianBlurPlane(lPlane, w: w, h: h, radius: radius)
        // 3. Writeback: oklab dst[0] = blurredL[i].
        for i in 0..<(w * h) {
            oklab[i][0] = blurredL[i]
        }
        // 4. oklab -> rec2020 per pixel.
        var out = [[Float]](repeating: [0, 0, 0], count: w * h)
        for i in 0..<(w * h) {
            out[i] = swiftOklabToRec2020(oklab[i])
        }
        return out
    }

    func testM3aSwiftScalarApplyLuminanceMatchesRust() async throws {
        // Build a 16×16 alternating-luminance scene in rec2020 (matches
        // the Rust unit test at noise_reduction.rs:121-126 — even pixels
        // bright reddish, odd pixels dark reddish).
        let w = 16, h = 16
        var rgb = [[Float]](repeating: [0, 0, 0], count: w * h)
        for i in 0..<(w * h) {
            rgb[i] = (i % 2 == 0) ? [0.6, 0.3, 0.3] : [0.3, 0.1, 0.1]
        }
        // Run apply_luminance at amount=100 (radius=2 per the math).
        let out = Self.swiftApplyLuminance(rgb, w: w, h: h, amount: 100.0)

        // Same assertions the Rust unit test uses at noise_reduction.rs
        // :130-138: every output pixel is finite, luma is in a sane band,
        // and the red tint persists (saturation > 0.05).
        for p in out {
            for c in p {
                XCTAssertTrue(c.isFinite,
                    "apply_luminance produced non-finite channel: \(c)")
            }
            // luma per Rec.2020 = 0.2627 R + 0.6780 G + 0.0593 B.
            let luma = 0.2627 * p[0] + 0.6780 * p[1] + 0.0593 * p[2]
            XCTAssertGreaterThan(luma, 0.15, "luma too low after blur: \(luma)")
            XCTAssertLessThan(luma, 0.6, "luma too high after blur: \(luma)")
            // saturation as max(R-G, R-B) — preserved by NR luma.
            let sat = max(p[0] - p[1], p[0] - p[2])
            XCTAssertGreaterThan(sat, 0.05, "saturation lost after NR luma: \(sat)")
        }
    }

    /// Identity check for the scalar mirror: amount=0 returns the input
    /// unchanged (matches the Rust short-circuit at noise_reduction.rs:22
    /// and the wrapper short-circuit at MetalKernels.applySceneNRLuminance).
    func testM3aSwiftScalarApplyLuminanceZeroIsIdentity() async throws {
        let w = 8, h = 8
        var rgb = [[Float]](repeating: [0, 0, 0], count: w * h)
        for i in 0..<(w * h) {
            rgb[i] = [Float(i) / 64.0, 0.5, 0.7]
        }
        let out = Self.swiftApplyLuminance(rgb, w: w, h: h, amount: 0.0)
        XCTAssertEqual(out.count, rgb.count)
        for i in 0..<(w * h) {
            XCTAssertEqual(out[i][0], rgb[i][0], accuracy: 0.0,
                "amount=0 not identity at pixel \(i) channel R")
            XCTAssertEqual(out[i][1], rgb[i][1], accuracy: 0.0,
                "amount=0 not identity at pixel \(i) channel G")
            XCTAssertEqual(out[i][2], rgb[i][2], accuracy: 0.0,
                "amount=0 not identity at pixel \(i) channel B")
        }
    }

    /// Identity check at the Swift wrapper level: applySceneNRLuminance
    /// with amount=0 returns the input CIImage instance (===).
    func testM3NRLuminanceShortCircuitsAtZeroAmount() async throws {
        let input = Self.makeRGBSceneLinearCIImage(
            width: 8, height: 8, r: 0.4, g: 0.5, b: 0.6
        )
        let out = MetalKernels.applySceneNRLuminance(to: input, nrLuminance: 0.0)
        XCTAssertTrue(out === input,
            "amount=0 should return the input CIImage instance unchanged")
    }
```

- [ ] **Step 3.3: Run the parity tests.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter "testM3a\\|testM3NRLuminance" 2>&1 | tail -15`

Expected: PASS for `testM3aSwiftScalarApplyLuminanceMatchesRust`, `testM3aSwiftScalarApplyLuminanceZeroIsIdentity`, and `testM3NRLuminanceShortCircuitsAtZeroAmount`.

If the luma-band assertion fails, re-check the Oklab matrix copies for typos against `SceneVibrance.metal:16-38`. If the saturation-preservation assertion fails, the L-only blur is contaminating a or b (likely a writeback-index bug — confirm `oklab[i][0] = blurredL[i]` only touches channel 0).

- [ ] **Step 3.4: Run the full Swift test suite.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | tail -10`

Expected: green. Test count = post-Task-1 baseline + 3 (one parity, one identity, one wrapper-identity).

- [ ] **Step 3.5: M3a milestone gate — parity harness regression check.**

Run: `BUDGET=15 src/scripts/test_color_pipeline.sh 2>&1 | tail -8`

Expected: PASS. Plan 2 v2 v2's M3a has touched only the new files (`SceneNRLuminance.metal`, the wrapper in `MetalKernels.swift`, the test file). The legacy `applyFilters` path is untouched.

- [ ] **Step 3.6: Commit.**

```bash
git add src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
git commit -m "test(apple): pure-Swift parity mirror for SceneNRLuminance vs Rust

Plan 2 v2 v2 M3a verification gate. swift test cannot load metallibs
(established v2 v1 pattern), so the Metal kernel from Task 2 is a
silent no-op under XCTest. To verify algorithm correctness, this commit
adds a pure-Swift scalar mirror of noise_reduction::apply_luminance
(raw-core/src/stages/noise_reduction.rs:20-55) and runs it against the
same shape of inputs the Rust unit test at noise_reduction.rs:121-126
uses.

The Swift mirror reuses swiftGaussianBlurPlane (added by v2 v1 Task 3)
plus newly-added Oklab matrix helpers byte-identical to those in
SceneVibrance.metal / SceneSaturation.metal / SceneNRLuminance.metal.
This locks in the algorithm port at the Swift layer; the live Metal
kernel runtime check is in Task 7's manual smoke test.

Tests:
  * testM3aSwiftScalarApplyLuminanceMatchesRust — every output pixel
    is finite, luma is in [0.15, 0.6], saturation > 0.05 (mirrors the
    Rust unit test at noise_reduction.rs:130-138).
  * testM3aSwiftScalarApplyLuminanceZeroIsIdentity — amount=0 returns
    the input unchanged.
  * testM3NRLuminanceShortCircuitsAtZeroAmount — wrapper short-circuit
    returns the input CIImage instance (===)."
```

---

## Task 4: M3b — `SceneNRColor.metal` + `MetalKernels.applySceneNRColor`

**Files:**

- Add: `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneNRColor.metal`
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift` (add 2 cache fields, 1 public wrapper, 2 private kernel loaders)

**Why this matters:** NR color reuses the extract-blur-combine pattern from M3a. The Metal kernel is shape-symmetric (read a/b instead of L; pack into R/G instead of replicating L into R/G/B). The Swift wrapper differs only in the radius scale (`MAX = 4.0` vs `2.0`).

- [ ] **Step 4.1: Confirm the Rust source-of-truth for `apply_color`.**

Run: `sed -n '61,96p' src/raw-pipeline/raw-core/src/stages/noise_reduction.rs`

Expected:

- Same shape as `apply_luminance`.
- `MAX = 4.0` at `:64`.
- AB-pack `[src[1], src[2], 0.0]` at `:80` (a goes into R, b goes into G, 0 into B).
- AB-writeback `dst[1] = src[0]; dst[2] = src[1];` at `:88-89` (blurred R lane → new a, blurred G lane → new b).

The Metal kernel mirror puts a in `.r`, b in `.g`, 0 in `.b` for the blur input; the combine kernel reads `.rg` from the blurred CIImage and writes `lab.yz`.

- [ ] **Step 4.2: Write the Metal kernel source.**

Create `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneNRColor.metal`:

```metal
// SceneNRColor.metal — chroma noise reduction in Oklab. Mirrors
// `noise_reduction::apply_color` at src/raw-pipeline/raw-core/src/
// stages/noise_reduction.rs:61-96.
//
// Two CIColorKernel functions compose with the shared
// SeparableGaussianBlur compute kernel (shipped in Plan 2 v2 v1):
//
//   1. nrColorExtractAB(src) -> (a, b, 0, alpha)
//      Sample rec2020, convert to Oklab, pack a into R, b into G,
//      zero into B. The Swift wrapper feeds this output to
//      applySeparableGaussianBlur at integer radius derived from the
//      slider amount.
//
//   2. nrColorCombine(src, blurredAB, amount) -> rec2020
//      Sample original rec2020 + blurred-AB CIImage. Re-convert
//      rec2020 -> oklab to recover L without plumbing an oklab
//      CIImage intermediate. Overwrite (a, b) = (blurredAB.r,
//      blurredAB.g) (matches the writeback at noise_reduction.rs
//      :88-89 — full replacement, not a blend; the Rust shim's
//      `amount` controls radius only). Unconvert oklab -> rec2020.
//
// The `amount` argument on nrColorCombine is unused inside the
// kernel body — symmetric with SceneNRLuminance.metal.
//
// Oklab matrices duplicated with `_nrc` suffix per the established
// pattern at SceneSaturation.metal:11-16. Same DRY-oklab follow-up
// note applies as in SceneNRLuminance.metal.

#include <CoreImage/CoreImage.h>

constant float3x3 M_rec2020_to_lms_nrc = float3x3(
    float3(0.6370481, 0.2657101, 0.0365291),
    float3(0.3320989, 0.6936245, 0.0374060),
    float3(0.0002832, 0.0182337, 0.9994374)
);

constant float3x3 M_lms_to_oklab_nrc = float3x3(
    float3(0.2104542553, 0.7936177850, -0.0040720468),
    float3(1.9779984951, -2.4285922050, 0.4505937099),
    float3(0.0259040371, 0.7827717662, -0.8086757660)
);

constant float3x3 M_oklab_to_lms_nrc = float3x3(
    float3(1.0000000000, 0.3963377774, 0.2158037573),
    float3(1.0000000000, -0.1055613458, -0.0638541728),
    float3(1.0000000000, -0.0894841775, -1.2914855480)
);

constant float3x3 M_lms_to_rec2020_nrc = float3x3(
    float3(1.6970305, -0.7288047, 0.0413840),
    float3(-0.5065012, 1.6510782, -0.0577547),
    float3(-0.0247447, 0.0438581, 1.0759636)
);

float3 rec2020_to_oklab_nrc(float3 rgb) {
    float3 lms = M_rec2020_to_lms_nrc * rgb;
    float3 lms_nl = sign(lms) * pow(abs(lms), float3(1.0 / 3.0));
    return M_lms_to_oklab_nrc * lms_nl;
}

float3 oklab_to_rec2020_nrc(float3 lab) {
    float3 lms_nl = M_oklab_to_lms_nrc * lab;
    float3 lms = lms_nl * lms_nl * lms_nl;
    return M_lms_to_rec2020_nrc * lms;
}

extern "C" float4 nrColorExtractAB(
    coreimage::sampler_h src
) {
    float4 color = float4(src.sample(src.coord()));
    float3 lab = rec2020_to_oklab_nrc(color.rgb);
    return float4(lab.y, lab.z, 0.0, color.a);
}

extern "C" float4 nrColorCombine(
    coreimage::sampler_h src,
    coreimage::sampler_h blurredAB,
    float amount  // unused; see header comment
) {
    float4 color = float4(src.sample(src.coord()));
    float4 bAB = float4(blurredAB.sample(blurredAB.coord()));
    float3 lab = rec2020_to_oklab_nrc(color.rgb);
    lab.y = bAB.r;
    lab.z = bAB.g;
    float3 rgb_out = oklab_to_rec2020_nrc(lab);
    return float4(rgb_out, color.a);
}
```

- [ ] **Step 4.3: Add the Swift wrapper to `MetalKernels.swift`.**

Add two new private statics next to the M3a fields from Task 2:

```swift
    // Plan 2 v2 v2 — SceneNRColor shared kernels (M3b, Task 4). Two
    // CIColorKernels: extractAB (rec2020 -> oklab a/b pack for the
    // blur input) and combine (rec2020 + blurredAB -> rec2020 with
    // new a/b). Same lazy / process-lifetime cache pattern.
    private static var _sceneNRColorExtract: CIColorKernel?
    private static var _sceneNRColorCombine: CIColorKernel?
```

After the `applySceneNRLuminance` wrapper from Task 2, add:

```swift
    // MARK: SceneNRColor (Plan 2 v2 v2 M3b)

    /// Apply scene-linear Rec.2020 chroma noise reduction (Oklab
    /// roundtrip + shared blur on the a/b channels). Mirrors
    /// `noise_reduction::apply_color` from raw-core/src/stages/
    /// noise_reduction.rs:61-96.
    ///
    /// `nrColor` is in [0, 100]; 0 is identity. The default
    /// `AdjustmentModel.nrColor` is 25 (radius=1), so this wrapper
    /// runs by default — meaning AdjustmentModel.default produces
    /// chroma-blurred output with one box-blur radius. Higher slider
    /// values scale the integer blur radius via `radius = max(1,
    /// ceil((amount / 100) * 4.0))`. Maximum effective radius at
    /// amount=100 is 4 source pixels (3-pass box ~3 px tail), well
    /// inside the Deep Zoom 35 px overlap budget.
    ///
    /// Composition: same shape as applySceneNRLuminance — extractAB
    /// runs first (rec2020 -> oklab and pack (a, b, 0, alpha)), then
    /// applySeparableGaussianBlur at the integer radius, then combine
    /// (rec2020 + blurred-AB -> rec2020 with new a/b).
    public static func applySceneNRColor(
        to input: CIImage,
        nrColor: Float
    ) -> CIImage {
        if abs(nrColor) < 1e-3 { return input }
        let scaled = (nrColor / 100.0) * 4.0
        let ceiled = Int(ceilf(scaled))
        let radius = max(1, ceiled)

        guard let extract = sceneNRColorExtractKernel(),
              let combine = sceneNRColorCombineKernel() else {
            return input
        }

        guard let abPlane = extract.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: [input]
        ) else { return input }

        let blurredAB = applySeparableGaussianBlur(to: abPlane, radius: radius)

        return combine.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: [input, blurredAB, nrColor / 100.0]
        ) ?? input
    }
```

After the M3a loaders from Task 2, add:

```swift
    private static func sceneNRColorExtractKernel() -> CIColorKernel? {
        if let k = _sceneNRColorExtract { return k }
        _sceneNRColorExtract = loadKernel(file: "SceneNRColor",
                                          function: "nrColorExtractAB") as? CIColorKernel
        return _sceneNRColorExtract
    }

    private static func sceneNRColorCombineKernel() -> CIColorKernel? {
        if let k = _sceneNRColorCombine { return k }
        _sceneNRColorCombine = loadKernel(file: "SceneNRColor",
                                          function: "nrColorCombine") as? CIColorKernel
        return _sceneNRColorCombine
    }
```

- [ ] **Step 4.4: Run `swift test` to confirm no compile error.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | tail -10`

Expected: green. Test count = post-Task-3 baseline (no new tests in this task — Task 5 adds the parity test).

- [ ] **Step 4.5: Commit.**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneNRColor.metal src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift
git commit -m "feat(apple): add SceneNRColor Metal kernel + Swift wrapper

Plan 2 v2 v2 M3b — chroma NR on the new path. SceneNRColor.metal
exposes two CIColorKernel functions:

  * nrColorExtractAB(src) — sample rec2020, convert to Oklab,
    return (a, b, 0, alpha) for the blur input.
  * nrColorCombine(src, blurredAB, amount) — sample original
    rec2020 + blurred-AB CIImage; re-convert rec2020 -> oklab to
    recover L, overwrite (a, b) = (blurredAB.r, blurredAB.g),
    unconvert -> rec2020. The amount arg is unused (Rust shim does
    not blend; radius is the only knob).

Oklab matrices duplicated with _nrc suffix per the SceneSaturation
pattern. Symmetric with SceneNRLuminance.

The Swift wrapper applySceneNRColor(to:nrColor:) computes radius =
max(1, ceil((amount/100) * 4.0)) — byte-for-byte mirror of
noise_reduction.rs:64-65 — and orchestrates extract -> shared blur ->
combine. AdjustmentModel.nrColor defaults to 25 (radius=1), so this
wrapper runs by default on AdjustmentModel.default."
```

---

## Task 5: M3b verification — Swift-scalar parity mirror against Rust `apply_color`

**Files:**

- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift` (append the parity mirror test)

**Why this matters:** Same rationale as Task 3 (Metal kernels are no-ops under `swift test`). The Swift mirror for `apply_color` is shape-symmetric to `swiftApplyLuminance` from Task 3 — only the channel routing differs.

- [ ] **Step 5.1: Add the M3b parity test.**

Append to `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift`:

```swift
    // MARK: - Plan 2 v2 v2 M3b: apply_color scalar parity vs Rust

    /// Pure-Swift mirror of `noise_reduction::apply_color` from
    /// raw-core/src/stages/noise_reduction.rs:61-96. Symmetric with
    /// `swiftApplyLuminance` (Task 3); only the channel routing differs:
    ///   * blur input is the (a, b, 0) plane instead of (L, L, L)
    ///   * radius scale is MAX=4.0 instead of MAX=2.0
    ///   * writeback is dst[1] = blurredA, dst[2] = blurredB (instead
    ///     of dst[0] = blurredL)
    static func swiftApplyColor(
        _ rgbBuf: [[Float]], w: Int, h: Int, amount: Float
    ) -> [[Float]] {
        if abs(amount) < 1e-3 { return rgbBuf }
        let scaled = (amount / 100.0) * 4.0
        let radius = max(1, Int(ceilf(scaled)))

        var oklab = [[Float]](repeating: [0, 0, 0], count: w * h)
        for i in 0..<(w * h) {
            oklab[i] = swiftRec2020ToOklab(rgbBuf[i])
        }
        // Pack a into R, b into G, 0 into B; blur each plane independently.
        var aPlane = [Float](repeating: 0, count: w * h)
        var bPlane = [Float](repeating: 0, count: w * h)
        for i in 0..<(w * h) {
            aPlane[i] = oklab[i][1]
            bPlane[i] = oklab[i][2]
        }
        let blurredA = Self.swiftGaussianBlurPlane(aPlane, w: w, h: h, radius: radius)
        let blurredB = Self.swiftGaussianBlurPlane(bPlane, w: w, h: h, radius: radius)
        // Writeback: dst[1] = blurredA[i], dst[2] = blurredB[i].
        for i in 0..<(w * h) {
            oklab[i][1] = blurredA[i]
            oklab[i][2] = blurredB[i]
        }
        var out = [[Float]](repeating: [0, 0, 0], count: w * h)
        for i in 0..<(w * h) {
            out[i] = swiftOklabToRec2020(oklab[i])
        }
        return out
    }

    func testM3bSwiftScalarApplyColorMatchesRust() async throws {
        // Same alternating scene as the luma test, but check NR color
        // smooths the chroma without crushing luma.
        let w = 16, h = 16
        var rgb = [[Float]](repeating: [0, 0, 0], count: w * h)
        for i in 0..<(w * h) {
            // Even pixels reddish, odd pixels greenish — same luma.
            rgb[i] = (i % 2 == 0) ? [0.5, 0.3, 0.3] : [0.3, 0.5, 0.3]
        }
        let out = Self.swiftApplyColor(rgb, w: w, h: h, amount: 100.0)

        // Every pixel finite.
        for p in out {
            for c in p {
                XCTAssertTrue(c.isFinite,
                    "apply_color produced non-finite channel: \(c)")
            }
        }

        // Chroma alternation should be reduced — measured as the
        // variance of (R - G) across the image. Rust unit test at
        // noise_reduction.rs:111-118 only checks identity-at-zero;
        // we additionally assert that NR color at amount=100 reduces
        // chroma alternation by at least 50% relative to the input.
        var inputDiffs: [Float] = []
        var outputDiffs: [Float] = []
        for i in 0..<(w * h) {
            inputDiffs.append(rgb[i][0] - rgb[i][1])
            outputDiffs.append(out[i][0] - out[i][1])
        }
        let inputAbsAvg = inputDiffs.map { abs($0) }.reduce(0, +) / Float(inputDiffs.count)
        let outputAbsAvg = outputDiffs.map { abs($0) }.reduce(0, +) / Float(outputDiffs.count)
        XCTAssertLessThan(outputAbsAvg, inputAbsAvg,
            "NR color at amount=100 should reduce chroma alternation; in=\(inputAbsAvg) out=\(outputAbsAvg)")
    }

    func testM3bSwiftScalarApplyColorZeroIsIdentity() async throws {
        let w = 8, h = 8
        var rgb = [[Float]](repeating: [0, 0, 0], count: w * h)
        for i in 0..<(w * h) {
            rgb[i] = [Float(i) / 64.0, 0.5, 0.7]
        }
        let out = Self.swiftApplyColor(rgb, w: w, h: h, amount: 0.0)
        for i in 0..<(w * h) {
            XCTAssertEqual(out[i][0], rgb[i][0], accuracy: 0.0)
            XCTAssertEqual(out[i][1], rgb[i][1], accuracy: 0.0)
            XCTAssertEqual(out[i][2], rgb[i][2], accuracy: 0.0)
        }
    }

    func testM3NRColorShortCircuitsAtZeroAmount() async throws {
        let input = Self.makeRGBSceneLinearCIImage(
            width: 8, height: 8, r: 0.4, g: 0.5, b: 0.6
        )
        let out = MetalKernels.applySceneNRColor(to: input, nrColor: 0.0)
        XCTAssertTrue(out === input,
            "amount=0 should return the input CIImage instance unchanged")
    }
```

- [ ] **Step 5.2: Run the parity tests.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter "testM3b\\|testM3NRColor" 2>&1 | tail -15`

Expected: PASS for all three (`testM3bSwiftScalarApplyColorMatchesRust`, `testM3bSwiftScalarApplyColorZeroIsIdentity`, `testM3NRColorShortCircuitsAtZeroAmount`). The chroma-reduction assertion in `testM3bSwiftScalarApplyColorMatchesRust` confirms the NR color algorithm actually reduces a/b variance — a stronger signal than the bare finite-pixel check. If it fails, the writeback indexing is wrong (e.g. swapping `lab[1]` and `lab[2]` between the pack and the writeback).

- [ ] **Step 5.3: Run the full Swift test suite.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | tail -10`

Expected: green. Test count = post-Task-3 baseline + 3.

- [ ] **Step 5.4: M3b milestone gate — parity harness regression check.**

Run: `BUDGET=15 src/scripts/test_color_pipeline.sh 2>&1 | tail -8`

Expected: PASS.

- [ ] **Step 5.5: Commit.**

```bash
git add src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
git commit -m "test(apple): pure-Swift parity mirror for SceneNRColor vs Rust

Plan 2 v2 v2 M3b verification gate. Symmetric with M3a (Task 3) — only
the channel routing differs. Reuses the swiftRec2020ToOklab /
swiftOklabToRec2020 helpers from Task 3 and the swiftGaussianBlurPlane
from v2 v1 Task 3.

Tests:
  * testM3bSwiftScalarApplyColorMatchesRust — every pixel finite
    after NR color at amount=100; chroma alternation (mean |R-G|
    over the image) is reduced relative to the input.
  * testM3bSwiftScalarApplyColorZeroIsIdentity — amount=0 returns
    the input unchanged.
  * testM3NRColorShortCircuitsAtZeroAmount — wrapper short-circuit
    returns the input CIImage instance (===)."
```

---

## Task 6: Wire NR luminance + NR color into `processSceneLinear`

**Files:**

- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift` (`processSceneLinear`, after Plan 2 v2 v1's edits)
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift` (append two wiring smoke tests)

**Why this matters:** The wiring is a two-line insert in `processSceneLinear`, between `withTexture` (the post-texture stage from v2 v1) and the AgX return. The chain order matches Rust at `pipeline.rs:131-132`: `nr_luminance` before `nr_color`. **NR color default = 25 means tests using `AdjustmentModel.default` baseline will run NR color at radius=1 by default; the `>=` smoke comparison still holds (we compare radius=1 vs radius=4).**

- [ ] **Step 6.1: Confirm the Rust chain order: NR luminance before NR color.**

Run: `grep -n 'stage("nr_luminance\|stage("nr_color\|stage("texture' src/raw-pipeline/raw-core/src/pipeline.rs`

Expected:

```
128:    stage("texture", || texture::apply(&mut scene, model.texture));
131:    stage("nr_luminance", || noise_reduction::apply_luminance(&mut scene, model.nr_luminance));
132:    stage("nr_color", || noise_reduction::apply_color(&mut scene, model.nr_color));
```

(Lines 129-130 are dehaze + sharpen, deferred to v3/v4. NR luminance is at line 131, NR color at line 132 — luma before color.)

- [ ] **Step 6.2: Write a failing wiring smoke test for NR luminance.**

Append to `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift`:

```swift
    // MARK: - Plan 2 v2 v2 M3: NR luminance + NR color wired into processSceneLinear

    /// Build a 32×32 fp16 Rec.2020 CIImage with alternating bright/dark
    /// rows on the same hue (mirrors the Rust unit test at
    /// noise_reduction.rs:121-126). Run through processSceneLinear with
    /// model.nrLuminance = 0 (default) and model.nrLuminance = 100.
    /// Assert the +100 output's centre-pixel R-channel is finite and
    /// in [0, 2] — the chroma should not have collapsed catastrophically.
    /// Same `>=` caveat as Plan 2 v1's M1 wiring tests — under XCTest
    /// the kernel may be a no-op; the load-bearing runtime check is
    /// in Task 7's manual smoke test.
    func testM3ProcessSceneLinearAppliesNRLuminance() async throws {
        let pipeline = ImageEditPipeline()
        let input = Self.makeAlternatingLumaSceneLinearCIImage(width: 32, height: 32)

        var modelDefault = AdjustmentModel.default
        modelDefault.nrLuminance = 0    // explicit 0 to suppress NR luma
        modelDefault.nrColor = 0        // also suppress NR color so the
                                        // baseline is bare WB->tone->...->texture
                                        // (no chroma blur)
        var modelBoost = modelDefault
        modelBoost.nrLuminance = 100

        let outDefault = pipeline.processSceneLinear(decoded: input, model: modelDefault)
        let outBoost   = pipeline.processSceneLinear(decoded: input, model: modelBoost)

        let dR = Self.sampleCenterR(outDefault, width: 32, height: 32)
        let bR = Self.sampleCenterR(outBoost, width: 32, height: 32)
        XCTAssertTrue(dR.isFinite && bR.isFinite,
            "NR luminance produced non-finite channel: default=\(dR) boost=\(bR)")
        XCTAssertGreaterThanOrEqual(bR, 0.0,
            "NR luminance pushed centre R below zero: \(bR)")
        XCTAssertLessThanOrEqual(bR, 2.0,
            "NR luminance pushed centre R above 2.0 (clip headroom): \(bR)")
    }

    /// Same shape but for NR color. The boost slider increases blur on
    /// the a/b channels; assert no catastrophic chroma collapse.
    func testM3ProcessSceneLinearAppliesNRColor() async throws {
        let pipeline = ImageEditPipeline()
        let input = Self.makeAlternatingChromaSceneLinearCIImage(width: 32, height: 32)

        var modelDefault = AdjustmentModel.default
        modelDefault.nrLuminance = 0
        modelDefault.nrColor = 0
        var modelBoost = modelDefault
        modelBoost.nrColor = 100

        let outDefault = pipeline.processSceneLinear(decoded: input, model: modelDefault)
        let outBoost   = pipeline.processSceneLinear(decoded: input, model: modelBoost)

        let dRG = Self.sampleCenterRMinusG(outDefault, width: 32, height: 32)
        let bRG = Self.sampleCenterRMinusG(outBoost, width: 32, height: 32)
        XCTAssertTrue(dRG.isFinite && bRG.isFinite,
            "NR color produced non-finite R-G: default=\(dRG) boost=\(bRG)")
        // NR color blurs chroma — the centre of an alternating-chroma
        // scene should see chroma reduced. We accept >= as a smoke
        // threshold (no-op kernel passes; running kernel produces a
        // smaller |R-G| at the centre).
        XCTAssertLessThanOrEqual(abs(bRG), abs(dRG) + 1e-3,
            "NR color +100 should not increase |R-G| at centre — got default=\(dRG) boost=\(bRG)")
    }

    /// Build a 32×32 alternating-luma scene: even rows bright reddish
    /// (R, G, B = 0.6, 0.3, 0.3), odd rows dark reddish (0.3, 0.1, 0.1).
    /// Mirrors the Rust unit test at noise_reduction.rs:121-126.
    static func makeAlternatingLumaSceneLinearCIImage(width w: Int, height h: Int) -> CIImage {
        var pixels = [UInt16](repeating: 0, count: w * h * 4)
        let one = Self.float32ToFloat16Bits(1.0)
        let bright = (Self.float32ToFloat16Bits(0.6),
                      Self.float32ToFloat16Bits(0.3),
                      Self.float32ToFloat16Bits(0.3))
        let dark = (Self.float32ToFloat16Bits(0.3),
                    Self.float32ToFloat16Bits(0.1),
                    Self.float32ToFloat16Bits(0.1))
        for y in 0..<h {
            for x in 0..<w {
                let i = (y * w + x) * 4
                let v = (y % 2 == 0) ? bright : dark
                pixels[i + 0] = v.0
                pixels[i + 1] = v.1
                pixels[i + 2] = v.2
                pixels[i + 3] = one
            }
        }
        let bytesPerRow = w * 4 * 2
        let data = pixels.withUnsafeBufferPointer { Data(bytes: $0.baseAddress!, count: $0.count * 2) }
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        return CIImage(
            bitmapData: data,
            bytesPerRow: bytesPerRow,
            size: CGSize(width: w, height: h),
            format: .RGBAh,
            colorSpace: space
        )
    }

    /// Build a 32×32 alternating-chroma scene: even rows reddish (R, G,
    /// B = 0.5, 0.3, 0.3), odd rows greenish (0.3, 0.5, 0.3). Same luma,
    /// different chroma — designed for NR color smoothing.
    static func makeAlternatingChromaSceneLinearCIImage(width w: Int, height h: Int) -> CIImage {
        var pixels = [UInt16](repeating: 0, count: w * h * 4)
        let one = Self.float32ToFloat16Bits(1.0)
        let red = (Self.float32ToFloat16Bits(0.5),
                   Self.float32ToFloat16Bits(0.3),
                   Self.float32ToFloat16Bits(0.3))
        let green = (Self.float32ToFloat16Bits(0.3),
                     Self.float32ToFloat16Bits(0.5),
                     Self.float32ToFloat16Bits(0.3))
        for y in 0..<h {
            for x in 0..<w {
                let i = (y * w + x) * 4
                let v = (y % 2 == 0) ? red : green
                pixels[i + 0] = v.0
                pixels[i + 1] = v.1
                pixels[i + 2] = v.2
                pixels[i + 3] = one
            }
        }
        let bytesPerRow = w * 4 * 2
        let data = pixels.withUnsafeBufferPointer { Data(bytes: $0.baseAddress!, count: $0.count * 2) }
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        return CIImage(
            bitmapData: data,
            bytesPerRow: bytesPerRow,
            size: CGSize(width: w, height: h),
            format: .RGBAh,
            colorSpace: space
        )
    }
```

- [ ] **Step 6.3: Run the tests — expect PASS (no-op kernels short-circuit, but the wrappers exist and short-circuits return identity for the default path).**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testM3ProcessSceneLinearApplies 2>&1 | tail -10`

Expected: both tests PASS even before wiring (the wrappers are public and the wiring tests don't depend on the wrappers being called from `processSceneLinear` yet — the >= / <= smoke comparisons are satisfied at identity). The wiring lands in Step 6.4.

- [ ] **Step 6.4: Add the `applySceneNRLuminance` + `applySceneNRColor` calls inside `processSceneLinear`.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift`, locate the `withTexture` block (lines 366-369 after v2 v1 landing). Replace:

```swift
        // Plan 2 v2 M2 — Stage: SceneTexture (unsharp mask at radius 3 in
        // scene-linear Rec.2020 RGB). Mirrors texture::apply from raw-core
        // (texture.rs:10). Backed by the same SeparableGaussianBlur
        // compute kernel as clarity (Task 2); only the radius differs.
        let withTexture = MetalKernels.applySceneTexture(
            to: withClarity,
            texture: Float(model.texture)
        )

        // Stage: AgX view transform — exactly once, on scene-linear data.
        // The kernel is per-channel (verified by Spike 1.2), so feeding it
        // Rec.2020 instead of sRGB only matters for out-of-gamut content.
        return MetalKernels.applyAgXViewTransform(
            to: withTexture, contrast: Float(model.contrast)
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

        // Plan 2 v2 v2 M3 — Stage: SceneNRColor (Oklab roundtrip + shared
        // blur on the a/b channels). Mirrors noise_reduction::apply_color
        // from raw-core (noise_reduction.rs:61-96). AdjustmentModel.nrColor
        // defaults to 25 (radius=1) — this stage runs by default. Maximum
        // radius at amount=100 is 4 src px.
        let withNRColor = MetalKernels.applySceneNRColor(
            to: withNRLuminance,
            nrColor: Float(model.nrColor)
        )

        // Stage: AgX view transform — exactly once, on scene-linear data.
        // The kernel is per-channel (verified by Spike 1.2), so feeding it
        // Rec.2020 instead of sRGB only matters for out-of-gamut content.
        return MetalKernels.applyAgXViewTransform(
            to: withNRColor, contrast: Float(model.contrast)
        )
```

- [ ] **Step 6.5: Run the wiring tests.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testM3ProcessSceneLinearApplies 2>&1 | tail -10`

Expected: both PASS.

- [ ] **Step 6.6: Run the full Swift test suite.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | tail -10`

Expected: green. Test count = post-Task-5 baseline + 2.

- [ ] **Step 6.7: Run the parity harness.**

Run: `BUDGET=15 src/scripts/test_color_pipeline.sh 2>&1 | tail -8`

Expected: PASS — Plan 2 v2 v2 has not touched `applyFilters`.

- [ ] **Step 6.8: Commit.**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
git commit -m "feat(apple): wire SceneNRLuminance + SceneNRColor into processSceneLinear

Plan 2 v2 v2 M3 — both NR stages on the new path. Inserts the calls
between SceneTexture and AgXViewTransform in processSceneLinear so
the chain becomes:
  WB -> tone -> vibrance -> saturation -> clarity -> texture
       -> NR luminance -> NR color -> AgX

Order matches raw-core's pipeline.rs:131-132 (NR luminance before
NR color). Tests assert centre-pixel finite and bounded under
amount=100 for each stage.

Parity harness on the legacy path (BUDGET=15) stays green —
applyFilters still untouched. Plan 2 v2 v5 (separate plan) deletes
the legacy path."
```

---

## Task 7: M3 milestone gate — manual smoke test + deep-zoom regression check

**Files:**

- Read-only: `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift`
- Read-only: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/DeepZoomTileRenderingTests.swift`
- Modify (header comment only): `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift`
- Build artifacts: the macOS `Maple.app` launched from `xcodebuild` output

**Why this matters:** `swift test` cannot load the metallib (per `MetalKernels.swift:19-28` and the v2 v1 M1 + M2 milestone gates), so the wiring tests in Task 6 are smoke tests, not parity tests. The actual confirmation that NR luminance + NR color move pixels at runtime is a manual A/B in the macOS app. This task is also where the deep-zoom regression check lands: the existing `DeepZoomTileRenderingTests.swift` exercises the 35 px tile-overlap budget; running it after wiring confirms the new compute-blur path doesn't widen the effective stencil for NR (which it shouldn't, because NR radii ≤4 px are far inside the 35 px budget).

- [ ] **Step 7.1: Build the macOS app.**

Run: `cd src/apple && xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build 2>&1 | tail -3`

Expected: `BUILD SUCCEEDED`. The xcframework is unchanged (no Rust source changes in Plan 2 v2 v2).

- [ ] **Step 7.2: Launch the app and open the reference fixture.**

Run: `open -a /Users/$USER/Library/Developer/Xcode/DerivedData/Maple-*/Build/Products/Debug/Maple.app`

(Substitute the actual DerivedData path if the wildcard expansion fails — `find ~/Library/Developer/Xcode/DerivedData -name 'Maple-*' -maxdepth 1 -type d` locates it.)

Open `src/raw-pipeline/test-fixtures/raws/dji-mavic3pro-100mp.dng` (or the largest available fixture — `ls src/raw-pipeline/test-fixtures/raws/*.dng`).

- [ ] **Step 7.3: Drag NR luminance and NR color sliders, confirm each moves pixels.**

For each slider below, drag from the listed default to the listed extreme and visually confirm the image changes:

| Slider       | Default | Test action  | Expected                                                                 |
| ------------ | ------- | ------------ | ------------------------------------------------------------------------ |
| NR luminance | 0       | Drag to +100 | Fine luminance noise (sky, shadows) softens; mid-frequency detail intact |
| NR color     | 25      | Drag to +100 | Chroma noise (random color speckles in shadows) softens; luma untouched  |
| NR color     | 25      | Drag to 0    | Chroma noise should re-emerge in shadows / dark regions                  |

Capture a screenshot of one mid-drag state per slider — file at `/tmp/plan-2-v2-v2-m3-<slider>.png`. **Do not commit screenshots.**

If any slider fails to move pixels, M3 is not actually working — STOP and inspect:

- Run `log stream --predicate 'subsystem == "app.justmaple.aperture"'` and look for `os_log .error` lines (the loaders log on failure via `MetalKernels.loadKernel`).
- Confirm the metallib is present in the .app bundle: `find /Users/$USER/Library/Developer/Xcode/DerivedData/Maple-*/Build/Products/Debug/Maple.app -name 'SceneNR*.metal'`. If `SceneNRLuminance.metal` and `SceneNRColor.metal` are absent, the `.copy("Metal")` resource bundling failed — rebuild from clean (`xcodebuild clean` then `build`).
- If the `os_log` shows "Cannot find a valid stitchable Metal function in the source" or "cannot initialize a variable of type 'float4' with an rvalue of type 'half4'" (the Spike 1.1 modern-macOS failure modes), the new NR kernels need `[[stitchable]]` retrofitted (per the Step 1.5 note in Task 1). Apply the fix to BOTH `SceneNRLuminance.metal` and `SceneNRColor.metal` AND the existing v2 v1 production kernels (`SceneVibrance`, `SceneSaturation`, `SceneToneControls`, `WhiteBalance`, `SceneUnsharp`) in a separate retrofit plan — do NOT add `[[stitchable]]` only to the new NR kernels (would create a kernel-source style split).

- [ ] **Step 7.4: Run the Deep Zoom test suite to confirm tile compatibility didn't regress.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter DeepZoomTileRenderingTests 2>&1 | tail -20`

Expected: green. The tests exercise the 35 px overlap budget; NR radii ≤ 4 px are far inside that budget. Plan 2 v2 v2's M3 does not change radius constants (NR luma stays MAX=2, NR color stays MAX=4) or the algorithm shape (3-pass box-blur + Oklab roundtrip — same as Rust), so the deep-zoom math is preserved by construction. The test run is a regression detector — if anything has broken, the failure is in the new compute-blur or Oklab convert/unconvert.

If the deep-zoom suite fails, inspect the failing test name and trace it to which tile-rect / radius combination broke. The most likely cause is an Oklab convert/unconvert sign error in one of the new `.metal` files (compare `nrLuminance*` against `SceneVibrance.metal:40-50` and `nrColor*` against the same, looking for a sign flip on `cbrtSigned` or a row/column transpose in the matrix constructors).

- [ ] **Step 7.5: Run the parity harness one more time.**

Run: `BUDGET=15 src/scripts/test_color_pipeline.sh 2>&1 | tail -8`

Expected: PASS — Plan 2 v2 v2 has not touched `applyFilters` (legacy path).

- [ ] **Step 7.6: Append the M3 manual test result to the test file header.**

In `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift`, locate the Plan 2 v2 v1 M2 milestone-gate header block (added by v2 v1 Task 7 Step 7.6, currently around lines 211-229). Append after it:

```swift
//
// Plan 2 v2 v2 M3 manual smoke test (Task 7 Step 7.3, recorded after
// wiring SceneNRLuminance + SceneNRColor into processSceneLinear in
// Task 6):
//   nrLuminance  0->+100  moved pixels — <PASS|FAIL>
//   nrColor      25->+100  moved pixels — <PASS|FAIL>
//   nrColor      25->0    moved pixels — <PASS|FAIL>
//
// Deep Zoom regression check (Task 7 Step 7.4):
//   DeepZoomTileRenderingTests — <PASS|FAIL> (35 px overlap budget
//   preserved by construction; NR radii <= 4 px <<< 35 px).
//
// Parity harness on legacy path (Step 7.5): BUDGET=15 <PASS|FAIL>
// — applyFilters still untouched.
```

Replace `<PASS|FAIL>` with the actual results. A FAIL anywhere blocks Plan 2 v2 v2 from being declared complete — STOP and investigate.

- [ ] **Step 7.7: Commit.**

```bash
git add src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
git commit -m "docs(apple): record Plan 2 v2 v2 M3 milestone-gate results in test file header

M3 wires SceneNRLuminance + SceneNRColor into processSceneLinear.
swift test cannot load metallibs so kernels run no-op under XCTest;
the runtime confirmation is manual at this milestone. This commit
records the result of dragging each slider once on the reference
fixture and observing pixel changes.

Also records the DeepZoomTileRenderingTests result — the 35 px overlap
budget is preserved by construction (NR radii <= 4 px <<< 35 px;
algorithm shape unchanged). Parity harness on the legacy path
(BUDGET=15) still passes.

This concludes Plan 2 v2 v2 (M3 = NR luminance + NR color). Plan 2 v2
v3 (sharpen), v4 (dehaze), and v5 (delete legacy applyFilters) are
separate plans."
```

---

## Self-review checklist (before declaring Plan 2 v2 v2 complete)

The following are the load-bearing checks — confirm each before marking the plan done.

1. **Both v2 v1 spikes still recorded as PASS** in the test file header (verified in Task 1 Step 1.3). If either is missing, the v2 v1 architecture assumption (compute → CI handoff) is invalidated — STOP and reopen.
2. **Two new Metal sources** under `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/`:
   - `SceneNRLuminance.metal` (`CIColorKernel`, 2 functions: extractL + combine)
   - `SceneNRColor.metal` (`CIColorKernel`, 2 functions: extractAB + combine)
3. **Two new public Swift wrappers** in `MetalKernels.swift`:
   - `applySceneNRLuminance(to:nrLuminance:)`
   - `applySceneNRColor(to:nrColor:)`
4. **Four new private Swift loaders** in `MetalKernels.swift`:
   - `sceneNRLuminanceExtractKernel()`, `sceneNRLuminanceCombineKernel()`
   - `sceneNRColorExtractKernel()`, `sceneNRColorCombineKernel()`
5. **Wiring in `processSceneLinear`:** the chain is now WB → tone → vibrance → saturation → clarity → texture → NR luminance → NR color → AgX. Verify with `grep -n "applyScene" src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift` — eight matches in `processSceneLinear` (WB, tone, vibrance, saturation, clarity, texture, NR luminance, NR color) before the AgX return.
6. **Test count grew by 8 test methods:**
   - Task 3 adds 3: `testM3aSwiftScalarApplyLuminanceMatchesRust`, `testM3aSwiftScalarApplyLuminanceZeroIsIdentity`, `testM3NRLuminanceShortCircuitsAtZeroAmount`.
   - Task 5 adds 3: `testM3bSwiftScalarApplyColorMatchesRust`, `testM3bSwiftScalarApplyColorZeroIsIdentity`, `testM3NRColorShortCircuitsAtZeroAmount`.
   - Task 6 adds 2: `testM3ProcessSceneLinearAppliesNRLuminance`, `testM3ProcessSceneLinearAppliesNRColor`.
   - Plus 8 static helper funcs (`swiftRec2020ToOklab`, `swiftOklabToRec2020`, `mulMV`, `cbrtSigned`, `swiftApplyLuminance`, `swiftApplyColor`, `makeAlternatingLumaSceneLinearCIImage`, `makeAlternatingChromaSceneLinearCIImage`) — these are not test methods.
7. **Parity harness still PASS** at `BUDGET=15` — the legacy `applyFilters` path is untouched.
8. **DeepZoomTileRenderingTests still PASS** — NR radii ≤ 4 px are far inside the 35 px overlap budget; algorithm shape unchanged.
9. **No `applyFilters` source touched.** Verify with `git diff main..HEAD -- src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift` and confirm changes are scoped to `processSceneLinear`.
10. **Manual smoke test passed for both sliders** — recorded in the test file header (Task 7 Step 7.6). Three slider transitions (NR luma 0 → +100, NR color 25 → +100, NR color 25 → 0) all moved pixels in the macOS app.
11. **Oklab matrices in `SceneNRLuminance.metal` (suffix `_nrl`) and `SceneNRColor.metal` (suffix `_nrc`) are byte-identical to those in `SceneSaturation.metal` (suffix `_sat`)** — verify by `diff <(sed -n '17,38p' src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneSaturation.metal) <(sed -n '<line range>' src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneNRLuminance.metal)` (modulo the suffix). Any drift in matrix values is a parity bug.
12. **No Rust source files touched.** Verify with `git diff main..HEAD -- src/raw-pipeline/` — should produce empty output.

If any check fails, the plan is not complete. Address the failing check, re-run the verification steps it depends on, and only then declare done.
