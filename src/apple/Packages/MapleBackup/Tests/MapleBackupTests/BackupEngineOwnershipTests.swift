import XCTest

@testable import MapleBackup

private actor CompanionShutdownGate {
  let started: XCTestExpectation
  var attempts = 0
  var stopped = false
  var resume: CheckedContinuation<Void, Never>?
  init(_ started: XCTestExpectation) { self.started = started }
  func upload() async throws {
    attempts += 1
    guard attempts > 1 else { throw URLError(.badServerResponse) }
    await withCheckedContinuation {
      resume = $0
      started.fulfill()
    }
    throw CancellationError()
  }
  func release() {
    resume?.resume()
    resume = nil
  }
  func didStop() { stopped = true }
}

final class BackupEngineOwnershipTests: XCTestCase {
  func testContendingHostCannotResetUploadingRowsAndCancellationStopsWaiting() async throws {
    let id = BackupTaskID(deviceId: "device", phassetLocalId: "asset")
    if let path = ProcessInfo.processInfo.environment["MAPLE_BACKUP_OWNER_TEST_DB"] {
      let state = try BackupStateStore(databaseURL: URL(fileURLWithPath: path))
      let startup = Task {
        try await state.acquireEngineOwnership()
        for task in try await state.tasks(in: .uploading) {
          try await state.transition(task.id, to: .pending)
        }
      }
      try await Task.sleep(for: .milliseconds(100))
      startup.cancel()
      do {
        try await startup.value
        XCTFail("Canceled contending startup must not rehydrate")
      } catch { XCTAssertTrue(error is CancellationError) }
      let row = try await state.find(id)
      XCTAssertEqual(
        row?.state, .uploading, "Status reads remain available without engine ownership")
      return
    }
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: root) }
    let url = root.appendingPathComponent("state.sqlite")
    var owner: BackupStateStore? = try BackupStateStore(databaseURL: url)
    try await owner!.acquireEngineOwnership()
    let independent = try BackupStateStore(databaseURL: root.appendingPathComponent("other.sqlite"))
    try await independent.acquireEngineOwnership()
    try await owner!.upsert(BackupTask(id: id, state: .uploading, priority: .background))
    let child = Process()
    child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    child.arguments = [
      "-XCTest",
      "MapleBackupTests.BackupEngineOwnershipTests/testContendingHostCannotResetUploadingRowsAndCancellationStopsWaiting",
      Bundle(for: BackupEngineOwnershipTests.self).bundlePath,
    ]
    var environment = ProcessInfo.processInfo.environment
    environment["MAPLE_BACKUP_OWNER_TEST_DB"] = url.path
    child.environment = environment
    try child.run()
    child.waitUntilExit()
    XCTAssertEqual(child.terminationStatus, 0)
    owner = nil
    let successor = try BackupStateStore(databaseURL: url)
    try await successor.acquireEngineOwnership()
    let row = try await successor.find(id)
    XCTAssertEqual(row?.state, .uploading, "Only the new owner may now recover the interrupted row")
  }

  func testStopWaitsForCanceledCompanionAndDoesNotScheduleAnotherRetry() async throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: root) }
    let state = try BackupStateStore(databaseURL: root.appendingPathComponent("state.sqlite"))
    try await state.acquireEngineOwnership()
    let queue = InProcessBackupQueue()
    let sidecars = AppSupportSidecarStore(root: root)
    try sidecars.write(phassetLocalId: "asset", xmp: "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"/>")
    let gate = CompanionShutdownGate(expectation(description: "companion retry in flight"))
    let upload = UploadClient(
      baseURL: URL(string: "https://backup.example")!, libraryId: "library", deviceId: "device",
      transport: { request in
        if request.url!.path.contains("sidecar") { try await gate.upload() }
        return (
          Data(#"{"maple_id":"asset","target_rel_path":"asset.heic"}"#.utf8),
          HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        )
      })
    let engine = BackupEngine(
      queue: queue, state: state, upload: upload, sidecars: sidecars, reader: StubAssetReader(),
      companionBackoff: { _ in 0 })
    let task = BackupTask(
      id: BackupTaskID(deviceId: "device", phassetLocalId: "asset"), state: .pending,
      priority: .background)
    try await state.upsert(task)
    await queue.enqueue(task, priority: .background)
    try await engine.processOne()
    await fulfillment(of: [gate.started], timeout: 3)
    let stop = Task {
      await engine.stop()
      await gate.didStop()
    }
    try await Task.sleep(for: .milliseconds(50))
    let stoppedEarly = await gate.stopped
    XCTAssertFalse(stoppedEarly, "The owner must await in-flight companion writes")
    await gate.release()
    await stop.value
    try await Task.sleep(for: .milliseconds(100))
    let attempts = await gate.attempts
    XCTAssertEqual(attempts, 2, "Canceled companion failures must not schedule fresh retries")
    let row = try await state.find(task.id)
    XCTAssertEqual(row?.state, .uploaded)
  }
}
