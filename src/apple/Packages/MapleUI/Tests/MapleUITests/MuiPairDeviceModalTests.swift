import XCTest
@testable import MapleUI

final class MuiPairDeviceModalTests: XCTestCase {
    func testStatusBeforeCurrentIsDone() {
        XCTAssertEqual(MuiPairDeviceModal.status(for: 0, current: 1), .done)
    }

    func testStatusAtCurrentIsActive() {
        XCTAssertEqual(MuiPairDeviceModal.status(for: 1, current: 1), .active)
    }

    func testStatusAfterCurrentIsPending() {
        XCTAssertEqual(MuiPairDeviceModal.status(for: 2, current: 1), .pending)
    }
}
