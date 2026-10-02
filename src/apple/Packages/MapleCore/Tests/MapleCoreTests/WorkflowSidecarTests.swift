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
