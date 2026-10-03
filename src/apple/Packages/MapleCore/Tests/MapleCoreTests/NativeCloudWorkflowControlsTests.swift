import Foundation
import XCTest

@testable import MapleCore

#if os(macOS)
  @MainActor
  final class NativeCloudWorkflowControlsTests: EditorTestCase {
    private typealias Fixture = NativeWorkflowControlFixture

    private func session(
      _ fixture: NativeWorkflowHTTPFixture, _ source: NativeWorkflowHTTPFixture.Source,
      catalog: Bool = false
    ) -> EditSession {
      let path = source.path
      let asset = AssetRef(
        displayName: "photo.dng", hintExtension: "dng", stableID: source.id,
        bytesProvider: { try Data(contentsOf: URL(fileURLWithPath: path)) })
      return EditSession(asset: asset, remoteSidecarStore: fixture.store(source, catalog: catalog))
    }

    private func path(_ source: NativeWorkflowHTTPFixture.Source) -> URL {
      SidecarPath.sidecarURL(for: URL(fileURLWithPath: source.path))
    }

    func testActualFolderAndCatalogCompleteXmpRestoreUndoRedoAndReopen() async throws {
      let fixture = try await NativeWorkflowHTTPFixture.start()
      defer { fixture.stop() }
      for catalog in [false, true] {
        let source = try await fixture.stage(xml: Fixture.input())
        let original = try Data(contentsOf: URL(fileURLWithPath: source.path))
        let editor = session(fixture, source, catalog: catalog)
        await editor.loadSidecar()
        try await Fixture.fullFlow(editor, path: path(source))
        let reopened = session(fixture, source, catalog: catalog)
        await reopened.workflow.reload(session: reopened)
        XCTAssertNil(reopened.workflow.errorText)
        XCTAssertEqual(reopened.model.exposure, 2)
        XCTAssertEqual(reopened.culling.keywords, ["Keyword A"])
        XCTAssertEqual(reopened.workflow.record, try Fixture.record(path(source)))
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: source.path)), original)
      }
    }

    func testAbsentPrimarySnapshotIsOneAtomicPublicationWithoutFakeHistory() async throws {
      let fixture = try await NativeWorkflowHTTPFixture.start()
      defer { fixture.stop() }
      let source = try await fixture.stage(xml: nil)
      let editor = session(fixture, source, catalog: true)
      await editor.loadSidecar()
      let snapshot = try await Fixture.save(editor)
      XCTAssertEqual(
        try Fixture.checkpoint(path(source)),
        try WorkflowSidecarCore.checkpoint(
          xmp: WorkflowSidecarCore.embed(Fixture.record(path(source)), in: snapshot.adjustmentXmp)))
      XCTAssertTrue(try Fixture.record(path(source)).history.isEmpty)
      editor.workflow.prepareRestore(id: snapshot.id, snapshot: true)
      await editor.workflow.confirmRestore(session: editor)
      XCTAssertNil(editor.workflow.errorText)
      XCTAssertTrue(try Fixture.record(path(source)).history.isEmpty)
      XCTAssertTrue(editor.undoHistory.isEmpty)
      let detail =
        try JSONSerialization.jsonObject(
          with: await fixture.control("/workflow-fixture/\(source.key)")) as! [String: Any]
      XCTAssertEqual((detail["changes"] as? [[String: Any]])?.count, 1)
    }

    func testLostAcceptedSnapshotRestoreUndoAndRedoRepliesRetryEachIdentityOnce() async throws {
      let fixture = try await NativeWorkflowHTTPFixture.start()
      defer { fixture.stop() }
      let source = try await fixture.stage(xml: Fixture.input())
      let editor = session(fixture, source)
      await editor.workflow.reload(session: editor)
      _ = try await fixture.control("/workflow-fixture/\(source.key)/lose-response", body: [:])
      await editor.workflow.saveSnapshot(name: "Saved A", session: editor)
      XCTAssertNotNil(editor.workflow.errorText)
      let accepted = try Fixture.record(path(source))
      XCTAssertEqual(accepted.snapshots.count, 1)
      await editor.workflow.saveSnapshot(name: "Saved A", session: editor)
      XCTAssertNil(editor.workflow.errorText)
      XCTAssertEqual(try Fixture.record(path(source)).snapshots, accepted.snapshots)
      try await Fixture.replace(path(source), session: editor)
      let before = try Fixture.checkpoint(path(source))
      editor.workflow.prepareRestore(id: accepted.snapshots[0].id, snapshot: true)
      _ = try await fixture.control("/workflow-fixture/\(source.key)/lose-response", body: [:])
      await editor.workflow.confirmRestore(session: editor)
      XCTAssertNotNil(editor.workflow.errorText)
      XCTAssertEqual(editor.model.exposure, 1.5)
      XCTAssertTrue(editor.undoHistory.isEmpty)
      XCTAssertEqual(try Fixture.record(path(source)).history.count, 1)
      await editor.workflow.confirmRestore(session: editor)
      XCTAssertNil(editor.workflow.errorText)
      XCTAssertEqual(editor.undoHistory.count, 1)
      for undo in [true, false] {
        _ = try await fixture.control("/workflow-fixture/\(source.key)/lose-response", body: [:])
        if undo { editor.undo() } else { editor.redo() }
        await editor.flushPendingSidecarWrite()
        XCTAssertNotNil(editor.workflow.errorText)
        XCTAssertEqual(editor.undoHistory.count, undo ? 1 : 0)
        if undo { editor.undo() } else { editor.redo() }
        await editor.flushPendingSidecarWrite()
        XCTAssertNil(editor.workflow.errorText)
        XCTAssertEqual(editor.undoHistory.count, undo ? 0 : 1)
        XCTAssertEqual(
          try Fixture.checkpoint(path(source)), undo ? before : accepted.snapshots[0].adjustmentXmp)
      }
      XCTAssertEqual(
        try Fixture.record(path(source)).history.map(\.action),
        ["snapshot-restore", "undo", "redo"])
    }

    func testNavigationDuringAdmittedRestoreAndUndoPreparationCannotReviveOldUi() async throws {
      let fixture = try await NativeWorkflowHTTPFixture.start()
      defer { fixture.stop() }
      for undo in [false, true] {
        let source = try await fixture.stage(xml: Fixture.input())
        let editor = session(fixture, source)
        await editor.loadSidecar()
        let snapshot = try await Fixture.save(editor)
        try await Fixture.replace(path(source), session: editor)
        editor.workflow.prepareRestore(id: snapshot.id, snapshot: true)
        if undo { await editor.workflow.confirmRestore(session: editor) }
        _ = try await fixture.control("/workflow-fixture/\(source.key)/block", body: [:])
        let work: Task<Void, Never>
        if undo {
          editor.undo()
          work = try XCTUnwrap(editor.workflow.task)
        } else {
          work = Task { await editor.workflow.confirmRestore(session: editor) }
        }
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        var arrived = false
        while ContinuousClock.now < deadline {
          let detail =
            try JSONSerialization.jsonObject(
              with: await fixture.control("/workflow-fixture/\(source.key)")) as! [String: Any]
          if (detail["blockedReads"] as? Int ?? 0) > 0 {
            arrived = true
            break
          }
          try await Task.sleep(for: .milliseconds(25))
        }
        XCTAssertTrue(arrived, "actual variant GET reached the owned socket gate")
        editor.workflow.invalidate()
        let replacement = try await fixture.stage(xml: Fixture.input(exposure: 3, tag: "C"))
        let fresh = session(fixture, replacement)
        await fresh.loadSidecar()
        let replacementXml = try Fixture.xml(path(replacement))
        _ = try await fixture.control("/workflow-fixture/\(source.key)/release", body: [:])
        await work.value
        XCTAssertNil(editor.workflow.documentXmp)
        XCTAssertNil(editor.workflow.pendingRestoreLabel)
        XCTAssertEqual(editor.undoHistory.count, undo ? 1 : 0)
        XCTAssertEqual(fresh.model.exposure, 3)
        XCTAssertTrue(fresh.undoHistory.isEmpty)
        XCTAssertEqual(try Fixture.xml(path(replacement)), replacementXml)
        if undo { XCTAssertEqual(try Fixture.checkpoint(path(source)), snapshot.adjustmentXmp) }
      }
    }
  }
#endif
