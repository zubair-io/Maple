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
  // Optional model weights/runtime remain outside the repository.
  func testRealPinnedNativeModelInferenceAndCancellation() throws {
    #if os(macOS)
      let root = RemovalModelTestDirectory.current(filePath: #filePath)
      let required = ["lama-native-512.onnx", "runtime.dylib"]
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
      let side = model.nativeSide
      let plane = side * side
      let rgb = (0..<(3 * plane)).map { Float(($0 * 29) % 251) / 250 }
      var hole = [Float](repeating: 0, count: plane)
      for y in (side / 3)..<(side * 2 / 3) {
        for x in (side / 3)..<(side * 2 / 3) { hole[y * side + x] = 1 }
      }
      let actual = try model.generate(rgb: rgb, hole: hole, operation: operation)
      XCTAssertEqual(actual.count, 3 * plane)
      XCTAssertTrue(actual.allSatisfy(\.isFinite))
      XCTAssertTrue(actual.allSatisfy { (0...1).contains($0) })
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

}
