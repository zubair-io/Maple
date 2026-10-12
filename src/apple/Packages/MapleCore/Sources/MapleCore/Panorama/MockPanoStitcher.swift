// MockPanoStitcher.swift — Test double for PanoStitching.
//
// Walks all pipeline stages with realistic delays, emits progress callbacks,
// then writes a placeholder TIFF to a temp URL. Makes the full M1+M2 UI
// demoable with no Rust FFI dependency.
//
// This is a labeled test double (not a stub): it produces observable
// side-effects (progress events, a real file on disk) so the UI can exercise
// all states end-to-end.
//
// Ticket: #1236 / Part of #1234

import Foundation
import CoreGraphics
import ImageIO
#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

// MARK: - MockPanoStitcher

/// Test double for `PanoStitching`.
///
/// Thread-safety note: `cancelledFlag` is accessed from two methods — `cancel()`
/// and `stitch(_:options:progress:)`. In practice `cancel()` is called on the
/// `@MainActor` (from `PanoMergeSession`) while `stitch` suspends on a
/// cooperative thread. The flag is only ever written from one direction at a
/// time (stitch resets it at entry; cancel sets it during the run), so
/// nonisolated(unsafe) is sound here. The real FFI impl (M4) will need a
/// proper actor or atomic; this mock keeps it simple.
public final class MockPanoStitcher: PanoStitching {
    // nonisolated(unsafe) satisfies Swift 6 Sendable: we document the locking
    // invariant above rather than paying the overhead of an actor or NSLock
    // for a test-only double with a single-writer pattern.
    nonisolated(unsafe) private var cancelledFlag: Bool = false

    public init() {}

    public func cancel() {
        cancelledFlag = true
    }

    public func stitch(
        assets: [AssetRef],
        options: PanoOptions,
        alignment: PanoAlignment?,
        progress: @escaping @MainActor (PanoStage, Double) -> Void
    ) async throws -> PanoResult {
        cancelledFlag = false
        let outcome = Self.outcome(offered: alignment, solved: Self.alignment(for: assets, options: options))
        let headDuration = outcome == .reused ? 0.0 : 1.0

        let allStages: [(PanoStage, Double, Int)] = [
            (.decoding,     headDuration * Double(assets.count) * 0.3, assets.count),
            (.matching,     headDuration * 1.2, 6),
            (.graph,        headDuration * 0.4, 4),
            (.solving,      1.5,  8),
            (.localAlign,   options.localAlign == .mesh ? 1.0 : 0.0, 5),
            (.compositing,  2.0, 10),
            (.writing,      0.5,  4),
        ]
        try await walk(allStages, progress: progress)

        let outputURL = try writePlaceholderPanorama(assetCount: assets.count)
        let summary = """
            Stitched \(assets.count) frames using \(options.strategy.rawValue) strategy. \
            Local align: \(options.localAlign.rawValue). Retention: \(options.retention.rawValue). \
            \(outcome.summary) [Mock result — no actual image processing was performed]
            """
        return PanoResult(outputURL: outputURL, reportSummary: summary, alignmentOutcome: outcome)
    }

    public func preview(
        assets: [AssetRef],
        options: PanoOptions,
        alignment: PanoAlignment?,
        progress: @escaping @MainActor (PanoStage, Double) -> Void
    ) async throws -> PanoPreview {
        cancelledFlag = false
        let solved = Self.alignment(for: assets, options: options)
        let outcome = Self.outcome(offered: alignment, solved: solved)
        let headDuration = outcome == .reused ? 0.0 : 1.0
        let stages: [(PanoStage, Double, Int)] = [
            (.decoding,    headDuration * 0.4, 4),
            (.matching,    headDuration * 0.6, 6),
            (.graph,       headDuration * 1.0, 8),
            (.localAlign,  0.3, 3),
            (.compositing, 0.5, 5),
        ]
        try await walk(stages, progress: progress)
        let image = try gradientImage(width: min(2048, 512 * assets.count), height: 512)
        return PanoPreview(image: image, alignment: solved, alignmentOutcome: outcome)
    }

    // MARK: - Private

    /// A stand-in alignment keyed on what the real key covers: the inputs
    /// and the geometry strategy. Retention and local alignment are
    /// composite-side options and do not invalidate it.
    private static func alignment(for assets: [AssetRef], options: PanoOptions) -> PanoAlignment {
        let key = assets.map(\.displayName).joined(separator: "|") + "#" + options.strategy.rawValue
        return PanoAlignment(json: Data(key.utf8))
    }

    private static func outcome(offered: PanoAlignment?, solved: PanoAlignment) -> PanoAlignmentOutcome {
        guard let offered else { return .solved }
        return offered == solved ? .reused : .stale(reason: "mock key changed")
    }

    private func walk(
        _ stages: [(PanoStage, Double, Int)],
        progress: @escaping @MainActor (PanoStage, Double) -> Void
    ) async throws {
        for (stage, duration, steps) in stages {
            guard !cancelledFlag else { throw CancellationError() }
            guard duration > 0 else {
                await MainActor.run { progress(stage, 1.0) }
                continue
            }
            let stepDuration = duration / Double(steps)
            for step in 0..<steps {
                guard !cancelledFlag else { throw CancellationError() }
                await MainActor.run { progress(stage, Double(step) / Double(steps)) }
                try await Task.sleep(for: .seconds(stepDuration))
            }
            await MainActor.run { progress(stage, 1.0) }
        }
        guard !cancelledFlag else { throw CancellationError() }
    }

    /// Write a simple grey gradient TIFF to a temp path as the mock output.
    private func writePlaceholderPanorama(assetCount: Int) throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("maple-pano-mock", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let outputURL = dir.appendingPathComponent("panorama-mock-\(UUID().uuidString).tiff")
        let cgImage = try gradientImage(width: min(4096, 1024 * assetCount), height: 512)

        guard let dest = CGImageDestinationCreateWithURL(outputURL as CFURL, "public.tiff" as CFString, 1, nil) else {
            throw MockPanoError.renderFailed
        }
        CGImageDestinationAddImage(dest, cgImage, nil)
        guard CGImageDestinationFinalize(dest) else { throw MockPanoError.renderFailed }
        return outputURL
    }

    private func gradientImage(width: Int, height: Int) throws -> CGImage {
        let bytesPerPixel = 4
        let bytesPerRow = width * bytesPerPixel
        let row: [UInt8] = (0..<width).flatMap { x -> [UInt8] in
            let t = UInt8(128 + Int(Double(x) / Double(width) * 80.0) - 40)
            return [t, t, t, 255]
        }
        var pixelData = Array((0..<height).map { _ in row }.joined())
        guard let ctx = CGContext(
            data: &pixelData,
            width: width, height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ), let cgImage = ctx.makeImage() else {
            throw MockPanoError.renderFailed
        }
        return cgImage
    }
}

// MARK: - MockPanoError

private enum MockPanoError: Error, LocalizedError {
    case renderFailed

    var errorDescription: String? {
        "Mock panorama render failed to produce an output image."
    }
}
