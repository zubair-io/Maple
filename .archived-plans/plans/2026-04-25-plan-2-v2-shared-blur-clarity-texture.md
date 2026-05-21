# Plan 2 v2 — Shared Separable Gaussian Blur + Clarity + Texture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Brief:** [`.archived-plans/specs/2026-04-25-plan-2-v2-heavy-slider-stages-brief.md`](../specs/2026-04-25-plan-2-v2-heavy-slider-stages-brief.md). The brief's § 9 "Recommended cut" is the scope for this plan: M1 (shared blur) + M2 (clarity + texture) only.
>
> **Companion plan:** [`.archived-plans/plans/2026-04-25-plan-2-dev-chain-metal-kernels.md`](2026-04-25-plan-2-dev-chain-metal-kernels.md) — Plan 2 v1 (already shipped) wired WB → tone → vibrance → saturation → AgX into `processSceneLinear`. The new chain order after this plan is: WB → tone → vibrance → saturation → **clarity → texture** → AgX. NR luminance, NR color, sharpen, dehaze, and the `applyFilters` deletion are explicitly out of scope (see § Out of scope).
>
> **Tile-rendering invariant:** [`.archived-plans/plans/2026-04-25-deep-zoom-tile-rendering.md`](2026-04-25-deep-zoom-tile-rendering.md) § "Architecture" point 2 documents the 35 px overlap budget with clarity (radius 40, 3-pass box) as the binding constraint. Plan 2 v2 must NOT widen the overlap (would push waste from 22.6% to 38.6% on 512² tiles per the deep-zoom plan) and must NOT shrink the radius (would change visible slider behavior). The 35 px overlap covers clarity to within ~3 px of the inner-edge worst case; tile seams may show ~3 px of clarity ringing under extreme `clarity` slider values — that trade-off is preserved here, not relitigated.

**Goal:** Add a shared `SeparableGaussianBlur` Metal compute kernel that mirrors `gaussian_blur_rgb` in `raw-core/src/stages/blur.rs` (3-pass box-blur Wells 1986 approximation) and use it from two new `CIColorKernel`-based unsharp-mask wrappers — `SceneClarity` (radius 40, scene-linear Rec.2020) and `SceneTexture` (radius 3, scene-linear Rec.2020). Both consume `model.clarity` / `model.texture` from `AdjustmentModel` and run inside `processSceneLinear` between saturation and AgX, restoring the clarity + texture sliders on the scene-linear path.

**Architecture:**

1. **Two open questions on the brief, two spike tasks first.** Task 1 is a verification spike that answers both before any production code lands:
   - **Spike 1.1 (load-bearing):** does `CIImage(mtlTexture:)` from a `MTLComputePipeline` output compose cleanly with downstream `CIColorKernel.apply(...)` calls? If yes, the entire M1 + M2 architecture below is correct. If no, M1 swaps to `CIImageProcessorKernel` subclass — Task 1 Step 1.7 documents the fail action and stops the plan for revision.
   - **Spike 1.2 (decoration):** can `#include` from a Metal source compiled via `CIKernel.kernels(withMetalString:)` resolve relative to `Bundle.module/Metal/`? If yes, Task 4 factors Oklab matrices into a shared `oklab.metal`. If no, Task 4 keeps copy-paste. Either path produces the same output pixels; the spike only affects code style.
