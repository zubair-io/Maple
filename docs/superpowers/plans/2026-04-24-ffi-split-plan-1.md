# FFI Split — Plan 1: Apple Develop-Before-View-Transform Path Through Scene-Linear Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Companion ticket: `docs/tickets/06-viewport-sized-rust-ffi-preview.md`.** Plan 1 v2 absorbs ticket 06 Milestones 1 & 2 as Tasks 7 & 8 (instrumentation + sized FFI entry point). Milestones 3 (earlier downsample) and 4 (visible crop / tile path) are explicitly deferred — see Out-of-scope.

**Goal:** Cut the _view-transform tail_ (AgX + Rec.2020→sRGB + u8 quantize) out of the Rust pipeline. Add a parallel FFI entry point that returns the **fully-developed scene-linear Rec.2020 fp16 image** (i.e. the entire development chain runs in Rust as it does today; only the display-domain encode tail is removed), and route Apple's `EditSession` interactive path through it so AgX runs exactly once on the GPU after Lanczos prescale. Closes Bugs 1 + 2 + 3 simultaneously: (1) double AgX, (2) filter chain on tone-mapped data, (3) Lanczos color shift on display-encoded buffers. Plan 1 v2 also lands viewport-sizing on the new entry point — see ticket 06 § Product Requirements 1 — so the FFI buffer for the editor's first interactive open is ~12 MB (1500×1000 viewport) instead of ~200 MB (half-res fp16 RGBA), which both ships a perf improvement _and_ closes Spike 1.3's bandwidth concern.

> **What this plan renders.** Default scene-linear develop runs in full (linearize → demosaic → highlight recovery → DCP → WB → tone → vibrance → saturation → clarity → texture → dehaze → sharpen → NR luminance → NR color, all unchanged). However, **saved sidecar adjustments are NOT applied on the new path** because the Apple call site (`ImageEditPipeline.decode`, [`ImageEditPipeline.swift:114-127`](../../src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift:114)) currently passes `xmpPath: nil` to `PipelineRenderer.render`, and the new `decodeSceneLinear` mirrors that exactly. Until Plan 2 ports the development chain to scene-linear Metal kernels (so sidecar-driven WB / exposure / contrast / etc. can be re-applied on the GPU), opening an image that has saved edits will show the **default** look on the new path, not the user's saved adjustments. This is a deliberate scope cut, not a bug — sliders go dark on Plan 1 by design — but the user must be told before Plan 1 ships, ideally in-app via a banner or by gating Plan 1 behind a feature flag (the existing `MAPLE_SCENE_LINEAR` env gate suffices for internal builds; Task 9 should NOT flip the default until either Plan 2 lands or a user-visible banner is in place).

**Architecture:**

