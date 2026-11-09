import Foundation
import XCTest

@testable import MapleCore

/// The live editor adopts merges and rebuilds its Undo/Redo ring from the persisted history (#4983).
@MainActor
final class EditSessionHistoryReconcileTests: EditorTestCase {
  private func files() throws -> (directory: URL, raw: URL, sidecar: URL) {
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "session-history-reconcile")
    var apple = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { apple.deleteLastPathComponent() }
    let raw = directory.appendingPathComponent("photo.dng")
    try FileManager.default.copyItem(
      at: apple.appendingPathComponent("MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng"),
      to: raw)
    return (directory, raw, SidecarPath.sidecarURL(for: raw))
  }

  private func open(_ raw: URL) async -> EditSession {
    let session = EditSession(asset: AssetRef(url: raw), model: .default, culling: CullingState())
    await session.loadSidecar()
    session.restoreUndoHistory()
    await session.workflow.undoRestoreTask?.value
    return session
  }

  private func edit(_ session: EditSession, _ change: (inout AdjustmentModel) -> Void) {
    session.beginEdit()
    change(&session.model)
    session.endEdit()
  }

  private func outsideEdit(_ sidecar: URL, _ change: (inout AdjustmentModel) -> Void) throws {
    let existing = try String(contentsOf: sidecar, encoding: .utf8)
    var model = try XMPParser.parse(existing).0
    change(&model)
    try XMPSerializer.serialize(
      model: model, culling: CullingState(), passthrough: XMPParser.parsePassthrough(existing)
    ).write(to: sidecar, atomically: true, encoding: .utf8)
  }

  private func history(_ sidecar: URL) throws -> [WorkflowHistoryEntry] {
    try WorkflowSidecarCore.read(xmp: String(contentsOf: sidecar, encoding: .utf8))?.history ?? []
  }

  private func waitUntil(_ condition: @MainActor () -> Bool) async -> Bool {
    for _ in 0..<500 {
      if condition() { return true }
      try? await Task.sleep(for: .milliseconds(10))
    }
    return condition()
  }

  func testLiveEditorAdoptsAMergedOutsideEditAndTheNextSaveDoesNotRevertIt() async throws {
    let (directory, raw, sidecar) = try files()
    defer { try? FileManager.default.removeItem(at: directory) }
    try XMPSerializer.serialize(model: .default, culling: CullingState())
      .write(to: sidecar, atomically: true, encoding: .utf8)
    let session = await open(raw)
    try outsideEdit(sidecar) { $0.contrast = 30 }

    edit(session) { $0.exposure = 0.5 }

    let adopted = await waitUntil { session.model.contrast == 30 }
    XCTAssertTrue(adopted, "the editor shows the merged document")
    XCTAssertEqual(session.model.exposure, 0.5, accuracy: 1e-9)
    await session.flushPendingSidecarWrite()
    XCTAssertNil(session.sidecarError)
    XCTAssertFalse(session.hasUnconfirmedSidecarUpdate)
    XCTAssertEqual(try history(sidecar).map(\.action), ["external", "adjustment"])
    XCTAssertEqual(session.undoHistory.count, 1, "the outside edit is one undo step")

    edit(session) { $0.saturation = 10 }
    await session.flushPendingSidecarWrite()

    let text = try String(contentsOf: sidecar, encoding: .utf8)
    let saved = try XMPParser.parse(text).0
    XCTAssertEqual(saved.contrast, 30, accuracy: 1e-9, "a later save keeps the outside edit")
    XCTAssertEqual(saved.exposure, 0.5, accuracy: 1e-9)
    XCTAssertEqual(saved.saturation, 10, accuracy: 1e-9)
    XCTAssertEqual(try history(sidecar).map(\.action), ["external", "adjustment", "adjustment"])
  }

  func testUndoAndRedoAreRebuiltFromTheHistoryWhenASessionReopens() async throws {
    let (directory, raw, sidecar) = try files()
    defer { try? FileManager.default.removeItem(at: directory) }
    let first = await open(raw)
    for exposure in [0.25, 0.75, 1.25] { edit(first) { $0.exposure = exposure } }
    await first.flushPendingSidecarWrite()
    let before = try history(sidecar)
    XCTAssertEqual(before.count, 3)

    let reopened = await open(raw)
    XCTAssertEqual(try history(sidecar), before, "opening an editor records nothing")
    XCTAssertEqual(reopened.undoHistory.count, 2)
    XCTAssertTrue(reopened.canUndo)
    XCTAssertFalse(reopened.canRedo)

    reopened.undo()
    await reopened.workflow.waitForIdle()
    XCTAssertEqual(reopened.model.exposure, 0.75, accuracy: 1e-9)
    XCTAssertTrue(reopened.canRedo)
    reopened.redo()
    await reopened.workflow.waitForIdle()
    XCTAssertEqual(reopened.model.exposure, 1.25, accuracy: 1e-9)

    let recorded = try history(sidecar)
    XCTAssertEqual(
      recorded.map(\.action), ["adjustment", "adjustment", "adjustment", "undo", "redo"])
    XCTAssertEqual(recorded.map(\.writer), Array(repeating: "apple", count: 5))
    XCTAssertEqual(recorded.map(\.parentId), [""] + recorded.dropLast().map(\.id))
  }

  func testAnOutsideEditMadeWhileClosedAddsAnUndoStep() async throws {
    let (directory, raw, sidecar) = try files()
    defer { try? FileManager.default.removeItem(at: directory) }
    let first = await open(raw)
    for exposure in [0.25, 0.75] { edit(first) { $0.exposure = exposure } }
    await first.flushPendingSidecarWrite()
    try outsideEdit(sidecar) { $0.contrast = 30 }

    let reopened = await open(raw)
    XCTAssertEqual(reopened.model.contrast, 30, accuracy: 1e-9)
    XCTAssertEqual(reopened.undoHistory.count, 2, "one retained step plus the outside edit")

    reopened.undo()
    await reopened.workflow.waitForIdle()
    XCTAssertEqual(reopened.model.contrast, 0, accuracy: 1e-9)
    XCTAssertEqual(reopened.model.exposure, 0.75, accuracy: 1e-9)
    reopened.redo()
    await reopened.workflow.waitForIdle()
    XCTAssertEqual(reopened.model.contrast, 30, accuracy: 1e-9)
  }

  func testPreviewTicksAndNoOpTransactionsStayOutOfTheRebuiltHistory() async throws {
    let (directory, raw, sidecar) = try files()
    defer { try? FileManager.default.removeItem(at: directory) }
    let first = await open(raw)
    edit(first) { $0.exposure = 0.5 }
    first.model.exposure = 0.6
    first.model.exposure = 0.7
    first.beginEdit()
    first.endEdit()
    await first.flushPendingSidecarWrite()
    XCTAssertEqual(try history(sidecar).count, 1)

    let reopened = await open(raw)
    XCTAssertEqual(
      reopened.undoHistory.count, 1, "the unrecorded preview ticks are one outside step")
    XCTAssertEqual(try history(sidecar).count, 1)
  }
}
