// Tests/MapleBackupTests/BackupEngineWifiGateTests.swift
//
// The Wi-Fi gate holds a dequeued task until Wi-Fi returns, and must not undo
// what a library walk wrote to the task's row while it waited.
import XCTest

@testable import MapleBackup

final class BackupEngineWifiGateTests: XCTestCase {

  private let photo = BackupTaskID(deviceId: "d", phassetLocalId: "P1")

  private func gatedEngine() throws -> (BackupEngine, InProcessBackupQueue, BackupStateStore, URL) {
    let (_, queue, state, sidecars, _, root) = try freshHarness()
    let upload = UploadClient(
      baseURL: URL(string: "https://server.example")!, libraryId: "lib", deviceId: "d",
      transport: stubTransport())
    let engine = BackupEngine(
      queue: queue, state: state, upload: upload, sidecars: sidecars, reader: StubAssetReader(),
      reachability: Reachability(fixed: .cellular), wifiOnly: true)
    return (engine, queue, state, root)
  }

  private func processWhileGated(
    _ engine: BackupEngine, taskID: BackupTaskID, queue: InProcessBackupQueue
  ) async throws {
    await queue.enqueue(
      BackupTask(id: taskID, state: .pending, priority: .background), priority: .background)
    let work = Task { try await engine.processOne() }
    try await Task.sleep(for: .milliseconds(300))
    work.cancel()
    _ = try? await work.value
  }

  func testAnExcludedRetryWaitingOutItsBackoffOnCellularStaysParked() async throws {
    let (engine, queue, state, root) = try gatedEngine()
    defer { try? FileManager.default.removeItem(at: root) }
    try await state.upsert(
      BackupTask(id: photo, state: .pending, priority: .background, retryCount: 3))
    try await state.markCompanionsOwed(photo)
    _ = try await state.suspendExcluded([photo])

    try await processWhileGated(engine, taskID: photo, queue: queue)

    let row = try await state.find(photo)
    XCTAssertEqual(row?.state, .skippedPolicy, "the gate must not turn an excluded row pending")
    XCTAssertEqual(row?.retryCount, 3)
  }

  func testAPhotoAWalkSettledWhileItWaitedForWifiStaysUploaded() async throws {
    let (engine, queue, state, root) = try gatedEngine()
    defer { try? FileManager.default.removeItem(at: root) }
    try await state.upsert(BackupTask(id: photo, state: .uploaded, priority: .background))

    try await processWhileGated(engine, taskID: photo, queue: queue)

    let row = try await state.find(photo)
    XCTAssertEqual(row?.state, .uploaded)
  }

  func testAQueuedTaskOnCellularReturnsToPendingAndWaits() async throws {
    let (engine, queue, state, root) = try gatedEngine()
    defer { try? FileManager.default.removeItem(at: root) }
    try await state.upsert(BackupTask(id: photo, state: .pending, priority: .background))

    try await processWhileGated(engine, taskID: photo, queue: queue)

    let row = try await state.find(photo)
    XCTAssertEqual(row?.state, .pending)
  }
}
