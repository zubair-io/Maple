import XCTest
@testable import MapleUI

final class MuiInlineRenameFieldTests: XCTestCase {
    func testCommitResultTrimsWhitespace() {
        XCTAssertEqual(MuiInlineRenameField.commitResult(current: "old", draft: "  New Name  "), "New Name")
    }

    func testCommitResultRejectsBlankDraft() {
        XCTAssertNil(MuiInlineRenameField.commitResult(current: "old", draft: "   "))
    }

    func testCommitResultRejectsUnchangedDraft() {
        XCTAssertNil(MuiInlineRenameField.commitResult(current: "Same Name", draft: "Same Name"))
    }

    func testCommitResultAcceptsAGenuineChange() {
        XCTAssertEqual(MuiInlineRenameField.commitResult(current: "old", draft: "new"), "new")
    }
}
