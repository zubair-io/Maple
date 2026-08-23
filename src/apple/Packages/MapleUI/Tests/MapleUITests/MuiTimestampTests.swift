import XCTest
@testable import MapleUI

final class MuiTimestampTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    func testJustNowUnderAMinute() {
        let value = now.addingTimeInterval(-30)
        XCTAssertEqual(MuiTimestamp.relativeString(value: value, now: now), "just now")
    }

    func testMinutesAgo() {
        let value = now.addingTimeInterval(-5 * 60)
        XCTAssertEqual(MuiTimestamp.relativeString(value: value, now: now), "5m ago")
    }

    func testJustUnderAnHourStillMinutes() {
        let value = now.addingTimeInterval(-59 * 60)
        XCTAssertEqual(MuiTimestamp.relativeString(value: value, now: now), "59m ago")
    }

    func testHoursAgo() {
        let value = now.addingTimeInterval(-3 * 3600)
        XCTAssertEqual(MuiTimestamp.relativeString(value: value, now: now), "3h ago")
    }

    func testJustUnderADayStillHours() {
        let value = now.addingTimeInterval(-23 * 3600)
        XCTAssertEqual(MuiTimestamp.relativeString(value: value, now: now), "23h ago")
    }

    func testDaysAgo() {
        let value = now.addingTimeInterval(-2 * 86400)
        XCTAssertEqual(MuiTimestamp.relativeString(value: value, now: now), "2d ago")
    }

    func testSixDayCeiling() {
        let value = now.addingTimeInterval(-6 * 86400)
        XCTAssertEqual(MuiTimestamp.relativeString(value: value, now: now), "6d ago")
    }

    func testPastCeilingFallsBackToAbsoluteDate() {
        let value = now.addingTimeInterval(-8 * 86400)
        let result = MuiTimestamp.relativeString(value: value, now: now)
        XCTAssertFalse(result.hasSuffix("d ago"))
        XCTAssertFalse(result.isEmpty)
    }

    func testFutureDateClampsToJustNow() {
        let value = now.addingTimeInterval(60)
        XCTAssertEqual(MuiTimestamp.relativeString(value: value, now: now), "just now")
    }

    func testDisplayStringRoutesToFormat() {
        let value = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertEqual(
            MuiTimestamp.displayString(value: value, format: .relative, now: now),
            MuiTimestamp.relativeString(value: value, now: now)
        )
        XCTAssertFalse(MuiTimestamp.displayString(value: value, format: .short, now: now).isEmpty)
        XCTAssertFalse(MuiTimestamp.displayString(value: value, format: .long, now: now).isEmpty)
        XCTAssertFalse(MuiTimestamp.displayString(value: value, format: .timeOnly, now: now).isEmpty)
    }

    func testAbsoluteStringIsStableForAFixedInstant() {
        let value = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertEqual(MuiTimestamp.absoluteString(value), MuiTimestamp.absoluteString(value))
        XCTAssertFalse(MuiTimestamp.absoluteString(value).isEmpty)
    }
}
