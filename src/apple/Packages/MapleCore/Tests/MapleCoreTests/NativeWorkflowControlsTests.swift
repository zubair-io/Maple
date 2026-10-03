import Foundation
import MapleBackup
import XCTest

@testable import MapleCore

@MainActor
final class NativeWorkflowControlsTests: EditorTestCase {
  private typealias Fixture = NativeWorkflowControlFixture

  func testFilesystemCompleteCheckpointRestoreUndoRedoAndReopen() async throws {
    let files = try Fixture.files()
    defer { try? FileManager.default.removeItem(at: files.directory) }
    let path = SidecarPath.sidecarURL(for: files.raw)
    try Data(Fixture.input().utf8).write(to: path)
    let session = EditSession(asset: AssetRef(url: files.raw))
    await session.loadSidecar()
    try await Fixture.fullFlow(session, path: path)
    let reopened = EditSession(asset: AssetRef(url: files.raw))
    await reopened.workflow.reload(session: reopened)
    XCTAssertEqual(reopened.model.exposure, 2)
    XCTAssertEqual(reopened.culling.keywords, ["Keyword A"])
    XCTAssertEqual(reopened.workflow.record, try Fixture.record(path))
    XCTAssertTrue(reopened.undoHistory.isEmpty)
    XCTAssertEqual(try Data(contentsOf: files.raw), files.original)
  }

