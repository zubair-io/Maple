import Foundation
import XCTest

@testable import MapleCore

final class RemovalGenerationBridgeTests: XCTestCase {
  func testRealBridgeKeepsIntentOpaqueAndRejectsProtectionOverlap() throws {
    let intent = try RemovalBridge.selection(
      width: 9, height: 9,
      request: """
        {"schema":1,"strokes":[{"points":[[0.5,0.5]],"radius":0.01,"subtract":false}]}
        """)
    let request = """
      {"schema":1,"window":{"x":0,"y":0,"width":9,"height":9},"hole_radius":3,"fringe_radius":2}
      """
    let planes = try RemovalBridge.generationMasks(request: request, intent: intent)
    XCTAssertEqual(planes.count, 162)
    XCTAssertEqual(planes[4 * 9 + 4], 1)
    XCTAssertEqual(planes[81 + 4 * 9 + 4], 1)
    XCTAssertEqual(planes[81 + 4 * 9 + 5], 0.5)
    XCTAssertEqual(planes[81 + 4 * 9 + 6], 0)
    XCTAssertThrowsError(
      try RemovalBridge.generationMasks(request: request, intent: intent, protected: intent))
    XCTAssertThrowsError(try RemovalBridge.generationMasks(request: request, intent: Data()))
    XCTAssertThrowsError(try RemovalBridge.generationMasks(request: "\u{0}", intent: intent))
  }
}
