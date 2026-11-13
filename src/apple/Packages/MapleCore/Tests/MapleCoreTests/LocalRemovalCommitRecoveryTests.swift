import Foundation
import XCTest

@testable import MapleCore

final class LocalRemovalCommitRecoveryTests: XCTestCase {
  private func fixture(_ name: String) throws -> Data {
    let parts = name.split(separator: ".")
    let url = try XCTUnwrap(
      Bundle.module.url(
        forResource: String(parts[0]), withExtension: String(parts[1]), subdirectory: "removal"))
    return try Data(contentsOf: url)
  }

  private func stage() throws -> URL {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: root) }
    let raw = root.appendingPathComponent("photo.dng")
    try fixture("source.dng").write(to: raw)
    try fixture("prior.xmp").write(to: SidecarPath.sidecarURL(for: raw))
    return raw
  }

  private func records(_ raw: URL) async throws -> String {
    try await LocalRemovalAssetStore(rawURL: raw).publish(
      request: String(decoding: fixture("request.txt"), as: UTF8.self), prior: "[]",
      mask: fixture("mask.mimf"), patch: fixture("patch.f16"))
  }

  func testFailureBeforeVisibilityCanRetryTheSameConfirmedCommand() async throws {
    let raw = try stage()
    let records = try await records(raw)
    let store = XMPSidecarStore(rawURL: raw)
    let before = try Data(contentsOf: SidecarPath.sidecarURL(for: raw))
    let revision = try await store.removalRevision()
    var target = AdjustmentModel.default
    target.inpaintRemovals = try RemovalRecords(json: records)
    let obstruction = raw.deletingLastPathComponent().appendingPathComponent(".photo.xmp.tmp")
    try FileManager.default.createDirectory(at: obstruction, withIntermediateDirectories: true)
    do {
      try await store.writeRemovalConfirmed(
        records: records, expectedRecords: "[]", model: target, culling: CullingState(),
        expectedSidecarRevision: revision)
      XCTFail("The real temporary-path obstruction must refuse publication")
    } catch {}
    XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: raw)), before)
    try FileManager.default.removeItem(at: obstruction)
    try await store.writeRemovalConfirmed(
      records: records, expectedRecords: "[]", model: target, culling: CullingState(),
      expectedSidecarRevision: revision)
    XCTAssertEqual(
      try RemovalXMPRecords.read(Data(contentsOf: SidecarPath.sidecarURL(for: raw))), records)
    let loaded = try await store.load()
    XCTAssertEqual(loaded.0, target)
    XCTAssertEqual(try Data(contentsOf: raw), try fixture("source.dng"))
  }

  func testFailureBeforeVisibilityDoesNotBlockAnOrdinarySaveOrAdoptOrphanAssets() async throws {
    let raw = try stage()
    let records = try await records(raw)
    let store = XMPSidecarStore(rawURL: raw)
    var target = AdjustmentModel.default
    target.inpaintRemovals = try RemovalRecords(json: records)
    let obstruction = raw.deletingLastPathComponent().appendingPathComponent(".photo.xmp.tmp")
    try FileManager.default.createDirectory(at: obstruction, withIntermediateDirectories: true)
    do {
      try await store.writeRemovalConfirmed(
        records: records, expectedRecords: "[]", model: target, culling: CullingState())
      XCTFail("The real temporary-path obstruction must refuse publication")
    } catch {}
    try FileManager.default.removeItem(at: obstruction)
    var ordinary = AdjustmentModel.default
    ordinary.exposure = 1.25
    await store.update(model: ordinary, culling: CullingState())
    await store.flush()
    let reopened = try XMPParser.parse(data: Data(contentsOf: SidecarPath.sidecarURL(for: raw))).0
    XCTAssertEqual(reopened.exposure, 1.25)
    XCTAssertNil(reopened.inpaintRemovals)
    let retained = try await LocalRemovalAssetStore(rawURL: raw).readAssets(records: records)
    XCTAssertEqual(retained.count, 2)
    XCTAssertEqual(try Data(contentsOf: raw), try fixture("source.dng"))
  }
}
