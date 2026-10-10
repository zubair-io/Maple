// #3941: actual portrait RAW detector inputs and inverse box mapping.
// Detection proposals are not semantic ownership, closure or fill truth.
import Foundation
import RawPipeline
import XCTest

@testable import MapleCore

@MainActor
final class PhotographicRemovalOrientationTests: XCTestCase {
  func testPortraitDetectorSeesUprightPixelsAndReturnsNativeSourceBoxes() async throws {
    #if os(macOS)
      let repository = (0..<7).reduce(URL(fileURLWithPath: #filePath)) {
        value, _ in value.deletingLastPathComponent()
      }
      let fixture = repository.appendingPathComponent(
        "test-fixtures/raws/removal-photographic/night.nef")
      let models = repository.appendingPathComponent("test-fixtures/raws/removal-inference")
      guard FileManager.default.fileExists(atPath: fixture.path),
        (ExperimentalRemovalModels.all.map(\.file) + ["runtime.dylib"]).allSatisfy({
          FileManager.default.fileExists(atPath: models.appendingPathComponent($0).path)
        })
      else {
        throw XCTSkip("Exact portrait RAW and native pinned detector/runtime required (#3941)")
      }
      let original = try Data(contentsOf: fixture)
      XCTAssertEqual(
        try RemovalBridge.digest(original),
        "blake3:45f83349f8f98d19c2e60955201c2e8cd9bc08e435fec22079d8218395c02fa2")
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
        UUID().uuidString)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: directory) }
      let raw = directory.appendingPathComponent("photo.nef")
      try original.write(to: raw)
      let engine = NativeRemovalEditorEngine()
      let context = try await engine.prepare(raw: raw, model: AdjustmentModel())
      XCTAssertEqual([context.width, context.height], [4288, 2848])
      XCTAssertEqual(maple_raw_handle_orientation(context.handle.pointer), 8)
      let proxy = try await context.saved.selectionProxy(xmp: context.xmp)
      XCTAssertEqual(
        try RemovalBridge.digest(Data(proxy.bytes)),
        "blake3:9957b4eef08bcabc0074033c541a81123aced1c5eaabfebbcfda18ba70ae973d")
      // Replay the old source-framed detector path to prove the regression
      // against these exact pixels, not a mocked or portrait-shaped image.
      let legacy = try await Task.detached {
        let inputs = try NativeRemovalProxyTensors(
          proxy, width: context.width, height: context.height)
        let detector = try NativeRemovalPersonDetector.open(
          directory: models, runtime: models.appendingPathComponent("runtime.dylib"))
        return try detector.detect(
          rgb: inputs.detector, sourceWidth: context.width, sourceHeight: context.height,
          operation: detector.operation())
      }.value
      XCTAssertEqual(legacy.filter { $0.class == 0 && $0.score >= 0.5 }.count, 0)
      try await engine.setModelDirectory(models)
      let operation = try await engine.detectionOperation()
      let detected = try await engine.detect(context: context, operation: operation)
      XCTAssertEqual(detected.count, 300)
      let people = detected.filter { $0.class == 0 && $0.score >= 0.5 }
      XCTAssertEqual(people.count, 2)
      // Expected source boxes independently invert the actual upright ORT
      // output with EXIF8's edge equations: x=W-y, y=x. Provider drift stays
      // within two source pixels; native dimensions must never become display axes.
      let expected: [[Float]] = [
        [1511.4683, 1074.0692, 3338.2617, 1964.9292],
        [1518.8748, 480.64996, 2463.5001, 1390.2601],
      ]
      for (person, bounds) in zip(people, expected) {
        for (actual, reference) in zip(person.bounds, bounds) {
          XCTAssertEqual(actual, reference, accuracy: 2.0)
        }
      }
      let suggestions = try RemovalBridge.peopleSuggestions(
        detected, width: context.width, height: context.height)
      XCTAssertEqual(suggestions.count, 2)
      XCTAssertTrue(suggestions.allSatisfy(\.keep))
      XCTAssertEqual(suggestions.filter { $0.role == .subject }.count, 1)
      XCTAssertEqual(suggestions.filter { $0.role == .uncertain }.count, 1)
      // Also exercise tab-triggered detection and actual SAM masks in the
      // production session. Detector boxes and masks must share native axes.
      let session = EditSession(asset: AssetRef(url: raw))
      let removal = RemovalSession(
        session: session,
        modelStore: MacRemovalModelStore(root: directory.appendingPathComponent("models")))
      await removal.open()
      XCTAssertEqual(removal.phase, .ready, removal.message)
      await removal.setMode(.people)
      await removal.chooseModelFolder(models)
      XCTAssertEqual(removal.phase, .ready, removal.message)
      XCTAssertEqual(removal.people.count, 2)
      XCTAssertTrue(removal.people.allSatisfy(\.keep))
      XCTAssertEqual(removal.detectedPersonMasks.count, 2)
      let masks = removal.detectedPersonMasks
      for person in masks {
        let mask = try RemovalBridge.decodeMask(person.mask)
        XCTAssertEqual([mask.sourceWidth, mask.sourceHeight], [4288, 2848])
        XCTAssertTrue(mask.pixels.contains(255))
      }
      removal.close()
      operation.cancel()
      do {
        _ = try await engine.detect(context: context, operation: operation)
        XCTFail("Cancelled oriented detector must publish no result")
      } catch {}
      XCTAssertEqual(try Data(contentsOf: raw), original)
      XCTAssertFalse(
        FileManager.default.fileExists(atPath: directory.appendingPathComponent("photo.xmp").path))
      let evidence = repository.appendingPathComponent(
        "test-fixtures/raws/removal-photographic/orientation-runs/\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: evidence, withIntermediateDirectories: true)
      try proxy.bytes.write(to: evidence.appendingPathComponent("selection-proxy.rgb8"))
      for person in masks {
        try person.mask.write(to: evidence.appendingPathComponent("detected-\(person.id).mimf"))
      }
      let report: [String: Any] = [
        "source": try JSONSerialization.jsonObject(with: Data(context.source.utf8)),
        "orientation": 8, "legacyPeople": 0,
        "proxySize": [proxy.width, proxy.height],
        "detections": try JSONSerialization.jsonObject(with: JSONEncoder().encode(detected)),
        "uprightPeople": people.count, "proxyDigest": try RemovalBridge.digest(Data(proxy.bytes)),
        "sessionMasks": try masks.map {
          [
            "id": $0.id, "file": "detected-\($0.id).mimf",
            "digest": try RemovalBridge.digest($0.mask),
          ]
            as [String: Any]
        },
        "originalUnchanged": true, "sidecarWritten": false, "cancelledRunRejected": true,
        "releaseQualified": false,
        "scope":
          "Actual portrait RAW, production engine/Swift/C-FFI/deployed detector, upright model inputs/source box mapping, tab-triggered session detection and native SAM mask framing. No semantic proposal truth, complete silhouettes, accepted edits, fill quality or supported-device performance qualification.",
      ]
      try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        .write(to: evidence.appendingPathComponent("report.json"))
      print("PHOTOGRAPHIC_ORIENTATION_EVIDENCE \(evidence.path)")
    #else
      throw XCTSkip("macOS photographic detector orientation qualification")
    #endif
  }
}
