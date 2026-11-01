// PanoEdgesTests.swift — Boundary Warp and Auto Crop: the reason copy, the
// engine status mapping, and how PanoMergeSession treats an edge change (#5575).

import XCTest

@testable import MapleCore

@MainActor
final class PanoEdgesTests: XCTestCase {
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

    private func report(_ status: PanoBoundaryWarpStatus, applied: Double = 0) -> PanoEdgesReport {
        PanoEdgesReport(boundaryWarpStatus: status, boundaryWarpApplied: applied)
    }

    // MARK: - Copy

    func testReasonCopyForEveryStatus() {
        XCTAssertNil(report(.off).boundaryWarpReason)
        XCTAssertNil(report(.applied, applied: 60).boundaryWarpReason)
        XCTAssertEqual(
            report(.clampedFold, applied: 37.4).boundaryWarpReason,
            "Limited to 37% so the image doesn't fold.")
        XCTAssertEqual(
            report(.refusedDisconnected).boundaryWarpReason,
            "Not applied: the frames form separate pieces, so the edges stay as stitched.")
        XCTAssertEqual(
            report(.refusedFullWrap).boundaryWarpReason,
            "Not applied to 360\u{00B0} panoramas. Auto Crop can still trim the top and bottom.")
        XCTAssertEqual(
            report(.refusedFold).boundaryWarpReason,
            "Not applied: warping this shape would fold the image.")
        XCTAssertEqual(
            report(.refusedEmpty).boundaryWarpReason,
            "Not applied: there are no stitched pixels to warp.")
        XCTAssertEqual(
            report(.refusedShape).boundaryWarpReason,
            "Not applied: this panorama's outline can't be warped, so the edges stay as stitched.")
        XCTAssertEqual(
            report(.refusedSolve).boundaryWarpReason,
            "Not applied: the warp couldn't be computed for this panorama, so the edges stay as stitched.")
    }

    func testOnlyOffAndAppliedHaveNoReason() {
        let silent = PanoBoundaryWarpStatus.allCases.filter { report($0, applied: 50).boundaryWarpReason == nil }
        XCTAssertEqual(Set(silent), [.off, .applied])
    }

    func testFFIStatusValuesMapAndUnknownValuesAreRejected() {
        let expected: [PanoBoundaryWarpStatus] = [
            .off, .applied, .clampedFold, .refusedFullWrap, .refusedDisconnected,
            .refusedEmpty, .refusedShape, .refusedFold, .refusedSolve,
        ]
        XCTAssertEqual(expected.indices.map { PanoBoundaryWarpStatus(ffiValue: $0) }, expected)
        XCTAssertNil(PanoBoundaryWarpStatus(ffiValue: 9))
        XCTAssertNil(PanoBoundaryWarpStatus(ffiValue: -1))
    }

    func testSliderLineIsThePlainHelpAtZeroAndTheReasonOtherwise() {
        let refused = report(.refusedFold)
        XCTAssertEqual(PanoEdgesReport.boundaryWarpLine(requested: 0, report: refused).text, PanoEdgesReport.boundaryWarpHelp)
        XCTAssertFalse(PanoEdgesReport.boundaryWarpLine(requested: 0, report: refused).isReason)
        XCTAssertEqual(PanoEdgesReport.boundaryWarpLine(requested: 50, report: nil).text, PanoEdgesReport.boundaryWarpHelp)
        XCTAssertEqual(PanoEdgesReport.boundaryWarpLine(requested: 50, report: report(.applied, applied: 50)).text, PanoEdgesReport.boundaryWarpHelp)
        let line = PanoEdgesReport.boundaryWarpLine(requested: 50, report: refused)
        XCTAssertEqual(line.text, "Not applied: warping this shape would fold the image.")
        XCTAssertTrue(line.isReason)
    }

    // MARK: - Options

    func testDefaultsSendNothingNew() {
        XCTAssertEqual(PanoOptions.default.boundaryWarp, 0)
        XCTAssertFalse(PanoOptions.default.autoCrop)
        XCTAssertFalse(PanoOptions.default.hasEdgeSettings)
        XCTAssertTrue(PanoOptions(boundaryWarp: 1).hasEdgeSettings)
        XCTAssertTrue(PanoOptions(autoCrop: true).hasEdgeSettings)
    }

