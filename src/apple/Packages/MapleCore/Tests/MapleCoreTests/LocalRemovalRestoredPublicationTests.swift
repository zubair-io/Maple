import Darwin
import Foundation
import XCTest

@testable import MapleCore

/// #3940: restored bytes cannot inherit a prior publisher's durability receipt.
final class LocalRemovalRestoredPublicationTests: XCTestCase {
  private func fixture(_ name: String) throws -> Data {
    let parts = name.split(separator: ".")
    let url = try XCTUnwrap(
      Bundle.module.url(
        forResource: String(parts[0]), withExtension: String(parts[1]), subdirectory: "removal"))
    return try Data(contentsOf: url)
  }

  private func mark(_ action: String, _ edge: String) {
    FileHandle.standardError.write(Data("MAPLE_RESTORED_\(edge) \(action)\n".utf8))
  }

  private func restoreWithoutSync(_ data: Data, at destination: URL) throws {
    let temporary = destination.deletingLastPathComponent().appendingPathComponent(
      ".restore-\(UUID().uuidString).tmp")
    defer { try? FileManager.default.removeItem(at: temporary) }
    let descriptor = open(temporary.path, O_CREAT | O_EXCL | O_WRONLY, 0o600)
    guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    try handle.write(contentsOf: data)
    try handle.close()
    // Plain rename gives the restored bytes a new inode without syncing its
    // bytes or directory. Data.write's Foundation staging may itself fsync.
    guard rename(temporary.path, destination.path) == 0 else {
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
  }

  func testRestoredKeepRedoAndReusedPublicationSynchronizeReferencedFiles() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "removal-restored-publication-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let raw = root.appendingPathComponent("source.dng")
    let original = try fixture("source.dng")
    try original.write(to: raw)
    try fixture("prior.xmp").write(to: SidecarPath.sidecarURL(for: raw))
    let mask = try fixture("mask.mimf")
    let patch = try fixture("patch.f16")
    let request = String(decoding: try fixture("request.txt"), as: UTF8.self)
    let records = try RemovalBridge.prepare(request: request, prior: "[]", mask: mask, patch: patch)
    let directory = root.appendingPathComponent(".maple/inpaint", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let names = try RemovalBridge.assetNames(records: records)
    let bytes = try Dictionary(
      uniqueKeysWithValues: names.map { name in
        (name, name.hasSuffix(".mask") ? mask : patch)
      })
    for (name, data) in bytes {
      try restoreWithoutSync(data, at: directory.appendingPathComponent(name))
    }
    let sidecar = XMPSidecarStore(rawURL: raw)
    mark("Keep", "BEGIN")
    try await sidecar.writeRemovalConfirmed(
      records: records, expectedRecords: "[]", model: .default, culling: CullingState())
    mark("Keep", "END")
    XCTAssertEqual(
      try RemovalXMPRecords.read(Data(contentsOf: SidecarPath.sidecarURL(for: raw))), records)
    mark("Undo", "BEGIN")
    try await sidecar.writeRemovalConfirmed(
      records: "[]", expectedRecords: records, model: .default, culling: CullingState())
    mark("Undo", "END")
    XCTAssertNil(try RemovalXMPRecords.read(Data(contentsOf: SidecarPath.sidecarURL(for: raw))))
    // Replacing the valid retained files after undo invalidates any old inode's sync.
    for (name, data) in bytes {
      try restoreWithoutSync(data, at: directory.appendingPathComponent(name))
    }
    mark("Redo", "BEGIN")
    try await sidecar.writeRemovalConfirmed(
      records: records, expectedRecords: "[]", model: .default, culling: CullingState())
    mark("Redo", "END")
    let saved = try Data(contentsOf: SidecarPath.sidecarURL(for: raw))
    XCTAssertEqual(try RemovalXMPRecords.read(saved), records)
    mark("Reuse", "BEGIN")
    let reused = try await LocalRemovalAssetStore(rawURL: raw).publish(
      request: request, prior: "[]", mask: mask, patch: patch)
    mark("Reuse", "END")
    XCTAssertEqual(reused, records)
    XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: raw)), saved)
    let retained = try await LocalRemovalAssetStore(rawURL: raw).readAssets(records: records)
    XCTAssertEqual(retained, bytes)
    XCTAssertEqual(try Data(contentsOf: raw), original)
  }

  func testCorruptRestoredCompanionRefusesConfirmedSaveAndReuse() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let raw = root.appendingPathComponent("source.dng")
    let prior = try fixture("prior.xmp")
    try fixture("source.dng").write(to: raw)
    try prior.write(to: SidecarPath.sidecarURL(for: raw))
    let records = String(decoding: try fixture("records.txt"), as: UTF8.self)
    let directory = root.appendingPathComponent(".maple/inpaint", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let corrupt = Data("corrupt restored patch".utf8)
    for name in try RemovalBridge.assetNames(records: records) {
      try restoreWithoutSync(
        name.hasSuffix(".mask") ? fixture("mask.mimf") : corrupt,
        at: directory.appendingPathComponent(name))
    }
    do {
      try await XMPSidecarStore(rawURL: raw).writeRemovalConfirmed(
        records: records, expectedRecords: "[]", model: .default, culling: CullingState())
      XCTFail("Corrupt restored bytes cannot confirm a save")
    } catch RemovalError.invalid {}
    do {
      _ = try await LocalRemovalAssetStore(rawURL: raw).publish(
        request: String(decoding: fixture("request.txt"), as: UTF8.self), prior: "[]",
        mask: fixture("mask.mimf"), patch: fixture("patch.f16"))
      XCTFail("Reuse cannot replace conflicting immutable bytes")
    } catch RemovalError.invalid {}
    XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: raw)), prior)
    let patchName = try XCTUnwrap(
      RemovalBridge.assetNames(records: records).first { $0.hasSuffix(".f16") })
    XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent(patchName)), corrupt)
    XCTAssertEqual(try Data(contentsOf: raw), try fixture("source.dng"))
  }

  func testClearingEmptyTargetDoesNotCreateCompanionDirectories() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let raw = root.appendingPathComponent("source.dng")
    try fixture("source.dng").write(to: raw)
    try fixture("prior.xmp").write(to: SidecarPath.sidecarURL(for: raw))
    try await XMPSidecarStore(rawURL: raw).writeRemovalConfirmed(
      records: "[]", expectedRecords: "[]", model: .default, culling: CullingState())
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: root.appendingPathComponent(".maple").path))
    XCTAssertNil(try RemovalXMPRecords.read(Data(contentsOf: SidecarPath.sidecarURL(for: raw))))
    XCTAssertEqual(try Data(contentsOf: raw), try fixture("source.dng"))
  }
}
