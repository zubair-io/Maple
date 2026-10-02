import Foundation
import XCTest

@testable import MapleCore

final class WorkflowSidecarTests: XCTestCase {
  private func record() throws -> SidecarWorkflow {
    try JSONDecoder().decode(
      [SidecarWorkflow].self,
      from: Data(
        contentsOf: WorkflowFixture.root().appendingPathComponent("workflow/contract-v1.json")))[1]
  }
  private func xml() throws -> String {
    try String(
      contentsOf: WorkflowFixture.root().appendingPathComponent(
        "local-adjustments/lightroom-group-add.xmp"),
      encoding: .utf8)
  }
  func testSharedSiblingPathsAndCapturedCheckpointsSurviveRealFiles() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let record = try record()
    let raw = dir.appendingPathComponent("photo.MOV")
    let original = Data([1, 0, 255, 42])
    try original.write(to: raw)
    XCTAssertEqual(
      try SidecarPath.variantURL(for: raw, variantId: "primary"), SidecarPath.sidecarURL(for: raw))
    let sibling = try SidecarPath.variantURL(for: raw, variantId: record.variantId)
    XCTAssertEqual(sibling.lastPathComponent, "photo.MOV.v\(record.variantId).xmp")
    XCTAssertThrowsError(try SidecarPath.variantURL(for: raw, variantId: "../primary"))
    let embedded = try WorkflowSidecarCore.embed(record, in: xml())
    let checkpoint = try WorkflowSidecarCore.checkpoint(xmp: embedded)
    XCTAssertNil(try WorkflowSidecarCore.read(xmp: checkpoint))
    XCTAssertTrue(checkpoint.contains("<crs:MaskGroupBasedCorrections>"))
    let before = try XMPParser.parse(embedded).0
    let after = try XMPParser.parse(checkpoint).0
    XCTAssertEqual(before, after)
    try Data(checkpoint.utf8).write(to: sibling, options: .atomic)
    XCTAssertEqual(try String(contentsOf: sibling, encoding: .utf8), checkpoint)
    let future = embedded.replacingOccurrences(
      of: "<papp:SchemaVersion>1", with: "<papp:SchemaVersion>2")
    XCTAssertThrowsError(try WorkflowSidecarCore.checkpoint(xmp: future))
    XCTAssertEqual(try Data(contentsOf: sibling), Data(checkpoint.utf8))
    XCTAssertEqual(try Data(contentsOf: raw), original)
  }
  func testRustValidationAndEmbeddingPreserveCompleteAuthoredCheckpoints() throws {
    let workflow = try record()
    let input = try xml()
    try WorkflowSidecarCore.validate(workflow)
    XCTAssertNil(try WorkflowSidecarCore.read(xmp: input))
    let output = try WorkflowSidecarCore.embed(workflow, in: input)
    XCTAssertEqual(try WorkflowSidecarCore.read(xmp: output), workflow)
    XCTAssertEqual(try WorkflowSidecarCore.embed(workflow, in: output), output)
    XCTAssertTrue(output.contains("<crs:MaskGroupBasedCorrections>"))
  }
  func testActorPublishesWorkflowAndPendingAdjustmentsThenReopensRealSidecar() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let original = dir.appendingPathComponent("photo.dng")
    let sidecar = dir.appendingPathComponent("photo.xmp")
    let bytes = Data([1, 2, 0, 255])
    try bytes.write(to: original)
    try Data(try xml().utf8).write(to: sidecar)
    let store = XMPSidecarStore(rawURL: original)
    var model = try await store.load().0
    model.exposure = 1.25
    await store.update(model: model, culling: CullingState())
    let workflow = try record()
    try await store.writeWorkflowConfirmed(workflow)
    let reopened = XMPSidecarStore(rawURL: original)
    let loaded = try await reopened.readWorkflow()
    XCTAssertEqual(loaded, workflow)
    let persistedModel = try await reopened.load().0
    XCTAssertEqual(persistedModel.exposure, 1.25)
    model.exposure = 2.0
    try await reopened.writeConfirmed(model: model, culling: CullingState())
    let retained = try await XMPSidecarStore(rawURL: original).readWorkflow()
    XCTAssertEqual(retained, workflow)
    XCTAssertEqual(try Data(contentsOf: original), bytes)
  }
  func testUnsupportedExistingWorkflowRejectsBothWritersWithoutChangingDisk() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let original = dir.appendingPathComponent("photo.dng")
    let sidecar = dir.appendingPathComponent("photo.xmp")
    try Data([42]).write(to: original)
    let workflow = try record()
    let future = try WorkflowSidecarCore.embed(workflow, in: xml())
      .replacingOccurrences(of: "<papp:SchemaVersion>1", with: "<papp:SchemaVersion>2")
    try Data(future.utf8).write(to: sidecar)
    let store = XMPSidecarStore(rawURL: original)
    do {
      try await store.writeWorkflowConfirmed(workflow)
      XCTFail("future record replaced")
    } catch {}
    do {
      try await store.writeConfirmed(model: .default, culling: CullingState())
      XCTFail("future record overwritten")
    } catch {}
    XCTAssertEqual(try Data(contentsOf: sidecar), Data(future.utf8))
    XCTAssertEqual(try Data(contentsOf: original), Data([42]))
  }
}
