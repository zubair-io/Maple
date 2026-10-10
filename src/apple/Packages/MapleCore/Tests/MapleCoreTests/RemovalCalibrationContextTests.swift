import Foundation
import XCTest

@testable import MapleCore

final class RemovalCalibrationContextTests: XCTestCase {
  func testNativeGestureMappingPreservesSurroundAndRejectsMalformedRequests() throws {
    let raw = try handle()
    let xmp = """
      <rdf:Description xmlns:rdf="x" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:PerspectiveX="100"/>
      """
    let request = "{\"schema\":1,\"points\":[[0.0,0.5],[0.8,0.5],[1.1,0.5]]}"
    let data = Data(
      try RemovalBridge.mapDisplayPoints(handle: raw, xmp: xmp, request: request).utf8)
    let mapped = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(mapped["source_size"] as? [Int], [16, 8])
    let points = try XCTUnwrap(mapped["points"] as? [Any])
    XCTAssertEqual(points.count, 3)
    XCTAssertTrue(points[0] is NSNull)
    XCTAssertTrue(points[2] is NSNull)
    let middle = try XCTUnwrap(points[1] as? [Double])
    XCTAssertEqual(middle[0], 0.3, accuracy: 1e-7)
    XCTAssertEqual(middle[1], 0.5)
    XCTAssertThrowsError(
      try RemovalBridge.mapDisplayPoints(
        handle: raw, xmp: xmp,
        request: "{\"schema\":2,\"points\":[]}"))
    XCTAssertThrowsError(
      try RemovalBridge.mapDisplayPoints(handle: raw, xmp: xmp + "\0", request: request))
    let cropped = """
      <rdf:Description xmlns:rdf="x" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:HasCrop="True" crs:CropLeft="0.25" crs:CropRight="0.75" crs:CropTop="0" crs:CropBottom="1" crs:CropAngle="90"/>
      """
    let cropRequest = "{\"schema\":1,\"crop_input_size\":[16,8],\"points\":[[0.5,0.25]]}"
    let cropData = Data(
      try RemovalBridge.mapDisplayPoints(handle: raw, xmp: cropped, request: cropRequest).utf8)
    let cropMap = try XCTUnwrap(JSONSerialization.jsonObject(with: cropData) as? [String: Any])
    XCTAssertEqual(cropMap["points"] as? [[Double]], [[0.375, 0.5]])
  }

  private func handle() throws -> MapleRawHandle {
    let raw = try XCTUnwrap(
      Bundle.module.url(forResource: "source", withExtension: "dng", subdirectory: "removal"))
    return try PipelineRenderer.openRawHandle(rawPath: raw)
  }

  func testRetainedNativeContextsHaveStableSourceCoordinates() throws {
    let raw = try handle()
    let region = try RemovalBridge.calibrationContext(
      handle: raw, x: 1, y: 1, width: 7, height: 5)
    XCTAssertEqual(region.count, 7 * 5 * 3)
    XCTAssertTrue(region.allSatisfy(\.isFinite))
    let inner = try RemovalBridge.calibrationContext(
      handle: raw, x: 2, y: 2, width: 3, height: 2)
    let firstRow = Array(region[24..<33])
    let secondRow = Array(region[45..<54])
    let expected: [Float] = firstRow + secondRow
    let innerBits: [UInt32] = inner.map { $0.bitPattern }
    let expectedBits: [UInt32] = expected.map { $0.bitPattern }
    XCTAssertEqual(innerBits, expectedBits)
    XCTAssertEqual(
      try RemovalBridge.calibrationContext(handle: raw, x: 1, y: 1, width: 7, height: 5)
        .map(\.bitPattern), region.map(\.bitPattern))
  }

  func testSharedSourceAnchorUsesOpenedOriginalAndSurvivesContextRequests() throws {
    let raw = try handle()
    let before = try RemovalBridge.calibrationSource(handle: raw)
    let value = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(before.utf8)) as? [String: Any])
    XCTAssertEqual(value["width"] as? Int, 16)
    XCTAssertEqual(value["height"] as? Int, 8)
    let url = try XCTUnwrap(
      Bundle.module.url(forResource: "source", withExtension: "dng", subdirectory: "removal"))
    XCTAssertEqual(value["original"] as? String, try RemovalBridge.digest(Data(contentsOf: url)))
    _ = try RemovalBridge.calibrationContext(handle: raw, x: 1, y: 1, width: 7, height: 5)
    XCTAssertEqual(try RemovalBridge.calibrationSource(handle: raw), before)
  }

  func testInvalidGeometryAndCancellationCannotPublishPixels() throws {
    let raw = try handle()
    for (x, width, height): (UInt32, UInt32, UInt32) in [
      (0, 0, 1), (0, 1, 0), (0, 2049, 1), (.max, 1, 1), (15, 2, 1),
    ] {
      XCTAssertThrowsError(
        try RemovalBridge.calibrationContext(handle: raw, x: x, y: 0, width: width, height: height))
    }
    let cancel = CancelFlag()
    cancel.requestCancel()
    XCTAssertThrowsError(
      try RemovalBridge.calibrationContext(
        handle: raw, x: 1, y: 1, width: 7, height: 5, cancel: cancel)
    ) { error in
      guard case PipelineError.cancelled = error else {
        return XCTFail("Expected cancellation, got \(error)")
      }
    }
    XCTAssertEqual(
      try RemovalBridge.calibrationContext(handle: raw, x: 1, y: 1, width: 7, height: 5).count, 105)
  }
}
