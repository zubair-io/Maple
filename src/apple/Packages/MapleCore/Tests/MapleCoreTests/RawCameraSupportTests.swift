import Foundation
import XCTest

@testable import MapleCore

final class RawCameraSupportTests: XCTestCase {
  func testMalformedOrUnknownBoundaryDoesNotInventSupport() {
    XCTAssertNil(RawCameraSupport(json: "not JSON"))
    XCTAssertNil(RawCameraSupport(json: #"{"cameraKey":"New camera","resolution":"future"}"#))
    XCTAssertNil(RawCameraSupport(json: #"{"resolution":"bundle_confident"}"#))
  }

  func testDecodeOnlyExplainsTheActualFileEvenForAKnownBody() throws {
    let body = try XCTUnwrap(CameraSupportRegistry.fixturedBodies.first)
    let json = "{\"cameraKey\":\"\(body.key)\",\"resolution\":\"rawler_fallback\"}"
    let support = try XCTUnwrap(RawCameraSupport(json: json))
    XCTAssertEqual(support.cameraKey, body.key)
    XCTAssertEqual(support.tier, .decodeOnly)
    XCTAssertEqual(support.tier.explanation, CameraTier.decodeOnly.explanation)
  }

  func testSuccessfulFileIsNotDowngradedByADifferentUnsupportedFixture() {
    for body in CameraSupportRegistry.fixturedBodies {
      XCTAssertGreaterThanOrEqual(
        CameraSupportRegistry.tier(forKey: body.key, resolution: .bundleConfident), .profiled)
    }
  }

  func testFileAndBytesRenderExportTheActualProfileResolution() throws {
    let repo = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent()
    for name in ["test_0004.fff", "test_0017.dng"] {
      let url = repo.appendingPathComponent("test-fixtures/raws/\(name)")
      guard FileManager.default.fileExists(atPath: url.path) else {
        throw XCTSkip("RAW fixture missing: \(url.path)")
      }
      let declared = try XCTUnwrap(
        CameraSupportRegistry.fixturedBodies.first { $0.fixture == name })
      let file = try PipelineRenderer.renderSceneLinearSized(
        rawPath: url, maxLongEdge: 64, profileOverride: .neutral)
      let bytes = try PipelineRenderer.renderSceneLinearSized(
        rawBytes: Data(contentsOf: url), hint: url.pathExtension, maxLongEdge: 64,
        profileOverride: .neutral)
      XCTAssertEqual(file.cameraSupport?.cameraKey, declared.key)
      XCTAssertEqual(file.cameraSupport?.resolution, declared.resolution)
      XCTAssertEqual(bytes.cameraSupport, file.cameraSupport)
      XCTAssertEqual(bytes.pixels, file.pixels)
    }
  }
}
