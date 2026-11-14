import Foundation
import XCTest

@testable import MapleCore

/// A live editor on an SMB share adopts the merge and rebuilds Undo/Redo from its history (#5828).
@MainActor
final class SMBEditSessionReconcileTests: EditorTestCase {
  private func editor(_ source: SMBSource, _ ref: ImageRef) async -> EditSession {
    let asset = AssetRef(
      displayName: ref.displayName, hintExtension: "dng", stableID: ref.id,
      thumbnailProvenance: .smb, bytesProvider: { try await source.rawBytes(for: ref) })
    let session = EditSession(
      asset: asset, remoteSidecarStore: SMBSidecarStore(source: source, ref: ref))
    session.announcer = RecordingAnnouncer()
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

  private func shared(_ fixture: OwnedSMBWorkflowFixture) throws -> String {
    try String(contentsOf: fixture.share.appendingPathComponent("photo.xmp"), encoding: .utf8)
  }

  private func history(_ fixture: OwnedSMBWorkflowFixture) throws -> [WorkflowHistoryEntry] {
    try WorkflowSidecarCore.read(xmp: shared(fixture))?.history ?? []
  }

  private func waitUntil(_ condition: @MainActor () -> Bool) async -> Bool {
    for _ in 0..<1000 {
      if condition() { return true }
      try? await Task.sleep(for: .milliseconds(10))
    }
    return condition()
  }

  func testLiveEditorAdoptsAMergedOutsideEditAndRebuildsUndoFromTheHistory() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let ref = try await fixture.image()
    let session = await editor(fixture.source, ref)
    XCTAssertNil(session.sidecarError)
    let sidecar = fixture.share.appendingPathComponent("photo.xmp")
    let existing = try shared(fixture)
    var outside = try XMPParser.parse(existing).0
    outside.contrast = 30
    try XMPSerializer.serialize(
      model: outside, culling: session.culling, metadata: XMPParser.parseMetadata(existing),
      passthrough: XMPParser.parsePassthrough(existing)
    ).write(to: sidecar, atomically: true, encoding: .utf8)

    edit(session) { $0.exposure = 0.5 }

    let adopted = await waitUntil { session.model.contrast == 30 }
    XCTAssertTrue(adopted, "the editor shows the merged document")
    XCTAssertEqual(session.model.exposure, 0.5, accuracy: 1e-9)
    await session.flushPendingSidecarWrite()
    XCTAssertNil(session.sidecarError)
    XCTAssertFalse(session.hasUnconfirmedSidecarUpdate)
    XCTAssertEqual(try history(fixture).map(\.action), ["external", "adjustment"])
    let rebuilt = await waitUntil {
      session.undoHistory.count == 1 && session.undoHistory[0].checkpoint != nil
    }
    XCTAssertTrue(rebuilt, "Undo is rebuilt from the merged history")
    XCTAssertEqual(session.undoHistory.first?.before.contrast ?? 0, 30, accuracy: 1e-9)
    XCTAssertEqual(session.undoHistory.count, 1, "the outside edit is one undo step")

    session.undo()
    await session.workflow.waitForIdle()
    await session.flushPendingSidecarWrite()
    XCTAssertEqual(session.model.exposure, 0, accuracy: 1e-9)
    XCTAssertEqual(session.model.contrast, 30, accuracy: 1e-9)
    session.redo()
    await session.workflow.waitForIdle()
    await session.flushPendingSidecarWrite()
    XCTAssertEqual(session.model.exposure, 0.5, accuracy: 1e-9)

    edit(session) { $0.saturation = 10 }
    await session.flushPendingSidecarWrite()
    XCTAssertNil(session.sidecarError)
    let saved = try XMPParser.parse(shared(fixture)).0
    XCTAssertEqual(saved.contrast, 30, accuracy: 1e-9, "a later save keeps the outside edit")
    XCTAssertEqual(saved.exposure, 0.5, accuracy: 1e-9)
    XCTAssertEqual(saved.saturation, 10, accuracy: 1e-9)
    XCTAssertEqual(
      try history(fixture).map(\.action), ["external", "adjustment", "undo", "redo", "adjustment"])
    XCTAssertEqual(try Data(contentsOf: fixture.raw), fixture.original)
    await session.renderActor.cancelAll()
    await session.releaseTransientMemory()
    await fixture.close()
  }
}
