import Foundation
import XCTest

@testable import MapleCore

/// The editor can appear before its sidecar has loaded (slow remote, Cloud or File
/// Provider store). The Undo/Redo ring is then rebuilt from the retained history when
/// the sidecar lands, not only when the editor appears (#5905).
@MainActor
final class EditSessionLateSidecarUndoTests: EditorTestCase {
  private func files() throws -> (directory: URL, raw: URL, sidecar: URL) {
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "session-late-sidecar-undo")
    var apple = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { apple.deleteLastPathComponent() }
    let raw = directory.appendingPathComponent("photo.dng")
    try FileManager.default.copyItem(
      at: apple.appendingPathComponent("MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng"),
      to: raw)
    return (directory, raw, SidecarPath.sidecarURL(for: raw))
  }

  private func edit(_ session: EditSession, exposure: Double) {
    session.beginEdit()
    session.model.exposure = exposure
    session.endEdit()
  }

  /// Saves three exposure edits, so the sidecar's history folds to two Undo steps.
  private func saveHistory(for raw: URL, sidecar: URL) async throws {
    let first = EditSession(asset: AssetRef(url: raw), model: .default, culling: CullingState())
    await first.loadSidecar()
    for exposure in [0.25, 0.75, 1.25] { edit(first, exposure: exposure) }
    await first.flushPendingSidecarWrite()
    let xml = try String(contentsOf: sidecar, encoding: .utf8)
    XCTAssertEqual(try WorkflowSidecarCore.read(xmp: xml)?.history.count, 3)
  }

  /// An editor whose sidecar is still loading when it appears.
  private func openEditorBeforeSidecar(_ raw: URL) -> EditSession {
    let session = EditSession(asset: AssetRef(url: raw), model: .default, culling: CullingState())
    session.ensureRenderStarted()
    XCTAssertFalse(session.hasLoadedSidecar)
    XCTAssertFalse(session.canUndo)
    return session
  }

  func testUndoIsRebuiltWhenTheSidecarLoadsAfterTheEditorAppears() async throws {
    let (directory, raw, sidecar) = try files()
    defer { try? FileManager.default.removeItem(at: directory) }
    try await saveHistory(for: raw, sidecar: sidecar)

    let reopened = openEditorBeforeSidecar(raw)
    await reopened.loadSidecar()
    await reopened.workflow.undoRestoreTask?.value

    XCTAssertTrue(reopened.canUndo, "the retained history is restored once the sidecar loads")
    XCTAssertFalse(reopened.canRedo)
    XCTAssertEqual(reopened.undoHistory.count, 2)
    reopened.undo()
    await reopened.workflow.waitForIdle()
    XCTAssertEqual(reopened.model.exposure, 0.75, accuracy: 1e-9)
    XCTAssertTrue(reopened.canRedo)
  }

  func testAnEditMadeBeforeTheHistoryIsReadKeepsItsOwnRing() async throws {
    let (directory, raw, sidecar) = try files()
    defer { try? FileManager.default.removeItem(at: directory) }
    try await saveHistory(for: raw, sidecar: sidecar)

    let reopened = openEditorBeforeSidecar(raw)
    await reopened.loadSidecar()
    edit(reopened, exposure: 2)
    await reopened.workflow.undoRestoreTask?.value

    XCTAssertEqual(reopened.undoHistory.count, 1, "the history never replaces a newer edit")
    reopened.undo()
    await reopened.workflow.waitForIdle()
    XCTAssertEqual(reopened.model.exposure, 1.25, accuracy: 1e-9)
    XCTAssertFalse(reopened.canUndo)
  }

  func testABrowseSessionThatNeverOpensTheEditorReadsNoHistory() async throws {
    let (directory, raw, sidecar) = try files()
    defer { try? FileManager.default.removeItem(at: directory) }
    try await saveHistory(for: raw, sidecar: sidecar)

    let browsing = EditSession(asset: AssetRef(url: raw), model: .default, culling: CullingState())
    await browsing.loadSidecar()

    XCTAssertTrue(browsing.hasLoadedSidecar)
    XCTAssertNil(browsing.workflow.undoRestoreTask)
    XCTAssertFalse(browsing.canUndo)
  }
}
