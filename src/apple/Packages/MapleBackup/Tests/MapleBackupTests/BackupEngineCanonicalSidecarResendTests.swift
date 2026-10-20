// Tests/MapleBackupTests/BackupEngineCanonicalSidecarResendTests.swift
// An edit delivered before the server wrote canonical sidecar names (#5021)
// landed as `IMG.HEIC.xmp`, which the server never reads; the digest recorded
// for it must not stop the next walk from sending it again. Real AppSupport
// XMP files and a real SQLite state store created with the old schema; only
// the HTTP transport is stubbed.
import GRDB
import XCTest

@testable import MapleBackup

final class BackupEngineCanonicalSidecarResendTests: XCTestCase {

  override func setUp() {
    StubURLProtocol.stub = .status(200)
    StubURLProtocol.clearRecording()
  }
  override func tearDown() {
    StubURLProtocol.stub = nil
    StubURLProtocol.clearRecording()
  }

  private let photo = BackupTaskID(deviceId: "d", phassetLocalId: "P1/L0/001")
  private let edit = "<x:edit>delivered as IMG.HEIC.xmp</x:edit>"
  private var held: ServerHeldAsset {
    ServerHeldAsset(id: photo, targetRelPath: "2024/03/15/IMG.HEIC", mapleId: "hash-P1")
  }

  private func sidecarPosts() -> [URLRequest] {
    StubURLProtocol.recordedRequests.filter { $0.url?.lastPathComponent == "sidecar" }
  }

  /// A state store as the previous release left it: the edit is recorded as
  /// delivered, before delivered digests knew which sidecar name they went to.
  private func storeDeliveredUnderTheOldName(at url: URL) throws {
    let legacy = try DatabaseQueue(path: url.path)
    try legacy.write { db in
      try db.execute(
        sql: """
          CREATE TABLE uploaded_sidecars (
            device_id TEXT NOT NULL, phasset_local_id TEXT NOT NULL, digest TEXT NOT NULL,
            uploaded_at DOUBLE NOT NULL, PRIMARY KEY (device_id, phasset_local_id))
          """)
      try db.execute(
        sql: "INSERT INTO uploaded_sidecars VALUES (?, ?, ?, 0)",
        arguments: [photo.deviceId, photo.phassetLocalId, BackupEngine.digest(of: edit)])
    }
  }

  private func makeEngine(stateURL: URL, sidecarRoot: URL) throws -> BackupEngine {
    let upload = UploadClient(
      baseURL: URL(string: "https://server.example")!, libraryId: "lib", deviceId: "d",
      transport: stubTransport())
    return BackupEngine(
      queue: InProcessBackupQueue(), state: try BackupStateStore(databaseURL: stateURL),
      upload: upload, sidecars: AppSupportSidecarStore(root: sidecarRoot),
      reader: StubAssetReader())
  }

