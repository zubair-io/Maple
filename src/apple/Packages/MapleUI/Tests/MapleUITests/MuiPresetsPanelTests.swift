import XCTest
@testable import MapleUI

final class MuiPresetsPanelTests: XCTestCase {
    func testTrimmedNonEmptyTrimsSurroundingWhitespace() {
        XCTAssertEqual(MuiPresetsPanel.trimmedNonEmpty("  Moody Landscape  "), "Moody Landscape")
    }

    func testTrimmedNonEmptyRejectsABlankName() {
        XCTAssertNil(MuiPresetsPanel.trimmedNonEmpty("   "))
        XCTAssertNil(MuiPresetsPanel.trimmedNonEmpty(""))
    }
}