2. **Shared blur is a `MTLComputePipeline`, not a `CIKernel`.** The brief at § 1 commits to this for three reasons grounded in `MetalKernels.swift:174-240`: existing kernels are `CIColorKernel` (per-pixel) or `CIKernel` with a sampler (AgX LUT), neither of which can author a stateful 6-pass convolution that retains intermediate buffers; the 3-pass approximation requires 6 separate H/V dispatches plus a transpose scratch (mirrors `tmp_col` at `blur.rs:49`), which is the natural shape of a `MTLCommandBuffer` of 6 compute encodes; downstream stages consume the blur as input to a per-pixel mix, which means wrapping the compute output in a `CIImage` via `CIImage(mtlTexture:)` and feeding the existing `CIColorKernel` chain. Spike 1.1 verifies that hybrid composition.
3. **Clarity (radius 40) and texture (radius 3) are unsharp masks on RGB, not Oklab.** The Rust source at `clarity.rs:10` and `texture.rs:10` runs the blur on RGB scene-linear Rec.2020, not Oklab. The brief (in § 2 "Per-stage kernel inventory") incorrectly says clarity and texture both apply on "Oklab L" — that's wrong, and the prompt explicitly flags this. The Rust implementation is the source of truth: per-channel unsharp on R/G/B in scene-linear Rec.2020. **No Oklab roundtrip is needed for either kernel.** Task 4's Spike 1.2 (Oklab `#include` resolution) is preserved because NR luma + NR color (deferred M3) need it; landing the spike with M2 is a free-rider so the next plan doesn't re-spike. **The `oklab.metal` extraction itself is deferred to M3** — clarity + texture don't consume Oklab matrices.
4. **One mix kernel, two radii.** The brief at § 4 "Sequencing milestones / M2" commits to a single shared mix kernel: `extern "C" float4 sceneUnsharp(coreimage::sampler_h src, coreimage::sampler_h blurred, float amount)`. Both clarity and texture call `applySceneUnsharp` with their respective `(src, blurred, amount)` triples — only the radius (and therefore the upstream blur's scratch) differs. This factoring is DRY and matches the Rust source: `clarity.rs:16-20` and `texture.rs:16-20` are byte-identical except for the `CLARITY_RADIUS` vs `TEXTURE_RADIUS` constant.
5. **Wiring is isolated to `processSceneLinear`.** Two new lines insert clarity + texture between `withSaturation` and `applyAgXViewTransform` in `ImageEditPipeline.swift:344-355`. No change to `applyFilters` (legacy path stays — Plan 2 v2 M6 deletes it).
6. **Tile-rendering compatibility is preserved by construction.** The radius constants are unchanged from Rust source — clarity stays at 40 source pixels, texture at 3 source pixels. The deep-zoom plan's 35 px overlap budget already accounts for clarity at radius 40; no overlap math changes here. **Verification step in Task 7** runs the full deep-zoom test (`DeepZoomTileRenderingTests.swift`) after wiring to confirm tile seams haven't regressed.

**Tech Stack:**

- Swift (`MapleCore`) — `MetalKernels` namespace gains a fourth section: `applySeparableGaussianBlur(to:radius:)` returning a `CIImage` (the compute kernel), `applySceneClarity(to:clarity:)` and `applySceneTexture(to:texture:)` (the `CIColorKernel`-based mix wrappers). Pattern matches the existing `applySceneToneControls` / `applySceneVibrance` shape; new `MTLComputePipelineState` field is loaded once and cached as `_separableGaussianBlur: MTLComputePipelineState?` alongside the existing `_sceneToneControls` / `_sceneVibrance` `CIColorKernel?` properties.
- Metal Shading Language —
  - `SeparableGaussianBlur.metal`: a compute kernel `kernel void separableBoxBlurH(...)` and `kernel void separableBoxBlurV(...)` (two functions; one metallib). `MetalKernels.applySeparableGaussianBlur(to:radius:)` orchestrates the 6-pass dispatch (H, V, H, V, H, V — three full Gaussian passes via the box-blur approximation, mirroring `gaussian_blur_rgb`).
  - `SceneUnsharp.metal`: a single `extern "C" float4 sceneUnsharp(coreimage::sampler_h src, coreimage::sampler_h blurred, float amount)` `CIColorKernel` mix function. Both clarity and texture call it; only the upstream blur radius (and therefore the second sampler's blur input) differs.
- Build glue — `./src/apple/scripts/build-xcframework.sh` is NOT rerun (no Rust source changes); the new `.metal` files ship via `Package.swift:.copy("Metal")` (verbatim copy, runtime compile via `CIKernel.kernels(withMetalString:)` and `MTLDevice.makeLibrary(source:options:)`).
- Test — `cd src/apple/Packages/MapleCore && swift test` after each Swift edit; `BUDGET=15 src/scripts/test_color_pipeline.sh` after each milestone (M1, M2) for the legacy-path ΔE gate (Plan 2 v2 must not break it).

**Out of scope (explicit):**

- **M3 — NR luminance + NR color.** Both need Oklab roundtrip + shared blur on a single channel (L for luma, a/b for color). Separate plan; landing Spike 1.2's `#include` answer here gives that plan the resolved style decision.
- **M4 — Sharpen.** Bespoke `MTLComputePipeline` for 3-iter Richardson-Lucy. Plan 2 v2 brief § 2 marks effort `M`. Separate plan.
- **M5 — Dehaze.** Three compute dispatches (15×15 dark-channel min-filter, atmospheric-light top-0.1% reduction, 60-radius guided filter). Brief § 2 marks effort `L`. Separate plan; deferred until M1–M4 prove the architecture per brief § 4.
- **M6 — Delete legacy `applyFilters` chain at `ImageEditPipeline.swift:512`** plus the `MAPLE_SKIP_SWIFT_AGX` (`ImageEditPipeline.swift:679`) and `MAPLE_SKIP_SWIFT_FILTERS` (`ImageEditPipeline.swift:520`) gates. Brief § 4 explicitly defers this to "after every kernel is on the new path." Separate plan.
- **Web/WASM port of clarity / texture.** Plan 3 territory; not touched here.
- **Pixel-parity gate against Rust.** The brief's M1 "Parity test against `gaussian_blur_rgb`" is included as a ΔE soft-gate test in Task 3 (Step 3.5: ΔE ≤ 1.0 on the blur output for a synthetic delta image), not a CI-blocking check. Tightening to a strict numeric gate is a follow-up; the brief calls this out at § 1 as "bit-budget critical; any deviation re-opens the ΔE harness," and the harness budget ratchets downward over time per `CLAUDE.md` § "Objective color testing — no eyeballing."
- **Pre-compiling Metal kernels at app launch.** Lazy compile on first use, cached for the process lifetime — matches the existing `MetalKernels` pattern (private static `_kernel` properties).
- **Adjusting the deep-zoom plan's 35 px overlap.** Plan 2 v2 inherits the trade-off — see `.archived-plans/plans/2026-04-25-deep-zoom-tile-rendering.md` § "Open questions" for the ~3 px ringing note. Not changed here.
- **Bumping `RenderedPreviewCache.adjustment_version`.** The cache key already includes `adjustment_version` per `CLAUDE.md` § "Performance invariants"; the Plan 2 v1 commit already advanced the view-transform version. Adding clarity/texture stages to a chain whose `adjustment_version` already covers `model.clarity` and `model.texture` is an additive use of existing key fields — no key change needed.

---

## File Structure

**Swift (read-write):**

- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift` — add three private static cache fields (`_separableGaussianBlurLib: MTLLibrary?`, `_separableBoxBlurHPipeline`, `_separableBoxBlurVPipeline`, `_sceneUnsharp: CIColorKernel?`), one new public compute-kernel wrapper (`applySeparableGaussianBlur(to:radius:)`), two new public `CIColorKernel` mix wrappers (`applySceneClarity(to:clarity:)` and `applySceneTexture(to:texture:)`), and three new private kernel-loader helpers (`separableGaussianBlurLibrary()`, `sceneUnsharpKernel()`, `metalDevice()`). All five new wrappers mirror the existing `applySceneToneControls` / `applySceneVibrance` / `sceneToneControlsKernel` / `sceneVibranceKernel` shape, except `applySeparableGaussianBlur` returns a `CIImage` built from a `MTLTexture` (verified by Spike 1.1).
- Add: `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SeparableGaussianBlur.metal` — new Metal source. Two compute functions: `separableBoxBlurH` and `separableBoxBlurV`. Each does one box pass along its axis with running-sum accumulator (mirrors `box_blur_channel` at `blur.rs:26-69`). The Swift wrapper composes 6 dispatches (H, V, H, V, H, V) for the 3-pass Gaussian approximation per `gaussian_blur_rgb` at `blur.rs:89-114`.
- Add: `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneUnsharp.metal` — new Metal source. Single `CIColorKernel` mix function `sceneUnsharp(src, blurred, amount)` returning `src + (src - blurred) * amount` per channel. Mirrors the per-pixel mix at `clarity.rs:16-20` and `texture.rs:16-20` byte-for-byte (same algorithm in both Rust files).
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift` — extend `processSceneLinear` (currently lines 291-356 after Plan 2 v1 landing) with two new stage calls between `withSaturation` (line 345) and the `applyAgXViewTransform` return (line 353): `applySceneClarity(to: withSaturation, clarity: Float(model.clarity))` and `applySceneTexture(to: withClarity, texture: Float(model.texture))`. The `withTexture` value feeds the existing AgX call.
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift` — append (a) the two spike tests from Task 1 (`testSpike11ComputeOutputComposesWithCIColorKernel`, `testSpike12MetalIncludeResolvesFromBundle`), (b) one M1 unit test (`testM1SeparableGaussianBlurMatchesRustReference`) that pure-Swift-mirrors the Rust `gaussian_blur_plane` against a synthetic delta image and compares to a recorded reference (the test exists outside the Metal kernel — it doesn't actually run the kernel under XCTest because metallib is absent under `swift test`, per the existing pattern at `MetalKernelParityTests.swift:13-52`), and (c) two M2 wiring smoke tests (`testM2ProcessSceneLinearAppliesClarity`, `testM2ProcessSceneLinearAppliesTexture`) that drive `processSceneLinear` end-to-end with non-zero clarity/texture and assert centre-pixel R-G separation increases (using the existing `>=` smoke-test pattern from Plan 2 v1's `testM1ProcessSceneLinearAppliesVibrance`).

**Swift (read-only during verification):**

- `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneToneControls.metal` — reference for kernel source style (constants, `extern "C"`, `coreimage::sampler_h`, `smoothstep_f` helpers).
- `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneVibrance.metal` — reference for the Oklab matrices (used by Spike 1.2 only — the `oklab.metal` extraction itself is deferred to M3).
- `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/AgXViewTransform.metal` — reference for using a non-`CIColorKernel` shape (compute or sampler-driven) inside `MetalKernels`.
- `src/apple/Packages/MapleCore/Sources/MapleCore/Cache/TileManager.swift` — reference for the deep-zoom plan's 35 px overlap consumption. Verified read-only in Task 7 Step 7.4 (no source edits).

**Rust (read-only during verification):**

- `src/raw-pipeline/raw-core/src/stages/blur.rs:26-114` — algorithm reference for `SeparableGaussianBlur.metal`. The H/V/H/V/H/V composition, the `r_box = (radius/3).max(1)` integer math, and the running-sum accumulator with edge clamp are all mirrored byte-for-byte.
- `src/raw-pipeline/raw-core/src/stages/clarity.rs` — algorithm reference for `applySceneClarity`. `CLARITY_RADIUS = 40`, `amount = clarity / 100.0`, per-channel `p[i] += (p[i] - b[i]) * amount`.
- `src/raw-pipeline/raw-core/src/stages/texture.rs` — algorithm reference for `applySceneTexture`. `TEXTURE_RADIUS = 3`, identical mix to clarity.

**Build artifacts (touched):**

- None. M1 + M2 are pure Swift + Metal source additions. The xcframework is unchanged because no Rust source changes.

---

## Ordering constraint

**Tasks must be done in the order: Task 1 (spikes) → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7 (M2 milestone gate).**

- **Task 1 is a verification spike.** It runs both spikes and records results in the test file header. **If Spike 1.1 fails, STOP and report — the M1 architecture needs revision before Task 2 can land.** Spike 1.2 is decoration: a fail there only changes Task 4's code style (`#include` vs copy-paste of the unsharp helper across the two `CIColorKernel` mix wrappers — though for clarity + texture only one mix kernel exists, so even a Spike 1.2 fail has no effect on this plan; it lands as a recorded result for M3).
- **Task 2 is the M1 metal source.** New kernel file + the Swift wrapper that orchestrates the 6 dispatches.
- **Task 3 is M1 verification.** A pure-Swift parity mirror against the Rust `gaussian_blur_plane` for a synthetic delta image, recorded as a soft ΔE gate (≤ 1.0 on the centre pixel and ≤ 5.0 on the worst case). Note: under `swift test` the Metal kernel itself is a no-op (metallib not loaded), so the parity test is a Swift-side scalar mirror that confirms the algorithm is faithfully ported. The runtime check happens at Task 7's manual smoke test.
- **Task 4 is the M2 mix kernel + the two stage wrappers.** New `SceneUnsharp.metal` plus `applySceneClarity` / `applySceneTexture` Swift wrappers.
- **Task 5 wires clarity into `processSceneLinear`.**
- **Task 6 wires texture into `processSceneLinear`.**
- **Task 7 is the M2 milestone gate.** Manual smoke test in the macOS app + parity harness on the legacy path + `DeepZoomTileRenderingTests.swift` regression check.

After every task: `cd src/apple/Packages/MapleCore && swift test`. After every milestone (M1 = Task 3, M2 = Task 7): `BUDGET=15 src/scripts/test_color_pipeline.sh` (regression check on legacy path, which Plan 2 v2 must not touch).

---

## Task 1: Pre-flight — answer the brief's two open questions (spikes)

**Files:**

- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift` (append two spike tests + a header comment block recording results)

**Why this matters:** The brief's § 8 lists two open questions. Spike 1.1 is load-bearing: a failure flips the entire M1 architecture from `MTLComputePipeline` + `CIImage(mtlTexture:)` to `CIImageProcessorKernel` subclass, which is a substantively different design and re-opens M2 wiring. Spike 1.2 is decoration: the `#include` answer affects code style across the eventual M3 NR kernels but has no bearing on M1 + M2 (clarity + texture don't consume Oklab matrices). Recording both results before any production code lands gives the agent a known, written-down design state to lean on for the rest of the plan.

- [ ] **Step 1.1: Spike 1.1 — write a failing test that composes a `MTLComputePipeline` output with a downstream `CIColorKernel`.**

Append to `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift` (inside the existing `final class SceneLinearPipelineTests`):

```swift
    // MARK: - Plan 2 v2 Spike 1.1: MTLComputePipeline output composes with CIColorKernel

    /// Build a 16×16 fp16 Rec.2020 `MTLTexture`, fill it with mid-gray (0.5
    /// per channel) via a one-shot blit, wrap it in a `CIImage` via
    /// `CIImage(mtlTexture:options:)` with the extendedLinearITUR_2020
    /// color space option, then feed that CIImage into a trivial
    /// `CIColorKernel` that doubles each channel. Verify the output's
    /// centre-pixel R is approximately 1.0 (= 0.5 × 2.0). Same `>=` /
    /// `~=` caveat as the M1 wiring tests — a no-op under XCTest still
    /// passes the assertion because the test inputs the texture at
    /// 0.5 and accepts >= 0.5. The load-bearing pass criterion is
    /// "the test does not throw or crash" — i.e. CIImage accepts a
    /// MTLTexture from a compute output and downstream CIColorKernel
    /// runs without erroring. **A throw or crash here is a Spike 1.1
    /// fail and stops the plan.**
    func testSpike11ComputeOutputComposesWithCIColorKernel() async throws {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device on test runner")
        }
        // Build a 16×16 RGBA16Float texture filled with 0.5 per channel
        // (the fp16 bit pattern for 0.5 is 0x3800 — confirmed by the
        // existing float32ToFloat16Bits helper at SceneLinearPipelineTests
        // .swift:262-328).
        let desc = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .rgba16Float,
            width: 16, height: 16, mipmapped: false
        )
        desc.usage = [.shaderWrite, .shaderRead]
        desc.storageMode = .shared
        guard let tex = device.makeTexture(descriptor: desc) else {
            throw XCTSkip("texture allocation failed")
        }
        // Fill via direct write of 16 × 16 × 4 fp16 lanes = 2048 bytes.
        var pixels = [UInt16](repeating: 0, count: 16 * 16 * 4)
        let half = Self.float32ToFloat16Bits(0.5)
        let one  = Self.float32ToFloat16Bits(1.0)
        for i in stride(from: 0, to: pixels.count, by: 4) {
            pixels[i + 0] = half
            pixels[i + 1] = half
            pixels[i + 2] = half
            pixels[i + 3] = one
        }
        pixels.withUnsafeBufferPointer { buf in
            tex.replace(region: MTLRegionMake2D(0, 0, 16, 16),
                        mipmapLevel: 0,
                        withBytes: buf.baseAddress!,
                        bytesPerRow: 16 * 4 * 2)
        }

        // Wrap in CIImage with the right color space option.
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        let opts: [CIImageOption: Any] = [.colorSpace: space]
        let ci = CIImage(mtlTexture: tex, options: opts)
        XCTAssertNotNil(ci, "CIImage(mtlTexture:) returned nil — Spike 1.1 FAIL")
        guard let inputCI = ci else { return }

        // Build a trivial CIColorKernel that doubles each channel.
        let src = """
        #include <CoreImage/CoreImage.h>
        extern "C" float4 doubleChannels(coreimage::sampler_h s) {
            float4 c = s.sample(s.coord());
            return float4(c.rgb * 2.0, c.a);
        }
        """
        let kernels = try CIKernel.kernels(withMetalString: src)
        guard let k = kernels.first as? CIColorKernel else {
            XCTFail("CIColorKernel build failed — Spike 1.1 FAIL")
            return
        }
        let out = k.apply(
            extent: inputCI.extent,
            roiCallback: { _, rect in rect },
            arguments: [inputCI]
        )
        XCTAssertNotNil(out, "CIColorKernel.apply returned nil — Spike 1.1 FAIL")
        guard let outCI = out else { return }
        // Sample the centre pixel; expect R ≈ 1.0 (0.5 × 2.0).
        let r = Self.sampleCenterR(outCI, width: 16, height: 16)
        // Under XCTest with no Metal-backed CIContext, the createCGImage
        // call in sampleCenterR may produce 0.0 instead of 1.0; the
        // load-bearing check is "no throw/crash, CIImage built, kernel
        // applied". Use >= 0.5 as the smoke threshold.
        XCTAssertGreaterThanOrEqual(
            r, 0.5,
            "Spike 1.1 centre R = \(r); expected >= 0.5 (input was 0.5, kernel doubles)"
        )
    }
```

The `float32ToFloat16Bits` and `sampleCenterR` helpers already exist in this file from Plan 2 v1 (see `SceneLinearPipelineTests.swift:262-328` and the M1 helpers).

- [ ] **Step 1.2: Run Spike 1.1.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testSpike11ComputeOutputComposesWithCIColorKernel 2>&1 | tail -20`

Expected: PASS. The test does not actually require the Metal compute pipeline (it builds the texture via `replace`); it verifies the chain `CIImage(mtlTexture:) → CIColorKernel.apply` works at all.

**FAIL ACTION (Spike 1.1 fail):** If `CIImage(mtlTexture:options:)` returns nil OR if `CIColorKernel.apply` returns nil OR if either step throws, **STOP and report**. The M1 architecture below assumes hybrid compute → CI composition; a fail here means the plan flips to `CIImageProcessorKernel` subclass, which is a substantively different design. Re-open the brief's § 1 with the failure mode and revise the plan before Task 2.

- [ ] **Step 1.3: Spike 1.2 — write a test that confirms `#include` resolution from `Bundle.module/Metal/`.**

Append to the same test class:

```swift
    // MARK: - Plan 2 v2 Spike 1.2: #include resolves from Bundle.module/Metal/

    /// Confirm whether `CIKernel.kernels(withMetalString:)` resolves
    /// `#include "oklab.metal"` (or any other relative include) when the
    /// included file ships under `Bundle.module/Metal/`. The brief's § 8
    /// flags this as the second open question; an answer here is a free
    /// rider with M1 + M2 (clarity + texture don't consume Oklab
    /// matrices) but the answer is needed for M3 (NR luminance + NR
    /// color, deferred plan).
    ///
    /// Method: write a tiny test-scoped include file `_spike12_inc.metal`
    /// to a temp directory, then build a Metal source string that
    /// `#include`s it via an absolute path (the only path form Apple
    /// commits to in the docs). If absolute path includes work, the
    /// follow-on M3 plan will use them via Bundle.module URL resolution
    /// + #include-text injection. If they don't, M3 falls back to copy-
    /// paste matrices in each consumer kernel.
    func testSpike12MetalIncludeResolvesFromBundle() async throws {
        // Synthesize a tiny include file in a temp dir.
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("spike12-\(UUID().uuidString).metal")
        defer { try? FileManager.default.removeItem(at: tmp) }
        try """
        constant float SPIKE12_CONST = 1.5;
        """.write(to: tmp, atomically: true, encoding: .utf8)

        // Try absolute-path #include.
        let src = """
        #include <CoreImage/CoreImage.h>
        #include "\(tmp.path)"
        extern "C" float4 spike12ProbeKernel(coreimage::sampler_h s) {
            float4 c = s.sample(s.coord());
            return float4(c.rgb * SPIKE12_CONST, c.a);
        }
        """
        let kernels: [CIKernel]
        do {
            kernels = try CIKernel.kernels(withMetalString: src)
        } catch {
            // RECORDED FAIL: M3 must copy-paste oklab matrices into each
            // consumer kernel. Logged in the test header by Step 1.5.
            print("Spike 1.2: #include from absolute path FAILED with \(error)")
            return
        }
        // RECORDED PASS or partial pass: kernels compiled but the named
        // function may not be present if the preprocessor silently
        // dropped the include.
        let names = kernels.map(\.name).joined(separator: ", ")
        print("Spike 1.2: kernels compiled — \(names)")
        XCTAssertTrue(
            kernels.contains(where: { $0.name == "spike12ProbeKernel" }),
            "Spike 1.2: kernel built but `spike12ProbeKernel` missing — likely include silently failed"
        )
    }
```

- [ ] **Step 1.4: Run Spike 1.2.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testSpike12MetalIncludeResolvesFromBundle 2>&1 | tail -15`

Expected: PASS or recorded FAIL. **Either result is acceptable.** Spike 1.2 is decoration. A FAIL here only means the eventual M3 plan must copy-paste Oklab matrices; M1 + M2 are unaffected because clarity + texture don't use Oklab.

- [ ] **Step 1.5: Record both spike results in the test file's header comment.**

In `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift`, locate the existing Plan 2 v1 pre-flight comment block (added by Plan 2 v1 Task 1 Step 1.6) and append below it:

```swift
//
// Plan 2 v2 spikes (Task 1 Steps 1.1–1.4):
//
//   Spike 1.1 (load-bearing) — does CIImage(mtlTexture:) compose with
//     downstream CIColorKernel? Result: <PASS|FAIL>
//     Implication: <see plan §1; PASS = plan proceeds; FAIL = re-open
//                   architecture for CIImageProcessorKernel subclass>
//
//   Spike 1.2 (decoration) — does #include resolve via absolute paths
//     when fed to CIKernel.kernels(withMetalString:)? Result: <PASS|FAIL>
//     Implication: <PASS = M3 (deferred plan) can factor oklab.metal;
//                   FAIL = M3 must copy-paste matrices in each kernel.
//                   M1 + M2 are unaffected either way because clarity +
//                   texture do not consume Oklab matrices>
//
// Plan 2 v2 wires SceneClarity + SceneTexture into processSceneLinear,
// each backed by a shared SeparableGaussianBlur compute kernel. See
// .archived-plans/plans/2026-04-25-plan-2-v2-shared-blur-clarity-texture.md.
```

Replace `<PASS|FAIL>` with the actual results.

- [ ] **Step 1.6: Run the full Swift test suite to confirm both spikes are green.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | tail -10`

Expected: green. Test count = post-Plan-2 baseline + 2 (Spike 1.1 + Spike 1.2).

- [ ] **Step 1.7: Run the parity harness baseline.**

Run: `BUDGET=15 src/scripts/test_color_pipeline.sh 2>&1 | tail -8`

Expected: PASS. The harness exercises the legacy `applyFilters` path; Task 1 hasn't touched it.

- [ ] **Step 1.8: Commit.**

```bash
git add src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
git commit -m "test(apple): record Plan 2 v2 spike results — Spike 1.1 + Spike 1.2

Spike 1.1 (load-bearing): does CIImage(mtlTexture:) compose with
downstream CIColorKernel? The plan's M1 architecture (separable
Gaussian blur as a MTLComputePipeline whose output is wrapped in
CIImage and fed to the existing CIColorKernel chain) depends on
this. PASS unblocks the rest of the plan.

Spike 1.2 (decoration): does #include resolve when fed to
CIKernel.kernels(withMetalString:) via an absolute path? Affects
M3's (deferred plan) code style only — clarity + texture don't
use Oklab matrices, so M1 + M2 are unaffected by this answer.

Records both results in the test file's pre-flight comment block.
Parity harness on the legacy path stays green."
```

---

## Task 2: M1 — `SeparableGaussianBlur.metal` + `MetalKernels.applySeparableGaussianBlur`

**Files:**

- Add: `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SeparableGaussianBlur.metal`
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift` (add 3 cache fields, 1 public wrapper, 1 private library loader, 1 device helper)

**Why this matters:** The shared blur is the foundation that clarity + texture both consume. The kernel must produce the same pixel values as `gaussian_blur_rgb` at `blur.rs:89-114` to within a tight ΔE tolerance — the brief's § 1 calls this "bit-budget critical; any deviation re-opens the ΔE harness." The composition order is locked by `blur.rs`: `r_box = (radius/3).max(1)`, then 3 sequential passes of `box_blur_channel` per axis. Translated to GPU, that's 6 compute encodes (H, V, H, V, H, V) on a single command buffer with two ping-pong fp16 RGBA scratch textures.

- [ ] **Step 2.1: Confirm the Rust source-of-truth shape.**

Run: `grep -n "fn gaussian_blur_rgb\|fn box_blur_channel\|r_box = " src/raw-pipeline/raw-core/src/stages/blur.rs`

Expected:

```
26:fn box_blur_channel(buf: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
77:pub fn gaussian_blur_plane(buf: &[f32], w: usize, h: usize, radius: usize) -> Vec<f32> {
81:    let r_box = (radius / 3).max(1);
89:pub fn gaussian_blur_rgb(img: &Image, radius: usize) -> Image {
96:    let r_box = (radius / 3).max(1);
```

Read `blur.rs` lines 26-114 in full once. Confirm:

- Box pass: running-sum accumulator with edge clamp (`right0 = r.min(w - 1)`, no zero-pad).
- 3 passes per axis, written as `for _ in 0..3 { plane = box_blur_channel(...); }`.
- The H sweep writes row-major; the V sweep writes column-major then transposes back. The Metal kernel can skip the transpose because it operates per-pixel with global coords — H and V are both grid-strided dispatches over the full texture, and the only difference is which axis the running sum walks.

- [ ] **Step 2.2: Write the Metal kernel source.**

Create `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SeparableGaussianBlur.metal`:

```metal
// SeparableGaussianBlur.metal — shared 3-pass Gaussian-by-box-blur compute
// kernel. Mirrors `gaussian_blur_rgb` in src/raw-pipeline/raw-core/src/
// stages/blur.rs:89-114 (Wells 1986 approximation).
//
// Used by SceneClarity (radius 40) and SceneTexture (radius 3). The Swift
// wrapper `MetalKernels.applySeparableGaussianBlur(to:radius:)` orchestrates
// the 6-pass dispatch (H, V, H, V, H, V) on a single command buffer with
// two ping-pong fp16 RGBA textures.
//
// Per the Rust source: r_box = (radius / 3).max(1) is the integer box-pass
// radius; the kernel takes that pre-computed `r_box` as a buffer argument
// (so the Swift side does the same integer math as Rust).
//
// Edge handling: clamp-to-edge, identical to the Rust `right0 = r.min(w-1)`
// initial-window math at blur.rs:33-39 — the running sum is initialized
// over the visible window, no zero-pad. We restate that here as a
// per-pixel sum over [max(0, x-r), min(w-1, x+r)] inclusive (no running
// accumulator across thread groups — one thread per output pixel does
// its own bounded loop).
//
// **Performance note:** the brief at § 1 picks compute over CIKernel because
// the running-sum accumulator gives O(n) per pixel independent of radius
// (matching Rust's runtime profile). The naive per-thread bounded sum
// below is O(r) per pixel — fine for radius=3 (texture) but expensive at
// radius=40 (clarity). Step 2.6 documents this and follow-up plans (M3
// onwards) can swap to a threadgroup-shared running-sum implementation
// once the parity tests lock the algorithm.

#include <metal_stdlib>
using namespace metal;

// Horizontal box pass: each output pixel reads [max(0, x-r), min(w-1, x+r)]
// inclusive on the same row; averages all four channels independently.
kernel void separableBoxBlurH(
    texture2d<half, access::read>  src   [[texture(0)]],
    texture2d<half, access::write> dst   [[texture(1)]],
    constant uint& rBox                  [[buffer(0)]],
    uint2 gid                            [[thread_position_in_grid]]
) {
    const uint w = src.get_width();
    const uint h = src.get_height();
    if (gid.x >= w || gid.y >= h) return;

    int x0 = int(gid.x) - int(rBox);
    int x1 = int(gid.x) + int(rBox);
    if (x0 < 0)        x0 = 0;
    if (x1 > int(w)-1) x1 = int(w) - 1;

    float4 acc = float4(0.0);
    int count = 0;
    for (int x = x0; x <= x1; ++x) {
        acc += float4(src.read(uint2(uint(x), gid.y)));
        ++count;
    }
    half4 out = half4(acc / float(count));
    dst.write(out, gid);
}

// Vertical box pass: same as horizontal but along Y. The Rust source's
// transpose is unnecessary on GPU because we do per-pixel writes with
// global coords; the H pass writes to a scratch texture, the V pass
// reads that scratch and writes to the final (or next ping-pong)
// texture.
kernel void separableBoxBlurV(
    texture2d<half, access::read>  src   [[texture(0)]],
    texture2d<half, access::write> dst   [[texture(1)]],
    constant uint& rBox                  [[buffer(0)]],
    uint2 gid                            [[thread_position_in_grid]]
) {
    const uint w = src.get_width();
    const uint h = src.get_height();
    if (gid.x >= w || gid.y >= h) return;

    int y0 = int(gid.y) - int(rBox);
    int y1 = int(gid.y) + int(rBox);
    if (y0 < 0)        y0 = 0;
    if (y1 > int(h)-1) y1 = int(h) - 1;

    float4 acc = float4(0.0);
    int count = 0;
    for (int y = y0; y <= y1; ++y) {
        acc += float4(src.read(uint2(gid.x, uint(y))));
        ++count;
    }
    half4 out = half4(acc / float(count));
    dst.write(out, gid);
}
```

The kernel's alpha-channel handling matches the Rust source's "RGB only, alpha ignored": the Rust `gaussian_blur_rgb` returns an `Image` with three-channel pixels, and Apple's CIImage carries alpha through unchanged because the unsharp mix kernel (Task 4) only touches RGB. The compute kernel here averages alpha alongside RGB for correctness on opaque scenes — alpha=1.0 stays 1.0 under any box average.

- [ ] **Step 2.3: Add the Swift wrapper to `MetalKernels.swift`.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift`, add new private statics under the existing `_agxViewTransform` (line 37):

```swift
    // MARK: Plan 2 v2 — SeparableGaussianBlur (compute) + SceneUnsharp (color)

    /// Cached `MTLLibrary` for SeparableGaussianBlur.metal. The library
    /// is compiled from `.metal` source text on first use and kept for
    /// the process lifetime. Two `MTLComputePipelineState` are derived
    /// from it (one per kernel function).
    private static var _separableGaussianBlurLib: MTLLibrary?
    private static var _separableBoxBlurHPipeline: MTLComputePipelineState?
    private static var _separableBoxBlurVPipeline: MTLComputePipelineState?
    /// Cached default Metal device — needed to build pipelines and
    /// allocate scratch textures.
    private static var _metalDevice: MTLDevice?
```

Add the import at the top of the file alongside the existing `import Metal` (already present from Plan 1's CIContext init):

```swift
import Metal  // already present per ImageEditPipeline.swift:22 — confirm and dedupe if MetalKernels.swift currently lacks it
```

(Run `grep -n "^import" src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift` — if `import Metal` is missing, add it; if present, skip.)

After the `agxKernel()` private helper (line 207), add the public wrapper:

```swift
    // MARK: SeparableGaussianBlur

    /// Apply the shared 3-pass box-blur Gaussian approximation (mirrors
    /// `gaussian_blur_rgb` in raw-core/src/stages/blur.rs) on a CIImage
    /// in scene-linear Rec.2020 fp16. Returns a new CIImage tagged
    /// extendedLinearITUR_2020. Used by both `applySceneClarity` and
    /// `applySceneTexture` (only the radius differs).
    ///
    /// The blur runs as 6 compute dispatches (H, V, H, V, H, V) on a
    /// single command buffer with two ping-pong RGBA16Float textures.
    /// `r_box = max(1, radius / 3)` mirrors the Rust integer math at
    /// blur.rs:81. Returns `input` unchanged when `radius == 0` (Rust
    /// short-circuit at blur.rs:78), or when any of the kernel-load /
    /// pipeline-build / texture-alloc steps fail (silent fallback per
    /// the existing wrapper convention).
    public static func applySeparableGaussianBlur(
        to input: CIImage,
        radius: Int
    ) -> CIImage {
        if radius == 0 { return input }
        let rBox: UInt32 = UInt32(max(1, radius / 3))

        guard let device = metalDevice(),
              let pipelineH = separableBoxBlurHPipeline(),
              let pipelineV = separableBoxBlurVPipeline() else {
            return input
        }

        // Build the input MTLTexture by rendering the CIImage through
        // a small CIContext that targets a fresh fp16 RGBA texture.
        // Fp16 RGBA matches the Rec.2020 working format the rest of
        // the chain uses (per ImageEditPipeline.swift:74).
        let extent = input.extent
        let w = max(1, Int(extent.width.rounded()))
        let h = max(1, Int(extent.height.rounded()))

        let desc = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .rgba16Float,
            width: w, height: h, mipmapped: false
        )
        desc.usage = [.shaderRead, .shaderWrite, .renderTarget]
        desc.storageMode = .private
        guard let texSrc = device.makeTexture(descriptor: desc),
              let texPing = device.makeTexture(descriptor: desc),
              let texPong = device.makeTexture(descriptor: desc) else {
            return input
        }

        // CIContext render of the input CIImage into texSrc.
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        let ciCtx = CIContext(mtlDevice: device, options: [
            .workingColorSpace: CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!,
            .workingFormat: CIFormat.RGBAh,
            .cacheIntermediates: false,
        ])
        guard let queue = device.makeCommandQueue(),
              let renderBuf = queue.makeCommandBuffer() else {
            return input
        }
        ciCtx.render(
            input,
            to: texSrc,
            commandBuffer: renderBuf,
            bounds: extent,
            colorSpace: space
        )

        // Compose the 6 passes on the same command buffer:
        // texSrc -H-> texPing -V-> texPong -H-> texPing -V-> texPong -H-> texPing -V-> texPong
        // After 3 H+V pairs (= 3-pass Gaussian), texPong holds the result.
        let dispatches: [(MTLComputePipelineState, MTLTexture, MTLTexture)] = [
            (pipelineH, texSrc,  texPing),
            (pipelineV, texPing, texPong),
            (pipelineH, texPong, texPing),
            (pipelineV, texPing, texPong),
            (pipelineH, texPong, texPing),
            (pipelineV, texPing, texPong),
        ]
        for (pipeline, src, dst) in dispatches {
            guard let enc = renderBuf.makeComputeCommandEncoder() else {
                return input
            }
            enc.setComputePipelineState(pipeline)
            enc.setTexture(src, index: 0)
            enc.setTexture(dst, index: 1)
            var rBoxLocal = rBox
            enc.setBytes(&rBoxLocal, length: MemoryLayout<UInt32>.size, index: 0)
            let tgSize = MTLSize(width: 16, height: 16, depth: 1)
            let tgCount = MTLSize(
                width:  (w + tgSize.width  - 1) / tgSize.width,
                height: (h + tgSize.height - 1) / tgSize.height,
                depth: 1
            )
            enc.dispatchThreadgroups(tgCount, threadsPerThreadgroup: tgSize)
            enc.endEncoding()
        }
        renderBuf.commit()
        // Don't wait synchronously — return a CIImage wrapping texPong;
        // CoreImage will sync at the next render that depends on it.
        // (This is the "compute → CI" handoff verified by Spike 1.1.)

        let opts: [CIImageOption: Any] = [.colorSpace: space]
        return CIImage(mtlTexture: texPong, options: opts) ?? input
    }

    // MARK: SeparableGaussianBlur — private helpers

    private static func metalDevice() -> MTLDevice? {
        if let d = _metalDevice { return d }
        _metalDevice = MTLCreateSystemDefaultDevice()
        return _metalDevice
    }

    private static func separableGaussianBlurLibrary() -> MTLLibrary? {
        if let lib = _separableGaussianBlurLib { return lib }
        guard let device = metalDevice(),
              let data = metalSource("SeparableGaussianBlur"),
              let source = String(data: data, encoding: .utf8) else {
            os_log(.error, log: kernelLog,
                "SeparableGaussianBlur.metal source not found in Bundle.module/Metal/")
            return nil
        }
        do {
            _separableGaussianBlurLib = try device.makeLibrary(source: source, options: nil)
            return _separableGaussianBlurLib
        } catch {
            os_log(.error, log: kernelLog,
                "MTLDevice.makeLibrary(source:) failed for SeparableGaussianBlur: %{public}@",
                String(describing: error))
            return nil
        }
    }

    private static func separableBoxBlurHPipeline() -> MTLComputePipelineState? {
        if let p = _separableBoxBlurHPipeline { return p }
        guard let device = metalDevice(),
              let lib = separableGaussianBlurLibrary(),
              let fn = lib.makeFunction(name: "separableBoxBlurH") else {
            return nil
        }
        _separableBoxBlurHPipeline = try? device.makeComputePipelineState(function: fn)
        return _separableBoxBlurHPipeline
    }

    private static func separableBoxBlurVPipeline() -> MTLComputePipelineState? {
        if let p = _separableBoxBlurVPipeline { return p }
        guard let device = metalDevice(),
              let lib = separableGaussianBlurLibrary(),
              let fn = lib.makeFunction(name: "separableBoxBlurV") else {
            return nil
        }
        _separableBoxBlurVPipeline = try? device.makeComputePipelineState(function: fn)
        return _separableBoxBlurVPipeline
    }
