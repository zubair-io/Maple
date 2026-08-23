import XCTest
@testable import MapleUI

final class MuiProgressTests: XCTestCase {
    func testNilPassesThroughAsIndeterminate() {
        XCTAssertNil(MuiProgress.clampedValue(nil))
    }

    func testInRangeValueIsUnchanged() {
        XCTAssertEqual(MuiProgress.clampedValue(42), 42)
    }

    func testValueAboveMaximumClampsTo100() {
        XCTAssertEqual(MuiProgress.clampedValue(150), 100)
    }

    func testValueBelowMinimumClampsTo0() {
        XCTAssertEqual(MuiProgress.clampedValue(-20), 0)
    }

    func testBoundaryValuesPassThroughUnchanged() {
        XCTAssertEqual(MuiProgress.clampedValue(0), 0)
        XCTAssertEqual(MuiProgress.clampedValue(100), 100)
    }
}