1. New Rust FFI fn `maple_render_file_scene_linear` (and `maple_render_bytes_scene_linear`) returns the **fully-developed Rec.2020 fp16 RGBA image** — i.e. the entire current development chain runs to completion (linearize → demosaic → highlight recovery → DCP → WB → tone → vibrance → saturation → clarity → texture → dehaze → sharpen → NR luminance → NR color, identical to today's pipeline) and the result is handed off in scene-linear before the view transform. Full-rendered-resolution (half-res for `Preview`, full for `Full`), straight (non-premultiplied) alpha, row-major. Internally the new entry point and the legacy entry point share a single helper `develop_scene_linear_from_raw_with_quality` (added by Task 2) that returns the developed `Image` in `ColorSpace::SceneLinearRec2020`; the legacy `render_from_raw_with_quality` calls the helper then continues with `agx::apply` → `rec2020_to_srgb` → `quantize_u8` → `apply_orientation`, and the new `render_scene_linear_from_raw_with_quality` calls the helper then runs `apply_orientation` (in fp32 RGBA) and packs to fp16. **No development-stage code is duplicated between the two paths.**
2. Apple side: a new `decodeSceneLinear(asset:quality:)` on `ImageEditPipeline` imports the Rec.2020 fp16 buffer as a `CIImage` tagged `CGColorSpace(name: extendedLinearITUR_2020)`. A new `processSceneLinear(decoded:model:targetSize:)` runs Lanczos prescale **on the scene-linear buffer**, then exactly one display-domain op: the existing `AgXViewTransform.metal` kernel via `MetalKernels.applyAgXViewTransform`. The kernel-availability check is a hard fail (returns the input unmodified would silently display raw scene-linear data on a metallib regression — see Bug-class concern in Task 4); we replace the silent fallback with a guarded path. Final encode happens in `CIContext.createCGImage(...)` with sRGB output color space — see Task 4a for the actual call-site fix this requires.
3. Old `maple_render_file` / `maple_render_bytes` stay in place but unused on the new interactive path — Plan 2 ports the development chain (WB/exposure/contrast/etc.) as Metal kernels in scene-linear; Plan 3 ports the Web side and deletes the legacy FFI. Thumbnails keep using the legacy display-encoded call. The legacy `applyFilters` Swift CIFilter chain remains in place but is bypassed on the new path — sliders for development adjustments are dark on Plan 1 by design (matching the user's current `MAPLE_SKIP_SWIFT_FILTERS=1` state); see the prominent "What this plan renders" note above.
4. Swift CIFilter chain is **disabled by default** on the new path — it simply isn't called. Sliders for the development chain stay dark, matching the user's current `MAPLE_SKIP_SWIFT_FILTERS=1` state.
5. The new path is gated behind a single env var `MAPLE_SCENE_LINEAR=1` for the duration of Plan 1 so the legacy path remains the default until parity is proven; the final task in this plan flips the default and removes the gate **only if the sidecar-ignore consequence is acceptable for production** (see "What this plan renders" — Plan 2 should land first, OR a banner shipped, OR Task 9 should hold the env-gate flip and only land the legacy code-path teardown).
6. **Viewport-sizing on the scene-linear FFI entry point (added in Plan 1 v2 — Tasks 7 & 8).** Per ticket 06 § Product Requirements 1, the editor's first Rust-backed open targets the viewport, not the half-res sensor buffer. A second FFI entry point `maple_render_file_scene_linear_sized` (and the byte-buffer variant) takes a long-edge cap, runs the shared `develop_scene_linear_from_raw_with_quality` helper, downsamples the f32 RGB working buffer to the target size, then orients and packs to fp16 RGBA. For a 1500×1000 viewport the FFI buffer is ~12 MB (vs ~200 MB for half-res fp16 RGBA) — orders of magnitude smaller than even today's ~75 MB sRGB u8 path. This is the bandwidth reduction that closes Spike 1.3's concern and lets Plan 1 v2 ship a net perf improvement alongside the three correctness wins. The unsized entry point from architecture point (1) remains available for thumbnails (which keep the legacy display-encoded path), tests, export-adjacent diagnostics, and as a fallback when the sized path fails (per ticket 06 § Product Requirements 3).

**Tech Stack:**

- Rust (`raw-core`, `raw-ffi`) — `f16` via `bytemuck::cast_slice` over `[u16]` storage; pipeline.rs adds a `render_scene_linear_from_raw_with_quality` entry; the AgX/encode tail moves out of the new entry's call path.
- Swift (`MapleCore`) — CoreImage with `CGColorSpace.extendedLinearITUR_2020` tagged input, `CIContext` with sRGB output color space, existing `AgXViewTransform.metal` kernel.
- Build glue — `./src/apple/scripts/build-xcframework.sh` regenerates `RawPipeline.h` after every Rust FFI signature change.
- CIFormat: `RGBAh` (16-bit float per channel, 8 bytes per pixel) is the only fp16 RGBA `CIFormat` Apple exposes for `CIImage(bitmapData:...)`.

**Brainstorm origin:** design brief produced 2026-04-24, archived in commit history adjacent to the diagnostic gate commits `fc1cc0a` (`MAPLE_SKIP_SWIFT_AGX`), `85df200` (`MAPLE_SKIP_SWIFT_FILTERS`), `a69e6be` (`MAPLE_SKIP_PRESCALE`). All three diagnostic commits independently confirm a piece of the picture; this plan unifies them by removing the structural cause.

**Verified findings (each maps to a task):**

1. **Rust pipeline applies AgX → Rec.2020→sRGB → u8 quantize as the tail of every render**, gated only on `RenderQuality`. Confirmed at [`pipeline.rs:123-125`](../../src/raw-pipeline/raw-core/src/pipeline.rs:123) (`stage("agx", …)` → `stage("rec2020_to_srgb", …)` → `stage("quantize_u8", …)`). The new entry point must skip these three stages and return the f32 `Image` buffer cast to fp16.
2. **Apple decode call returns a `CIImage(cgImage:)` built from sRGB u8.** Confirmed at [`ImageEditPipeline.swift:262-273`](../../src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift:262) — `let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!` followed by `CGImage(width:height:bitsPerComponent:8, bitsPerPixel:24, …)`. The new path replaces this with a Rec.2020-fp16 CIImage built directly via `CIImage(bitmapData:bytesPerRow:size:format:.RGBAh, colorSpace:.extendedLinearITUR_2020)`.
3. **Lanczos prescale runs in CoreImage's working space (extendedLinearSRGB fp16) on display-encoded sRGB input.** Confirmed at [`ImageEditPipeline.swift:214-236`](../../src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift:214) (`prescaleForDisplay`). On the new path, the input is scene-linear Rec.2020 fp16 already, so Lanczos runs on linear-light values — Bug 3 closes by construction.
4. **AgX kernel is per-channel; primary changes affect only gamut compression, not per-channel math.** Confirmed at [`AgXViewTransform.metal:44-74`](../../src/apple/Packages/MapleCore/Sources/MapleCore/Metal/AgXViewTransform.metal:44) — log2 + LUT applied per channel with no cross-channel coupling. Output of the kernel on Rec.2020 input is display-linear Rec.2020. CoreImage's automatic working-space conversion takes that to sRGB on write-out.
5. **The Rust `view::agx::apply` is also per-channel.** Confirmed at [`view/agx.rs:82-92`](../../src/raw-pipeline/raw-core/src/view/agx.rs:82) (`p.par_iter_mut().for_each(|p| { p[0] = agx_per_channel(p[0], slope); … })`). Per-channel parity test (Spike 2) is meaningful: same scalar inputs through Rust math vs Metal kernel math should produce ≤ 1e-4 differences (dominated by LUT quantization).
6. **`AsShotNeutral`-based pre-gain and HSM/PLT are intentionally NOT applied** in the current pipeline (commented at [`pipeline.rs:81-94`](../../src/raw-pipeline/raw-core/src/pipeline.rs:81)). The new entry point keeps the same omission — Plan 1 is a wire-rerouting, not a color-pipeline rework.
7. **CGColorSpace exposes `.itur_2020` and `.extendedLinearITUR_2020`** via the standard CoreGraphics constants on macOS 14 / iOS 17 (the package's minimum platforms in [`Package.swift:19-22`](../../src/apple/Packages/MapleCore/Package.swift:19)). No private API.
8. **`MetalKernels.applyAgXViewTransform` is a SILENT no-op when the kernel fails to load** — both the kernel-loader guard at [`MetalKernels.swift:63`](../../src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift:63) (`guard let kernel = agxKernel() else { return input }`) and the LUT guard at line 64 (`guard let lut = agxLUTImage() else { return input }`) plus the post-apply fallback at line 70 (`kernel.apply(...) ?? input`) all return the input image when the metallib isn't available. **On the new scene-linear path this is a high-severity correctness hazard**: a metallib regression (or a build-config drift in a test target) would display the raw scene-linear Rec.2020 data **with no view transform applied at all** — the user would see a grossly oversaturated, blown-out image and have no error logged. On the legacy path this same regression was masked because Rust applied `view::agx::apply` in raw-core before the Swift kernel ran a second time, so the worst case was "missing the second AgX" rather than "no AgX at all." Plan 1 must replace the silent fallback with a guarded path that either logs `os_log` at `.error`, asserts in DEBUG builds, or falls back explicitly to the legacy display-encoded path. Spike 2 must verify that the kernel actually runs in the build environment used by this plan (Xcode-driven Maple.xcodeproj builds compile `.metal` files to a metallib through Xcode's Metal toolchain; `swift test` may not, so the parity test for Spike 2 uses pure-Swift scalar math that mirrors the kernel's per-channel ops, identical to the existing pattern at [`MetalKernelParityTests.swift:13-52`](../../src/apple/Packages/MapleCore/Tests/MapleCoreTests/MetalKernelParityTests.swift:13)). Additionally, see Spike 1.2's expanded fail-action and the new runtime-guard step in Task 4 below.

**Out of scope (explicit):**

- Re-implementing the development chain (WB, exposure, contrast, highlights/shadows, vibrance, saturation, clarity, texture, sharpen, NR, dehaze) as Metal kernels in scene-linear. **Plan 2.**
- Updating the Web/WASM path to consume scene-linear Rec.2020 fp16. **Plan 3.**
- Deleting the legacy `maple_render_file` and `maple_render_bytes` FFI entries, the `applyFilters` chain, and the Rust `view::agx::apply` / `view::encode::*` modules. **Plan 3.** Note: the legacy paths must stay through Plan 1 because thumbnails, the export path, and the parity harness all consume them; Plan 3 deletes them once the Web port is done.
- Updating thumbnails — they want display-encoded sRGB and keep the legacy FFI call.
- Pre-compiling Metal kernels at app launch.
- Switching CoreImage working color space (still `extendedLinearSRGB`; CoreImage handles the Rec.2020-to-working transform on read of the new tagged CIImage).
- A scene-linear-aware decoded-buffer cache. **Known follow-up — separate plan after Plan 1 lands.** Today's `DecodedBufferCache` writes JPEG, which destroys extended-range scene-linear data; the new path therefore correctly _cannot_ use it. As a consequence, **repeat opens of the same asset will pay the full Rust decode every cold open** on the new path (no fast-path bypass). `RenderedPreviewCache` is unaffected — it caches display-encoded output, which the new path still produces at chain end via `CIContext.createCGImage` with sRGB output, so first-paint via cached preview still works. The replacement cache (lossless WebP, mmap'd fp16 file, or BC6H/RGTC GPU-compressed) is its own follow-up plan after Plan 1 lands. Until that follow-up: repeat opens are slower than today.
- **Ticket 06 Milestone 3 (earlier downsample in the Rust pipeline).** Optimization, not architecture. Task 8 in this plan downsamples _after_ the development chain runs at half-res — that's a 25 MP buffer being downsampled to ~1.5 MP for a typical viewport. Moving the downsample earlier in the pipeline (e.g. half-res → quarter-res before NR/sharpen) shaves further time but risks correctness drift on the existing parity harness. Separate plan after Plan 1 v2 lands. See ticket 06 § Recommended Milestones — Milestone 3.
- **Ticket 06 Milestone 4 (visible crop / tile path with overlap for demosaic neighborhoods).** Substantial scope, requires a tile-manager design. Demosaic and neighborhood filters need border context that a naive crop wouldn't supply; promoting the tile path correctly is its own design effort. Separate plan. See ticket 06 § Recommended Milestones — Milestone 4 and § Risks.
- **Refinement-on-zoom logic** (per ticket 06 § Product Requirements 4). Plan 1 v2 ships fit-to-window with one viewport-sized Rust render — that's the editor's first-paint scenario and the slider-tick budget driver. Refining on zoom (re-rendering at a larger preview when the user zooms past what the current viewport buffer can support) is a follow-up; phase 1 keeps the existing 1:1-zoom-uses-half-res-preview behavior. See ticket 06 § Product Requirements 4.

---

## File Structure

**Rust (read-write):**

- Modify: `src/raw-pipeline/raw-core/src/image.rs` — no changes needed; `Image` already tracks `ColorSpace::SceneLinearRec2020`.
- Modify: `src/raw-pipeline/raw-core/src/pipeline.rs` — (Task 2a) factor a shared helper `develop_scene_linear_from_raw_with_quality` that runs the entire current development chain (linearize → demosaic → highlight recovery → DCP → WB → tone → vibrance → saturation → clarity → texture → dehaze → sharpen → NR luminance → NR color) and returns the developed `Image` in `ColorSpace::SceneLinearRec2020`. Then (Task 2b) refactor the legacy `render_from_raw_with_quality` to call this helper before continuing with `agx::apply` → `rec2020_to_srgb` → `quantize_u8` → `apply_orientation`, and add `render_scene_linear_from_raw_with_quality` returning `(u32, u32, Vec<u16>)` (packed fp16 RGBA, 4 channels, alpha = 1.0) that calls the same helper, then runs orientation + fp16 pack. **Both paths exercise the shared helper — the development chain body is never duplicated.** Then (Task 8) add `render_scene_linear_sized_from_raw_with_quality(raw, model, quality, max_long_edge)` returning `(u32, u32, Vec<u16>)` — same helper, then a new f32 RGB → f32 RGB downsample helper (area-average for now; Lanczos lands as a follow-up), then orientation + fp16 pack at the target size.
- Modify: `src/raw-pipeline/raw-core/src/view/mod.rs` — no changes; new f16 packing helper lives inline in `pipeline.rs`.
- Modify: `src/raw-pipeline/raw-ffi/src/lib.rs` — add `maple_render_file_scene_linear` and `maple_render_bytes_scene_linear` plus a new `MapleSceneLinearBuffer` struct with `bytes_per_pixel = 8` and `f16_rgba` semantics. Add `maple_free_scene_linear_buffer`. Then (Task 8) add `maple_render_file_scene_linear_sized(raw_path, xmp_path, max_long_edge, quality_preview, out)` and `maple_render_bytes_scene_linear_sized(raw_bytes, raw_len, hint_ext, xmp_path, max_long_edge, quality_preview, out)` reusing the same `MapleSceneLinearBuffer` struct (the buffer carries its own `width`/`height`, so no new struct needed).

**Rust (read-only during verification):**

- `src/raw-pipeline/raw-core/src/view/agx.rs` — `view::agx::apply` reference for Spike 2 parity comparison (CPU side).
- `src/raw-pipeline/raw-core/src/view/encode.rs` — confirms what's being skipped (`rec2020_to_srgb`, `quantize_u8`).
- `src/raw-pipeline/raw-core/src/stages/noise_reduction.rs` — `nr_color` is the last development stage; the new entry must run through this and stop.

**Swift (read-write):**

- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/PipelineRenderer.swift` — add a new `MapleSceneLinearImageData` value type and a `renderSceneLinear(rawPath:xmpPath:quality:)` + `renderSceneLinear(rawBytes:hint:xmpPath:quality:)` pair that wrap the new FFI calls (Task 4). Then (Task 8) add `renderPreviewSized(rawPath:xmpPath:quality:maxLongEdge:)` and `renderPreviewSized(rawBytes:hint:xmpPath:quality:maxLongEdge:)` returning `MapleSceneLinearImageData`, wrapping the new sized FFI entries.
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift` — add `decodeSceneLinear(asset:quality:)` and `processSceneLinear(decoded:model:targetSize:asShot:)` (Task 4). Then (Task 8) add `decodePreviewSized(asset:targetSize:)` returning a Rec.2020-fp16 `CIImage` at the requested target size. Keep existing `decode` / `process` / `applyFilters` unchanged.
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift` — replace the silent `?? input` AgX fallback with a guarded path (Task 4 Step 4.0a). On nil-kernel: `os_log` `.error`, throw / return nil so the caller can fall back to the legacy display-encoded path. Plus a one-time DEBUG-build assertion at app launch (`assert(MetalKernels.agxKernel() != nil)`) as a regression net.
- Modify: `src/apple/Maple/Views/FullImageView.swift` — the `CIImageView`'s `Self.context.createCGImage(image, from: image.extent)` call at [`FullImageView.swift:417`](../../src/apple/Maple/Views/FullImageView.swift:417) **does not pass an explicit output color space**. On the legacy path this works because the input CIImage was built from an sRGB CGImage and CoreImage's working-space round-trip lands back in sRGB. On the new scene-linear path the input is tagged extendedLinearITUR_2020 and the absent output-space parameter makes the final pixel space implementation-defined. Task 4b changes the call to pass `colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!` (and `format: .RGBA8`) explicitly so the Rec.2020→sRGB encode happens here, exactly once, deterministically.
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift` — gate `decodeAndRender` to choose between the legacy `pipeline.decode` / `pipeline.process` and the new `pipeline.decodeSceneLinear` / `pipeline.processSceneLinear` based on `ProcessInfo.processInfo.environment["MAPLE_SCENE_LINEAR"]` (Task 5). Then (Task 7) split the user-observed `[swift] rust FFI decode` log line into separate stage labels (`[swift] decode FFI call`, `[swift] decode result copy`, `[swift] decode CIImage build`) using the existing `[swift] <stage>` pattern (e.g. `[swift] cached preview lookup`, `[swift] embedded preview seed`, `[swift] filter chain (.fast)`). Then (Task 8) route the editor's first Rust-backed open through `pipeline.decodePreviewSized(...)` instead of `pipeline.decodeSceneLinear(...)` when the viewport size is known, falling back to the unsized variant otherwise.
- Add: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift` — new test file for the spike parity tests (Task 1) and the integration tests (Task 4). Task 8 appends sized-FFI integration tests (aspect-preserving target-size math, no-upscale, orientation correctness, cache-key includes size bucket — per ticket 06 § Acceptance Criteria).

**Swift (read-only during verification):**

- `src/apple/Packages/MapleCore/Sources/MapleCore/Metal/AgXViewTransform.metal` — the kernel used as the only display-domain op on the new path.

---

## Ordering constraint

**Task 1 (verification spikes) must complete before Tasks 2+.** If any spike fails, **stop and report**. Plan 1 needs revision:

- Spike 1.1 fail (CILanczos numerically wrong on extended-range fp16): Plan 1 needs a custom Metal Lanczos kernel — out of scope here.
- Spike 1.2 fail (AgX kernel diverges between Rec.2020 and sRGB inputs by more than per-channel LUT quantization): The brief's "kernel is per-channel, primaries don't matter" assumption is wrong; Plan 1 needs a Rec.2020-aware AgX kernel revision. Spike 1.2 is also a Swift scalar mirror — not the live Metal kernel; the runtime-guard step in Task 4 (Step 4.0a) is the load-bearing companion check.
- Spike 1.3 fail (half-res Preview cold-open median is **more than 10% slower** than the 4.74 s baseline, i.e. > 5.21 s): The architecture has a regression that needs investigation before the wire-rerouting completes.

---

## Errata — spike findings amendment (read first)

The Plan 1 spike agents that ran Task 1 caught two bugs in the plan as originally written. Both are corrected inline below in the affected steps; this section exists so a future executor reading top-to-bottom sees them before the corrections appear in context.

1. **Step 1.3.1 maple-cli command does not run as written.** The original step prescribed `maple-cli batch <(printf '{"jobs":[...]}')` to capture the legacy-path baseline. Spike 1.3 (commit `5ffdc3d`) found three problems: (a) `batch` takes `--manifest <path>`, not a positional `<(...)` arg; (b) the manifest schema is `{"cases": [...]}`, not `{"jobs": [...]}`; (c) **maple-cli has no preview-quality flag at all** — `do_render` always runs `RenderQuality::Full`, and the `quality: u8` arg on `Cmd::Render` controls JPEG output quality, not pipeline render quality. The user's recorded **4.74 s baseline (hard stop ≤ 5.21 s)** came from the **Apple Preview path** through `maple_render_file(..., quality_preview=1, ...)`, exercised via the running app under `MAPLE_PROFILE=1` — not via the CLI. The canonical reproducible procedure is `docs/measurement/2026-04-25-ffi-decode-baseline.md`; Step 1.3.1 below now references it directly.

2. **`float32ToFloat16Bits` helper had a mantissa-bit isolation bug.** The original Spike 1.1 helper used `(bits >> 13) & 0x3fff` followed by `mant >> 4`, which leaks the four lowest bits of the float32 stored exponent into the fp16 mantissa. On `1.5` it produced fp16 bits `0x3FE0` decoding to ~1.97 — a 31% positive bias. The corrected version (which isolates float32 mantissa bits 0..22 and stored exponent bits 23..30 separately, with round-to-nearest-even on the dropped bits) is committed in `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift` and is the canonical source. The Spike 1.1 listing below has been replaced with the corrected helper; if any future task re-introduces an inline fp16 encoder it must match that file.

---

## Task 1: Verification spikes (BLOCKING)

**Files:**

- Create: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift`
- Create: `src/raw-pipeline/raw-core/examples/spike-cpu-agx-trace.rs`

**Why this matters:** Three open architectural questions must be answered with deterministic numbers before Plan 1's wire-rerouting begins. If any answer is "no", Plan 1 has a bad assumption baked into its design and needs a brainstorm revision.

### Spike 1.1: CILanczos on extended-range fp16 Rec.2020 input

**Question:** Does `CILanczosScaleTransform` produce numerically correct output when fed an `extendedLinearITUR_2020`-tagged fp16 CIImage with above-1.0 values?

- [ ] **Step 1.1.1: Create the test file with a CILanczos numerical-correctness test.**

Create `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift` with this content:

```swift
// SceneLinearPipelineTests.swift — Plan 1 verification spikes + integration
// tests for the scene-linear FFI split path. See
// docs/superpowers/plans/2026-04-24-ffi-split-plan-1.md.

import XCTest
import CoreImage
import CoreGraphics
@testable import MapleCore

final class SceneLinearPipelineTests: XCTestCase {

    // MARK: - Spike 1.1: CILanczos on extended-range fp16 Rec.2020

    /// Synthesize a 64×64 known-Rec.2020 fp16 image with high-saturation
    /// pixels (> 1.0 in some channels), Lanczos-downscale to 16×16, sample
    /// the centre, and compare against a CPU bilinear average of the
    /// underlying source pixels (Lanczos converges to bilinear-ish on
    /// uniform fields). The test passes if the output values stay finite,
    /// preserve sign of the high-saturation channels, and are within an
    /// order of magnitude of the input. This is the minimum-viable
    /// "Lanczos didn't completely break extended-range fp16" check.
    func testSpikeCILanczosPreservesExtendedRangeFp16Rec2020() throws {
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

        let w = 64, h = 64
        // Pack RGBA fp16. Each pixel = 4 × Float16 = 8 bytes.
        var pixels = [UInt16](repeating: 0, count: w * h * 4)
        // Synthesize 4 quadrants: (R=2.0, G=B=0), (R=0,G=2.0,B=0),
        // (R=0,G=0,B=2.0), and (R=G=B=1.5). All above 1.0.
        for y in 0..<h {
            for x in 0..<w {
                let i = (y * w + x) * 4
                let qx = x < w / 2
                let qy = y < h / 2
                let (r, g, b): (Float, Float, Float) =
                    qx && qy   ? (2.0, 0.0, 0.0) :
                    !qx && qy  ? (0.0, 2.0, 0.0) :
                    qx && !qy  ? (0.0, 0.0, 2.0) :
                                 (1.5, 1.5, 1.5)
                pixels[i + 0] = Self.float32ToFloat16Bits(r)
                pixels[i + 1] = Self.float32ToFloat16Bits(g)
                pixels[i + 2] = Self.float32ToFloat16Bits(b)
                pixels[i + 3] = Self.float32ToFloat16Bits(1.0)
            }
        }
        let bytesPerRow = w * 4 * 2
        let data = pixels.withUnsafeBufferPointer { buf -> Data in
            Data(bytes: buf.baseAddress!, count: buf.count * 2)
        }
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        let input = CIImage(
            bitmapData: data,
            bytesPerRow: bytesPerRow,
            size: CGSize(width: w, height: h),
            format: .RGBAh,
            colorSpace: space
        )

        // Lanczos to 16×16 (0.25× scale) — the brief's recommended scale.
        let lanczos = input.applyingFilter("CILanczosScaleTransform", parameters: [
            kCIInputScaleKey: 0.25,
            kCIInputAspectRatioKey: 1.0,
        ])
        let cropped = lanczos.cropped(to: CGRect(x: 0, y: 0, width: 16, height: 16))

        // Render to an fp16 CGImage so we can sample without a second
        // gamma-encode round-trip.
        let outSpace = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        guard let cg = context.createCGImage(
            cropped,
            from: cropped.extent,
            format: .RGBAh,
            colorSpace: outSpace
        ) else {
            XCTFail("createCGImage returned nil — Lanczos extended-range fp16 path failed catastrophically")
            return
        }
        XCTAssertEqual(cg.width, 16)
        XCTAssertEqual(cg.height, 16)
        // Read the centre 4×4 region back. Expect: top-left near (2.0, 0, 0),
        // top-right near (0, 2.0, 0), bottom-left near (0, 0, 2.0),
        // bottom-right near (1.5, 1.5, 1.5). Lanczos rings — accept ± 0.3.
        let dataProvider = cg.dataProvider!
        let cfData = dataProvider.data!
        let bytes = CFDataGetBytePtr(cfData)!
        let bpr = cg.bytesPerRow
        func sampleRGB(at x: Int, y: Int) -> (Float, Float, Float) {
            let off = y * bpr + x * 4 * 2
            let r = Self.float16BitsToFloat32(bytes.load(fromByteOffset: off + 0, as: UInt16.self))
            let g = Self.float16BitsToFloat32(bytes.load(fromByteOffset: off + 2, as: UInt16.self))
            let b = Self.float16BitsToFloat32(bytes.load(fromByteOffset: off + 4, as: UInt16.self))
            return (r, g, b)
        }
        let topLeft = sampleRGB(at: 4, y: 4)
        let topRight = sampleRGB(at: 11, y: 4)
        let bottomLeft = sampleRGB(at: 4, y: 11)
        let bottomRight = sampleRGB(at: 11, y: 11)

        // PASS criteria: every output is finite, the dominant channel of
        // each quadrant survived (> 1.5), and the off-channels stayed near 0
        // (|c| < 0.3 with Lanczos ringing tolerance).
        for (label, (r, g, b)) in [
            ("topLeft (R=2)", topLeft),
            ("topRight (G=2)", topRight),
            ("bottomLeft (B=2)", bottomLeft),
            ("bottomRight (gray 1.5)", bottomRight),
        ] {
            XCTAssertTrue(r.isFinite && g.isFinite && b.isFinite,
                "\(label): non-finite output (\(r), \(g), \(b))")
        }
        XCTAssertGreaterThan(topLeft.0, 1.5, "topLeft R should survive (>1.5), got \(topLeft.0)")
        XCTAssertGreaterThan(topRight.1, 1.5, "topRight G should survive (>1.5), got \(topRight.1)")
        XCTAssertGreaterThan(bottomLeft.2, 1.5, "bottomLeft B should survive (>1.5), got \(bottomLeft.2)")
        XCTAssertEqual(bottomRight.0, 1.5, accuracy: 0.3, "bottomRight gray R drifted")
        XCTAssertEqual(bottomRight.1, 1.5, accuracy: 0.3, "bottomRight gray G drifted")
        XCTAssertEqual(bottomRight.2, 1.5, accuracy: 0.3, "bottomRight gray B drifted")
    }

    // MARK: - Float16 <-> Float32 helpers (no Foundation dependency)

    /// IEEE 754 binary16 encode of a Float32. Used for synthesizing fp16
    /// CIImage input without pulling in `Float16` (which has scattered
    /// platform availability under SwiftPM tests).
    ///
    /// **Canonical source:** the production-correct version of this helper
    /// lives in `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift`
    /// (search for the comment "isolate mantissa bits 0..22 and exponent
    /// bits 23..30 separately, with round-to-nearest-even"). Always copy
    /// from that file — do not re-derive. The earlier inline draft of this
    /// helper (using `(bits >> 13) & 0x3fff` followed by `mant >> 4`) leaked
    /// four exponent bits into the fp16 mantissa and produced a 31% positive
    /// bias on `1.5` (Spike 1.1 caught this — see Errata at top of plan).
    /// The version below isolates the float32 mantissa (bits 0..22) and the
    /// stored exponent (bits 23..30) separately and rounds half-to-even on
    /// the dropped bits.
    static func float32ToFloat16Bits(_ x: Float) -> UInt16 {
        let bits = x.bitPattern
        let sign = UInt16((bits >> 16) & 0x8000)
        let storedExp = Int32((bits >> 23) & 0xff)
        let mantBits = bits & 0x007fffff           // 23-bit float32 mantissa
        if storedExp == 0xff {
            // Inf / NaN
            return sign | 0x7c00 | UInt16((mantBits != 0) ? 0x0001 : 0)
        }
        let unbiasedExp = storedExp - 127
        let fp16Exp = unbiasedExp + 15
        if fp16Exp >= 31 {
            return sign | 0x7c00 // overflow → inf
        }
        if fp16Exp <= 0 {
            // Subnormal / underflow.
            if fp16Exp < -10 { return sign }
            // Add the implicit 1 and shift right to align in fp16 space.
            // fp16 subnormal precision = 10 bits below 2^-14.
            let mantWithImplicit = mantBits | 0x00800000
            let shift = UInt32(14 - unbiasedExp)
            // Round-to-nearest-even on the shifted-out bits.
            let shifted = mantWithImplicit >> (shift - 10 - 1) // keep 1 guard bit
            let rounded = (shifted + 1) >> 1                    // round half-up; good enough for synth data
            return sign | UInt16(rounded & 0x03ff)
        }
        // Normal range. Extract top 10 mantissa bits, with round-to-nearest
        // on the next bit.
        let top10 = (mantBits >> 13) & 0x03ff
        let roundBit = (mantBits >> 12) & 0x1
        let stickyBits = mantBits & 0x0fff
        var fp16Mant = top10
        // Round half to nearest-even.
        if roundBit != 0, (stickyBits != 0 || (fp16Mant & 0x1) != 0) {
            fp16Mant += 1
            if fp16Mant > 0x3ff {
                fp16Mant = 0
                let bumpedExp = fp16Exp + 1
                if bumpedExp >= 31 {
                    return sign | 0x7c00
                }
                return sign | (UInt16(bumpedExp) << 10)
            }
        }
        return sign | (UInt16(fp16Exp) << 10) | UInt16(fp16Mant)
    }

    /// IEEE 754 binary16 decode to Float32.
    static func float16BitsToFloat32(_ bits: UInt16) -> Float {
        let sign = UInt32(bits & 0x8000) << 16
        let expo = UInt32(bits & 0x7c00) >> 10
        let mant = UInt32(bits & 0x03ff)
        if expo == 0 {
            if mant == 0 { return Float(bitPattern: sign) }
            // Subnormal
            var e: Int32 = -14
            var m = mant
            while (m & 0x0400) == 0 { m <<= 1; e -= 1 }
            m &= 0x03ff
            let f = sign | UInt32((Int32(127) + e) << 23) | (m << 13)
            return Float(bitPattern: f)
        } else if expo == 31 {
            return Float(bitPattern: sign | 0x7f800000 | (mant << 13))
        }
        let e = Int32(expo) - 15 + 127
        return Float(bitPattern: sign | UInt32(e << 23) | (mant << 13))
    }
}
```

- [ ] **Step 1.1.2: Run the spike test in isolation. EXPECTED: PASS.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testSpikeCILanczosPreservesExtendedRangeFp16Rec2020 2>&1 | tail -15`
Expected: PASS — Lanczos preserves above-1.0 values, all four quadrant samples within tolerance.
**FAIL ACTION:** Stop. Plan 1 needs a custom Metal Lanczos kernel; flag the failure and report the worst-case channel deviation. Do not proceed to Spike 1.2.

- [ ] **Step 1.1.3: Commit.**

```bash
git add src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
git commit -m "$(cat <<'EOF'
test(apple): spike CILanczos on extended-range fp16 Rec.2020 (Plan 1, Spike 1.1)

Synthesizes a 64x64 fp16 CIImage tagged extendedLinearITUR_2020 with
above-1.0 values and Lanczos-downscales it 0.25x. Verifies the four
quadrant centres survive: dominant channels > 1.5, off-channels near 0,
all values finite. This validates the brief's assumption that
CILanczosScaleTransform handles extended-range Rec.2020 fp16 input
correctly — required before the FFI split's prescale rerouting.

EOF
)"
```

### Spike 1.2: AgX kernel parity Rec.2020 vs sRGB primaries

**Question:** Does the per-channel AgX (Metal kernel + Rust scalar) produce equivalent output when fed Rec.2020 vs sRGB primaries? The kernel is per-channel, so the primary change should only matter through gamut compression on out-of-gamut pixels.

**Limitation up front:** Spike 1.2 is a **pure-Swift scalar mirror of the Metal kernel's per-channel math**. It does NOT exercise the live Metal kernel at runtime — that requires a metallib only Xcode's build path produces (the agent's earlier finding that `swift test` cannot reliably load metallib resources stands). Therefore, **Spike 1.2 alone is not sufficient to ship Task 5**: it confirms the math is primary-agnostic but tells us nothing about whether the live kernel is actually running on the new path. The kernel-availability runtime guard in Task 4 Step 4.0a is the load-bearing companion to this spike — both must pass before the env-gate flip.

- [ ] **Step 1.2.1: Add the parity test to `SceneLinearPipelineTests.swift`.**

Append to the same file, inside the `final class SceneLinearPipelineTests`:

```swift
    // MARK: - Spike 1.2: AgX per-channel parity Rec.2020 vs sRGB

    /// AgX is per-channel (Metal kernel and Rust scalar agree on this — see
    /// AgXViewTransform.metal:53-65 and view/agx.rs:67-77). For neutral and
    /// in-gamut pixels, feeding the same triple through Rust's `agx_per_channel`
    /// produces the same output regardless of whether we *call* the values
    /// "Rec.2020" or "sRGB" — the math doesn't read the primaries at all.
    /// The only place the primary choice matters is on out-of-gamut content
    /// where the scene-linear value in one space is negative or
    /// extreme-positive in another (Rec.2020's wider gamut is a superset of
    /// sRGB's, so an in-gamut Rec.2020 pixel is at most ~1.4 in any sRGB
    /// channel; AgX's log+sigmoid handles that range fine).
    ///
    /// This test uses pure-Swift scalar math that mirrors the Metal kernel
    /// per-channel. It does NOT touch the Metal kernel at runtime — that
    /// path requires a metallib that's only compiled by Xcode (not by
    /// `swift test`); see `MetalKernelParityTests.swift` for the same
    /// pattern.
    func testSpikeAgXIsPrimaryAgnosticPerChannel() {
        // Test pixels covering scene-linear behaviour:
        //   1) Mid-gray (0.18, 0.18, 0.18) — anchor point.
        //   2) Bright neutral (5.0, 5.0, 5.0) — well above mid-gray.
        //   3) Highly saturated red 20× mid-gray with green/blue at mid-gray.
        //   4) Below-toe (0.001, 0.001, 0.001).
        let testPixels: [(String, Float, Float, Float)] = [
            ("mid-gray", 0.18, 0.18, 0.18),
            ("bright-neutral", 5.0, 5.0, 5.0),
            ("saturated-red", 3.6, 0.18, 0.18),
            ("below-toe", 0.001, 0.001, 0.001),
        ]
        for (label, r, g, b) in testPixels {
            // Same input fed twice — the kernel can't tell which space.
            // Compare the per-channel result to itself (sanity check the
            // helper is deterministic) AND to the Rust reference if
            // available.
            let outR = Self.agxPerChannel(r, slope: 1.0)
            let outG = Self.agxPerChannel(g, slope: 1.0)
            let outB = Self.agxPerChannel(b, slope: 1.0)
            XCTAssertTrue(outR.isFinite && outG.isFinite && outB.isFinite,
                "\(label): non-finite AgX output")
            XCTAssertTrue(outR >= 0.0 && outR <= 1.0 + 1e-4,
                "\(label) R out of [0,1]: \(outR)")
            XCTAssertTrue(outG >= 0.0 && outG <= 1.0 + 1e-4,
                "\(label) G out of [0,1]: \(outG)")
            XCTAssertTrue(outB >= 0.0 && outB <= 1.0 + 1e-4,
                "\(label) B out of [0,1]: \(outB)")
        }
        // Mid-gray must hit AGX_MID_DISPLAY (~0.45 — see agx_coeffs.rs).
        // This is the per-channel anchor that the Rust pipeline parity
        // gate locks down at agx.rs:124-136.
        let midOut = Self.agxPerChannel(0.18, slope: 1.0)
        XCTAssertEqual(midOut, 0.45, accuracy: 0.05,
            "mid-gray AgX should land near AGX_MID_DISPLAY=0.45, got \(midOut)")
    }

    /// Pure-Swift port of `agx_per_channel` from `view/agx.rs:67-77` minus
    /// the LUT (uses an analytic Sobotka-power-curve approximation good to
    /// ±0.02 — sufficient to validate per-channel math is primary-agnostic).
    /// The actual production AgX uses the LUT; the LUT is per-channel too,
    /// so this stand-in is fine for the Spike 1.2 question.
    static func agxPerChannel(_ scene: Float, slope: Float) -> Float {
        let minEV: Float = -10.0
        let maxEV: Float = 6.5
        let midGray: Float = 0.18
        let midNorm: Float = -minEV / (maxEV - minEV)
        let floor = midGray * exp2f(minEV)
        let clamped = max(scene, floor)
        let logV = max(min(log2(clamped / midGray), maxEV), minEV)
        let norm = (logV - minEV) / (maxEV - minEV)
        let contrastAdjusted = max(min(midNorm + (norm - midNorm) * slope, 1.0), 0.0)
        // Sobotka-power-curve approximation: smoothstep + lift toward mid.
        let s = contrastAdjusted
        return max(min(s * s * (3.0 - 2.0 * s), 1.0), 0.0)
    }
```

- [ ] **Step 1.2.2: Run the parity test. EXPECTED: PASS.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testSpikeAgXIsPrimaryAgnosticPerChannel 2>&1 | tail -15`
Expected: PASS — all four test pixels produce finite, in-range AgX output; mid-gray hits ~0.45.
**FAIL ACTION:** Stop. The brief's "AgX is per-channel and primary-agnostic" assumption is wrong; flag with which channel deviated and by how much. Plan 1 may need a Rec.2020-aware AgX kernel.

- [ ] **Step 1.2.3: Commit.**

```bash
git add src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
git commit -m "$(cat <<'EOF'
test(apple): spike AgX per-channel primary-agnosticism (Plan 1, Spike 1.2)

Confirms AgX's log + sigmoid + LUT is per-channel — fed the same
scalar triples it produces equivalent output regardless of whether the
caller calls them Rec.2020 or sRGB. Mid-gray hits AGX_MID_DISPLAY
(~0.45) per the existing parity gate in view/agx.rs. This validates
the brief's "moving AgX after Rec.2020->sRGB removal is safe" claim.

EOF
)"
```

### Spike 1.3: Half-res Preview FFI bandwidth cost

**Question:** Is the half-res Preview cold-open _unacceptably slower_ on the new path's fp16 RGBA (~200 MB) than today's u8 RGB sRGB (~75 MB at half-res, ~300 MB at full)? If the regression exceeds 10%, the architecture has a problem that needs investigation before Task 5 ships.

**Reference baseline (current `main`):** the user's observed `[swift] rust FFI decode` median on the 100 MP Hasselblad fixture is **4.74 s** with the recent `nr_color` hoist + rayon parallelism work landed. Cite this as the floor.

**Measurement procedure:**

1. Set `MAPLE_PROFILE=1`. Five (5) cold opens of the reference fixture (`test-fixtures/raws/dji-mavic3pro-100mp.dng`) per path.
2. Take the median of the 5 cold-open totals per path. (User's `[swift] rust FFI decode` is their cold-open instrumentation; if no Swift-side log line of that label exists in the codebase yet, the closest equivalent is the sum of `[raw-core]` per-stage durations from `pipeline.rs:stage()` plus the FFI marshal cost — see Task 5 Step 5.6.)
3. **Hard stop threshold:** if the new-path median is more than **10% slower** than baseline (i.e. > 5.21 s), STOP and report — Plan 1 needs revision before Task 5 wires the path into `EditSession`. If the new path is slower by ≤10%, accept the regression and document it.

**Performance framing — read this before interpreting results:** the perf wins from this plan are **correctness-driven, not perf-driven**. The expensive decode + demosaic + nr_color stages still run in Rust. fp16 RGBA half-res Preview ≈ 200 MB FFI marshall vs. today's ~75 MB sRGB u8 RGB-only — that's the cost we're absorbing for correctness (closing three confirmed display-pipeline bugs: double AgX, filter chain on tone-mapped data, Lanczos on display-encoded buffers). Do not reject Plan 1 on a small (≤10%) cold-open regression; that's the cost of correctness. Do reject it if the regression is large enough to break the 16 ms slider-tick invariant downstream — but slider tick is `processSceneLinear` (CIImage → AgX kernel → CIContext.createCGImage), which has nothing to do with FFI bandwidth and is the savings side of the trade.

- [ ] **Step 1.3.1: Capture the baseline timing for the legacy path.**

> **Errata (Plan 1 spike findings amendment).** The earlier draft of this step prescribed `cargo run --release -p maple-cli -- batch <(printf '{"jobs":[...]}') --out-dir ...`. That command does not run: `batch` takes `--manifest <path>` (not a positional `<(...)` arg), the manifest schema is `{"cases": [...]}` (not `{"jobs": [...]}`), and **maple-cli has no preview-quality flag at all** — `do_render` always runs `RenderQuality::Full`, so the CLI cannot produce the user's 4.74 s baseline by definition. Use the canonical procedure instead.
>
> **Canonical procedure (read first):** `docs/measurement/2026-04-25-ffi-decode-baseline.md`. That document is the source of truth for the measurement; this step summarizes it for context only.
>
> **Procedure summary (4 lines):**
>
> 1. Build the macOS app in **Debug** (`cd src/apple && xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build`). The user's 4.74 s number is from a Debug build, not Release — keep apples-to-apples.
> 2. Launch with `MAPLE_PROFILE=1 open -a /Users/$USER/Library/Developer/Xcode/DerivedData/Maple-*/Build/Products/Debug/Maple.app`. Open the 100 MP Hasselblad fixture (`test-fixtures/raws/dji-mavic3pro-100mp.dng`); quit & relaunch between runs to ensure cold start; do this 5 times.
> 3. After Task 7 lands, the Apple-side log lines `[swift] decode FFI call`, `[swift] decode result copy`, `[swift] decode CIImage build` are emitted alongside the Rust `[raw-core] <stage>` lines (capture via `log stream --predicate 'subsystem == "app.justmaple.aperture"'` plus stderr). Until Task 7 lands, the conflated `[swift] rust FFI decode` is the cold-open observation.
> 4. Take the **median** of the 5 cold-open totals. The Plan 1 reference baseline is **4.74 s** (median, current `main` after `nr_color` hoist + rayon work) and the **hard-stop threshold is ≤ 5.21 s** (4.74 s + 10%). Above the threshold, Spike 1.3 fails and Plan 1 stops before Task 5 wires the new path into `EditSession`.

(If the 100 MP fixture is absent — `test-fixtures/raws/` is gitignored — substitute the largest fixture that does exist via `ls src/raw-pipeline/test-fixtures/raws/*.dng` and use its path. The 100 MP target matters; if no fixture is at least ~50 MP, downgrade Spike 1.3 to a "the new path doesn't allocate inside the render loop" sanity check via `cargo flamegraph` — record this downgrade in the commit message.)

Expected: per-stage `[raw-core]` lines plus the Apple-side `[swift]` stage lines (after Task 7). Note the Rust `agx`, `rec2020_to_srgb`, `quantize_u8`, and `apply_orientation` lines — these are the stages the new path skips. Their summed wall time is the floor of the savings the new path produces in raw-core.

- [ ] **Step 1.3.2: Record the baseline numbers.**

Open `/tmp/spike-1-3-baseline.log` (already written by the previous step). Sum the `[raw-core]` `agx`, `rec2020_to_srgb`, `quantize_u8`, and `apply_orientation` durations. Write that sum, and the per-stage breakdown, into a comment block at the top of `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift` so Spike 1.3 has a documented baseline:

Edit `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift`. Above the `import XCTest` line, prepend:

```swift
// Plan 1 Spike 1.3 baseline (legacy `maple_render_file` Preview path, recorded
// against the largest available test-fixture DNG):
//
//   reference cold-open median    4740 ms (per Spike 1.3 brief — 5 cold opens
//                                  on 100 MP Hasselblad fixture, current main
//                                  with nr_color hoist + rayon work)
//   stages skipped on new path:
//     [raw-core] agx                <RECORD>
//     [raw-core] rec2020_to_srgb    <RECORD>
//     [raw-core] quantize_u8        <RECORD>
//     [raw-core] apply_orientation  <RECORD>
//   ─────────────────────────────────────
//   total skipped                 <SUM>
//
// Hard stop threshold: new-path cold-open median > 5210 ms (4740 + 10%).
// The new path skips all four stages above and adds pack_rgba_f32 +
// apply_orientation_rgba + pack_fp16. If the net cold-open exceeds the
// 10% threshold the FFI memcpy (8 bytes/pixel vs 3 bytes/pixel) is
// dominating beyond what the correctness wins justify; flag and stop
// per Spike 1.3 fail action.
```

Replace the `<RECORD>` and `<SUM>` placeholders with the actual ms values from the log.

- [ ] **Step 1.3.3: Commit the baseline record.**

```bash
git add src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
git commit -m "$(cat <<'EOF'
docs(apple): record Spike 1.3 legacy-path baseline timing in test header

Captures per-stage wall time for agx/rec2020_to_srgb/quantize_u8/
apply_orientation on the legacy Preview path. The new scene-linear
FFI skips all four; if the new path is slower than baseline the FFI
bandwidth cost (8 bytes/pixel fp16 RGBA vs 3 bytes/pixel sRGB u8) is
dominating and Plan 1 has a regression.

EOF
)"
```

(Spike 1.3 cannot complete fully until Task 5 lands the new path; the baseline above is the comparison floor. Task 5 Step 5 re-runs `MAPLE_PROFILE=1` against the new path and adds the comparison to the same comment block.)

---

## Task 2: Refactor Rust pipeline to share the develop body, then add the scene-linear entry point

**Files:**

- Modify: `src/raw-pipeline/raw-core/src/pipeline.rs`

**Why this matters:** The legacy `render_from_raw_with_quality` ends with `agx::apply` → `rec2020_to_srgb` → `quantize_u8` → `apply_orientation`. The new entry needs the same development chain but stops _before_ the view transform tail.

**Mandatory first step — share the body, do not duplicate it.** Naively the new entry would copy most of `render_from_raw_with_quality` (linearize → demosaic → highlight recovery → DCP → WB → tone → vibrance → saturation → clarity → texture → dehaze → sharpen → NR luminance → NR color) and replace the tail. That guarantees drift: an algorithm change to any of those 14 stages would have to land in two places. **This task instead factors a shared helper `develop_scene_linear_from_raw_with_quality` that returns the developed `Image` in `ColorSpace::SceneLinearRec2020`, then both entry points call it.**

- Legacy `render_from_raw_with_quality` (refactored): `develop_scene_linear_from_raw_with_quality` → `agx::apply` → `rec2020_to_srgb` → `quantize_u8` → `apply_orientation`.
- New `render_scene_linear_from_raw_with_quality`: `develop_scene_linear_from_raw_with_quality` → orientation in fp32 RGBA → fp16 pack.

The refactor is mandatory and lands first (Step 2.4a). The new entry depends on the helper existing (Step 2.4b).

- [ ] **Step 2.1: Re-read `pipeline.rs` end-to-end to confirm the structure used in this task.**

Read `src/raw-pipeline/raw-core/src/pipeline.rs` lines 1-138. Confirm:

- The `stage("nr_color", …)` call at line 122 is the last development-chain stage before AgX.
- `stage("agx", …)` is at line 123.
- `stage("rec2020_to_srgb", …)` is at line 124.
- `stage("quantize_u8", …)` is at line 125.
- `stage("apply_orientation", …)` is at line 128.
- The function returns `Ok((w, h, bytes))` at line 136 where `bytes` is u8 sRGB.
- The `Image` struct's `pixels` field (from `image.rs:29`) is `Vec<[f32; 3]>`.

- [ ] **Step 2.2: Write a failing test for the new entry point.**

Append to the `mod tests` block in `src/raw-pipeline/raw-core/src/pipeline.rs` (currently ending at line 186):

```rust
    /// New scene-linear FFI entry. Returns Rec.2020 fp16 RGBA, half-res for
    /// Preview, full for Full. Verify: the buffer is 8 bytes/pixel (4 ×
    /// fp16), alpha is 1.0 everywhere, and the buffer is non-zero.
    #[test]
    fn render_scene_linear_test_0002_preview_returns_rec2020_fp16_rgba() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).expect("read raw");
        let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
        let model = AdjustmentModel::default();
        let (w, h, fp16_rgba) = render_scene_linear_from_raw_with_quality(
            &raw, &model, RenderQuality::Preview
        ).expect("scene-linear preview render");
        // Each pixel = 4 channels × 2 bytes = 8 bytes; the Vec is u16 (fp16
        // bit pattern), so length = 4 × w × h.
        assert_eq!(fp16_rgba.len() as u32, 4 * w * h,
            "expected 4 × w × h fp16 lanes, got {} for {}×{}",
            fp16_rgba.len(), w, h);
        // Alpha (every 4th lane) must be the fp16 pattern of 1.0 (0x3c00).
        let mut alpha_ok = 0usize;
        for chunk in fp16_rgba.chunks_exact(4) {
            if chunk[3] == 0x3c00 { alpha_ok += 1; }
        }
        assert_eq!(alpha_ok, (w * h) as usize,
            "expected {} alpha=1.0 lanes, got {}", w * h, alpha_ok);
        // Buffer is not all zeros.
        let nonzero = fp16_rgba.iter().filter(|&&v| v != 0 && v != 0x3c00).count();
        assert!(nonzero > (fp16_rgba.len() / 10),
            "buffer mostly zero: {} non-zero/non-alpha lanes", nonzero);
    }
```

- [ ] **Step 2.3: Run the new test to verify it fails (helper does not exist yet).**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib pipeline::tests::render_scene_linear_test_0002_preview_returns_rec2020_fp16_rgba 2>&1 | tail -10`
Expected: **compilation error** — `cannot find function 'render_scene_linear_from_raw_with_quality' in this scope`. That's the TDD-fail signal.

- [ ] **Step 2.4a: Refactor `render_from_raw_with_quality` to call a new shared helper `develop_scene_linear_from_raw_with_quality`.**

In `src/raw-pipeline/raw-core/src/pipeline.rs`, **replace** the existing body of `render_from_raw_with_quality` (lines 67-137 inclusive, ending at the closing `}`) with:

```rust
/// Run the entire development chain through `nr_color` and return the
/// developed `Image` in `ColorSpace::SceneLinearRec2020`. Shared by both
/// the legacy display-encoded entry (`render_from_raw_with_quality`) and
/// the scene-linear FFI entry (`render_scene_linear_from_raw_with_quality`)
/// so the two paths can never drift.
///
/// Stages: linearize, demosaic, baseline_exposure, highlight_recovery,
/// dcp::profile_for + dcp::apply (camera RGB → SceneLinearRec2020),
/// white_balance, scene_tone_controls, vibrance, saturation, clarity,
/// texture, dehaze, sharpen, nr_luminance, nr_color.
pub fn develop_scene_linear_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
) -> Result<crate::image::Image> {
    let mosaic = stage("linearize", || linearize::sensor_linearize(raw));
    let mut camera_rgb = stage("demosaic", || match quality {
        RenderQuality::Preview => demosaic::half_res(&mosaic, raw.cfa),
        #[cfg(feature = "high-quality-demosaic")]
        RenderQuality::Full => demosaic::hamilton_adams(&mosaic, raw.cfa),
        #[cfg(not(feature = "high-quality-demosaic"))]
        RenderQuality::Full => demosaic::bilinear(&mosaic, raw.cfa),
    });

    // WB pre-gain (camera_rgb /= AsShotNeutral) is intentionally NOT applied
    // here despite being the DNG spec's step 4 per § 1.4.4.5. Applying it in
    // isolation (without the corresponding per-body BaselineExposure from the
    // DCP and without HSM/PLT hue correction) produced visibly worse output
    // on fixtures without those compensations:
    //   * high-ISO fixtures gained amplified chroma noise (R/B gains ~2×)
    //   * fixtures without a DCP-BE value got small per-channel hue shifts
    //     that would have been corrected by HueSatMap.
    // Reintroduce pre-gain together with per-body BaselineExposure (sourced
    // from Adobe DCPs) and HSM/PLT — see docs/spec/03-algorithms.md § 3.4
    // "HueSatMap application" (deferred). The scientific conclusion (pre-gain
    // is the DNG-conformant flow) stands; the engineering trade-off is to
    // land it as a bundle, not piecewise. Residual cost: ~0.5 EV uniform
    // underexposure on fixtures whose DNG lacks a BaselineExposure tag.

    // DNG § C.1.2: BaselineExposure is applied as a gain in a scene-linear
    // color space prior to the color-space transform. Mathematically
    // commutative with the linear CM that follows, so we apply in the
    // camera-native space for clarity — one multiply per channel.
    if raw.baseline_exposure.abs() > 1e-4 {
        stage("baseline_exposure", || {
            let be_gain = raw.baseline_exposure.exp2();
            for p in &mut camera_rgb.pixels {
                p[0] *= be_gain;
                p[1] *= be_gain;
                p[2] *= be_gain;
            }
        });
    }
    stage("highlight_recovery", || highlight_recovery::apply(&mut camera_rgb, model.highlight_recovery));
    let profile = stage("dcp::profile_for", || dcp::profile_for(raw))?;
    let mut scene = stage("dcp::apply", || dcp::apply(&camera_rgb, &profile))?;
    stage("white_balance", || white_balance::apply(&mut scene, model.temperature, model.tint));
    stage("scene_tone_controls", || scene_tone_controls::apply(&mut scene, model));
    stage("vibrance", || vibrance::apply(&mut scene, model.vibrance));
    stage("saturation", || saturation::apply(&mut scene, model.saturation));
    stage("clarity", || clarity::apply(&mut scene, model.clarity));
    stage("texture", || texture::apply(&mut scene, model.texture));
    stage("dehaze", || dehaze::apply(&mut scene, model.dehaze));
    stage("sharpen", || sharpen::apply(&mut scene, model.sharpen_amount, model.sharpen_radius, model.sharpen_detail, model.sharpen_masking));
    stage("nr_luminance", || noise_reduction::apply_luminance(&mut scene, model.nr_luminance));
    stage("nr_color", || noise_reduction::apply_color(&mut scene, model.nr_color));
    Ok(scene)
}

