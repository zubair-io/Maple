import Darwin
import XCTest

@testable import MapleCore

final class LocalRemovalAssetStoreTests: XCTestCase {
  private func fixture(_ name: String) throws -> Data {
    let parts = name.split(separator: ".")
    let url = try XCTUnwrap(
      Bundle.module.url(
        forResource: String(parts[0]), withExtension: String(parts[1]), subdirectory: "removal"))
    return try Data(contentsOf: url)
  }

  private func stage() throws -> URL {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    let raw = directory.appendingPathComponent("photo.dng")
    try fixture("source.dng").write(to: raw)
    try fixture("prior.xmp").write(to: directory.appendingPathComponent("photo.xmp"))
    return raw
  }

  private func publish(_ store: LocalRemovalAssetStore) async throws -> String {
    try await store.publish(
      request: String(decoding: fixture("request.txt"), as: UTF8.self), prior: "[]",
      mask: fixture("mask.mimf"), patch: fixture("patch.f16"))
  }

  func testRealCompanionPublicationAndConfirmedXMPPreserveOriginalAndForeignXML() async throws {
    let raw = try stage()
    let original = try Data(contentsOf: raw)
    let assets = LocalRemovalAssetStore(rawURL: raw)
    let records = try await publish(assets)
    XCTAssertEqual(records, String(decoding: try fixture("records.txt"), as: UTF8.self))
    let repeated = try await publish(assets)
    XCTAssertEqual(repeated, records)
    let files = try await assets.readAssets(records: records)
    XCTAssertEqual(files.count, 2)
    let store = XMPSidecarStore(rawURL: raw)
    try await store.writeRemovalConfirmed(
      records: records, expectedRecords: "[]", model: .default, culling: CullingState())
    let sidecar = raw.deletingPathExtension().appendingPathExtension("xmp")
    let xml = try String(contentsOf: sidecar, encoding: .utf8)
    XCTAssertTrue(xml.contains("foreign:Keep=\"untouched\""))
    XCTAssertTrue(xml.contains("<foreign:History original=\"preserved\"/>"))
    XCTAssertEqual(
      XMPParser.parsePassthrough(xml).unknownAttributes.first {
        $0.name == "papp:InpaintRemovals"
      }?.value, records)
    XCTAssertEqual(try Data(contentsOf: raw), original)
    let reopened = try await assets.readAssets(records: records)
    XCTAssertEqual(reopened, files)
  }

  func testStaleCommitAndMissingAssetsNeverReplaceSidecar() async throws {
    let raw = try stage()
    let assets = LocalRemovalAssetStore(rawURL: raw)
    let records = try await publish(assets)
    let store = XMPSidecarStore(rawURL: raw)
    let sidecar = raw.deletingPathExtension().appendingPathExtension("xmp")
    let original = try Data(contentsOf: sidecar)
    do {
      try await store.writeRemovalConfirmed(
        records: records, expectedRecords: "stale", model: .default, culling: CullingState())
      XCTFail("A stale stack cannot commit")
    } catch RemovalError.saveConflict {}
    XCTAssertEqual(try Data(contentsOf: sidecar), original)
    let directory = raw.deletingLastPathComponent().appendingPathComponent(".maple/inpaint")
    let one = try XCTUnwrap(
      FileManager.default.contentsOfDirectory(
        at: directory, includingPropertiesForKeys: nil
      ).first)
    try FileManager.default.removeItem(at: one)
    do {
      try await store.writeRemovalConfirmed(
        records: records, expectedRecords: "[]", model: .default, culling: CullingState())
      XCTFail("An incomplete edit cannot report a confirmed save")
    } catch RemovalError.missingCompanion {}
    XCTAssertEqual(try Data(contentsOf: sidecar), original)
  }

  func testConcurrentLocalWriterRefusesLockAndLeavesCandidateAssets() async throws {
    let raw = try stage()
    let assets = LocalRemovalAssetStore(rawURL: raw)
    let records = try await publish(assets)
    let lock = raw.deletingLastPathComponent().appendingPathComponent(".photo.xmp.lock")
    let fd = open(lock.path, O_CREAT | O_RDWR, 0o600)
    XCTAssertGreaterThanOrEqual(fd, 0)
    defer {
      flock(fd, LOCK_UN)
      close(fd)
    }
    XCTAssertEqual(flock(fd, LOCK_EX | LOCK_NB), 0)
    let store = XMPSidecarStore(rawURL: raw)
    do {
      try await store.writeRemovalConfirmed(
        records: records, expectedRecords: "[]", model: .default, culling: CullingState())
      XCTFail("A concurrent Maple writer holds the photo lock")
    } catch RemovalError.saveConflict {}
    let retained = try await assets.readAssets(records: records)
    XCTAssertEqual(retained.count, 2)
  }

  func testReplacedOriginalRefusesPublicationAndCommit() async throws {
    let raw = try stage()
    let assets = LocalRemovalAssetStore(rawURL: raw)
    let records = try await publish(assets)
    let sidecar = raw.deletingPathExtension().appendingPathExtension("xmp")
    let before = try Data(contentsOf: sidecar)
    try Data("different original".utf8).write(to: raw)
    do {
      _ = try await publish(assets)
      XCTFail("A candidate for a different original cannot publish")
    } catch RemovalError.invalid {}
    do {
      try await XMPSidecarStore(rawURL: raw).writeRemovalConfirmed(
        records: records, expectedRecords: "[]", model: .default, culling: CullingState())
      XCTFail("A changed original cannot commit")
    } catch RemovalError.invalid {}
    XCTAssertEqual(try Data(contentsOf: sidecar), before)
  }
}
