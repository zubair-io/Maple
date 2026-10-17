import Foundation
import XCTest

@testable import MapleBackup

private actor SidecarRequestCount {
  var value = 0
  func record() -> Int {
    value += 1
    return value
  }
}

private actor LocalOriginalReader: AssetReader {
  let url: URL
  init(url: URL) { self.url = url }
  func read(phassetLocalId: String) async throws -> AssetReadResult {
    AssetReadResult(
      originalBytes: try Data(contentsOf: url),
      renderedBytes: nil,
      sidecar: PayloadAssembler.SidecarInput(
        phassetLocalId: phassetLocalId, deviceId: "device",
        captureDate: Date(timeIntervalSince1970: 1_700_000_000),
        latitude: nil, longitude: nil, favorite: false, caption: nil,
        keywords: [], tags: [], livePhotoCompanion: nil, burstStackId: nil,
        originalFilename: "asset.heic", mtime: 0),
      mapleId: "asset")
  }
}

final class BackupCompanionRecoveryTests: XCTestCase {
  private static let edit = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"/>"
  private static let newerEdit = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">new</x:xmpmeta>"

  func testUntouchedPhotoHasNoRecoveryReceipt() async throws {
    StubURLProtocol.stub = .ok(
      json: #"{"maple_id":"hash-P1","target_rel_path":"asset.heic"}"#)
    defer {
      StubURLProtocol.stub = nil
      StubURLProtocol.clearRecording()
    }
    let (engine, queue, state, _, _, root) = try freshHarness()
    defer { try? FileManager.default.removeItem(at: root) }
    let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
    let task = BackupTask(id: id, state: .pending, priority: .background)
    try await state.upsert(task)
    await queue.enqueue(task, priority: .background)
    try await engine.processOne()
    let row = try await state.find(id)
    let receipts = try await state.pendingSidecars(deviceId: "d")
    XCTAssertEqual(row?.state, .uploaded)
    XCTAssertTrue(receipts.isEmpty)
  }

  private func produce(at root: URL) throws {
    let child = Process()
    child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    child.arguments = [
      "-XCTest",
      "MapleBackupTests.BackupCompanionRecoveryTests/testProducerLeavesCanceledCompanion",
      Bundle(for: Self.self).bundlePath,
    ]
    var environment = ProcessInfo.processInfo.environment
    environment["MAPLE_COMPANION_RECOVERY_ROOT"] = root.path
    child.environment = environment
    try child.run()
    child.waitUntilExit()
    XCTAssertEqual(child.terminationStatus, 0)
  }

  func testSuccessorProcessRecoversLocalEditWithoutUploadingPrimary() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    try produce(at: root)

    let state = try BackupStateStore(databaseURL: root.appendingPathComponent("state.sqlite"))
    let sidecars = AppSupportSidecarStore(root: root)
    let queue = InProcessBackupQueue()
    let requests = SidecarRequestCount()
    let upload = UploadClient(
      baseURL: URL(string: "https://backup.example")!, libraryId: "library", deviceId: "device",
      transport: { request in
        let attempt = await requests.record()
        XCTAssertTrue(
          request.url!.path.contains("/sidecar"), "Recovery must not upload original bytes")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Maple-Target-Rel-Path"), "asset.heic")
        XCTAssertEqual(request.httpBody, Data((attempt == 1 ? Self.edit : Self.newerEdit).utf8))
        if attempt == 1 {
          try AppSupportSidecarStore(root: root).write(
            phassetLocalId: "asset", xmp: Self.newerEdit)
        }
        return (
          Data(),
          HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        )
      })
    let engine = BackupEngine(
      queue: queue, state: state, upload: upload, sidecars: sidecars,
      reader: FailingAssetReader(), companionBackoff: { _ in 999 })
    let outstanding = try await state.pendingSidecars(deviceId: "device")
    XCTAssertEqual(outstanding.count, 1)
    await engine.recoverPendingSidecars()
    XCTAssertEqual(try sidecars.read(phassetLocalId: "asset"), Self.newerEdit)
    let retained = try await state.pendingSidecars(deviceId: "device")
    XCTAssertEqual(retained.count, 1, "The older acknowledgement must keep the new edit pending")
    await engine.stop()
    let successor = BackupEngine(
      queue: InProcessBackupQueue(), state: state, upload: upload, sidecars: sidecars,
      reader: FailingAssetReader())
    await successor.recoverPendingSidecars()
    XCTAssertNil(try sidecars.read(phassetLocalId: "asset"))
    let resolved = try await state.pendingSidecars(deviceId: "device")
    XCTAssertTrue(resolved.isEmpty)
    await successor.recoverPendingSidecars()
    let requestCount = await requests.value
    XCTAssertEqual(requestCount, 2, "Only the newer edit should replay once")
    XCTAssertEqual(
      try Data(contentsOf: root.appendingPathComponent("asset.heic")), Data([1, 2, 3, 4]))
    let recoveredRow = try await state.find(
      BackupTaskID(deviceId: "device", phassetLocalId: "asset"))
    XCTAssertEqual(recoveredRow?.state, .uploaded)
  }

