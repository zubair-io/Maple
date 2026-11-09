// Tests/MapleBackupTests/BackupCompanionRepairTests.swift
// The full-scan repair for photos recorded as uploaded without their Live
// Photo video or edited render (#5778): which photos it picks, the once-only
// re-queue, and the engine re-sending the companions. Real SQLite files in a
// temp dir; only the HTTP transport is stubbed.
import Foundation
import GRDB
import XCTest

@testable import MapleBackup

final class BackupCompanionRepairTests: XCTestCase {

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

  private func task(_ phid: String, _ state: BackupState) -> BackupTask {
    BackupTask(id: id(phid), state: state, priority: .background)
  }

  private func storeURL() -> URL {
    FileManager.default.temporaryDirectory
      .appendingPathComponent("backup-companion-repair-\(UUID().uuidString).sqlite")
  }

  // MARK: - Which photos lack a companion

  func testLackingNamesOnlyCompanionsTheServerReportsMissing() {
    let lacking = CompanionRepair.lacking(
      local: [
        "live": [.liveVideo],
        "liveHeld": [.liveVideo],
        "editedLive": [.liveVideo, .rendered],
        "unreported": [.liveVideo, .rendered],
        "plain": [],
      ],
      held: [
        "live": [],
        "liveHeld": [.liveVideo],
        "editedLive": [.liveVideo],
        "plain": [],
      ],
      includeLivePhotos: true)

    XCTAssertEqual(lacking, ["live": [.liveVideo], "editedLive": [.rendered]])
  }

  func testLackingIgnoresTheLiveVideoWhenLivePhotosAreExcluded() {
    let lacking = CompanionRepair.lacking(
      local: ["live": [.liveVideo], "editedLive": [.liveVideo, .rendered]],
      held: ["live": [], "editedLive": []],
      includeLivePhotos: false)

    XCTAssertEqual(lacking, ["editedLive": [.rendered]])
  }

  func testAServerThatDoesNotReportCompanionsReportsNone() {
    XCTAssertNil(BackupCompanions(serverHasLiveVideo: nil, serverHasRendered: nil))
    XCTAssertNil(BackupCompanions(serverHasLiveVideo: true, serverHasRendered: nil))
    XCTAssertEqual(
      BackupCompanions(serverHasLiveVideo: false, serverHasRendered: false), [])
    XCTAssertEqual(
      BackupCompanions(serverHasLiveVideo: true, serverHasRendered: false), [.liveVideo])
    XCTAssertEqual(
      BackupCompanions(serverHasLiveVideo: false, serverHasRendered: true), [.rendered])
  }

  // MARK: - Store

  func testCandidatesAreUploadedRowsNotYetRepaired() async throws {
    let store = try BackupStateStore(databaseURL: storeURL())
    try await store.upsert([
      task("uploaded", .uploaded), task("pending", .pending),
      task("failed", .failedRetry), task("repaired", .uploaded),
    ])
    _ = try await store.requeueForMissingCompanions([task("repaired", .pending)])
    try await store.transition(id("repaired"), to: .uploaded)

    let candidates = try await store.companionRepairCandidates(
      deviceId: "d", among: ["uploaded", "pending", "failed", "repaired", "unknown"])

    XCTAssertEqual(candidates, ["uploaded"])
  }

  func testRequeueOwesCompanionsSoTheServerListingCannotSettleIt() async throws {
    let store = try BackupStateStore(databaseURL: storeURL())
    let shot = Date(timeIntervalSince1970: 1_700_000_000)
    try await store.upsert([
      BackupTask(
        id: id("P1"), state: .uploaded, priority: .background, retryCount: 3, capturedAt: shot),
      task("P2", .pending),
    ])

    let requeued = try await store.requeueForMissingCompanions([
      task("P1", .pending), task("P2", .pending),
    ])

    XCTAssertEqual(requeued.map(\.id), [id("P1")], "only an uploaded row is repaired")
    let row = try await store.find(id("P1"))
    XCTAssertEqual(row?.state, .pending)
    XCTAssertEqual(row?.retryCount, 0)
    XCTAssertEqual(row?.capturedAt, shot)
    let owing = try await store.phidsOwingCompanions(deviceId: "d")
    XCTAssertEqual(owing, ["P1"])
    let settled = try await store.markServerHeld([task("P1", .uploaded)])
    XCTAssertEqual(settled, [])
    let afterWalk = try await store.find(id("P1"))
    XCTAssertEqual(afterWalk?.state, .pending, "the original on the server is not enough")
  }

