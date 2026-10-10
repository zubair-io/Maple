import Foundation
import XCTest

@testable import MapleCore

@MainActor
final class RemovalSavedControlsTests: XCTestCase {
  private func data(_ name: String, _ ext: String) throws -> Data {
    try Data(
      contentsOf: XCTUnwrap(
        Bundle.module.url(
          forResource: name, withExtension: ext, subdirectory: "removal/calibration")))
  }

  private func stage() async throws -> EditSession {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    let raw = directory.appendingPathComponent("photo.dng")
    try data("source", "dng").write(to: raw)
    let session = EditSession(asset: AssetRef(url: raw))
    try await session.acceptRemoval(proposal(), snapshot: session.removalAuthoringSnapshot())
    return session
  }

  private func proposal(version: String? = nil) throws -> NativeRemovalProposal {
    let original = try data("request", "txt")
    var request = try XCTUnwrap(JSONSerialization.jsonObject(with: original) as? [String: Any])
    if let version { request["model_version"] = version }
    return NativeRemovalProposal(
      request: String(decoding: try JSONSerialization.data(withJSONObject: request), as: UTF8.self),
      mask: try data("mask", "mimf"), patch: try data("patch", "f16"))
  }

  private func reopen(_ session: EditSession) throws -> AdjustmentModel {
    try XMPParser.parse(data: Data(contentsOf: XCTUnwrap(session.asset.sidecarURL))).0
  }

