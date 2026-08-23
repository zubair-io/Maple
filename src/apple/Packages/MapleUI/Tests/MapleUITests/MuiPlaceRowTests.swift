import XCTest
@testable import MapleUI

final class MuiPlaceRowTests: XCTestCase {
    func testCommitResultTrimsWhitespace() {
        XCTAssertEqual(MuiPlaceRow.commitResult(current: "Old town", draft: "  Reykjavík  "), "Reykjavík")
    }

    func testCommitResultNeverCommitsEmpty() {
        XCTAssertNil(MuiPlaceRow.commitResult(current: "Reykjavík", draft: "   "))
        XCTAssertNil(MuiPlaceRow.commitResult(current: "Reykjavík", draft: ""))
    }

    func testCommitResultIsNilWhenUnchanged() {
        XCTAssertNil(MuiPlaceRow.commitResult(current: "Reykjavík", draft: "Reykjavík"))
    }
}
