import Foundation
import MapleBackup
import XCTest

@testable import MapleCore

/// Actual branch writers, before editor/cache integration tracked in #4063.
final class NativeVariantWriterTests: XCTestCase {
  private typealias Fixture = NativeWorkflowControlFixture

  func testNamedBranchOwnsEditsSnapshotsRestoreAndReplayWithoutChangingPrimary() async throws {
    let files = try Fixture.files()
    defer { try? FileManager.default.removeItem(at: files.directory) }
    let primary = SidecarPath.sidecarURL(for: files.raw)
    try Data(Fixture.input().utf8).write(to: primary)
    let initial = try Data(contentsOf: primary)
    try await exerciseBranch(primary: primary)
    XCTAssertEqual(try Data(contentsOf: primary), initial)
    XCTAssertEqual(try Data(contentsOf: files.raw), files.original)
  }

  func testPhotosCanonicalRootDiscoversIndependentSiblingAfterReopen() async throws {
    let files = try Fixture.files()
    defer { try? FileManager.default.removeItem(at: files.directory) }
    let backing = AppSupportSidecarStore(root: files.directory.appendingPathComponent("photos"))
    let primary = backing.sidecarURL(phassetLocalId: "PHOTO/VARIANT/ORIGINAL")
    try FileManager.default.createDirectory(
      at: primary.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data(Fixture.input().utf8).write(to: primary)
    let initial = try Data(contentsOf: primary)
    try await exerciseBranch(primary: primary)
    XCTAssertEqual(try Data(contentsOf: primary), initial)
    XCTAssertEqual(try Data(contentsOf: files.raw), files.original)
  }

  func testMissingNamedBranchNeverFallsBackOrRecreatesItThroughAnOrdinarySave() async throws {
    let files = try Fixture.files()
    defer { try? FileManager.default.removeItem(at: files.directory) }
    let primary = SidecarPath.sidecarURL(for: files.raw)
    try Data(Fixture.input().utf8).write(to: primary)
    let id = UUID().uuidString.lowercased()
    let writer = try XMPSidecarStore(primarySidecarURL: primary, variantId: id)
    let selected = await writer.url
    do {
      _ = try await writer.loadIfPresent()
      XCTFail("A missing UUID branch cannot hydrate primary/default state")
    } catch { XCTAssertTrue(error.localizedDescription.contains("missing")) }
    do {
      try await writer.writeConfirmed(model: .default, culling: CullingState())
      XCTFail("An ordinary save must not recreate a missing branch")
    } catch { XCTAssertTrue(error.localizedDescription.contains("missing")) }
    XCTAssertFalse(FileManager.default.fileExists(atPath: selected.path))
    XCTAssertEqual(try Fixture.xml(primary), Fixture.input())
  }

  func testMismatchedIdentityRejectsHydrationAndPublicationWithoutChangingEitherFile() async throws
  {
    let files = try Fixture.files()
    defer { try? FileManager.default.removeItem(at: files.directory) }
    let primary = SidecarPath.sidecarURL(for: files.raw)
    try Data(Fixture.input().utf8).write(to: primary)
    let id = UUID().uuidString.lowercased()
    let writer = try XMPSidecarStore(primarySidecarURL: primary, variantId: id)
    let selected = await writer.url
    try Data(Fixture.input(tag: "B").utf8).write(to: selected)
    let initial = try Data(contentsOf: selected)
    do {
      _ = try await writer.readWorkflowXML()
      XCTFail("A legacy primary document cannot impersonate a named branch")
    } catch { XCTAssertTrue(error.localizedDescription.contains("identity")) }
    do {
      try await writer.writeConfirmed(model: .default, culling: CullingState())
      XCTFail("A mismatched branch cannot be overwritten")
    } catch { XCTAssertTrue(error.localizedDescription.contains("identity")) }
    XCTAssertEqual(try Data(contentsOf: selected), initial)
    XCTAssertEqual(try Fixture.xml(primary), Fixture.input())
    XCTAssertThrowsError(try XMPSidecarStore(primarySidecarURL: primary, variantId: "../primary"))
  }

  private func exerciseBranch(primary: URL) async throws {
    let id = UUID().uuidString.lowercased()
    let store = WorkflowVariantStore(primarySidecarURL: primary)
    let record = SidecarWorkflow(
      schemaVersion: WorkflowContract.version, variantId: id, variantName: "Alternate treatment",
      snapshots: [], history: [])
    let selected = try await store.create(record)
    let writer = try XMPSidecarStore(primarySidecarURL: primary, variantId: id)
    let initialDocument = try await writer.readWorkflowXML()
    let initial = try XCTUnwrap(initialDocument)
    let snapshot = WorkflowSnapshot(
      id: UUID().uuidString.lowercased(), name: "Saved branch", createdAtMs: 1,
      adjustmentXmp: try WorkflowSidecarCore.checkpoint(xmp: initial))
    _ = try await writer.publishWorkflow(
      .snapshot(expectedXmp: initial, initialXmp: nil, snapshot: snapshot))
    var model = AdjustmentModel.default
    model.exposure = 1.5
    try await writer.commitSemantic(
      model: model, culling: CullingState(stars: 5, keywords: ["Branch only"]),
      action: "adjustment", label: "Exposure")
    let changedDocument = try await writer.readWorkflowXML()
    let changed = try XCTUnwrap(changedDocument)
    let before = try WorkflowSidecarCore.checkpoint(xmp: changed)
    let restore = history(snapshot.adjustmentXmp, action: "snapshot-restore", timestamp: 2)
    let restored = try await writer.publishWorkflow(.restore(expectedXmp: changed, entry: restore))
    XCTAssertEqual(try Fixture.checkpoint(selected), snapshot.adjustmentXmp)
    XCTAssertEqual(try Fixture.record(selected).variantId, id)
    let undone = try await writer.publishWorkflow(
      .replay(expectedXmp: restored, entry: history(before, action: "undo", timestamp: 3)))
    XCTAssertEqual(try Fixture.checkpoint(selected), before)
    _ = try await writer.publishWorkflow(
      .replay(
        expectedXmp: undone,
        entry: history(snapshot.adjustmentXmp, action: "redo", timestamp: 4)))
    XCTAssertEqual(try Fixture.checkpoint(selected), snapshot.adjustmentXmp)
    XCTAssertEqual(try Fixture.record(selected).snapshots, [snapshot])
    XCTAssertEqual(
      try Fixture.record(selected).history.map(\.action),
      ["adjustment", "snapshot-restore", "undo", "redo"])
    let reopened = WorkflowVariantStore(primarySidecarURL: primary)
    let branches = try await reopened.list()
    XCTAssertEqual(Set(branches.map(\.variantId)), [WorkflowContract.primaryVariantID, id])
    let reopenedWriter = try XMPSidecarStore(primarySidecarURL: primary, variantId: id)
    let parsed = try await reopenedWriter.load()
    XCTAssertEqual(parsed.0.exposure, 0)
    XCTAssertEqual(parsed.1.keywords, ["Keyword A"])
    XCTAssertTrue(try Fixture.xml(selected).contains("z=\"A\""))
  }

  private func history(_ checkpoint: String, action: String, timestamp: UInt64)
    -> WorkflowHistoryEntry
  {
    WorkflowHistoryEntry(
      id: UUID().uuidString.lowercased(), createdAtMs: timestamp, action: action,
      label: action, adjustmentXmp: checkpoint)
  }
}
