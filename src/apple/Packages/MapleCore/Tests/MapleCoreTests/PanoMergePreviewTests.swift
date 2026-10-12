// PanoMergePreviewTests.swift — Automatic preview, debounced re-preview,
// cancellation, and alignment hand-off in PanoMergeSession (#4579).

import CoreGraphics
import XCTest
@testable import MapleCore

@MainActor
final class PanoMergePreviewTests: XCTestCase {

    private func makeAssets(_ count: Int) -> [AssetRef] {
        (0..<count).map { AssetRef.preview(displayName: "IMG_\($0).dng") }
    }

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

    func testPreviewRunsAutomaticallyAndStoresTheAlignment() async {
        let stitcher = RecordingStitcher()
        let session = PanoMergeSession(stitcher: stitcher, previewDebounce: .milliseconds(20))

        session.preview(assets: makeAssets(3))
        XCTAssertTrue(session.isPreviewing)
        await waitUntil { if case .ready = session.previewState { true } else { false } }

        XCTAssertEqual(stitcher.previewCalls.count, 1)
        XCTAssertNil(stitcher.previewCalls[0].alignment)
        XCTAssertEqual(session.alignment, RecordingStitcher.alignment(for: .default))
    }

    func testFewerThanTwoFramesNeverPreviews() async {
        let stitcher = RecordingStitcher()
        let session = PanoMergeSession(stitcher: stitcher, previewDebounce: .milliseconds(20))

        session.preview(assets: makeAssets(1))
        session.options.strategy = .tile
        try? await Task.sleep(for: .milliseconds(100))

        XCTAssertTrue(stitcher.previewCalls.isEmpty)
        guard case .idle = session.previewState else {
            return XCTFail("expected idle, got \(session.previewState)")
        }
    }

    func testOptionChangeRePreviewsOfferingTheStoredAlignment() async {
        let stitcher = RecordingStitcher()
        let session = PanoMergeSession(stitcher: stitcher, previewDebounce: .milliseconds(20))
        session.preview(assets: makeAssets(3))
        await waitUntil { if case .ready = session.previewState { true } else { false } }

        session.options.localAlign = .off
        guard case .scheduled = session.previewState else {
            return XCTFail("an option change should schedule a debounced re-preview, got \(session.previewState)")
        }
        XCTAssertNotNil(session.lastPreview, "the previous preview stays visible while re-previewing")
        await waitUntil { stitcher.previewCalls.count == 2 && !session.isPreviewing }

        XCTAssertEqual(stitcher.previewCalls[1].options.localAlign, .off)
        XCTAssertEqual(stitcher.previewCalls[1].alignment, RecordingStitcher.alignment(for: .default))
    }

    func testRapidOptionChangesCoalesceIntoOnePreview() async {
        let stitcher = RecordingStitcher()
        let session = PanoMergeSession(stitcher: stitcher, previewDebounce: .milliseconds(80))
        session.preview(assets: makeAssets(3))
        await waitUntil { stitcher.previewCalls.count == 1 && !session.isPreviewing }

        session.options.retention = .strict
        session.options.localAlign = .off
        session.options.strategy = .rotation
        await waitUntil { stitcher.previewCalls.count == 2 && !session.isPreviewing }
        try? await Task.sleep(for: .milliseconds(150))

        XCTAssertEqual(stitcher.previewCalls.count, 2)
        XCTAssertEqual(stitcher.previewCalls[1].options, PanoOptions(retention: .strict, localAlign: .off, strategy: .rotation))
    }

    func testOptionChangeCancelsTheInFlightPreviewAndItNeverPublishes() async {
        let stitcher = RecordingStitcher()
        stitcher.holdPreviews = true
        let session = PanoMergeSession(stitcher: stitcher, previewDebounce: .milliseconds(20))
        session.preview(assets: makeAssets(3))
        await waitUntil { stitcher.previewCalls.count == 1 }

        stitcher.holdPreviews = false
        session.options.strategy = .tile
        await waitUntil { stitcher.cancelledPreviews == 1 }
        await waitUntil { if case .ready = session.previewState { true } else { false } }

        XCTAssertEqual(stitcher.previewCalls.count, 2)
        XCTAssertEqual(session.alignment, RecordingStitcher.alignment(for: PanoOptions(strategy: .tile)))
    }

    func testProgressFromASupersededPreviewIsDropped() async {
        let stitcher = RecordingStitcher()
        stitcher.holdPreviews = true
        let session = PanoMergeSession(stitcher: stitcher, previewDebounce: .milliseconds(20))
        session.preview(assets: makeAssets(3))
        await waitUntil { stitcher.previewCalls.count == 1 }

        let staleProgress = stitcher.lastProgress!
        session.options.strategy = .tile
        staleProgress(.compositing, 0.9)

        guard case .scheduled = session.previewState else {
            return XCTFail("stale progress overwrote the new preview's state: \(session.previewState)")
        }
    }

