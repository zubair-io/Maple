// Tests/MapleBackupTests/BackupWalkInsertMissingTests.swift
// The rows a walk creates for photos its snapshot had no row for. A live
// observer or a worker may have inserted or advanced the row since that
// snapshot, and the walk must not reset it (#5833). Real SQLite in a temp dir.
import Foundation
import XCTest

@testable import MapleBackup

final class BackupWalkInsertMissingTests: XCTestCase {

  private func id(_ phid: String) -> BackupTaskID {
    BackupTaskID(deviceId: "d", phassetLocalId: phid)
  }

  private func planned(_ phid: String, capturedAt: Date? = nil) -> BackupTask {
    BackupTask(id: id(phid), state: .pending, priority: .background, capturedAt: capturedAt)
  }

  private func freshStore() throws -> BackupStateStore {
    try BackupStateStore(
      databaseURL: FileManager.default.temporaryDirectory
        .appendingPathComponent("backup-insert-missing-\(UUID().uuidString).sqlite"))
  }

  func testCreatesRowsThatAreStillMissingAndReturnsThemForQueueing() async throws {
    let store = try freshStore()
    let shot = Date(timeIntervalSince1970: 1_700_000_000)

    let created = try await store.insertMissing([planned("A", capturedAt: shot), planned("B")])

    XCTAssertEqual(created.map(\.id), [id("A"), id("B")])
    let a = try await store.find(id("A"))
    XCTAssertEqual(a?.state, .pending)
    XCTAssertEqual(a?.capturedAt, shot)
    let b = try await store.find(id("B"))
    XCTAssertEqual(b?.state, .pending)
  }

  func testARowTheObserverInsertedAfterTheSnapshotIsNotReset() async throws {
    let store = try freshStore()
    // The walk's snapshot had no row for these; before it writes, a worker has
    // uploaded one, claimed another, and a retry of a third has used its budget.
    try await store.upsert([
      BackupTask(id: id("uploaded"), state: .uploaded, priority: .userEdit),
      BackupTask(id: id("uploading"), state: .uploading, priority: .userEdit),
      BackupTask(
        id: id("retrying"), state: .pending, priority: .background, retryCount: 3,
        lastError: "timeout"),
      BackupTask(id: id("owes"), state: .pending, priority: .background),
    ])
    try await store.markCompanionsOwed(id("owes"))

    let created = try await store.insertMissing(
      ["uploaded", "uploading", "retrying", "owes", "fresh"].map { planned($0) })

    XCTAssertEqual(created.map(\.id), [id("fresh")], "only the row still missing is queued")
    let uploaded = try await store.find(id("uploaded"))
    XCTAssertEqual(uploaded?.state, .uploaded)
    XCTAssertEqual(uploaded?.priority, .userEdit)
    let uploading = try await store.find(id("uploading"))
    XCTAssertEqual(uploading?.state, .uploading)
    let retrying = try await store.find(id("retrying"))
    XCTAssertEqual(retrying?.retryCount, 3)
    XCTAssertEqual(retrying?.lastError, "timeout")
    let owing = try await store.phidsOwingCompanions(deviceId: "d")
    XCTAssertEqual(owing, ["owes"], "the companions-owed mark survives")
  }

  func testAnExistingRowOnlyGainsACaptureDateItLacked() async throws {
    let store = try freshStore()
    let shot = Date(timeIntervalSince1970: 1_700_000_000)
    let kept = Date(timeIntervalSince1970: 1_600_000_000)
    try await store.upsert([
      BackupTask(id: id("undated"), state: .uploading, priority: .background),
      BackupTask(id: id("dated"), state: .uploading, priority: .background, capturedAt: kept),
    ])

    let created = try await store.insertMissing([
      planned("undated", capturedAt: shot), planned("dated", capturedAt: shot),
    ])

    XCTAssertEqual(created, [])
    let undated = try await store.find(id("undated"))
    XCTAssertEqual(undated?.capturedAt, shot)
    XCTAssertEqual(undated?.state, .uploading)
    let dated = try await store.find(id("dated"))
    XCTAssertEqual(dated?.capturedAt, kept)
  }
}