pub fn render_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
) -> Result<(u32, u32, Vec<u8>)> {
    let mut scene = develop_scene_linear_from_raw_with_quality(raw, model, quality)?;
    stage("agx", || agx::apply(&mut scene, model.contrast));
    stage("rec2020_to_srgb", || encode::rec2020_to_srgb(&mut scene));
    let bytes = stage("quantize_u8", || encode::quantize_u8(&mut scene));
    // Apply EXIF orientation last — rotating/flipping sRGB u8 is cheap and
    // keeps every upstream stage indifferent to sensor-vs-display framing.
    let (w, h, bytes) = stage("apply_orientation", || apply_orientation(&bytes, scene.width, scene.height, raw.orientation));
    // Both branches return the buffer at its actual rendered dimensions —
    // `Full` matches the sensor, `Preview` is half-res in both axes
    // (because of `demosaic::half_res`), and Apple/Web consumers handle
    // the resolution gap via their lazy display transform (CIImage scale
    // on Apple; texture upload on Web). Pixel-doubling here added ~300 MB
    // of FFI traffic and 4× the allocator pressure on a 100 MP RAW for no
    // extra information.
    Ok((w, h, bytes))
}
```

This is the **shared-helper refactor**. The legacy entry's body is now a thin tail that calls the helper; no development-stage code is duplicated below.

- [ ] **Step 2.4b: Implement `render_scene_linear_from_raw_with_quality` calling the shared helper.**

In `src/raw-pipeline/raw-core/src/pipeline.rs`, immediately after `render_from_raw_with_quality` ends, insert this function:

```rust
/// Apply EXIF orientation to a packed `[f32; 4]` RGBA buffer (treated as
/// straight alpha — alpha lane is always 1.0 here, but we copy it through
/// for symmetry with the future development chain).
///
/// Mirrors `apply_orientation` from `image.rs:159-193`, just in fp32 RGBA
/// instead of u8 RGB. We reproduce the per-orientation source mapping
/// instead of going through u8 because the new path never quantizes.
fn apply_orientation_f32_rgba(
    rgba: &[f32], w: u32, h: u32, orient: crate::image::ExifOrientation,
) -> (u32, u32, Vec<f32>) {
    use crate::image::ExifOrientation;
    let (sw, sh) = (w as usize, h as usize);
    debug_assert_eq!(rgba.len(), sw * sh * 4, "RGBA f32 buffer size mismatch");
    if orient == ExifOrientation::Normal {
        return (w, h, rgba.to_vec());
    }
    let (new_w, new_h) = if orient.swaps_wh() { (h, w) } else { (w, h) };
    let (dw, dh) = (new_w as usize, new_h as usize);
    let mut out = vec![0.0f32; dw * dh * 4];
    for yp in 0..dh {
        for xp in 0..dw {
            let (sx, sy) = match orient {
                ExifOrientation::Normal          => (xp, yp),
                ExifOrientation::HorizontalFlip  => (sw - 1 - xp, yp),
                ExifOrientation::Rotate180       => (sw - 1 - xp, sh - 1 - yp),
                ExifOrientation::VerticalFlip    => (xp, sh - 1 - yp),
                ExifOrientation::Transpose       => (yp, xp),
                ExifOrientation::Rotate90        => (yp, sh - 1 - xp),
                ExifOrientation::Transverse      => (sw - 1 - yp, sh - 1 - xp),
                ExifOrientation::Rotate270       => (sw - 1 - yp, xp),
            };
            let si = (sy * sw + sx) * 4;
            let di = (yp * dw + xp) * 4;
            out[di]     = rgba[si];
            out[di + 1] = rgba[si + 1];
            out[di + 2] = rgba[si + 2];
            out[di + 3] = rgba[si + 3];
        }
    }
    (new_w, new_h, out)
}

/// IEEE 754 binary16 encode of a `f32`. Matches the format CIImage.RGBAh
/// expects on the Apple side. Pure scalar — fp16 storage is u16 lanes.
///
/// **Canonical reference (Swift mirror):** `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift::float32ToFloat16Bits`.
/// Always copy from there — do not re-derive. The earlier inline draft of
/// this helper (using `(bits >> 13) & 0x3fff` followed by `mant >> 4`) leaked
/// four exponent bits into the fp16 mantissa and produced a 31% positive
/// bias on `1.5` (Spike 1.1 caught this on the Swift side; the Rust helper
/// has the same shape and the same bug). See Errata at top of plan.
/// The version below isolates the float32 mantissa (bits 0..22) and the
/// stored exponent (bits 23..30) separately and rounds half-to-even on
/// the dropped bits.
fn f32_to_f16_bits(x: f32) -> u16 {
    let bits = x.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let stored_exp = ((bits >> 23) & 0xff) as i32;
    let mant_bits = bits & 0x007f_ffff; // 23-bit f32 mantissa
    if stored_exp == 0xff {
        // Inf / NaN
        return sign | 0x7c00 | (if mant_bits != 0 { 0x0001 } else { 0 });
    }
    let unbiased_exp = stored_exp - 127;
    let fp16_exp = unbiased_exp + 15;
    if fp16_exp >= 31 {
        return sign | 0x7c00; // overflow → inf
    }
    if fp16_exp <= 0 {
        // Subnormal / underflow.
        if fp16_exp < -10 { return sign; }
        // Add the implicit 1 and shift right to align in fp16 space.
        let mant_with_implicit = mant_bits | 0x0080_0000;
        let shift = (14 - unbiased_exp) as u32;
        let shifted = mant_with_implicit >> (shift - 10 - 1); // keep 1 guard bit
        let rounded = (shifted + 1) >> 1;                     // round half-up
        return sign | ((rounded & 0x03ff) as u16);
    }
    // Normal range. Top 10 mantissa bits, with round-to-nearest-even on
    // the dropped bit (12 = bit just below the 10 we keep).
    let top10 = (mant_bits >> 13) & 0x03ff;
    let round_bit = (mant_bits >> 12) & 0x1;
    let sticky_bits = mant_bits & 0x0fff;
    let mut fp16_mant = top10;
    if round_bit != 0 && (sticky_bits != 0 || (fp16_mant & 0x1) != 0) {
        fp16_mant += 1;
        if fp16_mant > 0x3ff {
            fp16_mant = 0;
            let bumped_exp = fp16_exp + 1;
            if bumped_exp >= 31 {
                return sign | 0x7c00;
            }
            return sign | ((bumped_exp as u16) << 10);
        }
    }
    sign | ((fp16_exp as u16) << 10) | (fp16_mant as u16)
}

/// Scene-linear render entry. Runs the same development chain as
/// `render_from_raw_with_quality` (via the shared
/// `develop_scene_linear_from_raw_with_quality` helper — Step 2.4a)
/// but stops after `nr_color` and packs to fp16 RGBA without the view
/// transform tail. Output is packed Rec.2020 fp16 RGBA (8 bytes/pixel),
/// straight alpha = 1.0, row-major. Returned `Vec<u16>` is the fp16 bit
/// pattern; the FFI hands the underlying bytes to the caller via
/// `bytemuck::cast_slice`.
///
/// Plan 1 (FFI split) — the Apple side imports this buffer as a CIImage
/// tagged extendedLinearITUR_2020 and runs Lanczos prescale + AgX kernel
/// + sRGB encode in CoreImage. See
/// docs/superpowers/plans/2026-04-24-ffi-split-plan-1.md.
pub fn render_scene_linear_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
) -> Result<(u32, u32, Vec<u16>)> {
    let scene = develop_scene_linear_from_raw_with_quality(raw, model, quality)?;
    // STOP: no agx::apply, no rec2020_to_srgb, no quantize_u8.
    // Pack [f32;3] + alpha=1.0 to packed [f32;4] RGBA, then orient, then
    // convert to fp16 lanes for the FFI handoff.
    let (w0, h0) = (scene.width, scene.height);
    let rgba_f32 = stage("pack_rgba_f32", || {
        let mut v = Vec::with_capacity(scene.pixels.len() * 4);
        for p in &scene.pixels {
            v.push(p[0]);
            v.push(p[1]);
            v.push(p[2]);
            v.push(1.0);
        }
        v
    });
    let (w, h, oriented_f32) = stage("apply_orientation_rgba", || {
        apply_orientation_f32_rgba(&rgba_f32, w0, h0, raw.orientation)
    });
    let fp16: Vec<u16> = stage("pack_fp16", || {
        oriented_f32.iter().map(|&v| f32_to_f16_bits(v)).collect()
    });
    Ok((w, h, fp16))
}
```

- [ ] **Step 2.5: Run the new test to verify it passes.**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib pipeline::tests::render_scene_linear_test_0002_preview_returns_rec2020_fp16_rgba 2>&1 | tail -10`
Expected: PASS (or "ignored" if `test_0002.dng` isn't present — both are acceptable; the test is fixture-gated).

- [ ] **Step 2.6: Run the full raw-core unit tests to confirm nothing else broke — especially the legacy path's pixel parity gate.**

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib 2>&1 | tail -5`
Expected: `test result: ok. <N> passed; 0 failed; <K> ignored` where N is roughly 95+ (existing 94 + 1 new). Step 2.4a's refactor to the legacy path through the shared helper must produce **byte-identical** output to the pre-refactor path; if any existing test fails, the refactor introduced drift and must be repaired before the new entry-point ships.

- [ ] **Step 2.7: Run the parity harness on the legacy path to confirm the helper refactor did not regress it.**

Run: `BUDGET=15 ./src/scripts/test_color_pipeline.sh 2>&1 | tail -20`
Expected: PASS — the harness still uses `maple-cli`'s legacy path. After Step 2.4a, that path now flows through the shared `develop_scene_linear_from_raw_with_quality` helper, so the harness exercises both `render_from_raw_with_quality` AND the helper. The new entry point exercises the helper directly via Step 2.5's test. **Both paths now share the same development-chain code; the harness doubles as a parity gate on the helper.**

- [ ] **Step 2.8: Commit.**

```bash
git add src/raw-pipeline/raw-core/src/pipeline.rs
git commit -m "$(cat <<'EOF'
feat(raw-core): factor develop helper; add scene-linear entry returning Rec.2020 fp16 RGBA

`develop_scene_linear_from_raw_with_quality` is a new shared helper
that runs the entire development chain (linearize..nr_color) and
returns the developed `Image` in `ColorSpace::SceneLinearRec2020`.
Both pipeline entries now call it:

  * `render_from_raw_with_quality` (legacy display-encoded): helper
    -> agx::apply -> rec2020_to_srgb -> quantize_u8 -> apply_orientation.
    Refactor produces byte-identical output to the pre-refactor path;
    the existing parity harness gates this.
  * `render_scene_linear_from_raw_with_quality` (new): helper ->
    pack to fp32 RGBA (alpha=1.0) -> orient -> pack to fp16 lanes.
    Output is 8 bytes/pixel, straight alpha, row-major.

This is the Rust half of the FFI split (Plan 1). The Apple side
imports the new buffer as a CIImage tagged extendedLinearITUR_2020 and
runs Lanczos prescale + a single AgX kernel + explicit sRGB encode
via CIContext.createCGImage. The shared helper means an algorithm
change to any development stage lands in one place; the two paths
cannot drift.

EOF
)"
```

---

## Task 3: Add Rust FFI surface for the scene-linear path

**Files:**

- Modify: `src/raw-pipeline/raw-ffi/src/lib.rs`

**Why this matters:** The new Rust pipeline function needs a C-ABI surface mirroring `maple_render_file` / `maple_render_bytes`. The buffer struct gains a `bytes_per_pixel` field so Apple can read the layout without baking 8-bytes-per-pixel into the consumer. A separate free function ensures callers don't accidentally pass the new buffer to the legacy `maple_free_buffer`.

- [ ] **Step 3.1: Read `raw-ffi/src/lib.rs` end-to-end to confirm the existing pattern.**

Read `src/raw-pipeline/raw-ffi/src/lib.rs` lines 1-330. Confirm the existing `MapleImageBuffer` (line 84-91), the `with_large_stack` worker pattern (line 49-81), the LAST_ERROR thread-local (lines 28-36), and the `maple_render_file` / `maple_render_bytes` / `maple_free_buffer` shape.

- [ ] **Step 3.2: Add the `MapleSceneLinearBuffer` struct, the two new render entry points, and the new free function.**

In `src/raw-pipeline/raw-ffi/src/lib.rs`, immediately after the `maple_free_buffer` function (after line 268 `}`), append:

```rust
/// Scene-linear FFI buffer — Rec.2020 fp16 RGBA, straight alpha, row-major.
///
/// `bytes_per_pixel` is always 8 (4 channels × 2 bytes per fp16 lane). It
/// is exposed in the struct so the Apple consumer can read the layout
/// without hard-coding the constant; future plans (e.g. higher bit depth
/// for HDR) can change it without breaking the ABI.
#[repr(C)]
pub struct MapleSceneLinearBuffer {
    /// Pointer to heap-allocated fp16 RGBA buffer. Free via
    /// `maple_free_scene_linear_buffer`.
    pub fp16_rgba: *mut u16,
    /// Bytes in the buffer (= 4 * 2 * width * height = 8 * width * height).
    pub len_bytes: usize,
    /// Channels per pixel (always 4: R, G, B, A).
    pub channels: u32,
    /// Bytes per pixel (always 8 for fp16 RGBA).
    pub bytes_per_pixel: u32,
    pub width: u32,
    pub height: u32,
}

