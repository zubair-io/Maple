// Tests/MapleBackupTests/BackupWalkReconcileTests.swift
// What a library walk writes while workers upload: server-held photos, deleted
// photos, the worker's claim on a row, and the local-edit check that decides
// whether a walk needs the server's full list. Real SQLite and AppSupport XMP
// files in a temp dir; only the HTTP transport is stubbed.
import Foundation
import GRDB
import XCTest

@testable import MapleBackup

final class BackupWalkReconcileTests: XCTestCase {

  override func setUp() {
    StubURLProtocol.stub = nil
    StubURLProtocol.clearRecording()
  }
  override func tearDown() {
    StubURLProtocol.stub = nil
    StubURLProtocol.clearRecording()
  }

  private func id(_ phid: String) -> BackupTaskID {
    BackupTaskID(deviceId: "d", phassetLocalId: phid)
  }

  private func held(_ phid: String) -> BackupTask {
    BackupTask(id: id(phid), state: .uploaded, priority: .background)
  }

  private func freshStore() throws -> BackupStateStore {
    try BackupStateStore(
      databaseURL: FileManager.default.temporaryDirectory
        .appendingPathComponent("backup-reconcile-\(UUID().uuidString).sqlite"))
  }

  func testServerHeldSettlesOnlyRowsNoWorkerHasClaimed() async throws {
    let store = try freshStore()
    let shot = Date(timeIntervalSince1970: 1_700_000_000)
    try await store.upsert([
      BackupTask(id: id("pending"), state: .pending, priority: .background, capturedAt: shot),
      BackupTask(id: id("uploading"), state: .uploading, priority: .background),
      BackupTask(id: id("retrying"), state: .pending, priority: .background, retryCount: 1),
      BackupTask(id: id("failed"), state: .failedRetry, priority: .background),
    ])

    let cancelled = try await store.markServerHeld(
      ["pending", "uploading", "retrying", "failed", "new"].map(held))

    XCTAssertEqual(cancelled, [id("pending")])
    let pending = try await store.find(id("pending"))
    XCTAssertEqual(pending?.state, .uploaded)
    XCTAssertEqual(pending?.capturedAt, shot)
    let uploading = try await store.find(id("uploading"))
    XCTAssertEqual(uploading?.state, .uploading)
    let retrying = try await store.find(id("retrying"))
    XCTAssertEqual(retrying?.state, .pending, "a retry may still owe the photo's companions")
    let failed = try await store.find(id("failed"))
    XCTAssertEqual(failed?.state, .uploaded)
    let new = try await store.find(id("new"))
    XCTAssertEqual(new?.state, .uploaded)
  }

  func testWorkerClaimBeforeTheWalkKeepsTheUpload() async throws {
    let store = try freshStore()
    try await store.upsert(BackupTask(id: id("P1"), state: .pending, priority: .background))

    let claimed = try await store.claimForUpload(id("P1"))
    let cancelled = try await store.markServerHeld([held("P1")])

    XCTAssertTrue(claimed)
    XCTAssertEqual(cancelled, [])
    let row = try await store.find(id("P1"))
    XCTAssertEqual(row?.state, .uploading)
  }

  func testWorkerDropsATaskTheWalkAlreadySettled() async throws {
    StubURLProtocol.stub = ingestAndSidecarStub()
    let (engine, queue, state, _, _, tmpRoot) = try freshHarness()
    defer { try? FileManager.default.removeItem(at: tmpRoot) }
    let sink = EventSink()
    await sink.attach(to: queue)
    defer { sink.stop() }

    let task = BackupTask(id: id("P1"), state: .pending, priority: .background)
    try await state.upsert(task)
    await queue.enqueue(task, priority: .background)
    let settled = try await state.markServerHeld([held("P1")])
    XCTAssertEqual(settled, [id("P1")])

    try await engine.processOne()

    XCTAssertTrue(StubURLProtocol.recordedRequests.isEmpty, "no upload of a settled photo")
    let row = try await state.find(id("P1"))
    XCTAssertEqual(row?.state, .uploaded)
    let isCancel: (BackupQueueEvent) -> Bool = { if case .cancelled = $0 { true } else { false } }
    let deadline = Date().addingTimeInterval(2)
    while Date() < deadline, sink.count(where: isCancel) == 0 {
      try await Task.sleep(nanoseconds: 10_000_000)
    }
    XCTAssertEqual(sink.count(where: isCancel), 1)
    XCTAssertEqual(sink.count { if case .completed = $0 { true } else { false } }, 0)
  }

