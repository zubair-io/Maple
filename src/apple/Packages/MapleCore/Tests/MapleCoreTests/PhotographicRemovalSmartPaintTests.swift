// #3984 / #3941: actual RAW Smart paint gestures, native selection and save.
import Foundation
import XCTest

@testable import MapleCore

@MainActor
final class PhotographicRemovalSmartPaintTests: XCTestCase {
  private let proxySize = [1024.0, 683.0]
  private let nativeSize: [UInt32] = [6000, 4000]

  private func gesture(_ point: [Double]) -> [[Double]] {
    [[(point[0] + 0.5) / proxySize[0], (point[1] + 0.5) / proxySize[1]]]
  }

  private func selected(_ mask: Data, at point: [Double]) throws -> Bool {
    guard !mask.isEmpty else { return false }
    let decoded = try RemovalBridge.decodeMask(mask)
    let x = Int((point[0] + 0.5) * Double(nativeSize[0]) / proxySize[0])
    let y = Int((point[1] + 0.5) * Double(nativeSize[1]) / proxySize[1])
    guard x >= Int(decoded.x), y >= Int(decoded.y),
      x < Int(decoded.x + decoded.width), y < Int(decoded.y + decoded.height)
    else { return false }
    return decoded.pixels[(y - Int(decoded.y)) * Int(decoded.width) + x - Int(decoded.x)] == 255
  }

  private func paint(_ point: [Double], removal: RemovalSession, subtract: Bool = false)
    async
  {
    removal.subtract = subtract
    await removal.paint(gesture(point), cropInputSize: nativeSize)
    XCTAssertEqual(removal.phase, .ready, removal.message)
  }

  func testActualSmartPaintAddsVisibleSleeveAndCarriedBag() async throws {
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
      else { throw XCTSkip("Exact Bologna RAW and pinned native models required (#3984)") }
      let original = try Data(contentsOf: fixture)
      XCTAssertEqual(
        try RemovalBridge.digest(original),
        "blake3:2019a5cbd7bcdcf8405528789cde7c05ed4bee8d31c533df786be64f42c97718")
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
        "removal-smart-boundary-\(UUID().uuidString)")
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
      let context = try XCTUnwrap(removal.context)
      removal.radius = 25.0 / Double(nativeSize[0])
      await paint([147, 386], removal: removal)
      removal.protectSelection()
      let protection = removal.protection
      await removal.setMode(.smart)
      let points: [[UInt32]] = [
        [2214, 1703], [1818, 2144], [1638, 2304],
        [1536, 2970], [2394, 2791], [2022, 3098],
      ]
      for (index, point) in points.enumerated() {
        let previous = removal.selection
        await removal.paint(
          [
            [
              (Double(point[0]) + 0.5) / Double(nativeSize[0]),
              (Double(point[1]) + 0.5) / Double(nativeSize[1]),
            ]
          ], cropInputSize: nativeSize)
        XCTAssertEqual(removal.phase, .ready, removal.message)
        if index == 3 {
          let addedBag = removal.selection
          await removal.undoSelection()
          XCTAssertEqual(removal.selection, previous)
          await removal.redoSelection()
          XCTAssertEqual(removal.selection, addedBag)
        }
      }
      await paint([147, 386], removal: removal, subtract: true)
      await paint([496, 330], removal: removal, subtract: true)
      let beforeNeighborNegative = removal.selection
      let priorStrokeCount = removal.strokes.count
      let priorGestureSizes = removal.gestureSizes
      let priorRedoCount = removal.redoGestures.count
      let neighbor: [UInt32] = [1728, 1664]
      let beforeNeighbor = try RemovalBridge.decodeMask(beforeNeighborNegative)
      let neighborPreviouslySelected =
        neighbor[0] >= beforeNeighbor.x && neighbor[1] >= beforeNeighbor.y
        && neighbor[0] < beforeNeighbor.x + beforeNeighbor.width
        && neighbor[1] < beforeNeighbor.y + beforeNeighbor.height
        && beforeNeighbor.pixels[
          Int(
            (neighbor[1] - beforeNeighbor.y) * beforeNeighbor.width + neighbor[0] - beforeNeighbor.x
          )
        ] == 255
      await removal.paint(
        [
          [
            (Double(neighbor[0]) + 0.5) / Double(nativeSize[0]),
            (Double(neighbor[1]) + 0.5) / Double(nativeSize[1]),
          ]
        ], cropInputSize: nativeSize)
      XCTAssertEqual(removal.phase, .ready, removal.message)
      XCTAssertTrue(removal.message.contains("could not follow all"), removal.message)
      let rejectedMessage = removal.message
      XCTAssertEqual(removal.selection, beforeNeighborNegative)
      XCTAssertEqual(removal.strokes.count, priorStrokeCount)
      XCTAssertEqual(removal.gestureSizes, priorGestureSizes)
      XCTAssertEqual(removal.redoGestures.count, priorRedoCount)
      XCTAssertEqual(removal.protection, protection)
      XCTAssertNil(removal.operation)

