import XCTest
@testable import MapleUI

final class MuiThreadPanelTests: XCTestCase {
    func testTrimmedNonEmptyTrimsSurroundingWhitespace() {
        XCTAssertEqual(MuiThreadPanel.trimmedNonEmpty("  Sure, on it.  "), "Sure, on it.")
    }

    func testTrimmedNonEmptyRejectsABlankDraft() {
        XCTAssertNil(MuiThreadPanel.trimmedNonEmpty("   "))
        XCTAssertNil(MuiThreadPanel.trimmedNonEmpty(""))
    }
}
