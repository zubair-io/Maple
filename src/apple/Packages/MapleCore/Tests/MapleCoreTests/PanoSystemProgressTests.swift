
import Foundation
import XCTest

@testable import MapleCore

final class PanoSystemProgressTests: XCTestCase {
    private func running(_ fraction: Double, title: String = "Compositing") -> (PanoMergeSession.RunState, PanoStitchProgress) {
        (
            .running(stage: .compositing, stageFraction: 0, overallFraction: fraction),
            PanoStitchProgress(title: title, fraction: fraction)
        )
    }

    func testFirstRunningStateBeginsWithRealFraction() {
        var tracker = PanoSystemProgressTracker()
        let (state, progress) = running(0.425)
        XCTAssertEqual(
            tracker.consume(state, progress: progress),
            .began(.init(units: 420, subtitle: "Compositing · 42%")))
    }

    func testRepeatedIdenticalStateEmitsNothing() {
        var tracker = PanoSystemProgressTracker()
        let (state, progress) = running(0.5)
        _ = tracker.consume(state, progress: progress)
        XCTAssertNil(tracker.consume(state, progress: progress))
    }

    func testAlignmentPhaseReportsNoPercentAndDoesNotPinTheBar() {
        var tracker = PanoSystemProgressTracker()
        XCTAssertEqual(
            tracker.consume(
                .finishingAlignment, progress: PanoStitchProgress(title: "Finishing alignment…", fraction: 1)),
            .began(.init(units: 0, subtitle: "Finishing alignment")))
        let (state, progress) = running(0.0, title: "Decoding frames")
        XCTAssertEqual(
            tracker.consume(state, progress: progress),
            .progressed(.init(units: 0, subtitle: "Decoding frames · 0%")))
    }

    func testRestartedRunReportsItsOwnProgress() {
        var tracker = PanoSystemProgressTracker()
        let (late, lateProgress) = running(0.8)
        _ = tracker.consume(late, progress: lateProgress)
        let (early, earlyProgress) = running(0.0, title: "Decoding frames")
        XCTAssertEqual(
            tracker.consume(early, progress: earlyProgress),
            .progressed(.init(units: 0, subtitle: "Decoding frames · 0%")))
    }

    func testNonFiniteFractionIsTreatedAsZero() {
        var tracker = PanoSystemProgressTracker()
        let (state, progress) = running(.nan)
        XCTAssertEqual(
            tracker.consume(state, progress: progress), .began(.init(units: 0, subtitle: "Compositing · 0%")))
    }

    func testDoneEndsAsFinished() {
        var tracker = PanoSystemProgressTracker()
        let (state, progress) = running(0.5)
        _ = tracker.consume(state, progress: progress)
        let done = PanoMergeSession.RunState.done(
            result: PanoResult(outputURL: URL(fileURLWithPath: "/tmp/p.png"), reportSummary: ""))
        XCTAssertEqual(tracker.consume(done, progress: nil), .ended(.finished))
    }

    func testRunningWithoutProgressIsSilent() {
        var tracker = PanoSystemProgressTracker()
        XCTAssertNil(
            tracker.consume(.running(stage: .decoding, stageFraction: 0, overallFraction: 0), progress: nil))
    }

    func testEllipsisIsDroppedFromTheSubtitle() {
        var tracker = PanoSystemProgressTracker()
        let event = tracker.consume(
            .finishingAlignment, progress: PanoStitchProgress(title: "Finishing alignment…", fraction: 0.1))
        XCTAssertEqual(event, .began(.init(units: 0, subtitle: "Finishing alignment")))
    }

    func testFractionIsClamped() {
        var tracker = PanoSystemProgressTracker()
        let (state, progress) = running(1.7)
        XCTAssertEqual(tracker.consume(state, progress: progress), .began(.init(units: 1000, subtitle: "Compositing · 100%")))
    }