      // The model refusal cannot stand in for a successful correction. The
      // photographer explicitly freezes this selection and brushes the face out.
      removal.refineWithPaint()
      XCTAssertEqual(removal.mode, .paint)
      XCTAssertEqual(removal.selection, beforeNeighborNegative)
      XCTAssertFalse(removal.canUndoSelection)
      XCTAssertFalse(removal.canRedoSelection)
      await removal.paint(
        [
          [
            (Double(neighbor[0]) + 0.5) / Double(nativeSize[0]),
            (Double(neighbor[1]) + 0.5) / Double(nativeSize[1]),
          ]
        ], cropInputSize: nativeSize)
      XCTAssertEqual(removal.phase, .ready, removal.message)
      XCTAssertTrue(removal.message.isEmpty)
      let intent = removal.selection
      let decoded = try RemovalBridge.decodeMask(intent)
      let visibleSamples = points.map { point -> Bool in
        guard point[0] >= decoded.x, point[1] >= decoded.y,
          point[0] < decoded.x + decoded.width, point[1] < decoded.y + decoded.height
        else { return false }
        return decoded.pixels[
          Int((point[1] - decoded.y) * decoded.width + point[0] - decoded.x)] == 255
      }
      XCTAssertEqual(visibleSamples, Array(repeating: true, count: points.count))
      let neighborSelected =
        neighbor[0] >= decoded.x && neighbor[1] >= decoded.y
        && neighbor[0] < decoded.x + decoded.width && neighbor[1] < decoded.y + decoded.height
        && decoded.pixels[
          Int((neighbor[1] - decoded.y) * decoded.width + neighbor[0] - decoded.x)] == 255
      XCTAssertFalse(neighborSelected)
      XCTAssertFalse(try selected(intent, at: [147, 386]))
      XCTAssertFalse(try selected(intent, at: [496, 330]))
      XCTAssertEqual(removal.protection, protection)
      await removal.undoSelection()
      XCTAssertEqual(removal.selection, beforeNeighborNegative)
      await removal.redoSelection()
      XCTAssertEqual(removal.selection, intent)
      await removal.remove()
      XCTAssertEqual(removal.phase, .ready, removal.message)
      XCTAssertTrue(removal.message.contains("object is too large"), removal.message)
      XCTAssertNil(removal.job)
      XCTAssertTrue(removal.proposals.isEmpty)
      XCTAssertTrue(session.undoHistory.isEmpty)
      XCTAssertNil(session.model.inpaintRemovals)
      XCTAssertFalse(
        FileManager.default.fileExists(
          atPath: raw.deletingPathExtension().appendingPathExtension("xmp").path))
      XCTAssertEqual(try Data(contentsOf: raw), original)
      let evidence = repository.appendingPathComponent(
        "test-fixtures/raws/removal-photographic/boundary-runs/\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: evidence, withIntermediateDirectories: true)
      try intent.write(to: evidence.appendingPathComponent("intent.mimf"))
      try beforeNeighborNegative.write(to: evidence.appendingPathComponent("smart-intent.mimf"))
      try protection.write(to: evidence.appendingPathComponent("protection.mimf"))
      let report: [String: Any] = [
        "source": try JSONSerialization.jsonObject(with: Data(context.source.utf8)),
        "intentDigest": try RemovalBridge.digest(intent),
        "protectionDigest": try RemovalBridge.digest(protection),
        "nativeSamples": points, "visibleSamples": visibleSamples,
        "bagGestureUndoRedoExact": true, "originalUnchanged": true,
        "neighborSample": neighbor, "neighborPreviouslySelected": neighborPreviouslySelected,
        "smartNegativeRejectedMessage": rejectedMessage,
        "rejectedGesturePreservedSelectionAndHistory": true,
        "neighborSelectedAfterExplicitPaint": neighborSelected,
        "paintCorrectionUndoRedoExact": true,
        "largeRefusedBeforeInference": true, "sidecarWritten": false,
        "releaseQualified": false,
        "scope":
          "Actual native Smart paint recovers six observed interior sleeve/bag/body samples but leaks a neighboring face. A rejected negative preserves selection/history. Explicit Refine with Paint removes that face sample with exact undo/redo and retained protection. Sparse samples do not prove complete silhouette/ownership; large-object fill, UI, cross-host and supported-device qualification remain open (#3941/#3984).",
      ]
      try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        .write(to: evidence.appendingPathComponent("report.json"))
      print("PHOTOGRAPHIC_BOUNDARY_EVIDENCE \(evidence.path)")
      removal.close()
      await session.releaseTransientMemory()
    #else
      throw XCTSkip("macOS photographic Smart paint qualification")
    #endif
  }

