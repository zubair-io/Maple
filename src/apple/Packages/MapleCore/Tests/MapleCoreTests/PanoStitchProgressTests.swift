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

@Suite struct PanoStitchWeightsTests {
    /// Every progress callback a stitch makes, in the order the FFI makes
    /// them: stages 0-5, with stage 5 reporting through its sub-phases.
    private let ffiOrder: [(PanoStage, Double)] = [
        (.decoding, 0), (.decoding, 1), (.matching, 0), (.matching, 0.5), (.matching, 1),
        (.graph, 0), (.graph, 1), (.solving, 0), (.solving, 1),
        (.localAlign, 0), (.localAlign, 1),
        (.compositing, 0), (.compositing, 0.1), (.compositing, 0.25), (.compositing, 0.6),
        (.compositing, 0.99), (.compositing, 1),
    ]

    @Test(arguments: PanoOptions.LocalAlign.allCases)
    func theBarNeverGoesBackwards(localAlign: PanoOptions.LocalAlign) {
        let weights = PanoProgressWeights.stitch(localAlign: localAlign)
        let fractions = ffiOrder.map { weights.overall(stage: $0.0, stageFraction: $0.1) }
        #expect(fractions == fractions.sorted())
    }

    @Test(arguments: PanoOptions.LocalAlign.allCases)
    func solvingNeverShowsTheBarComplete(localAlign: PanoOptions.LocalAlign) {
        let weights = PanoProgressWeights.stitch(localAlign: localAlign)
        let afterSolve = weights.overall(stage: .localAlign, stageFraction: 1)
        let compositingStart = weights.overall(stage: .compositing, stageFraction: 0)
        #expect(afterSolve < 1)
        #expect(compositingStart >= afterSolve)
        #expect(weights.overall(stage: .compositing, stageFraction: 1) > compositingStart)
    }
}