  func testAPhotoIsRepairedOnlyOnce() async throws {
    let store = try BackupStateStore(databaseURL: storeURL())
    try await store.upsert(task("P1", .uploaded))

    let first = try await store.requeueForMissingCompanions([task("P1", .pending)])
    try await store.transition(id("P1"), to: .uploaded)
    let second = try await store.requeueForMissingCompanions([task("P1", .pending)])

    XCTAssertEqual(first.count, 1)
    XCTAssertEqual(second, [], "a companion that still did not land is not re-queued again")
    let row = try await store.find(id("P1"))
    XCTAssertEqual(row?.state, .uploaded)
    let owing = try await store.phidsOwingCompanions(deviceId: "d")
    XCTAssertEqual(owing, [])
  }

  func testTheRepairMarkSurvivesReopeningTheStore() async throws {
    let url = storeURL()
    do {
      let store = try BackupStateStore(databaseURL: url)
      try await store.upsert(task("P1", .uploaded))
      _ = try await store.requeueForMissingCompanions([task("P1", .pending)])
      try await store.transition(id("P1"), to: .uploaded)
    }

    let reopened = try BackupStateStore(databaseURL: url)
    let candidates = try await reopened.companionRepairCandidates(deviceId: "d", among: ["P1"])

    XCTAssertEqual(candidates, [])
  }

  func testAStoreFromBeforeTheRepairGainsTheColumnWithEveryRowUnrepaired() async throws {
    let url = storeURL()
    let legacy = try DatabaseQueue(path: url.path)
    try await legacy.write { db in
      try db.execute(
        sql: """
          CREATE TABLE tasks (
            device_id TEXT NOT NULL, phasset_local_id TEXT NOT NULL, state TEXT NOT NULL,
            priority INTEGER NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0,
            last_error TEXT, enqueued_at DOUBLE NOT NULL, captured_at DOUBLE,
            companions_owed INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (device_id, phasset_local_id))
          """)
      try db.execute(
        sql: """
          INSERT INTO tasks (device_id, phasset_local_id, state, priority, enqueued_at)
          VALUES ('d', 'old', 'uploaded', 0, 1.0)
          """)
    }
    try legacy.close()

    let store = try BackupStateStore(databaseURL: url)
    let candidates = try await store.companionRepairCandidates(deviceId: "d", among: ["old"])

    XCTAssertEqual(candidates, ["old"])
  }

  // MARK: - The scan's repair

  private actor DeviceLookups {
    private(set) var asked: [Set<String>] = []
    func record(_ phids: Set<String>) { asked.append(phids) }
  }

  func testRepairAsksPhotoKitOnlyAboutUploadedSuspectsAndRequeuesConfirmedOnes() async throws {
    let store = try BackupStateStore(databaseURL: storeURL())
    let queue = InProcessBackupQueue()
    let shot = Date(timeIntervalSince1970: 1_700_000_000)
    try await store.upsert([
      task("live", .uploaded), task("edited", .uploaded), task("unedited", .uploaded),
      task("complete", .uploaded), task("pending", .pending), task("oldServer", .uploaded),
    ])
    let lookups = DeviceLookups()

    let requeued = try await CompanionRepair.requeueMissing(
      possible: [
        "live": [.liveVideo], "edited": [.rendered], "unedited": [.rendered],
        "complete": [.liveVideo], "pending": [.liveVideo], "oldServer": [.liveVideo],
        "plain": [],
      ],
      held: [
        "live": [], "edited": [], "unedited": [], "complete": [.liveVideo], "pending": [],
        "plain": [],
      ],
      includeLivePhotos: true, deviceId: "d", capturedAt: ["live": shot],
      state: store, queue: queue,
      onDevice: { phids in
        await lookups.record(phids)
        return ["live": [.liveVideo], "edited": [.rendered], "unedited": []]
      })

    XCTAssertEqual(requeued, ["live", "edited"])
    let asked = await lookups.asked
    XCTAssertEqual(asked, [["live", "edited", "unedited"]])
    let queued = await queue.snapshot()
    XCTAssertEqual(Set(queued.map(\.id.phassetLocalId)), ["live", "edited"])
    let live = try await store.find(id("live"))
    XCTAssertEqual(live?.state, .pending)
    XCTAssertEqual(live?.capturedAt, shot)
    let unedited = try await store.find(id("unedited"))
    XCTAssertEqual(unedited?.state, .uploaded)
  }