  func testAnEditDeliveredUnderTheOldSidecarNameIsSentAgainOnceBasedOnItsDigest() async throws {
    let tmpRoot = FileManager.default.temporaryDirectory
      .appendingPathComponent("canonical-resend-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: tmpRoot) }
    let sidecarRoot = tmpRoot.appendingPathComponent("sidecars", isDirectory: true)
    try FileManager.default.createDirectory(at: sidecarRoot, withIntermediateDirectories: true)
    let stateURL = tmpRoot.appendingPathComponent("state.sqlite")
    try storeDeliveredUnderTheOldName(at: stateURL)
    try AppSupportSidecarStore(root: sidecarRoot).write(
      phassetLocalId: photo.phassetLocalId, xmp: edit)
    let engine = try makeEngine(stateURL: stateURL, sidecarRoot: sidecarRoot)

    await engine.resendNewerEdits([held])
    await engine.resendNewerEdits([held])

    let posts = sidecarPosts()
    XCTAssertEqual(posts.count, 1)
    XCTAssertEqual(
      posts.first?.value(forHTTPHeaderField: "X-Maple-Sidecar-Base"), BackupEngine.digest(of: edit))
    XCTAssertEqual(posts.first?.httpBody, Data(edit.utf8))
  }

  private func harness() throws -> (BackupEngine, URL) {
    let tmpRoot = FileManager.default.temporaryDirectory
      .appendingPathComponent("canonical-resend-\(UUID().uuidString)", isDirectory: true)
    let sidecarRoot = tmpRoot.appendingPathComponent("sidecars", isDirectory: true)
    try FileManager.default.createDirectory(at: sidecarRoot, withIntermediateDirectories: true)
    let stateURL = tmpRoot.appendingPathComponent("state.sqlite")
    try storeDeliveredUnderTheOldName(at: stateURL)
    try AppSupportSidecarStore(root: sidecarRoot).write(
      phassetLocalId: photo.phassetLocalId, xmp: edit)
    return (try makeEngine(stateURL: stateURL, sidecarRoot: sidecarRoot), tmpRoot)
  }

  /// Videos always had their canonical `IMG.MOV.xmp`, so nothing needs re-sending.
  func testAVideoEditDeliveredBeforeTheRenameIsNotSentAgain() async throws {
    let (engine, tmpRoot) = try harness()
    defer { try? FileManager.default.removeItem(at: tmpRoot) }
    let clip = ServerHeldAsset(id: photo, targetRelPath: "2024/03/15/IMG.MOV", mapleId: "hash-P1")

    await engine.resendNewerEdits([clip])

    XCTAssertEqual(sidecarPosts().count, 0)
  }

  /// A server from before #5021 still stores `IMG.HEIC.xmp`; that delivery
  /// must not count, or the edit is never re-sent once the server upgrades.
  func testAnEditAnOldServerStoredUnderTheOldNameIsSentAgainAfterItUpgrades() async throws {
    StubURLProtocol.stub = .sequence([
      .ok(json: #"{"target_rel_path":"2024/03/15/IMG.HEIC.xmp"}"#),
      .ok(json: #"{"target_rel_path":"2024/03/15/IMG.xmp"}"#),
    ])
    let (engine, tmpRoot) = try harness()
    defer { try? FileManager.default.removeItem(at: tmpRoot) }

    await engine.resendNewerEdits([held])
    await engine.resendNewerEdits([held])
    await engine.resendNewerEdits([held])

    XCTAssertEqual(sidecarPosts().count, 2)
  }

  /// A 2xx reply that doesn't say where the server stored the edit proves nothing,
  /// so the delivery isn't recorded and the next walk sends again.
  func testAReplyThatDoesNotNameTheStoredSidecarIsSentAgain() async throws {
    StubURLProtocol.stub = .sequence([.ok(json: "not json"), .ok(json: "{}")])
    let (engine, tmpRoot) = try harness()
    defer { try? FileManager.default.removeItem(at: tmpRoot) }

    await engine.resendNewerEdits([held])
    await engine.resendNewerEdits([held])

    XCTAssertEqual(sidecarPosts().count, 2)
  }

  /// Against a server that hasn't upgraded, each re-send still names the last
  /// delivered revision as its base, so a newer edit isn't taken for a divergence.
  func testReSendsToAnOldServerStayBasedOnTheLastDeliveredEdit() async throws {
    let oldName = #"{"target_rel_path":"2024/03/15/IMG.HEIC.xmp"}"#
    StubURLProtocol.stub = .sequence([.ok(json: oldName), .ok(json: oldName)])
    let (engine, tmpRoot) = try harness()
    defer { try? FileManager.default.removeItem(at: tmpRoot) }
    let sidecarRoot = tmpRoot.appendingPathComponent("sidecars", isDirectory: true)
    await engine.resendNewerEdits([held])
    let newer = "<x:edit>newer</x:edit>"
    try AppSupportSidecarStore(root: sidecarRoot).write(
      phassetLocalId: photo.phassetLocalId, xmp: newer)

    await engine.resendNewerEdits([held])

    let posts = sidecarPosts()
    XCTAssertEqual(posts.count, 2)
    XCTAssertEqual(
      posts.last?.value(forHTTPHeaderField: "X-Maple-Sidecar-Base"), BackupEngine.digest(of: edit))
  }
}
