import XCTest
@testable import MapleUI

final class MuiScrubMathTests: XCTestCase {
    func testPercentInRangeAtBounds() {
        XCTAssertEqual(MuiScrubMath.percentInRange(value: -5, min: -5, max: 5, fallbackPct: 50), 0)
        XCTAssertEqual(MuiScrubMath.percentInRange(value: 5, min: -5, max: 5, fallbackPct: 50), 100)
        XCTAssertEqual(MuiScrubMath.percentInRange(value: 0, min: -5, max: 5, fallbackPct: 50), 50)
    }

    func testPercentInRangeDegenerateRangeUsesFallback() {
        XCTAssertEqual(MuiScrubMath.percentInRange(value: 3, min: 5, max: 5, fallbackPct: 0), 0)
        XCTAssertEqual(MuiScrubMath.percentInRange(value: 3, min: 5, max: 5, fallbackPct: 50), 50)
    }

    func testValueFromPercentIsInverseOfPercentInRange() {
        XCTAssertEqual(MuiScrubMath.valueFromPercent(75, min: -100, max: 100), 50)
        XCTAssertEqual(MuiScrubMath.valueFromPercent(0, min: -100, max: 100), -100)
    }

    func testValueFromPercentClampsOutOfRangePercent() {
        XCTAssertEqual(MuiScrubMath.valueFromPercent(150, min: 0, max: 10), 10)
        XCTAssertEqual(MuiScrubMath.valueFromPercent(-50, min: 0, max: 10), 0)
    }

    func testSnapRoundsToNearestStep() {
        XCTAssertEqual(MuiScrubMath.snap(1.04, step: 0.1, min: -5, max: 5), 1.0, accuracy: 1e-9)
        XCTAssertEqual(MuiScrubMath.snap(1.06, step: 0.1, min: -5, max: 5), 1.1, accuracy: 1e-9)
    }

    func testSnapClampsAfterRounding() {
        XCTAssertEqual(MuiScrubMath.snap(15, step: 1, min: -5, max: 5), 5)
        XCTAssertEqual(MuiScrubMath.snap(-15, step: 1, min: -5, max: 5), -5)
    }

    func testSnapWithZeroStepOnlyClamps() {
        XCTAssertEqual(MuiScrubMath.snap(4.567, step: 0, min: 0, max: 10), 4.567, accuracy: 1e-9)
        XCTAssertEqual(MuiScrubMath.snap(15, step: 0, min: 0, max: 10), 10)
    }

    func testFormatSignedValueWholeStepHasNoDecimals() {
        XCTAssertEqual(MuiScrubMath.formatSignedValue(50, step: 1), "+50")
        XCTAssertEqual(MuiScrubMath.formatSignedValue(-50, step: 1), "-50")
        XCTAssertEqual(MuiScrubMath.formatSignedValue(0, step: 1), "0")
    }

    func testFormatSignedValueSubOneStepShowsOneDecimal() {
        XCTAssertEqual(MuiScrubMath.formatSignedValue(1.0, step: 0.5), "+1.0")
    }

    func testFormatSignedValueSubTenthStepShowsTwoDecimals() {
        XCTAssertEqual(MuiScrubMath.formatSignedValue(0.35, step: 0.05), "+0.35")
    }

    func testFormatSignedValueAppendsUnit() {
        XCTAssertEqual(MuiScrubMath.formatSignedValue(6500, step: 50, unit: "K"), "+6500 K")
    }
}
