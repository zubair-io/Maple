// PanoAlignmentHandoffTests.swift — what the merge sheet says about a reused
// or stale alignment, and which alignment it offers for which frames.

import XCTest
@testable import MapleCore

final class PanoAlignmentHandoffTests: XCTestCase {
    func testTheCoresStaleWordingIsReducedToItsReason() {
        let reason = PanoFFICall.staleReason(
            fromCoreMessage: "alignment not reused (the frames changed); matching re-ran")

        XCTAssertEqual(reason, "the frames changed")
        XCTAssertEqual(
            PanoAlignmentOutcome.stale(reason: reason).summary,
            "Preview alignment was stale (the frames changed); matching re-ran.")
    }

    func testAnUnexpectedCoreMessageIsKeptWhole() {
        XCTAssertEqual(PanoFFICall.staleReason(fromCoreMessage: "something else"), "something else")
    }

    @MainActor
    func testPreviewingOtherFramesDropsTheEarlierFramesAlignment() async {
        let stitcher = RecordingStitcher()
        let session = PanoMergeSession(stitcher: stitcher, previewDebounce: .milliseconds(10))
        let first = (0..<3).map { AssetRef.preview(displayName: "A_\($0).dng") }
        let second = (0..<3).map { AssetRef.preview(displayName: "B_\($0).dng") }
        session.preview(assets: first)
        await waitForReady(session)
        session.cancel()
        session.preview(assets: first)
        await waitForReady(session)

        session.cancel()
        session.preview(assets: second)
        await waitForReady(session)

        XCTAssertEqual(stitcher.previewCalls.map { $0.alignment == nil }, [true, false, true])
    }

    @MainActor
    private func waitForReady(_ session: PanoMergeSession) async {
        let deadline = ContinuousClock.now + .seconds(5)
        while ContinuousClock.now < deadline {
            if case .ready = session.previewState { return }
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("the preview never finished")
    }
}
