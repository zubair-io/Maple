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

private let logger = Logger(subsystem: "app.justmaple.aperture", category: "ImageEditPipeline")

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
    /// Conservative long-edge cap (px) for a fast-phase decode when the
    /// viewport target is unknown or degenerate. Per ticket 06 § Open
    /// Questions: "if previewSize is unknown at the moment decode starts,
    /// the editor may use a conservative fallback cap, for example a 2 MP
    /// long-edge-constrained preview." 2 MP ≈ 1414 px on a square; rounded
    /// to 1500. This is the single source of truth for that fallback so
    /// the sized RAW decode and the fast-phase decode-target fallback (the
    /// `decodeAndRender` nil-target guard, #785) never drift apart.
    nonisolated public static let fastPhaseFallbackLongEdge: Int = 1500

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
        // + f32 working format (#487) keeps memory bounded enough that
        // CoreImage can tile internally on a 100MP input while preserving
        // full scene-buffer precision through the chain. Migrated from
        // fp16 in #487 — see PipelineRenderer.applySceneLinearChain.
        if let device = MTLCreateSystemDefaultDevice() {
            self.context = CIContext(mtlDevice: device, options: [
                .workingColorSpace: CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!,
                .workingFormat: CIFormat.RGBAf,
                .cacheIntermediates: false,
            ])
        } else {
            self.context = CIContext(options: [
                .workingColorSpace: CGColorSpace(name: CGColorSpace.linearSRGB)!,
                .workingFormat: CIFormat.RGBAf,
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
        // Build a CIImage directly from the f32 RGBA buffer (#487) tagged
        // with extendedLinearITUR_2020.
        // `CIImage(bitmapData:bytesPerRow:size:format:colorSpace:)` copies
        // the bytes — `imageData.pixels` can be released after the call
        // returns.
        let w = imageData.width, h = imageData.height
        let bytesPerRow = w * imageData.bytesPerPixel
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        return mapleStage("decode CIImage build") {
            CIImage(
                bitmapData: imageData.pixels,
                bytesPerRow: bytesPerRow,
                size: CGSize(width: w, height: h),
                format: .RGBAf,
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
        // (zero/negative): see `fastPhaseFallbackLongEdge` (the shared
        // 2 MP ≈ 1500 px cap).
        let longEdge: UInt32 = {
            let w = max(1, Int(targetSize.width.rounded()))
            let h = max(1, Int(targetSize.height.rounded()))
            let le = max(w, h)
            if le <= 0 { return UInt32(Self.fastPhaseFallbackLongEdge) }
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
                format: .RGBAf,
                colorSpace: space
            )
        }
    }

    // MARK: Decode (non-RAW path — ImageIO + Core Image)

    /// Decode a non-RAW image (HEIF / HEIC / JPEG / PNG) into a scene-linear
    /// Rec.2020 CIImage that matches the working space of
    /// `processSceneLinear`. Skips the Rust pipeline entirely — non-RAW
    /// images already ship demosaiced sRGB / Display-P3 pixels with an
    /// embedded ICC profile, so rawler::decode would reject them.
    ///
    /// Pipeline:
    ///   1. `CGImageSourceCreateWithURL` / `WithData` reads the file (cheap;
    ///      lazy until the CGImage is drawn).
    ///   2. `CGImageSourceCreateImageAtIndex` materialises a CGImage with
    ///      its embedded ICC profile honoured. ImageIO handles HEIF/HEIC
    ///      natively on macOS 10.13+ / iOS 11+.
    ///   3. `CIImage(cgImage:)` wraps the CGImage; CoreImage promises to
    ///      convert from the source color space to the working space (we
    ///      configure the CIContext for `extendedLinearSRGB` working space,
    ///      so the gamma decode happens here).
    ///   4. We tag the result with `extendedLinearITUR_2020` so the rest of
    ///      `processSceneLinear` (which assumes Rec.2020 fp16 input) sees a
    ///      consistent color space. CoreImage's working-space promotion
    ///      handles the gamut transform.
    ///
    /// Returns `nil` on decode failure or when the asset has neither a URL
    /// nor a bytes provider.
    nonisolated public func decodeSceneLinearNonRaw(
        asset: AssetRef,
        targetSize: CGSize? = nil
    ) async -> CIImage? {
        // Pull bytes (or use the URL directly when available).
        let cgImage: CGImage?
        let sourceColorSpace: CGColorSpace?
        // Downsample at decode for the fast (viewport) phase so the
        // full-resolution bitmap is never allocated — a 40-100MP JPEG's
        // full-res CGImage + CIImage + scene-linear f32 buffer is hundreds
        // of MB before `prescaleForDisplay` runs (×2 for fast+refine),
        // which is the clearest OOM on device (#785). When `targetSize` is
        // nil (refine / export) we keep the full-res decode so the final
        // render quality is unchanged.
        let maxPixelSize: Int? = Self.thumbnailMaxPixelSize(for: targetSize)
        if let url = asset.primaryURL {
            let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
            let accessing = scope.startAccessingSecurityScopedResource()
            defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
            let pair = Self.decodeNonRawCGImage(url: url, maxPixelSize: maxPixelSize)
            cgImage = pair.image
            sourceColorSpace = pair.colorSpace
        } else if let provider = asset.bytesProvider {
            do {
                let bytes = try await provider()
                let pair = Self.decodeNonRawCGImage(data: bytes, maxPixelSize: maxPixelSize)
                cgImage = pair.image
                sourceColorSpace = pair.colorSpace
            } catch {
                logger.error("decodeSceneLinearNonRaw bytesProvider failed for \(asset.displayName, privacy: .public): \(error.localizedDescription, privacy: .public)")
                return nil
            }
        } else {
            return nil
        }
        guard let cgImage else {
            logger.error("decodeSceneLinearNonRaw: ImageIO returned nil for \(asset.displayName, privacy: .public)")
            return nil
        }

        // Build a CIImage from the CGImage. CoreImage will pick up the
        // embedded ICC from the CGImage; passing `colorSpace` overrides
        // it explicitly so callers without a tagged source still land on
        // sRGB-encoded input.
        var options: [CIImageOption: Any] = [:]
        if let cs = sourceColorSpace ?? cgImage.colorSpace {
            options[.colorSpace] = cs
        }
        let raw = mapleStage("decode non-RAW CIImage build") {
            CIImage(cgImage: cgImage, options: options)
        }

        // Tag the working buffer as extendedLinearITUR_2020 so the rest of
        // the scene-linear chain treats it as Rec.2020 fp16. CoreImage
        // promotes the source's gamut+gamma into the working space at
        // render time — we just need the downstream filters to read the
        // right colorimetry from the CIImage's metadata.
        //
        // `matchedToWorkingSpace(from:)` on macOS 13+ / iOS 16+ would be
        // the cleanest API, but it isn't on every supported deployment
        // target. The simpler `applyingFilter("CIColorMatrix")` no-op
        // identity matrix forces an explicit working-space promotion;
        // the matrix is the identity so we don't apply any color shift.
        let promoted = raw.applyingFilter(
            "CIColorMatrix",
            parameters: [:]
        )

        // Optional prescale to viewport — same Lanczos path as the RAW
        // chain. Calling `prescaleForDisplay` here keeps the scene-linear
        // intermediate small for the slider phase.
        return Self.prescaleForDisplay(promoted, targetSize: targetSize)
    }

    /// Long-edge pixel cap for the downsampled thumbnail decode, or `nil`
    /// (full-resolution decode) when `targetSize` is absent. The fast
    /// phase passes its viewport target; refine / export pass `nil`.
    ///
    /// We never upscale, so the cap is purely a ceiling — when the source
    /// is already smaller than `targetSize`, `CGImageSourceCreateThumbnail…`
    /// returns the source at its native size. A degenerate (zero/negative)
    /// target falls through to a full-resolution decode rather than asking
    /// ImageIO for a 0-px thumbnail.
    nonisolated private static func thumbnailMaxPixelSize(for targetSize: CGSize?) -> Int? {
        guard let targetSize else { return nil }
        let longEdge = max(targetSize.width, targetSize.height)
        guard longEdge.isFinite, longEdge >= 1 else { return nil }
        return Int(longEdge.rounded())
    }

    /// Helper — open a `CGImageSource` and pull the primary image at
    /// index 0. When `maxPixelSize` is non-nil, ImageIO decodes a
    /// downsampled thumbnail (long edge capped at `maxPixelSize`) so the
    /// full-resolution bitmap is never materialised; otherwise the
    /// full-resolution image is decoded. Returns the CGImage plus its
    /// source color space (when surfaced by ImageIO) so the caller can
    /// tag the CIImage explicitly.
    nonisolated private static func decodeNonRawCGImage(
        url: URL,
        maxPixelSize: Int? = nil
    ) -> (image: CGImage?, colorSpace: CGColorSpace?) {
        let opts: [CFString: Any] = [
            kCGImageSourceShouldCache: false,
            kCGImageSourceShouldCacheImmediately: false,
        ]
        guard let src = CGImageSourceCreateWithURL(url as CFURL, opts as CFDictionary) else {
            return (nil, nil)
        }
        return decodeNonRawCGImage(source: src, maxPixelSize: maxPixelSize)
    }

    nonisolated private static func decodeNonRawCGImage(
        data: Data,
        maxPixelSize: Int? = nil
    ) -> (image: CGImage?, colorSpace: CGColorSpace?) {
        let opts: [CFString: Any] = [
            kCGImageSourceShouldCache: false,
            kCGImageSourceShouldCacheImmediately: false,
        ]
        guard let src = CGImageSourceCreateWithData(data as CFData, opts as CFDictionary) else {
            return (nil, nil)
        }
        return decodeNonRawCGImage(source: src, maxPixelSize: maxPixelSize)
    }

    nonisolated private static func decodeNonRawCGImage(
        source: CGImageSource,
        maxPixelSize: Int?
    ) -> (image: CGImage?, colorSpace: CGColorSpace?) {
        // Index 0 is the primary image for HEIF / JPEG / PNG. (HEIF can
        // contain multiple images via the `pitm` box but Apple's
        // CGImageSource defaults index 0 to the primary item.)
        if let maxPixelSize, maxPixelSize >= 1 {
            // Downsampled fast-phase decode (#785). `…FromImageAlways`
            // forces ImageIO to derive the thumbnail from the full image
            // (not return a tiny/absent embedded thumbnail), but it scales
            // straight from the decoder so the full-res bitmap is never
            // allocated.
            //
            // We deliberately do NOT set `…WithTransform`: the full-res
            // path (`CGImageSourceCreateImageAtIndex`) returns stored,
            // un-oriented pixels and nothing downstream rotates the
            // non-RAW buffer, so orienting only the thumbnail would flip
            // the image when the refine pass replaces it. Matching the
            // full-res path's stored orientation keeps fast and refine
            // consistent (#785 is OOM-only — no rendered-output change).
            let thumbOpts: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceShouldCacheImmediately: false,
                kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
            ]
            if let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbOpts as CFDictionary) {
                // The fit-mode preview stays on screen as the fast (sized)
                // decode, so it must not shift color vs. the full-res
                // refine. ImageIO preserves the source's embedded profile
                // on the thumbnail in the common formats; when it doesn't
                // surface one (`cg.colorSpace == nil`), default to sRGB —
                // a profile-stripped image is sRGB by convention. We do
                // NOT decode the full-resolution CGImage just to read a
                // color space (that would defeat the downsample on the
                // very images this guards). The full-res refine path below
                // applies the identical sRGB default on nil, so fast and
                // refine never disagree (#785).
                return (cg, cg.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB))
            }
            // Fall through to the full-res path if the thumbnail decode
            // failed (e.g. an exotic format ImageIO can downsample-decode
            // only via the full image path) — correctness over the
            // allocation win.
        }
        let imageOpts: [CFString: Any] = [
            // Decode at full res; non-RAW images are already display-sized.
            kCGImageSourceShouldAllowFloat: true,
        ]
        let cg = CGImageSourceCreateImageAtIndex(source, 0, imageOpts as CFDictionary)
        // Default a profile-stripped image to sRGB — matches the
        // downsampled thumbnail branch above so the fast (sized) preview
        // and the full-res refine agree on colorimetry (#785). Leave nil
        // only when the decode itself failed (no image to tag).
        let cs = cg.map { $0.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB) } ?? nil
        return (cg, cs)
    }

    // MARK: FFI per-tick chain helper

    /// Render `scaled` to a fp16 RGBA byte buffer via the pipeline's
    /// CIContext, hand it to the Rust `apply_scene_linear_chain` FFI to
    /// run the cheap-stages chain (WB → tone → vibrance → saturation →
    /// clarity → texture → dehaze → nr_luminance → optional AgX), then
    /// wrap the FFI's output back into a CIImage at the same extent.
    ///
    /// This collapses 8 Metal-kernel CIImage compositions into one
    /// flat-buffer round-trip plus a single CIImage wrap. The CIContext
    /// render is a Metal-backed render so the input materialisation
    /// stays on the GPU until the byte copy.
    ///
    /// `decodedTemperature` / `decodedTint` are the WB the cached buffer
    /// was decoded at by the Rust FFI (sidecar Temperature/Tint when an
    /// XMP was applied; 6500/0 otherwise). The chain runs the WB delta
    /// `wb_gains(live) / wb_gains(decoded)` so opening a saved sidecar
    /// doesn't double-apply WB. `skipAgX` flips off the AgX tail for
    /// non-RAW input that already has a tone curve baked in.
    nonisolated private func applySceneLinearChainViaFFI(
        _ scaled: CIImage,
        model: AdjustmentModel,
        decodedTemperature: Double,
        decodedTint: Double,
        skipAgX: Bool
    ) -> CIImage {
        let extent = scaled.extent
        let w = Int(extent.width.rounded())
        let h = Int(extent.height.rounded())
        guard w > 0, h > 0 else { return scaled }

        let bytesPerPixel = 16 // 4 f32 lanes (#487 — migrated from fp16 / 8 B/px)
        let rowBytes = w * bytesPerPixel
        let totalBytes = rowBytes * h
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!

        // Materialise scaled CIImage -> f32 RGBA bytes.
        var inputBytes = Data(count: totalBytes)
        let renderSucceeded: Bool = inputBytes.withUnsafeMutableBytes { buf -> Bool in
            guard let base = buf.baseAddress else { return false }
            context.render(
                scaled,
                toBitmap: base,
                rowBytes: rowBytes,
                bounds: CGRect(x: 0, y: 0, width: w, height: h),
                format: .RGBAf,
                colorSpace: space
            )
            return true
        }
        guard renderSucceeded else {
            logger.error("applySceneLinearChainViaFFI: CIContext.render failed; falling through")
            return scaled
        }

        // Run the FFI chain. On error, log and fall through to the
        // unprocessed input — the Apple side still shows pixels rather
        // than going black on a kernel hiccup.
        let params = PipelineRenderer.makeParams(
            from: model,
            decodedTemperature: decodedTemperature,
            decodedTint: decodedTint,
            skipAgX: skipAgX
        )
        let outputBytes: Data
        do {
            outputBytes = try mapleStage("apply scene-linear chain") {
                try PipelineRenderer.applySceneLinearChain(
                    inputBytes: inputBytes, width: w, height: h, params: params
                )
            }
        } catch {
            logger.error("applySceneLinearChainViaFFI: FFI error: \(error.localizedDescription, privacy: .public)")
            return scaled
        }

        // Wrap the FFI output back into a CIImage. The bytes are f32
        // RGBA in extendedLinearITUR_2020 — same colour space the FFI
        // input was in, so downstream `MetalKernels.*` consumers see
        // the buffer they expect.
        return mapleStage("FFI chain CIImage build") {
            CIImage(
                bitmapData: outputBytes,
                bytesPerRow: rowBytes,
                size: CGSize(width: w, height: h),
                format: .RGBAf,
                colorSpace: space
            )
        }
    }

    // MARK: Process (non-RAW path — skip WB calibration)

    /// Scene-linear chain for non-RAW input. Identical to
    /// `processSceneLinear` except the WhiteBalance kernel is bypassed by
    /// default — non-RAW images already had source-light WB baked in by
    /// the camera or original editor, so the slider semantics shift from
    /// "correct the source illuminant" (RAW) to "creative warmth/cool
    /// shift on top of whatever the JPEG was baked at" (non-RAW).
    ///
    /// The simplest behaviour ships here: when `model.temperature == 6500`
    /// and `model.tint == 0` (the non-RAW default), the WB kernel is
    /// short-circuited via `decodedAtModel == .default`. Off-default
    /// values apply a multiplicative D65→target shift through the same
    /// kernel, mirroring how Lightroom treats the WB sliders on a JPEG.
    nonisolated public func processSceneLinearNonRaw(
        decoded: CIImage,
        model: AdjustmentModel,
        targetSize: CGSize? = nil
    ) -> CIImage {
        let scaled = Self.prescaleForDisplay(decoded, targetSize: targetSize)

        // Non-RAW WB: identity at user's "as shot" (6500/0). The FFI
        // applies the live-vs-decoded delta the same way the retired
        // WhiteBalance.metal kernel did — pass `(6500, 0)` as the
        // decoded baseline so the chain treats the user's slider value
        // as the absolute target and short-circuits at the default.
        //
        // `skipAgX: true` because non-RAW input is ALREADY display-encoded
        // content (sRGB JPEG, HEIF photo, PNG screenshot). The bytes were
        // tone-mapped at capture by the camera or the renderer that
        // produced them; AgX is a scene-referred view transform expecting
        // extended dynamic range, so applying it to display-bound input
        // double-tone-maps (white at 1.0 compresses to ~0.82, screenshots
        // come back dim and warm). Reference renderers / Lightroom skip their default
        // tone curve on non-RAW for the same reason.
        //
        // The contrast slider (which AgX normally consumes via curve
        // slope modulation) is therefore unused on the non-RAW path; for
        // default sliders today, output is near-passthrough.
        let chained = applySceneLinearChainViaFFI(
            scaled, model: model,
            decodedTemperature: 6500.0, decodedTint: 0.0,
            skipAgX: true
        )

        // Sharpen + nr_color stay on the Apple GPU path (Metal compute
        // kernels) — Richardson-Lucy at 33 ms / 2 MP and Oklab UV blur
        // at 5 ms / 2 MP exceed the slider tick budget on Rust-on-CPU.
        let withSharpen = MetalKernels.applySceneSharpen(
            to: chained,
            amount: Float(model.sharpenAmount),
            radius: Float(model.sharpenRadius),
            detail: Float(model.sharpenDetail),
            masking: Float(model.sharpenMasking)
        )
        return MetalKernels.applySceneNRColor(
            to: withSharpen,
            nrColor: Float(model.nrColor)
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
        decodedAtModel: AdjustmentModel? = nil,
        profileLUT: CIFilter? = nil
    ) -> CIImage {
        let scaled = Self.prescaleForDisplay(decoded, targetSize: targetSize)

        // FFI-collapse path: white_balance → scene_tone_controls →
        // vibrance → saturation → clarity → texture → dehaze →
        // nr_luminance → AgX all run in a single FFI call against the
        // canonical Rust core. Replaces 9 separate Metal-kernel CIImage
        // compositions with one round-trip — and inherits the Rust
        // pipeline's algorithmic decisions verbatim, which closes the
        // drift between Apple and Rust on every cheap stage.
        //
        // WB contract (paired with `RawCoreBridge.stripAppleGPUStages`):
        //
        //   1. The FFI scene-linear decode FORCES `temperature=6500,
        //      tint=0`, so the Rust `white_balance::apply` early-exits.
        //      The cached buffer is at D65 (post-DCP reference) regardless
        //      of sidecar contents. This eliminates the
        //      "first-open at D65, post-sidecar at user-temp"
        //      inconsistency that surfaced as a magenta cast on every
        //      slider write.
        //
        //   2. Apple's chain passes `decodedTemp = asShot.temperature`
        //      (NOT 6500). The chain's `apply_delta(live, decoded)`
        //      computes `wb_gains(live) / wb_gains(asShot)`, which is
        //      identity at `live == asShot` — matching the reference renderer's "As Shot"
        //      UX where the default slider value produces zero WB shift
        //      (the post-DCP buffer is already at D65, viewed as the
        //      camera's intended scene rendering). Moving the slider
        //      applies a relative shift from asShot.
        //
        //   Why NOT pass decodedTemp=6500: on test_0002 (Hasselblad
        //   H5D-40, asShotCCT=4522, asShotTint=-43.7),
        //   `wb_gains(4522, -43.7) ≈ (1.04, 1.0, 2.13)` — applied to
        //   the D65 buffer the B channel doubles, producing a uniform
        //   magenta cast. The relative-to-asShot formula (g_live /
        //   g_asShot) cancels this 2.13× B amplification at slider
        //   = asShot.
        //
        // `decodedAtModel` is unused; kept on the signature so a future
        // saved-WB sidecar workflow can re-thread per-asset baselines.
        let _ = decodedAtModel
        let decodedTemp = asShot?.temperature ?? 6500.0
        let decodedTint = asShot?.tint ?? 0.0
        if let asShot {
            logger.notice("processSceneLinear asShot=\(asShot.temperature, format: .fixed(precision: 0))K/\(asShot.tint, format: .fixed(precision: 1)) live=\(model.temperature, format: .fixed(precision: 0))K/\(model.tint, format: .fixed(precision: 1)) → decodedTemp=\(decodedTemp, format: .fixed(precision: 0))")
        } else {
            logger.notice("processSceneLinear asShot=NIL live=\(model.temperature, format: .fixed(precision: 0))K/\(model.tint, format: .fixed(precision: 1)) → decodedTemp=\(decodedTemp, format: .fixed(precision: 0))")
        }
        let chained = applySceneLinearChainViaFFI(
            scaled, model: model,
            decodedTemperature: decodedTemp, decodedTint: decodedTint,
            skipAgX: false
        )

        // sharpen + nr_color stay on the Apple GPU path (Metal compute
        // kernels). Both run AFTER the FFI's AgX, so they operate in
        // display-linear Rec.2020 ([0,1]) rather than the scene-linear
        // domain the original pipeline placed them in. This is a known
        // behaviour change from "sharpen pre-AgX in scene-linear" to
        // "sharpen post-AgX in display-linear" — chosen because:
        //   * sharpen at viewport size dominates Rust-on-CPU latency
        //     (~33 ms / 2 MP, exceeding the 16 ms slider tick budget);
        //     GPU is essential.
        //   * the display-domain shift only affects highlight halos, not
        //     midtones — the visible difference at default sliders
        //     (sharpen_amount = 0) is zero.
        let withSharpen = MetalKernels.applySceneSharpen(
            to: chained,
            amount: Float(model.sharpenAmount),
            radius: Float(model.sharpenRadius),
            detail: Float(model.sharpenDetail),
            masking: Float(model.sharpenMasking)
        )
        let withNRColor = MetalKernels.applySceneNRColor(
            to: withSharpen,
            nrColor: Float(model.nrColor)
        )
        // Auto Profile (#812) — the LAST display-space op, matching the CPU
        // path's `auto_profile` → quantize order. `profileLUT` is a
        // CIColorCubeWithColorSpace tagged sRGB so CoreImage applies the
        // curve in f32 sRGB-encoded display space (the domain it was fit in,
        // #550). Nil for `Profile::Neutral` — the canvas then stays
        // byte-identical to the AgX-only output.
        //
        // #871: `profileLUT` is currently ALWAYS nil — `AutoProfileLUT.filter`
        // is disabled because the sRGB-tagged cube made CoreImage clip
        // wide-gamut Rec.2020 greens (no Oklab compression like raw-core),
        // blowing out saturated foliage under Auto. So Apple `Profile::Auto`
        // renders as Neutral/AgX until the gamut-correct encode lands. The
        // `apply(nil, …)` call is then a no-op; the wiring stays so the
        // re-enable is a one-line change in `AutoProfileLUT`.
        return AutoProfileLUT.apply(profileLUT, to: withNRColor)
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

    // MARK: Materialise a region (visible-rect refine)

    /// Force CoreImage to materialise `image` over the given `rect` into
    /// a CGImage using the pipeline's Metal-backed context. Equivalent
    /// to `CIContext.createCGImage(image, from: rect, format:colorSpace:)`,
    /// exposed so EditSession's visible-region refine path can reuse the
    /// shared context (avoids spinning up a sibling Metal command queue
    /// per slider tick).
    ///
    /// Output format is `RGBAf` + extended-linear Rec.2020 (#487 — migrated
    /// from RGBAh to keep the scene-buffer precision intact through the
    /// refine path). Same working-space the CIImageView re-encodes from
    /// when it lands the final P3 raster, so this step doesn't introduce
    /// a colour-space trip beyond what the canvas will already do.
    nonisolated public func materializeRegion(
        _ image: CIImage,
        rect: CGRect
    ) -> CGImage? {
        let cs = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        return context.createCGImage(image, from: rect, format: .RGBAf, colorSpace: cs)
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