  func testASecondScanDoesNotRepairTheSamePhotoAgain() async throws {
    let store = try BackupStateStore(databaseURL: storeURL())
    try await store.upsert(task("live", .uploaded))
    let repair = {
      try await CompanionRepair.requeueMissing(
        possible: ["live": [.liveVideo]], held: ["live": []], includeLivePhotos: true,
        deviceId: "d", capturedAt: [:], state: store, queue: InProcessBackupQueue(),
        onDevice: { _ in ["live": [.liveVideo]] })
    }

    let first = try await repair()
    try await store.transition(id("live"), to: .uploaded)
    let second = try await repair()

    XCTAssertEqual(first, ["live"])
    XCTAssertEqual(second, [])
  }

  // MARK: - End to end

  func testAReinstalledDeviceResendsTheLivePhotoVideoTheServerLacks() async throws {
    let ingest = StubURLProtocol.Stub.ok(
      json: #"{"maple_id":"hash-P1","target_rel_path":"2024/03/15/IMG.heic"}"#)
    StubURLProtocol.stub = .sequence([
      ingest, .ok(json: #"{"target_rel_path":"2024/03/15/IMG.mov"}"#),
    ])
    let (engine, queue, state, _, tmpRoot) =
      try freshHarness(companionBackoff: { _ in 0 }, reader: LivePhotoAssetReader())
    defer { try? FileManager.default.removeItem(at: tmpRoot) }

    _ = try await state.markServerHeld([task("P1", .uploaded)])
    let requeued = try await CompanionRepair.requeueMissing(
      possible: ["P1": [.liveVideo]], held: ["P1": []], includeLivePhotos: true,
      deviceId: "d", capturedAt: [:], state: state, queue: queue,
      onDevice: { _ in ["P1": [.liveVideo]] })
    XCTAssertEqual(requeued, ["P1"])
    try await engine.processOne()

    let paths = StubURLProtocol.recordedRequests.compactMap { $0.url?.path }
    XCTAssertEqual(paths.filter { $0.contains("backup/rendered") }.count, 1, "the .mov is re-sent")
    let row = try await state.find(id("P1"))
    XCTAssertEqual(row?.state, .uploaded)
    let owing = try await state.phidsOwingCompanions(deviceId: "d")
    XCTAssertEqual(owing, [])
    let again = try await state.companionRepairCandidates(deviceId: "d", among: ["P1"])
    XCTAssertEqual(again, [])
  }

  func testARepairWhoseCompanionKeepsFailingEndsInFailedRetry() async throws {
    let ingest = StubURLProtocol.Stub.ok(
      json: #"{"maple_id":"hash-P1","target_rel_path":"2024/03/15/IMG.heic"}"#)
    StubURLProtocol.stub = .sequence([ingest, .status(500)])
    let (engine, queue, state, _, tmpRoot) =
      try freshHarness(companionBackoff: { _ in 0 }, reader: LivePhotoAssetReader())
    defer { try? FileManager.default.removeItem(at: tmpRoot) }
    try await state.upsert(task("P1", .uploaded))
    let requeued = try await state.requeueForMissingCompanions([task("P1", .pending)])
    try await state.transition(id("P1"), to: .pending, retryCount: 7)
    var lastAttempt = try XCTUnwrap(requeued.first)
    lastAttempt.retryCount = 7

    await queue.enqueue(lastAttempt, priority: .background)
    do {
      try await engine.processOne()
      XCTFail("the companion upload fails the attempt")
    } catch {}

    let row = try await state.find(id("P1"))
    XCTAssertEqual(row?.state, .failedRetry)
    let settled = try await state.markServerHeld([task("P1", .uploaded)])
    XCTAssertEqual(settled, [])
    let afterWalk = try await state.find(id("P1"))
    XCTAssertEqual(afterWalk?.state, .failedRetry, "left for the user's Retry, not settled")
  }
}