    func testEndingOutcomesMapFromSessionStates() {
        for (state, outcome) in [
            (PanoMergeSession.RunState.idle, PanoSystemProgressTracker.Outcome.stopped),
            (.error(.init(underlying: CocoaError(.fileNoSuchFile))), .failed(CocoaError(.fileNoSuchFile).localizedDescription)),
        ] {
            var tracker = PanoSystemProgressTracker()
            let (runningState, progress) = running(0.2)
            _ = tracker.consume(runningState, progress: progress)
            XCTAssertEqual(tracker.consume(state, progress: nil), .ended(outcome))
        }
    }

    func testEndingIsReportedOncePerRun() {
        var tracker = PanoSystemProgressTracker()
        let (state, progress) = running(0.2)
        _ = tracker.consume(state, progress: progress)
        XCTAssertEqual(tracker.consume(.idle, progress: nil), .ended(.stopped))
        XCTAssertNil(tracker.consume(.idle, progress: nil))
    }

    func testIdleBeforeAnyRunIsSilent() {
        var tracker = PanoSystemProgressTracker()
        XCTAssertNil(tracker.consume(.idle, progress: nil))
    }

    func testNextRunBeginsAfterAnEnd() {
        var tracker = PanoSystemProgressTracker()
        let (state, progress) = running(0.9)
        _ = tracker.consume(state, progress: progress)
        _ = tracker.consume(.idle, progress: nil)
        let (again, againProgress) = running(0.1)
        XCTAssertEqual(
            tracker.consume(again, progress: againProgress),
            .began(.init(units: 100, subtitle: "Compositing · 10%")))
    }
}

final class PanoSystemProgressArbiterTests: XCTestCase {
    private let midRun = PanoMergeSession.RunState.running(stage: .compositing, stageFraction: 0, overallFraction: 0.5)
    private let progress = PanoStitchProgress(title: "Compositing", fraction: 0.5)
    private let frame = PanoSystemProgressTracker.Frame(units: 500, subtitle: "Compositing · 50%")

    func testSecondSessionIdleDoesNotEndTheOwnersTask() {
        var arbiter = PanoSystemProgressArbiter<Int>()
        XCTAssertEqual(arbiter.consume(1, state: midRun, progress: progress), .began(frame))
        XCTAssertNil(arbiter.consume(2, state: .idle, progress: nil))
        XCTAssertEqual(arbiter.owner, 1)
    }

    func testSecondSessionRunDoesNotTakeOverTheTask() {
        var arbiter = PanoSystemProgressArbiter<Int>()
        _ = arbiter.consume(1, state: midRun, progress: progress)
        XCTAssertNil(arbiter.consume(2, state: midRun, progress: progress))
        XCTAssertNil(arbiter.consume(2, state: .idle, progress: nil))
        XCTAssertEqual(arbiter.owner, 1)
    }

    func testOwnerEndFreesTheTaskForTheNextRun() {
        var arbiter = PanoSystemProgressArbiter<Int>()
        _ = arbiter.consume(1, state: midRun, progress: progress)
        XCTAssertEqual(arbiter.consume(1, state: .idle, progress: nil), .ended(.stopped))
        XCTAssertNil(arbiter.owner)
        XCTAssertEqual(arbiter.consume(2, state: midRun, progress: progress), .began(frame))
    }

    func testReleasingTheOwnerEndsItsTask() {
        var arbiter = PanoSystemProgressArbiter<Int>()
        _ = arbiter.consume(1, state: midRun, progress: progress)
        XCTAssertEqual(arbiter.release(1), .ended(.stopped))
        XCTAssertNil(arbiter.owner)
    }

    func testReleasingANonOwnerChangesNothing() {
        var arbiter = PanoSystemProgressArbiter<Int>()
        _ = arbiter.consume(1, state: midRun, progress: progress)
        XCTAssertNil(arbiter.release(2))
        XCTAssertEqual(arbiter.owner, 1)
    }
}