    func testCreatePanoramaPassesThePreviewAlignmentToTheStitch() async {
        let stitcher = RecordingStitcher()
        let session = PanoMergeSession(stitcher: stitcher, previewDebounce: .milliseconds(20))
        let assets = makeAssets(3)
        session.preview(assets: assets)
        await waitUntil { if case .ready = session.previewState { true } else { false } }

        session.start(assets: assets)
        await waitUntil { if case .done = session.state { true } else { false } }

        XCTAssertEqual(stitcher.stitchAlignments, [RecordingStitcher.alignment(for: .default)])
        guard case .done(let result) = session.state else { return }
        XCTAssertEqual(result.alignmentOutcome, .reused)
    }

    func testCreatePanoramaCancelsAnInFlightPreview() async {
        let stitcher = RecordingStitcher()
        stitcher.holdPreviews = true
        let session = PanoMergeSession(stitcher: stitcher, previewDebounce: .milliseconds(20))
        let assets = makeAssets(3)
        session.preview(assets: assets)
        await waitUntil { stitcher.previewCalls.count == 1 }

        session.start(assets: assets)
        await waitUntil { stitcher.cancelledPreviews == 1 }
        await waitUntil { if case .done = session.state { true } else { false } }

        XCTAssertEqual(stitcher.stitchAlignments, [nil])
        guard case .idle = session.previewState else {
            return XCTFail("expected the cancelled preview to leave idle, got \(session.previewState)")
        }
    }

    func testCancelStopsThePreviewAndOptionChangesNoLongerRePreview() async {
        let stitcher = RecordingStitcher()
        stitcher.holdPreviews = true
        let session = PanoMergeSession(stitcher: stitcher, previewDebounce: .milliseconds(20))
        session.preview(assets: makeAssets(3))
        await waitUntil { stitcher.previewCalls.count == 1 }

        session.cancel()
        await waitUntil { stitcher.cancelledPreviews == 1 }
        session.options.strategy = .tile
        try? await Task.sleep(for: .milliseconds(100))

        XCTAssertEqual(stitcher.previewCalls.count, 1)
        XCTAssertFalse(session.isPreviewing)
        XCTAssertNil(session.lastPreview)
    }

    func testPreviewProgressIsMonotonicAndEndsAtOne() {
        let ffiOrder: [(PanoStage, Double)] = [
            (.decoding, 0), (.decoding, 1), (.matching, 0.5), (.matching, 1),
            (.graph, 0.5), (.graph, 1), (.solving, 1), (.localAlign, 1), (.compositing, 0.5), (.compositing, 1),
        ]
        let fractions = ffiOrder.map { PanoProgressWeights.preview.overall(stage: $0.0, stageFraction: $0.1) }

        XCTAssertEqual(fractions, fractions.sorted())
        XCTAssertEqual(fractions.last ?? 0, 1.0, accuracy: 1e-9)
    }
}

// MARK: - RecordingStitcher

/// Instant stitcher that records what the session offers it. With
/// `holdPreviews`, a preview suspends until its task is cancelled.
private final class RecordingStitcher: PanoStitching, @unchecked Sendable {
    struct PreviewCall {
        let options: PanoOptions
        let alignment: PanoAlignment?
    }

    @MainActor var previewCalls: [PreviewCall] = []
    @MainActor var stitchAlignments: [PanoAlignment?] = []
    @MainActor var cancelledPreviews = 0
    @MainActor var holdPreviews = false
    @MainActor var lastProgress: (@MainActor (PanoStage, Double) -> Void)?

    static func alignment(for options: PanoOptions) -> PanoAlignment {
        PanoAlignment(json: Data(options.strategy.rawValue.utf8))
    }

    func cancel() {}

    func preview(
        assets: [AssetRef],
        options: PanoOptions,
        alignment: PanoAlignment?,
        progress: @escaping @MainActor (PanoStage, Double) -> Void
    ) async throws -> PanoPreview {
        let hold = await MainActor.run {
            previewCalls.append(PreviewCall(options: options, alignment: alignment))
            lastProgress = progress
            return holdPreviews
        }
        if hold {
            do {
                try await Task.sleep(for: .seconds(60))
            } catch {
                await MainActor.run { cancelledPreviews += 1 }
                throw CancellationError()
            }
        }
        await MainActor.run { progress(.compositing, 1.0) }
        let solved = Self.alignment(for: options)
        return PanoPreview(
            image: Self.image,
            alignment: solved,
            alignmentOutcome: alignment == nil ? .solved : (alignment == solved ? .reused : .stale(reason: "test"))
        )
    }

    func stitch(
        assets: [AssetRef],
        options: PanoOptions,
        alignment: PanoAlignment?,
        progress: @escaping @MainActor (PanoStage, Double) -> Void
    ) async throws -> PanoResult {
        await MainActor.run { stitchAlignments.append(alignment) }
        return PanoResult(
            outputURL: FileManager.default.temporaryDirectory.appendingPathComponent("recorded.png"),
            reportSummary: "recorded",
            alignmentOutcome: alignment == Self.alignment(for: options) ? .reused : .solved
        )
    }

    private static let image: CGImage = {
        let ctx = CGContext(
            data: nil, width: 4, height: 2, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        return ctx.makeImage()!
    }()
}