  func testActualSmartPaintRefinesWholeSelectionAndCommitsOneNativeRemoval() async throws {
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
      else { throw XCTSkip("Exact Bologna RAW and pinned native models required (#3984)") }
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
      let context = try XCTUnwrap(removal.context)
      XCTAssertEqual([context.width, context.height], nativeSize)
      removal.radius = 0.002
      let protectedPoint = [620.0, 328.0]
      await paint(protectedPoint, removal: removal)
      removal.protectSelection()
      let protection = removal.protection
      XCTAssertTrue(try selected(protection, at: protectedPoint))
      await removal.setMode(.smart)

      // Head/body positives are explicit user gestures. Leg and nearby keeper
      // samples are diagnostic observations, not full silhouette/role truth.
      await paint([20, 381], removal: removal)
      await paint([37, 205], removal: removal)
      let beforeNegative = removal.selection
      await paint([147, 386], removal: removal, subtract: true)
      let large = removal.selection
      XCTAssertTrue(try selected(large, at: [20, 381]))
      XCTAssertTrue(try selected(large, at: [37, 205]))
      XCTAssertTrue(try selected(large, at: [59, 572]))
      XCTAssertFalse(try selected(large, at: [147, 386]))
      await removal.undoSelection()
      XCTAssertEqual(removal.selection, beforeNegative)
      await removal.redoSelection()
      XCTAssertEqual(removal.selection, large)
      await removal.remove()
      XCTAssertEqual(removal.phase, .ready, removal.message)
      XCTAssertTrue(removal.message.contains("object is too large"), removal.message)
      XCTAssertTrue(removal.message.contains("1024"), removal.message)
      let largeRefusedBeforeInference =
        removal.phase == .ready && removal.job == nil && removal.proposals.isEmpty
      XCTAssertNil(removal.job)
      XCTAssertTrue(removal.proposals.isEmpty)
      XCTAssertFalse(
        FileManager.default.fileExists(
          atPath: raw.deletingPathExtension().appendingPathExtension("xmp").path))

      removal.clearSelection()
      await paint([594, 310], removal: removal)
      await paint([579, 272], removal: removal)
      await paint([548, 292], removal: removal, subtract: true)
      let intent = removal.selection
      for point in [[579.0, 272.0], [594.0, 310.0], [582.0, 331.0]] {
        XCTAssertTrue(try selected(intent, at: point))
      }
      XCTAssertFalse(try selected(intent, at: [548, 292]))
      XCTAssertFalse(try selected(intent, at: protectedPoint))
      XCTAssertEqual(removal.protection, protection)
      await removal.remove()
      XCTAssertEqual(removal.phase, .review, removal.message)
      let preview = try XCTUnwrap(removal.preview)
      let proposals = removal.proposals
      XCTAssertEqual(proposals.count, 1)
      XCTAssertNil(session.model.inpaintRemovals)
      let sidecar = raw.deletingPathExtension().appendingPathExtension("xmp")
      XCTAssertFalse(FileManager.default.fileExists(atPath: sidecar.path))
      removal.compare = true
      XCTAssertEqual(removal.preview?.bytes, preview.bytes)
      removal.cancel()
      XCTAssertEqual(removal.selection, intent)
      XCTAssertEqual(removal.phase, .ready)
      XCTAssertFalse(FileManager.default.fileExists(atPath: sidecar.path))

      await removal.remove()
      XCTAssertEqual(removal.phase, .review, removal.message)
      let finalPreview = try XCTUnwrap(removal.preview)
      await removal.keep()
      XCTAssertEqual(removal.phase, .ready, removal.message)
      let accepted = session.model
      XCTAssertEqual(session.undoHistory.count, 1)
      let records = try XCTUnwrap(accepted.inpaintRemovals).json
      let assets = try await LocalRemovalAssetStore(rawURL: raw).readAssets(records: records)
      XCTAssertEqual(assets.count, 2)
      XCTAssertEqual(try XMPParser.parse(data: Data(contentsOf: sidecar)).0, accepted)
      removal.close()
      let engine = NativeRemovalEditorEngine()
      let reopened = try await engine.prepare(raw: raw, model: accepted)
      let rendered = try await engine.review(reopened)
      XCTAssertEqual(rendered.bytes, finalPreview.bytes)
      let originalContext = try await context.saved.generationContext(
        xmp: context.xmp, x: 3620, y: 1908, width: 32, height: 32)
      let savedContext = try await reopened.saved.generationContext(
        xmp: reopened.xmp, x: 3620, y: 1908, width: 32, height: 32)
      XCTAssertEqual(savedContext, originalContext)
      session.undo()
      await session.flushPendingSidecarWrite()
      XCTAssertNil(session.model.inpaintRemovals)
      session.redo()
      await session.flushPendingSidecarWrite()
      XCTAssertEqual(session.model, accepted)
      XCTAssertEqual(try Data(contentsOf: raw), original)

      let evidence = repository.appendingPathComponent(
        "test-fixtures/raws/removal-photographic/smart-runs/\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: evidence, withIntermediateDirectories: true)
      try large.write(to: evidence.appendingPathComponent("large-intent.mimf"))
      try intent.write(to: evidence.appendingPathComponent("smart-intent.mimf"))
      try protection.write(to: evidence.appendingPathComponent("smart-protection.mimf"))
      for (name, data) in assets { try data.write(to: evidence.appendingPathComponent(name)) }
      try Data(finalPreview.bytes).write(to: evidence.appendingPathComponent("review.rgb8"))
      let report: [String: Any] = [
        "source": try JSONSerialization.jsonObject(with: Data(context.source.utf8)),
        "largeIntentDigest": try RemovalBridge.digest(large),
        "smartIntentDigest": try RemovalBridge.digest(intent),
        "protectionDigest": try RemovalBridge.digest(protection),
        "reviewSize": [finalPreview.width, finalPreview.height],
        "reviewDigest": try RemovalBridge.digest(Data(finalPreview.bytes)),
        "reopenedDigest": try RemovalBridge.digest(Data(rendered.bytes)),
        "requests": try proposals.map {
          try JSONSerialization.jsonObject(with: Data($0.request.utf8))
        },
        "assets": try assets.mapValues { try RemovalBridge.digest($0) },
        "undoSteps": session.undoHistory.count, "originalUnchanged": true,
        "protectedNativeContextExact": true, "selectionUndoRedoExact": true,
        "cancelWroteSidecar": false, "largeRefusedBeforeInference": largeRefusedBeforeInference,
        "releaseQualified": false,
        "scope":
          "Actual photographic Smart paint Add/Subtract gestures, deployed native MobileSAM selection, held-out visible sample checks, temporary review/Compare/Cancel, native LaMa reconstruction, one Keep/XMP/two assets/undo and exact model-free reopening. No independent complete silhouettes, person ownership, photographic fill quality, live UI or supported-device performance qualification.",
      ]
      try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        .write(to: evidence.appendingPathComponent("report.json"))
      print("PHOTOGRAPHIC_SMART_EVIDENCE \(evidence.path)")
      await session.releaseTransientMemory()
    #else
      throw XCTSkip("macOS photographic Smart paint qualification")
    #endif
  }
}
