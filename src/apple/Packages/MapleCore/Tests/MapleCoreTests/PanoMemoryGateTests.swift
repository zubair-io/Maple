// PanoMemoryGateTests.swift — the merge session refuses a stitch the frames
// alone cannot fit, and stops a run when the system warns that memory is
// low (P1 of the panorama memory review).

import XCTest
@testable import MapleCore

@MainActor
final class PanoMemoryGateTests: XCTestCase {
    private let sizes = PanoStitchSizes(
        canvasWidth: 30_400, canvasHeight: 8_430, largestFramePixels: 48_771_072, frameCount: 40,
        scratchBytes: 24_000_000_000)
    private var assets: [AssetRef] { (0..<3).map { AssetRef.preview(displayName: "IMG_\($0).dng") } }

    private func session(available: Int?, holdPreviews: Bool = false) async -> (PanoMergeSession, RecordingStitcher) {
        let stitcher = RecordingStitcher()
        stitcher.previewSizes = sizes
        stitcher.holdPreviews = holdPreviews
        let session = PanoMergeSession(
            stitcher: stitcher, previewDebounce: .milliseconds(20), availableMemory: { available })
        session.preview(assets: assets)
        let deadline = ContinuousClock.now + .seconds(5)
        while ContinuousClock.now < deadline {
            if holdPreviews ? !stitcher.previewCalls.isEmpty : session.lastPreview != nil { break }
            try? await Task.sleep(for: .milliseconds(5))
        }
        return (session, stitcher)
    }

    private var headBytes: Int { PanoMemoryModel().headBytes(sizes) }

    func testFramesThatCannotFitAtAnySizeBlockCreatePanorama() async {
        let (session, stitcher) = await session(available: headBytes / 2)
        guard case .tooLarge = session.memoryFit else {
            return XCTFail("expected tooLarge, got \(String(describing: session.memoryFit))")
        }
        XCTAssertEqual(session.stitchBlockedReason, PanoStitcherError.insufficientMemory.errorDescription)

        session.start(assets: assets)
        guard case .error(let error) = session.state else {
            return XCTFail("expected the start to be refused, got \(session.state)")
        }
        XCTAssertEqual(error.message, PanoStitcherError.insufficientMemory.errorDescription)
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(stitcher.stitchCaps.isEmpty, "no stitch may run")
    }

    func testFramesThatFitDoNotBlock() async {
        let (session, _) = await session(available: Int.max / 4)
        XCTAssertNotNil(session.memoryFit)
        XCTAssertNil(session.stitchBlockedReason)
    }

    func testNoMemoryLimitNeverBlocks() async {
        let (session, _) = await session(available: nil)
        XCTAssertNil(session.memoryFit)
        XCTAssertNil(session.stitchBlockedReason)
    }

    func testMemoryPressureStopsARunningPreviewWithAMessage() async {
        let (session, stitcher) = await session(available: Int.max / 4, holdPreviews: true)
        XCTAssertTrue(session.isPreviewing)
        session.handleMemoryPressure()
        guard case .failed(let error) = session.previewState else {
            return XCTFail("expected the preview to stop, got \(session.previewState)")
        }
        XCTAssertEqual(error.message, PanoStitcherError.stoppedForMemory.errorDescription)
        stitcher.holdPreviews = false
    }

    func testMemoryPressureIsIgnoredWhereTheOSSetsNoLimit() async {
        let (session, stitcher) = await session(available: nil, holdPreviews: true)
        session.handleMemoryPressure()
        XCTAssertTrue(session.isPreviewing)
        stitcher.holdPreviews = false
    }

    func testClosingTheMergeDiscardsThePreviewCache() async {
        let (session, stitcher) = await session(available: nil)
        session.cancel()
        XCTAssertEqual(stitcher.discardedPreviewCaches, 1)
    }
}