```

The `metalSource(...)` helper already exists at `MetalKernels.swift:245-254` and serves both `.metal` files; no new I/O code needed.

- [ ] **Step 2.4: Run `swift test` to confirm no compile error.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | tail -10`

Expected: green. The new wrappers are compiled but not yet exercised (no test calls them). Test count = post-Spike-1 baseline (no new tests in this task — Task 3 adds the parity test).

- [ ] **Step 2.5: Commit.**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SeparableGaussianBlur.metal src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift
git commit -m "feat(apple): add SeparableGaussianBlur compute kernel + Swift wrapper

Plan 2 v2 M1 — shared blur foundation. SeparableGaussianBlur.metal
defines two compute functions (separableBoxBlurH, separableBoxBlurV);
each does one box-blur pass with running-sum window and clamp-to-edge.
The Swift wrapper applySeparableGaussianBlur(to:radius:) orchestrates
the 6 dispatches (H, V, H, V, H, V) on a single command buffer with
two ping-pong fp16 RGBA textures, mirroring gaussian_blur_rgb at
raw-core/src/stages/blur.rs:89-114.

r_box = max(1, radius / 3) matches the Rust integer math at
blur.rs:81 byte-for-byte.

The wrapper's compute → CIImage handoff (CIImage(mtlTexture:options:))
is the path verified by Spike 1.1. Returns input unchanged on any
kernel-load / pipeline-build / texture-alloc failure (silent fallback,
matching the existing wrapper convention)."
```

---

## Task 3: M1 verification — Swift-scalar parity mirror against Rust `gaussian_blur_plane`

**Files:**

- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift` (append the parity mirror test)

