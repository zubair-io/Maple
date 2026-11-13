// Tests/MapleBackupTests/BackupCursorTests.swift
// Which discovery path a library walk takes, read back from a real SQLite
// state store after the writes a finished or an interrupted walk leaves.
import Foundation
import XCTest

@testable import MapleBackup

final class BackupCursorTests: XCTestCase {
  private let token = Data("token-1".utf8)

  private func freshStore() throws -> BackupStateStore {
    try BackupStateStore(
      databaseURL: FileManager.default.temporaryDirectory
        .appendingPathComponent("backup-cursor-\(UUID().uuidString).sqlite"))
  }

  /// The rows and server cursor a walk writes before its full scan finishes.
  private func recordPartOfAScan(in store: BackupStateStore) async throws {
    try await store.upsert(
      (0..<3).map {
        BackupTask(
          id: BackupTaskID(deviceId: "d", phassetLocalId: "P\($0)"),
          state: .pending, priority: .background)
      })
    try await store.updateServerReconciledAt(deviceId: "d", since: "2026-11-01T00:00:00Z")
  }

  func testFirstWalkListsTheWholeLibrary() async throws {
    let cursor = try await freshStore().cursor(deviceId: "d")
    XCTAssertEqual(
      cursor.discovery(settingsFingerprint: "A", retryFailed: false, forceFullScan: false),
      .fullScan)
  }

  func testCompletedFullScanLetsTheNextWalkReplayChanges() async throws {
    let store = try freshStore()
    try await store.recordCompletedFullScan(
      deviceId: "d", settingsFingerprint: "A", phChangeToken: token)
    let cursor = try await store.cursor(deviceId: "d")
    XCTAssertEqual(
      cursor.discovery(settingsFingerprint: "A", retryFailed: false, forceFullScan: false),
      .changesSince(token: token))
  }

  func testInterruptedScanResumesAsAFullScan() async throws {
    let store = try freshStore()
    try await recordPartOfAScan(in: store)
    try await store.updatePhotoKitChangeToken(deviceId: "d", token: token)

    let cursor = try await store.cursor(deviceId: "d")
    XCTAssertNil(cursor.fullScanCompletedAt)
    XCTAssertEqual(
      cursor.discovery(settingsFingerprint: "A", retryFailed: false, forceFullScan: false),
      .fullScan)
  }

  func testSettingsChangeListsTheWholeLibraryUntilItsScanFinishes() async throws {
    let store = try freshStore()
    try await store.recordCompletedFullScan(
      deviceId: "d", settingsFingerprint: "A", phChangeToken: token)
    try await recordPartOfAScan(in: store)

    let interrupted = try await store.cursor(deviceId: "d")
    XCTAssertEqual(
      interrupted.discovery(
        settingsFingerprint: "B", retryFailed: false, forceFullScan: false),
      .fullScan)

    let newerToken = Data("token-2".utf8)
    try await store.recordCompletedFullScan(
      deviceId: "d", settingsFingerprint: "B", phChangeToken: newerToken)
    let finished = try await store.cursor(deviceId: "d")
    XCTAssertEqual(
      finished.discovery(settingsFingerprint: "B", retryFailed: false, forceFullScan: false),
      .changesSince(token: newerToken))
    XCTAssertEqual(finished.lastServerReconciledAt, "2026-11-01T00:00:00Z")
  }

  func testRetryAndSafetyWalksAlwaysListTheWholeLibrary() async throws {
    let store = try freshStore()
    try await store.recordCompletedFullScan(
      deviceId: "d", settingsFingerprint: "A", phChangeToken: token)
    let cursor = try await store.cursor(deviceId: "d")
    XCTAssertEqual(
      cursor.discovery(settingsFingerprint: "A", retryFailed: true, forceFullScan: false),
      .fullScan)
    XCTAssertEqual(
      cursor.discovery(settingsFingerprint: "A", retryFailed: false, forceFullScan: true),
      .fullScan)
  }

  func testReplayNeedsABaselineOfTheEligibleLibraryWhenSomethingIsExcluded() async throws {
    let store = try freshStore()
    try await store.recordCompletedFullScan(
      deviceId: "d", settingsFingerprint: "A", phChangeToken: token)
    let cursor = try await store.cursor(deviceId: "d")
    XCTAssertEqual(
      cursor.discovery(
        settingsFingerprint: "A", retryFailed: false, forceFullScan: false,
        hasEligibleBaseline: false),
      .fullScan)
    XCTAssertEqual(
      cursor.discovery(
        settingsFingerprint: "A", retryFailed: false, forceFullScan: false,
        hasEligibleBaseline: true),
      .changesSince(token: token))
  }

