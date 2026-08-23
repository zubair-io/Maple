import XCTest
@testable import MapleUI

final class MuiRatingFlagsTests: XCTestCase {
    func testTappingANewStarSetsTheRating() {
        XCTAssertEqual(MuiRatingFlags.nextRating(current: 2, tapped: 4), 4)
    }

    func testTappingTheCurrentTopStarClearsOneBelowIt() {
        XCTAssertEqual(MuiRatingFlags.nextRating(current: 3, tapped: 3), 2)
    }

    func testTappingTheFirstStarWhenAlreadyAtOneClearsToZero() {
        XCTAssertEqual(MuiRatingFlags.nextRating(current: 1, tapped: 1), 0)
    }

    func testFlagCyclesNonePickRejectNone() {
        XCTAssertEqual(MuiRatingFlagState.none.next, .pick)
        XCTAssertEqual(MuiRatingFlagState.pick.next, .reject)
        XCTAssertEqual(MuiRatingFlagState.reject.next, .none)
    }
}
