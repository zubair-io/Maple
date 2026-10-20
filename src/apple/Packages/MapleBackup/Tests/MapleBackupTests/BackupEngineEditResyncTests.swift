// Tests/MapleBackupTests/BackupEngineEditResyncTests.swift
// Re-sending a newer local PhotoKit edit after its photo was uploaded (#4719).
// Real AppSupport XMP files and a real SQLite state store in a temp dir; only
// the HTTP transport is stubbed, and the assertions read what was sent.
import XCTest

@testable import MapleBackup

final class BackupEngineEditResyncTests: XCTestCase {

  override func setUp() {
    StubURLProtocol.stub = nil
    StubURLProtocol.clearRecording()
  }
  override func tearDown() {
    StubURLProtocol.stub = nil
    StubURLProtocol.clearRecording()
  }

  private let photo = BackupTaskID(deviceId: "d", phassetLocalId: "P1/L0/001")
  private var held: ServerHeldAsset {
    ServerHeldAsset(id: photo, targetRelPath: "2024/03/15/IMG.heic", mapleId: "hash-P1")
  }

  private func sidecarPosts() -> [URLRequest] {
    StubURLProtocol.recordedRequests.filter { $0.url?.lastPathComponent == "sidecar" }
  }

  func testNewerLocalEditIsSentBasedOnTheUploadedRevision() async throws {
    StubURLProtocol.stub = .status(200)
    let (engine, _, state, sidecars, _, tmpRoot) = try freshHarness()
    defer { try? FileManager.default.removeItem(at: tmpRoot) }
    try await state.recordUploadedSidecar(
      photo, digest: BackupEngine.digest(of: "<x:edit>A</x:edit>"))
    try sidecars.write(phassetLocalId: photo.phassetLocalId, xmp: "<x:edit>B</x:edit>")

    await engine.resendNewerEdits([held])

    let posts = sidecarPosts()
    XCTAssertEqual(posts.count, 1)
    XCTAssertEqual(
      posts.first?.value(forHTTPHeaderField: "X-Maple-Sidecar-Base"),
      BackupEngine.digest(of: "<x:edit>A</x:edit>"))
    XCTAssertEqual(
      posts.first?.value(forHTTPHeaderField: "X-Maple-Target-Rel-Path"), "2024/03/15/IMG.heic")
    XCTAssertEqual(posts.first?.value(forHTTPHeaderField: "X-Maple-Id"), "hash-P1")
    XCTAssertEqual(posts.first?.httpBody, Data("<x:edit>B</x:edit>".utf8))
    let delivered = try await state.uploadedSidecarDigest(photo)
    XCTAssertEqual(delivered, BackupEngine.digest(of: "<x:edit>B</x:edit>"))
  }

  func testEditMadeAfterAnEditlessUploadIsSentBasedOnNone() async throws {
    StubURLProtocol.stub = .status(200)
    let (engine, _, state, sidecars, _, tmpRoot) = try freshHarness()
    defer { try? FileManager.default.removeItem(at: tmpRoot) }
    try sidecars.write(phassetLocalId: photo.phassetLocalId, xmp: "<x:edit>first</x:edit>")

    await engine.resendNewerEdits([held])

    XCTAssertEqual(sidecarPosts().first?.value(forHTTPHeaderField: "X-Maple-Sidecar-Base"), "none")
    let delivered = try await state.uploadedSidecarDigest(photo)
    XCTAssertEqual(delivered, BackupEngine.digest(of: "<x:edit>first</x:edit>"))
  }

  func testAnEditTheServerAlreadyHasIsNotSentAgain() async throws {
    StubURLProtocol.stub = .status(200)
    let (engine, _, state, sidecars, _, tmpRoot) = try freshHarness()
    defer { try? FileManager.default.removeItem(at: tmpRoot) }
    try sidecars.write(phassetLocalId: photo.phassetLocalId, xmp: "<x:edit>A</x:edit>")
    try await state.recordUploadedSidecar(
      photo, digest: BackupEngine.digest(of: "<x:edit>A</x:edit>"))

    await engine.resendNewerEdits([held])

    XCTAssertTrue(sidecarPosts().isEmpty)
  }

  func testAPhotoWithoutALocalEditSendsNothing() async throws {
    StubURLProtocol.stub = .status(200)
    let (engine, _, _, _, _, tmpRoot) = try freshHarness()
    defer { try? FileManager.default.removeItem(at: tmpRoot) }

    await engine.resendNewerEdits([held])

    XCTAssertTrue(sidecarPosts().isEmpty)
  }

  func testAFailedResendKeepsTheOldRevisionSoTheNextScanRetries() async throws {
    StubURLProtocol.stub = .status(500)
    let (engine, _, state, sidecars, _, tmpRoot) = try freshHarness()
    defer { try? FileManager.default.removeItem(at: tmpRoot) }
    try await state.recordUploadedSidecar(
      photo, digest: BackupEngine.digest(of: "<x:edit>A</x:edit>"))
    try sidecars.write(phassetLocalId: photo.phassetLocalId, xmp: "<x:edit>B</x:edit>")

    await engine.resendNewerEdits([held])

    XCTAssertEqual(sidecarPosts().count, 1)
    let delivered = try await state.uploadedSidecarDigest(photo)
    XCTAssertEqual(delivered, BackupEngine.digest(of: "<x:edit>A</x:edit>"))
  }

