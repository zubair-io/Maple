// PanoStitchProgressTests.swift — the stitch progress the merge sheet pins
// inside its preview, and the preview's height cap (#5639).

import Foundation
import Testing

@testable import MapleCore

/// Reports one progress value, then waits until it is cancelled.
private final class HoldingStitcher: PanoStitching, @unchecked Sendable {
    let reported: Double

    init(reporting reported: Double) { self.reported = reported }

    func cancel() {}

    func stitch(
        assets: [AssetRef], options: PanoOptions, alignment: PanoAlignment?,
        maxCanvasPixels: Int?, progress: @escaping @MainActor (PanoStage, Double) -> Void
    ) async throws -> PanoResult {
        await MainActor.run { progress(.matching, reported) }
        try await Task.sleep(for: .seconds(60))
        throw CancellationError()
    }

    func preview(
        assets: [AssetRef], options: PanoOptions, alignment: PanoAlignment?,
        progress: @escaping @MainActor (PanoStage, Double) -> Void
    ) async throws -> PanoPreview {
        throw CancellationError()
    }
}

@MainActor
@Suite struct PanoStitchProgressTests {
    private let assets = (0..<2).map { AssetRef.preview(displayName: "IMG_\($0).dng") }

    private func runningSession(reporting reported: Double) async -> PanoMergeSession {
        let session = PanoMergeSession(stitcher: HoldingStitcher(reporting: reported))
        session.start(assets: assets)
        var turns = 0
        while session.stitchProgress(runsOnServer: false)?.title != PanoStage.matching.displayName
            && turns < 10_000
        {
            await Task.yield()
            turns += 1
        }
        return session
    }

    @Test func thereIsNoStitchProgressBeforeTheStitchRuns() {
        let session = PanoMergeSession(stitcher: HoldingStitcher(reporting: 0))
        #expect(session.stitchProgress(runsOnServer: false) == nil)
    }

    @Test func aRunningStitchReportsItsStageAndOverallFraction() async {
        let session = await runningSession(reporting: 0.4)
        let progress = session.stitchProgress(runsOnServer: false)
        #expect(progress?.title == PanoStage.matching.displayName)
        #expect((progress?.fraction ?? 0) > 0)
        session.cancel()
    }

    @Test func aServerStitchThatHasNotStartedSaysItIsWaiting() {
        let session = PanoMergeSession(stitcher: HoldingStitcher(reporting: 0))
        session.start(assets: assets)
        #expect(session.stitchProgress(runsOnServer: true)?.title == "Waiting for the server…")
        #expect(session.stitchProgress(runsOnServer: false)?.title == PanoStage.decoding.displayName)
        session.cancel()
    }

    @Test func theProgressEndsWhenTheStitchIsCancelled() async {
        let session = await runningSession(reporting: 0.2)
        session.cancel()
        #expect(session.stitchProgress(runsOnServer: false) == nil)
    }

    @Test func thePreviewMayTakeAThirdAndABitOfTheSheet() {
        #expect(PanoPreviewLayout.maxImageHeight(sheetHeight: 1000) == 350)
        #expect(PanoPreviewLayout.maxImageHeight(sheetHeight: 801) == 280)
    }

    @Test func anUnmeasuredSheetKeepsTheFixedCap() {
        #expect(PanoPreviewLayout.maxImageHeight(sheetHeight: 0) == PanoPreviewLayout.unmeasuredHeight)
    }
}
