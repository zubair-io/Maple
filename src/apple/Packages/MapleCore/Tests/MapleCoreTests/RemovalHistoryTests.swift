import Darwin
import Foundation
import XCTest

@testable import MapleCore

@MainActor
final class RemovalHistoryTests: XCTestCase {
  private func data(_ name: String, _ ext: String) throws -> Data {
    let url = try XCTUnwrap(
      Bundle.module.url(forResource: name, withExtension: ext, subdirectory: "removal/calibration"))
    return try Data(contentsOf: url)
  }

  private func stage() throws -> EditSession {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    let raw = directory.appendingPathComponent("photo.dng")
    try data("source", "dng").write(to: raw)
    try data("prior", "xmp").write(to: SidecarPath.sidecarURL(for: raw))
    return EditSession(asset: AssetRef(url: raw))
  }

  private func proposal() throws -> NativeRemovalProposal {
    NativeRemovalProposal(
      request: String(decoding: try data("request", "txt"), as: UTF8.self),
      mask: try data("mask", "mimf"), patch: try data("patch", "f16"))
  }

  private func keep(_ session: EditSession) async throws {
    try await session.acceptRemoval(
      proposal(), snapshot: session.removalAuthoringSnapshot())
  }

  private func reopen(_ session: EditSession) throws -> AdjustmentModel {
    try XMPParser.parse(data: Data(contentsOf: try XCTUnwrap(session.asset.sidecarURL))).0
  }

  private func pixels(_ session: EditSession) throws -> Data {
    var model = try reopen(session)
    model.profile = .neutral
    model.autoExposure = .off
    return try RawCoreBridge.withStrippedModelXMP(model) { parameters in
      try PipelineRenderer.renderSceneLinearSized(
        rawPath: try XCTUnwrap(session.asset.primaryURL), xmpPath: parameters,
        quality: .amaze, maxLongEdge: 64, autoExposureOverride: .off
      ).pixels
    }
  }

  func testKeepUndoRedoAndResetReopenTheSameRecipeAndActualPixels() async throws {
    let session = try stage()
    let base = session.model
    let originalPixels = try pixels(session)
    try await keep(session)
    await session.flushPendingSidecarWrite()
    let accepted = session.model
    let acceptedPixels = try pixels(session)
    XCTAssertNotEqual(acceptedPixels, originalPixels)
    XCTAssertEqual(try reopen(session), accepted)
    XCTAssertEqual(session.undoHistory.count, 1)
    XCTAssertEqual(session.undoHistory[0].kind, .repair)
    XCTAssertEqual(session.undoHistory[0].invalidation, .decode)
    XCTAssertEqual(session.undoHistory[0].diff.map(\.key), ["papp:InpaintRemovals"])

    session.undo()
    XCTAssertTrue(session.isSavingRemoval)
    XCTAssertEqual(session.model, accepted, "Do not show unsaved undo pixels")
    XCTAssertFalse(session.canUndo)
    XCTAssertFalse(session.canRedo)
    await session.flushPendingSidecarWrite()
    XCTAssertNil(session.sidecarError)
    XCTAssertEqual(session.model, base)
    XCTAssertEqual(try reopen(session), base)
    XCTAssertEqual(try pixels(session), originalPixels)
    XCTAssertTrue(session.canRedo)

    session.redo()
    await session.flushPendingSidecarWrite()
    XCTAssertEqual(session.model, accepted)
    XCTAssertEqual(try reopen(session), accepted)
    XCTAssertEqual(try pixels(session), acceptedPixels)
    XCTAssertEqual(session.undoHistory.count, 1)

    session.resetToOriginal()
    await session.flushPendingSidecarWrite()
    XCTAssertEqual(try reopen(session), base)
    XCTAssertEqual(session.undoHistory.count, 2)
    session.undo()
    await session.flushPendingSidecarWrite()
    XCTAssertEqual(try pixels(session), acceptedPixels)
    XCTAssertEqual(try reopen(session), accepted)
    XCTAssertEqual(
      try Data(contentsOf: XCTUnwrap(session.asset.primaryURL)), try data("source", "dng"))
    await session.releaseTransientMemory()
  }

