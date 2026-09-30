import Foundation
import XCTest

@testable import MapleCore

final class RemovalSmartBridgeTests: XCTestCase {
  private let strokes = """
    [{"points":[[0.5,0.5]],"radius":0.025,"subtract":false},
    {"points":[[0.7,0.5]],"radius":0.025,"subtract":true}]
    """

  func testRealNativeBridgePreservesBothPromptLabelsAndExactPaintFootprint() throws {
    let request = """
      {"schema":1,"source_width":100,"source_height":100,
      "window":{"x":0,"y":0,"width":100,"height":100},
      "input_width":100,"input_height":100,"strokes":\(strokes)}
      """
    let prepared = try RemovalBridge.smartStrokes(request: request)
    let json =
      try JSONSerialization.jsonObject(
        with: Data(RemovalBridge.smartPrompts(request: prepared).utf8)) as! [String: Any]
    XCTAssertEqual((json["labels"] as! [NSNumber]).map(\.intValue), [1, 0, -1])
    var logits = [Float](repeating: -1, count: 4 * 1024 * 1024)
    logits[50 * 1024 + 50] = 1
    let actual = try RemovalBridge.smartMask(
      request: prepared, logits: logits, scores: [0.9, 0.1, 0.2, 0.3])
    let paint = try RemovalBridge.selection(
      width: 100, height: 100, request: "{\"schema\":1,\"strokes\":\(strokes)}")
    XCTAssertEqual(actual, paint)
  }

  func testInvalidModelOutputAndNulRequestThrowThroughRealRustBoundary() throws {
    let request = """
      {"schema":1,"source_width":100,"source_height":100,
      "window":{"x":0,"y":0,"width":100,"height":100},
      "input_width":100,"input_height":100,"strokes":\(strokes)}
      """
    let prepared = try RemovalBridge.smartStrokes(request: request)
    XCTAssertThrowsError(try RemovalBridge.smartMask(request: prepared, logits: [1], scores: [1]))
    XCTAssertThrowsError(try RemovalBridge.smartPrompts(request: "\u{0}"))
    let logits = [Float](repeating: 1, count: 4 * 1024 * 1024)
    XCTAssertThrowsError(
      try RemovalBridge.smartMask(request: prepared, logits: logits, scores: [0.9, 0.8, 0.7, .nan]))
    // All candidates cover the negative prompt; they must not replace selection.
    XCTAssertThrowsError(
      try RemovalBridge.smartMask(request: prepared, logits: logits, scores: [0.9, 0.8, 0.7, 0.6]))
  }
}
