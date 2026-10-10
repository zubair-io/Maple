import Foundation
import XCTest

@testable import MapleCore

@MainActor
final class RemovalGroupTests: XCTestCase {
  private func stage() throws -> EditSession {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    let fixture = try XCTUnwrap(
      Bundle.module.url(
        forResource: "source", withExtension: "dng", subdirectory: "removal/calibration"))
    let raw = directory.appendingPathComponent("photo.dng")
    try FileManager.default.copyItem(at: fixture, to: raw)
    return EditSession(asset: AssetRef(url: raw))
  }

  private func proposal(_ context: NativeRemovalEditorContext, x: Double) async throws
    -> NativeRemovalProposal
  {
    let mask = try RemovalBridge.selection(
      width: context.width, height: context.height,
      request:
        "{\"schema\":1,\"strokes\":[{\"subtract\":false,\"radius\":0.1,\"points\":[[\(x),0.5]]}]}")
    let plan = try NativeRemovalGeneration.plan(
      source: context.source, intent: mask, holeRadius: 1, fringeRadius: 1)
    let request: [String: Any] = [
      "schema": 1, "source": try JSONSerialization.jsonObject(with: Data(context.source.utf8)),
      "masks": try JSONSerialization.jsonObject(with: Data(plan.utf8)),
      "model": try RemovalBridge.digest(Data("group-fixture".utf8)), "model_version": "fixture",
    ]
    let scene = try await context.saved.generationContext(
      xmp: context.xmp, x: 0, y: 0, width: 16, height: 8)
    let generation = try NativeRemovalGeneration.prepare(
      request: String(decoding: JSONSerialization.data(withJSONObject: request), as: UTF8.self),
      prior: context.model.inpaintRemovals?.json ?? "[]", scene: scene, intent: mask)
    let input = try generation.inputs()
    return try generation.finish(generated: input.rgb.map { min(0.9, $0 + 0.15) })
  }

  private func group(_ session: EditSession) async throws
    -> ([NativeRemovalProposal], NativeRemovalEditorContext)
  {
    let engine = NativeRemovalEditorEngine()
    let base = try await engine.prepare(
      raw: XCTUnwrap(session.asset.primaryURL), model: session.model)
    let first = try await proposal(base, x: 0.4)
    let interim = try await engine.appending(first, to: base)
    let second = try await proposal(interim, x: 0.6)
    return ([first, second], try await engine.appending(second, to: interim))
  }