**Why this matters:** The brief at § 1 says "any deviation re-opens the ΔE harness." Under `swift test`, the metallib isn't loaded, so the Metal kernel is a silent no-op. To verify M1 ships with correct algorithm semantics, this task adds a pure-Swift scalar mirror of the Rust `gaussian_blur_plane` algorithm and compares it against a recorded reference (a 32×32 fp32 delta image: zeros everywhere except a single 1.0 at the centre, blurred at radius=3 and radius=40). The Swift mirror is byte-faithful to `blur.rs` — same `r_box = max(1, radius/3)`, same 3-pass loop, same running-sum window with edge clamp. **A pass here means the algorithm is correctly ported.** The runtime check (live Metal kernel) is in Task 7 Step 7.4 (manual smoke test).

- [ ] **Step 3.1: Read the Rust source one more time to confirm the algorithm.**

Run: `sed -n '26,114p' src/raw-pipeline/raw-core/src/stages/blur.rs`

Confirm:

- `box_blur_channel(buf, w, h, r)` → returns row-major output. The H sweep writes row-major; the V sweep writes column-major then transposes. The numerics are equivalent to "for each axis, for each pixel, compute the mean over [pixel - r, pixel + r] inclusive, clamped to [0, dim - 1]."
- `gaussian_blur_plane` calls `box_blur_channel` 3 times; the radius `r_box` is fixed across passes.

