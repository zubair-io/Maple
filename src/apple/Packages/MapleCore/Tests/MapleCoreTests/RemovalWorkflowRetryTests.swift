import Darwin
import Foundation
import XCTest

@testable import MapleCore

final class RemovalWorkflowRetryTests: XCTestCase {
  private func fixture(_ name: String) throws -> Data {
    let parts = name.split(separator: ".")
    let url = try XCTUnwrap(
      Bundle.module.url(
        forResource: String(parts[0]), withExtension: String(parts[1]), subdirectory: "removal"))
    return try Data(contentsOf: url)
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
    guard rename(temporary.path, destination.path) == 0 else {
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
  }

  func testAlreadyPublishedRemovalRestoreReconfirmsDurabilityWithoutDuplicatingHistory()
    async throws
  {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "removal-workflow-retry-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let raw = root.appendingPathComponent("source.dng")
    let sidecar = SidecarPath.sidecarURL(for: raw)
    let original = try fixture("source.dng")
    try original.write(to: raw)
    let records = String(decoding: try fixture("records.txt"), as: UTF8.self)
    var accepted = AdjustmentModel.default
    accepted.exposure = 1.25
    accepted.inpaintRemovals = try RemovalRecords(json: records)
    let acceptedXML = XMPSerializer.serialize(model: accepted, culling: CullingState())
    let snapshot = WorkflowSnapshot(
      id: UUID().uuidString.lowercased(), name: "Accepted removal", createdAtMs: 1,
      adjustmentXmp: try WorkflowSidecarCore.checkpoint(xmp: acceptedXML))
    let checkpoint = try WorkflowSidecarCore.snapshot(snapshot, in: acceptedXML)
    let workflow = try XCTUnwrap(WorkflowSidecarCore.read(xmp: checkpoint))
    let before = try WorkflowSidecarCore.embed(
      workflow, in: XMPSerializer.serialize(model: .default, culling: CullingState()))
    let entry = WorkflowHistoryEntry(
      id: UUID().uuidString.lowercased(), createdAtMs: 2, action: "snapshot-restore",
      label: "Restore accepted removal", adjustmentXmp: snapshot.adjustmentXmp)
    let command = WorkflowPublication.restore(expectedXmp: before, entry: entry)
    let output = try command.output(current: before)
    let directory = root.appendingPathComponent(".maple/inpaint", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    for name in try RemovalBridge.assetNames(records: records) {
      try restoreWithoutSync(
        fixture(name.hasSuffix(".mask") ? "mask.mimf" : "patch.f16"),
        at: directory.appendingPathComponent(name))
    }
    let store = XMPSidecarStore(rawURL: raw)
    for action in ["Restore", "RepeatedRestore"] {
      // Matching command identity and valid XML do not prove that these
      // restored bytes have been synchronized. Use a new unsynced inode.
      try restoreWithoutSync(Data(output.utf8), at: sidecar)
      FileHandle.standardError.write(Data("MAPLE_WORKFLOW_RETRY_BEGIN \(action)\n".utf8))
      let confirmed = try await store.publishWorkflow(command)
      FileHandle.standardError.write(Data("MAPLE_WORKFLOW_RETRY_END \(action)\n".utf8))
      XCTAssertEqual(confirmed, output)
      XCTAssertEqual(try String(contentsOf: sidecar, encoding: .utf8), output)
      let saved = try XCTUnwrap(WorkflowSidecarCore.read(xmp: confirmed))
      XCTAssertEqual(saved.history, [entry])
      XCTAssertEqual(saved.snapshots, [snapshot])
      let loaded = try await store.load()
      XCTAssertEqual(loaded.0, accepted)
    }
    let missing = try XCTUnwrap(RemovalBridge.assetNames(records: records).first)
    try FileManager.default.removeItem(at: directory.appendingPathComponent(missing))
    do {
      _ = try await store.publishWorkflow(command)
      XCTFail("A matching workflow UUID cannot bypass missing removal bytes")
    } catch RemovalError.missingCompanion {}
    XCTAssertEqual(try String(contentsOf: sidecar, encoding: .utf8), output)
    XCTAssertEqual(try Data(contentsOf: raw), original)
  }
}
