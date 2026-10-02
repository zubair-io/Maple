import Foundation
import XCTest

@testable import MapleCore

@MainActor
final class NativeWorkflowHistoryTests: EditorTestCase {
  private func files() throws -> (URL, URL, Data) {
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "native-workflow-history")
    var apple = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { apple.deleteLastPathComponent() }
    let raw = directory.appendingPathComponent("photo.dng")
    try FileManager.default.copyItem(
      at: apple.appendingPathComponent("MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng"),
      to: raw)
    return (directory, raw, try Data(contentsOf: raw))
  }

  private func record(_ raw: URL) throws -> SidecarWorkflow {
    try XCTUnwrap(
      WorkflowSidecarCore.read(
        xmp: String(contentsOf: SidecarPath.sidecarURL(for: raw), encoding: .utf8)))
  }

  func testRapidEditorGesturesUndoAndRedoPersistExactBoundaryModelsAcrossReopen() async throws {
    let (directory, raw, original) = try files()
    defer { try? FileManager.default.removeItem(at: directory) }
    let source = try String(
      contentsOf: WorkflowFixture.root().appendingPathComponent(
        "local-adjustments/lightroom-group-add.xmp"), encoding: .utf8)
    // Recognized mask groups have modeled fields and are canonically serialized.
    // An opaque foreign history subtree must retain its exact interior bytes.
    let unknownXML = """
      <vendor:Audit xmlns:vendor="urn:maple:test:opaque" z="kept" a="unchanged">
          <vendor:History> exposure &amp; colour </vendor:History>
        </vendor:Audit>
      """
    let foreign = source.replacingOccurrences(
      of: "<crs:MaskGroupBasedCorrections>",
      with: unknownXML + "\n   <crs:MaskGroupBasedCorrections>")
    try Data(foreign.utf8).write(to: SidecarPath.sidecarURL(for: raw))
    let session = EditSession(asset: AssetRef(url: raw), model: .default, culling: CullingState())
    await session.loadSidecar()
    let state = EditorState(session: session)
    state.arm(tool: .exposure)
    for exposure in [0.25, 0.75, 1.25] {
      state.commit()
      state.beginGesture()
      state.setArmedDisplayValue(exposure - 0.1)
      state.setArmedDisplayValue(exposure)
      state.endGesture()
    }
    state.undo()
    state.redo()
    await session.flushPendingSidecarWrite()
    XCTAssertNil(session.sidecarError)
    let persisted = try record(raw)
    XCTAssertEqual(
      persisted.history.map(\.action), ["adjustment", "adjustment", "adjustment", "undo", "redo"])
    XCTAssertEqual(
      persisted.history.map(\.label),
      ["Exposure", "Exposure", "Exposure", "Undo Exposure", "Redo Exposure"])
    XCTAssertEqual(
      try persisted.history.map { try XMPParser.parse($0.adjustmentXmp).0.exposure },
      [0.25, 0.75, 1.25, 0.75, 1.25])
    XCTAssertEqual(Set(persisted.history.map(\.id)).count, 5)
    for entry in persisted.history {
      XCTAssertNil(try WorkflowSidecarCore.read(xmp: entry.adjustmentXmp))
      XCTAssertTrue(entry.adjustmentXmp.contains("<crs:MaskGroupBasedCorrections>"))
      XCTAssertTrue(entry.adjustmentXmp.contains(unknownXML))
    }
    let reopened = EditSession(asset: AssetRef(url: raw), model: .default, culling: CullingState())
    await reopened.loadSidecar()
    XCTAssertEqual(reopened.model.exposure, 1.25)
    let fresh = XMPSidecarStore(rawURL: raw)
    let reopenedHistory = try await fresh.readWorkflow()
    XCTAssertEqual(reopenedHistory, persisted)
    XCTAssertEqual(try Data(contentsOf: raw), original)
  }

  func testPreviewTicksAndNoopTransactionsNeverCreateSemanticHistory() async throws {
    let (directory, raw, original) = try files()
    defer { try? FileManager.default.removeItem(at: directory) }
    let session = EditSession(asset: AssetRef(url: raw), model: .default, culling: CullingState())
    session.model.exposure = 0.25
    session.model.exposure = 0.5
    session.beginEdit()
    session.endEdit()
    await session.flushPendingSidecarWrite()
    let xml = try String(contentsOf: SidecarPath.sidecarURL(for: raw), encoding: .utf8)
    XCTAssertNil(try WorkflowSidecarCore.read(xmp: xml))
    XCTAssertEqual(try XMPParser.parse(xml).0.exposure, 0.5)
    XCTAssertEqual(try Data(contentsOf: raw), original)
  }

  func testFailedPublicationRetainsCapturedCheckpointThroughLaterPreviewAndRetry() async throws {
    let (directory, raw, original) = try files()
    defer { try? FileManager.default.removeItem(at: directory) }
    let sidecar = SidecarPath.sidecarURL(for: raw)
    let initial = XMPSerializer.serialize(model: .default, culling: CullingState())
    try Data(initial.utf8).write(to: sidecar)
    // A real filesystem failure, without substituting the sidecar writer.
    let obstruction = directory.appendingPathComponent(".photo.xmp.tmp")
    try FileManager.default.createDirectory(at: obstruction, withIntermediateDirectories: true)
    let store = XMPSidecarStore(rawURL: raw)
    var committed = AdjustmentModel.default
    committed.exposure = 1.25
    do {
      try await store.commitSemantic(
        model: committed, culling: CullingState(), action: "preset", label: "Warm study")
      XCTFail("Publication into an obstructed temporary path must fail")
    } catch {}
    XCTAssertEqual(try String(contentsOf: sidecar, encoding: .utf8), initial)
    var preview = committed
    preview.exposure = 2.25
    await store.update(model: preview, culling: CullingState())
    try FileManager.default.removeItem(at: obstruction)
    await store.flush()
    let persisted = try record(raw)
    XCTAssertEqual(persisted.history.count, 1)
    XCTAssertEqual(persisted.history[0].action, "preset")
    XCTAssertEqual(try XMPParser.parse(persisted.history[0].adjustmentXmp).0.exposure, 1.25)
    XCTAssertEqual(
      try XMPParser.parse(String(contentsOf: sidecar, encoding: .utf8)).0.exposure, 2.25)
    await store.flush()
    XCTAssertEqual(try record(raw), persisted, "Retry must not duplicate the committed action")
    XCTAssertEqual(try Data(contentsOf: raw), original)
  }

  func testCoreCompactionKeepsNewestActionsAndExistingNamedSnapshot() async throws {
    let (directory, raw, original) = try files()
    defer { try? FileManager.default.removeItem(at: directory) }
    let initial = XMPSerializer.serialize(model: .default, culling: CullingState())
    let snapshot = WorkflowSnapshot(
      id: UUID().uuidString.lowercased(), name: "Original", createdAtMs: 1, adjustmentXmp: initial)
    let workflow = SidecarWorkflow(
      schemaVersion: 1, variantId: "primary", variantName: "Original", snapshots: [snapshot],
      history: [])
    try Data(WorkflowSidecarCore.embed(workflow, in: initial).utf8).write(
      to: SidecarPath.sidecarURL(for: raw))
    let store = XMPSidecarStore(rawURL: raw)
    for index in 1...40 {
      var model = AdjustmentModel.default
      model.exposure = Double(index) / 10
      try await store.commitSemantic(
        model: model, culling: CullingState(), action: "adjustment", label: "Exposure \(index)")
    }
    let persisted = try record(raw)
    XCTAssertLessThanOrEqual(persisted.history.count, WorkflowContract.historyLimit)
    XCTAssertEqual(persisted.history.last?.label, "Exposure 40")
    XCTAssertEqual(persisted.snapshots, [snapshot])
    XCTAssertEqual(
      try XMPParser.parse(XCTUnwrap(persisted.history.last).adjustmentXmp).0.exposure, 4)
    XCTAssertEqual(try Data(contentsOf: raw), original)
  }

  func testFutureWorkflowFailsAtRealEditorBoundaryWithoutReplacingSidecar() async throws {
    let (directory, raw, original) = try files()
    defer { try? FileManager.default.removeItem(at: directory) }
    let initial = XMPSerializer.serialize(model: .default, culling: CullingState())
    let workflow = SidecarWorkflow(
      schemaVersion: 1, variantId: "primary", variantName: "Original", snapshots: [], history: [])
    let future = try WorkflowSidecarCore.embed(workflow, in: initial).replacingOccurrences(
      of: "<papp:SchemaVersion>1", with: "<papp:SchemaVersion>2")
    let sidecar = SidecarPath.sidecarURL(for: raw)
    try Data(future.utf8).write(to: sidecar)
    let session = EditSession(asset: AssetRef(url: raw), model: .default, culling: CullingState())
    session.beginEdit(description: "Exposure")
    session.model.exposure = 1.25
    session.endEdit()
    await session.flushPendingSidecarWrite()
    XCTAssertNotNil(session.sidecarError)
    XCTAssertEqual(try String(contentsOf: sidecar, encoding: .utf8), future)
    XCTAssertEqual(try Data(contentsOf: raw), original)
  }

  func testSeparateActorInstancesPreserveConcurrentCommittedHistory() async throws {
    let (directory, raw, original) = try files()
    defer { try? FileManager.default.removeItem(at: directory) }
    try await withThrowingTaskGroup(of: Void.self) { group in
      for index in 1...8 {
        group.addTask {
          let store = XMPSidecarStore(rawURL: raw)
          var model = AdjustmentModel.default
          model.exposure = Double(index) / 10
          try await store.commitSemantic(
            model: model, culling: CullingState(), action: "adjustment", label: "Exposure \(index)")
        }
      }
      try await group.waitForAll()
    }
    let persisted = try record(raw)
    XCTAssertEqual(Set(persisted.history.map(\.label)), Set((1...8).map { "Exposure \($0)" }))
    XCTAssertEqual(persisted.history.count, 8)
    let latest = try XCTUnwrap(persisted.history.last)
    XCTAssertEqual(
      try XMPParser.parse(latest.adjustmentXmp).0.exposure,
      try XMPParser.parse(String(contentsOf: SidecarPath.sidecarURL(for: raw), encoding: .utf8)).0
        .exposure)
    XCTAssertEqual(try Data(contentsOf: raw), original)
  }

  func testNamedVariantIdentityInPrimaryFailsWithoutRecordingOrPublishing() async throws {
    let (directory, raw, original) = try files()
    defer { try? FileManager.default.removeItem(at: directory) }
    let initial = XMPSerializer.serialize(model: .default, culling: CullingState())
    let workflow = SidecarWorkflow(
      schemaVersion: 1, variantId: UUID().uuidString.lowercased(), variantName: "Misplaced branch",
      snapshots: [], history: [])
    let misplaced = try WorkflowSidecarCore.embed(workflow, in: initial)
    let sidecar = SidecarPath.sidecarURL(for: raw)
    try Data(misplaced.utf8).write(to: sidecar)
    let store = XMPSidecarStore(rawURL: raw)
    do {
      try await store.commitSemantic(
        model: .default, culling: CullingState(), action: "adjustment", label: "Exposure")
      XCTFail("A primary edit must reject a different variant identity")
    } catch {}
    await store.flush()
    XCTAssertEqual(try String(contentsOf: sidecar, encoding: .utf8), misplaced)
    XCTAssertEqual(try Data(contentsOf: raw), original)
  }
}
