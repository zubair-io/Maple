// #3984: actual separated Paint gestures, native inference and one durable edit.
// Small architectural regions verify workflow, not complete people or fill quality.
import Foundation
import XCTest

@testable import MapleCore

@MainActor
final class PhotographicRemovalPaintTests: XCTestCase {
  func testSeparatedPaintRunsActualModelsAndSavesAsOneUndoableEdit() async throws {
    #if os(macOS)
      let repository = (0..<7).reduce(URL(fileURLWithPath: #filePath)) {
        value, _ in value.deletingLastPathComponent()
      }
      let fixture = repository.appendingPathComponent(
        "test-fixtures/raws/removal-photographic/bologna.nef")
      let models = repository.appendingPathComponent("test-fixtures/raws/removal-inference")
      guard FileManager.default.fileExists(atPath: fixture.path),
        (ExperimentalRemovalModels.all.map(\.file) + ["runtime.dylib"]).allSatisfy({
          FileManager.default.fileExists(atPath: models.appendingPathComponent($0).path)
        })
      else { throw XCTSkip("Exact Bologna RAW and pinned native model corpus required (#3984)") }
      let original = try Data(contentsOf: fixture)
      XCTAssertEqual(
        try RemovalBridge.digest(original),
        "blake3:2019a5cbd7bcdcf8405528789cde7c05ed4bee8d31c533df786be64f42c97718")
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
        UUID().uuidString)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: directory) }
      let raw = directory.appendingPathComponent("photo.nef")
      try original.write(to: raw)
      let session = EditSession(asset: AssetRef(url: raw))
      let removal = RemovalSession(
        session: session,
        modelStore: MacRemovalModelStore(root: directory.appendingPathComponent("models")))
      await removal.open()
      await removal.chooseModelFolder(models)
      XCTAssertEqual(removal.phase, .ready, removal.message)
      XCTAssertEqual(removal.mode, .paint)
      let context = try XCTUnwrap(removal.context)
      let sidecar = try XCTUnwrap(session.asset.sidecarURL)
      let engine = NativeRemovalEditorEngine()
      let before = try await engine.review(context)
      let known = try await context.saved.generationContext(
        xmp: context.xmp, x: 2984, y: 1984, width: 32, height: 32)
      removal.radius = 0.008
      await removal.paint([[0.1, 0.8], [0.5, 0.8]], cropInputSize: [6000, 4000])
      await removal.remove()
      XCTAssertEqual(removal.phase, .ready, removal.message)
      XCTAssertTrue(
        removal.message.contains("too large for the current removal model"), removal.message)
      XCTAssertTrue(removal.proposals.isEmpty)
      XCTAssertNil(removal.job, "Every Paint context must preflight before opening inference")
      XCTAssertFalse(FileManager.default.fileExists(atPath: sidecar.path))
      removal.clearSelection()
      removal.radius = 0.004
      await removal.paint([[0.5, 0.5]], cropInputSize: [6000, 4000])
      removal.protectSelection()
      let protection = removal.protection
      removal.radius = 0.008
      await removal.paint([[0.1, 0.15]], cropInputSize: [6000, 4000])
      await removal.paint([[0.9, 0.15]], cropInputSize: [6000, 4000])
      let intent = removal.selection
      XCTAssertThrowsError(
        try NativeRemovalGeneration.plan(
          source: context.source, intent: intent, holeRadius: ExperimentalRemovalModels.holeRadius,
          fringeRadius: ExperimentalRemovalModels.fringeRadius))
      await removal.undoSelection()
      XCTAssertNotEqual(removal.selection, intent)
      await removal.redoSelection()
      XCTAssertEqual(removal.selection, intent)
      await removal.remove()
      XCTAssertEqual(removal.phase, .review, removal.message)
      XCTAssertEqual(removal.proposals.count, 2)
      XCTAssertEqual(removal.protection, protection)
      let review = try XCTUnwrap(removal.preview)
      let proposals = removal.proposals
      XCTAssertFalse(FileManager.default.fileExists(atPath: sidecar.path))
      XCTAssertFalse(
        FileManager.default.fileExists(
          atPath: directory.appendingPathComponent(".maple/inpaint").path))
      await removal.keep()
      XCTAssertEqual(removal.phase, .ready, removal.message)
      let accepted = session.model
      let records = try XCTUnwrap(accepted.inpaintRemovals).json
      XCTAssertEqual(
        (try JSONSerialization.jsonObject(with: Data(records.utf8)) as? [Any])?.count, 2)
      XCTAssertEqual(session.undoHistory.count, 1)
      XCTAssertEqual(session.undoHistory[0].description, "Remove 2 objects")
      XCTAssertEqual(try XMPParser.parse(data: Data(contentsOf: sidecar)).0, accepted)
      let assets = try await LocalRemovalAssetStore(rawURL: raw).readAssets(records: records)
      XCTAssertEqual(assets.count, 4)
      let savedSidecar = try Data(contentsOf: sidecar)
      let firstSaved = try XCTUnwrap(removal.savedRemovals.first)
      await removal.replaceSavedRemoval(firstSaved.id)
      XCTAssertEqual(removal.phase, .ready, removal.message)
      await removal.paint([[0.9, 0.15]], cropInputSize: [6000, 4000])
      await removal.remove()
      XCTAssertEqual(removal.phase, .ready, removal.message)
      XCTAssertTrue(removal.message.contains("Replace a saved removal within one native context"))
      XCTAssertTrue(removal.proposals.isEmpty)
      XCTAssertNil(removal.job)
      XCTAssertEqual(session.model, accepted)
      XCTAssertEqual(try Data(contentsOf: sidecar), savedSidecar)
      await removal.cancelSavedReplacement()
      removal.close()
      let reopened = try await engine.prepare(raw: raw, model: accepted)
      let rendered = try await engine.review(reopened)
      XCTAssertEqual(rendered.bytes, review.bytes)
      let reopenedKnown = try await reopened.saved.generationContext(
        xmp: reopened.xmp, x: 2984, y: 1984, width: 32, height: 32)
      XCTAssertEqual(reopenedKnown, known)
      session.undo()
      await session.flushPendingSidecarWrite()
      XCTAssertNil(session.model.inpaintRemovals)
      session.redo()
      await session.flushPendingSidecarWrite()
      XCTAssertEqual(session.model, accepted)
      XCTAssertEqual(try Data(contentsOf: raw), original)
      let evidence = repository.appendingPathComponent(
        "test-fixtures/raws/removal-photographic/paint-runs/\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: evidence, withIntermediateDirectories: true)
      try intent.write(to: evidence.appendingPathComponent("paint-intent.mimf"))
      try protection.write(to: evidence.appendingPathComponent("paint-protection.mimf"))
      for (name, data) in assets { try data.write(to: evidence.appendingPathComponent(name)) }
      for (name, image) in [("before", before), ("review", review), ("reopened", rendered)] {
        try Data(image.bytes).write(to: evidence.appendingPathComponent("\(name).rgb8"))
      }
      let report: [String: Any] = [
        "source": try JSONSerialization.jsonObject(with: Data(context.source.utf8)),
        "paintIntentDigest": try RemovalBridge.digest(intent),
        "protectionDigest": try RemovalBridge.digest(protection),
        "requests": try proposals.map {
          try JSONSerialization.jsonObject(with: Data($0.request.utf8))
        },
        "reviewSize": [review.width, review.height],
        "reviewDigest": try RemovalBridge.digest(Data(review.bytes)),
        "reopenedDigest": try RemovalBridge.digest(Data(rendered.bytes)),
        "knownProtectedContextExact": true,
        "originalUnchanged": true, "undoSteps": session.undoHistory.count,
        "assets": try assets.mapValues { try RemovalBridge.digest($0) },
        "oversizedConnectedSelectionRefusedBeforeInference": true,
        "multiContextSavedReplacementRefusedBeforeInference": true,
        "releaseQualified": false,
        "scope":
          "Actual photographic RAW Paint gestures/protection/selection undo-redo, shared context grouping, two native pinned model jobs, temporary review, one durable Keep/XMP/four assets, edit undo-redo and exact reopening without model installation. Original bytes and distant protected native f32 context unchanged. Architectural selections are workflow evidence, not complete people, semantic ownership, fill quality or supported-device performance qualification.",
      ]
      try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        .write(to: evidence.appendingPathComponent("report.json"))
      print("PHOTOGRAPHIC_PAINT_EVIDENCE \(evidence.path)")
      await session.releaseTransientMemory()
    #else
      throw XCTSkip("macOS photographic Paint qualification")
    #endif
  }
}
