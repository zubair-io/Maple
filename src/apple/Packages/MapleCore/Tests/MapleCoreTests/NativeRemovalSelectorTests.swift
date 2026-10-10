import CoreGraphics
import Foundation
import ImageIO
import XCTest

@testable import MapleCore

final class NativeRemovalSelectorTests: XCTestCase {
  func testRemotePathsAndUnavailableModelsFailWithoutDownload() {
    let remote = URL(string: "https://example.com/models")!
    XCTAssertThrowsError(try NativeRemovalSelector.open(directory: remote))
    XCTAssertThrowsError(try NativeRemovalPersonDetector.open(directory: remote))
    let absent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    XCTAssertThrowsError(try NativeRemovalSelector.open(directory: absent, runtime: absent))
    XCTAssertThrowsError(try NativeRemovalPersonDetector.open(directory: absent, runtime: absent))
  }

  /// Local model/RAW-context diagnostic; missing weights skip visibly, and are
  /// not shipping/device/photographic qualification (#3941).
  func testActualNativeSelectionDetectionAndCancellationMatchReferences() throws {
    #if os(macOS)
      let root = (0..<7).reduce(URL(fileURLWithPath: #filePath)) { value, _ in
        value.deletingLastPathComponent()
      }
      .appendingPathComponent("test-fixtures/raws/removal-inference")
      let required =
        ExperimentalRemovalModels.all.map(\.file) + [
          "runtime.dylib",
          "selection-context.json", "selection-request.json", "selection-input.png",
          "selection-reference.mimf", "detection-input.f32", "detection-input.json",
          "detection-reference.json",
        ]
      guard
        required.allSatisfy({
          FileManager.default.fileExists(atPath: root.appendingPathComponent($0).path)
        })
      else { throw XCTSkip("Local native selection qualification corpus is not installed (#3941)") }
      let runtime = root.appendingPathComponent("runtime.dylib")
      let context = try XCTUnwrap(
        JSONSerialization.jsonObject(
          with: Data(contentsOf: root.appendingPathComponent("selection-context.json")))
          as? [String: Any])
      let anchor = try XCTUnwrap(context["source_anchor"] as? [String: Any])
      let source = String(
        decoding: try JSONSerialization.data(withJSONObject: anchor), as: UTF8.self)
      let request = try String(
        contentsOf: root.appendingPathComponent("selection-request.json"), encoding: .utf8)
      let rgb = try photographicCHW(root.appendingPathComponent("selection-input.png"))
      let model = try NativeRemovalSelector.open(directory: root, runtime: runtime)
      let operation = try model.operation()
      let embedding = try model.encode(
        source: source, request: request, rgb: rgb, operation: operation)
      let mask = try model.refine(
        source: source, request: request, embedding: embedding, operation: operation)
      XCTAssertEqual(
        mask, try Data(contentsOf: root.appendingPathComponent("selection-reference.mimf")))
      var stale = anchor
      stale["original"] = try RemovalBridge.digest(Data("changed original".utf8))
      let staleSource = String(
        decoding: try JSONSerialization.data(withJSONObject: stale), as: UTF8.self)
      XCTAssertThrowsError(
        try model.refine(
          source: staleSource, request: request, embedding: embedding, operation: operation))
      XCTAssertThrowsError(
        try model.encode(source: source, request: request, rgb: [], operation: operation))
      var nonfinite = rgb
      nonfinite[0] = .nan
      XCTAssertThrowsError(
        try model.encode(source: source, request: request, rgb: nonfinite, operation: operation))
      let cancelled = try model.operation()
      cancelled.cancel()
      XCTAssertThrowsError(
        try model.encode(source: source, request: request, rgb: rgb, operation: cancelled)
      ) {
        self.assertCancelled($0)
      }
      XCTAssertThrowsError(
        try model.refine(
          source: source, request: request, embedding: embedding, operation: cancelled)
      ) {
        self.assertCancelled($0)
      }

      let detector = try NativeRemovalPersonDetector.open(directory: root, runtime: runtime)
      let detectionOperation = try detector.operation()
      let detectionRGB = try floats(root.appendingPathComponent("detection-input.f32"))
      let metadata = try XCTUnwrap(
        JSONSerialization.jsonObject(
          with: Data(contentsOf: root.appendingPathComponent("detection-input.json")))
          as? [String: Any])
      let size = try XCTUnwrap(metadata["size"] as? [UInt32])
      XCTAssertEqual(size.count, 2)
      let actual = try detector.detect(
        rgb: detectionRGB, sourceWidth: size[0], sourceHeight: size[1],
        operation: detectionOperation)
      let expected = try JSONDecoder().decode(
        [NativeRemovalDetection].self,
        from: Data(contentsOf: root.appendingPathComponent("detection-reference.json")))
      XCTAssertEqual(actual.count, 300)
      XCTAssertEqual(actual.map(\.class), expected.map(\.class))
      XCTAssertEqual(actual.map(\.bounds), expected.map(\.bounds))
      XCTAssertEqual(actual.map(\.score), expected.map(\.score))
      let suggestions = try RemovalBridge.peopleSuggestions(
        actual, width: size[0], height: size[1])
      let referenceSuggestions = try RemovalBridge.peopleSuggestions(
        expected, width: size[0], height: size[1])
      XCTAssertEqual(suggestions.count, 9)
      XCTAssertEqual(suggestions.map(\.role), referenceSuggestions.map(\.role))
      XCTAssertEqual(suggestions.map(\.keep), referenceSuggestions.map(\.keep))
      XCTAssertTrue(suggestions.filter { $0.role != .background }.allSatisfy(\.keep))
      print("Actual market detector role suggestions: \(suggestions.map { $0.role.rawValue })")

      XCTAssertThrowsError(
        try model.encode(source: source, request: request, rgb: rgb, operation: detectionOperation))
      detectionOperation.cancel()
      XCTAssertThrowsError(
        try detector.detect(
          rgb: detectionRGB, sourceWidth: size[0], sourceHeight: size[1],
          operation: detectionOperation)
      ) {
        self.assertCancelled($0)
      }
    #else
      throw XCTSkip("Static iOS selection execution requires device qualification (#3941)")
    #endif
  }

  @MainActor
  func testAutomaticDetectionRetainsPreviousSelectionWhenSegmentationModelIsMissing() async throws {
    #if os(macOS)
      let repository = (0..<7).reduce(URL(fileURLWithPath: #filePath)) { value, _ in
        value.deletingLastPathComponent()
      }
      let models = repository.appendingPathComponent("test-fixtures/raws/removal-inference")
      let fixture = repository.appendingPathComponent("test-fixtures/raws/test_0002.dng")
      guard FileManager.default.fileExists(atPath: fixture.path),
        ["rtdetrv2-r18.onnx", "runtime.dylib"].allSatisfy({
          FileManager.default.fileExists(atPath: models.appendingPathComponent($0).path)
        })
      else { throw XCTSkip("Actual photographic RAW and pinned detector are required (#3941)") }
      let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: root) }
      let raw = root.appendingPathComponent("photo.dng")
      try FileManager.default.copyItem(at: fixture, to: raw)
      for name in ["rtdetrv2-r18.onnx", "runtime.dylib"] {
        try FileManager.default.copyItem(
          at: models.appendingPathComponent(name), to: root.appendingPathComponent(name))
      }
      let session = EditSession(asset: AssetRef(url: raw))
      let removal = RemovalSession(
        session: session,
        modelStore: MacRemovalModelStore(root: root.appendingPathComponent("installed")))
      await removal.open()
      XCTAssertEqual(removal.phase, .ready, removal.message)
      // Exercise the inference failure boundary directly. The user import
      // now refuses an incomplete model set before it reaches this boundary.
      await removal.setMode(.people)
      await removal.chooseModelFolder(models)
      XCTAssertEqual(removal.phase, .ready, removal.message)
      XCTAssertNotNil(removal.modelFolderName, removal.message)
      try await removal.engine.setModelDirectory(root)
      let previous = try RemovalBridge.selection(
        width: 7216, height: 5412,
        request: #"{"schema":1,"strokes":[{"points":[[0.4,0.5]],"radius":0.001,"subtract":false}]}"#
      )
      removal.selection = previous
      removal.protection = previous
      removal.personMasks = [previous]
      removal.people = [
        RemovalSession.Person(
          id: 1,
          detection: NativeRemovalDetection(class: 0, bounds: [10, 10, 100, 200], score: 0.9),
          keep: false)
      ]
      let original = try RemovalBridge.digest(Data(contentsOf: raw))
      await removal.findPeople()
      XCTAssertEqual(removal.phase, .failed)
      XCTAssertTrue(removal.message.contains("mobile-sam-encoder"), removal.message)
      XCTAssertEqual(removal.selection, previous)
      XCTAssertEqual(removal.protection, previous)
      XCTAssertEqual(removal.personMasks, [previous])
      XCTAssertEqual(removal.people.first?.detection.bounds, [10, 10, 100, 200])
      XCTAssertEqual(try RemovalBridge.digest(Data(contentsOf: raw)), original)
      XCTAssertFalse(
        FileManager.default.fileExists(atPath: root.appendingPathComponent("photo.xmp").path))
      XCTAssertFalse(
        FileManager.default.fileExists(atPath: root.appendingPathComponent(".maple/inpaint").path))
      removal.close()
      await session.releaseTransientMemory()
    #else
      throw XCTSkip("Actual detector failure-path qualification requires macOS (#3941)")
    #endif
  }

