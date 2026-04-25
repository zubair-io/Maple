// ImageEditPipeline.swift — scene-linear pipeline (spec § 02).
//
// Pipeline order (matches Rust `pipeline.rs:120-132`):
//   1. RAW decode → Rust scene-linear FFI (Rec.2020 fp16)
//   2. WhiteBalance kernel (live - decoded delta)
//   3. SceneToneControls (exposure / highlights / shadows / whites / blacks)
//   4. SceneVibrance (Oklab chroma boost with skin protection)
//   5. SceneSaturation (Oklab uniform chroma scale)
//   6. SceneClarity (40-px unsharp mask)
//   7. SceneTexture (3-px unsharp mask)
//   8. SceneDehaze (dark-channel + atmospheric-light + guided filter)
//   9. SceneSharpen (3-iter Richardson-Lucy + edge-aware mix)
//  10. SceneNRLuminance (Oklab roundtrip + blur on L)
//  11. SceneNRColor (Oklab roundtrip + blur on a/b)
//  12. AgX view transform (sole display-domain op)
//  13. sRGB encode at the CIContext.createCGImage boundary
//
// The legacy `applyFilters` / `process` chain that operated on AgX-baked
// sRGB u8 in the wrong working space was deleted in Plan 2 v2 v5 once
// every heavy slider stage shipped on the scene-linear path.

import Foundation
import CoreImage
import Metal
import os

private let logger = Logger(subsystem: "app.justmaple.maple", category: "ImageEditPipeline")

// MARK: - ImageEditPipeline

