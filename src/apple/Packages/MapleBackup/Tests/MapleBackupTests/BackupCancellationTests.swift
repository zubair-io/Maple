import XCTest

@testable import MapleBackup

private actor SuspendedBackupReader: AssetReader {
  let started: XCTestExpectation
  init(started: XCTestExpectation) { self.started = started }
  func read(phassetLocalId: String) async throws -> AssetReadResult {
    started.fulfill()
    try await Task.sleep(for: .seconds(60))
    throw CancellationError()
  }
}

final class BackupCancellationTests: XCTestCase {
  func testStopDuringPhotoReadPreservesPendingWithoutRetryOrUpload() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let state = try BackupStateStore(databaseURL: root.appendingPathComponent("state.sqlite"))
    let queue = InProcessBackupQueue()
    let started = expectation(description: "reading photo")
    let task = BackupTask(
      id: BackupTaskID(deviceId: "d", phassetLocalId: "photo"),
      state: .pending, priority: .background, retryCount: 3)
    try await state.upsert(task)
    await queue.enqueue(task, priority: .background)
    let upload = UploadClient(
      baseURL: URL(string: "https://server.example")!,
      libraryId: "library", deviceId: "d",
      transport: { _ in
        XCTFail("Cancelled photo must not upload")
        throw CancellationError()
      })
    let engine = BackupEngine(
      queue: queue, state: state, upload: upload,
      sidecars: AppSupportSidecarStore(root: root), reader: SuspendedBackupReader(started: started))
    let runner = Task { await engine.run(keepAlive: true) }
    await fulfillment(of: [started], timeout: 2)
    runner.cancel()
    await engine.stop()
    await runner.value
    let persisted = try await state.find(task.id)
    XCTAssertEqual(persisted?.state, .pending)
    XCTAssertEqual(persisted?.retryCount, 3)
    XCTAssertNil(persisted?.lastError)
    let remaining = await queue.snapshot()
    XCTAssertTrue(remaining.isEmpty, "Cancellation must not schedule a detached retry")
  }

  func testHundredThousandPhotosPersistAndRecoverInBatches() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let url = root.appendingPathComponent("state.sqlite")
    let state = try BackupStateStore(databaseURL: url)
    let start = Date()
    for offset in stride(from: 0, to: 100_000, by: 256) {
      let tasks = (offset..<min(offset + 256, 100_000)).map { index in
        BackupTask(
          id: BackupTaskID(deviceId: "d", phassetLocalId: "\(index)"),
          state: .pending, priority: .background,
          capturedAt: Date(timeIntervalSince1970: Double(index)))
      }
      try await state.upsert(tasks)
    }
    let reopened = try BackupStateStore(databaseURL: url)
    let recovered = try await reopened.tasks(in: .pending)
    XCTAssertEqual(recovered.count, 100_000)
    XCTAssertEqual(Set(recovered.map(\.id)).count, 100_000)
    XCTAssertTrue(recovered.allSatisfy { $0.capturedAt != nil })
    print("100k backup state persist/recover: \(Date().timeIntervalSince(start)) seconds")
  }
}