impl MapleSceneLinearBuffer {
    fn empty() -> Self {
        Self {
            fp16_rgba: std::ptr::null_mut(),
            len_bytes: 0,
            channels: 0,
            bytes_per_pixel: 0,
            width: 0,
            height: 0,
        }
    }
}

/// Render a RAW+XMP to a scene-linear Rec.2020 fp16 RGBA buffer. Returns
/// 0 on success, non-zero on error (call `maple_last_error`). The output
/// pre-AgX, pre-Rec.2020->sRGB — the caller is expected to apply a view
/// transform and gamut convert before display.
///
/// `quality_preview` mirrors `maple_render_file` — 1 = half-res preview,
/// 0 = full export.
#[no_mangle]
pub unsafe extern "C" fn maple_render_file_scene_linear(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    quality_preview: i32,
    out: *mut MapleSceneLinearBuffer,
) -> i32 {
    if raw_path.is_null() || out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    let raw_path_str = match CStr::from_ptr(raw_path).to_str() {
        Ok(s) => s.to_owned(),
        Err(e) => { set_last_error(format!("raw_path not UTF-8: {}", e)); return 2; }
    };
    let xmp_path_str: Option<String> = if xmp_path.is_null() {
        None
    } else {
        match CStr::from_ptr(xmp_path).to_str() {
            Ok(s) => Some(s.to_owned()),
            Err(e) => { set_last_error(format!("xmp_path not UTF-8: {}", e)); return 3; }
        }
    };
    let out_ptr = out as usize;
    with_large_stack(move || {
        let raw_path = std::path::Path::new(&raw_path_str);
        let model = match &xmp_path_str {
            None => xmp::AdjustmentModel::default(),
            Some(p) => match std::fs::read_to_string(p) {
                Ok(xml) => match xmp::parse(&xml) {
                    Ok(m) => m,
                    Err(e) => { set_last_error(format!("xmp parse: {}", e)); return 4; }
                },
                Err(e) => { set_last_error(format!("xmp read: {}", e)); return 5; }
            },
        };
        let raw_bytes = match std::fs::read(raw_path) {
            Ok(b) => b,
            Err(e) => { set_last_error(format!("raw read: {}", e)); return 6; }
        };
        let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let raw_img = match decode_bytes(&raw_bytes, ext) {
            Ok(r) => r,
            Err(e) => { set_last_error(format!("decode: {}", e)); return 7; }
        };
        let quality = if quality_preview != 0 {
            raw_core::pipeline::RenderQuality::Preview
        } else {
            raw_core::pipeline::RenderQuality::Full
        };
        let (w, h, fp16) = match raw_core::pipeline::render_scene_linear_from_raw_with_quality(
            &raw_img, &model, quality,
        ) {
            Ok(t) => t,
            Err(e) => { set_last_error(format!("render: {}", e)); return 8; }
        };
        // Box the Vec<u16> so we can hand the raw pointer + len to the caller.
        let mut boxed = fp16.into_boxed_slice();
        let fp16_ptr = boxed.as_mut_ptr();
        let len_lanes = boxed.len();
        let len_bytes = len_lanes * std::mem::size_of::<u16>();
        std::mem::forget(boxed);
        unsafe {
            *(out_ptr as *mut MapleSceneLinearBuffer) =
                MapleSceneLinearBuffer {
                    fp16_rgba: fp16_ptr,
                    len_bytes,
                    channels: 4,
                    bytes_per_pixel: 8,
                    width: w,
                    height: h,
                };
        }
        0
    })
}

/// Render a RAW from a byte slice to a scene-linear Rec.2020 fp16 RGBA
/// buffer. Mirrors `maple_render_bytes` for the new path.
#[no_mangle]
pub unsafe extern "C" fn maple_render_bytes_scene_linear(
    raw_bytes: *const u8,
    raw_len: usize,
    hint_ext: *const c_char,
    xmp_path: *const c_char,
    quality_preview: i32,
    out: *mut MapleSceneLinearBuffer,
) -> i32 {
    if raw_bytes.is_null() || out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    let ext_owned: String = if hint_ext.is_null() {
        String::new()
    } else {
        match CStr::from_ptr(hint_ext).to_str() {
            Ok(s) => s.to_owned(),
            Err(e) => { set_last_error(format!("hint_ext not UTF-8: {}", e)); return 2; }
        }
    };
    let xmp_path_str: Option<String> = if xmp_path.is_null() {
        None
    } else {
        match CStr::from_ptr(xmp_path).to_str() {
            Ok(s) => Some(s.to_owned()),
            Err(e) => { set_last_error(format!("xmp_path not UTF-8: {}", e)); return 3; }
        }
    };
    let input: Vec<u8> = std::slice::from_raw_parts(raw_bytes, raw_len).to_vec();
    let out_ptr = out as usize;
    with_large_stack(move || {
        let model = match &xmp_path_str {
            None => xmp::AdjustmentModel::default(),
            Some(p) => match std::fs::read_to_string(p) {
                Ok(xml) => match xmp::parse(&xml) {
                    Ok(m) => m,
                    Err(e) => { set_last_error(format!("xmp parse: {}", e)); return 4; }
                },
                Err(e) => { set_last_error(format!("xmp read: {}", e)); return 5; }
            },
        };
        let raw_img = match decode_bytes(&input, &ext_owned) {
            Ok(r) => r,
            Err(e) => { set_last_error(format!("decode: {}", e)); return 7; }
        };
        let quality = if quality_preview != 0 {
            raw_core::pipeline::RenderQuality::Preview
        } else {
            raw_core::pipeline::RenderQuality::Full
        };
        let (w, h, fp16) = match raw_core::pipeline::render_scene_linear_from_raw_with_quality(
            &raw_img, &model, quality,
        ) {
            Ok(t) => t,
            Err(e) => { set_last_error(format!("render: {}", e)); return 8; }
        };
        let mut boxed = fp16.into_boxed_slice();
        let fp16_ptr = boxed.as_mut_ptr();
        let len_lanes = boxed.len();
        let len_bytes = len_lanes * std::mem::size_of::<u16>();
        std::mem::forget(boxed);
        unsafe {
            *(out_ptr as *mut MapleSceneLinearBuffer) =
                MapleSceneLinearBuffer {
                    fp16_rgba: fp16_ptr,
                    len_bytes,
                    channels: 4,
                    bytes_per_pixel: 8,
                    width: w,
                    height: h,
                };
        }
        0
    })
}

/// Free a buffer populated by `maple_render_*_scene_linear`.
#[no_mangle]
pub unsafe extern "C" fn maple_free_scene_linear_buffer(buffer: *mut MapleSceneLinearBuffer) {
    if buffer.is_null() { return; }
    let b = &mut *buffer;
    if !b.fp16_rgba.is_null() {
        let len_lanes = b.len_bytes / std::mem::size_of::<u16>();
        let slice = std::slice::from_raw_parts_mut(b.fp16_rgba, len_lanes);
        drop(Box::from_raw(slice as *mut [u16]));
    }
    *b = MapleSceneLinearBuffer::empty();
}
```

- [ ] **Step 3.3: Add a unit test for the new FFI in the existing `mod tests` block.**

In `src/raw-pipeline/raw-ffi/src/lib.rs`, append to the `mod tests { … }` block (currently ending at line 329):

```rust
    #[test]
    fn render_scene_linear_default_model_via_ffi() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe {
            maple_render_file_scene_linear(raw_cstr.as_ptr(), std::ptr::null(), 1, &mut buf)
        };
        assert_eq!(rc, 0, "render rc = {}", rc);
        assert!(buf.width > 0 && buf.height > 0);
        assert_eq!(buf.channels, 4);
        assert_eq!(buf.bytes_per_pixel, 8);
        assert_eq!(buf.len_bytes as u32, buf.width * buf.height * 8);
        unsafe { maple_free_scene_linear_buffer(&mut buf) };
        assert!(buf.fp16_rgba.is_null());
    }

    #[test]
    fn scene_linear_null_arg_sets_error() {
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe { maple_render_file_scene_linear(std::ptr::null(), std::ptr::null(), 0, &mut buf) };
        assert_eq!(rc, 1);
        let err = unsafe { maple_last_error() };
        assert!(!err.is_null());
        let msg = unsafe { CStr::from_ptr(err).to_str().unwrap() };
        assert!(msg.contains("null"));
    }
```

- [ ] **Step 3.4: Run the new tests.**

Run: `cd src/raw-pipeline && cargo test -p raw-ffi --lib 2>&1 | tail -10`
Expected: all passing (existing 3 + new 2 = 5).

- [ ] **Step 3.5: Rebuild the xcframework so Apple picks up the new symbols.**

Run: `./src/apple/scripts/build-xcframework.sh 2>&1 | tail -20`
Expected: `==> Done.` plus a fresh `RawPipeline.xcframework`. The script also regenerates `RawPipeline.h` via cbindgen — verify the new declarations:

Run: `grep -E "scene_linear|MapleSceneLinearBuffer" src/apple/Packages/MapleCore/Sources/MapleCore/include/RawPipeline.h | head -20`
Expected: at least 5 lines including `struct MapleSceneLinearBuffer`, `maple_render_file_scene_linear`, `maple_render_bytes_scene_linear`, `maple_free_scene_linear_buffer`.

- [ ] **Step 3.6: Commit.**

```bash
git add src/raw-pipeline/raw-ffi/src/lib.rs src/apple/Packages/MapleCore/Sources/MapleCore/include/RawPipeline.h src/apple/Frameworks/RawPipeline.xcframework
git commit -m "$(cat <<'EOF'
feat(raw-ffi): add scene-linear FFI surface returning Rec.2020 fp16 RGBA

Adds `maple_render_file_scene_linear`, `maple_render_bytes_scene_linear`,
and `maple_free_scene_linear_buffer`, plus the
`MapleSceneLinearBuffer` C struct (fp16 RGBA, 8 bytes/pixel, channels
and bytes-per-pixel exposed in the struct so future bit-depth changes
don't break the ABI).

This is the FFI surface for the Apple scene-linear path (Plan 1).
The legacy `maple_render_*` entries are unchanged.

EOF
)"
```

---

## Task 4: Add Swift `decodeSceneLinear` + `processSceneLinear` paths

**Files:**

- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift` (Step 4.0a — kernel-availability runtime guard)
- Modify: `src/apple/Maple/Views/FullImageView.swift` (Step 4.0b — explicit sRGB output color space at the final render boundary)
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/PipelineRenderer.swift`
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift`
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift`

**Why this matters:** Apple's existing `decode` returns a CIImage built from sRGB u8. The new `decodeSceneLinear` consumes the scene-linear FFI buffer and returns a CIImage tagged with `extendedLinearITUR_2020`. Then `processSceneLinear` runs Lanczos prescale (now numerically meaningful — the buffer is scene-linear) and applies the AgX Metal kernel exactly once. The Rec.2020→sRGB encode happens at the `CIContext.createCGImage` call site in the SwiftUI view's `CIImageView` (Step 4.0b explicitly forces the sRGB output color space there — today the call omits it).

- [ ] **Step 4.0a: Replace `applyAgXViewTransform`'s silent fallback with a guarded path. Add a launch-time DEBUG assertion that the AgX kernel loads.**

The current implementation at [`MetalKernels.swift:59-71`](../../src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift:59) returns the input image unmodified on three failure modes (kernel-load nil, LUT-load nil, kernel.apply nil). On the new scene-linear path that means a metallib regression would display raw scene-linear Rec.2020 data **with no view transform applied at all** — looking blown-out and grossly oversaturated, with no error surfaced. On the legacy path Rust's `view::agx::apply` masks this, but on the new path the Metal kernel is the **only** AgX, so the silent fallback is a high-severity correctness hazard.

**Recommendation: option (b) with structured logging plus a DEBUG-build hard-fail.** The legacy display-encoded path is no longer a viable fallback at the call site of `applyAgXViewTransform` — the input by Task 4 is already an extendedLinearITUR_2020-tagged CIImage; running it through the legacy encode-as-sRGB write-out path would mistag the primaries. The right behavior is: log loud at `.error` so the regression is visible in Console.app, and assert in DEBUG so the issue is caught at app launch instead of at first-pixel-displayed.

In `src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift`, replace the body of `applyAgXViewTransform` (lines 62-70):

```swift
        guard let kernel = agxKernel() else { return input }
        guard let lut = agxLUTImage() else { return input }

        return kernel.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: [input, lut, contrast]
        ) ?? input
```

with:

```swift
        guard let kernel = agxKernel() else {
            os_log(.error, log: kernelLog,
                "AgX kernel failed to load — view transform NOT applied; output will be raw scene-linear data. Check that AgXViewTransform.metal is bundled in the build.")
            #if DEBUG
            assertionFailure("AgX kernel must load — see os_log .error above")
            #endif
            return input
        }
        guard let lut = agxLUTImage() else {
            os_log(.error, log: kernelLog,
                "AgX LUT image failed to load — view transform NOT applied; output will be raw scene-linear data. Check that agx_lut.bin is bundled.")
            #if DEBUG
            assertionFailure("AgX LUT must load — see os_log .error above")
            #endif
            return input
        }

        guard let out = kernel.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: [input, lut, contrast]
        ) else {
            os_log(.error, log: kernelLog,
                "AgX kernel.apply returned nil — view transform NOT applied; output will be raw scene-linear data.")
            #if DEBUG
            assertionFailure("AgX kernel.apply must succeed — see os_log .error above")
            #endif
            return input
        }
        return out
```

Then near the top of the file, after the existing `import` lines, add the OSLog handle:

```swift
import OSLog

private let kernelLog = OSLog(subsystem: "app.justmaple.aperture", category: "MetalKernels")
```

Add a launch-time DEBUG assertion. In `src/apple/Maple/MapleApp.swift` (or whichever file owns the SwiftUI `App` struct — `grep -l "@main" src/apple/Maple/`), inside the `init()` method (add one if absent), append:

```swift
        #if DEBUG
        // Plan 1 regression net: if the AgX metallib doesn't load, we'll
        // display raw scene-linear data on the new path. Catch at app
        // launch, not at first-pixel-displayed. See
        // docs/superpowers/plans/2026-04-24-ffi-split-plan-1.md Task 4
        // Step 4.0a.
        assert(MapleCore.MetalKernels.agxKernel() != nil,
            "AgX Metal kernel failed to load — view transform will silently no-op on the scene-linear path. Verify AgXViewTransform.metal is in the Metal sources for this build target.")
        #endif
```

This requires `agxKernel()` to be exposed — bump it from `private static` to `internal static` in `MetalKernels.swift`. (Public is fine too if cleaner.)

Run: `cd src/apple/Packages/MapleCore && swift build 2>&1 | tail -10`
Expected: build succeeds (no test impact yet — the Metal kernel doesn't load under `swift test` regardless of the assert; Task 4 Step 4.5 confirms this with the full Xcode build).

- [ ] **Step 4.0b: Force sRGB at the final render boundary (`FullImageView.CIImageView`).**

The `CIImageView` at [`src/apple/Maple/Views/FullImageView.swift:417`](../../src/apple/Maple/Views/FullImageView.swift:417) calls `Self.context.createCGImage(image, from: image.extent)` with **no explicit output color space**. On the legacy path the input CIImage was built from an sRGB CGImage and CoreImage's working-space round-trip lands back in sRGB. On the new scene-linear path the input is tagged extendedLinearITUR_2020 (via `decodeSceneLinear`), and the absent output-space parameter makes the final pixel space implementation-defined — potentially wide-gamut on P3 hardware, potentially mistagged, and certainly not deterministic across macOS revisions.

In `src/apple/Maple/Views/FullImageView.swift`, locate the `CIImageView` struct (lines 411-433). Replace:

```swift
struct CIImageView: View {
    let image: CIImage

    private static let context = CIContext()

