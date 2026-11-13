import Foundation
import XCTest

@testable import MapleCore

/// Real first-save and deep transfer paths, also observed by the fsync auditor (#3940).
final class LocalRemovalDirectoryPublicationTests: XCTestCase {
  private func fixture(_ name: String) throws -> Data {
    let parts = name.split(separator: ".")
    let url = try XCTUnwrap(
      Bundle.module.url(
        forResource: String(parts[0]), withExtension: String(parts[1]), subdirectory: "removal"))
    return try Data(contentsOf: url)
  }

  func testFirstSaveAndDeepTransferRetainAllImmutableAssetsAndSidecarOrder() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "removal-directory-publication-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let raw = root.appendingPathComponent("source.dng")
    let original = try fixture("source.dng")
    let prior = try fixture("prior.xmp")
    try original.write(to: raw)
    try prior.write(to: SidecarPath.sidecarURL(for: raw))
    let store = LocalRemovalAssetStore(rawURL: raw)
    let records = try await store.publish(
      request: String(decoding: fixture("request.txt"), as: UTF8.self), prior: "[]",
      mask: fixture("mask.mimf"), patch: fixture("patch.f16"))
    let acceptedAssets = try await store.readAssets(records: records)
    XCTAssertEqual(acceptedAssets.count, 2)
    XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: raw)), prior)
    try await XMPSidecarStore(rawURL: raw).writeRemovalConfirmed(
      records: records, expectedRecords: "[]", model: .default, culling: CullingState())
    let saved = try Data(contentsOf: SidecarPath.sidecarURL(for: raw))
    XCTAssertEqual(try RemovalXMPRecords.read(saved), records)

    let destination = root.appendingPathComponent("new/nested/photos/destination.dng")
    try await store.copyAssets(records: records, to: destination)
    let imported = LocalRemovalAssetStore(rawURL: destination)
    let retained = try await imported.readAssets(records: records)
    XCTAssertEqual(retained, acceptedAssets)
    XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: SidecarPath.sidecarURL(for: destination).path))
    // The caller publishes RAW and XMP only after the carrier tree is durable.
    try FileManager.default.copyItem(at: raw, to: destination)
    try await XMPSidecarStore(rawURL: destination).writeRemovalConfirmed(
      records: records, expectedRecords: "[]", model: .default, culling: CullingState())
    XCTAssertEqual(
      try RemovalXMPRecords.read(Data(contentsOf: SidecarPath.sidecarURL(for: destination))),
      records)
    XCTAssertEqual(try Data(contentsOf: destination), original)
    XCTAssertEqual(try Data(contentsOf: raw), original)
    XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: raw)), saved)
    // An existing carrier must be synchronized as well; it can be retained
    // from a prior interrupted publication, and its identical blobs are reused.
    try await store.copyAssets(records: records, to: destination)
    let repeated = try await imported.readAssets(records: records)
    XCTAssertEqual(repeated, acceptedAssets)
  }
}