    func testWithoutEdgesKeepsTheAlignmentKeyedOptions() {
        let options = PanoOptions(retention: .strict, localAlign: .off, strategy: .tile, boundaryWarp: 40, autoCrop: true)
        XCTAssertEqual(options.withoutEdges, PanoOptions(retention: .strict, localAlign: .off, strategy: .tile))
    }

    // MARK: - Session

    func testEdgeChangeRePreviewsFromTheHeldAlignmentAndIsFlaggedEdgesOnly() async {
        let stitcher = RecordingStitcher()
        let session = PanoMergeSession(stitcher: stitcher, previewDebounce: .milliseconds(20))
        session.preview(assets: makeAssets(3))
        await waitUntil { stitcher.previewCalls.count == 1 && !session.isPreviewing }
        XCTAssertFalse(session.previewIsEdgesOnly)

        session.options.boundaryWarp = 60
        XCTAssertTrue(session.previewIsEdgesOnly)
        await waitUntil { stitcher.previewCalls.count == 2 && !session.isPreviewing }

        XCTAssertEqual(stitcher.previewCalls[1].options.boundaryWarp, 60)
        XCTAssertEqual(stitcher.previewCalls[1].alignment, RecordingStitcher.alignment(for: .default))
        XCTAssertFalse(session.previewIsEdgesOnly)
    }

    func testAnOptionChangeAlongsideAnEdgeChangeIsNotEdgesOnly() async {
        let stitcher = RecordingStitcher()
        let session = PanoMergeSession(stitcher: stitcher, previewDebounce: .milliseconds(20))
        session.preview(assets: makeAssets(3))
        await waitUntil { stitcher.previewCalls.count == 1 && !session.isPreviewing }

        session.options.localAlign = .off
        session.options.autoCrop = true
        XCTAssertFalse(session.previewIsEdgesOnly)
        await waitUntil { stitcher.previewCalls.count == 2 && !session.isPreviewing }
    }

    func testEdgeChangeDoesNotInvalidateTheMemoryFit() async {
        let stitcher = RecordingStitcher()
        stitcher.previewSizes = PanoStitchSizes(
            canvasWidth: 4000, canvasHeight: 2000, largestFramePixels: 1_000_000, frameCount: 3, scratchBytes: 0)
        let session = PanoMergeSession(
            stitcher: stitcher, previewDebounce: .milliseconds(20), availableMemory: { 8_000_000_000 })
        session.preview(assets: makeAssets(3))
        await waitUntil { stitcher.previewCalls.count == 1 && !session.isPreviewing }

        session.options.autoCrop = true
        await waitUntil { stitcher.previewCalls.count == 2 && !session.isPreviewing }
        session.start(assets: makeAssets(3))
        await waitUntil { if case .done = session.state { true } else { false } }

        XCTAssertEqual(stitcher.previewCalls.count, 2, "the stitch reuses the fit; it does not preview again")
        XCTAssertEqual(stitcher.stitchOptions.last?.autoCrop, true)
    }

    func testReportComesFromThePreviewThenTheFinishedStitch() async {
        let stitcher = RecordingStitcher()
        stitcher.edgesReport = report(.clampedFold, applied: 62)
        let session = PanoMergeSession(stitcher: stitcher, previewDebounce: .milliseconds(20))
        XCTAssertNil(session.edgesReport)

        session.preview(assets: makeAssets(3))
        await waitUntil { stitcher.previewCalls.count == 1 && !session.isPreviewing }
        XCTAssertEqual(session.edgesReport, report(.clampedFold, applied: 62))

        stitcher.edgesReport = report(.refusedFold)
        session.start(assets: makeAssets(3))
        await waitUntil { if case .done = session.state { true } else { false } }
        XCTAssertEqual(session.edgesReport, report(.refusedFold))
    }

    func testTheReasonStaysWhileANewerPreviewRuns() async {
        let stitcher = RecordingStitcher()
        stitcher.edgesReport = report(.refusedDisconnected)
        let session = PanoMergeSession(stitcher: stitcher, previewDebounce: .milliseconds(20))
        session.preview(assets: makeAssets(3))
        await waitUntil { stitcher.previewCalls.count == 1 && !session.isPreviewing }

        stitcher.holdPreviews = true
        session.options.boundaryWarp = 30
        await waitUntil { stitcher.previewCalls.count == 2 }
        XCTAssertEqual(session.edgesReport, report(.refusedDisconnected))
        stitcher.holdPreviews = false
        await waitUntil { !session.isPreviewing }
    }
}