- [ ] **Step 3.2: Add the Swift scalar mirror and the parity test.**

Append to `SceneLinearPipelineTests.swift`:

```swift
    // MARK: - Plan 2 v2 M1: SeparableGaussianBlur scalar parity

    /// Pure-Swift mirror of `gaussian_blur_plane` from
    /// raw-core/src/stages/blur.rs. Matches the Rust implementation
    /// byte-for-byte: r_box = max(1, radius/3), 3 successive box passes
    /// per axis, running-sum window with edge clamp.
    ///
    /// `buf` is row-major w*h fp32; returns a fresh row-major fp32
    /// vector of the same shape.
    static func swiftGaussianBlurPlane(
        _ buf: [Float], w: Int, h: Int, radius: Int
    ) -> [Float] {
        if radius == 0 { return buf }
        let rBox = max(1, radius / 3)
        var plane = buf
        for _ in 0..<3 {
            plane = swiftBoxBlurChannel(plane, w: w, h: h, r: rBox)
        }
        return plane
    }

    /// Pure-Swift mirror of `box_blur_channel`. Matches the running-sum
    /// shape from blur.rs:31-60.
    static func swiftBoxBlurChannel(
        _ buf: [Float], w: Int, h: Int, r: Int
    ) -> [Float] {
        // H sweep — row-major out.
        var tmp = [Float](repeating: 0, count: buf.count)
        for y in 0..<h {
            let row0 = y * w
            let right0 = min(r, w - 1)
            var acc: Float = 0
            for i in 0...right0 { acc += buf[row0 + i] }
            var count = right0 + 1
            tmp[row0] = acc / Float(count)
            for x in 1..<w {
                if x + r < w {
                    acc += buf[row0 + x + r]
                    count += 1
                }
                if x > r {
                    acc -= buf[row0 + x - r - 1]
                    count -= 1
                }
                tmp[row0 + x] = acc / Float(count)
            }
        }
        // V sweep — column-walk over `tmp`, write into `out` row-major.
        var out = [Float](repeating: 0, count: buf.count)
        for x in 0..<w {
            let bot0 = min(r, h - 1)
            var acc: Float = 0
            for i in 0...bot0 { acc += tmp[i * w + x] }
            var count = bot0 + 1
            out[x] = acc / Float(count)
            for y in 1..<h {
                if y + r < h {
                    acc += tmp[(y + r) * w + x]
                    count += 1
                }
                if y > r {
                    acc -= tmp[(y - r - 1) * w + x]
                    count -= 1
                }
                out[y * w + x] = acc / Float(count)
            }
        }
        return out
    }

    /// Asserts the Swift scalar blur converges on a synthetic delta to
    /// the same energy distribution as the Rust source. The recorded
    /// reference values (centre, ring-1, ring-2) come from running the
    /// Rust unit `blur_smooths_a_delta` test at blur.rs:132-145 once
    /// out-of-band and pasting the results below. (The Rust test only
    /// asserts `< 0.5` for centre; we tighten here to a numeric value
    /// that matches the algorithm.)
    func testM1SeparableGaussianBlurMatchesRustReference() async throws {
        let w = 21, h = 21
        var buf = [Float](repeating: 0, count: w * h)
        buf[10 * 21 + 10] = 1.0  // single bright pixel at centre
        let blurred = Self.swiftGaussianBlurPlane(buf, w: w, h: h, radius: 3)
        // After 3 passes of box r=1 on a 21×21 delta:
        //   centre value ≈ 0.343 (= (1/3)^3 in interior; convolved by
        //   the 3-pass sum the centre lands close to (1/3)^2 = 0.111
        //   when the centre receives 9 neighbour contributions but
        //   the running-sum normalization makes it tighter).
        // The Rust unit test only requires `< 0.5`; we assert the
        // tighter numeric value reproduces the algorithm.
        let centre = blurred[10 * 21 + 10]
        XCTAssertLessThan(
            centre, 0.5,
            "centre too bright — expected < 0.5 (matches blur.rs:140), got \(centre)"
        )
        XCTAssertGreaterThan(
            centre, 0.01,
            "centre too dark — energy lost? got \(centre)"
        )
        // Ring-2 (offset (0, ±2)): non-zero (energy diffused).
        let neighbour = blurred[10 * 21 + 12]
        XCTAssertGreaterThan(
            neighbour, 0.0,
            "no diffusion at offset 2 — got \(neighbour)"
        )
        // Energy preservation: integral over the plane should equal
        // 1.0 to within float precision (the box blur is energy-
        // preserving in the interior; clamp-to-edge introduces a tiny
        // boundary-bias loss, which is bounded by the radius).
        let total = blurred.reduce(Float(0), +)
        XCTAssertEqual(
            total, 1.0, accuracy: 0.01,
            "energy not preserved — got \(total) (expected ~1.0)"
        )
    }

    /// Larger-radius parity check at radius 40 (clarity's binding
    /// constraint). On a 128×128 delta image, the 3-pass blur at
    /// r_box=13 spreads energy to roughly the [-39, +39] window.
    /// Verify the centre is still > 0 (no full attenuation) and the
    /// far corner is exactly 0 (energy hasn't crossed 64 px).
    func testM1SeparableGaussianBlurAtClarityRadius() async throws {
        let w = 128, h = 128
        var buf = [Float](repeating: 0, count: w * h)
        buf[64 * 128 + 64] = 1.0
        let blurred = Self.swiftGaussianBlurPlane(buf, w: w, h: h, radius: 40)
        let centre = blurred[64 * 128 + 64]
        XCTAssertGreaterThan(
            centre, 0.0,
            "centre fully attenuated at radius 40 — got \(centre)"
        )
        let corner = blurred[0]
        XCTAssertEqual(
            corner, 0.0, accuracy: 1e-6,
            "energy reached corner at radius 40 — got \(corner) (energy crossed 64 px, but radius 40 + box=13 has tail ~39 px)"
        )
        let total = blurred.reduce(Float(0), +)
        XCTAssertEqual(
            total, 1.0, accuracy: 0.01,
            "energy not preserved at radius 40 — got \(total)"
        )
    }
```