  func testFirstUploadOfAnEditedPhotoNamesNoBase() async throws {
    StubURLProtocol.stub = ingestAndSidecarStub()
    let (engine, queue, state, sidecars, _, tmpRoot) = try freshHarness()
    defer { try? FileManager.default.removeItem(at: tmpRoot) }
    try sidecars.write(phassetLocalId: "P1", xmp: "<x:edit/>")
    let task = BackupTask(
      id: BackupTaskID(deviceId: "d", phassetLocalId: "P1"), state: .pending, priority: .background)
    try await state.upsert(task)
    await queue.enqueue(task, priority: .background)

    try await engine.processOne()

    XCTAssertEqual(sidecarPosts().first?.value(forHTTPHeaderField: "X-Maple-Sidecar-Base"), "none")
  }

  func testReuploadOfAnEditedPhotoNamesItsLastDeliveredRevision() async throws {
    StubURLProtocol.stub = ingestAndSidecarStub()
    let (engine, queue, state, sidecars, _, tmpRoot) = try freshHarness()
    defer { try? FileManager.default.removeItem(at: tmpRoot) }
    let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
    try await state.recordUploadedSidecar(
      id, digest: BackupEngine.digest(of: "<x:edit>old</x:edit>"))
    try sidecars.write(phassetLocalId: "P1", xmp: "<x:edit>new</x:edit>")
    let task = BackupTask(id: id, state: .pending, priority: .background)
    try await state.upsert(task)
    await queue.enqueue(task, priority: .background)

    try await engine.processOne()

    XCTAssertEqual(
      sidecarPosts().first?.value(forHTTPHeaderField: "X-Maple-Sidecar-Base"),
      BackupEngine.digest(of: "<x:edit>old</x:edit>"))
  }
  func testADelayedFirstUploadRetrySendsTheLatestEditNotTheOneItStartedWith() async throws {
    StubURLProtocol.stub = .sequence([
      .ok(json: #"{"maple_id":"hash-P1","target_rel_path":"2024/03/15/IMG.heic"}"#),
      .status(500),
      .status(200),
      .status(200),
    ])
    let (engine, queue, state, sidecars, tmpRoot) = try freshHarness(companionBackoff: { _ in 0.3 })
    defer { try? FileManager.default.removeItem(at: tmpRoot) }
    let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
    try sidecars.write(phassetLocalId: "P1", xmp: "<x:edit>v1</x:edit>")
    let task = BackupTask(id: id, state: .pending, priority: .background)
    try await state.upsert(task)
    await queue.enqueue(task, priority: .background)
    try await engine.processOne()

    try sidecars.write(phassetLocalId: "P1", xmp: "<x:edit>v2</x:edit>")
    await engine.resendNewerEdits([
      ServerHeldAsset(id: id, targetRelPath: "2024/03/15/IMG.heic", mapleId: "hash-P1")
    ])
    // The first upload's retry fires after the re-send; wait for it to settle.
    let deadline = Date().addingTimeInterval(5)
    while await engine.retryTasks.count > 0, Date() < deadline {
      try await Task.sleep(for: .milliseconds(50))
    }

    let bodies = sidecarPosts().compactMap {
      $0.httpBody.map { String(decoding: $0, as: UTF8.self) }
    }
    XCTAssertEqual(bodies.first, "<x:edit>v1</x:edit>")
    XCTAssertFalse(
      bodies.dropFirst().contains("<x:edit>v1</x:edit>"),
      "a retry re-sent the older edit after the newer one: \(bodies)")
    let delivered = try await state.uploadedSidecarDigest(id)
    XCTAssertEqual(delivered, BackupEngine.digest(of: "<x:edit>v2</x:edit>"))
  }

  func testAResendTheServerSkippedIsNotRecordedAsDelivered() async throws {
    StubURLProtocol.stub = .ok(
      json: #"{"target_rel_path":"2024/03/15/IMG.heic.xmp","skipped":true}"#)
    let (engine, _, state, sidecars, _, tmpRoot) = try freshHarness()
    defer { try? FileManager.default.removeItem(at: tmpRoot) }
    try await state.recordUploadedSidecar(
      photo, digest: BackupEngine.digest(of: "<x:edit>A</x:edit>"))
    try sidecars.write(phassetLocalId: photo.phassetLocalId, xmp: "<x:edit>B</x:edit>")

    await engine.resendNewerEdits([held])

    let delivered = try await state.uploadedSidecarDigest(photo)
    XCTAssertEqual(delivered, BackupEngine.digest(of: "<x:edit>A</x:edit>"))
  }
}
