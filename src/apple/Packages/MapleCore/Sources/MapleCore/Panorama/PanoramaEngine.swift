// PanoramaEngine.swift — async facade for the panorama pipeline (T5.3 + T5.7).
//
// Composes:
//   PanoramaSource (loads bytes from any ImageSource-compatible store)
//   → [Quality preset] PanoHandle.stitch (Rust core via the Apple FFI, sync + heavy)
//     → PanoramaExport.toCIImage (copies the f16 buffer into a CIImage tagged
//       with the Rec.2020 D65 color space the Rust core actually emits)
//   → [Quick preset]   QuickPreset.stitch (Vision + CoreImage; JPEG/HEIF only;
//       Apple-platform only — see QuickPreset.swift for trade-off notes)
//
// Preset dispatch (T5.7):
//   `stitch(assets:options:preset:progress:)` is the canonical entry point.
//   The legacy `stitch(assets:options:progress:)` overload defaults to `.quality`
//   for backwards compatibility.
//
// Threading model:
//   - `stitch(assets:progress:)` is an `async` method callable from any
//     concurrency context.
//   - The synchronous Rust call (`PanoHandle.stitch`) is run on a detached
//     Task at `.userInitiated` priority so it doesn't block the cooperative
//     thread pool.
//   - `progress` is a `@Sendable` closure so it can be captured by the
//     detached Task and called from any isolation context.
//
// Adaptation notes vs. task brief:
//   - `ImageAsset` → `ImageRef` (actual Swift type in this codebase).
//   - `LibrarySource` → `ImageSource` (actual protocol name).

import CoreImage
import Foundation

// MARK: - PanoramaPreset

/// Selects which stitching backend `PanoramaEngine` uses.
///
/// - `.quality`: Default. Routes through the Rust core via `PanoHandle.stitch`.
///   Accepts any format (JPEG, PNG, DNG, HEIF). Uses CPU-based ORB feature
///   detection, graph-cut seams, and scene-linear Rec.2020 f16 output.
/// - `.quick`: Apple-platform-only fast path via Vision + CoreImage.
///   Accepts JPEG and HEIF only (DNG → `QuickPresetError.unsupportedInputFormat`).
///   Uses `VNImageHomographicAlignmentRequest` for alignment and
///   `CIBlendWithMask` for compositing. Output is display-referred sRGB
///   (not linear Rec.2020). Faster than `.quality`; lower seam quality.
public enum PanoramaPreset: Sendable {
    /// Rust core via `PanoHandle` (existing default). Accepts all formats.
    case quality
    /// Apple Vision + CoreImage. JPEG / HEIF only. Apple-platform only.
    case quick
}

// MARK: - PanoramaProgress

/// Progress events fired by `PanoramaEngine.stitch(assets:progress:)`.
///
/// Callers collect these in order to drive a determinate progress indicator:
///   1. A sequence of `.loading(loaded:total:)` events (one per asset loaded,
///      starting at loaded=0 and ending at loaded=total).
///   2. A single `.stitching` event when the Rust FFI call begins.
///   3. A single `.wrappingCIImage` event when the CIImage wrap begins.
public enum PanoramaProgress: Sendable, Equatable {
    /// `loaded` assets have been fetched; `total` is the full count.
    case loading(loaded: Int, total: Int)
    /// The Rust stitching call is about to start.
    case stitching
    /// The f16 buffer is being wrapped in a `CIImage`.
    case wrappingCIImage
}

// MARK: - PanoramaEngineError

public enum PanoramaEngineError: LocalizedError, Sendable {
    /// A `PanoramaSourceError` was thrown while loading input bytes.
    case sourceFailed(PanoramaSourceError)
    /// `PanoHandle.stitch` threw a `StitchError`.
    case stitchFailed(PanoHandle.StitchError)
    /// `PanoramaExport.toCIImage` could not wrap the buffer.
    case ciImageWrapFailed(String)

    public var errorDescription: String? {
        switch self {
        case .sourceFailed(let e):
            return "Panorama source error: \(e.localizedDescription)"
        case .stitchFailed(let e):
            return "Panorama stitch failed: \(e.localizedDescription)"
        case .ciImageWrapFailed(let msg):
            return "Panorama CIImage wrap failed: \(msg)"
        }
    }
}

// MARK: - PanoramaEngine

/// High-level async panorama facade.
///
/// Usage:
/// ```swift
/// let source = PanoramaSource(library: myImageSource)
/// let engine = PanoramaEngine(source: source)
/// let image  = try await engine.stitch(assets: refs) { progress in
///     updateUI(progress)
/// }
/// ```
///
/// `PanoramaEngine` is `@unchecked Sendable` because it holds a
/// `PanoramaSource` actor reference, which is itself Sendable, and it
/// carries no mutable state of its own.
public final class PanoramaEngine: @unchecked Sendable {
    private let source: PanoramaSource

    public init(source: PanoramaSource) {
        self.source = source
    }

    // MARK: - Public API

