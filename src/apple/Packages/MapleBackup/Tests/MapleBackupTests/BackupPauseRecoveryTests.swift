import XCTest

@testable import MapleBackup

private actor HangingUploadServer {
  let uploadStarted: XCTestExpectation
  init(uploadStarted: XCTestExpectation) { self.uploadStarted = uploadStarted }

  func respond(to request: URLRequest) async throws -> (Data, URLResponse) {
    uploadStarted.fulfill()
    try await Task.sleep(for: .seconds(60))
    throw URLError(.timedOut)
  }
}

final class BackupPauseRecoveryTests: XCTestCase {
  func testStoppingMidUploadLeavesTheRowRecoverableAndRehydrateFinishesIt() async throws {
    StubURLProtocol.stub = .ok(json: #"{"maple_id":"m","target_rel_path":"IMG.heic"}"#)
    defer { StubURLProtocol.stub = nil }
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let state = try BackupStateStore(databaseURL: root.appendingPathComponent("state.sqlite"))
    let sidecars = AppSupportSidecarStore(root: root)
    let id = BackupTaskID(deviceId: "d", phassetLocalId: "photo")
    let task = BackupTask(id: id, state: .pending, priority: .background)
    try await state.upsert(task)
    let queue = InProcessBackupQueue()
    await queue.enqueue(task, priority: .background)

    let uploadStarted = expectation(description: "upload in flight")
    let hanging = HangingUploadServer(uploadStarted: uploadStarted)
    let pausedEngine = BackupEngine(
      queue: queue, state: state,
      upload: UploadClient(
        baseURL: URL(string: "https://server.example")!, libraryId: "lib", deviceId: "d",
        transport: { try await hanging.respond(to: $0) }),
      sidecars: sidecars, reader: StubAssetReader())
    let runner = Task { await pausedEngine.run(keepAlive: true) }
    await fulfillment(of: [uploadStarted], timeout: 5)

    runner.cancel()
    await pausedEngine.stop()
    await runner.value

    let stopped = try await state.find(id)
    XCTAssertNotEqual(stopped?.state, .uploaded)
    XCTAssertNotEqual(stopped?.state, .failedRetry)

    let resumedQueue = InProcessBackupQueue()
    let recovered = try await state.rehydrate(into: resumedQueue)
    XCTAssertEqual(recovered, 1)
    let resumedEngine = BackupEngine(
      queue: resumedQueue, state: state,
      upload: UploadClient(
        baseURL: URL(string: "https://server.example")!, libraryId: "lib", deviceId: "d",
        transport: stubTransport()),
      sidecars: sidecars, reader: StubAssetReader())
    await resumedEngine.run()

    let finished = try await state.find(id)
    XCTAssertEqual(finished?.state, .uploaded)
  }
}
