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
        progress: @escaping @MainActor (PanoStage, Double) -> Void
    ) async throws -> PanoResult {
        cancelledFlag = false

        // Stage schedule: (stage, durationSeconds, steps)
        // localAlign is skipped when options.localAlign == .off
        let allStages: [(PanoStage, Double, Int)] = [
            (.decoding,     Double(assets.count) * 0.3,  assets.count),
            (.matching,     1.2,  6),
            (.graph,        0.4,  4),
            (.solving,      1.5,  8),
            (.localAlign,   options.localAlign == .mesh ? 1.0 : 0.0, 5),
            (.compositing,  2.0, 10),
            (.writing,      0.5,  4),
        ]

        for (stage, duration, steps) in allStages {
            guard !cancelledFlag else { throw CancellationError() }
            guard duration > 0 else { continue }

            let stepDuration = duration / Double(steps)
            for step in 0..<steps {
                guard !cancelledFlag else { throw CancellationError() }
                let stageFraction = Double(step) / Double(steps)
                await MainActor.run { progress(stage, stageFraction) }
                try await Task.sleep(for: .seconds(stepDuration))
            }
            // Emit 1.0 completion for this stage.
            await MainActor.run { progress(stage, 1.0) }
        }

        guard !cancelledFlag else { throw CancellationError() }

        let outputURL = try writePlaceholderPanorama(assetCount: assets.count)

        let summary = """
            Stitched \(assets.count) frames using \(options.strategy.rawValue) strategy. \
            Local align: \(options.localAlign.rawValue). Retention: \(options.retention.rawValue). \
            [Mock result — no actual image processing was performed]
            """

        return PanoResult(outputURL: outputURL, reportSummary: summary)
    }

    // MARK: - Private

    /// Write a simple grey gradient TIFF to a temp path as the mock output.
    private func writePlaceholderPanorama(assetCount: Int) throws -> URL {
        // Panorama aspect ratio grows with frame count (rough approximation).
        let width = min(4096, 1024 * assetCount)
        let height = 512

        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("maple-pano-mock", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        let outputURL = dir.appendingPathComponent("panorama-mock-\(UUID().uuidString).tiff")

        // Build a wide grey gradient image as a stand-in.
        let bytesPerPixel = 4
        let bytesPerRow = width * bytesPerPixel
        var pixelData = [UInt8](repeating: 0, count: height * bytesPerRow)

        for y in 0..<height {
            for x in 0..<width {
                let t = UInt8(128 + Int(Double(x) / Double(width) * 80.0) - 40)
                let offset = y * bytesPerRow + x * bytesPerPixel
                pixelData[offset + 0] = t         // R
                pixelData[offset + 1] = t         // G
                pixelData[offset + 2] = t         // B
                pixelData[offset + 3] = 255       // A
            }
        }

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let ctx = CGContext(
            data: &pixelData,
            width: width, height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ), let cgImage = ctx.makeImage() else {
            throw MockPanoError.renderFailed
        }

        let dest = CGImageDestinationCreateWithURL(
            outputURL as CFURL,
            "public.tiff" as CFString,
            1, nil
        )
        guard let dest else { throw MockPanoError.renderFailed }
        CGImageDestinationAddImage(dest, cgImage, nil)
        guard CGImageDestinationFinalize(dest) else { throw MockPanoError.renderFailed }

        return outputURL
    }
}

// MARK: - MockPanoError

private enum MockPanoError: Error, LocalizedError {
    case renderFailed

    var errorDescription: String? {
        "Mock panorama render failed to produce an output image."
    }
}