  func testDisableEnableDeleteAndUndoAreConfirmedIndividualEditsAndRetainAssets() async throws {
    let session = try await stage()
    let removal = RemovalSession(session: session)
    await removal.open()
    let id = try XCTUnwrap(removal.savedRemovals.first).id
    let original = try XCTUnwrap(session.model.inpaintRemovals).json
    await removal.setSavedRemoval(id, active: false)
    XCTAssertEqual(removal.phase, .ready, removal.message)
    XCTAssertFalse(try XCTUnwrap(removal.savedRemovals.first).active)
    XCTAssertEqual(session.undoHistory.count, 2)
    XCTAssertEqual(try reopen(session), session.model)
    let disabled = session.model
    await removal.setSavedRemoval(id, active: true)
    XCTAssertTrue(try XCTUnwrap(removal.savedRemovals.first).active)
    XCTAssertEqual(try XCTUnwrap(removal.savedRemovals.first).id, id)
    let enabled = session.model
    await removal.setSavedRemoval(id, active: nil)
    XCTAssertTrue(removal.savedRemovals.isEmpty)
    XCTAssertNil(session.model.inpaintRemovals)
    XCTAssertEqual(session.undoHistory.count, 4)
    XCTAssertEqual(try reopen(session), session.model)
    let raw = try XCTUnwrap(session.asset.primaryURL)
    let assets = raw.deletingLastPathComponent().appendingPathComponent(".maple/inpaint")
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: assets.path).count, 2)
    session.undo()
    await session.flushPendingSidecarWrite()
    XCTAssertEqual(try reopen(session), enabled)
    session.undo()
    await session.flushPendingSidecarWrite()
    XCTAssertEqual(try reopen(session), disabled)
    session.undo()
    await session.flushPendingSidecarWrite()
    XCTAssertEqual(try reopen(session).inpaintRemovals?.json, original)
    XCTAssertEqual(try Data(contentsOf: raw), try data("source", "dng"))
    removal.close()
    await session.releaseTransientMemory()
  }

  func testReplacementLoadsSavedMaskRefinesWithStrokeHistoryAndCancelWritesNothing() async throws {
    let session = try await stage()
    let removal = RemovalSession(session: session)
    await removal.open()
    let id = try XCTUnwrap(removal.savedRemovals.first).id
    let sidecar = try XCTUnwrap(session.asset.sidecarURL)
    let before = try Data(contentsOf: sidecar)
    await removal.replaceSavedRemoval(id)
    XCTAssertEqual(removal.phase, .ready, removal.message)
    XCTAssertEqual(removal.replacingRemovalID, id)
    XCTAssertEqual(removal.context?.model.inpaintRemovals?.json ?? "[]", "[]")
    let base = removal.selection
    XCTAssertEqual(base, try data("mask", "mimf"))
    removal.radius = 0.1
    await removal.paint([[0.8, 0.5]], cropInputSize: [16, 8])
    XCTAssertNotEqual(removal.selection, base)
    await removal.undoSelection()
    XCTAssertEqual(removal.selection, base)
    await removal.redoSelection()
    XCTAssertNotEqual(removal.selection, base)
    await removal.setMode(.people)
    XCTAssertEqual(removal.mode, .paint)
    await removal.cancelSavedReplacement()
    XCTAssertNil(removal.replacingRemovalID)
    XCTAssertEqual(removal.phase, .ready, removal.message)
    XCTAssertEqual(try Data(contentsOf: sidecar), before)
    XCTAssertEqual(session.undoHistory.count, 1)
    removal.close()
    await session.releaseTransientMemory()
  }

  func testInPlaceReplacementUsesEarlierPrefixAndFreezesLaterPatchUntilReviewed() async throws {
    let session = try await stage()
    try await session.acceptRemoval(proposal(), snapshot: session.removalAuthoringSnapshot())
    let originalModel = session.model
    let original = try XCTUnwrap(originalModel.inpaintRemovals).json
    let rows = try RemovalBridge.savedList(records: original)
    let engine = NativeRemovalEditorEngine()
    let context = try await engine.prepare(
      raw: XCTUnwrap(session.asset.primaryURL), model: originalModel)
    let prefix = try await engine.replacementInput(id: rows[0].id, original: context)
    XCTAssertEqual(prefix.model.inpaintRemovals?.json ?? "[]", "[]")
    XCTAssertTrue(prefix.assets.isEmpty)
    let replacement = try proposal(version: "replacement test recipe")
    let candidate = try await engine.appending(replacement, to: prefix)
    let review = try await engine.replacementReview(
      id: rows[0].id, original: context, candidate: candidate)
    let reviewed = try RemovalBridge.savedList(
      records: XCTUnwrap(review.model.inpaintRemovals).json)
    XCTAssertEqual(reviewed.map(\.id), rows.map(\.id))
    XCTAssertEqual(reviewed.map(\.needsReview), [false, true])
    try await session.acceptRemovals(
      [replacement], snapshot: session.removalAuthoringSnapshot(), replacing: rows[0].id)
    XCTAssertEqual(try reopen(session), review.model)
    XCTAssertEqual(session.undoHistory.count, 3)
    let changed = try XCTUnwrap(session.model.inpaintRemovals).json
    let oldValues = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(original.utf8)) as? [[String: Any]])
    let newValues = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(changed.utf8)) as? [[String: Any]])
    XCTAssertEqual(oldValues[1]["patch"] as? String, newValues[1]["patch"] as? String)
    XCTAssertEqual(
      try JSONSerialization.data(withJSONObject: oldValues[1]["accepted"]!, options: .sortedKeys),
      try JSONSerialization.data(withJSONObject: newValues[1]["accepted"]!, options: .sortedKeys))
    session.undo()
    await session.flushPendingSidecarWrite()
    XCTAssertEqual(try reopen(session), originalModel)
    session.redo()
    await session.flushPendingSidecarWrite()
    XCTAssertEqual(try reopen(session).inpaintRemovals?.json, changed)
    await session.releaseTransientMemory()
  }

  func testStaleSidecarRefusesSavedRowChangeAndRetainsHistory() async throws {
    let session = try await stage()
    let before = session.model
    let snapshot = try await session.removalAuthoringSnapshot()
    let id = try XCTUnwrap(
      RemovalBridge.savedList(records: XCTUnwrap(before.inpaintRemovals).json).first
    ).id
    let sidecar = try XCTUnwrap(session.asset.sidecarURL)
    let external = Data(
      (XMPSerializer.serialize(model: before, culling: CullingState()) + "\n<!-- external -->").utf8
    )
    try external.write(to: sidecar)
    do {
      try await session.editSavedRemoval(id: id, active: false, snapshot: snapshot)
      XCTFail("A stale full-XMP snapshot must not overwrite external metadata")
    } catch RemovalError.saveConflict {}
    XCTAssertEqual(session.model, before)
    XCTAssertEqual(session.undoHistory.count, 1)
    XCTAssertEqual(try Data(contentsOf: sidecar), external)
    await session.releaseTransientMemory()
  }
}
