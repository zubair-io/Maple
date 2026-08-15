// WorkersTriageVMTests.swift — unit tests for the pure helpers in
// `Maple/Views/ServerAdmin/WorkersDrawers+VM.swift` (#2769).
//
// Lives in the MapleTests Xcode target because `WorkersTriageVM` is
// declared in the app target, per the `+VM.swift` co-location pattern
// (issue #192).

import Foundation
import MapleCore
import XCTest

@testable import Maple_Exposure

final class WorkersTriageVMTests: XCTestCase {

    private func deadJob(
        attempts: Int? = nil, processedAt: String? = nil, absPath: String? = "/lib/a.dng"
    ) -> DeadJob {
        DeadJob(
            id: "1", absPath: absPath, lastError: nil, attempts: attempts,
            processedAt: processedAt)
    }

    private func damaged(
        mapleID: String? = nil, stage: String? = nil, since: String? = nil
    ) -> DamagedAsset {
        DamagedAsset(
            id: "1", mapleID: mapleID, absPath: "/lib/b.cr2", stage: stage, reason: nil,
            since: since)
    }

    // MARK: - pathDisplay

    func test_pathDisplay_marksAnUnresolvablePathRatherThanRenderingBlank() {
        // The record still gets a row — hiding it would under-report the
        // queue — so the absence has to read as known-unknown, not as a
        // rendering glitch.
        XCTAssertEqual(WorkersTriageVM.pathDisplay(nil), "(path unavailable)")
        XCTAssertEqual(WorkersTriageVM.pathDisplay(""), "(path unavailable)")
        XCTAssertEqual(WorkersTriageVM.pathDisplay("/lib/a.dng"), "/lib/a.dng")
    }

    // MARK: - deadJobDetail

    func test_deadJobDetail_assemblesWhicheverHalvesAreKnown() {
        XCTAssertEqual(
            WorkersTriageVM.deadJobDetail(deadJob(attempts: 5, processedAt: "2026-08-15")),
            "5 attempts · last run 2026-08-15")
        XCTAssertEqual(WorkersTriageVM.deadJobDetail(deadJob(attempts: 5)), "5 attempts")
        XCTAssertEqual(
            WorkersTriageVM.deadJobDetail(deadJob(processedAt: "2026-08-15")),
            "last run 2026-08-15")
    }

    func test_deadJobDetail_singularAttempt() {
        XCTAssertEqual(WorkersTriageVM.deadJobDetail(deadJob(attempts: 1)), "1 attempt")
    }

    func test_deadJobDetail_nothingKnown() {
        XCTAssertEqual(
            WorkersTriageVM.deadJobDetail(deadJob()), "no attempt history recorded")
    }

    // MARK: - damagedDetail

    func test_damagedDetail_leadsWithTheTaggingStage() {
        // That stage is where triage starts, even though it is not
        // necessarily where the corruption came from.
        let detail = WorkersTriageVM.damagedDetail(
            damaged(mapleID: "mpl_1", stage: "exif", since: "2026-08-14"))
        XCTAssertTrue(detail.hasPrefix("tagged by exif"))
        XCTAssertTrue(detail.contains("since 2026-08-14"))
        XCTAssertTrue(detail.contains("mpl_1"))
    }

    func test_damagedDetail_oldTagWithNoDetails() {
        XCTAssertEqual(WorkersTriageVM.damagedDetail(damaged()), "no details recorded")
    }

    // MARK: - outcome notes

    func test_retryNote_callsOutZeroExplicitly() {
        // Zero means something else already re-armed them — a different
        // situation from the request failing, and one the operator would
        // otherwise read as a silent no-op.
        XCTAssertEqual(
            WorkersTriageVM.retryNote(affected: 0),
            "Nothing to re-arm — these jobs were already reset.")
        XCTAssertEqual(WorkersTriageVM.retryNote(affected: 1), "Re-armed 1 job.")
        XCTAssertEqual(WorkersTriageVM.retryNote(affected: 9), "Re-armed 9 jobs.")
    }

    func test_clearNote_callsOutZeroExplicitly() {
        XCTAssertEqual(
            WorkersTriageVM.clearNote(affected: 0),
            "Nothing to clear — these assets were already re-queued.")
        XCTAssertEqual(
            WorkersTriageVM.clearNote(affected: 1), "Cleared 1 asset and re-queued it.")
        XCTAssertEqual(
            WorkersTriageVM.clearNote(affected: 3), "Cleared 3 assets and re-queued them.")
    }
}
