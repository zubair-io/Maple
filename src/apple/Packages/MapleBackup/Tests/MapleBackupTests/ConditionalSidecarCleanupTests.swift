import XCTest

@testable import MapleBackup

final class ConditionalSidecarCleanupTests: XCTestCase {
  private actor CompletionFlag {
    private(set) var done = false
    func finish() { done = true }
  }

  func testNewLocalEditDuringUploadSurvivesAcknowledgement() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("backup-sidecar-race-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let sidecars = AppSupportSidecarStore(root: root)
    let oldXML = "<x:xmpmeta>old</x:xmpmeta>"
    let newXML = "<x:xmpmeta>new</x:xmpmeta>"
    try sidecars.write(phassetLocalId: "P1", xmp: oldXML)

    let state = try BackupStateStore(databaseURL: root.appendingPathComponent("state.sqlite"))
    let queue = InProcessBackupQueue()
    let upload = UploadClient(
      baseURL: URL(string: "https://server.example")!, libraryId: "lib", deviceId: "d",
      transport: { request in
        let isSidecar = request.url!.path.contains("backup/sidecar")
        if isSidecar { try sidecars.write(phassetLocalId: "P1", xmp: newXML) }
        let payload =
          isSidecar
          ? Data() : Data(#"{"maple_id":"hash-P1","target_rel_path":"IMG.heic"}"#.utf8)
        let response = HTTPURLResponse(
          url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        return (payload, response)
      })
    let engine = BackupEngine(
      queue: queue, state: state, upload: upload, sidecars: sidecars, reader: StubAssetReader())
    let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
    let task = BackupTask(id: id, state: .pending, priority: .background)
    try await state.upsert(task)
    await queue.enqueue(task, priority: .background)

    try await engine.processOne()

    XCTAssertEqual(try sidecars.read(phassetLocalId: "P1"), newXML)
  }

  func testConditionalDeleteComparesExactUTF8Bytes() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("backup-sidecar-bytes-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let sidecars = AppSupportSidecarStore(root: root)
    let composed = "<x:xmpmeta>caf\u{00E9}</x:xmpmeta>"
    let decomposed = "<x:xmpmeta>cafe\u{0301}</x:xmpmeta>"
    XCTAssertEqual(composed, decomposed)
    try sidecars.write(phassetLocalId: "P1", xmp: decomposed)

    XCTAssertFalse(try sidecars.deleteIfUnchanged(phassetLocalId: "P1", matching: composed))
    XCTAssertEqual(try sidecars.read(phassetLocalId: "P1"), decomposed)
    XCTAssertTrue(try sidecars.deleteIfUnchanged(phassetLocalId: "P1", matching: decomposed))
    XCTAssertNil(try sidecars.read(phassetLocalId: "P1"))
  }

  func testCleanupWaitsForAnotherProcessesCoordinatedWrite() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("backup-sidecar-process-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let sidecars = AppSupportSidecarStore(root: root)
    let id = "PHOTO/L0/004"
    let oldXML = "<x:xmpmeta>old</x:xmpmeta>"
    let newXML = "<x:xmpmeta>new</x:xmpmeta>"
    try sidecars.write(phassetLocalId: id, xmp: oldXML)
    let ready = root.appendingPathComponent("writer-ready")
    let release = root.appendingPathComponent("writer-release")
    let attempt = root.appendingPathComponent("cleanup-attempt")

    // The child holds a real NSFileCoordinator claim after replacing the XMP.
    // Cleanup must remain blocked until that other process releases it.
    let script = """
      import Foundation
      let env = ProcessInfo.processInfo.environment
      let url = URL(fileURLWithPath: env["MAPLE_TEST_XMP"]!)
      let ready = URL(fileURLWithPath: env["MAPLE_TEST_READY"]!)
      let release = URL(fileURLWithPath: env["MAPLE_TEST_RELEASE"]!)
      let coordinator = NSFileCoordinator(filePresenter: nil)
      var coordinationError: NSError?
      coordinator.coordinate(writingItemAt: url, options: [], error: &coordinationError) { destination in
        try! Data(env["MAPLE_TEST_NEW_XML"]!.utf8).write(to: destination, options: .atomic)
        try! Data().write(to: ready)
        while !FileManager.default.fileExists(atPath: release.path) {
          Thread.sleep(forTimeInterval: 0.01)
        }
      }
      if let coordinationError { fatalError("Child coordination failed: \\(coordinationError)") }
      """
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
    process.arguments = ["swift", "-e", script]
    process.environment = ProcessInfo.processInfo.environment.merging([
      "MAPLE_TEST_XMP": sidecars.sidecarURL(phassetLocalId: id).path,
      "MAPLE_TEST_READY": ready.path,
      "MAPLE_TEST_RELEASE": release.path,
      "MAPLE_TEST_NEW_XML": newXML,
    ]) { _, value in value }
    try process.run()
    defer {
      try? Data().write(to: release)
      if process.isRunning { process.terminate() }
    }
    for _ in 0..<3_000 where !FileManager.default.fileExists(atPath: ready.path) {
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertTrue(
      FileManager.default.fileExists(atPath: ready.path), "child writer did not lock XMP")

    let completion = CompletionFlag()
    let cleanup = Task.detached {
      try Data().write(to: attempt)
      let deleted = try sidecars.deleteIfUnchanged(phassetLocalId: id, matching: oldXML)
      await completion.finish()
      return deleted
    }
    for _ in 0..<1_000 where !FileManager.default.fileExists(atPath: attempt.path) {
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertTrue(FileManager.default.fileExists(atPath: attempt.path))
    try await Task.sleep(for: .milliseconds(300))
    let finishedWhileWriterHeldFile = await completion.done
    XCTAssertFalse(finishedWhileWriterHeldFile, "cleanup bypassed the other process's claim")

    try Data().write(to: release)
    let deleted = try await cleanup.value
    XCTAssertFalse(deleted)
    process.waitUntilExit()
    XCTAssertEqual(process.terminationStatus, 0)
    XCTAssertEqual(try sidecars.read(phassetLocalId: id), newXML)
  }

  func testAppSupportWriterWaitsForCoordinatedPublication() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("backup-sidecar-write-order-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let sidecars = AppSupportSidecarStore(root: root)
    let id = "PHOTO/L0/005"
    try sidecars.write(phassetLocalId: id, xmp: "<x:xmpmeta>old</x:xmpmeta>")
    let entered = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)
    let holderDone = DispatchSemaphore(value: 0)
    defer { release.signal() }
    DispatchQueue.global().async {
      let coordinator = NSFileCoordinator(filePresenter: nil)
      var coordinationError: NSError?
      coordinator.coordinate(
        writingItemAt: sidecars.sidecarURL(phassetLocalId: id), options: [],
        error: &coordinationError
      ) { _ in
        entered.signal()
        release.wait()
      }
      XCTAssertNil(coordinationError)
      holderDone.signal()
    }
    guard entered.wait(timeout: .now() + 5) == .success else {
      release.signal()
      return XCTFail("coordinated publisher did not claim the XMP")
    }

    let completion = CompletionFlag()
    let attempt = root.appendingPathComponent("writer-attempt")
    let newXML = "<x:xmpmeta>new</x:xmpmeta>"
    let writer = Task.detached {
      try Data().write(to: attempt)
      try sidecars.write(phassetLocalId: id, xmp: newXML)
      await completion.finish()
    }
    for _ in 0..<1_000 where !FileManager.default.fileExists(atPath: attempt.path) {
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertTrue(FileManager.default.fileExists(atPath: attempt.path))
    try await Task.sleep(for: .milliseconds(300))
    let finishedWhileAnotherWriterHeldFile = await completion.done
    XCTAssertFalse(
      finishedWhileAnotherWriterHeldFile, "direct PhotoKit writer bypassed coordination")

    release.signal()
    try await writer.value
    XCTAssertEqual(holderDone.wait(timeout: .now() + 5), .success)
    XCTAssertEqual(try sidecars.read(phassetLocalId: id), newXML)
  }
}