    /// Stitch a list of assets into a `CIImage` using the **Quality** preset.
    ///
    /// This overload exists for backwards compatibility; it forwards to
    /// `stitch(assets:options:preset:progress:)` with `preset: .quality`.
    ///
    /// Progress events fire at each stage boundary in this order:
    ///   `.loading(loaded: 0, total: N)` through
    ///   `.loading(loaded: N, total: N)` (one per asset),
    ///   `.stitching`,
    ///   `.wrappingCIImage`.
    ///
    /// - Parameters:
    ///   - assets:   Two or more `ImageRef` values in shooting order.
    ///   - options:  Stitching parameters. Defaults to cylindrical projection.
    ///   - progress: Optional `@Sendable` callback; fired at each stage.
    /// - Returns:    A `CIImage` with the stitched panorama in linear Rec.2020
    ///               D65 color space.
    /// - Throws:     `PanoramaEngineError` on load, stitch, or wrap failures.
    public func stitch(
        assets: [ImageRef],
        options: PanoramaOptions = .default,
        progress: (@Sendable (PanoramaProgress) -> Void)? = nil
    ) async throws -> CIImage {
        try await stitch(assets: assets, options: options, preset: .quality, progress: progress)
    }

    /// Stitch a list of assets into a `CIImage` with explicit preset selection.
    ///
    /// - Parameters:
    ///   - assets:   Two or more `ImageRef` values in shooting order.
    ///   - options:  Stitching parameters. Defaults to cylindrical projection.
    ///   - preset:   `.quality` (Rust core, default) or `.quick` (Vision + CoreImage,
    ///               Apple-platform only, JPEG/HEIF inputs only).
    ///   - progress: Optional `@Sendable` callback; fired at each stage.
    ///               Note: the Quick preset fires `.loading` events but not
    ///               `.stitching` / `.wrappingCIImage` (those are Quality-preset stages).
    /// - Returns:    A `CIImage`. Quality preset: linear Rec.2020 D65.
    ///               Quick preset: display-referred sRGB.
    /// - Throws:     `PanoramaEngineError` (Quality) or `QuickPresetError` (Quick).
    public func stitch(
        assets: [ImageRef],
        options: PanoramaOptions = .default,
        preset: PanoramaPreset,
        progress: (@Sendable (PanoramaProgress) -> Void)? = nil
    ) async throws -> CIImage {
        // 1. Load bytes for all presets.
        let loaded = try await loadAssets(assets, progress: progress)
        let imageDataArray = loaded.map { $0.0 }

        switch preset {
        case .quality:
            return try await stitchQuality(imageDataArray, options: options, progress: progress)
        case .quick:
            return try await QuickPreset.stitch(images: imageDataArray, options: options)
        }
    }

    // MARK: - Private

    /// Quality preset: route to Rust core via PanoHandle.
    private func stitchQuality(
        _ imageDataArray: [Data],
        options: PanoramaOptions,
        progress: (@Sendable (PanoramaProgress) -> Void)?
    ) async throws -> CIImage {
        // Stitch on a background Task — the Rust call is sync + heavy.
        progress?(.stitching)
        let handle: PanoHandle
        do {
            let capturedOptions = options
            handle = try await Task.detached(priority: .userInitiated) {
                try PanoHandle.stitch(images: imageDataArray, options: capturedOptions)
            }.value
        } catch let e as PanoHandle.StitchError {
            throw PanoramaEngineError.stitchFailed(e)
        } catch {
            // Should not happen — stitch only throws StitchError — but guard
            // anyway to avoid a bare rethrow from a detached Task context.
            throw PanoramaEngineError.stitchFailed(.stitchFailure)
        }

        // Wrap the f16 buffer in a CIImage.
        progress?(.wrappingCIImage)
        do {
            return try PanoramaExport.toCIImage(handle: handle, options: options)
        } catch let e as PanoramaEngineError {
            throw e
        } catch {
            throw PanoramaEngineError.ciImageWrapFailed(error.localizedDescription)
        }
    }

    private func loadAssets(
        _ assets: [ImageRef],
        progress: (@Sendable (PanoramaProgress) -> Void)?
    ) async throws -> [(Data, Data?)] {
        // Sequential loading for the MVP; parallel TaskGroup is a follow-up.
        var out: [(Data, Data?)] = []
        out.reserveCapacity(assets.count)

        for (i, asset) in assets.enumerated() {
            progress?(.loading(loaded: i, total: assets.count))
            do {
                let pair = try await source.loadAll(assets: [asset])
                out.append(contentsOf: pair)
            } catch let e as PanoramaSourceError {
                throw PanoramaEngineError.sourceFailed(e)
            } catch {
                // source.loadAll only throws PanoramaSourceError, but forward
                // any unexpected error as a source failure.
                throw PanoramaEngineError.sourceFailed(
                    PanoramaSourceError.loadFailed(asset.displayName, underlying: error)
                )
            }
        }

        progress?(.loading(loaded: assets.count, total: assets.count))
        return out
    }
}