  func testFailedRedoRetainsHistoryAndModelUntilCompanionsAreRecovered() async throws {
    let session = try stage()
    try await keep(session)
    let accepted = session.model
    session.undo()
    await session.flushPendingSidecarWrite()
    let before = session.model
    let raw = try XCTUnwrap(session.asset.primaryURL)
    let name = try XCTUnwrap(
      RemovalBridge.assetNames(records: accepted.inpaintRemovals!.json).first)
    let asset = raw.deletingLastPathComponent().appendingPathComponent(".maple/inpaint/\(name)")
    let bytes = try Data(contentsOf: asset)
    try FileManager.default.removeItem(at: asset)
    session.redo()
    await session.flushPendingSidecarWrite()
    XCTAssertNotNil(session.sidecarError)
    XCTAssertEqual(session.model, before)
    XCTAssertEqual(try reopen(session), before)
    XCTAssertTrue(session.canRedo)
    XCTAssertTrue(session.undoHistory.isEmpty)
    try bytes.write(to: asset)
    session.redo()
    await session.flushPendingSidecarWrite()
    XCTAssertNil(session.sidecarError)
    XCTAssertEqual(session.model, accepted)
    XCTAssertEqual(try reopen(session), accepted)
    await session.releaseTransientMemory()
  }

  func testFailedKeepAndStaleRevisionNeverRecordOrAdoptAProposal() async throws {
    let session = try stage()
    let before = session.model
    let snapshot = try await session.removalAuthoringSnapshot()
    session.beginEdit()
    session.model.exposure = 1
    session.endEdit()
    session.undo()
    do {
      try await session.acceptRemoval(proposal(), snapshot: snapshot)
      XCTFail("An edit → undo invalidates an in-flight proposal")
    } catch RemovalError.saveConflict {}
    XCTAssertTrue(session.undoHistory.isEmpty)
    let raw = try XCTUnwrap(session.asset.primaryURL)
    let lock = raw.deletingLastPathComponent().appendingPathComponent(".photo.xmp.lock")
    let fd = open(lock.path, O_CREAT | O_RDWR, 0o600)
    XCTAssertGreaterThanOrEqual(fd, 0)
    defer { close(fd) }
    XCTAssertEqual(flock(fd, LOCK_EX | LOCK_NB), 0)
    do {
      try await keep(session)
      XCTFail("A lock conflict cannot become a Saved event or undo entry")
    } catch RemovalError.saveConflict {}
    XCTAssertEqual(session.model, before)
    XCTAssertTrue(session.undoHistory.isEmpty)
    XCTAssertTrue(session.canRedo, "A failed Keep does not discard redo history")
    XCTAssertFalse(session.isSavingRemoval)
    XCTAssertNotNil(session.sidecarError)
    XCTAssertEqual(flock(fd, LOCK_UN), 0)
    await session.flushPendingSidecarWrite()
    try await keep(session)
    XCTAssertEqual(session.undoHistory.count, 1)
    XCTAssertFalse(session.canRedo)
    await session.releaseTransientMemory()
  }

  func testSavingFreezesModelAndHistoryButKeepsCullingChanges() async throws {
    let session = try stage()
    try await keep(session)
    await session.flushPendingSidecarWrite()
    let accepted = session.model
    session.undo()
    XCTAssertTrue(session.isSavingRemoval)
    session.model.exposure = 3
    session.beginEdit()
    session.redo()
    let router = EditorCommandRouter(state: EditorState(session: session))
    XCTAssertFalse(router.perform(.undo, assetID: session.asset.id))
    XCTAssertFalse(router.perform(.nudge(1), assetID: session.asset.id))
    session.culling.stars = 4
    XCTAssertEqual(session.model, accepted)
    XCTAssertNil(session.transactions.pending)
    await session.flushPendingSidecarWrite()
    XCTAssertNil(session.model.inpaintRemovals)
    XCTAssertEqual(session.model.exposure, 0)
    let reopened = try XMPParser.parse(data: Data(contentsOf: XCTUnwrap(session.asset.sidecarURL)))
    XCTAssertEqual(reopened.0, session.model)
    XCTAssertEqual(reopened.1.stars, 4)
    XCTAssertEqual(session.culling.stars, 4)
    await session.releaseTransientMemory()
  }