  func testTemporaryDependentGroupCommitsAndUndoesAsOneEdit() async throws {
    let session = try stage()
    let raw = try XCTUnwrap(session.asset.primaryURL)
    let original = try Data(contentsOf: raw)
    let sidecar = try XCTUnwrap(session.asset.sidecarURL)
    let snapshot = try await session.removalAuthoringSnapshot()
    let (proposals, candidate) = try await group(session)
    XCTAssertFalse(FileManager.default.fileExists(atPath: sidecar.path))
    XCTAssertFalse(
      FileManager.default.fileExists(
        atPath:
          raw.deletingLastPathComponent().appendingPathComponent(".maple/inpaint").path))
    let records = try XCTUnwrap(candidate.model.inpaintRemovals).json
    let decoded = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(records.utf8)) as? [[String: Any]])
    XCTAssertEqual(decoded.count, 2)
    let second = try XCTUnwrap(decoded[1]["accepted"] as? [String: Any])
    XCTAssertEqual((second["dependencies"] as? [Any])?.count, 1)
    let expected = try await candidate.saved.generationContext(
      xmp: candidate.xmp, x: 0, y: 0, width: 16, height: 8)
    try await session.acceptRemovals(proposals, snapshot: snapshot)
    await session.flushPendingSidecarWrite()
    XCTAssertEqual(session.model.inpaintRemovals?.json, records)
    XCTAssertEqual(session.undoHistory.count, 1)
    XCTAssertEqual(session.undoHistory[0].description, "Remove 2 objects")
    let savedModel = try XMPParser.parse(data: Data(contentsOf: sidecar)).0
    XCTAssertEqual(savedModel, session.model)
    let engine = NativeRemovalEditorEngine()
    let reopened = try await engine.prepare(raw: raw, model: savedModel)
    let actual = try await reopened.saved.generationContext(
      xmp: reopened.xmp, x: 0, y: 0, width: 16, height: 8)
    XCTAssertEqual(actual, expected, "Reopen must reproduce the whole group without inference")
    session.undo()
    await session.flushPendingSidecarWrite()
    XCTAssertNil(session.model.inpaintRemovals)
    XCTAssertNil(try XMPParser.parse(data: Data(contentsOf: sidecar)).0.inpaintRemovals)
    session.redo()
    await session.flushPendingSidecarWrite()
    XCTAssertEqual(session.model.inpaintRemovals?.json, records)
    XCTAssertEqual(session.undoHistory.count, 1)
    XCTAssertEqual(try Data(contentsOf: raw), original)
    await session.releaseTransientMemory()
  }

  func testInvalidLaterProposalDoesNotCommitAPrefixOrMoveHistory() async throws {
    let session = try stage()
    let sidecar = try XCTUnwrap(session.asset.sidecarURL)
    let snapshot = try await session.removalAuthoringSnapshot()
    let (proposals, _) = try await group(session)
    let broken = NativeRemovalProposal(
      request: proposals[1].request, mask: proposals[1].mask, patch: Data())
    do {
      try await session.acceptRemovals([proposals[0], broken], snapshot: snapshot)
      XCTFail("Invalid second companion cannot commit the first object")
    } catch { XCTAssertTrue(error is RemovalError) }
    await session.flushPendingSidecarWrite()
    XCTAssertEqual(session.model, snapshot.model)
    XCTAssertTrue(session.undoHistory.isEmpty)
    XCTAssertFalse(session.isSavingRemoval)
    XCTAssertFalse(FileManager.default.fileExists(atPath: sidecar.path))
    // Valid orphan companions from the failed group can be reused on retry.
    try await session.acceptRemovals(proposals, snapshot: snapshot)
    XCTAssertEqual(session.undoHistory.count, 1)
    await session.releaseTransientMemory()
  }

  func testExternalSidecarChangeRejectsTheWholeGroup() async throws {
    let session = try stage()
    let snapshot = try await session.removalAuthoringSnapshot()
    let (proposals, _) = try await group(session)
    let sidecar = try XCTUnwrap(session.asset.sidecarURL)
    var foreign = snapshot.model
    foreign.exposure = 1
    let external = Data(XMPSerializer.serialize(model: foreign, culling: CullingState()).utf8)
    try external.write(to: sidecar)
    do {
      try await session.acceptRemovals(proposals, snapshot: snapshot)
      XCTFail("An external edit must refuse the whole group")
    } catch RemovalError.saveConflict {}
    await session.flushPendingSidecarWrite()
    XCTAssertEqual(try Data(contentsOf: sidecar), external)
    XCTAssertEqual(session.model, snapshot.model)
    XCTAssertTrue(session.undoHistory.isEmpty)
    await session.releaseTransientMemory()
  }

  func testEmptyGroupIsRefusedWithoutStartingPersistence() async throws {
    let session = try stage()
    do {
      try await session.acceptRemovals([], snapshot: session.removalAuthoringSnapshot())
      XCTFail("An empty group has no accepted transaction")
    } catch { XCTAssertTrue(error is RemovalError) }
    XCTAssertFalse(session.isSavingRemoval)
    XCTAssertTrue(session.undoHistory.isEmpty)
    await session.releaseTransientMemory()
  }

  func testSeparatedPeopleHaveValidIndividualWindowsWhenUnionExceedsModelExtent() throws {
    let source: [String: Any] = [
      "width": 4096, "height": 2048,
      "original": try RemovalBridge.digest(Data("source".utf8)),
      "decode": try RemovalBridge.digest(Data("decode".utf8)),
    ]
    let json = String(decoding: try JSONSerialization.data(withJSONObject: source), as: UTF8.self)
    let masks = try [0.1, 0.9].map { x in
      try RemovalBridge.selection(
        width: 4096, height: 2048,
        request:
          "{\"schema\":1,\"strokes\":[{\"subtract\":false,\"radius\":0.02,\"points\":[[\(x),0.5]]}]}"
      )
    }
    for mask in masks {
      let plan = try NativeRemovalGeneration.plan(
        source: json, intent: mask,
        holeRadius: 1, fringeRadius: 1)
      let object = try XCTUnwrap(
        JSONSerialization.jsonObject(with: Data(plan.utf8)) as? [String: Any])
      let window = try XCTUnwrap(object["window"] as? [String: Int])
      XCTAssertLessThanOrEqual(
        try XCTUnwrap(window["width"]), 2048)
      XCTAssertLessThanOrEqual(
        try XCTUnwrap(window["height"]), 2048)
    }
    let union = try RemovalBridge.combineMasks(masks[0], masks[1])
    XCTAssertThrowsError(
      try NativeRemovalGeneration.plan(
        source: json, intent: union,
        holeRadius: 1, fringeRadius: 1))
  }
}
