import XCTest
@testable import MapleUI

final class MuiMediaTransportMathTests: XCTestCase {
    func testFormatDurationPadsSeconds() {
        XCTAssertEqual(MuiMediaTransportMath.formatDuration(65), "1:05")
    }

    func testFormatDurationUnderAMinute() {
        XCTAssertEqual(MuiMediaTransportMath.formatDuration(9), "0:09")
    }

    func testFormatDurationTruncatesFractionalSeconds() {
        XCTAssertEqual(MuiMediaTransportMath.formatDuration(65.9), "1:05")
    }

    func testFormatDurationNegativeReadsAsZero() {
        XCTAssertEqual(MuiMediaTransportMath.formatDuration(-1), "0:00")
    }

    func testFormatDurationNonFiniteReadsAsZero() {
        XCTAssertEqual(MuiMediaTransportMath.formatDuration(.nan), "0:00")
        XCTAssertEqual(MuiMediaTransportMath.formatDuration(.infinity), "0:00")
    }

    func testProgressPercentHalfway() {
        XCTAssertEqual(MuiMediaTransportMath.progressPercent(currentTime: 30, duration: 60), 50)
    }

    func testProgressPercentZeroDurationIsZero() {
        XCTAssertEqual(MuiMediaTransportMath.progressPercent(currentTime: 10, duration: 0), 0)
    }

    func testSeekTimeScalesRatioByDuration() {
        XCTAssertEqual(MuiMediaTransportMath.seekTime(ratio: 0.25, duration: 100), 25)
    }

    func testSeekTimeClampsRatioOutsideZeroToOne() {
        XCTAssertEqual(MuiMediaTransportMath.seekTime(ratio: -1, duration: 100), 0)
        XCTAssertEqual(MuiMediaTransportMath.seekTime(ratio: 2, duration: 100), 100)
    }

    func testSeekTimeNilWhenNoDuration() {
        XCTAssertNil(MuiMediaTransportMath.seekTime(ratio: 0.5, duration: 0))
    }
}
