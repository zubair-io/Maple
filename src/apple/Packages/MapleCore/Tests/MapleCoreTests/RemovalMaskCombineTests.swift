import Foundation
import XCTest

@testable import MapleCore

final class RemovalMaskCombineTests: XCTestCase {
  private func paint(width: UInt32 = 100, x: Double) throws -> Data {
    try RemovalBridge.selection(
      width: width, height: 100,
      request:
        "{\"schema\":1,\"strokes\":[{\"points\":[[\(x),0.5]],\"radius\":0.1,\"subtract\":false}]}")
  }

  func testRealNativeMasksCombineAndProtectWithoutMutatingInputs() throws {
    let left = try paint(x: 0.3)
    let right = try paint(x: 0.7)
    let union = try RemovalBridge.combineMasks(left, right)
    let mask = try RemovalBridge.decodeMask(union)
    XCTAssertEqual(mask.sourceWidth, 100)
    XCTAssertEqual(mask.sourceHeight, 100)
    XCTAssertTrue(mask.x < 30 && mask.x + mask.width > 70)
    XCTAssertEqual(mask.pixels.count, Int(mask.width * mask.height))
    XCTAssertEqual(Set(mask.pixels), [0, 255])
    let protected = try RemovalBridge.combineMasks(union, right, subtract: true)
    let selected = try RemovalBridge.decodeMask(protected)
    func contains(_ x: UInt32, _ y: UInt32) -> Bool {
      guard x >= selected.x, y >= selected.y,
        x < selected.x + selected.width, y < selected.y + selected.height
      else { return false }
      return selected.pixels[Int((y - selected.y) * selected.width + x - selected.x)] == 255
    }
    XCTAssertTrue(contains(30, 50))
    XCTAssertFalse(contains(70, 50))
    XCTAssertEqual(try RemovalBridge.combineMasks(union, union, subtract: true), Data())
    XCTAssertEqual(try RemovalBridge.combineMasks(Data(), left), left)
    XCTAssertEqual(try RemovalBridge.combineMasks(Data(), left, subtract: true), Data())
    XCTAssertEqual(left, try paint(x: 0.3))
    XCTAssertEqual(right, try paint(x: 0.7))
  }

  func testDifferentSourceAndCorruptMasksCannotReplaceSelection() throws {
    let previous = try paint(x: 0.3)
    XCTAssertThrowsError(try RemovalBridge.combineMasks(previous, paint(width: 101, x: 0.7)))
    XCTAssertThrowsError(try RemovalBridge.combineMasks(previous, Data("bad mask".utf8)))
    XCTAssertThrowsError(try RemovalBridge.decodeMask(Data()))
    XCTAssertThrowsError(try RemovalBridge.decodeMask(Data("bad mask".utf8)))
    XCTAssertEqual(previous, try paint(x: 0.3))
  }
}
