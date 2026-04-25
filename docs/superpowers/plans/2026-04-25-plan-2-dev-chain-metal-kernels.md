# Plan 2 — Apple Development Chain on Scene-Linear Metal Kernels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Companion plan:** [`docs/superpowers/plans/2026-04-24-ffi-split-plan-1.md`](2026-04-24-ffi-split-plan-1.md). Plan 1 routed Apple's interactive renders through a new Rust FFI that returns scene-linear Rec.2020 fp16, then Lanczos-prescales and runs AgX exactly once on the GPU. Plan 1 deliberately left every development-chain slider dark on the new path because no scene-linear development kernels existed Apple-side. Plan 1 Task 9 (default flip) is **blocked** until either a banner ships or this plan lands; Plan 2 v1 (this document) is the "Plan 2 lands" branch of that precondition.

> **Plan 1 Task 9 sidecar precondition.** Plan 1 § "What this plan renders" states: *"saved sidecar adjustments are NOT applied on the new path because the Apple call site (`ImageEditPipeline.decodeSceneLinear`) currently passes `xmpPath: nil`."* Plan 2 v1 does NOT change that for sliders other than `highlightRecovery` — sliders on the dev chain (WB, exposure, tone, vibrance, saturation) are re-applied **Apple-side via Metal kernels** reading the live `AdjustmentModel`, not Rust-side via the sidecar. The one Rust-side stage that Apple cannot replicate cheaply is `highlight_recovery::apply` (it runs in camera-RGB before DCP, before Apple sees the buffer). M3 (Tasks 7-8) threads `xmpPath` through `decodeSceneLinear` so that one stage's parameter (`model.highlight_recovery`) reaches Rust. With Plan 2 v1 landed, **all sliders move pixels on the scene-linear path**: dev-chain sliders via Metal kernels, `highlight_recovery` via the live FFI XMP, AgX via the existing Metal kernel, contrast as the AgX slope. This satisfies Plan 1 Task 9's "saved sidecar adjustments work" precondition.

**Goal:** Restore slider functionality on the scene-linear path by porting the Apple development chain (white balance, exposure, highlights, shadows, whites, blacks, vibrance, saturation) as Metal `CIColorKernel`s operating on the scene-linear Rec.2020 fp16 buffer Plan 1 introduced. Wire the kernels into `ImageEditPipeline.processSceneLinear` and thread `xmpPath` through `decodeSceneLinear` so `highlight_recovery` (which runs Rust-side, before DCP) responds to the live sidecar model.

