import Foundation
import XCTest

@testable import MapleCore

final class RemovalPeopleBridgeTests: XCTestCase {
  private func detection(_ bounds: [Float], _ score: Float) -> NativeRemovalDetection {
    NativeRemovalDetection(class: 0, bounds: bounds, score: score)
  }
  func testSharedDefaultsProtectSubjectsAndUncertaintyAndSuggestSeparatedPeople() throws {
    let people = try RemovalBridge.peopleSuggestions(
      [
        detection([0, 0, 300, 900], 0.98), detection([600, 200, 650, 400], 0.92),
        detection([800, 200, 850, 400], 0.6),
      ], width: 1000, height: 1000)
    XCTAssertEqual(people.map(\.role), [.subject, .background, .uncertain])
    XCTAssertEqual(people.map(\.keep), [true, false, true])
    XCTAssertEqual(
      people.map { $0.role.label }, ["Likely subject", "Suggested background", "Uncertain"])
  }
  func testSoloPortraitAndOverlappingPeopleRemainKeptAndDuplicatesCollapse() throws {
    let people = try RemovalBridge.peopleSuggestions(
      [
        detection([0, 0, 300, 900], 0.98), detection([1, 1, 301, 901], 0.97),
        detection([250, 400, 350, 600], 0.92),
      ], width: 1000, height: 1000)
    XCTAssertEqual(people.count, 2)
    XCTAssertTrue(people.allSatisfy(\.keep))
    XCTAssertEqual(people.map(\.role), [.subject, .uncertain])
    let portrait = try RemovalBridge.peopleSuggestions(
      [detection([600, 100, 990, 950], 0.99)], width: 1000, height: 1000)
    XCTAssertTrue(try XCTUnwrap(portrait.first).keep)
  }
  func testEmptyDetectionIsNotFailureAndMalformedOutputFails() throws {
    XCTAssertTrue(try RemovalBridge.peopleSuggestions([], width: 1000, height: 1000).isEmpty)
    XCTAssertThrowsError(try RemovalBridge.peopleSuggestions([], width: 0, height: 1000))
    XCTAssertThrowsError(
      try RemovalBridge.peopleSuggestions([detection([0, 0, 20], 0.9)], width: 1000, height: 1000))
    XCTAssertThrowsError(
      try RemovalBridge.peopleSuggestions(
        [detection([0, 0, 20, 20], .nan)], width: 1000, height: 1000))
  }
}
