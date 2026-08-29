// RatingFlagsRowTests.swift — unit tests for the `CullFlag` ↔
// `MuiRatingFlagState` mapping in `Maple/Views/InfoPanel/RatingFlagsRow.swift`
// (Maple UI adoption epic #3019, wave MA3). The row itself is a thin
// adapter around MapleUI's `MuiRatingFlags`; this file locks down the one
// piece of real logic left at the app-target layer — translating between
// the app's `CullFlag` (XMP-facing) and the design system's
// `MuiRatingFlagState`.

import MapleCore
import MapleUI
import XCTest

@testable import Maple_Exposure

final class RatingFlagsRowTests: XCTestCase {
  func testMuiFlagMapsEachCullFlagCaseDirectly() {
    XCTAssertEqual(RatingFlagsRow.muiFlag(for: .none), .none)
    XCTAssertEqual(RatingFlagsRow.muiFlag(for: .pick), .pick)
    XCTAssertEqual(RatingFlagsRow.muiFlag(for: .reject), .reject)
  }

  func testCullFlagMapsEachMuiStateDirectly() {
    XCTAssertEqual(RatingFlagsRow.cullFlag(for: .none), .none)
    XCTAssertEqual(RatingFlagsRow.cullFlag(for: .pick), .pick)
    XCTAssertEqual(RatingFlagsRow.cullFlag(for: .reject), .reject)
  }

  func testMappingRoundTripsForEveryCullFlagCase() {
    for flag: CullFlag in [.none, .pick, .reject] {
      XCTAssertEqual(RatingFlagsRow.cullFlag(for: RatingFlagsRow.muiFlag(for: flag)), flag)
    }
  }
}
