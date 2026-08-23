import XCTest
@testable import MapleUI

final class MuiAddServerModalTests: XCTestCase {
    func testCanConnectRequiresHostAndUsername() {
        XCTAssertFalse(MuiAddServerModal.canConnect(host: "", username: "ada", connecting: false))
        XCTAssertFalse(MuiAddServerModal.canConnect(host: "maple.local", username: "", connecting: false))
        XCTAssertTrue(MuiAddServerModal.canConnect(host: "maple.local", username: "ada", connecting: false))
    }

    func testCanConnectFalseWhileConnecting() {
        XCTAssertFalse(MuiAddServerModal.canConnect(host: "maple.local", username: "ada", connecting: true))
    }

    func testCanConnectFalseForWhitespaceOnlyFields() {
        XCTAssertFalse(MuiAddServerModal.canConnect(host: "   ", username: "ada", connecting: false))
    }
}
