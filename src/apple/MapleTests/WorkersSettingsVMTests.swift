// WorkersSettingsVMTests.swift — unit tests for the pure helpers in
// `Maple/Views/ServerAdmin/WorkersSettingsView+VM.swift`.
//
// Lives in the MapleTests Xcode target because `WorkersSettingsVM` is
// declared in the app target, per the `+VM.swift` co-location pattern
// (issue #192).

import Foundation
import MapleCore
import XCTest

@testable import Maple_Exposure

final class WorkersSettingsVMTests: XCTestCase {

    private func stage(
        inFlight: Int = 0, batchSize: Int = 8, ready: Int = 0, blocked: Int = 0,
        throughput: Double = 0, status: StageRunState = .running
    ) -> StageStatus {
        StageStatus(
            name: "thumb", status: status, inFlight: inFlight, configured: 4,
            pending: ready + blocked, ready: ready, blocked: blocked, dead: 0,
            throughput: throughput, lastError: nil, config: nil, batchSize: batchSize)
    }

    // MARK: - statusTone

    func test_statusTone_mapsRunningErrorAndEverythingElse() {
        XCTAssertEqual(WorkersSettingsVM.statusTone(.running), .active)
        XCTAssertEqual(WorkersSettingsVM.statusTone(.error), .fault)
        for idle: StageRunState in [.paused, .starting, .restarting, .stopped, .unknown] {
            XCTAssertEqual(WorkersSettingsVM.statusTone(idle), .idle, "\(idle) should read as idle")
        }
    }

    // MARK: - throughputLabel

    func test_throughputLabel_zeroReadsAsEmDashNotZeroPerMinute() {
        // "0 /min" reads as a stalled stage; an idle one should just be
        // blank.
        XCTAssertEqual(WorkersSettingsVM.throughputLabel(0), "—")
    }

    func test_throughputLabel_roundsToWholeItemsPerMinute() {
        XCTAssertEqual(WorkersSettingsVM.throughputLabel(12.4), "12 /min")
        XCTAssertEqual(WorkersSettingsVM.throughputLabel(12.6), "13 /min")
    }

    // MARK: - labels

    func test_inFlightLabel_showsBatchCeiling() {
        XCTAssertEqual(WorkersSettingsVM.inFlightLabel(stage(inFlight: 2, batchSize: 8)), "2 / 8")
    }

    func test_pendingLabel_plainWhenNothingBlocked() {
        XCTAssertEqual(WorkersSettingsVM.pendingLabel(stage(ready: 9)), "9")
    }

    func test_pendingLabel_annotatesBlockedShare() {
        // A stage at 0 ready with thousands blocked looks broken unless the
        // blocked count is visible.
        XCTAssertEqual(WorkersSettingsVM.pendingLabel(stage(ready: 0, blocked: 1200)), "0 · 1200 blkd")
    }

    // MARK: - pause action

    func test_pauseAction_flipsOnPausedOnly() {
        XCTAssertTrue(WorkersSettingsVM.isPausable(.running))
        XCTAssertTrue(WorkersSettingsVM.isPausable(.error))
        XCTAssertFalse(WorkersSettingsVM.isPausable(.paused))
        XCTAssertEqual(WorkersSettingsVM.pauseActionLabel(.running), "Pause")
        XCTAssertEqual(WorkersSettingsVM.pauseActionLabel(.paused), "Resume")
    }

    // MARK: - uncounted display (#2910)

    func test_countsRenderAsUnknownBeforeTheyAreComputed() {
        // The registry snapshot zeroes ready/blocked/dead rather than
        // omitting them, so rendering it verbatim told the operator a stage
        // with 27,080 dead jobs had none.
        let s = stage(ready: 0, blocked: 0)
        XCTAssertEqual(WorkersSettingsVM.pendingLabel(s, counted: false), "—")
        XCTAssertEqual(WorkersSettingsVM.deadLabel(s, counted: false), "—")
    }

    func test_countsRenderNormallyOnceCounted() {
        let s = stage(ready: 9, blocked: 3)
        XCTAssertEqual(WorkersSettingsVM.pendingLabel(s, counted: true), "9 · 3 blkd")
        XCTAssertEqual(WorkersSettingsVM.deadLabel(s, counted: true), "0")
    }

    func test_inFlightDropsTheCeilingWhenItIsAPlaceholder() {
        // deriveBatchSize(0) makes the uncounted ceiling 0; "1 / 0" reads as
        // a real limit of zero.
        XCTAssertEqual(
            WorkersSettingsVM.inFlightLabel(stage(inFlight: 1, batchSize: 0), counted: false), "1")
        XCTAssertEqual(
            WorkersSettingsVM.inFlightLabel(stage(inFlight: 1, batchSize: 5), counted: true), "1 / 5")
    }

    func test_countsPendingNotice_onlyWhileSomethingIsShownWithoutCounts() {
        XCTAssertNil(
            WorkersSettingsVM.countsPendingNotice(hasCountedData: false, hasPayload: false),
            "the page already shows its own loading state")
        XCTAssertNil(WorkersSettingsVM.countsPendingNotice(hasCountedData: true, hasPayload: true))
        XCTAssertEqual(
            WorkersSettingsVM.countsPendingNotice(hasCountedData: false, hasPayload: true),
            "Queue counts haven't loaded yet — showing live status only.")
    }

    // MARK: - connectionNotice

    func test_connectionNotice_silentBeforeAnythingIsDisplayed() {
        // The page already shows a loading state; stacking "reconnecting"
        // on top of it is noise.
        XCTAssertNil(WorkersSettingsVM.connectionNotice(isLive: false, hasPayload: false))
    }

    func test_connectionNotice_shownWhenLiveFeedDropsWithDataOnScreen() {
        XCTAssertEqual(
            WorkersSettingsVM.connectionNotice(isLive: false, hasPayload: true),
            "Live updates disconnected — reconnecting.")
    }

    func test_connectionNotice_silentWhileLive() {
        XCTAssertNil(WorkersSettingsVM.connectionNotice(isLive: true, hasPayload: true))
    }
}
