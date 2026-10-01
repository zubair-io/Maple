import Foundation
import XCTest

@testable import MapleCore

final class NativeRemovalReconstructorTests: XCTestCase {
  func testRejectsRemoteModelPathsAndUnavailableRuntime() throws {
    XCTAssertThrowsError(
      try NativeRemovalReconstructor.open(directory: URL(string: "https://example.com/models")!))
    let absent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    XCTAssertThrowsError(
      try NativeRemovalReconstructor.open(directory: absent, runtime: absent))
  }

  // Explicit local qualification corpus (#3941), never downloads during tests.
  // Optional model weights/runtime remain under the gitignored RAW fixture tree.
  func testRealNativeModelMatchesReferenceAndHonorsCancellation() throws {
    #if os(macOS)
      let root = (0..<7).reduce(URL(fileURLWithPath: #filePath)) { value, _ in
        value.deletingLastPathComponent()
      }.appendingPathComponent("test-fixtures/raws/removal-inference")
      let required = [
        "lama-native-1024.onnx", "runtime.dylib", "input.f32", "hole.f32", "result.f32",
      ]
      guard
        required.allSatisfy({
          FileManager.default.fileExists(atPath: root.appendingPathComponent($0).path)
        })
      else {
        throw XCTSkip("Local native removal qualification corpus is not installed (#3941)")
      }
      let model = try NativeRemovalReconstructor.open(
        directory: root, runtime: root.appendingPathComponent("runtime.dylib"))
      let operation = try model.operation()
      let rgb = try floats(root.appendingPathComponent("input.f32"))
      let hole = try floats(root.appendingPathComponent("hole.f32"))
      let reference = try floats(root.appendingPathComponent("result.f32"))
      let actual = try model.generate(rgb: rgb, hole: hole, operation: operation)
      XCTAssertEqual(actual.count, reference.count)
      XCTAssertTrue(actual.allSatisfy(\.isFinite))
      XCTAssertLessThanOrEqual(
        zip(actual, reference).map { abs($0 - $1) }.max() ?? .infinity, 1 / 255)
      let cancelled = try model.operation()
      cancelled.cancel()
      XCTAssertThrowsError(try model.generate(rgb: rgb, hole: hole, operation: cancelled)) {
        error in
        guard case PipelineError.cancelled = error else {
          return XCTFail("Expected cancellation, got \(error)")
        }
      }
      XCTAssertThrowsError(try model.generate(rgb: [], hole: hole, operation: operation))
      var nonfinite = rgb
      nonfinite[0] = .nan
      XCTAssertThrowsError(try model.generate(rgb: nonfinite, hole: hole, operation: operation))
      let concurrent = try model.operation()
      let started = DispatchSemaphore(value: 0)
      let finished = expectation(description: "Concurrent cancellation returns without publishing")
      DispatchQueue.global(qos: .userInitiated).async {
        started.signal()
        do {
          _ = try model.generate(rgb: rgb, hole: hole, operation: concurrent)
          XCTFail("Cancelled concurrent generation published pixels")
        } catch {
          guard case PipelineError.cancelled = error else {
            XCTFail("Expected concurrent cancellation, got \(error)")
            finished.fulfill()
            return
          }
        }
        finished.fulfill()
      }
      XCTAssertEqual(started.wait(timeout: .now() + 5), .success)
      Thread.sleep(forTimeInterval: 0.15)
      concurrent.cancel()
      wait(for: [finished], timeout: 5)

    #else
      throw XCTSkip("Static iOS execution requires device qualification (#3941)")
    #endif
  }

  private func floats(_ url: URL) throws -> [Float] {
    let data = try Data(contentsOf: url)
    guard data.count % 4 == 0 else { throw RemovalError.invalid("Invalid float fixture length") }
    return data.withUnsafeBytes { bytes in
      stride(from: 0, to: data.count, by: 4).map { offset in
        Float(
          bitPattern: UInt32(
            littleEndian: bytes.loadUnaligned(fromByteOffset: offset, as: UInt32.self)))
      }
    }
  }
}
