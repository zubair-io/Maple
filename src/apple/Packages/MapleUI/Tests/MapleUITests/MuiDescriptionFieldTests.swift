import XCTest
@testable import MapleUI

final class MuiDescriptionFieldTests: XCTestCase {
    func testCommitResultTrimsWhitespace() {
        XCTAssertEqual(MuiDescriptionField.commitResult(current: "Old", draft: "  New text  "), "New text")
    }

    func testCommitResultAllowsCommittingEmptyToClearTheDescription() {
        XCTAssertEqual(MuiDescriptionField.commitResult(current: "Old", draft: "   "), "")
    }

    func testCommitResultIsNilWhenUnchanged() {
        XCTAssertNil(MuiDescriptionField.commitResult(current: "Same", draft: "Same"))
        XCTAssertNil(MuiDescriptionField.commitResult(current: "", draft: "  "))
    }
}
