// WorkersRuntimeVMTests.swift — pure helpers behind the expanded stage
// body (#2770).
//
// Lives in the MapleTests Xcode target because `WorkersRuntimeVM` is
// declared in the app target, per the `+VM.swift` co-location pattern
// (issue #192).

import Foundation
import MapleCore
import XCTest

@testable import Maple_Exposure

final class WorkersRuntimeVMTests: XCTestCase {

    private func perf(source: String = "db", pool: WorkerPerformance.Pool? = nil)
        -> WorkerPerformance
    {
        WorkerPerformance(ffiWorkers: 4, source: source, min: 1, max: 16, pool: pool)
    }

    private func migration(
        status: String = "idle", processed: Int = 0, remaining: Int = 0, errors: Int = 0
    ) -> MigrationInfo {
        MigrationInfo(
            id: "m1", title: "One", description: nil, enabled: false, status: status,
            processed: processed, errors: errors, remaining: remaining, lastError: nil)
    }

    // MARK: - pool summary

    func test_poolSummary_showsTargetAgainstSpawned() {
        // These diverge while the pool resizes, which otherwise looks like
        // the save didn't take.
        let summary = WorkersRuntimeVM.poolSummary(
            perf(pool: .init(target: 8, spawned: 4, busy: 2, queued: 1)))
        XCTAssertTrue(summary.contains("8 target"))
        XCTAssertTrue(summary.contains("4 spawned"))
        XCTAssertTrue(summary.contains("2 busy"))
    }

    func test_poolSummary_handlesMissingStats() {
        XCTAssertEqual(WorkersRuntimeVM.poolSummary(perf()), "Pool stats unavailable.")
    }

    // MARK: - source note

    func test_sourceNote_warnsWhenAnEnvVarOwnsTheValue() {
        // A save would appear to work and then be overridden on restart.
        let note = WorkersRuntimeVM.sourceNote("env")
        XCTAssertNotNil(note)
        XCTAssertTrue(note!.contains("environment variable"))
    }

    func test_sourceNote_silentForDatabaseAndDefault() {
        XCTAssertNil(WorkersRuntimeVM.sourceNote("db"))
        XCTAssertNil(WorkersRuntimeVM.sourceNote("default"))
    }

    // MARK: - migration progress

    func test_migrationProgress_leadsWithStatusAndOmitsEmptyCounters() {
        XCTAssertEqual(WorkersRuntimeVM.migrationProgress(migration()), "idle")
        XCTAssertEqual(
            WorkersRuntimeVM.migrationProgress(
                migration(status: "running", processed: 10, remaining: 5)),
            "running · 10 processed · 5 remaining")
    }

    func test_migrationProgress_includesErrorsWhenPresent() {
        XCTAssertTrue(
            WorkersRuntimeVM.migrationProgress(migration(status: "running", errors: 2))
                .contains("2 errors"))
    }

    // MARK: - reset affordance

    func test_reset_hiddenUntilTheMigrationHasDoneSomething() {
        XCTAssertFalse(WorkersRuntimeVM.canReset(migration()))
        XCTAssertTrue(WorkersRuntimeVM.canReset(migration(processed: 1)))
        XCTAssertTrue(WorkersRuntimeVM.canReset(migration(status: "running")))
    }
}