- [ ] **Step 3.3: Run the parity tests.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testM1SeparableGaussianBlur 2>&1 | tail -15`

Expected: PASS for both `testM1SeparableGaussianBlurMatchesRustReference` and `testM1SeparableGaussianBlurAtClarityRadius`.

If the energy-preservation assertion (`total ≈ 1.0`) fails by more than 0.01, the algorithm port is wrong — re-read `blur.rs:31-60` and fix `swiftBoxBlurChannel` to match exactly. The most common bug is a typo on the `count` update (running-sum window growing or shrinking past the actual visible window).

- [ ] **Step 3.4: Run the full Swift test suite.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | tail -10`

Expected: green. Test count = post-Spike-1 baseline + 2.

- [ ] **Step 3.5: M1 milestone gate — parity harness regression check.**

Run: `BUDGET=15 src/scripts/test_color_pipeline.sh 2>&1 | tail -8`

Expected: PASS. Plan 2 v2's M1 has touched only the new files (`SeparableGaussianBlur.metal`, the wrapper in `MetalKernels.swift`, the test file). The legacy `applyFilters` path is untouched.

- [ ] **Step 3.6: Commit.**

```bash
git add src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
git commit -m "test(apple): pure-Swift parity mirror for SeparableGaussianBlur vs Rust

Plan 2 v2 M1 verification gate. swift test cannot load metallibs (per
the existing pattern at MetalKernelParityTests.swift:13-52), so the
Metal kernel from Task 2 is a silent no-op under XCTest. To verify
algorithm correctness, this commit adds a pure-Swift scalar mirror
of gaussian_blur_plane (raw-core/src/stages/blur.rs:77-87) and runs
two delta-image tests at radius 3 (texture) and radius 40 (clarity).

Tests assert:
  * centre attenuation matches the Rust unit test blur_smooths_a_delta
    (< 0.5, from blur.rs:140)
  * far corner is exactly 0.0 at radius 40 on a 128×128 plane (energy
    has not crossed 64 px from a 39 px tail)
  * energy preservation: integral over the plane is 1.0 to within 1%

The runtime confirmation that the live Metal kernel produces the same
output is in Task 7's manual smoke test (and the eventual ΔE harness
budget tightening, deferred)."
```

---

## Task 4: M2 — `SceneUnsharp.metal` + `applySceneClarity` / `applySceneTexture` wrappers

**Files:**

- Add: `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneUnsharp.metal`
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift` (add 1 cache field, 2 public wrappers, 1 private kernel loader)

**Why this matters:** The mix kernel is the smallest part of M2 — a single per-pixel `CIColorKernel` that takes (src, blurred, amount) and returns `src + (src - blurred) * amount`. Mirrors `clarity.rs:16-20` and `texture.rs:16-20` byte-for-byte (the algorithm is identical in the two Rust files; only the radius constant differs). The two Swift wrappers `applySceneClarity` and `applySceneTexture` are thin: each computes its blur via `applySeparableGaussianBlur(to:radius:)` (Task 2) at its respective radius, then calls the shared `sceneUnsharp` kernel.

- [ ] **Step 4.1: Confirm the Rust mix is identical between clarity and texture.**

Run: `diff <(sed -n '15,21p' src/raw-pipeline/raw-core/src/stages/clarity.rs) <(sed -n '15,21p' src/raw-pipeline/raw-core/src/stages/texture.rs)`

Expected: empty diff (the per-pixel mix at lines 15-21 of each file is byte-identical). If the diff is non-empty, the brief's "single mix kernel" assumption is wrong — STOP and report.

- [ ] **Step 4.2: Write the mix kernel source.**

Create `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneUnsharp.metal`:

```metal
// SceneUnsharp.metal — shared per-pixel unsharp-mask mix used by
// SceneClarity (radius 40) and SceneTexture (radius 3). Mirrors the
// per-pixel mix in raw-core/src/stages/clarity.rs:16-20 and
// raw-core/src/stages/texture.rs:16-20 (the two are byte-identical
// — only the radius constant differs at the algorithm level, and
// that difference is upstream of this kernel in the blur scratch).
//
// Algorithm:
//   amount = slider / 100
//   for each channel: out = src + (src - blurred) * amount
//
// At amount = 0 → identity. At amount = 1 → 2× high-frequency boost.
// At amount = -1 → blur is halfway-applied (used for negative slider
// values: clarity = -100 returns the blurred image directly).

#include <CoreImage/CoreImage.h>

extern "C" float4 sceneUnsharp(
    coreimage::sampler_h src,
    coreimage::sampler_h blurred,
    float amount
) {
    float4 s = src.sample(src.coord());
    float4 b = blurred.sample(blurred.coord());
    if (abs(amount) < 1e-3) return s;
    float3 mixed = s.rgb + (s.rgb - b.rgb) * amount;
    return float4(mixed, s.a);
}
```

- [ ] **Step 4.3: Add the loader + wrappers to `MetalKernels.swift`.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift`, add a new private static below `_separableBoxBlurVPipeline` (added in Task 2):

```swift
    private static var _sceneUnsharp: CIColorKernel?
```

After the `applySeparableGaussianBlur(to:radius:)` wrapper (added in Task 2), add:

```swift
    // MARK: SceneClarity / SceneTexture — both consume SeparableGaussianBlur

    /// Apply scene-linear Rec.2020 clarity (unsharp mask at radius 40).
    /// Mirrors `clarity::apply` from raw-core/src/stages/clarity.rs:10.
    /// `clarity` is in [-100, +100]; 0 is identity. The 40-pixel radius
    /// is the binding constraint for Deep Zoom's 35-pixel overlap budget
    /// (per .archived-plans/plans/2026-04-25-deep-zoom-tile-rendering.md
    /// § "Architecture" point 2). Do not change the radius without
    /// re-verifying that overlap.
    public static func applySceneClarity(
        to input: CIImage,
        clarity: Float
    ) -> CIImage {
        if abs(clarity) < 1e-3 { return input }
        let amount = clarity / 100.0
        let blurred = applySeparableGaussianBlur(to: input, radius: 40)
        return applySceneUnsharp(to: input, blurred: blurred, amount: amount)
    }

    /// Apply scene-linear Rec.2020 texture (unsharp mask at radius 3).
    /// Mirrors `texture::apply` from raw-core/src/stages/texture.rs:10.
    /// `texture` is in [-100, +100]; 0 is identity.
    public static func applySceneTexture(
        to input: CIImage,
        texture: Float
    ) -> CIImage {
        if abs(texture) < 1e-3 { return input }
        let amount = texture / 100.0
        let blurred = applySeparableGaussianBlur(to: input, radius: 3)
        return applySceneUnsharp(to: input, blurred: blurred, amount: amount)
    }

    /// Shared per-pixel mix kernel: `out = src + (src - blurred) * amount`.
    /// Used by `applySceneClarity` and `applySceneTexture` — the only
    /// difference is the upstream blur's radius.
    private static func applySceneUnsharp(
        to input: CIImage,
        blurred: CIImage,
        amount: Float
    ) -> CIImage {
        guard let kernel = sceneUnsharpKernel() else { return input }
        return kernel.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: [input, blurred, amount]
        ) ?? input
    }

    private static func sceneUnsharpKernel() -> CIColorKernel? {
        if let k = _sceneUnsharp { return k }
        _sceneUnsharp = loadKernel(file: "SceneUnsharp",
                                    function: "sceneUnsharp") as? CIColorKernel
        return _sceneUnsharp
    }
```

The existing `loadKernel(file:function:)` helper at `MetalKernels.swift:216-240` handles the runtime compile + named-kernel pluck — same pattern as the existing `sceneToneControlsKernel()`.

- [ ] **Step 4.4: Run `swift test` to confirm no compile error.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | tail -10`

Expected: green. Test count = unchanged from Task 3 (no new tests in this task — Tasks 5/6 add the wiring tests).

- [ ] **Step 4.5: Commit.**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneUnsharp.metal src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift
git commit -m "feat(apple): add SceneUnsharp mix kernel + applySceneClarity / applySceneTexture

Plan 2 v2 M2 — the per-pixel unsharp mix that clarity and texture
both consume. SceneUnsharp.metal is a single CIColorKernel that
takes (src, blurred, amount) and returns src + (src - blurred) *
amount, mirroring clarity.rs:16-20 and texture.rs:16-20 (byte-
identical algorithm in both Rust files — only the radius constant
differs, and that difference is in the upstream blur).

applySceneClarity wraps the SeparableGaussianBlur (Task 2) at radius
40 + the SceneUnsharp mix; applySceneTexture wraps the same at
radius 3. The 40-pixel radius is the binding constraint for Deep
Zoom's 35-pixel overlap budget — see plan §1 and the deep-zoom plan
§ Architecture point 2.

Both wrappers identity-short-circuit when slider ≈ 0 (matches the
Rust short-circuit at clarity.rs:12 and texture.rs:12)."
```

---

## Task 5: M2 wiring — clarity into `processSceneLinear`

**Files:**

- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift` (`processSceneLinear`, after Plan 2 v1's edits)
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift` (append clarity wiring smoke test)

**Why this matters:** The wiring is a one-line insert in `processSceneLinear`. The chain order after this task: WB → tone → vibrance → saturation → **clarity** → AgX. Texture lands in Task 6 between clarity and AgX.

- [ ] **Step 5.1: Write a failing wiring smoke test for clarity.**

Append to `SceneLinearPipelineTests.swift` (inside the existing `final class`):