  @MainActor
  func testPeopleTabDetectsAfterImportAndExplicitSelectionAfterReopen() async throws {
    #if os(macOS)
      let repository = (0..<7).reduce(URL(fileURLWithPath: #filePath)) {
        value, _ in value.deletingLastPathComponent()
      }
      let fixture = repository.appendingPathComponent(
        "test-fixtures/raws/removal-photographic/portrait.dng")
      let models = repository.appendingPathComponent("test-fixtures/raws/removal-inference")
      let requiredModels = ExperimentalRemovalModels.all.map(\.file) + ["runtime.dylib"]
      guard FileManager.default.fileExists(atPath: fixture.path),
        requiredModels.allSatisfy({
          FileManager.default.fileExists(atPath: models.appendingPathComponent($0).path)
        })
      else { throw XCTSkip("Actual photographic RAW and local models are required (#3941)") }
      let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: root) }
      let raw = root.appendingPathComponent("photo.dng")
      try FileManager.default.copyItem(at: fixture, to: raw)
      let original = try RemovalBridge.digest(Data(contentsOf: raw))
      let session = EditSession(asset: AssetRef(url: raw))
      let removal = RemovalSession(
        session: session,
        modelStore: MacRemovalModelStore(root: root.appendingPathComponent("models")))
      await removal.open()
      await removal.setMode(.people)
      XCTAssertEqual(removal.phase, .ready)
      XCTAssertTrue(removal.message.contains("Import local AI models"))
      await removal.chooseModelFolder(models)
      XCTAssertEqual(removal.phase, .ready, removal.message)
      XCTAssertNotNil(removal.modelFolderName, removal.message)
      XCTAssertFalse(removal.people.isEmpty, "The real portrait must produce a detected person")
      XCTAssertEqual(removal.detectedPersonMasks.count, removal.people.count)
      XCTAssertTrue(removal.people.filter { $0.role == .subject }.allSatisfy(\.keep))
      XCTAssertTrue(removal.people.filter { $0.role == .background }.allSatisfy { !$0.keep })
      let bounds = removal.people.map { $0.detection.bounds }
      await removal.open()
      XCTAssertEqual(removal.phase, .ready, removal.message)
      XCTAssertEqual(removal.mode, .paint)
      XCTAssertTrue(removal.people.isEmpty, "Opening the removal tool must not auto-run People")
      await removal.setMode(.people)
      XCTAssertEqual(removal.phase, .ready, removal.message)
      XCTAssertEqual(removal.people.map { $0.detection.bounds }, bounds)
      XCTAssertEqual(removal.detectedPersonMasks.count, removal.people.count)
      removal.close()
      XCTAssertTrue(removal.detectedPersonMasks.isEmpty)
      XCTAssertEqual(try RemovalBridge.digest(Data(contentsOf: raw)), original)
      XCTAssertFalse(
        FileManager.default.fileExists(atPath: root.appendingPathComponent("photo.xmp").path))
      await session.releaseTransientMemory()
    #else
      throw XCTSkip("Actual Mac photographic automatic detection gate (#3941)")
    #endif
  }

  private func assertCancelled(_ error: Error) {
    guard case PipelineError.cancelled = error else {
      return XCTFail("Expected cancellation, got \(error)")
    }
  }

  private func photographicCHW(_ url: URL) throws -> [Float] {
    let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
    let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
    XCTAssertEqual(image.width, 1024)
    XCTAssertEqual(image.height, 1024)
    // Decode directly, without an extra host colour conversion. The fixture is
    // photographic RGB8 already; its model input must match the Rust decoder.
    XCTAssertEqual(image.bitsPerComponent, 8)
    let bytesPerPixel = image.bitsPerPixel / 8
    XCTAssertTrue(bytesPerPixel == 3 || bytesPerPixel == 4)
    let data = try XCTUnwrap(image.dataProvider?.data) as Data
    return (0..<3).flatMap { channel in
      (0..<image.height).flatMap { row in
        (0..<image.width).map { column in
          Float(data[row * image.bytesPerRow + column * bytesPerPixel + channel])
        }
      }
    }
  }

  private func floats(_ url: URL) throws -> [Float] {
    let data = try Data(contentsOf: url)
    guard data.count % 4 == 0 else { throw RemovalError.invalid("Invalid float fixture length") }
    return data.withUnsafeBytes { bytes in
      stride(from: 0, to: data.count, by: 4).map {
        Float(
          bitPattern: UInt32(littleEndian: bytes.loadUnaligned(fromByteOffset: $0, as: UInt32.self))
        )
      }
    }
  }
}