  func testRemoveDeletedForgetsRowsExceptLiveUploads() async throws {
    let store = try freshStore()
    try await store.upsert([
      BackupTask(id: id("pending"), state: .pending, priority: .background),
      BackupTask(id: id("uploading"), state: .uploading, priority: .background),
      BackupTask(id: id("uploaded"), state: .uploaded, priority: .background),
    ])

    let cancelled = try await store.removeDeleted(
      ["pending", "uploading", "uploaded", "unknown"].map(id))

    XCTAssertEqual(cancelled, [id("pending")])
    let remaining = try await store.allTasks().map(\.id.phassetLocalId)
    XCTAssertEqual(remaining, ["uploading"])
  }

  func testEditToABackedUpPhotoIsUndeliveredUntilItsResendLands() async throws {
    let (engine, _, state, sidecars, _, tmpRoot) = try freshHarness()
    defer { try? FileManager.default.removeItem(at: tmpRoot) }
    let photo = id("P1/L0/001")
    try await state.upsert(BackupTask(id: photo, state: .uploaded, priority: .background))
    try await state.upsert(BackupTask(id: id("P2"), state: .pending, priority: .background))
    try sidecars.write(phassetLocalId: "P2", xmp: "<x:edit>pending</x:edit>")

    let noEdit = await engine.hasUndeliveredEdits(deviceId: "d")
    XCTAssertFalse(noEdit, "an edit to a photo not yet uploaded rides its own upload")

    try sidecars.write(phassetLocalId: photo.phassetLocalId, xmp: "<x:edit>B</x:edit>")
    let edited = await engine.hasUndeliveredEdits(deviceId: "d")
    XCTAssertTrue(edited, "the walk must then ask the server for every held photo")

    let target = "2024/03/15/IMG.heic"
    StubURLProtocol.stub = .ok(
      json: #"{"target_rel_path":"\#(BackupSidecarName.canonical(for: target))"}"#)
    await engine.resendNewerEdits(
      [ServerHeldAsset(id: photo, targetRelPath: target, mapleId: "hash-P1")])

    let delivered = await engine.hasUndeliveredEdits(deviceId: "d")
    XCTAssertFalse(delivered)
  }

  func testDeliveredVideoEditCountsAsDeliveredUnderItsCanonicalName() async throws {
    let (engine, _, state, sidecars, _, tmpRoot) = try freshHarness()
    defer { try? FileManager.default.removeItem(at: tmpRoot) }
    let video = id("V1")
    let xmp = "<x:edit>clip</x:edit>"
    try await state.upsert(BackupTask(id: video, state: .uploaded, priority: .background))
    try sidecars.write(phassetLocalId: video.phassetLocalId, xmp: xmp)
    try await state.recordUploadedSidecar(
      video, digest: BackupEngine.digest(of: xmp), canonicalName: false)
    let legacyRow = await engine.hasUndeliveredEdits(deviceId: "d")
    XCTAssertTrue(legacyRow)

    await engine.resendNewerEdits(
      [ServerHeldAsset(id: video, targetRelPath: "2024/03/15/CLIP.mov", mapleId: "hash-V1")])

    XCTAssertTrue(StubURLProtocol.recordedRequests.isEmpty, "the server already has this edit")
    let settled = await engine.hasUndeliveredEdits(deviceId: "d")
    XCTAssertFalse(settled)
  }

  func testDeferredCompanionReadFailureIsRetried() async throws {
    let ingest = StubURLProtocol.Stub.ok(
      json: #"{"maple_id":"hash-P1","target_rel_path":"2024/03/15/IMG.heic"}"#)
    StubURLProtocol.stub = .sequence([
      ingest, ingest,
      .ok(json: #"{"target_rel_path":"2024/03/15/IMG.rendered.jpeg"}"#),
      .ok(json: #"{"target_rel_path":"2024/03/15/IMG.mov"}"#),
    ])
    let reader = DeferredCompanionAssetReader(failingReads: 1)
    let (engine, queue, state, _, tmpRoot) =
      try freshHarness(companionBackoff: { _ in 0 }, reader: reader)
    defer { try? FileManager.default.removeItem(at: tmpRoot) }

    let task = BackupTask(id: id("P1"), state: .pending, priority: .background)
    try await state.upsert(task)
    await queue.enqueue(task, priority: .background)
    do {
      try await engine.processOne()
      XCTFail("an unreadable companion fails the attempt")
    } catch {}
    let afterFailure = try await state.find(task.id)
    XCTAssertEqual(afterFailure?.state, .pending, "kept for retry, including across a relaunch")
    XCTAssertEqual(afterFailure?.retryCount, 1)

    await engine.stop()
    var retry = task
    retry.retryCount = 1
    await queue.enqueue(retry, priority: .background)
    try await engine.processOne()

    let companionUploads = {
      StubURLProtocol.recordedRequests.filter { $0.url?.path.contains("backup/rendered") == true }
    }
    let deadline = Date().addingTimeInterval(2)
    while Date() < deadline, companionUploads().count < 2 {
      try await Task.sleep(nanoseconds: 10_000_000)
    }
    XCTAssertEqual(companionUploads().count, 2, "rendered and Live Photo twins land on retry")
    let reads = await reader.reads
    XCTAssertEqual(reads[.rendered], 2)
    XCTAssertEqual(reads[.liveVideo], 1)
    let row = try await state.find(task.id)
    XCTAssertEqual(row?.state, .uploaded)
  }

  func testExhaustedCompanionReadsLeaveThePhotoFailedUntilARetryDeliversThem() async throws {
    let ingest = StubURLProtocol.Stub.ok(
      json: #"{"maple_id":"hash-P1","target_rel_path":"2024/03/15/IMG.heic"}"#)
    StubURLProtocol.stub = .sequence([
      ingest, ingest,
      .ok(json: #"{"target_rel_path":"2024/03/15/IMG.rendered.jpeg"}"#),
      .ok(json: #"{"target_rel_path":"2024/03/15/IMG.mov"}"#),
    ])
    let reader = DeferredCompanionAssetReader(failingReads: 1)
    let (engine, queue, state, _, tmpRoot) =
      try freshHarness(companionBackoff: { _ in 0 }, reader: reader)
    defer { try? FileManager.default.removeItem(at: tmpRoot) }
    let lastAttempt = BackupTask(
      id: id("P1"), state: .pending, priority: .background, retryCount: 7)
    try await state.upsert(lastAttempt)
    await queue.enqueue(lastAttempt, priority: .background)

    do {
      try await engine.processOne()
      XCTFail("an unreadable companion fails the last attempt")
    } catch {}

    let failed = try await state.find(lastAttempt.id)
    XCTAssertEqual(failed?.state, .failedRetry, "out of retries with companions undelivered")
    let owing = try await state.phidsOwingCompanions(deviceId: "d")
    XCTAssertEqual(owing, ["P1"], "never counted as backed up")

    let settled = try await state.markServerHeld([held("P1")])
    XCTAssertEqual(settled, [])
    let afterWalk = try await state.find(lastAttempt.id)
    XCTAssertEqual(afterWalk?.state, .failedRetry, "the server holding the original is not enough")
    let rehydrated = try await state.rehydrate(into: InProcessBackupQueue())
    XCTAssertEqual(rehydrated, 0, "a failed photo waits for the user's retry")

    let requeued = try await state.requeueFailed([
      BackupTask(id: lastAttempt.id, state: .pending, priority: .background)
    ])
    XCTAssertEqual(requeued.map(\.id), [lastAttempt.id])
    let reset = try await state.find(lastAttempt.id)
    XCTAssertEqual(reset?.state, .pending)
    XCTAssertEqual(reset?.retryCount, 0)

    await engine.stop()
    await queue.enqueue(requeued, priority: nil)
    try await engine.processOne()

    let companionUploads = StubURLProtocol.recordedRequests.filter {
      $0.url?.path.contains("backup/rendered") == true
    }
    XCTAssertEqual(companionUploads.count, 2, "rendered and Live Photo twins land on the retry")
    let delivered = try await state.find(lastAttempt.id)
    XCTAssertEqual(delivered?.state, .uploaded)
    let stillOwing = try await state.phidsOwingCompanions(deviceId: "d")
    XCTAssertEqual(stillOwing, [])
  }

  func testOriginalSentWithoutAResponseStillOwesItsCompanions() async throws {
    StubURLProtocol.stub = .status(500)
    let reader = DeferredCompanionAssetReader(failingReads: 0)
    let (engine, queue, state, _, tmpRoot) =
      try freshHarness(companionBackoff: { _ in 0 }, reader: reader)
    defer { try? FileManager.default.removeItem(at: tmpRoot) }
    let lastAttempt = BackupTask(
      id: id("P1"), state: .pending, priority: .background, retryCount: 7)
    try await state.upsert(lastAttempt)
    await queue.enqueue(lastAttempt, priority: .background)

    do {
      try await engine.processOne()
      XCTFail("the original upload fails")
    } catch {}

    let settled = try await state.markServerHeld([held("P1")])
    XCTAssertEqual(settled, [])
    let row = try await state.find(lastAttempt.id)
    XCTAssertEqual(row?.state, .failedRetry)
  }

  func testRetryLeavesFailuresTheWalkSettledAlone() async throws {
    let store = try freshStore()
    try await store.upsert([
      BackupTask(id: id("held"), state: .failedRetry, priority: .background, retryCount: 8),
      BackupTask(id: id("owing"), state: .failedRetry, priority: .background, retryCount: 8),
      BackupTask(id: id("unknown"), state: .failedRetry, priority: .background, retryCount: 8),
    ])
    try await store.markCompanionsOwed(id("owing"))

    _ = try await store.markServerHeld([held("held"), held("owing")])
    let requeued = try await store.requeueFailed(
      ["held", "owing", "unknown"].map {
        BackupTask(id: id($0), state: .pending, priority: .background)
      })

    XCTAssertEqual(Set(requeued.map(\.id)), [id("owing"), id("unknown")])
    let held = try await store.find(id("held"))
    XCTAssertEqual(held?.state, .uploaded)
    let owing = try await store.find(id("owing"))
    XCTAssertEqual(owing?.state, .pending)
    XCTAssertEqual(owing?.retryCount, 0)
  }

  func testExhaustedCompanionUploadsLeaveThePhotoFailedUntilARetryDeliversThem() async throws {
    let ingest = StubURLProtocol.Stub.ok(
      json: #"{"maple_id":"hash-P1","target_rel_path":"2024/03/15/IMG.heic"}"#)
    StubURLProtocol.stub = .sequence([
      ingest, .status(500),
      ingest, .ok(json: #"{"target_rel_path":"2024/03/15/IMG.rendered.jpeg"}"#),
    ])
    let (engine, queue, state, _, tmpRoot) =
      try freshHarness(companionBackoff: { _ in 0 }, reader: RenderedAssetReader())
    defer { try? FileManager.default.removeItem(at: tmpRoot) }
    let lastAttempt = BackupTask(
      id: id("P1"), state: .pending, priority: .background, retryCount: 7)
    try await state.upsert(lastAttempt)
    await queue.enqueue(lastAttempt, priority: .background)

    do {
      try await engine.processOne()
      XCTFail("a failed render upload fails the last attempt")
    } catch {}

    let failed = try await state.find(lastAttempt.id)
    XCTAssertEqual(failed?.state, .failedRetry, "out of retries with the render undelivered")
    let owing = try await state.phidsOwingCompanions(deviceId: "d")
    XCTAssertEqual(owing, ["P1"])
    let settled = try await state.markServerHeld([held("P1")])
    XCTAssertEqual(settled, [])
    let afterWalk = try await state.find(lastAttempt.id)
    XCTAssertEqual(afterWalk?.state, .failedRetry, "the server holding the original is not enough")

    let requeued = try await state.requeueFailed([
      BackupTask(id: lastAttempt.id, state: .pending, priority: .background)
    ])
    XCTAssertEqual(requeued.map(\.id), [lastAttempt.id])
    await queue.enqueue(requeued, priority: nil)
    try await engine.processOne()

    let renderUploads = StubURLProtocol.recordedRequests.filter {
      $0.url?.path.contains("backup/rendered") == true
    }
    XCTAssertEqual(renderUploads.count, 2, "the failed render and its successful retry")
    let delivered = try await state.find(lastAttempt.id)
    XCTAssertEqual(delivered?.state, .uploaded)
    let stillOwing = try await state.phidsOwingCompanions(deviceId: "d")
    XCTAssertEqual(stillOwing, [])
  }

  private func failLastAttempt(
    reading reader: any AssetReader
  ) async throws -> (BackupStateStore, URL) {
    StubURLProtocol.stub = .status(500)
    let (engine, queue, state, _, tmpRoot) =
      try freshHarness(companionBackoff: { _ in 0 }, reader: reader)
    let lastAttempt = BackupTask(
      id: id("P1"), state: .pending, priority: .background, retryCount: 7)
    try await state.upsert(lastAttempt)
    await queue.enqueue(lastAttempt, priority: .background)
    do {
      try await engine.processOne()
      XCTFail("the original upload fails")
    } catch {}
    let row = try await state.find(lastAttempt.id)
    XCTAssertEqual(row?.state, .failedRetry)
    return (state, tmpRoot)
  }

  func testPhotoWithoutCompanionsIsNotFlaggedAndAWalkCanSettleIt() async throws {
    let (state, tmpRoot) = try await failLastAttempt(reading: StubAssetReader())
    defer { try? FileManager.default.removeItem(at: tmpRoot) }

    let owing = try await state.phidsOwingCompanions(deviceId: "d")
    XCTAssertEqual(owing, [])
    _ = try await state.markServerHeld([held("P1")])
    let row = try await state.find(id("P1"))
    XCTAssertEqual(row?.state, .uploaded, "the server holding the original is the whole photo")
  }

  func testLivePhotoVideoReadWithTheOriginalIsOwed() async throws {
    let (state, tmpRoot) = try await failLastAttempt(reading: LivePhotoAssetReader())
    defer { try? FileManager.default.removeItem(at: tmpRoot) }

    let owing = try await state.phidsOwingCompanions(deviceId: "d")
    XCTAssertEqual(owing, ["P1"])
    _ = try await state.markServerHeld([held("P1")])
    let row = try await state.find(id("P1"))
    XCTAssertEqual(row?.state, .failedRetry)
  }

  func testUpgradeMarksRowsAnOlderVersionMayHaveLeftOwingCompanions() async throws {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("backup-upgrade-\(UUID().uuidString).sqlite")
    defer { try? FileManager.default.removeItem(at: url) }
    let rows: [(phid: String, state: BackupState, retries: Int)] = [
      ("failed", .failedRetry, 8),
      ("retrying", .pending, 2),
      ("fresh", .pending, 0),
      ("done", .uploaded, 0),
    ]
    let legacy = try DatabaseQueue(path: url.path)
    try await legacy.write { db in
      try db.execute(
        sql: """
          CREATE TABLE tasks (
            device_id TEXT NOT NULL, phasset_local_id TEXT NOT NULL,
            state TEXT NOT NULL, priority INTEGER NOT NULL,
            retry_count INTEGER NOT NULL DEFAULT 0, last_error TEXT,
            enqueued_at DOUBLE NOT NULL, captured_at DOUBLE,
            PRIMARY KEY (device_id, phasset_local_id))
          """)
      for row in rows {
        try db.execute(
          sql: """
            INSERT INTO tasks (device_id, phasset_local_id, state, priority, retry_count, enqueued_at)
            VALUES ('d', ?, ?, 0, ?, 0)
            """,
          arguments: [row.phid, row.state.rawValue, row.retries])
      }
    }
    try legacy.close()

    let store = try BackupStateStore(databaseURL: url)

    let owing = try await store.phidsOwingCompanions(deviceId: "d")
    XCTAssertEqual(owing, ["failed", "retrying"])
    let settled = try await store.markServerHeld(rows.map { held($0.phid) })
    XCTAssertEqual(settled, [id("fresh")])
    let failed = try await store.find(id("failed"))
    XCTAssertEqual(failed?.state, .failedRetry)
    let retrying = try await store.find(id("retrying"))
    XCTAssertEqual(retrying?.state, .pending)

    try await store.upsert(
      BackupTask(id: id("later"), state: .failedRetry, priority: .background, retryCount: 8))
    let reopened = try BackupStateStore(databaseURL: url)
    let owingAfterReopen = try await reopened.phidsOwingCompanions(deviceId: "d")
    XCTAssertEqual(owingAfterReopen, ["failed", "retrying"], "the backfill runs only once")
  }
}