  func testWeekOldFullScanListsTheWholeLibraryAgain() async throws {
    let store = try freshStore()
    let finished = Date(timeIntervalSince1970: 1_800_000_000)
    try await store.recordCompletedFullScan(
      deviceId: "d", settingsFingerprint: "A", phChangeToken: token, at: finished)
    let cursor = try await store.cursor(deviceId: "d")
    XCTAssertEqual(cursor.fullScanCompletedAt, finished)
    XCTAssertEqual(
      cursor.discovery(
        settingsFingerprint: "A", retryFailed: false, forceFullScan: false,
        now: finished.addingTimeInterval(BackupCursor.fullScanInterval - 60)),
      .changesSince(token: token))
    XCTAssertEqual(
      cursor.discovery(
        settingsFingerprint: "A", retryFailed: false, forceFullScan: false,
        now: finished.addingTimeInterval(BackupCursor.fullScanInterval)),
      .fullScan)
  }

  func testCompletedScanWithoutATokenListsTheWholeLibrary() async throws {
    let store = try freshStore()
    try await store.recordCompletedFullScan(
      deviceId: "d", settingsFingerprint: "A", phChangeToken: nil)
    let cursor = try await store.cursor(deviceId: "d")
    XCTAssertEqual(
      cursor.discovery(settingsFingerprint: "A", retryFailed: false, forceFullScan: false),
      .fullScan)
  }

  func testServerSinceIsDroppedForFullScansAndUndeliveredEdits() {
    let cursor = BackupCursor(deviceId: "d", lastServerReconciledAt: "2026-11-01T00:00:00Z")
    XCTAssertEqual(
      cursor.serverSince(fullScan: false, hasUndeliveredEdits: false), "2026-11-01T00:00:00Z")
    XCTAssertNil(cursor.serverSince(fullScan: true, hasUndeliveredEdits: false))
    XCTAssertNil(cursor.serverSince(fullScan: false, hasUndeliveredEdits: true))
  }

  func testUpsertPreservesExistingCapturedAtWhenExcludedIsNil() async throws {
    let store = try freshStore()
    let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
    let shot = Date(timeIntervalSince1970: 1_700_000_000)
    try await store.upsert(
      BackupTask(id: id, state: .pending, priority: .background, capturedAt: shot))
    try await store.upsert(
      BackupTask(id: id, state: .uploaded, priority: .background, capturedAt: nil))
    let found = try await store.find(id)
    XCTAssertEqual(found?.state, .uploaded)
    XCTAssertEqual(found?.capturedAt, shot)
  }

  func testStartupSnapshotAndBackfillPendingCapturedDates() async throws {
    let store = try freshStore()
    try await store.upsert([
      BackupTask(
        id: BackupTaskID(deviceId: "d", phassetLocalId: "u1"),
        state: .uploaded, priority: .background),
      BackupTask(
        id: BackupTaskID(deviceId: "d", phassetLocalId: "p1"),
        state: .pending, priority: .background, capturedAt: nil),
      BackupTask(
        id: BackupTaskID(deviceId: "d", phassetLocalId: "f1"),
        state: .failedRetry, priority: .background),
    ])

    let snap = try await store.startupSnapshot(deviceId: "d")
    XCTAssertEqual(snap?.libraryPhotoIDs, ["u1", "p1", "f1"])
    XCTAssertEqual(snap?.backedUpPhotoIDs, ["u1"])

    let backfillDate = Date(timeIntervalSince1970: 1_700_000_999)
    let updated = try await store.backfillPendingCapturedDates(
      ["p1": backfillDate], deviceId: "d")
    XCTAssertEqual(updated.count, 1)
    XCTAssertEqual(updated.first?.capturedAt, backfillDate)
    let found = try await store.find(BackupTaskID(deviceId: "d", phassetLocalId: "p1"))
    XCTAssertEqual(found?.capturedAt, backfillDate)
  }

  func testBackfillLeavesRowsWaitingOutARetryBackoffToTheEngine() async throws {
    let store = try freshStore()
    let asleep = BackupTaskID(deviceId: "d", phassetLocalId: "asleep")
    try await store.upsert([
      BackupTask(id: asleep, state: .pending, priority: .background, retryCount: 2),
      BackupTask(
        id: BackupTaskID(deviceId: "d", phassetLocalId: "fresh"),
        state: .pending, priority: .background),
    ])
    let shot = Date(timeIntervalSince1970: 1_700_000_999)

    let updated = try await store.backfillPendingCapturedDates(
      ["asleep": shot, "fresh": shot], deviceId: "d")

    XCTAssertEqual(updated.map(\.id.phassetLocalId), ["fresh"])
    let found = try await store.find(asleep)
    XCTAssertNil(found?.capturedAt)
  }
}
