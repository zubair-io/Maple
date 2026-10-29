// PanoMergeCancellationTests.swift — Stop, cancel and restart of the full
// stitch in PanoMergeSession: a cancelled run never reclaims the session, and
// a restarted run never overlaps the one it replaced.

import CoreGraphics
import XCTest
@testable import MapleCore

@MainActor
final class PanoMergeCancellationTests: XCTestCase {

    private let assets = (0..<3).map { AssetRef.preview(displayName: "IMG_\($0).dng") }

    private func waitUntil(_ condition: @MainActor () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = ContinuousClock.now + .seconds(5)
        while !condition() {
            guard ContinuousClock.now < deadline else {
                XCTFail("condition not met within 5 s", file: file, line: line)
                return
            }
            try? await Task.sleep(for: .milliseconds(5))
        }
    }

    func testCancelBeforeTheRunStartsLeavesTheSessionIdleAndNeverStitches() async {
        let stitcher = OverlapProbeStitcher()
        let session = PanoMergeSession(stitcher: stitcher, previewDebounce: .seconds(60))

        session.start(assets: assets)
        session.cancel()
        try? await Task.sleep(for: .milliseconds(100))

        XCTAssertEqual(stitcher.stitchCalls, 0)
        guard case .idle = session.state else {
            return XCTFail("a cancelled run reclaimed the session: \(session.state)")
        }
    }

    func testStopThenCreateWaitsForTheStoppedStitchBeforeStartingAnother() async {
        let stitcher = OverlapProbeStitcher()
        let session = PanoMergeSession(stitcher: stitcher, previewDebounce: .seconds(60))
        session.start(assets: assets)
        await waitUntil { stitcher.active == 1 }

        session.cancel()
        stitcher.holdStitches = false
        session.start(assets: assets)
        await waitUntil { if case .done = session.state { true } else { false } }

        XCTAssertEqual(stitcher.stitchCalls, 2)
        XCTAssertEqual(stitcher.maxActive, 1, "the new stitch started while the stopped one was still unwinding")
    }

    func testCreateAfterACancelledPreviewWaitsForThePreviewToUnwind() async {
        let stitcher = OverlapProbeStitcher()
        stitcher.holdPreviews = true
        stitcher.holdStitches = false
        let session = PanoMergeSession(stitcher: stitcher, previewDebounce: .milliseconds(10))
        session.preview(assets: assets)
        await waitUntil { stitcher.active == 1 }

        session.options.strategy = .tile
        session.start(assets: assets)
        await waitUntil { if case .done = session.state { true } else { false } }

        XCTAssertEqual(stitcher.maxActive, 1, "the stitch overlapped the preview it cancelled")
    }

    func testAPreviewRequestedDuringAStitchIsIgnored() async {
        let stitcher = OverlapProbeStitcher()
        let session = PanoMergeSession(stitcher: stitcher, previewDebounce: .milliseconds(10))
        session.start(assets: assets)
        await waitUntil { stitcher.active == 1 }

        session.preview(assets: assets)
        session.options.localAlign = .off
        try? await Task.sleep(for: .milliseconds(60))

        XCTAssertEqual(stitcher.previewCalls, 0)
        XCTAssertFalse(session.isPreviewing)
        stitcher.holdStitches = false
        await waitUntil { if case .done = session.state { true } else { false } }
    }
}

// MARK: - OverlapProbeStitcher

/// Counts concurrent runs. A held run waits until it is released or its task
/// is cancelled, then takes a moment to unwind, as a real FFI call does
/// before it reaches its next cancellation checkpoint.
private final class OverlapProbeStitcher: PanoStitching, @unchecked Sendable {
    @MainActor var holdStitches = true
    @MainActor var holdPreviews = false
    @MainActor private(set) var active = 0
    @MainActor private(set) var maxActive = 0
    @MainActor private(set) var stitchCalls = 0
    @MainActor private(set) var previewCalls = 0

    func cancel() {}

    func stitch(
        assets: [AssetRef],
        options: PanoOptions,
        alignment: PanoAlignment?,
        maxCanvasPixels: Int?,
        progress: @escaping @MainActor (PanoStage, Double) -> Void
    ) async throws -> PanoResult {
        await MainActor.run { stitchCalls += 1 }
        try await run(holding: { $0.holdStitches })
        return PanoResult(
            outputURL: FileManager.default.temporaryDirectory.appendingPathComponent("probe.png"),
            reportSummary: "probe")
    }

    func preview(
        assets: [AssetRef],
        options: PanoOptions,
        alignment: PanoAlignment?,
        progress: @escaping @MainActor (PanoStage, Double) -> Void
    ) async throws -> PanoPreview {
        await MainActor.run { previewCalls += 1 }
        try await run(holding: { $0.holdPreviews })
        return PanoPreview(image: Self.image, alignment: PanoAlignment(json: Data()), alignmentOutcome: .solved)
    }

    private func run(holding: @escaping @MainActor (OverlapProbeStitcher) -> Bool) async throws {
        await MainActor.run {
            active += 1
            maxActive = max(maxActive, active)
        }
        while await MainActor.run(body: { holding(self) }), !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(2))
        }
        await Task.detached { Thread.sleep(forTimeInterval: 0.05) }.value
        await MainActor.run { active -= 1 }
        try Task.checkCancellation()
    }

    private static let image: CGImage = {
        let ctx = CGContext(
            data: nil, width: 4, height: 2, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        return ctx.makeImage()!
    }()
}