  func testPhotoKitUsesCanonicalAppSupportCheckpointAndReopens() async throws {
    let files = try Fixture.files()
    defer { try? FileManager.default.removeItem(at: files.directory) }
    let backing = AppSupportSidecarStore(root: files.directory.appendingPathComponent("sidecars"))
    let id = "PHOTO/WORKFLOW/ORIGINAL"
    let path = backing.sidecarURL(phassetLocalId: id)
    try FileManager.default.createDirectory(
      at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data(Fixture.input().utf8).write(to: path)
    let raw = files.raw
    let asset = AssetRef(
      displayName: "photo.dng", hintExtension: "dng", stableID: id,
      bytesProvider: { try Data(contentsOf: raw) })
    let session = EditSession(
      asset: asset, remoteSidecarStore: PhotoKitSidecarStore(phassetLocalId: id, sidecars: backing))
    await session.loadSidecar()
    try await Fixture.fullFlow(session, path: path)
    let reopened = EditSession(
      asset: asset, remoteSidecarStore: PhotoKitSidecarStore(phassetLocalId: id, sidecars: backing))
    await reopened.workflow.reload(session: reopened)
    XCTAssertEqual(reopened.model.exposure, 2)
    XCTAssertEqual(reopened.workflow.record, try Fixture.record(path))
    XCTAssertEqual(try Data(contentsOf: raw), files.original)
  }

  func testForeignOnlyRestoreRecordsOneActionAndHistorySelectionRestoresMetadata() async throws {
    let files = try Fixture.files()
    defer { try? FileManager.default.removeItem(at: files.directory) }
    let path = SidecarPath.sidecarURL(for: files.raw)
    try Data(Fixture.input().utf8).write(to: path)
    let session = EditSession(asset: AssetRef(url: files.raw))
    await session.loadSidecar()
    let snapshot = try await Fixture.save(session)
    try await Fixture.replace(path, session: session, exposure: 0)
    session.workflow.prepareRestore(id: snapshot.id, snapshot: true)
    await session.workflow.confirmRestore(session: session)
    XCTAssertNil(session.workflow.errorText)
    XCTAssertEqual(session.undoHistory.count, 1)
    XCTAssertEqual(session.undoHistory.last?.invalidation, InvalidationScope.none)
    session.undo()
    await session.flushPendingSidecarWrite()
    let undo = try XCTUnwrap(session.workflow.record?.history.last)
    session.redo()
    await session.flushPendingSidecarWrite()
    await session.workflow.reload(session: session)
    session.workflow.prepareRestore(id: undo.id, snapshot: false)
    await session.workflow.confirmRestore(session: session)
    XCTAssertEqual(try Fixture.checkpoint(path), undo.adjustmentXmp)
    XCTAssertEqual(try Fixture.record(path).history.last?.action, "history-restore")
    XCTAssertEqual(session.culling.keywords, ["Keyword B"])
  }

  func testFailedRestoreAndUndoKeepTheModelAndRingUntilRetrySucceeds() async throws {
    let files = try Fixture.files()
    defer { try? FileManager.default.removeItem(at: files.directory) }
    let path = SidecarPath.sidecarURL(for: files.raw)
    try Data(Fixture.input().utf8).write(to: path)
    let session = EditSession(asset: AssetRef(url: files.raw))
    await session.loadSidecar()
    let snapshot = try await Fixture.save(session)
    try await Fixture.replace(path, session: session)
    let before = try Fixture.xml(path)
    let obstruction = files.directory.appendingPathComponent(".photo.xmp.tmp")
    try FileManager.default.createDirectory(at: obstruction, withIntermediateDirectories: false)
    session.workflow.prepareRestore(id: snapshot.id, snapshot: true)
    await session.workflow.confirmRestore(session: session)
    XCTAssertNotNil(session.workflow.errorText)
    XCTAssertEqual(session.model.exposure, 1.5)
    XCTAssertTrue(session.undoHistory.isEmpty)
    XCTAssertEqual(try Fixture.xml(path), before)
    try FileManager.default.removeItem(at: obstruction)
    await session.workflow.confirmRestore(session: session)
    XCTAssertNil(session.workflow.errorText)
    XCTAssertEqual(session.undoHistory.count, 1)
    try FileManager.default.createDirectory(at: obstruction, withIntermediateDirectories: false)
    session.undo()
    await session.flushPendingSidecarWrite()
    XCTAssertNotNil(session.workflow.errorText)
    XCTAssertEqual(session.model.exposure, 0)
    XCTAssertEqual(session.undoHistory.count, 1)
    XCTAssertFalse(session.canRedo)
    try FileManager.default.removeItem(at: obstruction)
    session.undo()
    await session.flushPendingSidecarWrite()
    XCTAssertNil(session.workflow.errorText)
    XCTAssertEqual(session.model.exposure, 1.5)
    XCTAssertTrue(session.undoHistory.isEmpty)
    XCTAssertEqual(try Fixture.record(path).history.map(\.action), ["snapshot-restore", "undo"])
    XCTAssertEqual(try Data(contentsOf: files.raw), files.original)
  }

  func testStaleConfirmationCannotOverwriteAChangedPrimaryAndNoopAddsNoHistory() async throws {
    let files = try Fixture.files()
    defer { try? FileManager.default.removeItem(at: files.directory) }
    let path = SidecarPath.sidecarURL(for: files.raw)
    try Data(Fixture.input().utf8).write(to: path)
    let session = EditSession(asset: AssetRef(url: files.raw))
    await session.loadSidecar()
    let snapshot = try await Fixture.save(session)
    session.workflow.prepareRestore(id: snapshot.id, snapshot: true)
    await session.workflow.confirmRestore(session: session)
    XCTAssertTrue(try Fixture.record(path).history.isEmpty)
    try await Fixture.replace(path, session: session)
    session.workflow.prepareRestore(id: snapshot.id, snapshot: true)
    let changed = try WorkflowSidecarCore.embed(
      Fixture.record(path), in: Fixture.input(exposure: 3, tag: "C"))
    try Data(changed.utf8).write(to: path, options: .atomic)
    await session.workflow.confirmRestore(session: session)
    XCTAssertNotNil(session.workflow.errorText)
    XCTAssertEqual(try Fixture.xml(path), changed)
    XCTAssertTrue(session.undoHistory.isEmpty)
    await session.workflow.reload(session: session)
    session.workflow.prepareRestore(id: snapshot.id, snapshot: true)
    await session.workflow.confirmRestore(session: session)
    XCTAssertNil(session.workflow.errorText)
    XCTAssertEqual(try Fixture.checkpoint(path), snapshot.adjustmentXmp)
  }

  func testAtomicFirstSnapshotRaceAndMalformedInitialLeaveOriginalUntouched() async throws {
    let files = try Fixture.files()
    defer { try? FileManager.default.removeItem(at: files.directory) }
    let path = SidecarPath.sidecarURL(for: files.raw)
    let initial = Fixture.input()
    let outcomes = await withTaskGroup(of: Bool.self, returning: [Bool].self) { group in
      for index in 0..<8 {
        group.addTask {
          let command = WorkflowPublication.snapshot(
            expectedXmp: nil, initialXmp: initial,
            snapshot: WorkflowSnapshot(
              id: UUID().uuidString.lowercased(), name: "Client \(index)", createdAtMs: 1000,
              adjustmentXmp: initial))
          do {
            _ = try await XMPSidecarStore(rawURL: files.raw).publishWorkflow(command)
            return true
          } catch { return false }
        }
      }
      var results: [Bool] = []
      for await result in group { results.append(result) }
      return results
    }
    XCTAssertEqual(outcomes.filter { $0 }.count, 1)
    XCTAssertEqual(try Fixture.record(path).snapshots.count, 1)
    XCTAssertTrue(try Fixture.record(path).history.isEmpty)
    try FileManager.default.removeItem(at: path)
    let invalid = WorkflowPublication.snapshot(
      expectedXmp: nil, initialXmp: "<malformed",
      snapshot: WorkflowSnapshot(
        id: UUID().uuidString.lowercased(), name: "Invalid", createdAtMs: 1000,
        adjustmentXmp: initial))
    do {
      _ = try await XMPSidecarStore(rawURL: files.raw).publishWorkflow(invalid)
      XCTFail("invalid initial checkpoint accepted")
    } catch {}
    XCTAssertFalse(FileManager.default.fileExists(atPath: path.path))
    XCTAssertEqual(try Data(contentsOf: files.raw), files.original)
  }
}
