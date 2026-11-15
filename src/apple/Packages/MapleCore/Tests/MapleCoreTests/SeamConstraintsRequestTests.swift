import Foundation
import MapleCloudKit
import XCTest

final class SeamConstraintsRequestTests: XCTestCase {
  private let wire = """
    {"version":1,"canvas":{"width":2048,"height":1024},"regions":[
      {"frame":1,"kind":"include","x":100,"y":200,"width":80,"height":60},
      {"frame":2,"kind":"exclude","x":700,"y":300,"width":40,"height":50}
    ]}
    """

  private var request: SeamConstraintsRequest {
    .init(
      canvas: .init(width: 2048, height: 1024),
      regions: [
        .init(frame: 1, kind: .include, rect: .init(x: 100, y: 200, width: 80, height: 60)),
        .init(frame: 2, kind: .exclude, rect: .init(x: 700, y: 300, width: 40, height: 50)),
      ])
  }

  func testExactServerAndNativeWireShapeRoundTrips() throws {
    let decoded = try JSONDecoder().decode(SeamConstraintsRequest.self, from: Data(wire.utf8))
    XCTAssertEqual(decoded, request)
    XCTAssertEqual(decoded.version, 1)
    XCTAssertEqual(decoded.regions.map(\.kind.rawValue), ["include", "exclude"])
    let encoded = try XCTUnwrap(
      JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? NSDictionary)
    let expected = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(wire.utf8)) as? NSDictionary)
    XCTAssertEqual(encoded, expected)
    try decoded.validate(frameCount: 3)
  }

  func testEmptyRegionsAreValidAndKeepVersionAndCanvas() throws {
    let empty = SeamConstraintsRequest(canvas: .init(width: 1, height: 1), regions: [])
    try empty.validate(frameCount: 2)
    let roundTrip = try JSONDecoder().decode(
      SeamConstraintsRequest.self, from: JSONEncoder().encode(empty))
    XCTAssertEqual(roundTrip, empty)
    XCTAssertEqual(roundTrip.version, 1)
    XCTAssertEqual(roundTrip.canvas, .init(width: 1, height: 1))
  }

  func testRequiredFieldsUnknownKindsAndFractionalCoordinatesCannotDecode() {
    for invalid in [
      wire.replacingOccurrences(of: "\"version\":1,", with: ""),
      wire.replacingOccurrences(of: "\"kind\":\"include\"", with: "\"kind\":\"prefer\""),
      wire.replacingOccurrences(of: "\"x\":100", with: "\"x\":100.5"),
      wire.replacingOccurrences(of: "\"frame\":1,", with: ""),
    ] {
      XCTAssertThrowsError(
        try JSONDecoder().decode(SeamConstraintsRequest.self, from: Data(invalid.utf8)))
    }
  }

  func testVersionIsPreservedButUnsupportedVersionIsRejectedBeforeExecution() throws {
    var future = request
    future.version = 2
    let decoded = try JSONDecoder().decode(
      SeamConstraintsRequest.self, from: JSONEncoder().encode(future))
    XCTAssertEqual(decoded.version, 2)
    assertInvalid(decoded)
  }

  func testCanvasAndRectangleBoundsRejectNegativeZeroOverflowAndOutOfRangeValues() {
    for dimension in [-1, 0, Int(UInt32.max) + 1, Int.max] {
      var invalid = request
      invalid.canvas.width = dimension
      assertInvalid(invalid)
      invalid = request
      invalid.canvas.height = dimension
      assertInvalid(invalid)
    }
    let rectangles: [SeamConstraintsRequest.Rect] = [
      .init(x: -1, y: 0, width: 1, height: 1),
      .init(x: 0, y: -1, width: 1, height: 1),
      .init(x: 0, y: 0, width: 0, height: 1),
      .init(x: 0, y: 0, width: 1, height: 0),
      .init(x: 0, y: 0, width: -1, height: 1),
      .init(x: 0, y: 0, width: 1, height: -1),
      .init(x: 2048, y: 0, width: 1, height: 1),
      .init(x: 0, y: 1024, width: 1, height: 1),
      .init(x: 2047, y: 0, width: 2, height: 1),
      .init(x: 0, y: 1023, width: 1, height: 2),
      .init(x: Int.max, y: 0, width: Int.max, height: 1),
      .init(x: 0, y: 0, width: Int.max, height: 1),
    ]
    for rect in rectangles {
      var invalid = request
      invalid.regions[0].rect = rect
      assertInvalid(invalid)
    }
  }

  func testFrameIndicesReferToOriginalInputSet() {
    for index in [-1, 3, Int.max] {
      var invalid = request
      invalid.regions[0].frame = index
      assertInvalid(invalid)
    }
    XCTAssertThrowsError(try request.validate(frameCount: 0))
  }

  func testMaximumU32CanvasAndEdgeTouchingRectanglesAreValid() throws {
    let maximum = Int(UInt32.max)
    let edge = SeamConstraintsRequest(
      canvas: .init(width: maximum, height: maximum),
      regions: [
        .init(
          frame: 0, kind: .include, rect: .init(x: maximum - 1, y: maximum - 1, width: 1, height: 1)
        )
      ])
    try edge.validate(frameCount: 1)
  }

  func testContradictoryOwnershipIsRejectedButCompatibleOverlapsAreAllowed() throws {
    let rect = SeamConstraintsRequest.Rect(x: 10, y: 10, width: 20, height: 20)
    var overlap = SeamConstraintsRequest(
      canvas: .init(width: 100, height: 100),
      regions: [
        .init(frame: 0, kind: .include, rect: rect),
        .init(frame: 0, kind: .exclude, rect: rect),
      ])
    assertInvalid(overlap)
    overlap.regions[1] = .init(frame: 1, kind: .include, rect: rect)
    assertInvalid(overlap)
    overlap.regions[1] = .init(frame: 1, kind: .exclude, rect: rect)
    try overlap.validate(frameCount: 3)
    overlap.regions[1] = .init(frame: 0, kind: .include, rect: rect)
    try overlap.validate(frameCount: 3)
    overlap.regions[1] = .init(
      frame: 1, kind: .include, rect: .init(x: 30, y: 10, width: 20, height: 20))
    try overlap.validate(frameCount: 3)
  }

  private func assertInvalid(
    _ request: SeamConstraintsRequest, file: StaticString = #filePath, line: UInt = #line
  ) {
    XCTAssertThrowsError(try request.validate(frameCount: 3), file: file, line: line) { error in
      XCTAssertEqual(
        (error as? SeamConstraintsRequest.ValidationError)?.code,
        "invalid_seam_constraints", file: file, line: line)
      XCTAssertTrue(
        error.localizedDescription.hasPrefix("invalid_seam_constraints:"), file: file, line: line)
    }
  }
}
