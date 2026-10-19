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

/// Sidecar endpoint whose first POST fails (so the engine schedules a companion
/// retry) and whose retry hangs until cancelled, recording when it exits and
/// any sidecar POST that arrives after that.
private actor HangingSidecarServer {
  let retryStarted: XCTestExpectation
  private(set) var retryExited = false
  private(set) var requestsAfterRetryExit = 0
  private var sidecarPosts = 0

  init(retryStarted: XCTestExpectation) { self.retryStarted = retryStarted }

  func respond(to request: URLRequest) async throws -> (Data, URLResponse) {
    let url = request.url!
    guard url.lastPathComponent == "sidecar" else {
      return (
        Data(#"{"maple_id":"hash-photo","target_rel_path":"2024/03/15/IMG.heic"}"#.utf8),
        HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
      )
    }
    sidecarPosts += 1
    if retryExited { requestsAfterRetryExit += 1 }
    guard sidecarPosts == 2 else {
      return (
        Data(), HTTPURLResponse(url: url, statusCode: 500, httpVersion: nil, headerFields: nil)!
      )
    }
    retryStarted.fulfill()
    defer { retryExited = true }
    try await Task.sleep(for: .seconds(30))
    throw URLError(.timedOut)
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

  /// The app hands the engine lock to the backup helper once `stop()` returns
  /// (#4988), so a companion retry already uploading must have exited by then,
  /// and its cancellation must not schedule a replacement retry.
  func testStopWaitsForInFlightCompanionRetryAndSchedulesNoReplacement() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let state = try BackupStateStore(databaseURL: root.appendingPathComponent("state.sqlite"))
    let sidecarRoot = root.appendingPathComponent("sidecars", isDirectory: true)
    try FileManager.default.createDirectory(at: sidecarRoot, withIntermediateDirectories: true)
    let sidecars = AppSupportSidecarStore(root: sidecarRoot)
    try sidecars.write(phassetLocalId: "photo", xmp: "<x:edit/>")
    let queue = InProcessBackupQueue()
    let server = HangingSidecarServer(
      retryStarted: expectation(description: "companion retry uploading"))
    let upload = UploadClient(
      baseURL: URL(string: "https://server.example")!,
      libraryId: "library", deviceId: "d",
      transport: { try await server.respond(to: $0) })
    let engine = BackupEngine(
      queue: queue, state: state, upload: upload,
      sidecars: sidecars, reader: StubAssetReader(),
      maxConcurrency: 1, companionBackoff: { _ in 0 })
    let task = BackupTask(
      id: BackupTaskID(deviceId: "d", phassetLocalId: "photo"),
      state: .pending, priority: .background)
    try await state.upsert(task)
    await queue.enqueue(task, priority: .background)

    let runner = Task { await engine.run(keepAlive: true) }
    await fulfillment(of: [server.retryStarted], timeout: 5)
    runner.cancel()
    await engine.stop()
    let exitedBeforeStopReturned = await server.retryExited
    XCTAssertTrue(
      exitedBeforeStopReturned, "stop() returned while a companion retry was still uploading")
    await runner.value
    try await Task.sleep(for: .milliseconds(300))
    let lateRequests = await server.requestsAfterRetryExit
    XCTAssertEqual(
      lateRequests, 0, "a cancelled companion retry scheduled a replacement after stop()")
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