  func testFactoryResetClearsRemovalDurablyAndKeepsFramingAsOneAction() async throws {
    let session = try stage()
    try await keep(session)
    session.beginEdit(kind: .crop, description: "Crop")
    session.model.crop = Crop(top: 0.1, left: 0.1, bottom: 0.9, right: 0.9, angle: 0)
    session.endEdit()
    let before = session.model
    let count = session.undoHistory.count
    EditorState(session: session).resetToFactoryDefaults()
    await session.flushPendingSidecarWrite()
    XCTAssertEqual(session.model.crop, before.crop)
    XCTAssertNil(session.model.inpaintRemovals)
    XCTAssertEqual(session.undoHistory.count, count + 1)
    XCTAssertEqual(try reopen(session), session.model)
    session.undo()
    await session.flushPendingSidecarWrite()
    XCTAssertEqual(session.model, before)
    XCTAssertEqual(try reopen(session), before)
    await session.releaseTransientMemory()
  }

  func testChangedOriginalRefusesUndoWithoutPoppingHistory() async throws {
    let session = try stage()
    try await keep(session)
    await session.flushPendingSidecarWrite()
    let accepted = session.model
    let sidecar = try XCTUnwrap(session.asset.sidecarURL)
    let saved = try Data(contentsOf: sidecar)
    try Data("replaced source".utf8).write(to: XCTUnwrap(session.asset.primaryURL))
    session.undo()
    await session.flushPendingSidecarWrite()
    XCTAssertNotNil(session.sidecarError)
    XCTAssertEqual(session.model, accepted)
    XCTAssertEqual(session.undoHistory.count, 1)
    XCTAssertFalse(session.canRedo)
    XCTAssertEqual(try Data(contentsOf: sidecar), saved)
    await session.releaseTransientMemory()
  }

  func testExternalStackChangeRefusesUndoWithoutLosingRetryHistory() async throws {
    let session = try stage()
    try await keep(session)
    await session.flushPendingSidecarWrite()
    let accepted = session.model
    let raw = try XCTUnwrap(session.asset.primaryURL)
    let external = XMPSidecarStore(rawURL: raw)
    try await external.writeRemovalConfirmed(
      records: "[]", expectedRecords: accepted.inpaintRemovals!.json,
      model: .default, culling: CullingState())
    session.undo()
    await session.flushPendingSidecarWrite()
    XCTAssertNotNil(session.sidecarError)
    XCTAssertEqual(session.model, accepted)
    XCTAssertEqual(session.undoHistory.count, 1)
    XCTAssertFalse(session.canRedo)
    XCTAssertNil(try reopen(session).inpaintRemovals)
    try await external.writeRemovalConfirmed(
      records: accepted.inpaintRemovals!.json, expectedRecords: "[]",
      model: accepted, culling: CullingState())
    session.undo()
    await session.flushPendingSidecarWrite()
    XCTAssertNil(session.sidecarError)
    XCTAssertTrue(session.undoHistory.isEmpty)
    XCTAssertTrue(session.canRedo)
    XCTAssertNil(try reopen(session).inpaintRemovals)
    await session.releaseTransientMemory()
  }

  func testDirectModelAssignmentCannotPretendToSaveAnAcceptedStack() async throws {
    let session = try stage()
    let before = session.model
    session.model.inpaintRemovals = try RemovalRecords(
      json: String(decoding: data("records", "txt"), as: UTF8.self))
    XCTAssertEqual(session.model, before)
    XCTAssertNotNil(session.sidecarError)
    XCTAssertTrue(session.undoHistory.isEmpty)
    await session.flushPendingSidecarWrite()
    XCTAssertNil(try reopen(session).inpaintRemovals)
    await session.releaseTransientMemory()
  }
}