/// Thread-safe pipeline that converts a RAW asset + AdjustmentModel to a CIImage.
///
/// Two-entry-point design:
///
///   • `decodeSceneLinear(asset:quality:xmpPath:)` (or its sized variant)
///     runs the Rust scene-linear FFI once per asset open and returns a
///     Rec.2020 fp16 CIImage with the asset's sidecar pre-applied at decode
///     time. EditSession caches this result so slider ticks don't re-decode.
///   • `processSceneLinear(decoded:model:targetSize:asShot:decodedAtModel:)`
///     applies the WB → tone → vibrance → saturation → clarity → texture →
///     dehaze → sharpen → NR luma → NR color → AgX chain on top of a
///     pre-decoded scene-linear CIImage. When `targetSize` is provided and
///     smaller than the decoded extent, a `CILanczosScaleTransform` pass
///     fuses in front of the chain so every intermediate runs at display
///     resolution.
public actor ImageEditPipeline {
    /// As-shot white balance derived from the RAW's metadata. Passed into
    /// `process(...)` so `CITemperatureAndTint`'s `neutral` reflects the
    /// camera's metered white point — the slider then behaves as a scene
    /// white-point selector (Lightroom semantics), not a delta from 6500 K.
    public struct AsShotWB: Sendable, Equatable {
        public var temperature: Double
        public var tint: Double
        public init(temperature: Double, tint: Double) {
            self.temperature = temperature
            self.tint = tint
        }
    }

    private let context: CIContext

    public init() {
        // Metal-backed context where available; `cacheIntermediates: false`
        // + fp16 working format keeps memory bounded enough that CoreImage
        // can tile internally on a 100MP input. Mirrors the reference
        // pipeline's settings.
        if let device = MTLCreateSystemDefaultDevice() {
            self.context = CIContext(mtlDevice: device, options: [
                .workingColorSpace: CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!,
                .workingFormat: CIFormat.RGBAh,
                .cacheIntermediates: false,
            ])
        } else {
            self.context = CIContext(options: [
                .workingColorSpace: CGColorSpace(name: CGColorSpace.linearSRGB)!,
                .workingFormat: CIFormat.RGBAh,
                .cacheIntermediates: false,
            ])
        }
    }

    // MARK: Decode (cached path)

    /// Decode the RAW into a neutral CIImage via the Rust FFI. Call once per
    /// asset open; cache the result in `EditSession` so slider ticks skip the
    /// decode entirely.
    ///
    /// `quality` defaults to `.preview` (half-res quad demosaic) — the
    /// interactive editor doesn't need the parity-gated path, and 4× fewer
    /// pixels through 15+ stages turns a 100 MP RAW's cold decode from
    /// minutes into seconds. `MapleExporter` passes `.full` for bake-out.
    ///
    /// Security scope is claimed on the asset URL and its parent folder for
    /// the duration of the FFI call — the Rust decoder mmaps the file and
    /// without an active scope the read fails on sandboxed builds.
    nonisolated public func decode(
        asset: AssetRef,
        quality: PipelineRenderer.Quality = .preview
    ) async -> CIImage? {
        let imageData: MapleImageData
        do {
            if let url = asset.primaryURL {
                // Scope claim MUST be on the bookmark-resolved ancestor URL
                // — `url.deletingLastPathComponent()` is a plain path URL
                // with no scope token and `startAccessing` silently no-ops,
                // so the Rust FFI's `std::fs::read(path)` would hit EPERM
                // under the sandbox. `asset.scopeParentURL` is populated by
                // `FilesystemSource` / `BrowseViewModel.currentScopeRoot`.
                let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
                let accessing = scope.startAccessingSecurityScopedResource()
                defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
                imageData = try PipelineRenderer.render(
                    rawPath: url,
                    xmpPath: nil,
                    quality: quality
                )
            } else if let provider = asset.bytesProvider {
                let bytes = try await provider()
                let hint = asset.hintExtension ?? ""
                imageData = try PipelineRenderer.render(
                    rawBytes: bytes,
                    hint: hint,
                    xmpPath: nil,
                    quality: quality
                )
            } else {
                return nil
            }
        } catch {
            logger.error("decode failed for \(asset.displayName, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return nil
        }
        return ciImage(from: imageData, phase: .refine)
    }

    // MARK: Decode (scene-linear path — Plan 1 FFI split)

    /// Decode the RAW into a Rec.2020 fp16 scene-linear CIImage via the
    /// new Rust FFI. Used by the FFI-split path (Plan 1) — the buffer is
    /// pre-AgX, pre-Rec.2020->sRGB, so callers must apply a view transform
    /// before display. Tagged `extendedLinearITUR_2020` so CoreImage
    /// applies the correct primaries-to-working-space matrix on read.
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
        // Build a CIImage directly from the fp16 RGBA buffer tagged with
        // extendedLinearITUR_2020. `CIImage(bitmapData:bytesPerRow:size:format:colorSpace:)`
        // copies the bytes — `imageData.pixels` can be released after the
        // call returns.
        let w = imageData.width, h = imageData.height
        let bytesPerRow = w * imageData.bytesPerPixel
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        return mapleStage("decode CIImage build") {
            CIImage(
                bitmapData: imageData.pixels,
                bytesPerRow: bytesPerRow,
                size: CGSize(width: w, height: h),
                format: .RGBAh,
                colorSpace: space
            )
        }
    }

    // MARK: Decode (scene-linear sized — Plan 1 v2 viewport-sized FFI)

    /// Sized scene-linear decode — runs the new Rust FFI sized entry,
    /// returning a Rec.2020 fp16 CIImage at (or below) `targetSize`.
    /// Per ticket 06 § Product Requirements 1, 2: the editor's first
    /// Rust-backed open routes here when `previewSize` is known. The
    /// returned CIImage's extent fits within `targetSize` (preserving
    /// aspect, never upscaling).
    nonisolated public func decodeSceneLinearSized(
        asset: AssetRef,
        targetSize: CGSize,
        xmpPath: URL? = nil
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
                imageData = try PipelineRenderer.renderSceneLinearSized(
                    rawPath: url, xmpPath: xmpPath,
                    quality: .preview, maxLongEdge: longEdge
                )
            } else if let provider = asset.bytesProvider {
                let bytes = try await provider()
                let hint = asset.hintExtension ?? ""
                imageData = try PipelineRenderer.renderSceneLinearSized(
                    rawBytes: bytes, hint: hint, xmpPath: xmpPath,
                    quality: .preview, maxLongEdge: longEdge
                )
            } else {
                return nil
            }
        } catch {
            logger.error("decodeSceneLinearSized failed for \(asset.displayName, privacy: .public): \(error.localizedDescription, privacy: .public). Falling back to unsized scene-linear path.")
            // Ticket 06 § Product Requirements 3: existing whole-preview
            // path remains available as a fallback when the sized path
            // fails. The unsized scene-linear entry from Task 4 is the
            // right fallback (matched color domain); the legacy display-
            // encoded path would mismatch the rest of `processSceneLinear`.
            return await decodeSceneLinear(asset: asset, quality: .preview, xmpPath: xmpPath)
        }
        let w = imageData.width, h = imageData.height
        let bytesPerRow = w * imageData.bytesPerPixel
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        return mapleStage("decode CIImage build") {
            CIImage(
                bitmapData: imageData.pixels,
                bytesPerRow: bytesPerRow,
                size: CGSize(width: w, height: h),
                format: .RGBAh,
                colorSpace: space
            )
        }
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
    ///
    /// Plan 2 M3 — `decodedAtModel` is the model the Rust FFI used during
    /// decode (parsed from the sidecar on disk, or `.default` when no
    /// sidecar exists). The WhiteBalance kernel uses it to apply only the
    /// live-vs-decoded WB delta so opening a saved sidecar doesn't
    /// double-apply WB between the Rust path and the Apple kernel.
    nonisolated public func processSceneLinear(
        decoded: CIImage,
        model: AdjustmentModel,
        targetSize: CGSize? = nil,
        asShot: AsShotWB? = nil,
        decodedAtModel: AdjustmentModel? = nil
    ) -> CIImage {
        let scaled = Self.prescaleForDisplay(decoded, targetSize: targetSize)

        // Plan 2 M3 — the WB kernel applies (live / decoded) so opening
        // a saved sidecar doesn't double-apply WB. The Rust path applied
        // sidecar WB at decode; the Apple kernel applies the slider delta
        // on top. When `decodedAtModel` is nil (e.g. legacy callers, no
        // sidecar known), fall back to 6500/0 which matches the Rust
        // default's identity short-circuit.
        let decodedTemp = Float(decodedAtModel?.temperature ?? 6500)
        let decodedTint = Float(decodedAtModel?.tint ?? 0)
        let withWB = MetalKernels.applyWhiteBalance(
            to: scaled,
            liveTemperature: Float(model.temperature),
            liveTint: Float(model.tint),
            decodedTemperature: decodedTemp,
            decodedTint: decodedTint
        )

        // Plan 2 M1 — Stage: SceneToneControls (exposure / highlights /
        // shadows / whites / blacks). Per-pixel scene-linear Rec.2020 op.
        // Kernel mirrors `scene_tone_controls.rs` from raw-core; whites/
        // blacks semantics (`w_gain = 1 + whites/200`, `b_add = blacks/400`)
        // are identical on both sides — verified by Plan 2 pre-flight
        // Step 1.3.
        let withTone = MetalKernels.applySceneToneControls(
            to: withWB,
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

        // Plan 2 M2 — Stage: SceneSaturation (Oklab uniform chroma scale).
        // Mirrors `saturation::apply` from raw-core (saturation.rs:12).
        // Uses the same Oklab matrices as SceneVibrance.metal
        // (intentionally repeated; Metal doesn't share `constant` globals
        // between .metal files).
        let withSaturation = MetalKernels.applySceneSaturation(
            to: withVibrance,
            saturation: Float(model.saturation)
        )

        // Plan 2 v2 M2 — Stage: SceneClarity (unsharp mask at radius 40 in
        // scene-linear Rec.2020 RGB). Mirrors clarity::apply from raw-core
        // (clarity.rs:10). Backed by the shared SeparableGaussianBlur
        // compute kernel (Task 2). The 40-pixel radius is the binding
        // constraint for Deep Zoom's 35-pixel overlap budget — see
        // docs/superpowers/plans/2026-04-25-deep-zoom-tile-rendering.md
        // § Architecture point 2; do not change without re-verifying.
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

        // Plan 2 v2 v4 M5 — Stage: SceneDehaze (dark-channel + atmospheric-
        // light + transmission + guided-filter + reconstruction). Mirrors
        // dehaze::apply from raw-core (dehaze.rs:144-179). Backed by 5
        // pure-Metal compute kernel files (DehazeDarkChannel, Atmospheric-
        // Light, Transmission, Guide, BoxBlur, GuidedFilter) plus 1
        // CIColorKernel (DehazeReconstruct). The 67 px stencil exceeds
        // Deep Zoom's 35 px overlap budget — when this slider is non-
        // zero, the deep-zoom UI clamps maxPixelScale to fit-zoom (see
        // docs/superpowers/plans/2026-04-25-deep-zoom-tile-rendering.md
        // Architecture point 3). This wrapper does NOT change that
        // fallback; it composes whole-image only.
        let withDehaze = MetalKernels.applySceneDehaze(
            to: withTexture,
            dehaze: Float(model.dehaze)
        )

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
            to: withDehaze,
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
        // Sigmoid is inlined as 6-piece polynomial (ticket #08 fix).
        return MetalKernels.applyAgXViewTransform(
            to: withNRColor, contrast: Float(model.contrast)
        )
    }

    // MARK: Render preview (processed CIImage → CGImage)

    /// Materialise a processed CIImage into a CGImage at (at most) the given
    /// target size. Used by the on-demand export path and by diagnostic
    /// tools; the live slider path currently publishes CIImage directly
    /// (see `EditSession.renderedPreview`) and lets SwiftUI's `CIImageView`
    /// handle the final raster.
    ///
    /// Target-size math matches the reference — never upscale, use
    /// Lanczos-style downscale via a lazy transform so the CoreImage render
    /// planner can fuse it with the filter chain and auto-tile.
    nonisolated public func renderPreview(_ ciImage: CIImage, targetSize: CGSize) -> CGImage? {
        let extent = ciImage.extent
        guard extent.width > 0, extent.height > 0 else { return nil }

        let sx = targetSize.width / extent.width
        let sy = targetSize.height / extent.height
        let scale = min(sx, sy, 1.0)

        let scaled: CIImage = scale < 1.0
            ? ciImage.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            : ciImage

        return context.createCGImage(scaled, from: scaled.extent)
    }

    // MARK: Prescale helper (tiling-friendly)

    /// Lanczos-downscale `input` to fit within `targetSize` (aspect
    /// preserved). Never upscales; returns `input` unchanged when the ratio
    /// would be ≥ 0.99. Ported from Maple reference — the CIImage returned
    /// is lazy, so the downscale and the filter chain fuse into a single
    /// render plan and the full-res intermediate never materialises.
    nonisolated private static func prescaleForDisplay(
        _ input: CIImage,
        targetSize: CGSize?
    ) -> CIImage {
        guard let targetSize else { return input }
        let extent = input.extent
        guard extent.width > 0, extent.height > 0 else { return input }
        let sx = targetSize.width / extent.width
        let sy = targetSize.height / extent.height
        let scale = min(sx, sy, 1.0)
        guard scale < 0.99 else { return input }

        let clamped = input.clampedToExtent()
        let lanczos = clamped.applyingFilter("CILanczosScaleTransform", parameters: [
            kCIInputScaleKey: scale,
            kCIInputAspectRatioKey: 1.0,
        ])
        return lanczos.cropped(to: CGRect(
            x: 0, y: 0,
            width: floor(extent.width * scale),
            height: floor(extent.height * scale)
        ))
    }

    // MARK: Private helpers

    nonisolated private func ciImage(from data: MapleImageData, phase: RenderPhase) -> CIImage? {
        guard data.pixels.count == data.width * data.height * 3 else { return nil }
        let w = data.width, h = data.height

        // Build a CIImage from the packed sRGB u8 buffer.
        let bitmapInfo = CGImageAlphaInfo.none.rawValue
        // Copy the pixel bytes so the data provider doesn't outlive `data`.
        let copy = data.pixels
        let dp = CGDataProvider(data: copy as CFData)!

        let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
        let cgImgOpt: CGImage? = mapleStage("decode CIImage build") {
            CGImage(
                width: w, height: h,
                bitsPerComponent: 8, bitsPerPixel: 24,
                bytesPerRow: w * 3,
                space: colorSpace,
                bitmapInfo: CGBitmapInfo(rawValue: bitmapInfo),
                provider: dp,
                decode: nil,
                shouldInterpolate: true,
                intent: .defaultIntent
            )
        }
        guard let cgImg = cgImgOpt else { return nil }

        var ci = CIImage(cgImage: cgImg)

        if phase == .fast {
            // Downscale to ≤ 2MP for fast phase.
            let maxPixels: Int = 2_000_000
            let pixels = w * h
            if pixels > maxPixels {
                let scale = sqrt(Double(maxPixels) / Double(pixels))
                ci = ci.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            }
        }
        return ci
    }

    // MARK: - Tile decode (Plan 3 — Ticket 06 M4)

    /// Decode a single source-pixel tile through the new scene-linear
    /// FFI tile entry. Opens an opaque `MapleRawHandle` per call and
    /// drops it on return — the caller's session-scoped cache (Plan 3
    /// Task 5 `RawImageCache`) reuses handles across tile fetches.
    /// `srcRect` is in pre-orientation source-pixel coords; `outSize`
    /// is the tile output size (must be `<= srcRect` — tile path is
    /// downscale-only).
    ///
    /// Returns a `CIImage` tagged `extendedLinearITUR_2020` (matching
    /// the tagging convention from `decodeSceneLinear`). Returns nil
    /// when the tile path is unavailable for the asset (XMP missing,
    /// dehaze active, or the FFI returns any other error code).
    ///
    /// Caller is expected to feed the returned `CIImage` through the
    /// same view-transform tail as `processSceneLinear` to land on
    /// display.
    nonisolated public func decodePreviewTile(
        asset: AssetRef,
        srcRect: CGRect,
        outSize: CGSize,
        quality: PipelineRenderer.Quality = .full
    ) async -> CIImage? {
        guard srcRect.width > 0, srcRect.height > 0,
              outSize.width > 0, outSize.height > 0 else {
            return nil
        }
        let imageData: MapleSceneLinearImageData
        do {
            if let url = asset.primaryURL {
                let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
                let accessing = scope.startAccessingSecurityScopedResource()
                defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
                let handle = try PipelineRenderer.openRawHandle(rawPath: url, xmpPath: nil)
                imageData = try PipelineRenderer.renderTile(
                    handle: handle,
                    srcX: UInt32(max(0, srcRect.origin.x.rounded())),
                    srcY: UInt32(max(0, srcRect.origin.y.rounded())),
                    srcW: UInt32(max(1, srcRect.size.width.rounded())),
                    srcH: UInt32(max(1, srcRect.size.height.rounded())),
                    outW: UInt32(max(1, outSize.width.rounded())),
                    outH: UInt32(max(1, outSize.height.rounded())),
                    quality: quality
                )
                // `handle` is dropped here — its deinit calls
                // `maple_close_raw_handle`. Plan 3 Task 5 replaces this
                // per-call open with a cache lookup.
            } else if let provider = asset.bytesProvider {
                let bytes = try await provider()
                let hint = asset.hintExtension ?? ""
                let handle = try PipelineRenderer.openRawHandle(
                    rawBytes: bytes, hint: hint, xmpPath: nil
                )
                imageData = try PipelineRenderer.renderTile(
                    handle: handle,
                    srcX: UInt32(max(0, srcRect.origin.x.rounded())),
                    srcY: UInt32(max(0, srcRect.origin.y.rounded())),
                    srcW: UInt32(max(1, srcRect.size.width.rounded())),
                    srcH: UInt32(max(1, srcRect.size.height.rounded())),
                    outW: UInt32(max(1, outSize.width.rounded())),
                    outH: UInt32(max(1, outSize.height.rounded())),
                    quality: quality
                )
            } else {
                return nil
            }
        } catch {
            logger.error("decodePreviewTile failed for \(asset.displayName, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return nil
        }
        let w = imageData.width, h = imageData.height
        let bytesPerRow = w * imageData.bytesPerPixel
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        return mapleStage("decode tile CIImage build") {
            CIImage(
                bitmapData: imageData.pixels,
                bytesPerRow: bytesPerRow,
                size: CGSize(width: w, height: h),
                format: .RGBAh,
                colorSpace: space
            )
        }
    }

}