  func testDifferentDestinationDoesNotReplayOldReceipt() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    try produce(at: root)
    let previous = try BackupStateStore(databaseURL: root.appendingPathComponent("state.sqlite"))
    let current = try BackupStateStore(
      databaseURL: root.appendingPathComponent("other-destination.sqlite"))
    let sidecars = AppSupportSidecarStore(root: root)
    let upload = UploadClient(
      baseURL: URL(string: "https://other.example")!, libraryId: "other-library",
      deviceId: "device",
      transport: { _ in
        XCTFail("A different destination must not receive the old sidecar")
        throw URLError(.badURL)
      })
    let engine = BackupEngine(
      queue: InProcessBackupQueue(), state: current, upload: upload, sidecars: sidecars,
      reader: FailingAssetReader())
    await engine.recoverPendingSidecars()
    XCTAssertNotNil(try sidecars.read(phassetLocalId: "asset"))
    XCTAssertEqual(
      try Data(contentsOf: root.appendingPathComponent("asset.heic")), Data([1, 2, 3, 4]))
    let oldReceipts = try await previous.pendingSidecars(deviceId: "device")
    XCTAssertEqual(oldReceipts.count, 1)
  }

  func testProducerLeavesCanceledCompanion() async throws {
    let stagedRoot = ProcessInfo.processInfo.environment["MAPLE_COMPANION_RECOVERY_ROOT"]
    let root =
      stagedRoot.map { URL(fileURLWithPath: $0) }
      ?? FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { if stagedRoot == nil { try? FileManager.default.removeItem(at: root) } }
    let state = try BackupStateStore(databaseURL: root.appendingPathComponent("state.sqlite"))
    let sidecars = AppSupportSidecarStore(root: root)
    let originalURL = root.appendingPathComponent("asset.heic")
    try Data([1, 2, 3, 4]).write(to: originalURL)
    try sidecars.write(phassetLocalId: "asset", xmp: Self.edit)
    let queue = InProcessBackupQueue()
    let upload = UploadClient(
      baseURL: URL(string: "https://backup.example")!, libraryId: "library", deviceId: "device",
      transport: { request in
        if request.url!.path.contains("/sidecar") { throw URLError(.cannotConnectToHost) }
        return (
          Data(#"{"maple_id":"asset","target_rel_path":"asset.heic"}"#.utf8),
          HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        )
      })
    let engine = BackupEngine(
      queue: queue, state: state, upload: upload, sidecars: sidecars,
      reader: LocalOriginalReader(url: originalURL),
      companionBackoff: { _ in 999 })
    let id = BackupTaskID(deviceId: "device", phassetLocalId: "asset")
    let task = BackupTask(id: id, state: .pending, priority: .background)
    try await state.upsert(task)
    await queue.enqueue(task, priority: .background)
    try await engine.processOne()
    await engine.stop()
    let producedRow = try await state.find(id)
    XCTAssertEqual(producedRow?.state, .uploaded)
    XCTAssertNotNil(try sidecars.read(phassetLocalId: "asset"))
    XCTAssertEqual(try Data(contentsOf: originalURL), Data([1, 2, 3, 4]))
  }
}
