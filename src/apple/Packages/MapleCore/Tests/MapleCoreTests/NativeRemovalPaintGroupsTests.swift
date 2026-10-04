import Foundation
import XCTest

@testable import MapleCore

final class NativeRemovalPaintGroupsTests: XCTestCase {
  private func source(width: Int = 3000) throws -> String {
    let digest = try RemovalBridge.digest(Data("paint-group-source".utf8))
    return
      "{\"original\":\"\(digest)\",\"decode\":\"\(digest)\",\"width\":\(width),\"height\":2000}"
  }

  private func paint(_ strokes: [[[Double]]]) throws -> Data {
    let request: [String: Any] = [
      "schema": 1,
      "strokes": strokes.map {
        ["points": $0, "radius": 0.001, "subtract": false] as [String: Any]
      },
    ]
    return try RemovalBridge.selection(
      width: 3000, height: 2000,
      request: String(decoding: JSONSerialization.data(withJSONObject: request), as: UTF8.self))
  }

  private func selected(_ bytes: Data) throws -> Set<Int> {
    let mask = try RemovalBridge.decodeMask(bytes)
    return Set(
      mask.pixels.enumerated().compactMap { index, pixel in
        guard pixel == 255 else { return nil }
        let x = Int(mask.x) + index % Int(mask.width)
        let y = Int(mask.y) + index / Int(mask.width)
        return y * Int(mask.sourceWidth) + x
      })
  }

  func testDistantPaintUsesSharedContextsAndPreservesProtectedSubtractionExactly() throws {
    let painted = try paint([[[0.1, 0.5]], [[0.25, 0.5]], [[0.9, 0.5]]])
    let protection = try paint([[[0.25, 0.5]]])
    let intent = try RemovalBridge.combineMasks(painted, protection, subtract: true)
    let anchor = try source()
    XCTAssertThrowsError(
      try NativeRemovalGeneration.plan(
        source: anchor, intent: intent, holeRadius: 8, fringeRadius: 4))
    let groups = try NativeRemovalGeneration.paintIntents(
      source: anchor, intent: intent, holeRadius: 8, fringeRadius: 4)
    XCTAssertEqual(groups.count, 2)
    let first = try selected(groups[0])
    let second = try selected(groups[1])
    XCTAssertTrue(first.isDisjoint(with: second))
    XCTAssertEqual(first.union(second), try selected(intent))
    XCTAssertTrue(first.union(second).isDisjoint(with: try selected(protection)))
    for group in groups {
      let mask = try RemovalBridge.decodeMask(group)
      XCTAssertEqual([mask.sourceWidth, mask.sourceHeight], [3000, 2000])
      XCTAssertNoThrow(
        try NativeRemovalGeneration.plan(
          source: anchor, intent: group, holeRadius: 8, fringeRadius: 4))
    }
  }

  func testNearbyPaintRetainsTheOriginalMaskAndConnectedOversizeRefuses() throws {
    let small = try paint([[[0.1, 0.5]], [[0.25, 0.5]]])
    XCTAssertEqual(
      try NativeRemovalGeneration.paintIntents(
        source: source(), intent: small, holeRadius: 8, fringeRadius: 4), [small])
    let connected = try paint([[[0.1, 0.5], [0.9, 0.5]]])
    XCTAssertThrowsError(
      try NativeRemovalGeneration.paintIntents(
        source: source(), intent: connected, holeRadius: 8, fringeRadius: 4)
    ) { error in
      XCTAssertTrue(error.localizedDescription.contains("one connected painted area"))
    }
  }

  func testChangedSourceOrInvalidRadiiCannotProducePaintGroups() throws {
    let mask = try paint([[[0.1, 0.5]], [[0.9, 0.5]]])
    XCTAssertThrowsError(
      try NativeRemovalGeneration.paintIntents(
        source: source(width: 3001), intent: mask, holeRadius: 8, fringeRadius: 4))
    XCTAssertThrowsError(
      try NativeRemovalGeneration.paintIntents(
        source: source(), intent: mask, holeRadius: 8, fringeRadius: .nan))
    XCTAssertThrowsError(
      try NativeRemovalGeneration.paintIntents(
        source: source(), intent: mask, holeRadius: 0, fringeRadius: 1))
  }
}
