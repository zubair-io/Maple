// ImageEditPipeline.swift — scene-linear pipeline (spec § 02).
//
// Pipeline order (matches Rust `pipeline.rs:120-132`):
//   1. RAW decode → Rust scene-linear FFI (Rec.2020 f32)
//   2. The Rust per-tick scene-linear chain, in one FFI call —
//      white_balance (live − decoded delta) → scene_tone_controls →
//      tone_curves → vibrance → saturation → hsl → clarity → texture →
//      dehaze → local_adjustments → vignette → sharpen → nr_luminance →
//      nr_color → AgX → split_tone → grain
//   3. Display encode (Rec.2020 → sRGB, Oklab gamut compression + gamma)
//   4. Auto Profile cube, the last display-space op
//
// Steps 2 and 3 fuse into a single FFI round trip whenever the #661 chain
// cache would miss (`applyChainAndEncodeViaFusedFFI`).
//
// There are no hand-written Apple render kernels left. Each numbered stage
// above was once its own Metal compute kernel here; the cheap scene-linear
// nine were retired when the Rust FFI gained `apply_scene_linear_chain`,
// and #1043 (epic #925 P5b) retired the last two spatial ones — sharpen
// and nr_color — which had been running post-AgX in display-linear rather
// than at the canonical scene-linear position above. Render math now lives
// only in Rust (CPU) and WGSL (GPU). See `MetalKernels.swift`, which
// survives solely as the bundled AgX-LUT parity oracle.
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

    /// Resolution the live decode runs at for a render `phase`, given the
    /// caller's requested display `targetSize` (#1637).
    ///
    /// A bounded target is honoured so the decoded scene-linear buffer never
    /// exceeds the display. A nil/degenerate target — INCLUDING the cold-open
    /// race where `CanvasMath.refinedTargetSize` is nil before the viewport
    /// seeds and the scheduler reaches `decodeAndRender(.refine, nil)` — caps to
    /// the fast fallback rather than full-res; full-res here allocated the
    /// full-sensor demosaic + GPU texture and jetsam-killed iOS on a 100 MP RAW
    /// (#1637). The live decode never needs full-res — export renders full-res
    /// via the separate `renderActor.renderForExport` path. `phase` is retained
    /// for call-site clarity; both phases cap identically today.
    ///
    nonisolated public static func decodeTarget(
        phase: RenderPhase, targetSize: CGSize?
    ) -> CGSize? {
        _ = phase
        if let targetSize {
            let longEdge = max(targetSize.width, targetSize.height)
            if longEdge.isFinite, longEdge >= 1 { return targetSize }
        }
        let cap = CGFloat(fastPhaseFallbackLongEdge)
        return CGSize(width: cap, height: cap)
    }

    /// Cap a presentation/process target at the DELIVERED decode extent
    /// (#2143). At 100% zoom the refine target can exceed what the decode
    /// actually returned; the over-ask was silently absorbed downstream —
    /// `decodedForNativeCanvas` upscaled the delivered buffer to the native
    /// canvas (coordinate normalisation, required for crop geometry, #2118)
    /// and `prescaleForDisplay` scaled it back down to the inflated target,
    /// publishing a buffer with no more true detail than the delivered
    /// source (on a 100 MP Bayer frame: a ~432 MB RGBAf16 publish carrying
    /// 6144 px of real detail). Capping at the delivered extent bounds the
    /// prescale output and the published buffer to real resolution.
    ///
    /// Deliberately keyed off the ACTUAL delivered extent
    /// (`RenderActor.DecodedSnapshot.rawResolution` — the
    /// `decoded.extent.size` before `decodedForNativeCanvas` scales it to
    /// the native canvas; it is already DISPLAY-oriented, since the sized
    /// FFI applies EXIF rotation before returning, so per-axis comparison
    /// against the display-oriented target is sound for portrait assets
    /// too), never a predicted divisor: the `.preview`
    /// half-res ceiling is CFA-dependent in raw-core
    /// (`effective_quality_divisor` — Bayer halves at Preview, but X-Trans
    /// and LinearRgb decode FULL-res), so a predicted `native/2` cap would
    /// wrongly downsample those assets. Delivered-extent capping is a no-op
    /// exactly when the decode really is full-res — which, since
    /// `refineDecodeQuality` below now escalates the refine decode itself
    /// whenever the target exceeds the `.preview` ceiling, is the common
    /// case; this cap remains as the safety net for paths that still decode
    /// at `.preview` (GPU-live, non-RAW, or a decode that undershoots for
    /// some other reason). `.zero` delivered (no decode recorded yet)
    /// passes the target through unchanged. True 1:1 native detail remains
    /// `refineNativeDetail`'s job (the tile path).
    nonisolated static func cappedToDelivered(
        _ target: CGSize, delivered: CGSize
    ) -> CGSize {
        guard delivered.width > 0, delivered.height > 0 else { return target }
        let cappedWidth = min(target.width, delivered.width)
        let cappedHeight = min(target.height, delivered.height)
        guard cappedWidth < target.width || cappedHeight < target.height else { return target }
        return CGSize(width: cappedWidth, height: cappedHeight)
    }

    /// Decode quality for a REFINE-phase sized request, given the asset's
    /// native long edge and the requested decode target's long edge (#2143).
    ///
    /// `decodeSceneLinearSized` at `.preview` (half-res quad demosaic) caps
    /// its OWN output at roughly `nativeLongEdge / 2` regardless of the
    /// `maxLongEdge` the caller asks for — requesting `.preview` for a
    /// target beyond that cap silently returns the half-res buffer anyway.
    /// The canvas then has to upscale that undersized buffer back up to the
    /// native extent (`EditSession.decodedForNativeCanvas`) before
    /// `prescaleForDisplay` can downscale it to the real display target: a
    /// measured, FIXED `sx == sy == 2.0` (native ÷ native/2) upscale
    /// regardless of how far beyond the cap the request went, immediately
    /// followed by a second full resample back down — both on the largest
    /// buffer in the chain, for strictly less detail than a matched-quality
    /// decode would have delivered directly.
    ///
    /// Escalating to the full-res demosaic (`.full` / `.amaze`, the same
    /// flag gate the export path already uses — `AmazeFlag`, #940) whenever
    /// the target genuinely needs more than half-res detail removes that
    /// round trip: the decode delivers (up to) exactly what the display
    /// needs, `decodedForNativeCanvas`'s own `sx ≈ 1` guard turns its
    /// upscale into a no-op, and `prescaleForDisplay` downsamples exactly
    /// once. Below the threshold `.preview` already delivers precisely the
    /// requested target (no cap ever engages), so no escalation is needed —
    /// the request is naturally "capped" at what `.preview` can serve by
    /// construction of the `<=` branch. `cappedToDelivered` above remains
    /// the downstream safety net for whatever this function's caller
    /// couldn't escalate (GPU-live / non-RAW / a decode that still
    /// undershoots for some other reason).
    ///
    /// `nativeLongEdge <= 0` (native size not yet seeded — the cold-open
    /// race) keeps `.preview`, matching the existing fallback: there is no
    /// native reference to size the escalation decision against yet.
    nonisolated public static func refineDecodeQuality(
        nativeLongEdge: CGFloat, targetLongEdge: CGFloat
    ) -> PipelineRenderer.Quality {
        guard nativeLongEdge > 0, nativeLongEdge.isFinite,
              targetLongEdge.isFinite, targetLongEdge > 0
        else { return .preview }
        guard targetLongEdge > nativeLongEdge / 2 else { return .preview }
        return AmazeFlag.isEnabled ? .amaze : .full
    }

    /// Sensor long edge (px) at/below which the GPU-live render path is used;
    /// above it the editor falls back to the CPU two-phase path (#1637 / #1647).
    ///
    /// An on-device `MemoryProbe` trace (Artemis, GPU forced on) showed a single
    /// 100 MP `test_0000.DNG` open peaks at **4.8 GB and survives** (1.3 GB
    /// headroom) — the GPU chain is only ~0.5 GB at the 1.2 MP live dims, and the
    /// M0 fit-sizing already bounds the auto-profile develop. The original gate
    /// (9000 px) was over-conservative for that case. Raised to 13000 px (≈ the
    /// 100 MP class: DJI/Hasselblad ~12288, GFX ~11648) so those bodies keep the
    /// 16 ms GPU slider; sensors beyond the validated range still fall back to
    /// CPU. #1647 M3.
    nonisolated public static let gpuLiveMaxSensorLongEdge: Int = 13000

    /// Whether the GPU-live path is allowed for a sensor of `longEdge` px.
    ///
    /// `0` (size not yet seeded) returns `false` — conservative. A
    /// bytes-provider / PhotoKit asset seeds `nativeImageSize` ASYNchronously
    /// (`seedNativeImageSizeFromMetadataAsync`), so it can still be `.zero`
    /// when the cold-open refine presents; taking the GPU path then on a
    /// possibly-huge RAW is exactly what OOM-killed a 100 MP library photo.
    /// GPU-live resumes for that asset once the size seeds and proves ≤ the
    /// threshold. URL-backed assets seed synchronously before the first
    /// render, so they are unaffected (#1637).
    nonisolated public static func gpuLiveSupportsSensor(longEdge: CGFloat) -> Bool {
        longEdge > 0 && longEdge <= CGFloat(gpuLiveMaxSensorLongEdge)
    }

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

    // `internal` (not `private`) so the gpu-gated `ImageEditPipeline+GpuLive`
    // extension (a sibling file) can materialise a decoded CIImage to f32 via
    // this shared Metal-backed context. Same-module access only.
    let context: CIContext

    /// Single-entry LRU cache around `applySceneLinearChainViaFFI`. When
    /// the user drags a post-FFI slider (sharpen* / nrColor / capture
    /// sharpening) the model hash is unchanged and the cache returns the
    /// previously computed scene-linear CIImage, skipping the ≈50 ms FFI
    /// readback. See `SceneLinearChainCache` and #661.
    nonisolated let sceneLinearChainCache = SceneLinearChainCache()

    /// Single-entry cache around the FFI readback ITSELF — the
    /// `context.render(scaled, toBitmap:...)` call inside
    /// `applySceneLinearChainViaFFI` that materialises the prescaled
    /// scene-linear CIImage into flat f32 bytes. Unlike
    /// `sceneLinearChainCache` (keyed on the model digest, so it misses on
    /// every tick of an exposure-style drag), this cache is keyed on the
    /// identity of the `decoded` CIImage + target size — both of which are
    /// invariant across a slider drag regardless of which knob moves — so
    /// it hits even when the model-keyed cache above is a guaranteed miss.
    /// See `FFIInputBufferCache` and #1959.
    nonisolated let ffiInputBufferCache = FFIInputBufferCache()

    /// Env-derived default for the fused-chain-encode kill-switch —
    /// `MAPLE_DISABLE_FUSED_CHAIN_ENCODE=1`. Read once at process start.
    /// The effective value is `fusedChainEncodeDisabled` below, which lets a
    /// test override win over this default.
    nonisolated static let fusedChainEncodeEnvDisabled: Bool =
        ProcessInfo.processInfo.environment["MAPLE_DISABLE_FUSED_CHAIN_ENCODE"] == "1"

    /// Test-only runtime override of the fused-chain-encode kill-switch.
    /// `nil` = follow the env default; non-nil forces the fused path
    /// on (`true`) or off (`false`). Process-global (the gate is a static),
    /// guarded by `fusedChainEncodeOverrideLock`. Set via
    /// `_testSetFusedChainEncodeEnabled(_:)`.
    nonisolated(unsafe) private static var fusedChainEncodeTestOverride: Bool?
    private static let fusedChainEncodeOverrideLock = NSLock()

    /// Effective fused-chain-encode disabled state — forces
    /// `processSceneLinear` / `processSceneLinearNonRaw` to always take the
    /// two-step `applySceneLinearChainViaFFI` + `encodeDisplaySRGBViaFFI`
    /// path, even when the fused-path identity gate (sharpen/nr_color both
    /// ≈0) holds. The test override (when set) wins over the env default.
    /// Mirrors `MAPLE_DISABLE_FFI_CACHE` / `MAPLE_DISABLE_FFI_INPUT_CACHE` —
    /// used by `FusedChainEncodeSliderTickPerfTests` to measure the fused
    /// ("after") vs two-step ("before") arms on the SAME build, rather than
    /// a stale git ref (#2092), and to assert the win as a machine-independent
    /// in-run ratio (#2113).
    nonisolated static var fusedChainEncodeDisabled: Bool {
        fusedChainEncodeOverrideLock.lock()
        defer { fusedChainEncodeOverrideLock.unlock() }
        if let overrideEnabled = fusedChainEncodeTestOverride { return !overrideEnabled }
        return fusedChainEncodeEnvDisabled
    }

    /// Test-only: override the `MAPLE_DISABLE_FUSED_CHAIN_ENCODE` env
    /// kill-switch at runtime. `true` forces the fused path ON, `false`
    /// forces it OFF, `nil` restores the env-derived default. The gate is
    /// process-global (a static), so this override is too — a perf bench
    /// that toggles it must invalidate the per-pipeline caches and re-warm
    /// between arms. `internal` (test target only via `@testable import`) —
    /// not part of the production surface (#2113).
    nonisolated static func _testSetFusedChainEncodeEnabled(_ enabled: Bool?) {
        fusedChainEncodeOverrideLock.lock()
        defer { fusedChainEncodeOverrideLock.unlock() }
        fusedChainEncodeTestOverride = enabled
    }

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
    ///
    /// ⚠️ Auto Profile contract (#871 × #927 — see #1174): under
    /// `Profile.auto` (the default) the FFI develops this buffer with
    /// auto-exposure forced **Off** whenever the file's embedded preview is
    /// extractable, because the fitted Auto Profile cube owns the entire
    /// scene→JPEG brightness re-anchor. Since #927 made extraction work
    /// in-process, that is effectively *every* preview-bearing RAW — so a
    /// display render built from this buffer is only brightness-correct if
    /// the caller also passes `AutoProfileLUT.shared.filter(...)` into
    /// `processSceneLinear(profileLUT:)` (as `EditSession` does), or pins
    /// `profileOverride: .neutral` here to keep auto-exposure in the
    /// decode. Rendering the Auto buffer without the cube comes out too
    /// dark by roughly the AE anchor gain (typically 2–3×).
    /// Decoded scene-linear data including the pixel buffer and the per-camera
    /// noise profile + ISO needed by the adaptive NR stage. The noise profile
    /// and ISO survive the decode→render hand-off via `DecodedSnapshot` so the
    /// live-preview chain has the real per-image values rather than zeros.
    public struct SceneLinearDecodeResult: Sendable {
        public let image: CIImage
        public let noiseProfile: [Float]?
        public let iso: UInt32
        /// Decode-exported WB slider frame (#1781); `nil` when the source
        /// carries no frame. Survives the decode→render hand-off via
        /// `DecodedSnapshot` so the per-tick chains and the As-Shot seed
        /// use raw-core's numbers.
        public let wbFrame: WbSliderFrame?
        /// Decode-exported auto-exposure gain (#1167/#2070); mirrors
        /// `wbFrame`'s export contract (never optional — see
        /// `MapleSceneLinearImageData.aeGain`). Survives the decode→render
        /// hand-off via `DecodedSnapshot` so `NativeDetailRenderer` can
        /// thread the SAME gain into a deep-zoom / native-detail tile.
        public let aeGain: Float
    }

    nonisolated public func decodeSceneLinear(
        asset: AssetRef,
        quality: PipelineRenderer.Quality = .preview,
        xmpPath: URL? = nil,
        profileOverride: Profile? = nil,
        autoExposureOverride: AutoExposureMode? = nil,
        cancel: CancelFlag? = nil
    ) async -> SceneLinearDecodeResult? {
        let imageData: MapleSceneLinearImageData
        do {
            if let url = asset.primaryURL {
                let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
                let accessing = scope.startAccessingSecurityScopedResource()
                defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
                imageData = try PipelineRenderer.renderSceneLinear(
                    rawPath: url, xmpPath: xmpPath, quality: quality,
                    profileOverride: profileOverride, autoExposureOverride: autoExposureOverride, cancel: cancel
                )
            } else if let provider = asset.bytesProvider {
                let bytes = try await provider()
                let hint = asset.hintExtension ?? ""
                imageData = try PipelineRenderer.renderSceneLinear(
                    rawBytes: bytes, hint: hint, xmpPath: xmpPath, quality: quality,
                    profileOverride: profileOverride, autoExposureOverride: autoExposureOverride, cancel: cancel
                )
            } else {
                return nil
            }
        } catch PipelineError.cancelled {
            // #951: a superseding decode cancelled this one. Not an error —
            // drop quietly (debug, not error) so a normal supersession during
            // a cold open isn't logged as a failure.
            logger.debug("decodeSceneLinear cancelled for \(asset.displayName, privacy: .public) (superseded)")
            return nil
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
        let ciImage = mapleStage("decode CIImage build") {
            CIImage(
                bitmapData: imageData.pixels,
                bytesPerRow: bytesPerRow,
                size: CGSize(width: w, height: h),
                format: .RGBAf,
                colorSpace: space
            )
        }
        return SceneLinearDecodeResult(
            image: ciImage,
            noiseProfile: imageData.noiseProfile,
            iso: imageData.iso,
            wbFrame: imageData.wbFrame,
            aeGain: imageData.aeGain
        )
    }

    // MARK: Decode (scene-linear sized — Plan 1 v2 viewport-sized FFI)

    /// Sized scene-linear decode — runs the new Rust FFI sized entry,
    /// returning a Rec.2020 fp16 CIImage at (or below) `targetSize`.
    /// Per ticket 06 § Product Requirements 1, 2: the editor's first
    /// Rust-backed open routes here when `previewSize` is known. The
    /// returned CIImage's extent fits within `targetSize` (preserving
    /// aspect, never upscaling).
    ///
    /// `quality` defaults to `.preview` (half-res quad demosaic, the
    /// original ticket 06 contract) — callers that need a target beyond
    /// what `.preview` can deliver (roughly half the sensor's native long
    /// edge) must pass `.full`/`.amaze` explicitly; `.preview` silently
    /// caps its own output rather than honouring a larger `targetSize`
    /// (#2143 — see `ImageEditPipeline.refineDecodeQuality`, the refine
    /// call site's escalation decision).
    nonisolated public func decodeSceneLinearSized(
        asset: AssetRef,
        targetSize: CGSize,
        xmpPath: URL? = nil,
        quality: PipelineRenderer.Quality = .preview,
        profileOverride: Profile? = nil,
        autoExposureOverride: AutoExposureMode? = nil,
        cancel: CancelFlag? = nil
    ) async -> SceneLinearDecodeResult? {
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
                    quality: quality, maxLongEdge: longEdge,
                    profileOverride: profileOverride, autoExposureOverride: autoExposureOverride, cancel: cancel
                )
            } else if let provider = asset.bytesProvider {
                let bytes = try await provider()
                let hint = asset.hintExtension ?? ""
                imageData = try PipelineRenderer.renderSceneLinearSized(
                    rawBytes: bytes, hint: hint, xmpPath: xmpPath,
                    quality: quality, maxLongEdge: longEdge,
                    profileOverride: profileOverride, autoExposureOverride: autoExposureOverride, cancel: cancel
                )
            } else {
                return nil
            }
        } catch PipelineError.cancelled {
            // #951: superseded mid-decode. Drop quietly and do NOT fall back to
            // the unsized path — the fallback would either be cancelled too
            // (same flag) or, worse, re-decode the abandoned image at full
            // resolution. Returning nil routes to the stale/dropped path.
            logger.debug("decodeSceneLinearSized cancelled for \(asset.displayName, privacy: .public) (superseded)")
            return nil
        } catch {
            logger.error("decodeSceneLinearSized failed for \(asset.displayName, privacy: .public): \(error.localizedDescription, privacy: .public). Falling back to unsized scene-linear path.")
            // Ticket 06 § Product Requirements 3: existing whole-preview
            // path remains available as a fallback when the sized path
            // fails. The unsized scene-linear entry from Task 4 is the
            // right fallback (matched color domain); the legacy display-
            // encoded path would mismatch the rest of `processSceneLinear`.
            // Forward the cancel flag so the fallback is still interruptible,
            // and the caller's requested quality so a degraded network/disk
            // read doesn't ALSO silently degrade the demosaic.
            return await decodeSceneLinear(
                asset: asset, quality: quality, xmpPath: xmpPath,
                profileOverride: profileOverride, autoExposureOverride: autoExposureOverride, cancel: cancel
            )
        }
        let w = imageData.width, h = imageData.height
        let bytesPerRow = w * imageData.bytesPerPixel
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        let ciImage = mapleStage("decode CIImage build") {
            CIImage(
                bitmapData: imageData.pixels,
                bytesPerRow: bytesPerRow,
                size: CGSize(width: w, height: h),
                format: .RGBAf,
                colorSpace: space
            )
        }
        return SceneLinearDecodeResult(
            image: ciImage,
            noiseProfile: imageData.noiseProfile,
            iso: imageData.iso,
            wbFrame: imageData.wbFrame,
            aeGain: imageData.aeGain
        )
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
        // EXIF orientation (1–8) of the source. ImageIO returns the
        // stored, un-oriented pixels on both the thumbnail and full-res
        // decode paths, so we apply the rotation ourselves below (uniform
        // across fast + refine). iPhone HEIC/JPEG captures are almost
        // always stored landscape with an orientation tag; without this
        // the image opens sideways (#1283).
        let exifOrientation: Int32
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
            exifOrientation = pair.orientation
        } else if let provider = asset.bytesProvider {
            do {
                let bytes = try await provider()
                let pair = Self.decodeNonRawCGImage(data: bytes, maxPixelSize: maxPixelSize)
                cgImage = pair.image
                sourceColorSpace = pair.colorSpace
                exifOrientation = pair.orientation
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
        let decodedCI = mapleStage("decode non-RAW CIImage build") {
            CIImage(cgImage: cgImage, options: options)
        }

        // Apply the EXIF orientation. ImageIO handed us stored (sensor)
        // pixels; this rotates/flips them into display orientation. A
        // geometric transform commutes with the per-pixel color promotion
        // below, so order with the CIColorMatrix is irrelevant. Normal (1)
        // is a no-op fast path. `.oriented` is applied identically to the
        // fast (thumbnail) and refine (full-res) decodes, so the two phases
        // never disagree.
        let raw: CIImage = exifOrientation == 1
            ? decodedCI
            : decodedCI.oriented(forExifOrientation: exifOrientation)

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
    ) -> (image: CGImage?, colorSpace: CGColorSpace?, orientation: Int32) {
        let opts: [CFString: Any] = [
            kCGImageSourceShouldCache: false,
            kCGImageSourceShouldCacheImmediately: false,
        ]
        guard let src = CGImageSourceCreateWithURL(url as CFURL, opts as CFDictionary) else {
            return (nil, nil, 1)
        }
        return decodeNonRawCGImage(source: src, maxPixelSize: maxPixelSize)
    }

    nonisolated private static func decodeNonRawCGImage(
        data: Data,
        maxPixelSize: Int? = nil
    ) -> (image: CGImage?, colorSpace: CGColorSpace?, orientation: Int32) {
        let opts: [CFString: Any] = [
            kCGImageSourceShouldCache: false,
            kCGImageSourceShouldCacheImmediately: false,
        ]
        guard let src = CGImageSourceCreateWithData(data as CFData, opts as CFDictionary) else {
            return (nil, nil, 1)
        }
        return decodeNonRawCGImage(source: src, maxPixelSize: maxPixelSize)
    }

    /// Read the EXIF/TIFF orientation (1–8) recorded for the primary image
    /// (index 0) of a `CGImageSource`. Returns `1` (Normal) when the tag is
    /// absent or out of range. ImageIO surfaces the same value whether the
    /// pixels are later decoded via the thumbnail or the full-res path, so
    /// the caller can apply one rotation consistently across both.
    nonisolated private static func exifOrientation(of source: CGImageSource) -> Int32 {
        guard
            let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
            let value = props[kCGImagePropertyOrientation] as? NSNumber
        else {
            return 1
        }
        let raw = value.int32Value
        return (1...8).contains(raw) ? raw : 1
    }

    nonisolated private static func decodeNonRawCGImage(
        source: CGImageSource,
        maxPixelSize: Int?
    ) -> (image: CGImage?, colorSpace: CGColorSpace?, orientation: Int32) {
        let orientation = exifOrientation(of: source)
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
            // We deliberately do NOT set `…WithTransform`: both this
            // thumbnail decode and the full-res path
            // (`CGImageSourceCreateImageAtIndex`) return stored,
            // un-oriented pixels, and the caller applies the EXIF
            // orientation (returned alongside) once via
            // `CIImage.oriented(forExifOrientation:)`. Letting ImageIO
            // transform only the thumbnail here would double-apply (or
            // disagree with) that rotation. Returning identical stored
            // orientation from both paths keeps fast and refine consistent.
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
                return (cg, cg.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB), orientation)
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
        return (cg, cs, orientation)
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
    ///
    /// `decodedSource` (#1959) is the UN-prescaled decoded CIImage `scaled`
    /// was derived from (`Self.prescaleForDisplay(decoded, targetSize:)` in
    /// the caller) — it is used ONLY as an identity anchor for
    /// `ffiInputBufferCache`'s key, never rendered directly. The prescale is
    /// a pure function of `(decoded, targetSize)`, so the SAME `decoded`
    /// instance at the SAME target dims always reads back to the SAME
    /// bytes; passing it lets a cache hit skip the GPU→CPU readback below
    /// entirely even when `sceneLinearChainCache` above is a guaranteed miss
    /// (e.g. every tick of an exposure-style drag, where the model digest
    /// changes by design). `nil` (the default) disables the input cache
    /// for that call. CONSTRAINT (#2042): callers must pass `nil` for
    /// UNBOUNDED (nil-`targetSize`, full-resolution) renders — export and
    /// full-res preview paths — because a `put` there would pin a
    /// full-resolution f32 buffer (~1.6 GB at 100 MP) in the single slot
    /// until the next put, defeating the export-memory bounding. Slider
    /// drag ticks always carry a viewport target, so gating on a non-nil
    /// `targetSize` costs the drag path nothing.
    nonisolated private func applySceneLinearChainViaFFI(
        _ scaled: CIImage,
        model: AdjustmentModel,
        decodedTemperature: Double,
        decodedTint: Double,
        wbFrame: WbSliderFrame? = nil,
        skipAgX: Bool,
        assetID: UUID? = nil,
        noiseProfile: [Float]? = nil,
        iso: UInt32 = 0,
        decodedSource: CIImage? = nil
    ) -> CIImage {
        let extent = scaled.extent
        let w = Int(extent.width.rounded())
        let h = Int(extent.height.rounded())
        guard w > 0, h > 0 else { return scaled }

        // #661 — cache check. When the caller provides an `assetID` and
        // every scene-linear input matches the previously rendered tick,
        // return the cached CIImage and skip the FFI round-trip entirely.
        // The post-FFI Metal kernels (sharpen + nr_color) still run on
        // top — that's by design: they're the sliders the cache is
        // supposed to make cheap. See `SceneLinearChainCache` for the
        // key shape and correctness invariants.
        let cacheKey: SceneLinearChainCache.Key? = assetID.map { id in
            SceneLinearChainCache.make(
                assetID: id,
                model: model,
                decodedTemperature: decodedTemperature,
                decodedTint: decodedTint,
                skipAgX: skipAgX,
                width: w,
                height: h,
                wbFrame: wbFrame
            )
        }
        if let cacheKey, let hit = sceneLinearChainCache.get(cacheKey) {
            return hit
        }

        let bytesPerPixel = 16 // 4 f32 lanes (#487 — migrated from fp16 / 8 B/px)
        let rowBytes = w * bytesPerPixel
        let totalBytes = rowBytes * h
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!

        // Run the FFI chain. On error, log and fall through to the
        // unprocessed input — the Apple side still shows pixels rather
        // than going black on a kernel hiccup.
        let params = PipelineRenderer.makeParams(
            from: model,
            decodedTemperature: decodedTemperature,
            decodedTint: decodedTint,
            skipAgX: skipAgX,
            iso: iso,
            wbFrame: wbFrame
        )

        // #1959 — input-readback cache check. `scaled` is a pure function
        // of `(decodedSource, w, h)` (see `Self.prescaleForDisplay`), so
        // the flat f32 bytes a fresh `context.render(scaled, ...)` would
        // produce are identical to whatever the last call at this same
        // (decodedSource, w, h) already read back — regardless of how the
        // model changed in between. The `get`/`put` calls below also pass
        // the live `decodedSource` instance: the cache's weak identity
        // anchor requires `===` on it, so an `ObjectIdentifier` recycled
        // by a later allocation can never serve a previous image's bytes.
        // See `FFIInputBufferCache` for the key shape and correctness
        // invariant.
        let inputCacheKey: FFIInputBufferCache.Key? = decodedSource.map { d in
            FFIInputBufferCache.Key(decodedID: ObjectIdentifier(d), width: w, height: h)
        }

        // #2042 — the round trip below allocates an ~totalBytes `inputBytes`
        // buffer (the rendered `scaled` CIImage) AND an ~totalBytes
        // `outputBytes` buffer (the FFI result) — at 100 MP that's ~1.6 GB
        // each, ~3.2 GB live together for the FFI call. `autoreleasepool`
        // guarantees `inputBytes` plus any Foundation/CoreImage temporaries
        // autoreleased while rendering it (CoreImage's `context.render`
        // implementation is not under our control and is known to
        // autorelease scratch buffers) are released the instant this
        // function returns — BEFORE the next stage (the sibling
        // `encodeDisplaySRGBViaFFI` round trip) allocates its own
        // ~GB-scale buffers. Without
        // this, Swift gives no guarantee `inputBytes` is freed before
        // function return (ARC's last-use release is an optimisation, not
        // a promise, and autoreleased temporaries only die at a pool
        // drain) — so per-stage buffers can stack instead of superseding
        // one another across a single render. A cache HIT below skips the
        // render (and its autoreleased scratch) entirely, but the pool
        // still bounds the FFI output buffer's lifetime the same way.
        let wrapped: CIImage? = autoreleasepool {
            // Materialise scaled CIImage -> f32 RGBA bytes, or reuse the
            // bytes from the last tick's readback when the input cache
            // holds a hit for (decodedSource, w, h) — #1959.
            let inputBytes: Data
            if let inputCacheKey, let decodedSource,
               let cachedBytes = ffiInputBufferCache.get(inputCacheKey, decoded: decodedSource) {
                inputBytes = cachedBytes
            } else {
                var freshBytes = Data(count: totalBytes)
                let renderSucceeded: Bool = freshBytes.withUnsafeMutableBytes { buf -> Bool in
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
                    return nil
                }
                if let inputCacheKey, let decodedSource {
                    ffiInputBufferCache.put(inputCacheKey, freshBytes, decoded: decodedSource)
                }
                inputBytes = freshBytes
            }

            let outputBytes: Data
            do {
                outputBytes = try mapleStage("apply scene-linear chain") {
                    try PipelineRenderer.applySceneLinearChain(
                        inputBytes: inputBytes, width: w, height: h, params: params,
                        noiseProfile: noiseProfile
                    )
                }
            } catch {
                logger.error("applySceneLinearChainViaFFI: FFI error: \(error.localizedDescription, privacy: .public)")
                return nil
            }
            // `inputBytes` has no further use after this point — falling
            // out of this closure's scope (the autoreleasepool boundary)
            // is what actually drops it, rather than relying on it to
            // happen to be optimised away before function return.

            // Wrap the FFI output back into a CIImage. The bytes are f32
            // RGBA in extendedLinearITUR_2020 — same colour space the FFI
            // input was in, so the downstream display encode sees the
            // buffer it expects.
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
        guard let wrapped else {
            // Either the render or the FFI call failed above (already
            // logged inside the pool) — fall through to the unprocessed
            // input, matching the pre-#2042 control flow exactly.
            return scaled
        }
        // #661 — store only on the success path. The failure branch above
        // must not pollute the cache or a recovered pipeline would
        // silently return the unprocessed input on the next tick.
        if let cacheKey {
            sceneLinearChainCache.put(cacheKey, wrapped)
        }
        return wrapped
    }

    // MARK: Fused chain + display encode (#2092, follow-on to #1959 / PR #2083)

    /// Fused per-tick path: `applySceneLinearChainViaFFI` followed by
    /// `encodeDisplaySRGBViaFFI` in ONE FFI call
    /// (`maple_apply_chain_and_encode_display_f32`), over ONE input buffer,
    /// producing the FINAL sRGB-gamma-encoded CIImage directly — no
    /// intermediate CIImage wrap, no second `CIContext.render` readback.
    ///
    /// Valid whenever nothing runs between the chain and the encode this
    /// tick — which, since #1043, is always. The gap used to hold
    /// `MetalKernels.applySceneSharpen` + `applySceneNRColor`, so callers had
    /// to gate on both sliders being within `1e-3` of zero, and at the
    /// reference-import defaults (`sharpenAmount: 40, nrColor: 25`, #1933)
    /// that gate essentially never held. Those kernels are gone and the Rust
    /// chain runs both stages internally, so the fused path is now reachable
    /// at any slider state. The Auto Profile `CIColorCube` was never in the
    /// gap — it applies AFTER the encode, via `applyAutoCubeIfEncoded`.
    ///
    /// Also reuses `ffiInputBufferCache` (#1959/#2083) exactly like
    /// `applySceneLinearChainViaFFI` — same key, same weak identity anchor,
    /// same #2042 bounded-target gate via `decodedSource`.
    ///
    /// Deliberately does NOT consult/populate `sceneLinearChainCache` (#661):
    /// that cache stores the CHAIN-ONLY (pre-encode) CIImage, which this
    /// function never materialises. Callers must therefore check that cache
    /// FIRST and only reach this function on a miss — reusing a #661 HIT is
    /// strictly cheaper (skips the FFI entirely) than any fusion. See the
    /// call sites in `processSceneLinear` / `processSceneLinearNonRaw`.
    ///
    /// Returns `nil` on any failure (degenerate extent, render failure, FFI
    /// error) — the caller falls back to the existing two-step sequence,
    /// which has its own well-tested partial-failure fallback behaviour.
    /// This function does not attempt to replicate that fallback nuance
    /// itself (chain-stage failure vs encode-stage failure resolve to
    /// different fallback images in the two-step path); on ANY fused failure
    /// the caller simply re-derives the result via the two-step calls.
    nonisolated private func applyChainAndEncodeViaFusedFFI(
        _ scaled: CIImage,
        model: AdjustmentModel,
        decodedTemperature: Double,
        decodedTint: Double,
        wbFrame: WbSliderFrame? = nil,
        skipAgX: Bool,
        noiseProfile: [Float]? = nil,
        iso: UInt32 = 0,
        decodedSource: CIImage?
    ) -> CIImage? {
        let extent = scaled.extent
        let w = Int(extent.width.rounded())
        let h = Int(extent.height.rounded())
        guard w > 0, h > 0 else { return nil }

        let bytesPerPixel = 16 // 4 f32 lanes
        let rowBytes = w * bytesPerPixel
        let totalBytes = rowBytes * h
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!

        let params = PipelineRenderer.makeParams(
            from: model,
            decodedTemperature: decodedTemperature,
            decodedTint: decodedTint,
            skipAgX: skipAgX,
            iso: iso,
            wbFrame: wbFrame
        )

        // Same input-readback cache check as `applySceneLinearChainViaFFI` —
        // see that function's #1959 comment for the correctness argument.
        let inputCacheKey: FFIInputBufferCache.Key? = decodedSource.map { d in
            FFIInputBufferCache.Key(decodedID: ObjectIdentifier(d), width: w, height: h)
        }

        // Same #2042 autoreleasepool reasoning as `applySceneLinearChainViaFFI`
        // / `encodeDisplaySRGBViaFFI` — bounds the input readback buffer's
        // lifetime to this call, before the (single) output buffer here.
        return autoreleasepool {
            let inputBytes: Data
            if let inputCacheKey, let decodedSource,
               let cachedBytes = ffiInputBufferCache.get(inputCacheKey, decoded: decodedSource) {
                inputBytes = cachedBytes
            } else {
                var freshBytes = Data(count: totalBytes)
                let renderSucceeded: Bool = freshBytes.withUnsafeMutableBytes { buf -> Bool in
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
                    logger.error("applyChainAndEncodeViaFusedFFI: CIContext.render failed; falling through")
                    return nil
                }
                if let inputCacheKey, let decodedSource {
                    ffiInputBufferCache.put(inputCacheKey, freshBytes, decoded: decodedSource)
                }
                inputBytes = freshBytes
            }

            let outputBytes: Data
            do {
                outputBytes = try mapleStage("fused chain+encode") {
                    try PipelineRenderer.applyChainAndEncodeDisplay(
                        inputBytes: inputBytes, width: w, height: h, params: params,
                        noiseProfile: noiseProfile
                    )
                }
            } catch {
                logger.error("applyChainAndEncodeViaFusedFFI: FFI error: \(error.localizedDescription, privacy: .public)")
                return nil
            }

            // Output is sRGB-gamma-encoded sRGB-primary f32 RGBA — same
            // tagging as `encodeDisplaySRGBViaFFI`'s successful result.
            return mapleStage("fused chain+encode CIImage build") {
                CIImage(
                    bitmapData: outputBytes,
                    bytesPerRow: rowBytes,
                    size: CGSize(width: w, height: h),
                    format: .RGBAf,
                    colorSpace: Self.displayEncodedColorSpace
                )
            }
        }
    }

    // MARK: Display encode (Rec.2020 → sRGB Oklab gamut compression) — #877

    /// Color space the gamut-correct display encode (`encodeDisplaySRGBViaFFI`)
    /// hands back: **sRGB-gamma-encoded sRGB-primary**. CoreImage reads this
    /// tag and converts sRGB → the canvas output (P3) WITHOUT a Rec.2020→sRGB
    /// per-channel clamp — that clamp is exactly the #871/#877 wide-gamut-green
    /// blowout, and `encodeDisplaySRGBViaFFI` has already replaced it with
    /// raw-core's hue-preserving Oklab compression.
    nonisolated public static let displayEncodedColorSpace =
        CGColorSpace(name: CGColorSpace.sRGB)!

    /// Apply raw-core's canonical display encode (#877) to a post-AgX
    /// **display-linear Rec.2020** CIImage: materialise it to f32 RGBA, hand
    /// it to the `maple_encode_display_srgb_f32` FFI (Oklab gamut compression
    /// + sRGB gamma — the EXACT stages the CPU/CLI reference runs between AgX
    /// and the Auto Profile cube), and wrap the result back into a CIImage
    /// tagged `sRGB`.
    ///
    /// This makes the Apple canvas gamut-correct for wide-gamut content by
    /// construction: it shares raw-core's reference math instead of relying on
    /// CoreImage's implicit per-channel-clamp Rec.2020→sRGB conversion at the
    /// `createCGImage` boundary. It runs for BOTH `Profile::Neutral` (gamut-
    /// correct base) and `Profile::Auto` (the cube then applies on the matching
    /// sRGB-encoded domain).
    ///
    /// Returns `nil` on any failure (degenerate extent, `CIContext.render`
    /// failure, or FFI error). A `nil` result is **load-bearing**: the encode
    /// and the sRGB-tagged Auto cube must travel together. The caller MUST NOT
    /// apply the sRGB cube to the un-encoded (still Rec.2020-tagged) input on
    /// failure — that color-space mismatch is exactly the #871/#877 wide-gamut
    /// blowout on the error path. On `nil`, the caller falls back to the plain
    /// Rec.2020 buffer with NO cube (behaving like `Profile::Neutral`), so
    /// CoreImage's own Rec.2020→canvas conversion runs coherently. See
    /// `applyAutoCubeIfEncoded`.
    nonisolated private func encodeDisplaySRGBViaFFI(_ input: CIImage) -> CIImage? {
        let extent = input.extent
        let w = Int(extent.width.rounded())
        let h = Int(extent.height.rounded())
        guard w > 0, h > 0 else {
            logger.error("encodeDisplaySRGBViaFFI: degenerate extent \(w)x\(h); no encode")
            return nil
        }

        let bytesPerPixel = 16 // 4 f32 lanes
        let rowBytes = w * bytesPerPixel
        let totalBytes = rowBytes * h
        // Materialise the post-AgX display-linear Rec.2020 buffer.
        let rec2020 = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!

        // #2042 — same round-trip shape (and same ~GB-scale overlap risk)
        // as `applySceneLinearChainViaFFI` above: `inputBytes` (the
        // rendered `input` CIImage) and `outputBytes` (the FFI result)
        // are both ~totalBytes. By the time THIS function is entered, the
        // scene-linear chain's own round trip has already returned (its
        // autoreleasepool already drained), so its buffers are gone —
        // this pool's job is to make sure THIS stage's `inputBytes` (plus
        // any autoreleased CoreImage/Foundation scratch) doesn't linger
        // into whatever the caller does next (`MapleExporter`'s encode,
        // or the live-canvas publish).
        return autoreleasepool {
            var inputBytes = Data(count: totalBytes)
            let renderSucceeded: Bool = inputBytes.withUnsafeMutableBytes { buf -> Bool in
                guard let base = buf.baseAddress else { return false }
                context.render(
                    input,
                    toBitmap: base,
                    rowBytes: rowBytes,
                    bounds: CGRect(x: 0, y: 0, width: w, height: h),
                    format: .RGBAf,
                    colorSpace: rec2020
                )
                return true
            }
            guard renderSucceeded else {
                logger.error("encodeDisplaySRGBViaFFI: CIContext.render failed; no encode")
                return nil
            }

            let outputBytes: Data
            do {
                outputBytes = try mapleStage("encode display sRGB (Oklab gamut)") {
                    try PipelineRenderer.encodeDisplaySRGB(
                        inputBytes: inputBytes, width: w, height: h
                    )
                }
            } catch {
                logger.error("encodeDisplaySRGBViaFFI: FFI error: \(error.localizedDescription, privacy: .public)")
                return nil
            }
            // `inputBytes` dies at this closure's scope exit (the
            // autoreleasepool boundary), not merely "whenever ARC gets
            // around to it" — see the comment on the sibling round trip.

            // The bytes are now sRGB-gamma-encoded sRGB-primary f32 RGBA —
            // tag the CIImage sRGB so CoreImage does no further gamut clamp.
            return mapleStage("display sRGB CIImage build") {
                CIImage(
                    bitmapData: outputBytes,
                    bytesPerRow: rowBytes,
                    size: CGSize(width: w, height: h),
                    format: .RGBAf,
                    colorSpace: Self.displayEncodedColorSpace
                )
            }
        }
    }

    /// Resolve the final display image, enforcing the **encode + cube travel
    /// together** invariant (#877 error-path fix).
    ///
    /// `encoded` is the result of `encodeDisplaySRGBViaFFI`: a non-nil
    /// sRGB-gamma-encoded sRGB-primary CIImage on success, or `nil` when the
    /// gamut-correct encode failed. `fallback` is the un-encoded, still
    /// **Rec.2020-tagged** display-linear image (the encode's input).
    ///
    /// On success the sRGB-tagged Auto cube applies on its matching
    /// sRGB-encoded domain. On encode failure we return the Rec.2020 `fallback`
    /// **without** the cube — applying the sRGB cube to a Rec.2020 buffer is a
    /// color-space mismatch that reintroduces the #871/#877 wide-gamut blowout.
    /// Dropping to the cube-less Rec.2020 buffer mirrors `Profile::Neutral` and
    /// lets CoreImage do its own coherent Rec.2020→canvas conversion.
    ///
    /// Pure (no `self`/actor state) so the invariant is unit-testable without
    /// forcing an FFI failure — see `AutoProfileCanvasParityTests`.
    nonisolated static func applyAutoCubeIfEncoded(
        encoded: CIImage?,
        fallback: CIImage,
        profileLUT: CIFilter?
    ) -> CIImage {
        guard let encoded else {
            // Encode failed: NO cube on the Rec.2020 buffer (Neutral fallback).
            return fallback
        }
        return AutoProfileLUT.apply(profileLUT, to: encoded)
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
        targetSize: CGSize? = nil,
        assetID: UUID? = nil
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
        // #2092 — fused chain+encode fast path. Nothing runs between the
        // chain and the encode any more (#1043 retired the intervening
        // Metal sharpen / nr_color kernels), so the only remaining gate is
        // that the #661 `sceneLinearChainCache` would MISS anyway (a HIT
        // there is strictly cheaper: it skips the FFI entirely). Bounded to
        // `targetSize != nil` to match the #2042 input-cache gate below.
        if !Self.fusedChainEncodeDisabled, targetSize != nil {
            let extent = scaled.extent
            let w = Int(extent.width.rounded())
            let h = Int(extent.height.rounded())
            if w > 0, h > 0 {
                let wouldMissChainCache: Bool = {
                    guard let assetID else { return true }
                    let key = SceneLinearChainCache.make(
                        assetID: assetID, model: model,
                        decodedTemperature: 6500.0, decodedTint: 0.0,
                        skipAgX: true, width: w, height: h, wbFrame: nil
                    )
                    return sceneLinearChainCache.get(key) == nil
                }()
                if wouldMissChainCache,
                   let fusedEncoded = applyChainAndEncodeViaFusedFFI(
                       scaled, model: model,
                       decodedTemperature: 6500.0, decodedTint: 0.0,
                       skipAgX: true,
                       decodedSource: decoded
                   ) {
                    return fusedEncoded
                }
            }
        }

        // #1959/#2042 — the input-readback cache is gated to BOUNDED
        // (non-nil `targetSize`) renders: slider drag ticks always carry a
        // viewport target, while the full-res paths (`renderForExport`,
        // `RenderActor.renderPreview`) pass `targetSize: nil` and would
        // otherwise `put` a full-resolution f32 buffer (~1.6 GB at 100 MP)
        // into the single slot, retained until the next put — directly
        // against the #2042 export-memory bounding. Passing `nil` here
        // skips both the cache lookup AND the populate.
        let chained = applySceneLinearChainViaFFI(
            scaled, model: model,
            decodedTemperature: 6500.0, decodedTint: 0.0,
            skipAgX: true,
            assetID: assetID,
            decodedSource: targetSize != nil ? decoded : nil
        )

        // Sharpen + nr_color now run INSIDE `chained` — the per-tick Rust
        // chain applies them at their canonical scene-linear positions
        // (#1043 retired the post-AgX Metal kernels that used to sit here).
        // Display encode (#877) — same gamut-correct Rec.2020→sRGB (Oklab) +
        // gamma the RAW path uses, replacing CoreImage's implicit per-channel
        // clamp at the canvas boundary. Non-RAW input is already sRGB-gamut
        // content promoted into the Rec.2020 working space, so this is the
        // matching encode and keeps the non-RAW canvas consistent with the
        // RAW canvas (both tag the result `sRGB`). On encode failure fall back
        // to the Rec.2020 buffer (no cube on this path) — CoreImage then does
        // its own coherent Rec.2020→canvas conversion.
        return encodeDisplaySRGBViaFFI(chained) ?? chained
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
    /// call site in the live canvas view (originally `FullImageView`'s
    /// `CIImageView`, now `CanvasImageView`; forced to sRGB output by Task 4
    /// Step 4.0b). The encode is therefore exactly once, outside the
    /// development chain, and deterministic.
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
    /// `wbFrame` (#1781): the decode-exported WB slider frame. When present
    /// the chain's WB delta is derived with the frame's own calibration —
    /// anchored, like the frame-absent path, at the caller's `asShot`
    /// (`wbDeltaAnchor`: the frame's as-shot pair, the WB the strip-XMP
    /// decode actually baked — #1976) — so this CPU tick path agrees with
    /// both the GPU live chain and a fresh full develop of the same model.
    /// `nil` keeps the legacy asShot-anchored generic delta bit-for-bit.
    nonisolated public func processSceneLinear(
        decoded: CIImage,
        model: AdjustmentModel,
        targetSize: CGSize? = nil,
        asShot: AsShotWB? = nil,
        decodedAtModel: AdjustmentModel? = nil,
        profileLUT: CIFilter? = nil,
        assetID: UUID? = nil,
        noiseProfile: [Float]? = nil,
        iso: UInt32 = 0,
        wbFrame: WbSliderFrame? = nil
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
        //   1. The FFI scene-linear decode OMITS the WB fields from the
        //      strip XMP (`omitWhiteBalance`, #1883), so raw-core resolves
        //      the develop at the image's As-Shot WB. The cached buffer is
        //      the as-shot develop (post-DCP reference) regardless of
        //      sidecar contents. This eliminates the "first-open at
        //      as-shot, post-sidecar at user-temp" inconsistency that
        //      surfaced as a magenta cast on every slider write.
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
        // #1976: the anchor is `asShot` (the caller's `wbDeltaAnchor` — the
        // frame's as-shot pair when a frame is present) in BOTH branches:
        // the strip-XMP decode omits WB, so the buffer is always an
        // as-shot develop. The old frame-present override to an explicit
        // 6500/0 described a warm develop that never existed post-#1894
        // and overcooled every settled render into cyan.
        let frame = (wbFrame?.isPresent == true) ? wbFrame : nil
        let decodedTemp = asShot?.temperature ?? 6500.0
        let decodedTint = asShot?.tint ?? 0.0
        if let asShot {
            logger.notice("processSceneLinear asShot=\(asShot.temperature, format: .fixed(precision: 0))K/\(asShot.tint, format: .fixed(precision: 1)) live=\(model.temperature, format: .fixed(precision: 0))K/\(model.tint, format: .fixed(precision: 1)) → decodedTemp=\(decodedTemp, format: .fixed(precision: 0))")
        } else {
            logger.notice("processSceneLinear asShot=NIL live=\(model.temperature, format: .fixed(precision: 0))K/\(model.tint, format: .fixed(precision: 1)) → decodedTemp=\(decodedTemp, format: .fixed(precision: 0))")
        }

        // #2092 — fused chain+encode fast path. Nothing runs between the
        // chain and the encode any more (#1043 retired the intervening
        // Metal sharpen / nr_color kernels), so the only remaining gate is
        // that the #661 `sceneLinearChainCache` would MISS anyway (a HIT
        // there is strictly cheaper: it skips the FFI entirely). Bounded to
        // `targetSize != nil` to match the #2042 input-cache gate below. On
        // success, the Auto Profile cube (if any) is the ONLY remaining step
        // — it applies AFTER the encode either way, fused or not, so
        // applying it here to `fusedEncoded` matches
        // `applyAutoCubeIfEncoded`'s success branch exactly.
        if !Self.fusedChainEncodeDisabled, targetSize != nil {
            let extent = scaled.extent
            let w = Int(extent.width.rounded())
            let h = Int(extent.height.rounded())
            if w > 0, h > 0 {
                let wouldMissChainCache: Bool = {
                    guard let assetID else { return true }
                    let key = SceneLinearChainCache.make(
                        assetID: assetID, model: model,
                        decodedTemperature: decodedTemp, decodedTint: decodedTint,
                        skipAgX: false, width: w, height: h, wbFrame: frame
                    )
                    return sceneLinearChainCache.get(key) == nil
                }()
                if wouldMissChainCache,
                   let fusedEncoded = applyChainAndEncodeViaFusedFFI(
                       scaled, model: model,
                       decodedTemperature: decodedTemp, decodedTint: decodedTint,
                       wbFrame: frame,
                       skipAgX: false,
                       noiseProfile: noiseProfile,
                       iso: iso,
                       decodedSource: decoded
                   ) {
                    return AutoProfileLUT.apply(profileLUT, to: fusedEncoded)
                }
            }
        }

        // #1959/#2042 — the input-readback cache is gated to BOUNDED
        // (non-nil `targetSize`) renders: slider drag ticks always carry a
        // viewport target, while the full-res paths (`renderForExport`,
        // `RenderActor.renderPreview`) pass `targetSize: nil` and would
        // otherwise `put` a full-resolution f32 buffer (~1.6 GB at 100 MP)
        // into the single slot, retained until the next put — directly
        // against the #2042 export-memory bounding. Passing `nil` here
        // skips both the cache lookup AND the populate.
        let chained = applySceneLinearChainViaFFI(
            scaled, model: model,
            decodedTemperature: decodedTemp, decodedTint: decodedTint,
            wbFrame: frame,
            skipAgX: false,
            assetID: assetID,
            noiseProfile: noiseProfile,
            iso: iso,
            decodedSource: targetSize != nil ? decoded : nil
        )

        // sharpen + nr_color are INSIDE `chained` (#1043). They used to run
        // here as post-AgX Metal kernels, i.e. in display-linear Rec.2020
        // rather than the scene-linear domain the reference (Rust CPU)
        // pipeline runs them in — a deliberate domain change bought to keep
        // sharpen (~33 ms / 2 MP on CPU) off the slider tick. With the
        // wgpu/WGSL chain shipping as the default GPU path, that trade is
        // no longer worth its cost: the Metal kernels were the last copy of
        // render math outside Rust + WGSL, and the domain shift was
        // exercised on nearly every image (the reference-import defaults are
        // sharpenAmount = 40 and nrColor = 25). Both stages now run once, in
        // the Rust chain, at develop's canonical scene-linear position — the
        // same position the GPU chain uses — so this CPU path is once again
        // a faithful oracle for it. The tick-budget cost lands only on the
        // fallback; the GPU path is the one held to 16 ms.
        // Display encode (#877) — the EXACT raw-core view-encode the CPU/CLI
        // reference runs between AgX and the Auto Profile cube:
        // `rec2020_to_srgb` (hue-preserving Oklab gamut compression, #438) +
        // `srgb_gamma_encode`. Runs for BOTH profiles. This replaces the
        // implicit, per-channel-CLAMPED Rec.2020→sRGB conversion CoreImage
        // used to do at the `createCGImage` boundary — that clamp drove
        // saturated wide-gamut greens up / blue to zero and diverged from the
        // reference (#871's `_MG_3620` blowout). After this op the buffer is
        // sRGB-gamma-encoded sRGB-primary [0,1], tagged `sRGB`, so:
        //   * Neutral is gamut-correct (no green clip), matching the CLI.
        //   * the Auto cube below applies on its matching sRGB-encoded domain
        //     (no clamp inside the cube's color management).
        //   * the canvas raster (`createCGImage(displayP3)`) converts
        //     sRGB → P3 with all values in-gamut — nothing clips.
        let encoded = encodeDisplaySRGBViaFFI(chained)
        // Auto Profile (#812) — the LAST display-space op, matching the CPU
        // path's `auto_profile` → quantize order. `profileLUT` is a
        // CIColorCubeWithColorSpace tagged sRGB; on a successful encode its
        // input is already in that exact space, so CoreImage's cube color
        // management is a no-op convert. Nil for `Profile::Neutral` — the
        // canvas then renders the gamut-correct AgX+encode output. The caller
        // resolves + caches the cube per image via `AutoProfileLUT` so this is
        // never a per-tick cost.
        //
        // #877 error-path safety: the sRGB cube and the sRGB encode travel
        // together. If the encode FAILED (`encoded == nil`), applying the
        // sRGB-tagged cube to the un-encoded Rec.2020 buffer would be a
        // color-space mismatch that reintroduces the wide-gamut blowout —
        // `applyAutoCubeIfEncoded` drops to the cube-less Rec.2020 fallback
        // (Neutral) instead.
        return Self.applyAutoCubeIfEncoded(
            encoded: encoded, fallback: chained, profileLUT: profileLUT
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

    // MARK: Materialise a region (visible-rect refine)

    /// Force CoreImage to materialise `image` over the given `rect` into
    /// a CGImage using the pipeline's Metal-backed context. Equivalent
    /// to `CIContext.createCGImage(image, from: rect, format:colorSpace:)`,
    /// exposed so EditSession's visible-region refine path can reuse the
    /// shared context (avoids spinning up a sibling Metal command queue
    /// per slider tick).
    ///
    /// Output format is `RGBAf` + **sRGB** (#877). The `processSceneLinear`
    /// output is now sRGB-gamma-encoded sRGB-primary (the gamut-correct
    /// `encodeDisplaySRGBViaFFI` is the final develop-chain op — see #877),
    /// tagged `sRGB`. Materialising in the same `sRGB` space keeps the refine
    /// path byte-consistent with the live `CIImageView` path: both hand
    /// CoreImage an sRGB image and let it convert sRGB → the canvas's P3 at
    /// raster, with every value in-gamut so nothing clips. (Pre-#877 this
    /// materialised to extended-linear Rec.2020 because the chain output was
    /// still display-linear Rec.2020 and CoreImage did the Rec.2020→sRGB
    /// per-channel-clamp encode at `createCGImage` — that clamp was the
    /// wide-gamut-green blowout the encode now fixes upstream.)
    nonisolated public func materializeRegion(
        _ image: CIImage,
        rect: CGRect
    ) -> CGImage? {
        let cs = Self.displayEncodedColorSpace
        return context.createCGImage(image, from: rect, format: .RGBAf, colorSpace: cs)
    }

    // MARK: Prescale helper (tiling-friendly)

    /// Lanczos-downscale `input` to fit within `targetSize` (aspect
    /// preserved). Never upscales; returns `input` unchanged when the ratio
    /// would be ≥ 0.99. Ported from Maple reference — the CIImage returned
    /// is lazy, so the downscale and the filter chain fuse into a single
    /// render plan and the full-res intermediate never materialises.
    // `internal` (not `private`) so the gpu-gated `ImageEditPipeline+GpuLive`
    // extension can compute the same post-prescale extent the GPU upload uses.
    nonisolated static func prescaleForDisplay(
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
