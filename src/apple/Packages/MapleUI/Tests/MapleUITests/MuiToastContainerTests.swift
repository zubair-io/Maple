import XCTest
@testable import MapleUI

final class MuiToastContainerTests: XCTestCase {
    func testFirstToastHasNoDelay() {
        XCTAssertEqual(MuiToastContainer.exitDelay(forIndex: 0), 0)
    }

    func testEachSubsequentToastStaggersBySixtyMilliseconds() {
        XCTAssertEqual(MuiToastContainer.exitDelay(forIndex: 1), 0.06, accuracy: 1e-9)
        XCTAssertEqual(MuiToastContainer.exitDelay(forIndex: 3), 0.18, accuracy: 1e-9)
    }
}