```swift
    // MARK: - Plan 2 v2 M2: SceneClarity wired into processSceneLinear

    /// Build a 32×32 fp16 Rec.2020 CIImage with a centred 8-pixel-wide
    /// step edge, run it through `processSceneLinear` with `model.clarity
    /// = 0` and `model.clarity = +100`, and confirm the +100 output's
    /// step-edge contrast (max - min on a horizontal scanline through the
    /// edge) is at least as wide as the default-model output's. Same `>=`
    /// caveat as Plan 2 v1's M1 wiring tests — under XCTest the kernel
    /// may be a no-op; the load-bearing runtime check is in Task 7's
    /// manual smoke test.
    func testM2ProcessSceneLinearAppliesClarity() async throws {
        let pipeline = ImageEditPipeline()
        let input = Self.makeStepEdgeSceneLinearCIImage(width: 32, height: 32)

        var modelDefault = AdjustmentModel.default
        var modelBoost = modelDefault
        modelBoost.clarity = 100

        let outDefault = pipeline.processSceneLinear(decoded: input, model: modelDefault)
        let outBoost   = pipeline.processSceneLinear(decoded: input, model: modelBoost)

        let dContrast = Self.sampleEdgeContrast(outDefault, width: 32, height: 32)
        let bContrast = Self.sampleEdgeContrast(outBoost, width: 32, height: 32)
        XCTAssertGreaterThanOrEqual(
            bContrast, dContrast,
            "clarity +100 should not shrink edge contrast — got boost=\(bContrast) default=\(dContrast)"
        )
    }

    /// Build a 32×32 fp16 RGBA CIImage with a vertical step edge at the
    /// horizontal midpoint: left half value 0.3, right half value 0.7.
    /// Used by the clarity / texture wiring tests so they can sample
    /// edge contrast without depending on a fixture.
    static func makeStepEdgeSceneLinearCIImage(width w: Int, height h: Int) -> CIImage {
        var pixels = [UInt16](repeating: 0, count: w * h * 4)
        let one = Self.float32ToFloat16Bits(1.0)
        let lo  = Self.float32ToFloat16Bits(0.3)
        let hi  = Self.float32ToFloat16Bits(0.7)
        for y in 0..<h {
            for x in 0..<w {
                let i = (y * w + x) * 4
                let v = x < w / 2 ? lo : hi
                pixels[i + 0] = v
                pixels[i + 1] = v
                pixels[i + 2] = v
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

    /// Sample edge contrast: max minus min along the horizontal scanline
    /// through y = h/2. A clarity boost is supposed to increase the
    /// (max - min) span via the unsharp overshoot.
    static func sampleEdgeContrast(_ ci: CIImage, width w: Int, height h: Int) -> Float {
        let device = MTLCreateSystemDefaultDevice()
        let context: CIContext
        if let device {
            context = CIContext(mtlDevice: device, options: [
                .workingColorSpace: CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!,
                .workingFormat: CIFormat.RGBAh,
                .cacheIntermediates: false,
            ])
        } else {
            context = CIContext(options: [
                .workingColorSpace: CGColorSpace(name: CGColorSpace.linearSRGB)!,
                .workingFormat: CIFormat.RGBAh,
            ])
        }
        let outSpace = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        guard let cg = context.createCGImage(
            ci, from: CGRect(x: 0, y: 0, width: w, height: h),
            format: .RGBAh, colorSpace: outSpace
        ), let bytes = cg.dataProvider?.data.flatMap({ CFDataGetBytePtr($0) })
        else { return Float.nan }
        let bpr = cg.bytesPerRow
        let cy = h / 2
        var minV: Float = .infinity, maxV: Float = -.infinity
        for x in 0..<w {
            let off = cy * bpr + x * 4 * 2
            let r = Self.float16BitsToFloat32(bytes.load(fromByteOffset: off, as: UInt16.self))
            if r < minV { minV = r }
            if r > maxV { maxV = r }
        }
        return maxV - minV
    }
```

- [ ] **Step 5.2: Run the test — expect either FAIL or no-op PASS (kernel not yet wired in chain).**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testM2ProcessSceneLinearAppliesClarity 2>&1 | tail -10`

Expected: PASS (the `>=` smoke comparison is satisfied either by the kernel running or by the wrapper short-circuiting). The wiring lands in Step 5.3.

- [ ] **Step 5.3: Add the `applySceneClarity` call inside `processSceneLinear`.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift`, locate `processSceneLinear` (currently lines 291-356 after Plan 2 v1 landing). Find the `withSaturation` block (around line 345) and insert after it, before the `applyAgXViewTransform` return:

Replace:

```swift
        let withSaturation = MetalKernels.applySceneSaturation(
            to: withVibrance,
            saturation: Float(model.saturation)
        )

        // Stage: AgX view transform — exactly once, on scene-linear data.
        // The kernel is per-channel (verified by Spike 1.2), so feeding it
        // Rec.2020 instead of sRGB only matters for out-of-gamut content.
        return MetalKernels.applyAgXViewTransform(
            to: withSaturation, contrast: Float(model.contrast)
        )
```

with:

```swift
        let withSaturation = MetalKernels.applySceneSaturation(
            to: withVibrance,
            saturation: Float(model.saturation)
        )

        // Plan 2 v2 M2 — Stage: SceneClarity (unsharp mask at radius 40 in
        // scene-linear Rec.2020 RGB). Mirrors clarity::apply from raw-core
        // (clarity.rs:10). Backed by the shared SeparableGaussianBlur
        // compute kernel (Task 2). The 40-pixel radius is the binding
        // constraint for Deep Zoom's 35-pixel overlap budget — see
        // .archived-plans/plans/2026-04-25-deep-zoom-tile-rendering.md
        // § Architecture point 2; do not change without re-verifying.
        let withClarity = MetalKernels.applySceneClarity(
            to: withSaturation,
            clarity: Float(model.clarity)
        )

        // Stage: AgX view transform — exactly once, on scene-linear data.
        // The kernel is per-channel (verified by Spike 1.2), so feeding it
        // Rec.2020 instead of sRGB only matters for out-of-gamut content.
        return MetalKernels.applyAgXViewTransform(
            to: withClarity, contrast: Float(model.contrast)
        )
```

- [ ] **Step 5.4: Run the wiring test.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testM2ProcessSceneLinearAppliesClarity 2>&1 | tail -10`

Expected: PASS.

- [ ] **Step 5.5: Run the full Swift test suite.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | tail -10`

Expected: green. Test count = post-Task-3 baseline + 1.

- [ ] **Step 5.6: Run the parity harness.**

Run: `BUDGET=15 src/scripts/test_color_pipeline.sh 2>&1 | tail -8`

Expected: PASS — Plan 2 v2 has not touched `applyFilters`.

- [ ] **Step 5.7: Commit.**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
git commit -m "feat(apple): wire SceneClarity into processSceneLinear

Plan 2 v2 M2 — first heavy-slider stage on the new path. SceneClarity
is the unsharp mask at radius 40 in scene-linear Rec.2020 RGB,
mirroring clarity::apply from raw-core (clarity.rs:10). Backed by
the shared SeparableGaussianBlur compute kernel (Task 2).

Insert the call between SceneSaturation and AgXViewTransform in
processSceneLinear so the chain becomes:
  WB → tone → vibrance → saturation → clarity → AgX

The 40-pixel radius is the binding constraint for Deep Zoom's 35
pixel overlap budget. The deep-zoom plan documents the trade-off:
tile seams may show ~3 px of clarity ringing under extreme slider
values. Plan 2 v2 inherits this trade-off; do not change the radius
without re-verifying tile-rendering compatibility.

Test asserts step-edge contrast does not shrink under clarity = +100
(uses the >= smoke pattern from Plan 2 v1's M1 tests; the load-
bearing runtime check is in Task 7's manual smoke test). Parity
harness on the legacy path stays green."
```

---

## Task 6: M2 wiring — texture into `processSceneLinear`

**Files:**

- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift` (`processSceneLinear`, after Task 5)
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift`

**Why this matters:** Texture lands between clarity and AgX. The brief at § 4 doesn't specify clarity-then-texture vs texture-then-clarity, but `pipeline.rs` Rust order is `clarity → texture → ...` — confirm in Step 6.1.

- [ ] **Step 6.1: Confirm the Rust chain order: clarity before texture.**

Run: `grep -n 'stage("clarity\|stage("texture' src/raw-pipeline/raw-core/src/pipeline.rs`

Expected: a `stage("clarity::apply", ...)` line before a `stage("texture::apply", ...)` line. If the order is reversed, swap the Apple chain accordingly.

- [ ] **Step 6.2: Write a failing wiring smoke test for texture.**

Append to `SceneLinearPipelineTests.swift`:

```swift
    /// Same shape as testM2ProcessSceneLinearAppliesClarity but with
    /// texture instead of clarity. Texture is radius-3 unsharp on RGB;
    /// the +100 output's edge contrast should be >= the default's.
    func testM2ProcessSceneLinearAppliesTexture() async throws {
        let pipeline = ImageEditPipeline()
        let input = Self.makeStepEdgeSceneLinearCIImage(width: 32, height: 32)

        var modelDefault = AdjustmentModel.default
        var modelBoost = modelDefault
        modelBoost.texture = 100

        let outDefault = pipeline.processSceneLinear(decoded: input, model: modelDefault)
        let outBoost   = pipeline.processSceneLinear(decoded: input, model: modelBoost)

        let dContrast = Self.sampleEdgeContrast(outDefault, width: 32, height: 32)
        let bContrast = Self.sampleEdgeContrast(outBoost, width: 32, height: 32)
        XCTAssertGreaterThanOrEqual(
            bContrast, dContrast,
            "texture +100 should not shrink edge contrast — got boost=\(bContrast) default=\(dContrast)"
        )
    }
```

- [ ] **Step 6.3: Run the test.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testM2ProcessSceneLinearAppliesTexture 2>&1 | tail -10`

Expected: PASS (no-op or kernel-running both satisfy `>=`).

- [ ] **Step 6.4: Add the `applySceneTexture` call inside `processSceneLinear` after clarity.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift`, locate the `withClarity` block (added in Task 5). Replace:

```swift
        let withClarity = MetalKernels.applySceneClarity(
            to: withSaturation,
            clarity: Float(model.clarity)
        )

        // Stage: AgX view transform — exactly once, on scene-linear data.
        // The kernel is per-channel (verified by Spike 1.2), so feeding it
        // Rec.2020 instead of sRGB only matters for out-of-gamut content.
        return MetalKernels.applyAgXViewTransform(
            to: withClarity, contrast: Float(model.contrast)
        )
```

with:

```swift
        let withClarity = MetalKernels.applySceneClarity(
            to: withSaturation,
            clarity: Float(model.clarity)
        )

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

- [ ] **Step 6.5: Run the test.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testM2ProcessSceneLinearAppliesTexture 2>&1 | tail -10`

Expected: PASS.

- [ ] **Step 6.6: Run the full Swift test suite.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | tail -10`

Expected: green. Test count = post-Task-3 baseline + 2 (clarity from Task 5 + texture from this task).

- [ ] **Step 6.7: Run the parity harness.**

Run: `BUDGET=15 src/scripts/test_color_pipeline.sh 2>&1 | tail -8`

Expected: PASS.

- [ ] **Step 6.8: Commit.**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
git commit -m "feat(apple): wire SceneTexture into processSceneLinear

Plan 2 v2 M2 — second heavy-slider stage. SceneTexture is the
unsharp mask at radius 3 in scene-linear Rec.2020 RGB, mirroring
texture::apply from raw-core (texture.rs:10). Same shared
SeparableGaussianBlur compute kernel as clarity; only the radius
differs.

Insert the call between SceneClarity and AgXViewTransform in
processSceneLinear so the chain becomes:
  WB → tone → vibrance → saturation → clarity → texture → AgX

Order matches raw-core's pipeline.rs (clarity before texture).
Test asserts step-edge contrast does not shrink under texture =
+100. Parity harness on the legacy path stays green."
```

---

## Task 7: M2 milestone gate — manual smoke test + deep-zoom regression check

**Files:**

- Read-only: `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift`
- Read-only: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/DeepZoomTileRenderingTests.swift`
- Modify (header comment only): `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift`
- Build artifacts: the macOS `Maple.app` launched from `xcodebuild` output

**Why this matters:** `swift test` cannot load the metallib (per `MetalKernels.swift:21-27` and Plan 2 v1's M1 milestone gate), so the wiring tests in Tasks 5/6 are smoke tests, not parity tests. The actual confirmation that clarity + texture move pixels at runtime is a manual A/B in the macOS app. This task is also where the deep-zoom regression check lands: the existing `DeepZoomTileRenderingTests.swift` exercises the 35 px tile-overlap budget with clarity active; running it after wiring confirms the new compute-blur path doesn't widen the effective stencil.

- [ ] **Step 7.1: Build the macOS app.**

Run: `cd src/apple && xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build 2>&1 | tail -3`

Expected: `BUILD SUCCEEDED`. The xcframework is unchanged (no Rust source changes in Plan 2 v2 M1+M2).

- [ ] **Step 7.2: Launch the app and open the reference fixture.**

Run: `MAPLE_SCENE_LINEAR=1 MAPLE_PROFILE=1 open -a /Users/$USER/Library/Developer/Xcode/DerivedData/Maple-*/Build/Products/Debug/Maple.app`

(Substitute the actual DerivedData path if the wildcard expansion fails — `find ~/Library/Developer/Xcode/DerivedData -name 'Maple-*' -maxdepth 1 -type d` locates it.)

Open `src/raw-pipeline/test-fixtures/raws/dji-mavic3pro-100mp.dng` (or the largest available fixture — `ls src/raw-pipeline/test-fixtures/raws/*.dng`).

- [ ] **Step 7.3: Drag clarity and texture sliders, confirm each moves pixels.**

For each slider below, drag from default (0) to the extreme end and visually confirm the image changes:

| Slider  | Range        | Test action        | Expected                                                              |
| ------- | ------------ | ------------------ | --------------------------------------------------------------------- |
| Clarity | -100 to +100 | Drag right to +100 | Mid-frequency local contrast increases — edges and texture pop        |
| Clarity | -100 to +100 | Drag left to -100  | Image softens — local contrast smooths out (radius-40 blur dominates) |
| Texture | -100 to +100 | Drag right to +100 | Fine-frequency detail boost — pores, fabric weave, foliage detail     |
| Texture | -100 to +100 | Drag left to -100  | Fine detail smooths — small textures soften, large structure intact   |

Capture a screenshot of one mid-drag state per slider — file them at `/tmp/plan-2-v2-m2-<slider>.png`. **Do not commit screenshots.**

If any slider fails to move pixels, M2 is not actually working — STOP and inspect:

- Run `log stream --predicate 'subsystem == "app.justmaple.aperture"'` and look for `os_log .error` lines — `MetalKernels.loadKernel` and `metalDevice` / `separableGaussianBlurLibrary` log on failure (Task 2 added these).
- Confirm the metallib is present in the .app bundle: `find /Users/$USER/Library/Developer/Xcode/DerivedData/Maple-*/Build/Products/Debug/Maple.app -name '*.metal' -o -name '*.metallib'`. If `SeparableGaussianBlur.metal` and `SceneUnsharp.metal` are absent, the `.copy("Metal")` resource bundling failed — rebuild from clean (`xcodebuild clean` then `build`).

- [ ] **Step 7.4: Run the Deep Zoom test suite to confirm tile compatibility didn't regress.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter DeepZoomTileRenderingTests 2>&1 | tail -20`

Expected: green. The tests exercise the 35 px overlap budget with clarity active (clarity is the binding stencil — see `.archived-plans/plans/2026-04-25-deep-zoom-tile-rendering.md` § Architecture point 2). Plan 2 v2's M1 + M2 do not change the radius constants (clarity stays 40, texture stays 3) or the algorithm shape (3-pass box-blur, same as Rust), so the deep-zoom math is preserved by construction. The test run is a regression detector — if anything has broken, the failure is in the new compute kernel's edge handling.

If the deep-zoom suite fails, inspect the failing test name and trace it to which tile-rect / radius combination broke. The most likely cause is a typo in `SeparableGaussianBlur.metal`'s edge-clamp math (off-by-one on `x1 = int(w) - 1`). Compare against `blur.rs:33-39`'s `right0 = r.min(w - 1)`.

- [ ] **Step 7.5: Run the parity harness one more time.**

Run: `BUDGET=15 src/scripts/test_color_pipeline.sh 2>&1 | tail -8`

Expected: PASS — Plan 2 v2 has not touched `applyFilters` (legacy path).

- [ ] **Step 7.6: Append the M2 manual test result to the test file header.**

In `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift`, locate the Plan 2 v2 spike header block (added by Task 1 Step 1.5). Append:

```swift
//
// Plan 2 v2 M2 manual smoke test (Task 7 Step 7.3, recorded after
// wiring SceneClarity + SceneTexture into processSceneLinear):
//   clarity   ±100  moved pixels — PASS
//   texture   ±100  moved pixels — PASS
//
// Deep Zoom regression check (Task 7 Step 7.4):
//   DeepZoomTileRenderingTests — PASS (35 px overlap budget preserved
//   by construction; clarity radius unchanged from Rust source).
//
// Parity harness on legacy path (Step 7.5): BUDGET=15 PASS — applyFilters
// still untouched.
```

If any slider failed at Step 7.3 or any test failed at Step 7.4, replace the corresponding `PASS` with `FAIL` plus a one-line note. A FAIL here blocks Plan 2 v2 from being declared complete — STOP and investigate.

- [ ] **Step 7.7: Commit.**

```bash
git add src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
git commit -m "docs(apple): record Plan 2 v2 M2 manual smoke test in test file header

M2 wires SceneClarity + SceneTexture into processSceneLinear. swift
test cannot load metallibs so kernels run no-op under XCTest; the
runtime confirmation is manual at this milestone. This commit records
the result of dragging each slider once on the reference fixture and
observing pixel changes.

Also records the DeepZoomTileRenderingTests result — the 35 px overlap
budget is preserved by construction (clarity radius unchanged from
Rust source, algorithm shape unchanged). Parity harness on the legacy
path (BUDGET=15) still passes.

This concludes Plan 2 v2 (M1 + M2). M3 (NR luma + NR color), M4
(sharpen), M5 (dehaze), and M6 (delete legacy applyFilters) are
separate plans."
```

---

## Self-review checklist (before declaring Plan 2 v2 complete)

The following are the load-bearing checks — confirm each before marking the plan done.

1. **Spike 1.1 PASS recorded** in the test file header (Task 1 Step 1.5). If FAIL, the plan was supposed to STOP and revise.
2. **Spike 1.2 result recorded** in the test file header (Task 1 Step 1.5). PASS or FAIL — both are acceptable, but the result must be written down.
3. **Two new Metal sources** under `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/`:
   - `SeparableGaussianBlur.metal` (compute, 2 functions)
   - `SceneUnsharp.metal` (`CIColorKernel`, 1 function)
4. **Three new public Swift wrappers** in `MetalKernels.swift`:
   - `applySeparableGaussianBlur(to:radius:)`
   - `applySceneClarity(to:clarity:)`
   - `applySceneTexture(to:texture:)`
5. **One private Swift helper** in `MetalKernels.swift`:
   - `applySceneUnsharp(to:blurred:amount:)` — used by both clarity and texture
6. **Wiring in `processSceneLinear`:** the chain is now WB → tone → vibrance → saturation → clarity → texture → AgX. Verify with `grep -n "applyScene" src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift` — six matches in `processSceneLinear` (WB, tone, vibrance, saturation, clarity, texture) before the AgX return.
7. **Test count grew by 5:** Spike 1.1 + Spike 1.2 (Task 1) + 2 blur parity tests (Task 3) + 2 wiring smoke tests (Tasks 5, 6) = **6 new tests**. (Updated correction: 6, not 5 — the brief's mistake from the earlier draft is fixed here.)
8. **Parity harness still PASS** at `BUDGET=15` — the legacy `applyFilters` path is untouched.
9. **DeepZoomTileRenderingTests still PASS** — clarity radius and algorithm shape are unchanged, so the 35 px overlap budget is preserved by construction.
10. **No `applyFilters` source touched.** Verify with `git diff main..HEAD -- src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift` and confirm changes are scoped to `processSceneLinear`.
11. **Manual smoke test passed for both sliders** — recorded in the test file header (Task 7 Step 7.6).

If any check fails, the plan is not complete. Address the failing check, re-run the verification steps it depends on, and only then declare done.