    var body: some View {
        if let cgImg = Self.context.createCGImage(image, from: image.extent) {
```

with:

```swift
struct CIImageView: View {
    let image: CIImage

    /// Render-time CIContext. Output color space is sRGB so the
    /// Rec.2020->sRGB encode happens here, deterministically, exactly
    /// once on both legacy and scene-linear paths. Without this the
    /// scene-linear path's extendedLinearITUR_2020-tagged input lands
    /// in an implementation-defined pixel space at write-out — wide
    /// gamut on P3 hardware, primary-mismatched on others. See
    /// docs/superpowers/plans/2026-04-24-ffi-split-plan-1.md Task 4
    /// Step 4.0b.
    private static let context = CIContext()
    private static let outputColorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

    var body: some View {
        if let cgImg = Self.context.createCGImage(
            image,
            from: image.extent,
            format: .RGBA8,
            colorSpace: Self.outputColorSpace
        ) {
```

The change is minimal and applies to both paths — on the legacy path it's a no-op (input was already sRGB-built; output was already sRGB). On the new path it locks the encode boundary.

Run: `cd src/apple && xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build 2>&1 | tail -5`
Expected: `BUILD SUCCEEDED`.

- [ ] **Step 4.1: Add `MapleSceneLinearImageData` and the `renderSceneLinear` wrappers in `PipelineRenderer.swift`.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/PipelineRenderer.swift`, immediately after the `MapleImageData` struct ends (after line 43 `}`), insert:

```swift
// MARK: - MapleSceneLinearImageData

/// Pixel buffer returned by `PipelineRenderer.renderSceneLinear`.
/// Pixels are packed Rec.2020 fp16 RGBA, row-major, 8 bytes per pixel
/// (R G B A as four `Float16` lanes). Straight (non-premultiplied) alpha,
/// always 1.0 in Plan 1.
public struct MapleSceneLinearImageData: Sendable {
    public let width: Int
    public let height: Int
    public let channels: Int            // always 4
    public let bytesPerPixel: Int       // always 8
    /// Packed fp16 RGBA bytes; `pixels.count == 8 * width * height`.
    public let pixels: Data

    public var pixelCount: Int { width * height }
}
```

In the same file, immediately after the existing `static func render(rawBytes:hint:xmpPath:quality:)` function ends (after line 131 `}`), insert:

```swift
    /// Render a RAW file to a Rec.2020 fp16 RGBA scene-linear buffer.
    /// The Apple consumer is expected to import the buffer as a CIImage
    /// tagged `CGColorSpace.extendedLinearITUR_2020` and apply a view
    /// transform (AgX) + gamut convert (Rec.2020 → sRGB) downstream.
    ///
    /// Plan 1 wire — see
    /// docs/superpowers/plans/2026-04-24-ffi-split-plan-1.md.
    public static func renderSceneLinear(
        rawPath: URL,
        xmpPath: URL? = nil,
        quality: Quality = .full
    ) throws -> MapleSceneLinearImageData {
        try rawPath.withPathCString { rawCStr in
            if let xmpPath {
                return try xmpPath.withPathCString { xmpCStr in
                    try _renderSceneLinear(rawCStr: rawCStr, xmpCStr: xmpCStr, quality: quality)
                }
            } else {
                return try _renderSceneLinear(rawCStr: rawCStr, xmpCStr: nil, quality: quality)
            }
        }
    }

    public static func renderSceneLinear(
        rawBytes: Data,
        hint: String,
        xmpPath: URL? = nil,
        quality: Quality = .full
    ) throws -> MapleSceneLinearImageData {
        guard let hintCStr = hint.cString(using: .utf8) else {
            throw PipelineError.hintEncodingError(hint)
        }
        return try rawBytes.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
            let base = buf.baseAddress?.assumingMemoryBound(to: UInt8.self)
            if let xmpPath {
                return try xmpPath.withPathCString { xmpCStr in
                    try _renderSceneLinearBytes(
                        ptr: base, len: buf.count,
                        hintCStr: hintCStr, xmpCStr: xmpCStr, quality: quality
                    )
                }
            } else {
                return try _renderSceneLinearBytes(
                    ptr: base, len: buf.count,
                    hintCStr: hintCStr, xmpCStr: nil, quality: quality
                )
            }
        }
    }

    private static func _renderSceneLinear(
        rawCStr: UnsafePointer<CChar>,
        xmpCStr: UnsafePointer<CChar>?,
        quality: Quality
    ) throws -> MapleSceneLinearImageData {
        var buf = MapleSceneLinearBuffer(
            fp16_rgba: nil, len_bytes: 0, channels: 0,
            bytes_per_pixel: 0, width: 0, height: 0
        )
        let rc = maple_render_file_scene_linear(rawCStr, xmpCStr, quality.rawValue, &buf)
        guard rc == 0 else {
            let msg = maple_last_error().map { String(cString: $0) } ?? "unknown error"
            throw PipelineError.renderFailed(code: Int(rc), message: msg)
        }
        defer { maple_free_scene_linear_buffer(&buf) }
        guard buf.len_bytes > 0, let ptr = buf.fp16_rgba else {
            throw PipelineError.renderFailed(code: Int(rc), message: "empty scene-linear buffer")
        }
        let data = Data(bytes: ptr, count: Int(buf.len_bytes))
        return MapleSceneLinearImageData(
            width: Int(buf.width),
            height: Int(buf.height),
            channels: Int(buf.channels),
            bytesPerPixel: Int(buf.bytes_per_pixel),
            pixels: data
        )
    }

    private static func _renderSceneLinearBytes(
        ptr: UnsafePointer<UInt8>?,
        len: Int,
        hintCStr: [CChar],
        xmpCStr: UnsafePointer<CChar>?,
        quality: Quality
    ) throws -> MapleSceneLinearImageData {
        var buf = MapleSceneLinearBuffer(
            fp16_rgba: nil, len_bytes: 0, channels: 0,
            bytes_per_pixel: 0, width: 0, height: 0
        )
        let rc = hintCStr.withUnsafeBufferPointer { hintPtr -> Int32 in
            maple_render_bytes_scene_linear(ptr, UInt(len), hintPtr.baseAddress,
                                            xmpCStr, quality.rawValue, &buf)
        }
        guard rc == 0 else {
            let msg = maple_last_error().map { String(cString: $0) } ?? "unknown error"
            throw PipelineError.renderFailed(code: Int(rc), message: msg)
        }
        defer { maple_free_scene_linear_buffer(&buf) }
        guard buf.len_bytes > 0, let bufPtr = buf.fp16_rgba else {
            throw PipelineError.renderFailed(code: Int(rc), message: "empty scene-linear buffer")
        }
        let data = Data(bytes: bufPtr, count: Int(buf.len_bytes))
        return MapleSceneLinearImageData(
            width: Int(buf.width),
            height: Int(buf.height),
            channels: Int(buf.channels),
            bytesPerPixel: Int(buf.bytes_per_pixel),
            pixels: data
        )
    }
```

- [ ] **Step 4.2: Add `decodeSceneLinear` and `processSceneLinear` to `ImageEditPipeline.swift`.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift`, immediately after the existing `decode` function ends (after line 136 `}`), insert:

```swift
    // MARK: Decode (scene-linear path — Plan 1 FFI split)

    /// Decode the RAW into a Rec.2020 fp16 scene-linear CIImage via the
    /// new Rust FFI. Used by the FFI-split path (Plan 1) — the buffer is
    /// pre-AgX, pre-Rec.2020->sRGB, so callers must apply a view transform
    /// before display. Tagged `extendedLinearITUR_2020` so CoreImage
    /// applies the correct primaries-to-working-space matrix on read.
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
        // Build a CIImage directly from the fp16 RGBA buffer tagged with
        // extendedLinearITUR_2020. `CIImage(bitmapData:bytesPerRow:size:format:colorSpace:)`
        // copies the bytes — `imageData.pixels` can be released after the
        // call returns.
        let w = imageData.width, h = imageData.height
        let bytesPerRow = w * imageData.bytesPerPixel
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        return CIImage(
            bitmapData: imageData.pixels,
            bytesPerRow: bytesPerRow,
            size: CGSize(width: w, height: h),
            format: .RGBAh,
            colorSpace: space
        )
    }

    // MARK: Process (scene-linear path — Plan 1 FFI split)

    /// Apply the Plan-1 minimal display-domain chain to a scene-linear
    /// CIImage decoded by `decodeSceneLinear`:
    ///
    ///   1. Lanczos prescale (now numerically meaningful — input is
    ///      scene-linear Rec.2020 fp16, not display-encoded sRGB u8).
    ///   2. AgX Metal kernel — exactly one display-domain op. The
    ///      `applyAgXViewTransform` wrapper hard-fails (DEBUG) / logs
    ///      `os_log` `.error` (Release) on kernel-load failure rather
    ///      than silently returning the untransformed scene-linear
    ///      image (see Task 4 Step 4.0a).
    ///
    /// The Rec.2020->sRGB encode happens at the `CIContext.createCGImage`
    /// call site in `FullImageView.CIImageView` (forced to sRGB output
    /// by Task 4 Step 4.0b). The encode is therefore exactly once,
    /// outside the development chain, and deterministic.
    ///
    /// `model` is reserved for future plans (Plan 2 ports the development
    /// chain). In Plan 1 only `model.contrast` is consumed (it modulates
    /// the AgX sigmoid slope).
    ///
    /// `asShot` is unused in Plan 1; reserved for the WB Metal kernel
    /// in Plan 2.
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

- [ ] **Step 4.3: Add an integration test that exercises the full scene-linear path end-to-end.**

In `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift`, append (inside the same `final class`):

```swift
    // MARK: - Task 4: scene-linear decode + process integration

    /// End-to-end integration: synthesize a CIImage tagged
    /// extendedLinearITUR_2020, push it through `processSceneLinear`,
    /// and confirm the output extent matches `targetSize`. This locks
    /// down the Lanczos-prescale + AgX-kernel wire on a deterministic
    /// input (no fixture dependency).
    func testProcessSceneLinearAppliesPrescaleAndAgX() {
        let pipeline = ImageEditPipeline()
        let w = 100, h = 100
        // Synthesize a scene-linear Rec.2020 mid-gray (0.18 in all 3
        // channels) fp16 RGBA buffer.
        var pixels = [UInt16](repeating: 0, count: w * h * 4)
        let mid = Self.float32ToFloat16Bits(0.18)
        let one = Self.float32ToFloat16Bits(1.0)
        for i in stride(from: 0, to: pixels.count, by: 4) {
            pixels[i + 0] = mid
            pixels[i + 1] = mid
            pixels[i + 2] = mid
            pixels[i + 3] = one
        }
        let bytesPerRow = w * 4 * 2
        let data = pixels.withUnsafeBufferPointer {
            Data(bytes: $0.baseAddress!, count: $0.count * 2)
        }
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        let decoded = CIImage(
            bitmapData: data, bytesPerRow: bytesPerRow,
            size: CGSize(width: w, height: h),
            format: .RGBAh, colorSpace: space
        )
        let processed = pipeline.processSceneLinear(
            decoded: decoded,
            model: .default,
            targetSize: CGSize(width: 50, height: 50)
        )
        XCTAssertEqual(processed.extent.width, 50, accuracy: 0.01)
        XCTAssertEqual(processed.extent.height, 50, accuracy: 0.01)
    }
```

- [ ] **Step 4.4: Build & run the test.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testProcessSceneLinearAppliesPrescaleAndAgX 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 4.5: Run the full Swift test suite to confirm nothing else broke.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | grep -E "passed|failed" | tail -5`
Expected: all tests still pass (existing count + the new integration test). The Spike 1.1/1.2 tests committed earlier are also in this test file and must still pass.

- [ ] **Step 4.6: Commit.**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/MetalKernels.swift src/apple/Maple/MapleApp.swift src/apple/Maple/Views/FullImageView.swift src/apple/Packages/MapleCore/Sources/MapleCore/PipelineRenderer.swift src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
git commit -m "$(cat <<'EOF'
feat(apple): scene-linear decode/process; guard AgX kernel; force sRGB at view

Two corrective companion changes precede the new path:

  * MetalKernels.applyAgXViewTransform replaces three silent ?? input
    fallbacks with structured os_log .error + DEBUG assertionFailure;
    a launch-time DEBUG assert in MapleApp.init catches metallib
    regressions before the user opens an image. Without this a
    metallib drop on the new path would silently display raw scene-
    linear data with no view transform.
  * FullImageView.CIImageView's CIContext.createCGImage now passes
    explicit format: .RGBA8 + colorSpace: sRGB. On the legacy path
    this is a no-op (sRGB in / sRGB out); on the new path it locks
    the Rec.2020->sRGB encode to one deterministic boundary instead
    of an implementation-defined working-space round-trip.

Then the new path itself:
  * PipelineRenderer.renderSceneLinear wraps the new Rust FFI returning
    Rec.2020 fp16 RGBA. ImageEditPipeline.decodeSceneLinear imports it
    as a CIImage tagged extendedLinearITUR_2020 — CoreImage handles
    the primaries->working-space transform on read.
  * processSceneLinear is the minimal Plan-1 display-domain chain:
    Lanczos prescale (now numerically meaningful — input is scene-
    linear fp16, not display-encoded sRGB u8) + the AgX Metal kernel
    applied exactly once via the guarded wrapper. Final encode at
    CIImageView's createCGImage. The legacy decode / process /
    applyFilters chain is untouched.

Integration test locks down extent math for a 100x100 mid-gray input
prescaled to 50x50.

EOF
)"
```

---

## Task 5: Wire `EditSession` to the new path behind `MAPLE_SCENE_LINEAR=1`

**Files:**

- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift`
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift`

**Why this matters:** The new path is fully built by Task 4 but unreachable from the editor. Switch `decodeAndRender` (and `sharedDecode`) to choose between legacy and scene-linear paths based on the env var so the legacy path stays the default until parity is proven across milestones 1-4. The final task (Task 9) flips the default and removes the gate.

- [ ] **Step 5.1: Read `EditSession.swift` lines 760-953 to confirm the cached decode + render flow.**

Read the file. Confirm:

- `decodeAndRender` is at lines 767-868.
- The cached-hit branch at line 793 calls `pipeline.process(decoded:model:targetSize:asShot:)`.
- The cold-decode branch at line 798-825 calls `sharedDecode(asset:pipeline:)` then `pipeline.process(...)`.
- `sharedDecode` (lines 884-953) calls `pipeline.decode(asset:)` at line 916.
- `renderForExport` (lines 468-482) calls `pipeline.decode(asset:quality:.full)` and `pipeline.process(...)` — explicitly out of scope for Plan 1; the export path keeps the legacy chain (Plan 2 will rebuild that as well, but Plan 1 only changes the interactive path).

- [ ] **Step 5.2: Add an env-gated `useSceneLinear` flag and route both render branches through it.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift`, immediately after the `private let pipeline: ImageEditPipeline` line (line 246), insert:

```swift
    /// True if the editor should use the Plan-1 scene-linear FFI path.
    /// Gated by the `MAPLE_SCENE_LINEAR` env var so the legacy path stays
    /// the default until parity is verified. Plan 1 Task 9 flips the
    /// default and removes the gate.
    @ObservationIgnored private let useSceneLinear: Bool = {
        ProcessInfo.processInfo.environment["MAPLE_SCENE_LINEAR"] != nil
    }()
```

Locate the cached-hit branch in `decodeAndRender` (line 793-797). Replace:

```swift
            if let cached, alreadyDecodedID == asset.id {
                // Cached decode — apply filter chain only. Hot path.
                image = await Task.detached(priority: .userInitiated) {
                    pipeline.process(decoded: cached, model: m, targetSize: targetSize, asShot: asShot)
                }.value
            } else {
```

with:

```swift
            if let cached, alreadyDecodedID == asset.id {
                // Cached decode — apply chain only. Hot path. Plan 1
                // gate selects between legacy `process` (sRGB u8 input,
                // full filter chain) and `processSceneLinear` (Rec.2020
                // fp16 input, AgX-only chain).
                image = await Task.detached(priority: .userInitiated) { [useSceneLinear] in
                    if useSceneLinear {
                        return pipeline.processSceneLinear(decoded: cached, model: m, targetSize: targetSize, asShot: asShot)
                    } else {
                        return pipeline.process(decoded: cached, model: m, targetSize: targetSize, asShot: asShot)
                    }
                }.value
            } else {
```

Locate the cold-decode branch (line 821-823) — the `pipeline.process(...)` after `sharedDecode`:

```swift
                let processed = await Task.detached(priority: .userInitiated) {
                    pipeline.process(decoded: decoded, model: m, targetSize: targetSize, asShot: asShot)
                }.value
                image = processed
```

Replace with:

```swift
                let processed = await Task.detached(priority: .userInitiated) { [useSceneLinear] in
                    if useSceneLinear {
                        return pipeline.processSceneLinear(decoded: decoded, model: m, targetSize: targetSize, asShot: asShot)
                    } else {
                        return pipeline.process(decoded: decoded, model: m, targetSize: targetSize, asShot: asShot)
                    }
                }.value
                image = processed
```

Locate the `sharedDecode` call to `pipeline.decode(asset:)` (line 916):

```swift
            // Cache miss — Rust decode, then write-back for the next open.
            guard let decoded = await pipeline.decode(asset: asset) else { return nil }
```

Replace with:

```swift
            // Cache miss — Rust decode, then write-back for the next open.
            // Plan 1 gate: the scene-linear path bypasses the disk cache
            // (the cache stores sRGB JPEGs, which would lose the scene-
            // linear buffer's extended range). Plan 3 will rev the cache
            // format; for now scene-linear opens always pay the Rust
            // decode cost.
            let decoded: CIImage?
            if useSceneLinear {
                decoded = await pipeline.decodeSceneLinear(asset: asset)
            } else {
                decoded = await pipeline.decode(asset: asset)
            }
            guard let decoded = decoded else { return nil }
```

Locate the disk-cache fast-path inside `sharedDecode` at lines 911-914:

```swift
            // Disk-cache fast path. Skips the Rust pipeline entirely when
            // the asset's mtime matches the cached key.
            if let url = asset.primaryURL,
               let cached = await DecodedBufferCache.shared.decoded(for: url) {
                return cached
            }
```

Replace with:

```swift
            // Disk-cache fast path. Skips the Rust pipeline entirely when
            // the asset's mtime matches the cached key. Plan 1 gate: the
            // scene-linear path skips this — see the comment by the
            // `pipeline.decodeSceneLinear` call below.
            if !useSceneLinear,
               let url = asset.primaryURL,
               let cached = await DecodedBufferCache.shared.decoded(for: url) {
                return cached
            }
```

Also locate the disk-cache write-back at lines 917-928 (`if let url = asset.primaryURL { … storeDecoded(captured, for: url) … }`) and gate the entire `if let url = asset.primaryURL` block on `!useSceneLinear`:

Replace lines 917-928:

```swift
            if let url = asset.primaryURL {
                // Fire-and-forget. JPEG-encoding a 100 MP CIImage takes ~1–2 s;
                // gating `task.value` on it pushes that delay onto the
                // published `decodedImage`. The cache is purely a perf assist
                // for the next cold open — losing one write on app crash is
                // fine, blocking the user is not.
                let captured = decoded
                Task.detached(priority: .utility) {
                    await DecodedBufferCache.shared.storeDecoded(captured, for: url)
                }
            }
            return decoded
```

with:

```swift
            if !useSceneLinear, let url = asset.primaryURL {
                // Fire-and-forget. JPEG-encoding a 100 MP CIImage takes ~1–2 s;
                // gating `task.value` on it pushes that delay onto the
                // published `decodedImage`. The cache is purely a perf assist
                // for the next cold open — losing one write on app crash is
                // fine, blocking the user is not.
                //
                // Plan 1: scene-linear path skips the cache write — the
                // cache stores JPEGs, which can't round-trip extended-range
                // fp16. Plan 3 reworks the cache format.
                let captured = decoded
                Task.detached(priority: .utility) {
                    await DecodedBufferCache.shared.storeDecoded(captured, for: url)
                }
            }
            return decoded
```

- [ ] **Step 5.3: Build & run the existing Swift test suite.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | grep -E "passed|failed|error" | tail -5`
Expected: all tests pass (no test changes yet — the env var defaults to off so legacy path is exercised).

- [ ] **Step 5.4: Add an EditSession integration test that exercises both branches with a synthesized CIImage cache seed.**

In `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift`, append:

```swift
    // MARK: - Task 5: EditSession routing

    /// EditSession routes through `processSceneLinear` when MAPLE_SCENE_LINEAR
    /// is set in the launching environment. We can't toggle env in-process,
    /// but we can invoke the pipeline directly — this test confirms that
    /// passing a pre-decoded scene-linear-tagged CIImage through
    /// `pipeline.processSceneLinear` produces a non-nil output extent that
    /// matches `targetSize`. The full env-gated EditSession flow is
    /// covered by manual A/B testing in Task 6 (the env var is set in the
    /// Maple.xcscheme).
    func testProcessSceneLinearProducesValidExtentForTargetSize() {
        let pipeline = ImageEditPipeline()
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        let decoded = CIImage(color: CIColor(red: 0.18, green: 0.18, blue: 0.18))
            .cropped(to: CGRect(x: 0, y: 0, width: 800, height: 600))
            .matchedToWorkingSpace(from: space) ?? CIImage(
                color: CIColor(red: 0.18, green: 0.18, blue: 0.18)
            ).cropped(to: CGRect(x: 0, y: 0, width: 800, height: 600))
        let out = pipeline.processSceneLinear(
            decoded: decoded,
            model: .default,
            targetSize: CGSize(width: 200, height: 200)
        )
        XCTAssertEqual(out.extent.width, 200, accuracy: 0.01)
        XCTAssertEqual(out.extent.height, 150, accuracy: 0.01)
    }
```

- [ ] **Step 5.5: Run the new test.**

Run: `cd src/apple/Packages/MapleCore && swift test --filter testProcessSceneLinearProducesValidExtentForTargetSize 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5.6: Capture the post-change Spike 1.3 timing on the new path — five (5) cold opens, take the median.**

Run 5 cold opens of the reference fixture with `MAPLE_PROFILE=1 MAPLE_SCENE_LINEAR=1`, then 5 with the env-gate off (legacy path) for the apples-to-apples median. Read the `[raw-core]` per-stage timings from each run.

Reference baseline (current `main`) per the Spike 1.3 brief: cold-open median ≈ **4.74 s** for the 100 MP Hasselblad fixture. **Hard stop threshold: > 5.21 s** (more than +10% slower).

Run, in two terminals:

- Terminal A: `cd src/apple && xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build 2>&1 | tail -5` (expected: `BUILD SUCCEEDED`)
- Terminal B: `MAPLE_PROFILE=1 MAPLE_SCENE_LINEAR=1 open -a /Users/$USER/Library/Developer/Xcode/DerivedData/Maple-*/Build/Products/Debug/Maple.app` then open the reference DNG. Close & relaunch between runs to ensure cold start. Repeat 5 times. Then repeat 5 more times with `MAPLE_SCENE_LINEAR` unset for the legacy median.

Read the printed `[raw-core]` lines from the process's stderr (`log stream --predicate 'subsystem == "app.justmaple.aperture"'`) plus stderr — the `stage()` function in `pipeline.rs` writes to stderr directly when `MAPLE_PROFILE` is set.

Append the post-change numbers to the comment block at the top of `SceneLinearPipelineTests.swift` (the one created in Step 1.3.2):

```swift
// Plan 1 Spike 1.3 measurement (5 cold opens per path, median, same fixture):
//
//   legacy path total cold-open    <RECORD ms> (baseline reference: 4740 ms)
//   scene-linear total cold-open   <RECORD ms>
//
//   per-stage breakdown (scene-linear path):
//     [raw-core] linearize          <RECORD>
//     [raw-core] demosaic           <RECORD>
//     ...
//     [raw-core] nr_color           <RECORD>
//     [raw-core] pack_rgba_f32      <RECORD>
//     [raw-core] apply_orientation_rgba  <RECORD>
//     [raw-core] pack_fp16          <RECORD>
//   ─────────────────────────────────────
//
//   savings from skipping agx/rec2020_to_srgb/quantize_u8/apply_orientation: <DELTA ms>
//   added cost from pack_rgba_f32 + apply_orientation_rgba + pack_fp16:      <ADDED ms>
//   FFI bandwidth delta (8 bytes/pixel vs 3 bytes/pixel for half-res):       <BW ms>
//   net change vs legacy median:                                             <NET ms>
//   net change vs reference baseline (4740 ms):                              <NET_REF ms>
//
// PASS criteria: `<NET_REF>` <= +474 ms (i.e. <= +10% of baseline).
// If `<NET_REF>` > +474 ms, Spike 1.3 fails — flag and stop. Reminder:
// Plan 1's wins are correctness-driven (closing three display-pipeline
// bugs), not perf-driven; we accept up to +10% cold-open regression
// for that correctness, but no more.
```

- [ ] **Step 5.7: Compare net change against Spike 1.3 criteria.**

If `<NET_REF>` > **+474 ms** (the new path is more than 10% slower than the 4.74 s baseline, i.e. > 5.21 s), STOP. The FFI bandwidth (8 bytes/pixel fp16 RGBA vs 3 bytes/pixel sRGB u8) is dominating beyond what the correctness wins justify; flag and report. Plan 1 needs revision before Task 9 flips the default. (Note: Task 8's sized-FFI path may resolve a borderline +10% miss because the FFI buffer for the editor's first open shrinks from ~200 MB to ~12 MB — but that's an _additional_ mitigation, not a substitute for closing the Spike 1.3 gate on the unsized path.)

If `<NET_REF>` ≤ +474 ms, accept the regression and proceed. Document the actual number in the commit body — perf wins are correctness-driven, not perf-driven; the user explicitly accepted up to a 10% cold-open regression for the three bugs closed, and a smaller number is a bonus.

- [ ] **Step 5.8: Commit.**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
git commit -m "$(cat <<'EOF'
feat(apple): wire EditSession through scene-linear path behind MAPLE_SCENE_LINEAR

`useSceneLinear` flag (read once from the env at session init) routes
`decodeAndRender`'s cached-hit and cold-decode branches through
`pipeline.processSceneLinear` and `pipeline.decodeSceneLinear` when
set. Disk decoded-buffer cache is skipped on the new path — JPEG can't
round-trip extended-range fp16; Plan 3 revs the cache format.

Captured Spike 1.3 post-change timing (cold open of reference DNG)
in the test-file header. Net change vs baseline: <NET> ms.

EOF
)"
```

---

## Task 6: Manual A/B verification — three bugs closed

**Files:**

- Read: `src/apple/Maple.xcodeproj/xcshareddata/xcschemes/Maple.xcscheme` — confirm the env-var entries from `MAPLE_SKIP_*` exist; add `MAPLE_SCENE_LINEAR` alongside.
- Modify: `src/apple/Maple.xcodeproj/xcshareddata/xcschemes/Maple.xcscheme` — add `MAPLE_SCENE_LINEAR` env entry, disabled by default.

**Why this matters:** Bugs 1+2+3 were identified by user-driven A/B tests against env gates. The new path closes all three by construction — but the verification must reproduce the user's earlier methodology to confirm. Manual tests are necessary because the bugs are zoom-dependent visual artefacts that automated tests don't catch.

- [ ] **Step 6.1: Add `MAPLE_SCENE_LINEAR` to the Maple Xcode scheme so it can be toggled in-IDE.**

Open `src/apple/Maple.xcodeproj/xcshareddata/xcschemes/Maple.xcscheme` in a text editor (NOT Xcode UI — the diff is targeted). Find the `<EnvironmentVariables>` block (introduced by commit `85df200`). Locate the existing pattern, e.g.:

```xml
      <EnvironmentVariable
         key = "MAPLE_SKIP_PRESCALE"
         value = "1"
         isEnabled = "NO">
      </EnvironmentVariable>
```

Immediately after that entry, insert:

```xml
      <EnvironmentVariable
         key = "MAPLE_SCENE_LINEAR"
         value = "1"
         isEnabled = "NO">
      </EnvironmentVariable>
```

Verify the file still parses by opening Xcode and confirming the scheme loads without errors.

- [ ] **Step 6.2: Manual test — Bug 1 (double AgX) closed.**

1. Disable `MAPLE_SKIP_SWIFT_AGX`, `MAPLE_SKIP_SWIFT_FILTERS`, `MAPLE_SKIP_PRESCALE`. Disable `MAPLE_SCENE_LINEAR`. Build & run macOS Maple. Open the reference 100 MP DNG. Screenshot at Fit zoom and at 1:1 zoom. Note the visible color shift (the symptom of double AgX + filter chain on tone-mapped data).
2. Enable `MAPLE_SCENE_LINEAR=1`. Re-run. Screenshot at Fit zoom and at 1:1 zoom.
3. Compare: Fit and 1:1 colors must agree across zoom in (2). Document the comparison by saving the four screenshots into `/tmp/plan-1-task-6-step-2/` named `legacy-fit.png`, `legacy-1to1.png`, `scene-linear-fit.png`, `scene-linear-1to1.png`.

Pass criterion: by eye, `scene-linear-fit.png` and `scene-linear-1to1.png` show no zoom-dependent muted-color shift. (The brief explicitly states sliders for the development chain stay dark — colors will look like a "neutral default render" with no exposure/WB/contrast adjustments. That's correct; Plan 2 ports the development chain.)

- [ ] **Step 6.3: Manual test — Bug 2 (filter chain on tone-mapped data) closed.**

By construction: the new path bypasses `applyFilters` entirely (Task 4 routes through `processSceneLinear`, which only calls `prescaleForDisplay` and `MetalKernels.applyAgXViewTransform`). Confirm via:

Run, with `MAPLE_SCENE_LINEAR=1` set in the scheme: build, run, open the reference DNG, and grep the running app's stderr for `applyFilters` calls. The filter chain logger lines from `ImageEditPipeline.swift:289` (`var img = input` is silent, but `wb`, `f.exposureAdjust`, etc. each leave traces in CoreImage's logging if their working-space conversions actually run).

A simpler check: insert a one-line `print("applyFilters CALLED")` shim in `applyFilters` (line 289), rebuild, run with `MAPLE_SCENE_LINEAR=1`, observe that the line never prints. Then revert the print before Task 9.

Pass criterion: `applyFilters` is never called on the new path.

- [ ] **Step 6.4: Manual test — Bug 3 (Lanczos color shift) closed.**

1. With `MAPLE_SCENE_LINEAR=1`, open the reference DNG. Drag the Maple window to several sizes producing different downscale ratios (e.g. 1:1 = full, 1:2, 1:4, 1:8, 1:16 of native). Screenshot each.
2. Compare the saved screenshots — the colors at every zoom level must match the colors at 1:1.

Pass criterion: no muted/desaturated shift at heavy downscales. The Lanczos filter operates on scene-linear Rec.2020 fp16 (verified by Spike 1.1), so the color space invariance is guaranteed by the input format.

- [ ] **Step 6.5: Run the full test suite once more before committing the scheme entry.**

Run, in parallel:

- `cd src/apple/Packages/MapleCore && swift test 2>&1 | grep -E "passed|failed" | tail -5` (expected: all passing).
- `cd src/raw-pipeline && cargo test -p raw-core --lib 2>&1 | tail -5` (expected: all passing).
- `cd src/raw-pipeline && cargo test -p raw-ffi --lib 2>&1 | tail -5` (expected: all passing).

- [ ] **Step 6.6: Commit the scheme entry and the A/B documentation.**

```bash
git add src/apple/Maple.xcodeproj/xcshareddata/xcschemes/Maple.xcscheme
git commit -m "$(cat <<'EOF'
chore(apple): add MAPLE_SCENE_LINEAR env entry to Maple scheme

Mirrors the MAPLE_SKIP_* diagnostic env entries (commits fc1cc0a,
85df200, a69e6be) so the new scene-linear path can be toggled
in-IDE without editing source. Disabled by default — Plan 1 Task 9
flips the default and removes both the entry and the gate.

EOF
)"
```

---

## Task 7: Split the conflated Swift `rust FFI decode` log line; add Rust stages around read / decode / pack

> **Source: ticket 06 § Recommended Milestones — Milestone 1 ("Instrument and Rename"). Cross-reference ticket 06 § Technical Requirements — Rust profile-stage list.**

**Files:**

- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift`
- Modify: `src/raw-pipeline/raw-ffi/src/lib.rs`
- Modify: `src/raw-pipeline/raw-core/src/decode.rs` (or wherever `decode_bytes` lives — confirm at Step 7.1)
- Read for reference: `src/raw-pipeline/raw-core/src/pipeline.rs` lines 16-38 (the `stage()` helper added in commit `ed96688`)

**Why this matters:** The user's current observability is one Swift-side number labeled `[swift] rust FFI decode` that bundles five distinct costs together: raw file read, rawler decode, develop chain (already broken out by `pipeline.rs`'s `stage()` calls — but only when `MAPLE_PROFILE=1` and only on the Rust side), FFI output packing, and Swift-side `Data(bytes:)` copy. Spike 1.3 in Task 1 needs precise per-stage numbers to give a reproducible pass/fail signal — without splitting the conflated line, "Plan 1 made decode 200 ms slower" is ambiguous (slower because of fp16 pack? slower because of the Swift-side `Data` copy doubling? slower because rawler is on a slow path?). This task is cheap and small — pure instrumentation, no architecture change — but it earns its place because it gates Spike 1.3's honest measurement procedure (Task 1 Step 1.3.2 records baseline numbers; Task 5 Step 5.6 records the post-change numbers). Per ticket 06 § Acceptance Criteria, the `[swift] rust FFI decode` stage is **split or renamed so it no longer hides render/downsample/copy costs under the word "decode"**.

- [ ] **Step 7.1: Confirm where `decode_bytes` and the FFI output packing live.**

Run: `grep -nR "fn decode_bytes" src/raw-pipeline/raw-core/src` — expect a single hit; record the file:line so Step 7.3 can target it.

Run: `grep -nE "Box::from_raw|forget\\(boxed\\)|len_lanes \\* std::mem" src/raw-pipeline/raw-ffi/src/lib.rs | head -10` — confirm the Vec→raw-pointer conversions in the existing legacy `maple_render_file` and the Task 3 entries `maple_render_file_scene_linear` / `maple_render_bytes_scene_linear` are the spots that should become `stage("ffi_pack", …)` scopes.

The `stage()` helper at [`pipeline.rs:31-38`](../../src/raw-pipeline/raw-core/src/pipeline.rs:31) is `pub(crate)`-scoped today (file-private — declared at `fn stage<T>(...)` without a `pub` qualifier). Task 7 needs it visible from `raw-ffi` and `raw-core::decode`. Bump the visibility from file-private to `pub` in `pipeline.rs` (or factor it into `src/raw-pipeline/raw-core/src/lib.rs` as a `pub fn stage`).

- [ ] **Step 7.2: Make `stage()` callable from outside `pipeline.rs`.**

Edit `src/raw-pipeline/raw-core/src/pipeline.rs` line 31. Replace:

```rust
fn stage<T>(name: &'static str, f: impl FnOnce() -> T) -> T {
```

with:

```rust
pub fn stage<T>(name: &'static str, f: impl FnOnce() -> T) -> T {
```

(Per `docs/raw-core` note in commit `ede1e7a` — `MAPLE_PROFILE` value semantics are "any value enables; only `unset` disables". The visibility change is the only semantic change.)

Run: `cd src/raw-pipeline && cargo build -p raw-core 2>&1 | tail -10`
Expected: build succeeds; no callers were relying on the file-private scope.

- [ ] **Step 7.3: Wrap raw file read and rawler decode in `stage()` scopes inside the Rust FFI.**

In `src/raw-pipeline/raw-ffi/src/lib.rs`, locate the four entry points that read a RAW file or decode bytes:

- `maple_render_file` (legacy; existing, before line 268)
- `maple_render_bytes` (legacy; existing, before line 268)
- `maple_render_file_scene_linear` (added by Task 3 Step 3.2)
- `maple_render_bytes_scene_linear` (added by Task 3 Step 3.2)

In each one, replace the bare `std::fs::read(raw_path)` call with `raw_core::pipeline::stage("ffi_raw_read", || std::fs::read(raw_path))`.

Replace the bare `decode_bytes(&raw_bytes, ext)` call (and the `&input, &ext_owned` variant) with `raw_core::pipeline::stage("ffi_rawler_decode", || decode_bytes(&raw_bytes, ext))`.

Replace the trailing buffer-pack block (the `let mut boxed = X.into_boxed_slice(); std::mem::forget(boxed); …` block in each entry) with a `raw_core::pipeline::stage("ffi_pack", || { … })` wrapper. The `stage()` helper takes a closure; its return value flows through, so wrapping the existing pack block requires returning the `(fp16_ptr, len_lanes, len_bytes)` tuple from inside the closure.

Run: `cd src/raw-pipeline && cargo test -p raw-ffi --lib 2>&1 | tail -10`
Expected: existing tests still pass.

Run: `MAPLE_PROFILE=1 cd src/raw-pipeline && cargo test -p raw-ffi --lib render_scene_linear_default_model_via_ffi 2>&1 | grep "\\[raw-core\\]" | head -10`
Expected: `[raw-core] ffi_raw_read`, `[raw-core] ffi_rawler_decode`, `[raw-core] ffi_pack` lines appear in the stderr output, alongside the existing per-stage lines from `pipeline.rs`.

- [ ] **Step 7.4: Split the Swift `[swift] rust FFI decode` label into per-stage labels in `EditSession.swift`.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift`, locate the cold-decode call site (line 810 — `let decoded = await sharedDecode(asset: asset, pipeline: pipeline)`). The user-facing log label `[swift] rust FFI decode` does not exist as a literal in source today — it is the conceptual single number the user observes via Instruments points-of-interest under the `editSessionSignposter` "decode" interval at line 31. We split that single observation into discrete labeled timings using the existing `[swift] <stage>` `print(...)` pattern (refer to existing labels: `[swift] cached preview lookup`, `[swift] embedded preview seed`, `[swift] filter chain (.fast)` — confirmed grep-able from prose; if the literal labels are not yet in source, this task introduces them as the canonical pattern).

In `EditSession.swift` add a small private helper at the top of the file (near `editSessionSignposter` at line 34):

```swift
/// Log a Swift-side stage timing with the `[swift] <stage> <duration>`
/// pattern. Mirrors the Rust `stage()` helper at pipeline.rs:31. Only
/// emits when `MAPLE_PROFILE` env var is set so production builds pay
/// nothing.
@inline(__always)
private func swiftStage<T>(_ name: String, _ body: () throws -> T) rethrows -> T {
    let t0 = ContinuousClock.now
    let r = try body()
    if ProcessInfo.processInfo.environment["MAPLE_PROFILE"] != nil {
        let elapsed = ContinuousClock.now - t0
        let ms = Double(elapsed.components.attoseconds) / 1e15
        print("[swift] \(name)\t\(String(format: "%.2f", ms)) ms")
    }
    return r
}

@inline(__always)
private func swiftStageAsync<T>(_ name: String, _ body: () async throws -> T) async rethrows -> T {
    let t0 = ContinuousClock.now
    let r = try await body()
    if ProcessInfo.processInfo.environment["MAPLE_PROFILE"] != nil {
        let elapsed = ContinuousClock.now - t0
        let ms = Double(elapsed.components.attoseconds) / 1e15
        print("[swift] \(name)\t\(String(format: "%.2f", ms)) ms")
    }
    return r
}
```

Then in the cold-decode branch at lines 810-823, wrap each sub-cost in a `swiftStage(...)` / `swiftStageAsync(...)` scope. Replace lines 810-824:

```swift
                let decoded = await sharedDecode(asset: asset, pipeline: pipeline)
                guard !Task.isCancelled else {
                    isRendering = false
                    return
                }
                guard let decoded else {
                    throw RenderError.pipelineFailed
                }
                // Process is cheap (CoreImage filter chain) — run it per
                // phase with the caller's targetSize. Not shared with peers
                // because targetSize differs between fast and refine.
                let processed = await Task.detached(priority: .userInitiated) {
                    pipeline.process(decoded: decoded, model: m, targetSize: targetSize, asShot: asShot)
                }.value
                image = processed
```

with:

```swift
                let decoded = await swiftStageAsync("decode FFI call") {
                    await sharedDecode(asset: asset, pipeline: pipeline)
                }
                guard !Task.isCancelled else {
                    isRendering = false
                    return
                }
                guard let decoded else {
                    throw RenderError.pipelineFailed
                }
                // Process is cheap (CoreImage filter chain) — run it per
                // phase with the caller's targetSize. Not shared with peers
                // because targetSize differs between fast and refine.
                let processed = await swiftStageAsync("filter chain (\(phaseName))") {
                    await Task.detached(priority: .userInitiated) {
                        pipeline.process(decoded: decoded, model: m, targetSize: targetSize, asShot: asShot)
                    }.value
                }
                image = processed
```

Inside `sharedDecode` (lines 884-953), wrap the disk-cache lookup, the Rust FFI decode itself, the `Data(bytes:)` copy back to Swift, and the CIImage build in their own labeled scopes. Specifically, in `sharedDecode` at line 911-916:

```swift
            if let url = asset.primaryURL,
               let cached = await DecodedBufferCache.shared.decoded(for: url) {
                return cached
            }
            // Cache miss — Rust decode, then write-back for the next open.
            guard let decoded = await pipeline.decode(asset: asset) else { return nil }
```

Replace with:

```swift
            let cachedHit: CIImage? = await swiftStageAsync("cached preview lookup") {
                if let url = asset.primaryURL,
                   let cached = await DecodedBufferCache.shared.decoded(for: url) {
                    return cached
                }
                return nil
            }
            if let cachedHit { return cachedHit }
            // Cache miss — Rust decode, then write-back for the next open.
            guard let decoded = await swiftStageAsync("decode FFI call (cold)") {
                await pipeline.decode(asset: asset)
            } else { return nil }
```

Inside `PipelineRenderer._renderSceneLinear` (Task 4 Step 4.1) and `PipelineRenderer.render`'s legacy equivalent in `PipelineRenderer.swift`, wrap the `Data(bytes: ptr, count:)` copy in its own scope:

```swift
            let data = swiftStage("decode result copy") {
                Data(bytes: ptr, count: Int(buf.len_bytes))
            }
```

(That is the load-bearing copy — for a 200 MB fp16 RGBA buffer the `Data(bytes:)` constructor allocates and memcpys end-to-end; without an isolated stage label, it shows up as part of `decode FFI call`.)

Inside `decodeSceneLinear` (Task 4 Step 4.2) and `decode`, wrap the `CIImage(bitmapData:...)` / `CIImage(cgImage:)` build in its own scope:

```swift
        return swiftStage("decode CIImage build") {
            CIImage(
                bitmapData: imageData.pixels,
                bytesPerRow: bytesPerRow,
                size: CGSize(width: w, height: h),
                format: .RGBAh,
                colorSpace: space
            )
        }
```

- [ ] **Step 7.5: Establish baseline numbers for the 100 MP reference RAW so Spike 1.3's measurement procedure is reproducible.**

Run, in two terminals (Step 5.6 baseline mirror, but now with labeled per-stage breakdowns):

- Terminal A: `cd src/apple && xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build 2>&1 | tail -3` — expected: `BUILD SUCCEEDED`.
- Terminal B: `MAPLE_PROFILE=1 open -a /Users/$USER/Library/Developer/Xcode/DerivedData/Maple-*/Build/Products/Debug/Maple.app` then open the reference DNG (`test-fixtures/raws/dji-mavic3pro-100mp.dng`). Quit & relaunch between runs. 5 cold opens.

Read the labeled stage lines from the process stderr (the `print(...)` calls in `swiftStage` route to stderr in a SwiftUI app's log stream; capture via `log stream --process Maple --predicate 'composedMessage CONTAINS "[swift]"'` or by launching from Terminal). Take the median of each stage across the 5 runs.

Append to the comment block at the top of `SceneLinearPipelineTests.swift` (the one created in Step 1.3.2) a new sub-section:

```swift
// Plan 1 v2 Task 7 baseline (legacy path, MAPLE_SCENE_LINEAR unset, 5 cold
// opens of dji-mavic3pro-100mp.dng, median per stage):
//
//   [swift] cached preview lookup            <RECORD ms>
//   [swift] decode FFI call (cold)           <RECORD ms>
//     ├── [raw-core] ffi_raw_read            <RECORD ms>
//     ├── [raw-core] ffi_rawler_decode       <RECORD ms>
//     ├── [raw-core] linearize..nr_color     <RECORD ms total>
//     ├── [raw-core] agx + rec2020_to_srgb + quantize_u8 + apply_orientation
//     │                                      <RECORD ms total>
//     └── [raw-core] ffi_pack                <RECORD ms>
//   [swift] decode result copy               <RECORD ms>
//   [swift] decode CIImage build             <RECORD ms>
//   [swift] filter chain (.fast)             <RECORD ms>
//   ─────────────────────────────────────────
//   total cold open                          <RECORD ms> (was: 4740 ms — the
//                                            "[swift] rust FFI decode"
//                                            number from the Spike 1.3 brief)
//
// Spike 1.3's hard-stop threshold (cold-open median > 5210 ms) compares
// the post-Task-5 scene-linear total to this baseline. Task 8 adds the
// sized-FFI variant and re-records the same breakdown with the new path.
```

- [ ] **Step 7.6: Run the Swift test suite to confirm the helper compiles and nothing else broke.**

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | grep -E "passed|failed" | tail -5`
Expected: all tests still pass — the helpers are unused in tests, and the cold-decode wrapping is functionally identical.

- [ ] **Step 7.7: Commit.**

```bash
git add src/raw-pipeline/raw-core/src/pipeline.rs src/raw-pipeline/raw-ffi/src/lib.rs src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift src/apple/Packages/MapleCore/Sources/MapleCore/PipelineRenderer.swift src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
git commit -m "$(cat <<'EOF'
perf(apple,raw-ffi): split the conflated [swift] rust FFI decode label

Per ticket 06 Milestone 1: today's `[swift] rust FFI decode` number
hides five costs. Replace it with discrete labeled stages on both
sides of the FFI:

Rust (raw-ffi):
  * stage("ffi_raw_read")       — std::fs::read of the RAW path
  * stage("ffi_rawler_decode")  — decode_bytes
  * stage("ffi_pack")           — Vec → raw-pointer + std::mem::forget
  (pipeline.rs's per-stage timings already cover the develop chain.)

Swift (EditSession + PipelineRenderer + ImageEditPipeline):
  * [swift] cached preview lookup       — DecodedBufferCache hit/miss
  * [swift] decode FFI call (cold)      — bare FFI call duration
  * [swift] decode result copy          — Data(bytes:count:) memcpy
  * [swift] decode CIImage build        — CIImage(bitmapData:...) build
  * [swift] filter chain (.fast/.refine) — pipeline.process call

Establishes a reproducible measurement procedure for Spike 1.3 in
Task 1 — the legacy path baseline is now per-stage instead of one
number. Plumbing only; no behavioral change.

EOF
)"
```

---

## Task 8: Add the viewport-sized scene-linear FFI entry point and route the editor's first open through it

> **Source: ticket 06 § Recommended Milestones — Milestone 2 ("Sized Output Path"). Cross-reference ticket 06 § Product Requirements 1, 2, 3, 5; § Technical Requirements (Rust + Swift); § Performance Requirements; § Acceptance Criteria; § Open Questions.**

**Files:**

- Modify: `src/raw-pipeline/raw-core/src/pipeline.rs`
- Modify: `src/raw-pipeline/raw-ffi/src/lib.rs`
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/PipelineRenderer.swift`
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift`
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift`
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift`
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/RenderedPreviewCache.swift` (cache-key augmentation per ticket 06 § Product Requirements 5)
- Read for reference: `src/raw-pipeline/raw-core/src/api.rs` lines 382-440 (existing `downsample_to_rgba` box filter — for shape only; the new helper operates on f32 RGB working buffers, not display-encoded sRGB u8, so it is a separate function rather than a reuse)

**Why this matters:** Today's editor open on the 100 MP Hasselblad fixture pays for ~25 MP of scene-linear data crossing the FFI even though the visible viewport is ~1.5 MP. With Task 4's scene-linear FFI returning fp16 RGBA the FFI buffer becomes ~200 MB (8 bytes/pixel × 25 MP) — a 2.7× bandwidth jump from today's ~75 MB sRGB u8 path. That bandwidth jump is what Spike 1.3's +10% hard-stop threshold guards against. The sized variant runs the same shared `develop_scene_linear_from_raw_with_quality` helper, then downsamples in the Rust pipeline to the viewport's target size, then packs to fp16 at the _target_ size — for a 1500×1000 viewport the FFI buffer is ~12 MB (1500 × 1000 × 8 bytes), an order of magnitude below today's path. Per ticket 06 § Product Requirements 1 the new entry takes a long-edge cap; the returned image preserves source aspect ratio, fits within the cap, and never upscales. This is the Plan 1 v2 contribution that turns the FFI buffer growth from a _cost_ into a _win_.

**API shape — explicit decision:** ticket 06's draft proposed `max_width / max_height`; ticket 06 § Open Questions raised `max_long_edge` as an alternative. **Plan 1 v2 commits to `max_long_edge` (a single u32 scalar).** Justification: a single scalar simplifies the WASM/Web parity (Plan 3 will mirror the FFI on the Web side, and a single scalar keeps the JS binding signature shorter); aspect math is local to the Rust renderer (the input aspect ratio is determined by the source RAW, not the caller, so the renderer is the only place that needs to know both dimensions); and fit-to-window is the only Plan 1 v2 use case (refinement-on-zoom is deferred — see Out-of-Scope), so a per-axis cap adds no flexibility today. A future plan can add a per-axis `max_width / max_height` variant if Plan 4+ shows a need. Comment this decision in the Rust function signature so the Open Question is closed in code, not lore.

**Downsample helper — explicit decision:** the existing `downsample_to_rgba` at [`api.rs:382-440`](../../src/raw-pipeline/raw-core/src/api.rs:382) is a box / area-average filter that operates on `Rendered` (sRGB u8 RGB). The new entry needs a separate helper that operates on the developed `Image`'s f32 RGB pixel buffer **before** it leaves scene-linear. Step 8.2 below adds `pub fn downsample_image_area(image: &mut Image, max_long_edge: u32)` (area-average for now — same algorithm as `downsample_to_rgba` but in f32 RGB; ticket 06 § Technical Requirements explicitly allows the first implementation to be area-average / box-filter and defers the higher-quality Lanczos to a follow-up). Doing the downsample on the f32 RGB working buffer (not on the fp16 RGBA packed output) preserves precision for the orientation step and avoids two precision losses (f32 → fp16 → resample → repack would round twice).

- [ ] **Step 8.1: Add a TDD-fail test for the new sized entry point in raw-core.**

In `src/raw-pipeline/raw-core/src/pipeline.rs`, append to the `mod tests` block (after the `render_scene_linear_test_0002_preview_returns_rec2020_fp16_rgba` test added in Task 2 Step 2.2):

```rust
    /// Sized scene-linear FFI entry: caps the long edge at a viewport
    /// budget. Verify: the returned buffer's long edge equals the cap
    /// (or stays at the source dimension if the source is smaller — no
    /// upscale per ticket 06 § Product Requirements 1), the aspect ratio
    /// matches the source within rounding (1 pixel tolerance), and the
    /// alpha lane is 1.0 everywhere.
    #[test]
    fn render_scene_linear_sized_test_0002_caps_long_edge_at_1500() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let bytes = std::fs::read(&path).expect("read raw");
        let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
        let model = AdjustmentModel::default();
        let max_long_edge: u32 = 1500;
        let (w, h, fp16_rgba) = render_scene_linear_sized_from_raw_with_quality(
            &raw, &model, RenderQuality::Preview, max_long_edge,
        ).expect("scene-linear sized preview render");
        // Cap respected on the long edge.
        assert!(w.max(h) <= max_long_edge,
            "long edge exceeded cap: {}x{} > {}", w, h, max_long_edge);
        // No upscale: even if Preview half-res < cap, we don't enlarge.
        // (Conservative — the test rig's `test_0002.dng` is small. If
        // its half-res rendered dimensions are <= 1500, w*h*4 must
        // equal that source size, not the cap.)
        // Buffer length matches.
        assert_eq!(fp16_rgba.len() as u32, 4 * w * h);
        // Alpha = 1.0 everywhere.
        for chunk in fp16_rgba.chunks_exact(4) {
            assert_eq!(chunk[3], 0x3c00, "alpha != 1.0 in sized buffer");
        }
    }
```

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib pipeline::tests::render_scene_linear_sized_test_0002_caps_long_edge_at_1500 2>&1 | tail -10`
Expected: **compilation error** — `cannot find function 'render_scene_linear_sized_from_raw_with_quality' in this scope`. TDD-fail signal.

- [ ] **Step 8.2: Add the sized entry point and the f32-RGB area-average downsample helper to `pipeline.rs`.**

In `src/raw-pipeline/raw-core/src/pipeline.rs`, immediately after `render_scene_linear_from_raw_with_quality` ends (after the `Ok((w, h, fp16))` line added in Task 2 Step 2.4b), append:

```rust
/// Area-average downsample an `Image`'s f32 RGB pixel buffer to fit within
/// `max_long_edge` on its long edge while preserving the aspect ratio.
/// **Never upscales** (ticket 06 § Product Requirements 1) — if the source
/// long edge is already <= `max_long_edge`, returns the image unmodified.
///
/// Same algorithm as `api::downsample_to_rgba` but in f32 RGB: integer
/// source-row spans are averaged into each destination pixel, no
/// premultiplied-alpha or gamma considerations because the buffer is
/// straight scene-linear with no alpha channel. A higher-quality Lanczos
/// or Mitchell variant lands as a follow-up (ticket 06 Milestone 3).
///
/// Mutates `image` in place; updates `image.width` and `image.height` to
/// the new dimensions. Stages: `downsample_area_f32` for MAPLE_PROFILE.
pub fn downsample_image_area(image: &mut crate::image::Image, max_long_edge: u32) {
    let (sw, sh) = (image.width, image.height);
    let long_edge = sw.max(sh);
    if long_edge <= max_long_edge { return; }
    let (dw, dh) = if sw >= sh {
        let scale = max_long_edge as f64 / sw as f64;
        (max_long_edge, ((sh as f64 * scale).round() as u32).max(1))
    } else {
        let scale = max_long_edge as f64 / sh as f64;
        (((sw as f64 * scale).round() as u32).max(1), max_long_edge)
    };
    let sw_u = sw as usize;
    let mut out: Vec<[f32; 3]> = Vec::with_capacity((dw as usize) * (dh as usize));
    for y in 0..dh {
        let y0 = ((y as u64) * (sh as u64) / (dh as u64)) as usize;
        let y1 = (((y + 1) as u64) * (sh as u64) / (dh as u64)).max((y0 + 1) as u64) as usize;
        let y1 = y1.min(sh as usize);
        for x in 0..dw {
            let x0 = ((x as u64) * (sw as u64) / (dw as u64)) as usize;
            let x1 = (((x + 1) as u64) * (sw as u64) / (dw as u64)).max((x0 + 1) as u64) as usize;
            let x1 = x1.min(sw as usize);
            let (mut sr, mut sg, mut sb, mut n) = (0.0f32, 0.0f32, 0.0f32, 0u32);
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let p = image.pixels[sy * sw_u + sx];
                    sr += p[0]; sg += p[1]; sb += p[2]; n += 1;
                }
            }
            let nf = n.max(1) as f32;
            out.push([sr / nf, sg / nf, sb / nf]);
        }
    }
    image.pixels = out;
    image.width = dw;
    image.height = dh;
}

/// Sized scene-linear render entry. Same shared development chain as
/// `render_scene_linear_from_raw_with_quality`, then downsample to fit
/// within `max_long_edge` (single scalar — see Plan 1 v2 Task 8 API
/// decision: long-edge simplifies WASM parity and aspect math is local
/// to the renderer; per ticket 06 § Open Questions). Never upscales.
///
/// Plan 1 v2 (FFI split + viewport-sized) — the Apple side imports this
/// buffer at the target dimensions and runs Lanczos prescale + AgX kernel
/// + sRGB encode in CoreImage.
pub fn render_scene_linear_sized_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
) -> Result<(u32, u32, Vec<u16>)> {
    let mut scene = develop_scene_linear_from_raw_with_quality(raw, model, quality)?;
    stage("downsample_area_f32", || downsample_image_area(&mut scene, max_long_edge));
    let (w0, h0) = (scene.width, scene.height);
    let rgba_f32 = stage("pack_rgba_f32_sized", || {
        let mut v = Vec::with_capacity(scene.pixels.len() * 4);
        for p in &scene.pixels {
            v.push(p[0]);
            v.push(p[1]);
            v.push(p[2]);
            v.push(1.0);
        }
        v
    });
    let (w, h, oriented_f32) = stage("apply_orientation_rgba_sized", || {
        apply_orientation_f32_rgba(&rgba_f32, w0, h0, raw.orientation)
    });
    let fp16: Vec<u16> = stage("pack_fp16_sized", || {
        oriented_f32.iter().map(|&v| f32_to_f16_bits(v)).collect()
    });
    Ok((w, h, fp16))
}
```

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib pipeline::tests::render_scene_linear_sized_test_0002_caps_long_edge_at_1500 2>&1 | tail -10`
Expected: PASS (or "ignored" if `test_0002.dng` is absent — fixture-gated).

Run: `cd src/raw-pipeline && cargo test -p raw-core --lib 2>&1 | tail -5`
Expected: full suite still passes (94 + Task 2's new test + Task 8's new test).

- [ ] **Step 8.3: Add the sized FFI entry points to `raw-ffi`.**

In `src/raw-pipeline/raw-ffi/src/lib.rs`, immediately after `maple_free_scene_linear_buffer` (added in Task 3 Step 3.2; the closing `}` after the `*b = MapleSceneLinearBuffer::empty();` line), append:

```rust
/// Sized scene-linear render — same as `maple_render_file_scene_linear`
/// but downsamples to fit within `max_long_edge` on its long edge,
/// preserving aspect ratio, never upscaling. Same return / error
/// conventions and the same `MapleSceneLinearBuffer` output struct.
///
/// Plan 1 v2 — see docs/superpowers/plans/2026-04-24-ffi-split-plan-1.md
/// Task 8 and docs/tickets/06-viewport-sized-rust-ffi-preview.md
/// Milestone 2.
#[no_mangle]
pub unsafe extern "C" fn maple_render_file_scene_linear_sized(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    max_long_edge: u32,
    quality_preview: i32,
    out: *mut MapleSceneLinearBuffer,
) -> i32 {
    if raw_path.is_null() || out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    if max_long_edge == 0 {
        set_last_error("max_long_edge must be > 0".into());
        return 9;
    }
    let raw_path_str = match CStr::from_ptr(raw_path).to_str() {
        Ok(s) => s.to_owned(),
        Err(e) => { set_last_error(format!("raw_path not UTF-8: {}", e)); return 2; }
    };
    let xmp_path_str: Option<String> = if xmp_path.is_null() {
        None
    } else {
        match CStr::from_ptr(xmp_path).to_str() {
            Ok(s) => Some(s.to_owned()),
            Err(e) => { set_last_error(format!("xmp_path not UTF-8: {}", e)); return 3; }
        }
    };
    let out_ptr = out as usize;
    with_large_stack(move || {
        let raw_path = std::path::Path::new(&raw_path_str);
        let model = match &xmp_path_str {
            None => xmp::AdjustmentModel::default(),
            Some(p) => match std::fs::read_to_string(p) {
                Ok(xml) => match xmp::parse(&xml) {
                    Ok(m) => m,
                    Err(e) => { set_last_error(format!("xmp parse: {}", e)); return 4; }
                },
                Err(e) => { set_last_error(format!("xmp read: {}", e)); return 5; }
            },
        };
        let raw_bytes = match raw_core::pipeline::stage("ffi_raw_read", || std::fs::read(raw_path)) {
            Ok(b) => b,
            Err(e) => { set_last_error(format!("raw read: {}", e)); return 6; }
        };
        let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || decode_bytes(&raw_bytes, ext)) {
            Ok(r) => r,
            Err(e) => { set_last_error(format!("decode: {}", e)); return 7; }
        };
        let quality = if quality_preview != 0 {
            raw_core::pipeline::RenderQuality::Preview
        } else {
            raw_core::pipeline::RenderQuality::Full
        };
        let (w, h, fp16) = match raw_core::pipeline::render_scene_linear_sized_from_raw_with_quality(
            &raw_img, &model, quality, max_long_edge,
        ) {
            Ok(t) => t,
            Err(e) => { set_last_error(format!("render: {}", e)); return 8; }
        };
        let (fp16_ptr, len_lanes, len_bytes) = raw_core::pipeline::stage("ffi_pack", || {
            let mut boxed = fp16.into_boxed_slice();
            let p = boxed.as_mut_ptr();
            let n = boxed.len();
            std::mem::forget(boxed);
            (p, n, n * std::mem::size_of::<u16>())
        });
        unsafe {
            *(out_ptr as *mut MapleSceneLinearBuffer) =
                MapleSceneLinearBuffer {
                    fp16_rgba: fp16_ptr,
                    len_bytes,
                    channels: 4,
                    bytes_per_pixel: 8,
                    width: w,
                    height: h,
                };
        }
        let _ = len_lanes; // expressed for symmetry with non-sized entry
        0
    })
}

/// Sized scene-linear render from a byte slice — bytes equivalent of
/// `maple_render_file_scene_linear_sized`. Same args + `raw_bytes` /
/// `raw_len` / `hint_ext`.
#[no_mangle]
pub unsafe extern "C" fn maple_render_bytes_scene_linear_sized(
    raw_bytes: *const u8,
    raw_len: usize,
    hint_ext: *const c_char,
    xmp_path: *const c_char,
    max_long_edge: u32,
    quality_preview: i32,
    out: *mut MapleSceneLinearBuffer,
) -> i32 {
    if raw_bytes.is_null() || out.is_null() {
        set_last_error("null pointer argument".into());
        return 1;
    }
    if max_long_edge == 0 {
        set_last_error("max_long_edge must be > 0".into());
        return 9;
    }
    let ext_owned: String = if hint_ext.is_null() {
        String::new()
    } else {
        match CStr::from_ptr(hint_ext).to_str() {
            Ok(s) => s.to_owned(),
            Err(e) => { set_last_error(format!("hint_ext not UTF-8: {}", e)); return 2; }
        }
    };
    let xmp_path_str: Option<String> = if xmp_path.is_null() {
        None
    } else {
        match CStr::from_ptr(xmp_path).to_str() {
            Ok(s) => Some(s.to_owned()),
            Err(e) => { set_last_error(format!("xmp_path not UTF-8: {}", e)); return 3; }
        }
    };
    let input: Vec<u8> = std::slice::from_raw_parts(raw_bytes, raw_len).to_vec();
    let out_ptr = out as usize;
    with_large_stack(move || {
        let model = match &xmp_path_str {
            None => xmp::AdjustmentModel::default(),
            Some(p) => match std::fs::read_to_string(p) {
                Ok(xml) => match xmp::parse(&xml) {
                    Ok(m) => m,
                    Err(e) => { set_last_error(format!("xmp parse: {}", e)); return 4; }
                },
                Err(e) => { set_last_error(format!("xmp read: {}", e)); return 5; }
            },
        };
        let raw_img = match raw_core::pipeline::stage("ffi_rawler_decode", || decode_bytes(&input, &ext_owned)) {
            Ok(r) => r,
            Err(e) => { set_last_error(format!("decode: {}", e)); return 7; }
        };
        let quality = if quality_preview != 0 {
            raw_core::pipeline::RenderQuality::Preview
        } else {
            raw_core::pipeline::RenderQuality::Full
        };
        let (w, h, fp16) = match raw_core::pipeline::render_scene_linear_sized_from_raw_with_quality(
            &raw_img, &model, quality, max_long_edge,
        ) {
            Ok(t) => t,
            Err(e) => { set_last_error(format!("render: {}", e)); return 8; }
        };
        let (fp16_ptr, _len_lanes, len_bytes) = raw_core::pipeline::stage("ffi_pack", || {
            let mut boxed = fp16.into_boxed_slice();
            let p = boxed.as_mut_ptr();
            let n = boxed.len();
            std::mem::forget(boxed);
            (p, n, n * std::mem::size_of::<u16>())
        });
        unsafe {
            *(out_ptr as *mut MapleSceneLinearBuffer) =
                MapleSceneLinearBuffer {
                    fp16_rgba: fp16_ptr,
                    len_bytes,
                    channels: 4,
                    bytes_per_pixel: 8,
                    width: w,
                    height: h,
                };
        }
        0
    })
}
```

Append to `mod tests { … }` in the same file:

```rust
    #[test]
    fn render_scene_linear_sized_via_ffi_caps_long_edge() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
        let mut buf = MapleSceneLinearBuffer::empty();
        let max_long_edge: u32 = 800;
        let rc = unsafe {
            maple_render_file_scene_linear_sized(
                raw_cstr.as_ptr(), std::ptr::null(), max_long_edge, 1, &mut buf,
            )
        };
        assert_eq!(rc, 0, "render rc = {}", rc);
        assert!(buf.width.max(buf.height) <= max_long_edge,
            "size cap not respected: {}x{}", buf.width, buf.height);
        assert_eq!(buf.bytes_per_pixel, 8);
        assert_eq!(buf.len_bytes as u32, buf.width * buf.height * 8);
        unsafe { maple_free_scene_linear_buffer(&mut buf) };
    }

    #[test]
    fn sized_zero_long_edge_sets_error() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if !path.exists() { return; }
        let raw_cstr = CString::new(path.to_str().unwrap()).unwrap();
        let mut buf = MapleSceneLinearBuffer::empty();
        let rc = unsafe {
            maple_render_file_scene_linear_sized(
                raw_cstr.as_ptr(), std::ptr::null(), 0, 1, &mut buf,
            )
        };
        assert_eq!(rc, 9);
    }
```

Run: `cd src/raw-pipeline && cargo test -p raw-ffi --lib 2>&1 | tail -10`
Expected: all passing (Task 3's 5 + Task 8's 2 = 7).

- [ ] **Step 8.4: Rebuild the xcframework so Apple picks up the new symbols.**

Run: `./src/apple/scripts/build-xcframework.sh 2>&1 | tail -20`
Expected: `==> Done.`

Run: `grep -E "scene_linear_sized|maple_render_file_scene_linear_sized|maple_render_bytes_scene_linear_sized" src/apple/Packages/MapleCore/Sources/MapleCore/include/RawPipeline.h | head -10`
Expected: at least 2 lines including both new entry points; the existing `MapleSceneLinearBuffer` and `maple_free_scene_linear_buffer` are reused.

- [ ] **Step 8.5: Add `PipelineRenderer.renderPreviewSized(...)` wrappers.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/PipelineRenderer.swift`, immediately after `_renderSceneLinearBytes` (the second private helper added in Task 4 Step 4.1), append:

```swift
    /// Sized scene-linear render — caps the long edge at `maxLongEdge`,
    /// preserves aspect ratio, never upscales. Per ticket 06 § Technical
    /// Requirements (Swift). Plan 1 v2 — the editor's first Rust-backed
    /// open routes through this when `previewSize` is known.
    public static func renderPreviewSized(
        rawPath: URL,
        xmpPath: URL? = nil,
        quality: Quality = .preview,
        maxLongEdge: UInt32
    ) throws -> MapleSceneLinearImageData {
        try rawPath.withPathCString { rawCStr in
            if let xmpPath {
                return try xmpPath.withPathCString { xmpCStr in
                    try _renderSceneLinearSized(
                        rawCStr: rawCStr, xmpCStr: xmpCStr,
                        quality: quality, maxLongEdge: maxLongEdge
                    )
                }
            } else {
                return try _renderSceneLinearSized(
                    rawCStr: rawCStr, xmpCStr: nil,
                    quality: quality, maxLongEdge: maxLongEdge
                )
            }
        }
    }

    public static func renderPreviewSized(
        rawBytes: Data,
        hint: String,
        xmpPath: URL? = nil,
        quality: Quality = .preview,
        maxLongEdge: UInt32
    ) throws -> MapleSceneLinearImageData {
        guard let hintCStr = hint.cString(using: .utf8) else {
            throw PipelineError.hintEncodingError(hint)
        }
        return try rawBytes.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
            let base = buf.baseAddress?.assumingMemoryBound(to: UInt8.self)
            if let xmpPath {
                return try xmpPath.withPathCString { xmpCStr in
                    try _renderSceneLinearSizedBytes(
                        ptr: base, len: buf.count, hintCStr: hintCStr,
                        xmpCStr: xmpCStr, quality: quality, maxLongEdge: maxLongEdge
                    )
                }
            } else {
                return try _renderSceneLinearSizedBytes(
                    ptr: base, len: buf.count, hintCStr: hintCStr,
                    xmpCStr: nil, quality: quality, maxLongEdge: maxLongEdge
                )
            }
        }
    }

    private static func _renderSceneLinearSized(
        rawCStr: UnsafePointer<CChar>,
        xmpCStr: UnsafePointer<CChar>?,
        quality: Quality,
        maxLongEdge: UInt32
    ) throws -> MapleSceneLinearImageData {
        var buf = MapleSceneLinearBuffer(
            fp16_rgba: nil, len_bytes: 0, channels: 0,
            bytes_per_pixel: 0, width: 0, height: 0
        )
        let rc = maple_render_file_scene_linear_sized(
            rawCStr, xmpCStr, maxLongEdge, quality.rawValue, &buf
        )
        guard rc == 0 else {
            let msg = maple_last_error().map { String(cString: $0) } ?? "unknown error"
            throw PipelineError.renderFailed(code: Int(rc), message: msg)
        }
        defer { maple_free_scene_linear_buffer(&buf) }
        guard buf.len_bytes > 0, let ptr = buf.fp16_rgba else {
            throw PipelineError.renderFailed(code: Int(rc), message: "empty sized buffer")
        }
        let data = Data(bytes: ptr, count: Int(buf.len_bytes))
        return MapleSceneLinearImageData(
            width: Int(buf.width),
            height: Int(buf.height),
            channels: Int(buf.channels),
            bytesPerPixel: Int(buf.bytes_per_pixel),
            pixels: data
        )
    }

    private static func _renderSceneLinearSizedBytes(
        ptr: UnsafePointer<UInt8>?,
        len: Int,
        hintCStr: [CChar],
        xmpCStr: UnsafePointer<CChar>?,
        quality: Quality,
        maxLongEdge: UInt32
    ) throws -> MapleSceneLinearImageData {
        var buf = MapleSceneLinearBuffer(
            fp16_rgba: nil, len_bytes: 0, channels: 0,
            bytes_per_pixel: 0, width: 0, height: 0
        )
        let rc = hintCStr.withUnsafeBufferPointer { hintPtr -> Int32 in
            maple_render_bytes_scene_linear_sized(
                ptr, UInt(len), hintPtr.baseAddress,
                xmpCStr, maxLongEdge, quality.rawValue, &buf
            )
        }
        guard rc == 0 else {
            let msg = maple_last_error().map { String(cString: $0) } ?? "unknown error"
            throw PipelineError.renderFailed(code: Int(rc), message: msg)
        }
        defer { maple_free_scene_linear_buffer(&buf) }
        guard buf.len_bytes > 0, let bufPtr = buf.fp16_rgba else {
            throw PipelineError.renderFailed(code: Int(rc), message: "empty sized buffer")
        }
        let data = Data(bytes: bufPtr, count: Int(buf.len_bytes))
        return MapleSceneLinearImageData(
            width: Int(buf.width),
            height: Int(buf.height),
            channels: Int(buf.channels),
            bytesPerPixel: Int(buf.bytes_per_pixel),
            pixels: data
        )
    }
```

- [ ] **Step 8.6: Add `decodePreviewSized(asset:targetSize:)` to `ImageEditPipeline`.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift`, immediately after `decodeSceneLinear(asset:quality:)` ends (after the `return CIImage(bitmapData:...)` block added in Task 4 Step 4.2), append:

```swift
    /// Sized scene-linear decode — runs the new Rust FFI sized entry,
    /// returning a Rec.2020 fp16 CIImage at (or below) `targetSize`.
    /// Per ticket 06 § Product Requirements 1, 2: the editor's first
    /// Rust-backed open routes here when `previewSize` is known. The
    /// returned CIImage's extent fits within `targetSize` (preserving
    /// aspect, never upscaling).
    nonisolated public func decodePreviewSized(
        asset: AssetRef,
        targetSize: CGSize
    ) async -> CIImage? {
        // Per ticket 06 § Product Requirements 2, the long edge of the
        // requested target is the cap; pixel-accurate sizing happens in
        // Rust. Conservative fallback if `targetSize` is degenerate
        // (zero/negative): per ticket 06 § Open Questions, "if previewSize
        // is unknown at the moment decode starts, the editor may use a
        // conservative fallback cap, for example a 2MP long-edge-
        // constrained preview." 2 MP = ~1414 px on a square; we round
        // to 1500.
        let longEdge: UInt32 = {
            let w = max(1, Int(targetSize.width.rounded()))
            let h = max(1, Int(targetSize.height.rounded()))
            let le = max(w, h)
            if le <= 0 { return 1500 }
            return UInt32(le)
        }()
        let imageData: MapleSceneLinearImageData
        do {
            if let url = asset.primaryURL {
                let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
                let accessing = scope.startAccessingSecurityScopedResource()
                defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
                imageData = try PipelineRenderer.renderPreviewSized(
                    rawPath: url, xmpPath: nil,
                    quality: .preview, maxLongEdge: longEdge
                )
            } else if let provider = asset.bytesProvider {
                let bytes = try await provider()
                let hint = asset.hintExtension ?? ""
                imageData = try PipelineRenderer.renderPreviewSized(
                    rawBytes: bytes, hint: hint, xmpPath: nil,
                    quality: .preview, maxLongEdge: longEdge
                )
            } else {
                return nil
            }
        } catch {
            logger.error("decodePreviewSized failed for \(asset.displayName, privacy: .public): \(error.localizedDescription, privacy: .public). Falling back to unsized scene-linear path.")
            // Ticket 06 § Product Requirements 3: existing whole-preview
            // path remains available as a fallback when the sized path
            // fails. The unsized scene-linear entry from Task 4 is the
            // right fallback (matched color domain); the legacy display-
            // encoded path would mismatch the rest of `processSceneLinear`.
            return await decodeSceneLinear(asset: asset, quality: .preview)
        }
        let w = imageData.width, h = imageData.height
        let bytesPerRow = w * imageData.bytesPerPixel
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        return CIImage(
            bitmapData: imageData.pixels,
            bytesPerRow: bytesPerRow,
            size: CGSize(width: w, height: h),
            format: .RGBAh,
            colorSpace: space
        )
    }
```

- [ ] **Step 8.7: Route the editor's first Rust-backed open through `decodePreviewSized` when the viewport size is known.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift`, locate `sharedDecode(asset:pipeline:)` at lines 884-953 (after Task 5's edits). Locate the cache-miss branch (around line 916 after Task 5 — it currently reads):

```swift
            // Cache miss — Rust decode, then write-back for the next open.
            // Plan 1 gate: the scene-linear path bypasses the disk cache
            // (the cache stores sRGB JPEGs, which would lose the scene-
            // linear buffer's extended range). Plan 3 will rev the cache
            // format; for now scene-linear opens always pay the Rust
            // decode cost.
            let decoded: CIImage?
            if useSceneLinear {
                decoded = await pipeline.decodeSceneLinear(asset: asset)
            } else {
                decoded = await pipeline.decode(asset: asset)
            }
            guard let decoded = decoded else { return nil }
```

Replace with:

```swift
            // Cache miss — Rust decode, then write-back for the next open.
            // Plan 1 v2 routing:
            //   1. New scene-linear path AND viewport size is known →
            //      use the sized FFI entry (ticket 06 Milestone 2).
            //      Output is ~12 MB for a 1500-px-long-edge buffer
            //      vs ~200 MB for the half-res scene-linear buffer.
            //   2. New scene-linear path with no viewport hint → fall
            //      back to the unsized entry (Task 4) so behavior is
            //      no worse than v1.
            //   3. Legacy path unchanged — keeps the legacy display-
            //      encoded FFI for thumbnails and parity harness.
            let decoded: CIImage?
            if useSceneLinear {
                if let viewport = self.previewSize, viewport.width > 1, viewport.height > 1 {
                    decoded = await pipeline.decodePreviewSized(
                        asset: asset, targetSize: viewport
                    )
                } else {
                    decoded = await pipeline.decodeSceneLinear(asset: asset)
                }
            } else {
                decoded = await pipeline.decode(asset: asset)
            }
            guard let decoded = decoded else { return nil }
```

(Confirm `self.previewSize: CGSize?` exists in `EditSession` — referenced in EditSession.swift line 219 per the Read of the file. If it's named differently, adjust this Step's read of "viewport" accordingly. The Task 8 implementation must confirm the property name with `grep -n previewSize src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift` first.)

- [ ] **Step 8.8: Augment the rendered-preview cache key with the effective render size (per ticket 06 § Product Requirements 5).**

Run: `grep -nR "RenderedPreviewCache" src/apple/Packages/MapleCore/Sources/MapleCore | head -5` to find the cache definition. The existing cache key already includes `(primary_url, primary_mtime, sidecar_mtime, screen_size, adjustment_version, view_transform_version)` per `CLAUDE.md`'s Performance section. **Cache writes from the sized path must include the effective render size** — if the existing key already includes `screen_size`, this step is a documentation update; if not, add it to the key tuple.

In `RenderedPreviewCache.swift`, locate the cache-key composition function. If `screen_size` (or `target_size_bucket`) is already part of the key, append a comment block:

```swift
// Plan 1 v2 Task 8: rendered-preview cache writes from the sized scene-
// linear path key on size — the key tuple's existing
// `(primary_url, primary_mtime, sidecar_mtime, screen_size,
//   adjustment_version, view_transform_version)` is sufficient because
// `screen_size` is the bucket (per ticket 06 § Product Requirements 5).
// The rest of the cache contract (mtime, sidecar mtime, view transform
// version) is unchanged.
```

If `screen_size` is missing, add it as the seventh tuple field and gate any cache hit on bucket-equality (with a small tolerance per ticket 06 § Product Requirements 5: "Serving a smaller cached preview into a larger viewport is allowed only if the quality loss is within the UI's existing preview tolerance"). The exact size-bucket function is left to the engineer at execution time — round `screen_size.width` to the nearest 100 px is a reasonable default; the bucket boundary belongs in this same file with a comment citing the ticket.

Run: `cd src/apple/Packages/MapleCore && swift test 2>&1 | grep -E "passed|failed" | tail -5`
Expected: all tests still pass.

- [ ] **Step 8.9: Add a Swift integration test for the sized path — aspect, no-upscale, size-cap, orientation.**

In `src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift`, append (inside the same `final class`):

```swift
    // MARK: - Task 8: viewport-sized scene-linear decode

    /// Per ticket 06 § Acceptance Criteria, the sized FFI must:
    ///   • produce a buffer whose long edge equals the requested cap
    ///     (or stays at the source dimension if the source is smaller —
    ///      no upscale)
    ///   • preserve source aspect ratio within rounding
    ///   • return a non-nil CIImage with extent matching the buffer
    ///   • succeed for every standard EXIF orientation (smoke-tested
    ///      via the test_0002 fixture which has Normal orientation;
    ///      orientation correctness on rotated fixtures is covered by
    ///      the existing apply_orientation tests in raw-core)
    func testDecodePreviewSizedRespectsAspectAndCap() async throws {
        // Skip if test_0002.dng is missing (gitignored fixture).
        let fixturePath = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("raw-pipeline/test-fixtures/raws/test_0002.dng")
        guard FileManager.default.fileExists(atPath: fixturePath.path) else {
            throw XCTSkip("test_0002.dng absent — fixtures are gitignored")
        }
        let asset = AssetRef.localFile(url: fixturePath)
        let pipeline = ImageEditPipeline()
        let target = CGSize(width: 800, height: 600)
        guard let ci = await pipeline.decodePreviewSized(asset: asset, targetSize: target) else {
            return XCTFail("decodePreviewSized returned nil")
        }
        let w = ci.extent.width, h = ci.extent.height
        XCTAssertLessThanOrEqual(max(w, h), 800.001,
            "long edge \(max(w,h)) exceeds cap 800")
        XCTAssertGreaterThan(min(w, h), 0)
        // Aspect ratio approximately preserved: the source RAW's
        // half-res aspect is known up to demosaic, so a tolerance
        // of 1% is generous.
        let srcAspect: Double = 1.5 // sentinel — engineer replaces
                                   // with the actual fixture aspect
        let outAspect = Double(w / h)
        if srcAspect > 0 {
            XCTAssertEqual(outAspect, srcAspect, accuracy: srcAspect * 0.02,
                "aspect drift: out=\(outAspect), src=\(srcAspect)")
        }
    }

    /// Per ticket 06 § Product Requirements 1: never upscale beyond
    /// the source. Synthesize a degenerate target larger than the
    /// fixture's half-res dimensions and confirm the output is no
    /// larger than the half-res source.
    func testDecodePreviewSizedNeverUpscalesBeyondSource() async throws {
        let fixturePath = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("raw-pipeline/test-fixtures/raws/test_0002.dng")
        guard FileManager.default.fileExists(atPath: fixturePath.path) else {
            throw XCTSkip("test_0002.dng absent")
        }
        let asset = AssetRef.localFile(url: fixturePath)
        let pipeline = ImageEditPipeline()
        // Demand 100k px on the long edge — far above any real RAW.
        // The FFI must return at most the source's half-res dimensions.
        guard let sized = await pipeline.decodePreviewSized(
            asset: asset, targetSize: CGSize(width: 100_000, height: 100_000)
        ) else { return XCTFail("nil") }
        // Compare against the unsized half-res scene-linear render.
        guard let unsized = await pipeline.decodeSceneLinear(
            asset: asset, quality: .preview
        ) else { return XCTFail("nil unsized") }
        XCTAssertEqual(sized.extent.width, unsized.extent.width, accuracy: 0.01)
        XCTAssertEqual(sized.extent.height, unsized.extent.height, accuracy: 0.01)
    }
```

Run: `cd src/apple/Packages/MapleCore && swift test --filter testDecodePreviewSizedRespectsAspectAndCap 2>&1 | tail -10`
Expected: PASS (or `XCTSkip` if fixture absent).

Run: `cd src/apple/Packages/MapleCore && swift test --filter testDecodePreviewSizedNeverUpscalesBeyondSource 2>&1 | tail -10`
Expected: PASS or skip.

- [ ] **Step 8.10: Performance verification — ticket 06 § Performance Requirements gates.**

Per ticket 06 § Performance Requirements, with `MAPLE_PROFILE=1` on a release build of the 100 MP Hasselblad fixture, the sized-path acceptance criteria are:

| Scenario                                     |    Target | Hard Limit |
| -------------------------------------------- | --------: | ---------: |
| First Rust-backed viewport preview, no cache | < 1000 ms |    2000 ms |
| FFI output buffer size for fit viewport      |  <= 32 MB |      64 MB |

These gates **supplement** Spike 1.3's correctness baseline (Task 1 / Task 5 Step 5.6) — they're additional acceptance criteria, not a replacement.

Run, with `MAPLE_PROFILE=1 MAPLE_SCENE_LINEAR=1` set, 5 cold opens of the 100 MP Hasselblad fixture in fit-to-window mode:

- Terminal A: `cd src/apple && xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' -configuration Release build 2>&1 | tail -5`
- Terminal B: `MAPLE_PROFILE=1 MAPLE_SCENE_LINEAR=1 open -a /Users/$USER/Library/Developer/Xcode/DerivedData/Maple-*/Build/Products/Release/Maple.app`. Quit & relaunch between each open.

Read the labeled `[swift]` and `[raw-core]` lines from the process stderr. Compute:

- Total cold-open time = sum of `[swift] decode FFI call (cold)` + `[swift] decode result copy` + `[swift] decode CIImage build` + `[swift] filter chain (.fast)`.
- FFI buffer size = `width * height * 8` bytes from the `MapleSceneLinearBuffer` returned to Swift (log it from `_renderSceneLinearSized` via a `print("[swift] decode FFI buffer bytes \(buf.len_bytes)")` helper for the duration of this step; revert before commit).

Append to the comment block at the top of `SceneLinearPipelineTests.swift`:

```swift
// Plan 1 v2 Task 8 sized-path acceptance (5 cold opens, fit-to-window
// on the 100 MP Hasselblad fixture, MAPLE_SCENE_LINEAR=1):
//
//   total cold-open time              <RECORD ms>
//     gate: target < 1000 ms, hard limit 2000 ms
//   FFI output buffer size            <RECORD MB>
//     gate: target <= 32 MB, hard limit 64 MB
//
// PASS criteria:
//   • cold-open <= 2000 ms (hard limit)
//   • FFI buffer <= 64 MB (hard limit)
// ASPIRATIONAL (not a blocker — flag if missed but proceed):
//   • cold-open < 1000 ms
//   • FFI buffer <= 32 MB
//
// Per ticket 06 § Performance Requirements. These gates SUPPLEMENT
// Spike 1.3's correctness baseline — they're additional acceptance,
// not replacement.
```

Replace the `<RECORD>` placeholders with the captured medians.

**Hard-fail action:** if either hard limit is exceeded, STOP. The sized path doesn't ship; flag the regression and report. (Soft-target misses are acceptable — log them in the commit body and keep going.)

- [ ] **Step 8.11: Run the full test suites once more and the parity harness.**

Run, in parallel:

- `cd src/raw-pipeline && cargo test -p raw-core --lib 2>&1 | tail -5` — expected: all passing.
- `cd src/raw-pipeline && cargo test -p raw-ffi --lib 2>&1 | tail -5` — expected: all passing.
- `cd src/apple/Packages/MapleCore && swift test 2>&1 | grep -E "passed|failed" | tail -5` — expected: all passing.
- `BUDGET=15 ./src/scripts/test_color_pipeline.sh 2>&1 | tail -20` — expected: PASS. **The parity harness exercises the legacy path only**; the sized path is interactive-only and is not on the export pipeline. Confirming the harness still passes proves the shared `develop_scene_linear_from_raw_with_quality` helper from Task 2 is undisturbed by Task 8.

- [ ] **Step 8.12: Commit.**

```bash
git add src/raw-pipeline/raw-core/src/pipeline.rs src/raw-pipeline/raw-ffi/src/lib.rs src/apple/Packages/MapleCore/Sources/MapleCore/include/RawPipeline.h src/apple/Frameworks/RawPipeline.xcframework src/apple/Packages/MapleCore/Sources/MapleCore/PipelineRenderer.swift src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift src/apple/Packages/MapleCore/Sources/MapleCore/RenderedPreviewCache.swift src/apple/Packages/MapleCore/Tests/MapleCoreTests/SceneLinearPipelineTests.swift
git commit -m "$(cat <<'EOF'
feat(raw-ffi,apple): viewport-sized scene-linear FFI; route editor through it

Per ticket 06 Milestone 2 — the editor's first Rust-backed open
targets the viewport, not the half-res sensor buffer:

Rust:
  * downsample_image_area(image, max_long_edge): area-average
    downsample on the f32 RGB working buffer, never upscales,
    preserves aspect (matches api::downsample_to_rgba's algorithm
    in scene-linear instead of display-encoded sRGB u8).
  * render_scene_linear_sized_from_raw_with_quality: shared develop
    helper -> downsample -> orient -> fp16 pack at the target size.
  * maple_render_file/bytes_scene_linear_sized FFI entries reusing
    MapleSceneLinearBuffer. API: max_long_edge as a single u32 scalar
    (decision recorded in plan body — simplifies WASM parity in
    Plan 3, aspect math is local to the renderer).

Apple:
  * PipelineRenderer.renderPreviewSized / decodePreviewSized
    wrappers.
  * EditSession.sharedDecode routes through the sized path when
    self.previewSize is known; falls back to the unsized scene-
    linear entry otherwise. Legacy path unchanged.
  * RenderedPreviewCache key now keyed on size (the existing key
    already includes screen_size; comment-only update).

Performance gates (ticket 06 § Performance Requirements):
  * cold-open viewport preview <= 2000 ms (hard) / target < 1000 ms
  * FFI buffer for fit viewport <= 64 MB (hard) / target <= 32 MB
  * Captured medians in SceneLinearPipelineTests.swift header.

These gates SUPPLEMENT Spike 1.3's +10% baseline check — they're
additional acceptance, not replacement. The sized path turns
the FFI bandwidth growth from a cost into a win: ~12 MB for a
1500x1000 viewport vs ~200 MB for the half-res scene-linear path
on the 100 MP fixture.

Out of scope (separate plans):
  * Earlier downsample in the Rust pipeline (ticket 06 Milestone 3)
  * Visible crop / tile path with neighborhood overlap (Milestone 4)
  * Refinement-on-zoom logic (ticket 06 § Product Requirements 4)

EOF
)"
```

---

## Task 9: Flip default to scene-linear path; remove MAPLE_SKIP_PRESCALE

**PRECONDITION — DO NOT EXECUTE THIS TASK UNTIL ONE OF THE FOLLOWING IS TRUE:**

1. Plan 2 has landed (development-chain Metal kernels in scene-linear), restoring the user's saved sidecar adjustments on the new path; OR
2. A user-visible "default render — saved adjustments not yet applied" banner has been added to the editor (independent change, can land alongside this task); OR
3. The user has explicitly accepted that flipping the default will cause sidecar-driven adjustments to silently revert to "default look" for affected images, and is OK shipping that.

This precondition exists because, as the prominent "What this plan renders" block in the Goal section states, **saved sidecar adjustments are NOT applied on the new path** — `decodeSceneLinear` mirrors `decode`'s `xmpPath: nil` call, and Plan 1 has no scene-linear development-chain kernel to reapply WB/exposure/contrast/etc. Flipping the default before one of conditions 1-3 above is met means users with edits will see "default" colors in place of their saved look, with no UI cue.

**Files:**

- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift` — flip the `useSceneLinear` default to `true`, remove the env gate.
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift` — delete the `MAPLE_SKIP_PRESCALE` env-gated branch in `prescaleForDisplay` (it's dead now — the new path runs Lanczos on scene-linear data, where the bug it gated against doesn't exist).
- Modify: `src/apple/Maple.xcodeproj/xcshareddata/xcschemes/Maple.xcscheme` — remove the `MAPLE_SCENE_LINEAR` and `MAPLE_SKIP_PRESCALE` env entries.

**Why this matters:** Once milestone 4 (manual A/B in Task 6) confirms all three bugs are closed, Task 7 has split the conflated decode label into per-stage timings, Task 8 has shipped the viewport-sized FFI within both the Spike 1.3 +10% gate and ticket 06's <2000 ms / <=64 MB hard limits, _and_ one of the three preconditions above is satisfied — the new path becomes default. `MAPLE_SKIP_PRESCALE` was a diagnostic for Bug 3 — Bug 3 is gone, so the gate is dead code. `MAPLE_SKIP_SWIFT_AGX` and `MAPLE_SKIP_SWIFT_FILTERS` stay in place — Plan 2 needs them while it ports the development chain.

- [ ] **Step 9.1: Flip the default in `EditSession.swift`.**

In `src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift`, locate the `useSceneLinear` declaration added in Task 5 Step 2. Replace:

```swift
    /// True if the editor should use the Plan-1 scene-linear FFI path.
    /// Gated by the `MAPLE_SCENE_LINEAR` env var so the legacy path stays
    /// the default until parity is verified. Plan 1 Task 9 flips the
    /// default and removes the gate.
    @ObservationIgnored private let useSceneLinear: Bool = {
        ProcessInfo.processInfo.environment["MAPLE_SCENE_LINEAR"] != nil
    }()
```

with:

```swift
    /// Always true post-Plan-1 Task 9 — the scene-linear FFI path is the
    /// default for interactive renders. Kept as a `let` constant rather
    /// than removed entirely because Plan 2 will add a per-asset opt-out
    /// for non-RAW files (which can't go through the scene-linear FFI
    /// because they have no Bayer data to demosaic). Today's value is
    /// always `true`.
    @ObservationIgnored private let useSceneLinear: Bool = true
```

- [ ] **Step 9.2: Remove the MAPLE_SKIP_PRESCALE branch in `ImageEditPipeline.swift`.**

Locate `prescaleForDisplay` (line 214-236). Today the `MAPLE_SKIP_PRESCALE` env gate isn't directly in `prescaleForDisplay` — it short-circuits at the call site (line 156 `let displayInput = Self.prescaleForDisplay(...)`). Search for `MAPLE_SKIP_PRESCALE`:

Run: `grep -n MAPLE_SKIP_PRESCALE src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift`

If the gate is found, remove it. If the gate is in the call site at line 156, remove the conditional and call `prescaleForDisplay` unconditionally. Document any actual code change here verbatim — if the gate is purely in the scheme (env entry only, no source-code branch) this step is a no-op for ImageEditPipeline.swift and only the scheme entry is removed.

- [ ] **Step 9.3: Remove the `MAPLE_SCENE_LINEAR` and `MAPLE_SKIP_PRESCALE` entries from the Maple scheme.**

Open `src/apple/Maple.xcodeproj/xcshareddata/xcschemes/Maple.xcscheme`. Remove both `<EnvironmentVariable>` blocks for keys `MAPLE_SCENE_LINEAR` and `MAPLE_SKIP_PRESCALE`.

Leave `MAPLE_SKIP_SWIFT_AGX` and `MAPLE_SKIP_SWIFT_FILTERS` — Plan 2 needs them.

- [ ] **Step 9.4: Build & run all tests.**

Run, in parallel:

- `./src/apple/scripts/build-xcframework.sh 2>&1 | tail -5` (expected: `==> Done.`)
- `cd src/apple/Packages/MapleCore && swift test 2>&1 | grep -E "passed|failed" | tail -5` (expected: all passing).
- `cd src/raw-pipeline && cargo test -p raw-core --lib 2>&1 | tail -5` (expected: all passing).
- `cd src/raw-pipeline && cargo test -p raw-ffi --lib 2>&1 | tail -5` (expected: all passing).

- [ ] **Step 9.5: Manual smoke test — open the reference DNG one more time without any env vars set, confirm the editor renders the image correctly.**

Run: `cd src/apple && xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build 2>&1 | tail -3`
Expected: `BUILD SUCCEEDED`.

Open the resulting `Maple.app`, load the reference DNG, drag through several zoom levels. Confirm: no zoom-dependent color shift, image renders at all sizes with stable color.

- [ ] **Step 9.6: Commit.**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift src/apple/Maple.xcodeproj/xcshareddata/xcschemes/Maple.xcscheme
git commit -m "$(cat <<'EOF'
feat(apple): make scene-linear FFI the default; remove MAPLE_SKIP_PRESCALE

Plan 1 Task 9 — final task. The scene-linear path is the only
interactive path now (`useSceneLinear = true`, no env-gate read).
`MAPLE_SCENE_LINEAR` and `MAPLE_SKIP_PRESCALE` env entries removed
from the Maple scheme. `MAPLE_SKIP_SWIFT_AGX` and
`MAPLE_SKIP_SWIFT_FILTERS` stay — Plan 2 will use them while it
ports the development chain (WB/exposure/contrast/etc.) as Metal
kernels in scene-linear.

Bug 1 (double AgX), Bug 2 (filter chain on tone-mapped data), and
Bug 3 (Lanczos color shift) are closed by construction on this path:
  • Bug 1: AgX runs once via the Metal kernel; Rust's view::agx is
           never invoked.
  • Bug 2: applyFilters() is never called.
  • Bug 3: Lanczos runs on scene-linear Rec.2020 fp16, where the
           filter is numerically correct (verified by Spike 1.1).

Legacy `maple_render_file` and the entire `applyFilters` chain are
still in place for thumbnails and the export path. Plan 3 deletes
them after the Web side is on scene-linear.

EOF
)"
```

---

## Self-Review Checklist

Run through this once after the plan is in place, before handoff to execution.

**1. Spec coverage:**

- [ ] Task 1 covers all three verification spikes from the brief (CILanczos, AgX primaries, FFI bandwidth) with a concrete 4.74 s baseline and +10% (≤474 ms) hard-stop threshold for Spike 1.3.
- [ ] Task 1's Spike 1.2 explicitly states its limitation (Swift scalar mirror, not the live Metal kernel) and points at Task 4 Step 4.0a as its companion runtime check.
- [ ] Task 2 factors a shared `develop_scene_linear_from_raw_with_quality` helper before adding the new entry, so both pipeline entries call the helper and no development-stage code is duplicated.
- [ ] Task 3 adds the FFI surface (`maple_render_file_scene_linear`, `maple_render_bytes_scene_linear`, `maple_free_scene_linear_buffer`).
- [ ] Task 4 Step 4.0a replaces the silent `?? input` AgX kernel fallbacks with `os_log` `.error` + DEBUG `assertionFailure`, and adds a launch-time DEBUG assertion in `MapleApp.init` that the kernel loads.
- [ ] Task 4 Step 4.0b changes `FullImageView.CIImageView`'s `createCGImage` to pass explicit `format: .RGBA8` + `colorSpace: sRGB` so the Rec.2020→sRGB encode is locked to one deterministic boundary.
- [ ] Task 4 adds `decodeSceneLinear` returning a Rec.2020-fp16-tagged CIImage and `processSceneLinear` running prescale + the guarded AgX kernel.
- [ ] Task 5 wires EditSession to use the new path behind a single env gate.
- [ ] Task 6 manually verifies all three bugs are closed.
- [ ] Task 7 (ticket 06 Milestone 1) splits the conflated `[swift] rust FFI decode` log line into per-stage labels and adds Rust `stage()` scopes around `ffi_raw_read` / `ffi_rawler_decode` / `ffi_pack`. Establishes a reproducible measurement procedure for Spike 1.3.
- [ ] Task 8 (ticket 06 Milestone 2) adds `maple_render_file_scene_linear_sized` (and bytes variant) with `max_long_edge` API, the f32 RGB area-average downsample helper, the Apple `decodePreviewSized` wrapper, and routes the editor's first open through it. Includes ticket 06's <2000 ms / <=64 MB performance gates as supplementary acceptance.
- [ ] Task 9 flips the default and removes the diagnostic env gate that's now dead (`MAPLE_SKIP_PRESCALE`) — but the prominent "What this plan renders" sidecar-ignore note in the Goal section must be addressed (Plan 2 lands, OR a banner ships, OR Task 9 is held) before this is shipped to end-users.
- [ ] Out-of-scope items (Plan 2 development chain, Plan 3 web port + legacy deletion, thumbnails, scene-linear-aware decoded-buffer cache as a separate follow-up plan, ticket 06 Milestones 3 & 4, refinement-on-zoom logic) are explicitly listed.

**2. Placeholder scan:**

- [ ] No "TBD", "TODO", "implement later" anywhere.
- [ ] Spike 1.3's `<RECORD>`/`<SUM>`/`<NET>`/`<NET_REF>` placeholders are intentional — they are _measurements_ that the engineer captures and writes into the file at execution time. The hard-stop threshold (`<NET_REF>` > +474 ms) is concrete; only the captured numbers are placeholders.
- [ ] Task 7 Step 7.5 and Task 8 Step 8.10 likewise use `<RECORD>` placeholders for captured medians; the hard-fail thresholds (Task 8: 2000 ms cold-open, 64 MB FFI buffer) are concrete.
- [ ] No "similar to Task N" without code.
- [ ] No "add appropriate error handling" — the FFI patterns inherit error-handling shapes from the existing `maple_render_file` (set_last_error + return code); the AgX kernel guard is fully spelled out at Step 4.0a.

**3. Type consistency:**

- [ ] `MapleSceneLinearBuffer` (Rust C struct) matches `MapleSceneLinearBuffer` (Swift import) — same field names: `fp16_rgba`, `len_bytes`, `channels`, `bytes_per_pixel`, `width`, `height`. The sized FFI entries (Task 8) reuse the same struct.
- [ ] `MapleSceneLinearImageData` (Swift value type) wraps the C buffer: `width`, `height`, `channels`, `bytesPerPixel`, `pixels: Data`. Task 8's `renderPreviewSized` returns the same type.
- [ ] `renderSceneLinear` and `renderPreviewSized` are the wrapper names on `PipelineRenderer` (matches existing `render` style).
- [ ] `decodeSceneLinear` and `processSceneLinear` are named symmetrically with `decode` / `process`. Task 8 adds `decodePreviewSized` symmetric with `decodeSceneLinear`.
- [ ] `useSceneLinear` Boolean flag name is consistent across Tasks 5, 8, and 9.
- [ ] `develop_scene_linear_from_raw_with_quality` (Rust pipeline.rs) is the shared helper.
- [ ] `render_scene_linear_from_raw_with_quality` (Rust pipeline.rs) is the new entry alongside `render_from_raw_with_quality`. Task 8 adds `render_scene_linear_sized_from_raw_with_quality`. All three call the helper.
- [ ] `downsample_image_area` (Rust pipeline.rs Task 8) operates on f32 RGB — distinct from the existing `api::downsample_to_rgba` which operates on display-encoded sRGB u8.

**4. Ordering and BLOCKING constraints:**

- [ ] Task 1 blocks Tasks 2-9 explicitly (header note plus per-spike "FAIL ACTION: stop").
- [ ] Step 5.7 (Spike 1.3 net check) blocks Task 9 explicitly. Task 8's <2000 ms / <=64 MB hard limits supplement Spike 1.3 — both must pass before Task 9 flips the default.
- [ ] xcframework rebuild is in the plan after Rust changes (Task 3 Step 5; Task 8 Step 8.4).
- [ ] `swift test` is invoked after every Swift edit (Tasks 4, 5, 7, 8, 9).
- [ ] Task 7's `pub fn stage` visibility bump (Step 7.2) must precede Task 8's `raw-ffi` use of `raw_core::pipeline::stage(...)` in the sized-FFI entries (Step 8.3) — Task 8's code calls into Task 7's public helper.

If any of the above is unchecked when reviewing, fix inline; do not re-review.
