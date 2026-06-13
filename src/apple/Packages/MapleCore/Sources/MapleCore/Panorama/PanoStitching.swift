// PanoStitching.swift — Protocol seam for panorama stitching.
//
// Track 1 (this file): front-end only; wired to MockPanoStitcher.
// Track 2 will provide the real Rust FFI impl that satisfies this protocol.
//
// Ticket: #1236 / Part of #1234

import Foundation

// MARK: - PanoOptions

/// User-configurable options for a panorama stitch run.
/// Mirrors the CLI's --retention / --local-align / --strategy flags so the
// real FFI impl (M4) can pass these through without field mapping.
public struct PanoOptions: Sendable, Equatable {
    /// How aggressively to retain overlapping regions in the composite.
    public enum Retention: String, Sendable, CaseIterable {
        /// Prefer coverage — include a frame even when its overlap quality is
        /// marginal. Best for wide, thin-overlap sequences.
        case keep
        /// Exclude frames whose overlap quality falls below the solver threshold.
        /// Produces cleaner seams on high-overlap sequences.
        case strict
    }

    /// Local mesh-alignment pass after global bundle adjustment.
    public enum LocalAlign: String, Sendable, CaseIterable {
        /// Run the mesh warp pass (default). Corrects residual lens-roll and
        /// perspective drift that the global rotation solver doesn't capture.
        case mesh
        /// Skip mesh alignment. Faster; fine for sequences with negligible lens
        /// distortion or when the mesh pass artifacts (rare edge case).
        case off
    }

    /// Which geometry model to apply to the global bundle-adjustment pass.
    public enum Strategy: String, Sendable, CaseIterable {
        /// Let the solver pick based on feature graph topology (recommended).
        case auto
        /// Force pure rotation (no translation). Best for handheld pans taken
        /// from a fixed pivot point.
        case rotation
        /// Force flat-plane tiling. Best for copy-stand / flat-art sequences.
        case tile
    }

    public var retention: Retention = .keep
    public var localAlign: LocalAlign = .mesh
    public var strategy: Strategy = .auto

    public init(retention: Retention = .keep,
                localAlign: LocalAlign = .mesh,
                strategy: Strategy = .auto) {
        self.retention = retention
        self.localAlign = localAlign
        self.strategy = strategy
    }

    public static let `default` = PanoOptions()
}

// MARK: - PanoStage

/// Processing stages emitted during a stitch run, in order. Names match the
/// maple-cli `pano:` stage log prefix so the real FFI impl can map cleanly.
public enum PanoStage: String, Sendable, CaseIterable {
    /// Reading and decoding input RAW frames.
    case decoding
    /// Extracting and matching features across frame pairs.
    case matching
    /// Building the frame-overlap graph.
    case graph
    /// Global bundle-adjustment / rotation solving.
    case solving
    /// Local mesh warp (only when `PanoOptions.localAlign == .mesh`).
    case localAlign
    /// Stitching and blending the final panorama composite.
    case compositing
    /// Writing the output file.
    case writing

    /// Human-readable label shown in the progress view.
    public var displayName: String {
        switch self {
        case .decoding:     return "Decoding frames"
        case .matching:     return "Matching features"
        case .graph:        return "Building overlap graph"
        case .solving:      return "Solving geometry"
        case .localAlign:   return "Mesh alignment"
        case .compositing:  return "Compositing"
        case .writing:      return "Writing output"
        }
    }
}

// MARK: - PanoResult

/// Outcome of a successful stitch run.
public struct PanoResult: Sendable {
    /// File URL of the written panorama (TIFF or DNG).
    public let outputURL: URL
    /// One-paragraph human-readable summary produced by the stitcher.
    public let reportSummary: String

    public init(outputURL: URL, reportSummary: String) {
        self.outputURL = outputURL
        self.reportSummary = reportSummary
    }
}

// MARK: - PanoStitching

/// Protocol seam between the SwiftUI panorama UI and the stitching back-end.
///
/// Conforming types:
///   - `MockPanoStitcher` — test double used for UI development (this file's
///     companion, also in MapleCore/Panorama/).
///   - `RustPanoStitcher` — real FFI impl (M4, #1234). Must satisfy this
///     protocol exactly; no changes to the UI layer required.
///
/// Threading: called from `PanoMergeSession`, which is `@MainActor`-isolated.
/// Implementations MAY hop to a background executor internally, but must not
/// publish progress or throw from a non-sendable context.
public protocol PanoStitching: AnyObject, Sendable {
    /// Run a stitch.
    ///
    /// - Parameters:
    ///   - assets: Input frames in the order they should be stitched.
    ///     Minimum 2; the caller gates on `selectedIDs.count >= 2`.
    ///   - options: Tunable parameters for this run.
    ///   - progress: Called on the @MainActor as each stage starts / advances.
    ///     First argument is the current stage; second is 0–1 within that stage.
    ///     The caller is responsible for mapping stage completion to overall
    ///     progress if needed.
    /// - Returns: A `PanoResult` describing the output file and run summary.
    /// - Throws: Any error from the stitching pipeline.
    func stitch(
        assets: [AssetRef],
        options: PanoOptions,
        progress: @escaping @MainActor (PanoStage, Double) -> Void
    ) async throws -> PanoResult

    /// Request cancellation of the in-progress stitch. The running `stitch`
    /// call should throw `CancellationError` as soon as possible after this.
    /// Safe to call multiple times or when idle.
    func cancel()
}
