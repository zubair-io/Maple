import XCTest
@testable import MapleUI

final class MuiStatTests: XCTestCase {
    func testNoDeltaOmitsDeltaSegment() {
        XCTAssertEqual(MuiStat.accessibleLabel(value: "128", label: "Photos", delta: nil, trend: nil), "128 Photos")
    }

    func testDeltaWithoutTrendOmitsTrendWord() {
        XCTAssertEqual(
            MuiStat.accessibleLabel(value: "1.2K", label: "Views", delta: "+12", trend: nil),
            "1.2K Views, +12"
        )
    }

    func testDeltaWithUpTrend() {
        XCTAssertEqual(
            MuiStat.accessibleLabel(value: "1.2K", label: "Views", delta: "+12", trend: .up),
            "1.2K Views, up +12"
        )
    }

    func testDeltaWithDownTrend() {
        XCTAssertEqual(
            MuiStat.accessibleLabel(value: "84", label: "Errors", delta: "-6", trend: .down),
            "84 Errors, down -6"
        )
    }

    func testDeltaWithFlatTrend() {
        XCTAssertEqual(
            MuiStat.accessibleLabel(value: "50", label: "Idle", delta: "0", trend: .flat),
            "50 Idle, flat 0"
        )
    }
}