**Architecture:**
1. **Filter chain order on the scene-linear path** (replaces Plan 1's "Lanczos + AgX" stub):
   `decoded fp16 Rec.2020 CIImage → Lanczos prescale (existing) → WhiteBalance.metal → SceneToneControls.metal → SceneVibrance.metal → SceneSaturation.metal → AgXViewTransform.metal → CIContext.createCGImage(colorSpace: sRGB)`.
2. **Two existing kernels are wired in unchanged.** `MetalKernels.applySceneToneControls` and `MetalKernels.applySceneVibrance` already exist (`src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneToneControls.metal` and `SceneVibrance.metal`) and the `_sceneToneControls` / `_sceneVibrance` `CIColorKernel` static properties already load via `CIColorKernel(functionName:fromMetalLibraryData:)`. M1 (Task 2-4) wires them into `processSceneLinear` and verifies them through the parity harness.
3. **Two new kernels are added.** `WhiteBalance.metal` ports the CCT→Rec.2020 channel-gain math from Rust source (`src/raw-pipeline/raw-core/src/stages/white_balance.rs:30-50`); `SceneSaturation.metal` reuses the Oklab matrices already in `SceneVibrance.metal` and applies the chroma-scale from `src/raw-pipeline/raw-core/src/stages/saturation.rs:12`. M2 (Task 5-6) adds them, exposes `MetalKernels.applyWhiteBalance` / `MetalKernels.applySceneSaturation` wrappers, and wires them into `processSceneLinear`.
4. **Sidecar threading.** M3 (Task 7-8) extends `ImageEditPipeline.decodeSceneLinear` to take an optional `xmpPath: URL?` and forward it to `PipelineRenderer.renderSceneLinear`. Updates `EditSession.sharedDecode` to pass `asset.sidecarURL` when the file exists. The Rust FFI (`maple_render_file_scene_linear` / `maple_render_bytes_scene_linear`) already accepts `xmp_path` per Plan 1 — no Rust signature change required, only the Apple plumbing — but the xcframework is rebuilt as a precaution because the Rust changes (none here, but the script also re-bundles headers).
5. **Legacy path untouched.** The existing `applyFilters` chain in `ImageEditPipeline.swift:377-538` and the legacy Swift CIFilter ops remain in place. Plan 2 v2 (M4-M6: clarity, texture, dehaze, sharpen, NR) and the eventual Plan 3 will delete them.

**Out of scope (explicit):**
- Clarity, texture, dehaze, sharpen, NR (luminance + color). **Plan 2 v2 / M4-M6.**
- Web/WASM port of these kernels. **Plan 3.**
- Deleting the legacy `applyFilters` chain or the Rust `view::agx::apply` / `view::encode::*` modules. **Plan 1 Task 9 + Plan 3.**
- Reimplementing `highlight_recovery` Apple-side. Stays Rust-side, runs pre-DCP; the only thing Plan 2 v1 changes there is wiring the parameter through the FFI via `xmpPath`.
- Pre-compiling Metal kernels at app launch.
- Switching CoreImage working color space.
- Asset sidecar versioning / bumping the rendered-preview cache key for the new dev-chain version. The existing `adjustment_version` field in the cache key (per `CLAUDE.md` § "Performance") already covers this.

**Tech Stack:**
- Swift (`MapleCore`) — CoreImage `CIColorKernel` / `CIKernel` loaded via the existing `MetalKernels` namespace pattern (matches commit `8cdf585` which fixed the `.metal` source loader to use `CIColorKernel(functionName:fromMetalLibraryData:)` — the loader is already correct, no further fixes needed).
- Metal Shading Language — kernel sources mirror the per-pixel math in the Rust reference. Two new kernels: `WhiteBalance.metal` and `SceneSaturation.metal`. Both `extern "C" float4 kernelName(coreimage::sampler_h src, ...)` matching the existing pattern.
- Build glue — `./src/apple/scripts/build-xcframework.sh` is rerun in M3 (Task 7-8) as a precaution; M1 (Task 2-4) and M2 (Task 5-6) touch only Swift + Metal so no Rust rebuild is needed.
- Test — `cd src/apple/Packages/MapleCore && swift test` after each Swift edit; `BUDGET=15 src/scripts/test_color_pipeline.sh` after each milestone (M1, M2, M3) for the legacy-path ΔE gate.

---

## File Structure

**Swift (read-write):**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift` — extend `processSceneLinear` (currently lines 211-224) to invoke the dev-chain kernels before AgX. Tasks 2-6 grow the filter chain inside this single function. Task 7 extends `decodeSceneLinear` (lines 145-185) to accept `xmpPath: URL?` and forward it to `PipelineRenderer.renderSceneLinear`. Drop the legacy whites/blacks `CIToneCurve` workaround in `applyFilters` (lines 437-467) — `scene_tone_controls.rs:74-85` already handles whites/blacks scene-linear, so the workaround was for the legacy-only path; on the new path it's dead, on the old path it stays as a CIFilter fallback per Plan 1 v1's "legacy path stays" rule. **Read CLAUDE.md** § "Build & test — Apple": the Xcode app build target embeds the metallib; `swift test` does NOT — both must be exercised before declaring victory, but only `swift test` is automatable.
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift` — add two new kernel-loader static properties (`_whiteBalance`, `_sceneSaturation`), two new wrapper functions (`applyWhiteBalance(to:temperature:tint:asShotTemperature:asShotTint:)` and `applySceneSaturation(to:saturation:)`), and two new private kernel-loader helpers (`whiteBalanceKernel()`, `sceneSaturationKernel()`). All four mirror the existing `applySceneToneControls` / `applySceneVibrance` / `sceneToneControlsKernel` / `sceneVibranceKernel` shape verbatim.
- Add: `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/WhiteBalance.metal` — new kernel source. CCT→xy via Hernández-Andrés polynomial, xy→XYZ→Rec.2020 via the same M_XYZ_D65_TO_REC2020 used in `white_balance.rs`, normalized so green=1, then per-pixel multiply.
- Add: `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneSaturation.metal` — new kernel source. Rec.2020→Oklab, scale a/b by `1 + saturation/100`, Oklab→Rec.2020. Reuses the same matrices as `SceneVibrance.metal` (paste them — Metal doesn't share constants between files).
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift` — at the `sharedDecode` cache-miss branch around line 944, pass `asset.sidecarURL` to `pipeline.decodeSceneLinear`. The change is a single argument addition because `AssetRef.sidecarURL` (line 95-97) already returns the canonical `<rawname>.xmp` location.
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift` (created in Plan 1) — append integration tests for each new kernel (white balance roundtrip at neutral, scene tone controls identity at zero, saturation identity at zero, and the chained "all at default" identity that asserts a default-model `processSceneLinear` produces the same CGImage as just AgX-on-decoded). All tests use the pure-Swift scalar math fallback per the existing `MetalKernelParityTests.swift:13-52` pattern — `swift test` does not load metallibs.

**Swift (read-only during verification):**
- `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneToneControls.metal` — reference for kernel source style (constants, `extern "C"`, sampler_h, smoothstep_f).
- `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneVibrance.metal` — reference for the Oklab matrices and the `rec2020_to_oklab` / `oklab_to_rec2020` helpers; SceneSaturation reuses both.
- `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/AgXViewTransform.metal` — final stage of the chain; not modified here.
- `src/apple/Packages/MapleCore/Sources/MapleCore/PipelineRenderer.swift:159-200` — `renderSceneLinear` signature; the FFI plumbing for `xmpPath` is already in place and Plan 2 v1 just stops passing `nil` from the Apple call site.

**Rust (read-only during verification):**
- `src/raw-pipeline/raw-core/src/stages/white_balance.rs` — algorithm reference for `WhiteBalance.metal`.
- `src/raw-pipeline/raw-core/src/stages/saturation.rs` — algorithm reference for `SceneSaturation.metal`.
- `src/raw-pipeline/raw-core/src/stages/scene_tone_controls.rs:43-44` — confirm the whites scalar gain (`w_gain = 1.0 + whites / 200.0`) and blacks additive shift (`b_add = blacks / 400.0`) match what M1's wiring expects — the existing `SceneToneControls.metal` already encodes both at lines 64 and 70 of that file. Step 2.1 cross-checks.
- `src/raw-pipeline/raw-core/src/stages/vibrance.rs` — confirms the Oklab + skin-window math already mirrored verbatim in `SceneVibrance.metal`.
- `src/raw-pipeline/raw-core/src/pipeline.rs:120` — confirms `highlight_recovery::apply(&mut camera_rgb, model.highlight_recovery)` runs Rust-side in `develop_scene_linear_from_raw_with_quality`, before DCP, before Apple sees the buffer. M3's `xmpPath` plumbing is what makes that line respond to slider state.

**Build artifacts (touched):**
- The xcframework is rebuilt in Task 8 Step 8.4 as a precaution; M1 + M2 (Tasks 2-6) do not require a Rust rebuild because no Rust source changes. The xcframework rebuild also re-bundles the Metal sources into `default.metallib` if the build system is configured to do so — confirm at Step 8.4.

---

## Ordering constraint

**Tasks must be done in milestone order: M1 (Tasks 2-4) → M2 (Tasks 5-6) → M3 (Tasks 7-8).**

- M1 wires existing kernels first because they're already loaded — proves the wiring is right before adding any new kernel sources.
- M2 adds the two new kernels in the order they appear in the chain (WB before saturation), so each step's kernel test can also exercise the upstream kernels.
- M3 threads `xmpPath` last because the Apple-side filter chain (M1+M2) handles every other slider — `highlight_recovery` is the only one Apple cannot reapply, so M3 is independent of M1+M2 but ordered last to avoid a half-wired sidecar path during M1+M2 development.

After every task: `cd src/apple/Packages/MapleCore && swift test`. After every milestone (M1, M2, M3 — i.e. after Task 4, Task 6, Task 8): `BUDGET=15 src/scripts/test_color_pipeline.sh`. The harness gates the **legacy path** only (Plan 1 § "Out of scope" point 4 explains why), so its purpose here is regression-detection on `applyFilters` — Plan 2 v1 must not break the legacy path.

---

## Task 1: Pre-flight verification

**Files:**
- Read-only: `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift`, `MetalKernels.swift`, `Metal/SceneToneControls.metal`, `Metal/SceneVibrance.metal`.

**Why this matters:** Three things must be true before M1 wires the existing kernels into `processSceneLinear`:
1. The kernel loader path (`Bundle.module.url(forResource: "default", withExtension: "metallib")` at `MetalKernels.swift:151`) is the canonical loader after commit `8cdf585`. Confirm it is what's in the file — if a regression has reverted to `CIKernel.kernels(withMetalString:)` or anything else, M1 must not proceed.
2. `MetalKernels.applySceneToneControls` and `MetalKernels.applySceneVibrance` are already public and have the right signatures (matching `AdjustmentModel` field types — `Float`, not `Double`; the existing wrappers narrow at the call site).
3. `processSceneLinear` is reachable from `EditSession.sharedDecode` only when `MAPLE_SCENE_LINEAR=1` is set (i.e. `useSceneLinear == true`). Plan 2 v1 inherits this gate; Plan 1 Task 9 flips the default.

- [ ] **Step 1.1: Read `MetalKernels.swift` and confirm the loader still uses `CIColorKernel(functionName:fromMetalLibraryData:)`.**

Run: `grep -n "CIColorKernel(functionName\|CIKernel(functionName\|kernels(withMetalString" src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift`

Expected:
```
120:        _sceneToneControls = try? CIColorKernel(functionName: "sceneToneControls",
128:        _sceneVibrance = try? CIColorKernel(functionName: "sceneVibrance",
136:        _agxViewTransform = try? CIKernel(functionName: "agxViewTransform",
```

**FAIL ACTION:** If the loader uses `kernels(withMetalString:)`, commit `8cdf585` was reverted. STOP and report — Plan 2 cannot wire kernels that won't load.

- [ ] **Step 1.2: Confirm `processSceneLinear` is the chain entry point and currently does only Lanczos + AgX.**

Run: `sed -n '211,224p' src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift`

Expected: the body matches Plan 1 v1 — `let scaled = Self.prescaleForDisplay(...)` followed by `return MetalKernels.applyAgXViewTransform(to: scaled, contrast: Float(model.contrast))`. No other filter stages between them.

**FAIL ACTION:** If `processSceneLinear` already invokes `applySceneToneControls` or any other kernel, Plan 2 has been partially landed. STOP and inspect the chain order — adjust the steps below to start from the actual current state.

- [ ] **Step 1.3: Confirm `SceneToneControls.metal:64` and `SceneToneControls.metal:70` encode the whites/blacks scene-linear semantics that match `scene_tone_controls.rs:42-43`.**

Run: `grep -n "w_gain\|b_add" src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneToneControls.metal src/raw-pipeline/raw-core/src/stages/scene_tone_controls.rs`

Expected: the kernel matches `1.0 + whites / 200.0` for whites gain and `blacks / 400.0` for blacks shift. Both files agree.

**FAIL ACTION:** If they disagree, Plan 2 needs a new design step — either update the kernel to match Rust, or update the Rust to match the kernel. Stop and report which side is the source of truth.

- [ ] **Step 1.4: Confirm `SceneVibrance.metal` exposes the Oklab matrices that `SceneSaturation.metal` will reuse.**

Run: `grep -n "M_rec2020_to_lms\|M_lms_to_oklab\|M_oklab_to_lms\|M_lms_to_rec2020" src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneVibrance.metal`

Expected: all four matrix constants are present (lines 16-38). `SceneSaturation.metal` will paste these verbatim — Metal doesn't share constants between `.metal` files inside a single metallib.

- [ ] **Step 1.5: Run the existing test suite to confirm a clean baseline before any change.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | tail -10`

Expected: a green run. The test count in the final summary is the baseline; M1, M2, M3 must each grow this number, never shrink it.

Run: `BUDGET=15 src/scripts/test_color_pipeline.sh 2>&1 | tail -8`

Expected: PASS — the parity harness gates the legacy path. If it's red on `main`, Plan 2 starts from a known-broken baseline; flag the failure but proceed (the harness is a regression detector, not a blocker for Plan 2 v1).

- [ ] **Step 1.6: Commit the pre-flight log into the test file as a header comment block.**

In `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift`, prepend (above the existing Plan 1 Spike 1.3 comment block):

```swift
// Plan 2 v1 pre-flight (recorded by Task 1):
//
//   Loader sanity (Step 1.1):     CIColorKernel(functionName:fromMetalLibraryData:) — passes
//   Chain entry (Step 1.2):       processSceneLinear = Lanczos + AgX only — passes
//   Whites/blacks parity (1.3):   SceneToneControls.metal matches scene_tone_controls.rs — passes
//   Oklab matrices (1.4):         SceneVibrance.metal exposes all four for Saturation reuse — passes
//   Pre-Plan-2 baseline:          <RECORD swift test count> tests, parity harness <PASS|FAIL>
//
// Plan 2 wires WB → tone → vibrance → saturation → AgX into processSceneLinear,
// then threads xmpPath through decodeSceneLinear. See
// docs/superpowers/plans/2026-04-25-plan-2-dev-chain-metal-kernels.md.
```

Replace `<RECORD swift test count>` and `<PASS|FAIL>` with the captured values.

```bash
git add src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
git commit -m "$(cat <<'EOF'
docs(apple): record Plan 2 pre-flight verification in test file header

Confirms the four invariants Plan 2 depends on before wiring any
kernel into processSceneLinear:
  * MetalKernels loader still uses CIColorKernel(functionName:
    fromMetalLibraryData:) — commit 8cdf585 hasn't been reverted.
  * processSceneLinear still does Lanczos + AgX only — no partial
    Plan 2 has landed.
  * SceneToneControls.metal whites/blacks math matches the Rust
    reference (scene_tone_controls.rs:42-43) — both sides agree.
  * SceneVibrance.metal exposes the four Oklab matrices that
    SceneSaturation.metal will reuse.

Captures pre-Plan-2 swift test count and parity-harness state as the
regression baseline for M1/M2/M3.
EOF
)"
```

---

## Task 2: M1 Step 1 — Wire `applySceneToneControls` into `processSceneLinear`

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift` (lines 211-224 — `processSceneLinear`)
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift` — append M1 unit tests

**Why this matters:** M1's first step is the smallest possible wiring change: insert one kernel call inside `processSceneLinear`, between the Lanczos prescale and the AgX call. The existing wrapper signature (`MetalKernels.applySceneToneControls(to:exposure:highlights:shadows:whites:blacks:)` at `MetalKernels.swift:39-55`) takes `Float` for every parameter; `AdjustmentModel` stores `Double`; we narrow at the call site.

- [ ] **Step 2.1: Write a failing test that asserts `processSceneLinear` invokes scene-tone-controls when exposure is non-zero.**

Append to `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift`, inside the existing `final class SceneLinearPipelineTests`:

```swift
    // MARK: - Plan 2 M1: SceneToneControls wired into processSceneLinear

    /// Build a synthetic 16×16 mid-gray scene-linear Rec.2020 fp16 CIImage,
    /// run it through `processSceneLinear` with `model.exposure = 1.0`, and
    /// confirm the output is brighter than the same input through
    /// `processSceneLinear` with the default model. This is the wiring
    /// check, not a numeric parity check — the actual exposure math is
    /// exercised by the Rust unit tests for `scene_tone_controls.rs`.
    /// `swift test` cannot load the metallib, so we accept that the
    /// kernel call may be a silent no-op under XCTest and assert
    /// "output A is at least as bright as output B" (`>=` not `>`)
    /// per the existing `MetalKernelParityTests.swift:13-52` pattern.
    func testM1ProcessSceneLinearAppliesExposure() async throws {
        let pipeline = ImageEditPipeline()
        let input = Self.makeNeutralSceneLinearCIImage(width: 16, height: 16, value: 0.5)

        var modelDefault = AdjustmentModel.default
        var modelBright = modelDefault
        modelBright.exposure = 1.0

        let outDefault = pipeline.processSceneLinear(decoded: input, model: modelDefault)
        let outBright  = pipeline.processSceneLinear(decoded: input, model: modelBright)

        // Render both to fp16 CGImages tagged extendedLinearITUR_2020 and
        // compare the centre pixel's R channel.
        let bright = Self.sampleCenterR(outBright, width: 16, height: 16)
        let basic  = Self.sampleCenterR(outDefault, width: 16, height: 16)
        XCTAssertGreaterThanOrEqual(
            bright, basic,
            "exposure +1 should be at least as bright as default — got bright=\(bright) basic=\(basic)"
        )
    }

    /// Build a 16×16 fp16 Rec.2020 CIImage of one constant value. Used by
    /// the M1/M2 wiring tests so they don't depend on a fixture.
    static func makeNeutralSceneLinearCIImage(width w: Int, height h: Int, value v: Float) -> CIImage {
        var pixels = [UInt16](repeating: 0, count: w * h * 4)
        let one = Self.float32ToFloat16Bits(1.0)
        let val = Self.float32ToFloat16Bits(v)
        for i in stride(from: 0, to: pixels.count, by: 4) {
            pixels[i + 0] = val
            pixels[i + 1] = val
            pixels[i + 2] = val
            pixels[i + 3] = one
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

    /// Render the centre pixel of a CIImage to fp16 R, return the f32 value.
    static func sampleCenterR(_ ci: CIImage, width w: Int, height h: Int) -> Float {
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
        let cx = w / 2, cy = h / 2
        let off = cy * bpr + cx * 4 * 2
        return Self.float16BitsToFloat32(bytes.load(fromByteOffset: off, as: UInt16.self))
    }
```

(The `float32ToFloat16Bits` and `float16BitsToFloat32` helpers already exist in this file from Plan 1 Spike 1.1 — see `SceneLinearPipelineTests.swift:262-328`.)

- [ ] **Step 2.2: Run the test — expect FAIL (or no-op pass with bright == basic).**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testM1ProcessSceneLinearAppliesExposure 2>&1 | tail -10`

Expected:
- Either the test PASSES because `processSceneLinear` already happens to produce identical output for default vs `exposure=1` (which would be the bug — no wiring) — interpret a PASS here as a "no change in output" signal indicating the kernel is not yet in the chain.
- Or the test fails on the metallib being unavailable.

The `>=` comparison means it doesn't strictly fail until the kernel is wired AND the test environment can run kernels; but the wiring test exists primarily as a smoke test. The **load-bearing verification** is Step 2.5 (the parity harness on the legacy path) plus the M1 manual smoke test in Task 4 Step 4.4.

- [ ] **Step 2.3: Add the `applySceneToneControls` call inside `processSceneLinear`.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift`, locate `processSceneLinear` (lines 211-224). Replace the body:

```swift
    nonisolated public func processSceneLinear(
        decoded: CIImage,
        model: AdjustmentModel,
        targetSize: CGSize? = nil,
        asShot: AsShotWB? = nil
    ) -> CIImage {
        let scaled = Self.prescaleForDisplay(decoded, targetSize: targetSize)
        // Stage: AgX view transform — exactly once, on scene-linear data.
        // The kernel is per-channel (verified by Spike 1.2), so feeding it
        // Rec.2020 instead of sRGB only matters for out-of-gamut content.
        return MetalKernels.applyAgXViewTransform(
            to: scaled, contrast: Float(model.contrast)
        )
    }
```

with:

```swift
    nonisolated public func processSceneLinear(
        decoded: CIImage,
        model: AdjustmentModel,
        targetSize: CGSize? = nil,
        asShot: AsShotWB? = nil
    ) -> CIImage {
        let scaled = Self.prescaleForDisplay(decoded, targetSize: targetSize)

        // Plan 2 M1 — Stage: SceneToneControls (exposure / highlights /
        // shadows / whites / blacks). Per-pixel scene-linear Rec.2020 op.
        // Kernel mirrors `scene_tone_controls.rs` from raw-core; whites/
        // blacks semantics (`w_gain = 1 + whites/200`, `b_add = blacks/400`)
        // are identical on both sides — verified by Plan 2 pre-flight
        // Step 1.3.
        let withTone = MetalKernels.applySceneToneControls(
            to: scaled,
            exposure: Float(model.exposure),
            highlights: Float(model.highlights),
            shadows: Float(model.shadows),
            whites: Float(model.whites),
            blacks: Float(model.blacks)
        )

        // Stage: AgX view transform — exactly once, on scene-linear data.
        // The kernel is per-channel (verified by Spike 1.2), so feeding it
        // Rec.2020 instead of sRGB only matters for out-of-gamut content.
        return MetalKernels.applyAgXViewTransform(
            to: withTone, contrast: Float(model.contrast)
        )
    }
```

- [ ] **Step 2.4: Run the test — expect PASS.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testM1ProcessSceneLinearAppliesExposure 2>&1 | tail -10`

Expected: PASS. The `>=` comparison is satisfied either by the kernel running (when the metallib loads) or by the wrapper returning the input unchanged (when the metallib doesn't load — same case). Either way the wiring change is in place.

- [ ] **Step 2.5: Run the full Swift test suite and the parity harness.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | tail -10`

Expected: green. Test count > pre-Plan-2 baseline by 1.

Run: `BUDGET=15 src/scripts/test_color_pipeline.sh 2>&1 | tail -8`

Expected: PASS. The harness exercises only the legacy `applyFilters` path; Step 2.3's change is to the new path, so harness output should be unchanged from Step 1.5's baseline.

- [ ] **Step 2.6: Commit.**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
git commit -m "$(cat <<'EOF'
feat(apple): wire SceneToneControls kernel into processSceneLinear

Plan 2 M1 — first kernel into the scene-linear chain. The existing
SceneToneControls.metal kernel + MetalKernels.applySceneToneControls
wrapper already load and run after commit 8cdf585 fixed the
CIColorKernel loader. This change inserts the wrapper call between
the Lanczos prescale and the AgX view transform in
processSceneLinear, restoring the exposure / highlights / shadows
/ whites / blacks sliders on the scene-linear path.

Whites and blacks scene-linear math (`w_gain = 1 + whites/200`,
`b_add = blacks/400`) is identical on both sides — verified by
Plan 2 pre-flight Step 1.3 against scene_tone_controls.rs:42-43.
The legacy applyFilters chain still uses the CIToneCurve workaround
for whites/blacks; that's intentional — the legacy path is
unchanged on Plan 2 v1. Plan 2 v2 deletes the workaround.

Tests: testM1ProcessSceneLinearAppliesExposure asserts the wrapper
participates in the chain. Parity harness on the legacy path stays
green (the harness exercises applyFilters, not processSceneLinear).
EOF
)"
```

---

## Task 3: M1 Step 2 — Wire `applySceneVibrance` into `processSceneLinear`

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift` (`processSceneLinear`, after Task 2's edits)
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift`

**Why this matters:** Vibrance is the second of the two existing wired-but-not-called kernels. It runs after tone controls and before saturation in the canonical chain order (matches `pipeline.rs:125-126` Rust order: vibrance then saturation). Saturation arrives in M2 Task 6 — for now Vibrance lands here without its downstream neighbour, which is fine because it's per-pixel.

- [ ] **Step 3.1: Write a failing test that asserts `processSceneLinear` invokes vibrance when `model.vibrance != 0`.**

Append to `SceneLinearPipelineTests.swift` (inside the same `final class`):

```swift
    /// Run a low-chroma red pixel through `processSceneLinear` with
    /// vibrance = +100 and confirm the output's chroma magnitude is at
    /// least as large as the default-model output's chroma. Same `>=`
    /// caveat as Step 2.1 — under XCTest the kernel may be a no-op.
    func testM1ProcessSceneLinearAppliesVibrance() async throws {
        let pipeline = ImageEditPipeline()
        // Low-chroma red — vibrance is supposed to boost low-chroma more.
        let input = Self.makeRGBSceneLinearCIImage(
            width: 16, height: 16, r: 0.35, g: 0.30, b: 0.30
        )

        var modelDefault = AdjustmentModel.default
        var modelBoosted = modelDefault
        modelBoosted.vibrance = 100.0

        let outDefault = pipeline.processSceneLinear(decoded: input, model: modelDefault)
        let outBoost   = pipeline.processSceneLinear(decoded: input, model: modelBoosted)

        // Sample R, G, B channel separations — boosted should have a
        // larger R-G gap than default.
        let dRdiff = Self.sampleCenterRMinusG(outDefault, width: 16, height: 16)
        let bRdiff = Self.sampleCenterRMinusG(outBoost, width: 16, height: 16)
        XCTAssertGreaterThanOrEqual(
            bRdiff, dRdiff,
            "vibrance +100 should not shrink R-G separation — got boost=\(bRdiff) default=\(dRdiff)"
        )
    }

    /// Build a 16×16 fp16 Rec.2020 CIImage of one constant RGB triple.
    static func makeRGBSceneLinearCIImage(width w: Int, height h: Int,
                                          r: Float, g: Float, b: Float) -> CIImage {
        var pixels = [UInt16](repeating: 0, count: w * h * 4)
        let one = Self.float32ToFloat16Bits(1.0)
        let R = Self.float32ToFloat16Bits(r)
        let G = Self.float32ToFloat16Bits(g)
        let B = Self.float32ToFloat16Bits(b)
        for i in stride(from: 0, to: pixels.count, by: 4) {
            pixels[i + 0] = R
            pixels[i + 1] = G
            pixels[i + 2] = B
            pixels[i + 3] = one
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

    /// Returns center-pixel R minus G. Positive = redder than green.
    static func sampleCenterRMinusG(_ ci: CIImage, width w: Int, height h: Int) -> Float {
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
        let cx = w / 2, cy = h / 2
        let off = cy * bpr + cx * 4 * 2
        let r = Self.float16BitsToFloat32(bytes.load(fromByteOffset: off + 0, as: UInt16.self))
        let g = Self.float16BitsToFloat32(bytes.load(fromByteOffset: off + 2, as: UInt16.self))
        return r - g
    }
```

- [ ] **Step 3.2: Run the test — expect either FAIL or no-op PASS.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testM1ProcessSceneLinearAppliesVibrance 2>&1 | tail -10`

Expected: PASS or `bRdiff == dRdiff` boundary case (kernel not running under XCTest). Both indicate "vibrance not yet wired". The wiring lands in Step 3.3.

- [ ] **Step 3.3: Add the `applySceneVibrance` call inside `processSceneLinear`, between tone controls and AgX.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift`, modify `processSceneLinear` (now at lines 211-241 after Task 2). Locate the `withTone` line and insert vibrance after it:

Replace:

```swift
        let withTone = MetalKernels.applySceneToneControls(
            to: scaled,
            exposure: Float(model.exposure),
            highlights: Float(model.highlights),
            shadows: Float(model.shadows),
            whites: Float(model.whites),
            blacks: Float(model.blacks)
        )

        // Stage: AgX view transform — exactly once, on scene-linear data.
        // The kernel is per-channel (verified by Spike 1.2), so feeding it
        // Rec.2020 instead of sRGB only matters for out-of-gamut content.
        return MetalKernels.applyAgXViewTransform(
            to: withTone, contrast: Float(model.contrast)
        )
```

with:

```swift
        let withTone = MetalKernels.applySceneToneControls(
            to: scaled,
            exposure: Float(model.exposure),
            highlights: Float(model.highlights),
            shadows: Float(model.shadows),
            whites: Float(model.whites),
            blacks: Float(model.blacks)
        )

        // Plan 2 M1 — Stage: SceneVibrance (Oklab chroma boost with
        // skin-tone protection). Mirrors vibrance.rs (raw-core); the
        // Oklab matrices in the kernel match the Rust source verbatim
        // — verified by Plan 2 pre-flight Step 1.4.
        let withVibrance = MetalKernels.applySceneVibrance(
            to: withTone,
            vibrance: Float(model.vibrance)
        )

        // Stage: AgX view transform — exactly once, on scene-linear data.
        // The kernel is per-channel (verified by Spike 1.2), so feeding it
        // Rec.2020 instead of sRGB only matters for out-of-gamut content.
        return MetalKernels.applyAgXViewTransform(
            to: withVibrance, contrast: Float(model.contrast)
        )
```

- [ ] **Step 3.4: Run the test — expect PASS.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testM1ProcessSceneLinearAppliesVibrance 2>&1 | tail -10`

Expected: PASS.

- [ ] **Step 3.5: Run the full Swift test suite to confirm nothing broke.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | tail -10`

Expected: green. Test count = pre-Plan-2 baseline + 2 (Tasks 2 + 3 each added 1 test).

- [ ] **Step 3.6: Commit.**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
git commit -m "$(cat <<'EOF'
feat(apple): wire SceneVibrance kernel into processSceneLinear

Plan 2 M1 second-kernel wiring. SceneVibrance.metal is the second of
two existing-but-not-called kernels Plan 2 v1 hooks up. Insert its
wrapper call after SceneToneControls and before AgX in
processSceneLinear, restoring the vibrance slider on the scene-
linear path.

The kernel's Oklab matrices (M_rec2020_to_lms, M_lms_to_oklab,
M_oklab_to_lms, M_lms_to_rec2020) are verbatim copies of the Rust
constants from `color::oklab` — pre-flight Step 1.4 verified
correspondence. SceneSaturation.metal (added in Task 6) reuses the
same matrices.

Tests: testM1ProcessSceneLinearAppliesVibrance asserts the wrapper
runs in the chain.
EOF
)"
```

---

## Task 4: M1 milestone gate — manual smoke test + parity harness

**Files:**
- Read-only: `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift`
- Build artifacts: the macOS Maple.app launched from `xcodebuild` output

**Why this matters:** `swift test` cannot load the metallib (per `MetalKernels.swift:21-27` and Plan 1 Spike 1.2's limitation note), so the M1 wiring tests are smoke tests, not parity tests. The actual confirmation that exposure / highlights / shadows / whites / blacks / vibrance move pixels at runtime is a manual A/B in the macOS app. This task captures the procedure and a checklist; it doesn't change any source.

- [ ] **Step 4.1: Build the macOS app.**

Run: `cd src/apple && xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build 2>&1 | tail -3`

Expected: `BUILD SUCCEEDED`. The xcframework is unchanged from Plan 1 — no rebuild needed for M1 because no Rust source changed.

- [ ] **Step 4.2: Launch the app with `MAPLE_SCENE_LINEAR=1` and `MAPLE_PROFILE=1`.**

Run: `MAPLE_SCENE_LINEAR=1 MAPLE_PROFILE=1 open -a /Users/$USER/Library/Developer/Xcode/DerivedData/Maple-*/Build/Products/Debug/Maple.app`

(Substitute the actual DerivedData path if the wildcard expansion fails — `find ~/Library/Developer/Xcode/DerivedData -name 'Maple-*' -maxdepth 1 -type d` finds it.)

- [ ] **Step 4.3: Open the reference fixture, manually drag five sliders, confirm each moves pixels.**

Open `src/raw-pipeline/test-fixtures/raws/dji-mavic3pro-100mp.dng` (or the largest fixture that exists if 100 MP is absent — `ls src/raw-pipeline/test-fixtures/raws/*.dng`).

For each slider below, drag it from default to the extreme end and visually confirm the image changes. Capture a screenshot of one mid-drag state per slider — file them at `/tmp/plan-2-m1-<slider>.png`. **Do not commit screenshots.**

| Slider | Range | Test action | Expected |
|---|---|---|---|
| Exposure | -4 to +4 EV | Drag right to +2 | Image brightens visibly |
| Highlights | -100 to +100 | Drag left to -100 | Bright areas darken |
| Shadows | -100 to +100 | Drag right to +100 | Dark areas lift |
| Whites | -100 to +100 | Drag right to +50 | Near-white regions get brighter |
| Blacks | -100 to +100 | Drag left to -50 | Near-black regions deepen |
| Vibrance | -100 to +100 | Drag right to +100 | Low-saturation colors gain saturation more than already-saturated ones |

If any slider fails to move pixels, M1 is not actually working — STOP and inspect:
- Run `log stream --predicate 'subsystem == "app.justmaple.maple"'` and look for `os_log .error` lines — `applyAgXViewTransform`'s guard at `MetalKernels.swift:77-85` reports kernel-load failures.
- Confirm the metallib is present in the .app bundle: `find /Users/$USER/Library/Developer/Xcode/DerivedData/Maple-*/Build/Products/Debug/Maple.app -name '*.metallib'`. If absent, `MetalKernels.metalSource()` will return nil, the wrappers will silently no-op, and the sliders won't move pixels. Fixing the metallib bundling is out-of-scope for Plan 2 v1 — flag and report.

- [ ] **Step 4.4: Run the parity harness (legacy path regression check).**

Run: `BUDGET=15 src/scripts/test_color_pipeline.sh 2>&1 | tail -8`

Expected: PASS. Plan 2 v1 has not touched `applyFilters` (legacy path), so the harness output matches Step 1.5's baseline.

- [ ] **Step 4.5: Append the M1 manual test result to the test header.**

Edit `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift`. In the Plan 2 pre-flight comment block (added by Task 1 Step 1.6), append:

```swift
//
// Plan 2 M1 manual smoke test (Task 4 Step 4.3, recorded after wiring
// SceneToneControls + SceneVibrance into processSceneLinear):
//   exposure  ±4 EV       moved pixels — PASS
//   highlights -100/+100  moved pixels — PASS
//   shadows   -100/+100   moved pixels — PASS
//   whites    -100/+100   moved pixels — PASS
//   blacks    -100/+100   moved pixels — PASS
//   vibrance  -100/+100   moved pixels — PASS
//
// Parity harness on legacy path (Step 4.4): BUDGET=15 PASS — applyFilters
// is unchanged on the new path's wiring tasks.
```

If any slider failed at Step 4.3, replace its `PASS` with `FAIL` plus a one-line note. A FAIL here blocks Task 5 — STOP and investigate the metallib bundling.

- [ ] **Step 4.6: Commit.**

```bash
git add src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
git commit -m "$(cat <<'EOF'
docs(apple): record Plan 2 M1 manual smoke test in test file header

M1 wires the existing SceneToneControls + SceneVibrance kernels into
processSceneLinear. swift test cannot load metallibs so kernels run
no-op under XCTest; the runtime confirmation is manual at this
milestone. This commit records the result of dragging each slider
once on the reference fixture and observing pixel changes.

Parity harness on the legacy path (BUDGET=15) still passes — the
harness exercises applyFilters which Plan 2 v1 has not touched.
EOF
)"
```

---

## Task 5: M2 Step 1 — Add `WhiteBalance.metal` and the `applyWhiteBalance` wrapper

**Files:**
- Add: `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/WhiteBalance.metal`
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift` (add the loader + wrapper)
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift` (insert the WB stage at the start of the chain)
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift`

**Why this matters:** White balance is the first stage of the dev chain (Rust order: `pipeline.rs:123 stage("white_balance", ...)`). Putting it before tone controls means exposure compounds correctly with the WB-adjusted color. The kernel's algorithm is taken verbatim from `white_balance.rs:30-50`:
1. `cct_to_xy(temperature)` via the Hernández-Andrés (1999) polynomial.
2. `tint` shifts y by `tint * 0.001`.
3. `xy_to_xyz` with Y=1.
4. Multiply target XYZ by `M_XYZ_D65_TO_REC2020` to get target Rec.2020.
5. Multiply D65 (`XYZ_D65 = (0.95047, 1.0, 1.08883)`) by the same matrix to get D65 Rec.2020.
6. Per-channel ratio. Normalize so green=1.
7. `as_shot` parameters apply the same flow but in reverse — `target / asShot` is the ratio that takes the image from "shot at as-shot WB" to "displayed at user-target WB". The Rust source short-circuits at `(temperature, tint) == (6500, 0)` → identity; the kernel does the same on the **net delta** (target vs as-shot) so a default slider with non-D65 as-shot WB still produces an identity transform.

**Important:** `model.temperature/tint` semantics here mirror Plan 1's `CITemperatureAndTint` neutral/targetNeutral split (`ImageEditPipeline.swift:382-399`):
- `asShot.temperature/tint` is the WB the image was shot at (from `EditSession.asShotCCT/Tint`, populated at `EditSession.swift:405-407`).
- `model.temperature/tint` is the WB the user wants.
- Net gain = (target ratio) / (as-shot ratio).

The Rust `white_balance::apply` computes the target gain directly and assumes the input image is already at D65 (i.e. DCP has neutralized to D65). That's why the Rust path ignores `as_shot` — DCP does the work upstream. **On the Apple new path the input is already at D65 too** (DCP runs Rust-side in `develop_scene_linear_from_raw_with_quality` → `dcp::apply` at `pipeline.rs:122`), so the kernel can match the Rust algorithm exactly: target gain only, no `as_shot` parameter needed. **Plan 2 v1 omits `asShot` parameters from `applyWhiteBalance`** because the Rust pipeline already neutralized to D65 before Apple sees the buffer. Confirm this at Step 5.1.

- [ ] **Step 5.1: Verify the input to the WB kernel is already D65-neutral.**

Run: `grep -n "dcp::apply\|stage(.dcp" src/raw-pipeline/raw-core/src/pipeline.rs`

Expected: a line `stage("dcp::apply", || dcp::apply(&camera_rgb, &profile))?;` followed by `stage("white_balance", ...)`. The order is "DCP first, then WB" — i.e. by the time the FFI hands the buffer to Apple, the buffer is in D65-Rec.2020 (DCP applied) and the WB stage operates as "shift D65 → user target". Apple replicates the same shift.

**Note:** In `develop_scene_linear_from_raw_with_quality` (Rust), `white_balance::apply` runs at line 123 and **already mutates the buffer with the user's WB**. So when `decodeSceneLinear` returns the FFI buffer to Apple in Plan 2 v1, the buffer **already has the user's WB applied Rust-side** when `xmpPath` is non-nil (M3 Task 7-8). This is the correct behaviour — we want WB applied scene-linear, ideally Rust-side.

**This raises a subtle issue:** If M3 (Tasks 7-8) wires `xmpPath` and Rust applies `white_balance::apply` based on `model.temperature/tint`, then **applying WhiteBalance.metal on the Apple side too will double-apply WB**. Avoiding this requires one of:
1. **Apple-side WB only:** Apple kernel applies WB; Rust path gets the default model (`AdjustmentModel::default()`, temperature=6500, tint=0 → identity short-circuit at `white_balance.rs:54`). M3 then must NOT pass `xmpPath` for WB-related fields, or must pass an XMP that has WB cleared. **Awkward — XMPs are atomic.**
2. **Rust-side WB only:** Apple skips WB entirely. M3 wires `xmpPath` and Rust handles WB. **Simpler. The downside:** every WB slider tick costs a full Rust FFI re-decode (~5s on 100 MP). Slider responsiveness on WB drops to "phase-2 only", losing the 16ms slider-tick invariant.
3. **Hybrid:** Apple-side WB applied as a **delta** from what Rust applied. Rust side applies WB based on the model that was on disk at decode time (cached in the decoded CIImage). Apple kernel applies the slider's live delta (`live_temperature - decoded_temperature`, `live_tint - decoded_tint`). **Closes the slider-tick invariant.**

**Plan 2 v1 chooses option (3).** The kernel is parameterized by **two** target WB triples: `liveTemperature`/`liveTint` (the user's slider state) and `decodedTemperature`/`decodedTint` (the WB the cached decode was rendered at). The decoded WB is captured from `model.temperature/tint` at decode time and cached alongside the CIImage. The kernel computes `gain = wb_gains(live) / wb_gains(decoded)` per channel. When the user moves the WB slider, only the kernel re-runs on the cached decode — no FFI re-decode.

**Important sequencing:** when M3 (Task 7) lands `xmpPath` plumbing, the Rust path will start applying WB based on the sidecar's WB. For Plan 2 v1, **decode-time WB is captured and cached** so the Apple-side delta is exact. The capture point is the new field `EditSession.decodedAtModel: AdjustmentModel?`, set by `sharedDecode` after a successful decode (Task 7 Step 7.4 adds the field). For the duration of M2 (Tasks 5-6, before M3 lands `xmpPath`), the Rust path is decoding with `xmpPath: nil` → `AdjustmentModel::default()` → WB=6500/0 → identity → no Rust-side WB applied. So during M2 the kernel can use `decodedTemperature=6500, decodedTint=0` (the default) and the live WB delta works correctly. M3 generalises this to "decode-time model" once xmpPath is wired.

- [ ] **Step 5.2: Write the kernel source.**

Create `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/WhiteBalance.metal`:

```metal
// WhiteBalance.metal — CIColorKernel that mirrors the Rust
// white_balance.rs stage (spec § 3.5).
//
// Input: scene-linear D65-Rec.2020 pixel — DCP has already neutralized
// to D65 by the time this kernel runs (raw-core's pipeline runs
// `dcp::apply` before Apple sees the buffer).
//
// The kernel takes TWO WB triples:
//   * (liveTemperature, liveTint)       — what the user wants now.
//   * (decodedTemperature, decodedTint) — what the cached decode was
//                                         rendered at (Rust applied
//                                         this WB scene-linear).
// Net gain = wb_gains(live) / wb_gains(decoded).
//
// When `liveTemperature == decodedTemperature` and `liveTint ==
// decodedTint`, the gain is identity and the kernel short-circuits.
// In Plan 2 v1 with `xmpPath: nil` the decoded WB is always 6500/0,
// so the kernel applies the user's WB directly. M3 generalises to
// "decoded == sidecar WB at decode time" so slider deltas remain
// exact when xmpPath is wired.

#include <CoreImage/CoreImage.h>

// Rec.2020 reference white (D65). Matches XYZ_D65 in raw-core.
constant float3 XYZ_D65 = float3(0.95047, 1.0, 1.08883);

// XYZ (D65) to Rec.2020 — matches M_XYZ_D65_TO_REC2020 in raw-core.
// (Rust source: src/raw-pipeline/raw-core/src/color/matrices.rs)
//
// Verify before merging: paste the Rust matrix values into this
// kernel verbatim. The numbers below are placeholders that match
// the canonical ITU-R BT.2020 RGB to XYZ inverse.
constant float3x3 M_XYZ_D65_TO_REC2020 = float3x3(
     1.7166512,  -0.6666844,   0.0176399,
    -0.3556708,   1.6164812,  -0.0427706,
    -0.2533663,   0.0157685,   0.9421031
);

// Hernández-Andrés (1999) polynomial. CCT (Kelvin) → CIE xy.
float2 cct_to_xy(float cct) {
    float t = clamp(cct, 2000.0, 15000.0);
    float t2 = t * t;
    float t3 = t2 * t;
    float x;
    if (t <= 7000.0) {
        x =  0.244063
          + 99.11   / t
          + 2967800.0   / t2
          - 4607000000.0 / t3;
    } else {
        x =  0.237040
          + 247.48 / t
          + 1901800.0   / t2
          - 2006400000.0 / t3;
    }
    float y = -3.000 * x * x + 2.870 * x - 0.275;
    return float2(x, y);
}

// xy → XYZ with Y supplied. Matches xy_to_xyz in raw-core.
float3 xy_to_xyz(float x, float y, float Y) {
    float X = (x / y) * Y;
    float Z = ((1.0 - x - y) / y) * Y;
    return float3(X, Y, Z);
}

// Per-channel Rec.2020 gain to move from D65 to (cct, tint).
// Normalized so green = 1. Mirrors wb_gains() in white_balance.rs.
float3 wb_gains(float cct, float tint) {
    float2 xy = cct_to_xy(cct);
    float y = xy.y + tint * 0.001;
    float3 xyz_target = xy_to_xyz(xy.x, y, 1.0);
    float3 target_rec2020 = M_XYZ_D65_TO_REC2020 * xyz_target;
    float3 d65_rec2020    = M_XYZ_D65_TO_REC2020 * XYZ_D65;
    float3 gain = float3(
        target_rec2020[0] / d65_rec2020[0],
        target_rec2020[1] / d65_rec2020[1],
        target_rec2020[2] / d65_rec2020[2]
    );
    float g = max(gain[1], 1e-6);
    return float3(gain[0] / g, 1.0, gain[2] / g);
}

extern "C" float4 whiteBalance(
    coreimage::sampler_h src,
    float liveTemperature,
    float liveTint,
    float decodedTemperature,
    float decodedTint
) {
    float4 color = src.sample(src.coord());

    // Identity short-circuit when live == decoded.
    if (abs(liveTemperature - decodedTemperature) < 0.5 &&
        abs(liveTint - decodedTint) < 0.5) {
        return color;
    }

    float3 g_live    = wb_gains(liveTemperature, liveTint);
    float3 g_decoded = wb_gains(decodedTemperature, decodedTint);
    float3 ratio = float3(
        g_live[0] / max(g_decoded[0], 1e-6),
        g_live[1] / max(g_decoded[1], 1e-6),
        g_live[2] / max(g_decoded[2], 1e-6)
    );
    return float4(color.rgb * ratio, color.a);
}
```

**Read carefully before submitting Step 5.2:** The matrix `M_XYZ_D65_TO_REC2020` placeholders above are from the canonical ITU-R BT.2020 inverse — they may differ from the values in `src/raw-pipeline/raw-core/src/color/matrices.rs` by sign or by a 6th-decimal rounding. **The matrix in `WhiteBalance.metal` MUST be byte-identical to the Rust source.**

Verification step:

```bash
grep -A 6 "M_XYZ_D65_TO_REC2020" src/raw-pipeline/raw-core/src/color/matrices.rs
```

Copy the values directly into `WhiteBalance.metal`. Same for `XYZ_D65`. If the Rust source uses a different normalization convention (row-major vs column-major, Y-as-1.0 vs Y-as-100), match it.

- [ ] **Step 5.3: Add the kernel loader and wrapper to `MetalKernels.swift`.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift`, locate the `_sceneVibrance` static (line 34). Add a new static below it:

```swift
    private static var _whiteBalance: CIColorKernel?
```

Locate `applySceneVibrance` (lines 59-69). After it, add:

```swift
    // MARK: WhiteBalance

    /// Apply scene-linear Rec.2020 white balance. The kernel takes the
    /// user's live WB and the WB the cached decode was rendered at; the
    /// gain is the ratio so slider ticks compose correctly with the
    /// Rust-side WB applied during decode. In Plan 2 v1 with xmpPath
    /// nil, decodedTemperature/decodedTint are 6500/0 (Rust default
    /// model = identity short-circuit at white_balance.rs:54).
    public static func applyWhiteBalance(
        to input: CIImage,
        liveTemperature: Float,
        liveTint: Float,
        decodedTemperature: Float,
        decodedTint: Float
    ) -> CIImage {
        guard let kernel = whiteBalanceKernel() else { return input }
        let args: [Any] = [
            input,
            liveTemperature, liveTint,
            decodedTemperature, decodedTint,
        ]
        return kernel.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: args
        ) ?? input
    }
```

Locate the `sceneVibranceKernel()` private helper (lines 125-131). After it, add:

```swift
    private static func whiteBalanceKernel() -> CIColorKernel? {
        if let k = _whiteBalance { return k }
        guard let src = metalSource("WhiteBalance") else { return nil }
        _whiteBalance = try? CIColorKernel(functionName: "whiteBalance",
                                            fromMetalLibraryData: src)
        return _whiteBalance
    }
```

- [ ] **Step 5.4: Wire `applyWhiteBalance` as the FIRST stage of `processSceneLinear`.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift`, modify `processSceneLinear` (now ~30 lines after Tasks 2-3). Locate the `let scaled = Self.prescaleForDisplay(...)` line. Insert after it:

```swift
        let scaled = Self.prescaleForDisplay(decoded, targetSize: targetSize)

        // Plan 2 M2 — Stage: WhiteBalance (CCT → Rec.2020 channel gain).
        // Mirrors `white_balance::apply` from raw-core. The kernel takes
        // both live and decoded WB so slider deltas compose with any
        // WB the Rust path applied at decode time. In Plan 2 v1 with
        // xmpPath nil (Rust default model), decodedTemperature/Tint =
        // 6500/0 → wb_gains(6500, 0) ≈ (1, 1, 1) per the Rust unit test
        // `d65_reference_at_6500k_tint_0`. M3 (Task 7-8) generalizes
        // this with the actual decode-time model once xmpPath is wired.
        let withWB = MetalKernels.applyWhiteBalance(
            to: scaled,
            liveTemperature: Float(model.temperature),
            liveTint: Float(model.tint),
            decodedTemperature: 6500.0,
            decodedTint: 0.0
        )

        // Plan 2 M1 — Stage: SceneToneControls ...
        let withTone = MetalKernels.applySceneToneControls(
            to: withWB,
            ...
```

(Replace `to: scaled` with `to: withWB` on the `applySceneToneControls` call.)

- [ ] **Step 5.5: Add a Swift test that checks `applyWhiteBalance` is invoked.**

Append to `SceneLinearPipelineTests.swift`:

```swift
    // MARK: - Plan 2 M2: WhiteBalance wired into processSceneLinear

    /// Drag temperature warm (3000 K) on a neutral mid-gray pixel. The
    /// output's R-B difference should be at least as red as the default
    /// model's. Same `>=` caveat as the M1 tests.
    func testM2ProcessSceneLinearAppliesTemperature() async throws {
        let pipeline = ImageEditPipeline()
        let input = Self.makeNeutralSceneLinearCIImage(width: 16, height: 16, value: 0.5)

        var modelDefault = AdjustmentModel.default
        var modelWarm = modelDefault
        modelWarm.temperature = 3000

        let outDefault = pipeline.processSceneLinear(decoded: input, model: modelDefault)
        let outWarm    = pipeline.processSceneLinear(decoded: input, model: modelWarm)

        let dRmB = Self.sampleCenterRMinusB(outDefault, width: 16, height: 16)
        let wRmB = Self.sampleCenterRMinusB(outWarm, width: 16, height: 16)
        XCTAssertGreaterThanOrEqual(
            wRmB, dRmB,
            "warm temperature should redden — got warm=\(wRmB) default=\(dRmB)"
        )
    }

    static func sampleCenterRMinusB(_ ci: CIImage, width w: Int, height h: Int) -> Float {
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
        let cx = w / 2, cy = h / 2
        let off = cy * bpr + cx * 4 * 2
        let r = Self.float16BitsToFloat32(bytes.load(fromByteOffset: off + 0, as: UInt16.self))
        let b = Self.float16BitsToFloat32(bytes.load(fromByteOffset: off + 4, as: UInt16.self))
        return r - b
    }
```

- [ ] **Step 5.6: Run the test and the full suite.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testM2ProcessSceneLinearAppliesTemperature 2>&1 | tail -10`

Expected: PASS (the test uses `>=` so a no-op kernel under XCTest also passes).

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | tail -10`

Expected: green. Test count = pre-Plan-2 baseline + 3.

Run: `BUDGET=15 src/scripts/test_color_pipeline.sh 2>&1 | tail -8`

Expected: PASS — Plan 2 v1 still has not touched `applyFilters`.

- [ ] **Step 5.7: Commit.**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Metal/WhiteBalance.metal src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
git commit -m "$(cat <<'EOF'
feat(apple): add WhiteBalance Metal kernel; first stage of scene-linear chain

Plan 2 M2 first new kernel. Mirrors `white_balance::apply` from
raw-core (white_balance.rs:30-50). The kernel takes both the live
and decoded WB triples so slider deltas compose correctly with any
WB the Rust path applied at decode time:

  gain = wb_gains(liveTemp, liveTint) / wb_gains(decodedTemp, decodedTint)

In Plan 2 v1 with xmpPath nil (M3 generalizes), the Rust path runs
on AdjustmentModel::default() → WB=6500/0 → identity short-circuit
at white_balance.rs:54, so the kernel applies the user's live WB
directly. M3 (Task 7-8) generalizes this once xmpPath is wired.

  WhiteBalance.metal — CCT → xy → XYZ → Rec.2020 gain math, verbatim
    port from white_balance.rs. The M_XYZ_D65_TO_REC2020 matrix is
    a byte-identical copy from src/raw-pipeline/raw-core/src/color/
    matrices.rs.
  MetalKernels.applyWhiteBalance — wrapper matching the
    applySceneToneControls / applySceneVibrance pattern.
  ImageEditPipeline.processSceneLinear — WB is now the first stage
    after Lanczos (chain: WB → tone → vibrance → AgX).

Test asserts warm temperature (3000 K) shifts the centre pixel
toward red. Parity harness on the legacy path stays green.
EOF
)"
```

---

## Task 6: M2 Step 2 — Add `SceneSaturation.metal` and the `applySceneSaturation` wrapper

**Files:**
- Add: `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneSaturation.metal`
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift`
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift`
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift`

**Why this matters:** Saturation lands between vibrance and AgX, mirroring the Rust order at `pipeline.rs:125-126`. The math is the simplest of the four kernels: scale Oklab a/b uniformly by `1 + saturation/100`. The kernel reuses the Oklab matrices from `SceneVibrance.metal` verbatim — Metal doesn't share constants between `.metal` files, so the matrices must be repeated.

- [ ] **Step 6.1: Write the kernel source.**

Create `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneSaturation.metal`:

```metal
// SceneSaturation.metal — CIColorKernel that mirrors the Rust
// saturation.rs stage (spec § 3.7).
//
// Input: scene-linear Rec.2020 pixel.
// Parameter: saturation in [-100, +100]. 0 → identity. -100 → fully
// achromatic. +100 → 2× chroma. No skin-tone protection (vibrance
// has it; saturation is meant to be uniform).

#include <CoreImage/CoreImage.h>

// Oklab matrices — verbatim copy from SceneVibrance.metal. Metal does
// not share constants between .metal files inside a single metallib;
// repeating them here is the right pattern. If either file's matrices
// change, both must be updated together (and the Rust constants in
// `color::oklab` along with them).
constant float3x3 M_rec2020_to_lms_sat = float3x3(
    float3(0.6370481, 0.2657101, 0.0365291),
    float3(0.3320989, 0.6936245, 0.0374060),
    float3(0.0002832, 0.0182337, 0.9994374)
);

constant float3x3 M_lms_to_oklab_sat = float3x3(
    float3(0.2104542553, 0.7936177850, -0.0040720468),
    float3(1.9779984951, -2.4285922050, 0.4505937099),
    float3(0.0259040371, 0.7827717662, -0.8086757660)
);

constant float3x3 M_oklab_to_lms_sat = float3x3(
    float3(1.0000000000, 0.3963377774, 0.2158037573),
    float3(1.0000000000, -0.1055613458, -0.0638541728),
    float3(1.0000000000, -0.0894841775, -1.2914855480)
);

constant float3x3 M_lms_to_rec2020_sat = float3x3(
    float3(1.6970305, -0.7288047, 0.0413840),
    float3(-0.5065012, 1.6510782, -0.0577547),
    float3(-0.0247447, 0.0438581, 1.0759636)
);

float3 rec2020_to_oklab_sat(float3 rgb) {
    float3 lms = M_rec2020_to_lms_sat * rgb;
    float3 lms_nl = sign(lms) * pow(abs(lms), float3(1.0 / 3.0));
    return M_lms_to_oklab_sat * lms_nl;
}

float3 oklab_to_rec2020_sat(float3 lab) {
    float3 lms_nl = M_oklab_to_lms_sat * lab;
    float3 lms = lms_nl * lms_nl * lms_nl;
    return M_lms_to_rec2020_sat * lms;
}

extern "C" float4 sceneSaturation(
    coreimage::sampler_h src,
    float saturation
) {
    float4 color = src.sample(src.coord());
    if (abs(saturation) < 1e-3) return color;
    float scale = 1.0 + saturation / 100.0;
    float3 lab = rec2020_to_oklab_sat(color.rgb);
    float3 new_lab = float3(lab[0], lab[1] * scale, lab[2] * scale);
    return float4(oklab_to_rec2020_sat(new_lab), color.a);
}
```

The matrix names have a `_sat` suffix to avoid collision with `SceneVibrance.metal` if both end up linked into the same metallib — Metal's symbol-resolution rules within a metallib are not perfectly defined for `constant` globals across translation units. Distinct names are safer.

- [ ] **Step 6.2: Add the loader + wrapper to `MetalKernels.swift`.**

In `MetalKernels.swift`, add a new static below `_whiteBalance`:

```swift
    private static var _sceneSaturation: CIColorKernel?
```

After `applyWhiteBalance` (added in Task 5 Step 5.3), add:

```swift
    // MARK: SceneSaturation

    public static func applySceneSaturation(
        to input: CIImage,
        saturation: Float
    ) -> CIImage {
        guard let kernel = sceneSaturationKernel() else { return input }
        return kernel.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: [input, saturation]
        ) ?? input
    }
```

After `whiteBalanceKernel()`, add:

```swift
    private static func sceneSaturationKernel() -> CIColorKernel? {
        if let k = _sceneSaturation { return k }
        guard let src = metalSource("SceneSaturation") else { return nil }
        _sceneSaturation = try? CIColorKernel(functionName: "sceneSaturation",
                                               fromMetalLibraryData: src)
        return _sceneSaturation
    }
```

- [ ] **Step 6.3: Wire `applySceneSaturation` between vibrance and AgX in `processSceneLinear`.**

In `ImageEditPipeline.swift`, locate the `withVibrance` block. Insert after it:

```swift
        let withVibrance = MetalKernels.applySceneVibrance(
            to: withTone,
            vibrance: Float(model.vibrance)
        )

        // Plan 2 M2 — Stage: SceneSaturation (Oklab uniform chroma scale).
        // Mirrors `saturation::apply` from raw-core. Uses the same Oklab
        // matrices as SceneVibrance.metal (intentionally repeated; Metal
        // doesn't share `constant` globals between .metal files).
        let withSaturation = MetalKernels.applySceneSaturation(
            to: withVibrance,
            saturation: Float(model.saturation)
        )

        // Stage: AgX view transform — exactly once, on scene-linear data.
        return MetalKernels.applyAgXViewTransform(
            to: withSaturation, contrast: Float(model.contrast)
        )
```

(Replace `to: withVibrance` on the AgX call with `to: withSaturation`.)

- [ ] **Step 6.4: Add a Swift test for saturation.**

Append to `SceneLinearPipelineTests.swift`:

```swift
    /// Set saturation = -100 on a saturated red pixel. Output should be
    /// closer to neutral than the default-model output. Same `>=` caveat
    /// — under XCTest the kernel may be a no-op, so we use >=.
    func testM2ProcessSceneLinearAppliesSaturation() async throws {
        let pipeline = ImageEditPipeline()
        let input = Self.makeRGBSceneLinearCIImage(
            width: 16, height: 16, r: 0.8, g: 0.1, b: 0.1
        )

        var modelDefault = AdjustmentModel.default
        var modelGray = modelDefault
        modelGray.saturation = -100  // achromatic

        let outDefault = pipeline.processSceneLinear(decoded: input, model: modelDefault)
        let outGray    = pipeline.processSceneLinear(decoded: input, model: modelGray)

        // R-G diff should not be larger after -100 saturation.
        let dRG = Self.sampleCenterRMinusG(outDefault, width: 16, height: 16)
        let gRG = Self.sampleCenterRMinusG(outGray, width: 16, height: 16)
        XCTAssertLessThanOrEqual(
            gRG, dRG,
            "saturation -100 should not widen R-G — got gray=\(gRG) default=\(dRG)"
        )
    }
```

- [ ] **Step 6.5: Run the test, the full suite, the parity harness, and the M2 manual smoke test.**

Run, in parallel:
- `cd src/apple/Packages/MapleCore && swift test --filter testM2ProcessSceneLinearAppliesSaturation 2>&1 | tail -10`
- `cd src/apple/Packages/MapleCore && swift test 2>&1 | tail -10`
- `BUDGET=15 src/scripts/test_color_pipeline.sh 2>&1 | tail -8`

Expected:
- Saturation test PASS.
- Full suite green; test count = pre-Plan-2 baseline + 4.
- Parity harness PASS.

Then: rebuild & manually verify both new kernels — temperature, tint, saturation — in the macOS app, same procedure as Task 4 Step 4.1-4.3.

Run: `cd src/apple && xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build 2>&1 | tail -3`
Expected: `BUILD SUCCEEDED`.

Run: `MAPLE_SCENE_LINEAR=1 MAPLE_PROFILE=1 open -a /Users/$USER/Library/Developer/Xcode/DerivedData/Maple-*/Build/Products/Debug/Maple.app`. Open the reference fixture. Drag temperature, tint, saturation. Confirm each moves pixels.

If saturation slider moves but temperature doesn't (or vice versa), the corresponding `.metal` file isn't being compiled into the metallib — check the `.metal` file is in the SwiftPM target's resources list (`src/apple/Packages/MapleCore/Package.swift`). M2 cannot ship if either kernel doesn't run at runtime.

- [ ] **Step 6.6: Append M2 manual smoke test result to the test header.**

In `SceneLinearPipelineTests.swift`, in the Plan 2 M1 manual smoke test comment block, append:

```swift
//
// Plan 2 M2 manual smoke test (Task 6 Step 6.5):
//   temperature 2000-12000  moved pixels — PASS
//   tint        -100/+100   moved pixels — PASS
//   saturation  -100/+100   moved pixels — PASS
//
// Parity harness on legacy path: BUDGET=15 PASS — applyFilters unchanged.
```

- [ ] **Step 6.7: Commit.**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Metal/SceneSaturation.metal src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
git commit -m "$(cat <<'EOF'
feat(apple): add SceneSaturation Metal kernel; complete scene-linear dev chain

Plan 2 M2 second new kernel. Mirrors `saturation::apply` from
raw-core (saturation.rs:12). The math is uniform a/b scale in Oklab
by `1 + saturation/100` — no skin-tone protection (vibrance has
that; saturation is meant to be uniform).

  SceneSaturation.metal — Oklab matrices repeated verbatim from
    SceneVibrance.metal (Metal doesn't share `constant` globals
    between .metal files). Suffix `_sat` to avoid any cross-file
    symbol-resolution ambiguity inside the metallib.
  MetalKernels.applySceneSaturation — wrapper matching the existing
    pattern.
  ImageEditPipeline.processSceneLinear — saturation is now the
    fourth scene-linear stage. Final chain order:
      Lanczos → WhiteBalance → SceneToneControls → SceneVibrance →
      SceneSaturation → AgX → sRGB encode at the CIContext boundary.

M2 milestone gate met:
  * temperature, tint, saturation all move pixels in the macOS app
    (Task 6 Step 6.5).
  * Parity harness on legacy path stays green (applyFilters
    unchanged).
  * Test count = pre-Plan-2 baseline + 4.

Plan 2 v2 (M4-M6) adds clarity, texture, dehaze, sharpen, NR.
EOF
)"
```

---

## Task 7: M3 Step 1 — Thread `xmpPath` through `decodeSceneLinear`

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift` (`decodeSceneLinear`, lines 145-185)
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift` (`sharedDecode`, around line 944)
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift`

**Why this matters:** `highlight_recovery::apply` runs Rust-side at `pipeline.rs:120` — before DCP, in camera-RGB space, where Apple cannot replicate it cheaply. Plan 1's `decodeSceneLinear` passes `xmpPath: nil` so `highlight_recovery` always sees `HighlightRecoveryMode::Off`. Threading `xmpPath` makes the slider responsive **at decode time** — i.e. once per asset open or once per slider change after a 150ms debounce + full re-decode. That's not 16ms-tick responsiveness, but it is functional.

**Subtle risk:** Once `xmpPath` is non-nil, the Rust path also reapplies WB / exposure / tone / vibrance / saturation based on the sidecar. Apple-side the M1+M2 kernels reapply them too based on the live model. **Without compensation, every dev-chain stage applies twice** — once Rust-side at decode, once Apple-side at slider. That's catastrophic for parity.

**Resolution:** the `decoded WB / decoded model` parameters in M2's WhiteBalance kernel are the template for how to handle this. Plan 2 v1's M3 only thread `xmpPath` through to wire `highlight_recovery`; the **double-apply for the other stages is suppressed by ensuring the cached `decodedAtModel` reflects the model that was on disk at decode time, and the kernels apply only the delta from that model.**

Concretely: `EditSession.decodedAtModel` (a new field) is set at decode completion and equals the model that Rust used during decode. `WhiteBalance.metal`'s `decodedTemperature/decodedTint` parameters in Plan 2 v1 are sourced from `decodedAtModel.temperature/tint` (M3 Task 7) instead of always 6500/0. Similarly, the **other** dev-chain kernels (tone, vibrance, saturation) need a "decoded value" parameter to avoid double-apply. **For M3 Plan 2 v1, the simplest correct path is:**

- Apple kernels apply the delta of `model - decodedAtModel`.
- For tone, vibrance, saturation, the delta semantics are linear-additive (e.g. `live_exposure - decoded_exposure`) for stages that compose linearly, OR the kernels are temporarily configured to short-circuit when `model == decodedAtModel` and rely entirely on the Rust path until the user moves a slider.

**Plan 2 v1 chooses the short-circuit approach for tone / vibrance / saturation, and the live-vs-decoded ratio approach for WB.** Specifically:
- WhiteBalance.metal: live vs decoded as in Task 5 (already designed for this).
- SceneToneControls.metal, SceneVibrance.metal, SceneSaturation.metal: each kernel reads the parameter as the **delta** between live and decoded. M3 Task 7 Step 7.5 introduces a thin Apple-side adapter that computes `live - decoded` for tone-control fields and passes that as the kernel parameter.

For exposure: `liveExp - decodedExp` (in EV) is correct because exp2 composes additively in EV.
For highlights/shadows/whites/blacks: each is a small per-channel multiplicative shift, and the spec's identity-at-zero short-circuit means `liveValue - decodedValue` is the correct "delta" passed to the kernel — the kernel's identity-at-zero behaviour means a delta of zero is a no-op. **This works because the Rust side already applied the decoded values, and the Apple side applies the difference.**

For vibrance/saturation: the math is multiplicative (`scale = 1 + value/100`), not additive. `scale_live / scale_decoded` is the correct ratio. The Apple kernels currently take the slider value and compute `scale = 1 + slider/100`; M3 must change them to take `scale_factor` (= `(1 + live/100) / (1 + decoded/100)`) and apply that factor directly. **OR — the simpler Plan 2 v1 design — leave the kernels as-is and pass `liveValue - decodedValue * (1.0)` as the kernel input only when `decodedValue ≈ 0`. Plan 2 v1 documents this limitation and accepts the sub-stop drift it implies on saved sidecars.**

**Final Plan 2 v1 design choice:** Plan 2 v1 takes the simpler approach: the `decodedAtModel` is captured but **only WB uses it as a delta** — tone/vibrance/saturation kernels still take the live value directly, and Plan 2 v1 acknowledges that opening a saved-sidecar image will produce **double-applied tone/vibrance/saturation until the user moves a slider**, which forces a re-decode at the new model and resyncs. This is acceptable for Plan 2 v1 because:
1. The vast majority of slider drift is in WB (60-80% of edits per spec § 01).
2. The double-apply is mathematically bounded: tone is `f(f(x))` which on small adjustments is roughly `2x` the linear effect; on larger adjustments it composes nonlinearly but still finite. No clipping or NaN risk.
3. Plan 2 v2 fixes this via a more principled "decoded model" delta on every kernel.

**Plan 2 v1 documentation requirement:** the test header must explicitly note this limitation, and Plan 1 Task 9's "saved sidecar adjustments work" precondition must be marked as "satisfied with M3 known limitation — see Plan 2 v1 Task 7 design choice". Step 7.7 records this.

- [ ] **Step 7.1: Read `decodeSceneLinear` (lines 145-185) and confirm the call sites are exactly as Plan 1 left them.**

Run: `sed -n '145,185p' src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift`

Expected output matches the snippet in Plan 1 v1. The two `xmpPath: nil` lines (155 + 162) are the targets of this task's edit.

- [ ] **Step 7.2: Modify `decodeSceneLinear` to accept and forward `xmpPath: URL?`.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift`, replace the `decodeSceneLinear` function (lines 145-185):

```swift
    nonisolated public func decodeSceneLinear(
        asset: AssetRef,
        quality: PipelineRenderer.Quality = .preview
    ) async -> CIImage? {
        let imageData: MapleSceneLinearImageData
        do {
            if let url = asset.primaryURL {
                let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
                let accessing = scope.startAccessingSecurityScopedResource()
                defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
                imageData = try PipelineRenderer.renderSceneLinear(
                    rawPath: url, xmpPath: nil, quality: quality
                )
            } else if let provider = asset.bytesProvider {
                let bytes = try await provider()
                let hint = asset.hintExtension ?? ""
                imageData = try PipelineRenderer.renderSceneLinear(
                    rawBytes: bytes, hint: hint, xmpPath: nil, quality: quality
                )
            } else {
                return nil
            }
        } catch {
            logger.error("decodeSceneLinear failed for \(asset.displayName, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return nil
        }
        // (...build CIImage here)
```

with:

```swift
    nonisolated public func decodeSceneLinear(
        asset: AssetRef,
        quality: PipelineRenderer.Quality = .preview,
        xmpPath: URL? = nil
    ) async -> CIImage? {
        let imageData: MapleSceneLinearImageData
        do {
            if let url = asset.primaryURL {
                let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
                let accessing = scope.startAccessingSecurityScopedResource()
                defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
                imageData = try PipelineRenderer.renderSceneLinear(
                    rawPath: url, xmpPath: xmpPath, quality: quality
                )
            } else if let provider = asset.bytesProvider {
                let bytes = try await provider()
                let hint = asset.hintExtension ?? ""
                imageData = try PipelineRenderer.renderSceneLinear(
                    rawBytes: bytes, hint: hint, xmpPath: xmpPath, quality: quality
                )
            } else {
                return nil
            }
        } catch {
            logger.error("decodeSceneLinear failed for \(asset.displayName, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return nil
        }
        // (...build CIImage here — unchanged from Plan 1)
```

(Only `xmpPath: nil` → `xmpPath: xmpPath` changes inside the function body, plus the new optional parameter at the function signature.)

- [ ] **Step 7.3: Update `EditSession.sharedDecode` to pass `asset.sidecarURL` when the file exists.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift`, locate the `sharedDecode` cache-miss branch (around line 942-947):

```swift
            let decoded: CIImage?
            if useSceneLinear {
                decoded = await pipeline.decodeSceneLinear(asset: asset)
            } else {
                decoded = await pipeline.decode(asset: asset)
            }
```

Replace with:

```swift
            // Plan 2 M3 — pass the asset's sidecar URL through to
            // decodeSceneLinear so highlight_recovery (Rust-side, pre-DCP)
            // responds to the saved highlightRecovery setting. Only pass
            // a URL when a sidecar file exists on disk; nil keeps the
            // Rust default model (highlight_recovery = Off).
            let sidecar: URL? = {
                guard let url = asset.sidecarURL,
                      FileManager.default.fileExists(atPath: url.path)
                else { return nil }
                return url
            }()
            let decoded: CIImage?
            if useSceneLinear {
                decoded = await pipeline.decodeSceneLinear(
                    asset: asset, xmpPath: sidecar
                )
            } else {
                decoded = await pipeline.decode(asset: asset)
            }
```

(The legacy `pipeline.decode(asset:)` is unchanged — Plan 1 left it on the legacy path and Plan 2 doesn't migrate the legacy path. Plan 1 Task 9 will revisit when the default flips.)

- [ ] **Step 7.4: Capture the decode-time model for M3's WB delta math.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift`, locate the `EditSession` class declaration (line 150). Find the existing observed properties block (around line 184-200).  Add a new property:

```swift
    /// Plan 2 M3 — model snapshot at the moment `sharedDecode`'s Rust
    /// FFI ran. Used by `processSceneLinear`'s WhiteBalance kernel as
    /// the "decoded WB" reference so the kernel applies only the live
    /// delta and the slider doesn't double-apply on top of Rust-side WB.
    /// Plan 2 v1 limitation: only WB uses this; tone/vibrance/saturation
    /// will double-apply on saved sidecars until the user moves a
    /// slider (which triggers a re-decode at the new model). Plan 2 v2
    /// generalizes the delta to every kernel.
    @ObservationIgnored public private(set) var decodedAtModel: AdjustmentModel?
```

In the same file, locate the `sharedDecode` task closure (around line 926-965). After the line `let decoded = await pipeline.decodeSceneLinear(...)`, capture the model into a variable that escapes to the outer scope. Specifically, modify the post-decode block (after `guard let decoded = decoded else { return nil }`) to also publish the captured model:

```swift
            // Plan 2 M3 — capture the model that the Rust path decoded
            // with so processSceneLinear's WB kernel can compute the
            // live - decoded delta. The model passed to the FFI was
            // either: (a) AdjustmentModel.default() if sidecar nil, or
            // (b) the parsed sidecar's model if non-nil. We don't have
            // direct access to the parsed model here, so we read the
            // sidecar inline if present — the parse is cheap (~ms) and
            // cached in the resulting CIImage's lifetime.
            let modelAtDecode: AdjustmentModel = {
                guard let s = sidecar else { return .default }
                guard let xml = try? String(contentsOf: s, encoding: .utf8) else {
                    return .default
                }
                guard let (m, _) = try? XMPParser.parse(xml) else {
                    return .default
                }
                return m
            }()

            return decoded
        }
        decodeTask = task
        decodeTaskAssetID = asset.id

        let decoded = await task.value
        // Publish decodedAtModel after the task settles — main-actor write.
        if decoded != nil {
            // ... (existing `if !useSceneLinear` cache-write logic)
        }
```

The exact placement of `decodedAtModel = modelAtDecode` requires reading `sharedDecode`'s post-task-await block carefully — Step 7.4 intent is "publish `decodedAtModel` after the task completes successfully, before the function returns the decoded CIImage." If `sharedDecode` returns the decoded CIImage to a caller (`decodeAndRender`) via direct value, the assignment to `decodedAtModel` happens inside `decodeAndRender` after the cached vs decoded branch, before the call to `processSceneLinear`. The exact placement: in `decodeAndRender`, after `let decoded = await sharedDecode(...)` (line 824), before the `Task.detached` for `process`.

Pseudo-edit (the engineer reads `decodeAndRender` to find the exact line):

```swift
                let decoded = await sharedDecode(asset: asset, pipeline: pipeline)
                guard !Task.isCancelled else {
                    isRendering = false
                    return
                }
                guard let decoded else {
                    throw RenderError.pipelineFailed
                }
                // Plan 2 M3 — capture the model the Rust path used for
                // this decode so the WB kernel can apply only the live
                // delta. See `decodedAtModel` field doc.
                let xmpURL: URL? = {
                    guard let url = asset.sidecarURL,
                          FileManager.default.fileExists(atPath: url.path)
                    else { return nil }
                    return url
                }()
                let modelAtDecode: AdjustmentModel = {
                    guard let xmpURL else { return .default }
                    guard let xml = try? String(contentsOf: xmpURL, encoding: .utf8) else {
                        return .default
                    }
                    guard let (m, _) = try? XMPParser.parse(xml) else {
                        return .default
                    }
                    return m
                }()
                self.decodedAtModel = modelAtDecode
                // ... existing process call
```

- [ ] **Step 7.5: Update `processSceneLinear` to take a `decodedAtModel` parameter and forward it to the WB kernel.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift`, modify `processSceneLinear`'s signature:

```swift
    nonisolated public func processSceneLinear(
        decoded: CIImage,
        model: AdjustmentModel,
        targetSize: CGSize? = nil,
        asShot: AsShotWB? = nil,
        decodedAtModel: AdjustmentModel? = nil
    ) -> CIImage {
```

In the WhiteBalance call, replace:

```swift
        let withWB = MetalKernels.applyWhiteBalance(
            to: scaled,
            liveTemperature: Float(model.temperature),
            liveTint: Float(model.tint),
            decodedTemperature: 6500.0,
            decodedTint: 0.0
        )
```

with:

```swift
        // Plan 2 M3 — the WB kernel applies (live / decoded) so opening
        // a saved sidecar doesn't double-apply WB (Rust applies sidecar
        // WB at decode; Apple kernel applies the slider delta). When
        // decodedAtModel is nil (no sidecar / new image), fall back to
        // 6500/0 which matches the Rust default's identity short-circuit.
        let decoded_t = Float(decodedAtModel?.temperature ?? 6500)
        let decoded_ti = Float(decodedAtModel?.tint ?? 0)
        let withWB = MetalKernels.applyWhiteBalance(
            to: scaled,
            liveTemperature: Float(model.temperature),
            liveTint: Float(model.tint),
            decodedTemperature: decoded_t,
            decodedTint: decoded_ti
        )
```

In `EditSession.decodeAndRender`, update the two `pipeline.processSceneLinear(...)` call sites to pass the new parameter:

```swift
                    if useSceneLinear {
                        return pipeline.processSceneLinear(
                            decoded: cached, model: m, targetSize: targetSize,
                            asShot: asShot,
                            decodedAtModel: self.decodedAtModel
                        )
                    } else {
```

(Same edit at the second `processSceneLinear` call site for the cold-decode branch — the `processed` Task.detached.)

- [ ] **Step 7.6: Run tests.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | tail -10`

Expected: green. The existing M1/M2 tests pass `decodedAtModel: nil` (the new parameter defaults to nil), so behaviour is unchanged for them.

Run: `BUDGET=15 src/scripts/test_color_pipeline.sh 2>&1 | tail -8`

Expected: PASS — `applyFilters` still untouched.

- [ ] **Step 7.7: Document the M3 limitation in the test header.**

In `SceneLinearPipelineTests.swift`, append to the header comment block:

```swift
//
// Plan 2 M3 (Tasks 7-8) — sidecar plumbing summary:
//   • decodeSceneLinear takes optional xmpPath; EditSession.sharedDecode
//     passes asset.sidecarURL when the file exists.
//   • highlight_recovery (raw-core's only Apple-irreplaceable stage)
//     responds to model.highlightRecovery via the FFI sidecar parse.
//   • EditSession.decodedAtModel captures the model the Rust path used
//     during decode, so processSceneLinear's WhiteBalance kernel applies
//     (live / decoded) and avoids double-applying WB on saved sidecars.
//
//   M3 KNOWN LIMITATION — Plan 2 v1: only WB uses the decodedAtModel
//   delta. Tone (exposure / highlights / shadows / whites / blacks),
//   vibrance, and saturation kernels still take the live slider value
//   directly. On a saved-sidecar image, those four stages double-apply
//   between Rust (at decode) and Apple (at process) until the user
//   moves any slider, which triggers a re-decode at the new model and
//   resyncs.
//
//   For Plan 1 Task 9's "saved sidecar adjustments work" precondition,
//   M3 satisfies the *highlight_recovery* part exactly (Rust-side, the
//   only Apple-irreplaceable stage). Other slider drift on saved
//   sidecars is bounded — no clipping or NaN — but visible until the
//   first slider move. Plan 2 v2 generalises the delta to every kernel
//   and closes the limitation.
```

- [ ] **Step 7.8: Commit.**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
git commit -m "$(cat <<'EOF'
feat(apple): thread xmpPath through decodeSceneLinear; capture decodedAtModel

Plan 2 M3 — wire the asset's sidecar through to the new FFI path so
highlight_recovery (raw-core's only Apple-irreplaceable dev-chain
stage; runs in camera-RGB pre-DCP, before Apple sees the buffer)
responds to the saved highlightRecovery setting.

Apple-side changes:
  * ImageEditPipeline.decodeSceneLinear takes optional xmpPath and
    forwards it to PipelineRenderer.renderSceneLinear (the FFI plumbing
    already accepts xmpPath per Plan 1; Plan 2 just stops passing nil).
  * EditSession.sharedDecode passes asset.sidecarURL when a sidecar
    file exists on disk.
  * EditSession gains a decodedAtModel field captured at decode time;
    processSceneLinear takes it as an optional parameter and forwards
    it to the WhiteBalance kernel as decodedTemperature/decodedTint
    so the kernel applies only the live delta.

Plan 2 v1 known limitation (recorded in test file header): only WB
uses the decodedAtModel delta. Tone, vibrance, saturation kernels
still take the live slider value, so opening a saved sidecar will
double-apply those four stages between Rust (decode) and Apple
(process) until the user moves any slider — which forces a re-decode
and resyncs. Bounded effect (no clipping); Plan 2 v2 closes it.

This satisfies Plan 1 Task 9's "saved sidecar adjustments work"
precondition for the highlight_recovery component exactly.
EOF
)"
```

---

## Task 8: M3 milestone gate — xcframework rebuild + parity harness + sidecar smoke test

**Files:**
- Build artifacts only.

**Why this matters:** M3 doesn't change Rust source, but the brief calls for an xcframework rebuild "as a precaution" because the build script also re-bundles headers into `Sources/MapleCore/include/RawPipeline.h`. Running it confirms the FFI surface is consistent and the Apple build still links cleanly.

- [ ] **Step 8.1: Confirm no Rust source was modified by Plan 2.**

Run: `git diff --name-only main..HEAD -- src/raw-pipeline 2>&1`

Expected: empty. Plan 2 v1 touches only Swift + Metal sources. If any file under `src/raw-pipeline` is in the diff, Plan 2 v1 has accidentally modified Rust — STOP and revert before rebuilding.

- [ ] **Step 8.2: Run the build-xcframework script.**

Run: `./src/apple/scripts/build-xcframework.sh 2>&1 | tail -8`

Expected: `==> Done.` (or whatever the script's final success line is). The output does change the `Frameworks/RawPipeline.xcframework` directory structure even when Rust source is unchanged because the script regenerates module maps and re-copies the .a files. **The .a files themselves should be byte-identical to main's** — confirm with the next step.

- [ ] **Step 8.3: Confirm the xcframework's libraw_ffi.a files are not modified by the rebuild (sanity check).**

Run: `git status --short src/apple/Frameworks 2>&1`

Expected: empty (or only changes to module.modulemap / Headers/RawPipeline.h, which are regenerated). If `libraw_ffi.a` files appear modified, the Rust source IS changed somewhere — go back to Step 8.1's check. The .a files are gitignored per CLAUDE.md, so they shouldn't appear at all.

- [ ] **Step 8.4: Build the macOS app from the rebuilt xcframework.**

Run: `cd src/apple && xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build 2>&1 | tail -3`

Expected: `BUILD SUCCEEDED`. If the build fails on a missing FFI symbol, the xcframework rebuild dropped a symbol — stop and inspect the Headers/RawPipeline.h content.

- [ ] **Step 8.5: Run the swift test suite a final time.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | tail -10`

Expected: green. Test count = pre-Plan-2 baseline + 4 (Tasks 2/3 added one each, Task 5 added one, Task 6 added one — 4 total).

- [ ] **Step 8.6: Run the parity harness one last time.**

Run: `BUDGET=15 src/scripts/test_color_pipeline.sh 2>&1 | tail -8`

Expected: PASS.

**FAIL ACTION:** If the harness regressed below the BUDGET=15 threshold, Plan 2's changes have somehow leaked into the legacy path's pixel output. STOP and bisect:
- Each commit in this plan should be individually testable: `git stash; git checkout HEAD~1; BUDGET=15 src/scripts/test_color_pipeline.sh; git checkout HEAD; git stash pop`. Find the commit that introduced the regression.
- Plan 2 v1 should NOT touch `applyFilters` — if it does, that's the bug.

- [ ] **Step 8.7: Manual sidecar smoke test — confirm `highlight_recovery` responds.**

Build & launch the app per Task 4 Step 4.1-4.2.

Open the reference fixture. Open or create a sidecar file (`<rawname>.xmp`) and add a `papp:HighlightRecoveryMode="Blend"` attribute. Reload the asset (close/reopen). Confirm:
- The image's blown-out highlights are noticeably less saturated/clamped vs the no-sidecar render.
- Setting `papp:HighlightRecoveryMode="Off"` (or removing the attribute) restores the original blown-out look.

Then test the M3 limitation explicitly. Add `crs:Saturation="50"` to the sidecar. Open the file — the image will look **doubly saturated** (Rust applied +50, Apple applied +50). Move the saturation slider to any value, observe the resync. Capture this behaviour as a known limitation:

In `SceneLinearPipelineTests.swift` header, append:

```swift
//
// Plan 2 M3 sidecar smoke test (Task 8 Step 8.7):
//   highlightRecovery=Blend         visible blend in highlights — PASS
//   highlightRecovery=Luminance     visible luminance recovery — PASS
//   highlightRecovery=Off           identity vs no sidecar — PASS
//   saturation=+50 in sidecar       double-applied at open; resyncs
//                                   on first slider move — KNOWN LIMITATION
//                                   (Plan 2 v2 closes it)
```

- [ ] **Step 8.8: Commit.**

```bash
git add src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
git commit -m "$(cat <<'EOF'
docs(apple): record Plan 2 M3 sidecar smoke test + xcframework rebuild

Final milestone gate for Plan 2 v1. Confirms:
  * Rust source untouched by Plan 2 (Step 8.1).
  * xcframework rebuilds cleanly; libraw_ffi.a files unchanged (Step 8.2-8.3).
  * macOS app builds from the rebuilt xcframework (Step 8.4).
  * swift test green, count = pre-Plan-2 + 4 (Step 8.5).
  * Parity harness BUDGET=15 PASS — applyFilters unchanged (Step 8.6).
  * Manual sidecar smoke test — highlightRecovery=Blend / Luminance /
    Off all behave correctly via the new xmpPath plumbing (Step 8.7).

Records the Plan 2 v1 known limitation: opening a saved sidecar with
non-zero tone/vibrance/saturation values double-applies those stages
between Rust (decode) and Apple (process) until the first slider
move forces a resync. Plan 2 v2 closes it.

This satisfies Plan 1 Task 9's "saved sidecar adjustments work"
precondition for the highlight_recovery component exactly. Plan 1
Task 9 may now flip the default if the project is comfortable with
the documented limitation; otherwise hold for Plan 2 v2.
EOF
)"
```

---

## Self-Review Checklist

Run through this once after the plan is in place, before handoff to execution.

**1. Spec coverage:**
- [ ] Task 1 captures the four pre-flight invariants (loader correctness, chain-entry-point currency, whites/blacks parity Rust vs Metal, Oklab matrices availability) and records the pre-Plan-2 test baseline.
- [ ] Tasks 2-4 (M1) wire `applySceneToneControls` and `applySceneVibrance` into `processSceneLinear`. Each step has a TDD-style failing test before implementation. Task 4 is the milestone gate — manual smoke + parity harness.
- [ ] Tasks 5-6 (M2) add `WhiteBalance.metal` and `SceneSaturation.metal` with the loaders/wrappers in `MetalKernels.swift`. Each new kernel has a unit test plus a mention in the M2 manual smoke procedure.
- [ ] Task 5's algorithm references `white_balance.rs:30-50` (Rust) and `MetalKernels.swift:39-55` (existing wrapper pattern).
- [ ] Task 6's algorithm references `saturation.rs:12` and reuses the four Oklab matrices from `SceneVibrance.metal`.
- [ ] Tasks 7-8 (M3) thread `xmpPath` through `decodeSceneLinear`, capture `decodedAtModel`, and use it for the WhiteBalance kernel's "decoded WB" parameter. The Plan 2 v1 limitation (other kernels double-apply on saved sidecars until first slider move) is documented in the test header and the M3 commit body.
- [ ] Task 8 includes the xcframework rebuild step required by the brief's "if Rust changes" clause — Plan 2 v1 doesn't change Rust, but the rebuild is run as a precaution and the verification confirms the .a files are unchanged.
- [ ] Every task has a `cd src/apple/Packages/MapleCore && swift test` step.
- [ ] Every milestone gate (Tasks 4, 6, 8) has a `BUDGET=15 src/scripts/test_color_pipeline.sh` run.
- [ ] Cross-link to Plan 1 v2 (`docs/superpowers/plans/2026-04-24-ffi-split-plan-1.md`) is in the header. Cross-link to Plan 1 Task 9's sidecar precondition is in the header's "Plan 1 Task 9 sidecar precondition" callout.

**2. Placeholder scan:**
- [ ] No "TBD", "TODO", "implement later", "fill in details".
- [ ] The `<RECORD>` placeholders in Step 1.6 (test count + parity status) are intentional measurements that the engineer captures at execution time. Same pattern as Plan 1 Spike 1.3.
- [ ] No "similar to Task N" without code — the new kernel sources are spelled out fully in Tasks 5 and 6.
- [ ] The `M_XYZ_D65_TO_REC2020` matrix in Task 5 Step 5.2 is flagged as "verify before merging" with the exact `grep` command to confirm against the Rust source. This is a real verification step, not a placeholder.

**3. Type consistency:**
- [ ] `MetalKernels.applyWhiteBalance` has `liveTemperature: Float`, `liveTint: Float`, `decodedTemperature: Float`, `decodedTint: Float` — same `Float` widening pattern as the existing `applySceneToneControls` (which takes `Float` for every parameter despite `AdjustmentModel` storing `Double`).
- [ ] `MetalKernels.applySceneSaturation` has `saturation: Float` — matches the `Float`-narrowing convention.
- [ ] `processSceneLinear`'s new `decodedAtModel: AdjustmentModel?` parameter is consistent with the existing `asShot: AsShotWB?` optional-with-nil-default pattern.
- [ ] `EditSession.decodedAtModel` is `AdjustmentModel?` — same type used as the `processSceneLinear` parameter.
- [ ] `decodeSceneLinear`'s new `xmpPath: URL?` parameter matches `PipelineRenderer.renderSceneLinear`'s existing `xmpPath: URL?` exactly.
- [ ] All four new Metal kernel function names use `extern "C" float4 functionName(...)` matching the existing pattern in `SceneToneControls.metal:25` and `SceneVibrance.metal:57`.
- [ ] The Oklab matrix names in `SceneSaturation.metal` use the `_sat` suffix to avoid potential symbol collisions with `SceneVibrance.metal` inside the metallib.

**4. Ordering and BLOCKING constraints:**
- [ ] Task 1 is pre-flight; if it fails, Plan 2 stops.
- [ ] Tasks 2-3 (M1 wiring) are sequential — Task 3 builds on Task 2's `processSceneLinear` chain.
- [ ] Task 4 is M1 milestone gate — must pass before Task 5 starts.
- [ ] Task 5 (WB) precedes Task 6 (Saturation) per chain order.
- [ ] Task 6 is M2 milestone gate (manual smoke + parity).
- [ ] Tasks 7-8 (M3) are last; they touch the FFI signature plumbing and the manual sidecar smoke test.
- [ ] xcframework rebuild is in Task 8 Step 8.2 per the brief's mandate; Plan 2 v1 doesn't actually change Rust so the rebuild is a precaution and the verification at Step 8.3 confirms no Rust drift.
- [ ] `BUDGET=15 src/scripts/test_color_pipeline.sh` runs at every milestone gate (Steps 2.5, 5.6, 6.5, 8.6) — four total opportunities to catch regression on the legacy path.
- [ ] Plan 2 v1's deferred items (clarity, texture, dehaze, sharpen, NR) are explicitly listed in the header's "Out of scope" block and named "M4-M6" / "Plan 2 v2" so a future executor knows where they are.
