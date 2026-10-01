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
      let required = [
        "mobile-sam-encoder.onnx", "mobile-sam-decoder.onnx", "rtdetrv2-r18.onnx", "runtime.dylib",
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
