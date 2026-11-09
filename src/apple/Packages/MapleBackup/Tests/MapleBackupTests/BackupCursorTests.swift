// Tests/MapleBackupTests/BackupCursorTests.swift
import Foundation
import XCTest

@testable import MapleBackup

final class BackupCursorTests: XCTestCase {
  private func freshURL() -> URL {
    FileManager.default.temporaryDirectory
      .appendingPathComponent("backup-cursor-\(UUID().uuidString).sqlite")
  }

  func testUpsertPreservesExistingCapturedAtWhenExcludedIsNil() async throws {
    let store = try BackupStateStore(databaseURL: freshURL())
    let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
    let shot = Date(timeIntervalSince1970: 1_700_000_000)
    try await store.upsert(
      BackupTask(id: id, state: .pending, priority: .background, capturedAt: shot))
    // Server reconciliation upserts .uploaded without a capture date.
    try await store.upsert(
      BackupTask(id: id, state: .uploaded, priority: .background, capturedAt: nil))
    let found = try await store.find(id)
    XCTAssertEqual(found?.state, .uploaded)
    XCTAssertEqual(found?.capturedAt, shot)
  }

  func testUploadedWatermarksTrackEarliestAndLatestCaptureDates() async throws {
    let store = try BackupStateStore(databaseURL: freshURL())
    let t1 = Date(timeIntervalSince1970: 1_700_000_100)
    let t2 = Date(timeIntervalSince1970: 1_700_000_500)
    let t3 = Date(timeIntervalSince1970: 1_700_000_050)
    let id1 = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
    let id2 = BackupTaskID(deviceId: "d", phassetLocalId: "P2")
    let id3 = BackupTaskID(deviceId: "d", phassetLocalId: "P3")

    try await store.upsert([
      BackupTask(id: id1, state: .uploaded, priority: .background, capturedAt: t1),
      BackupTask(id: id2, state: .pending, priority: .background, capturedAt: t2),
      BackupTask(id: id3, state: .pending, priority: .background, capturedAt: t3),
    ])
    var cursor = try await store.cursor(deviceId: "d")
    XCTAssertEqual(cursor.newestBackedUpAt, t1)
    XCTAssertEqual(cursor.oldestBackedUpAt, t1)

    try await store.transition(id2, to: .uploaded, error: nil)
    cursor = try await store.cursor(deviceId: "d")
    XCTAssertEqual(cursor.newestBackedUpAt, t2)
    XCTAssertEqual(cursor.oldestBackedUpAt, t1)

    try await store.transition(id3, to: .uploaded, error: nil)
    cursor = try await store.cursor(deviceId: "d")
    XCTAssertEqual(cursor.newestBackedUpAt, t2)
    XCTAssertEqual(cursor.oldestBackedUpAt, t3)
  }

  func testAdvanceScanWatermarksMonotonicAndResetsOnFingerprintChange() async throws {
    let store = try BackupStateStore(databaseURL: freshURL())
    let d1 = Date(timeIntervalSince1970: 1_000)
    let d2 = Date(timeIntervalSince1970: 2_000)
    let d3 = Date(timeIntervalSince1970: 3_000)

    try await store.advanceScanWatermarks(
      deviceId: "d",
      newestScannedAt: d2,
      oldestScannedAt: d2,
      oldestScannedPhid: "P2",
      libraryEligibleCount: 100,
      settingsFingerprint: "fp-1",
      initialScanCompleted: false)

    try await store.advanceScanWatermarks(
      deviceId: "d",
      newestScannedAt: d3,
      oldestScannedAt: d1,
      oldestScannedPhid: "P1",
      libraryEligibleCount: 100,
      settingsFingerprint: "fp-1",
      initialScanCompleted: true)

    var cursor = try await store.cursor(deviceId: "d")
    XCTAssertEqual(cursor.newestScannedAt, d3)
    XCTAssertEqual(cursor.oldestScannedAt, d1)
    XCTAssertEqual(cursor.oldestScannedPhid, "P1")
    XCTAssertTrue(cursor.initialScanCompleted)

    // Changing settingsFingerprint resets scan bounds to the new pass's values.
    try await store.advanceScanWatermarks(
      deviceId: "d",
      newestScannedAt: d2,
      oldestScannedAt: d2,
      oldestScannedPhid: "P2",
      libraryEligibleCount: 150,
      settingsFingerprint: "fp-2",
      initialScanCompleted: false)

    cursor = try await store.cursor(deviceId: "d")
    XCTAssertEqual(cursor.newestScannedAt, d2)
    XCTAssertEqual(cursor.oldestScannedAt, d2)
    XCTAssertEqual(cursor.settingsFingerprint, "fp-2")
    XCTAssertFalse(cursor.initialScanCompleted)
  }

  func testStartupSnapshotAndBackfillPendingCapturedDates() async throws {
    let store = try BackupStateStore(databaseURL: freshURL())
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
    XCTAssertEqual(snap?.failedPermanentlyCount, 1)

    let backfillDate = Date(timeIntervalSince1970: 1_700_000_999)
    let updated = try await store.backfillPendingCapturedDates(
      ["p1": backfillDate], deviceId: "d")
    XCTAssertEqual(updated.count, 1)
    XCTAssertEqual(updated.first?.capturedAt, backfillDate)
    let found = try await store.find(BackupTaskID(deviceId: "d", phassetLocalId: "p1"))
    XCTAssertEqual(found?.capturedAt, backfillDate)
  }

  func testDeferredCompanionsAreReadAfterPrimaryUploadLands() async throws {
    let ingestedMapleId = "02371b94aade2246ba56c6770a7624e1"
    StubURLProtocol.stub = .sequence([
      .ok(
        json:
          #"{"maple_id":"\#(ingestedMapleId)","target_rel_path":"2024/03/15/IMG.heic"}"#),
      .ok(json: #"{"target_rel_path":"2024/03/15/IMG.rendered.jpeg"}"#),
      .ok(json: #"{"target_rel_path":"2024/03/15/IMG.mov"}"#),
    ])
    let tmpRoot = FileManager.default.temporaryDirectory
      .appendingPathComponent("engine-deferred-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: tmpRoot, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: tmpRoot) }

    let stateURL = tmpRoot.appendingPathComponent("state.sqlite")
    let sidecarRoot = tmpRoot.appendingPathComponent("sidecars", isDirectory: true)
    try FileManager.default.createDirectory(at: sidecarRoot, withIntermediateDirectories: true)

    let queue = InProcessBackupQueue()
    let state = try BackupStateStore(databaseURL: stateURL)
    let sidecars = AppSupportSidecarStore(root: sidecarRoot)
    let reader = DeferredCompanionAssetReader()
    let upload = UploadClient(
      baseURL: URL(string: "https://server.example")!,
      libraryId: "lib", deviceId: "d",
      transport: stubTransport())
    let engine = BackupEngine(
      queue: queue, state: state, upload: upload,
      sidecars: sidecars, reader: reader,
      companionBackoff: { _ in 0 })

    let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
    let task = BackupTask(id: id, state: .pending, priority: .background)
    try await state.upsert(task)
    await queue.enqueue(task, priority: .background)

    try await engine.processOne()

    let companionCalls = await reader.readCompanionsCalls
    XCTAssertEqual(companionCalls, 1)
    let renderedReqs = StubURLProtocol.recordedRequests
      .filter { $0.url?.path.contains("backup/rendered") == true }
    XCTAssertEqual(
      renderedReqs.count, 2,
      "both deferred rendered JPEG and Live Photo .mov must upload")
  }
}
