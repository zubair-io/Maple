import XCTest
@testable import MapleUI

final class MuiStatusTextTests: XCTestCase {
    func testDefaultTextIsUsedWhenNoOverride() {
        XCTAssertEqual(MuiStatusText.displayText(state: .saving, text: nil), "Saving…")
    }

    func testExplicitTextOverridesDefaultButKeepsState() {
        XCTAssertEqual(MuiStatusText.displayText(state: .saved, text: "Saved 2m ago"), "Saved 2m ago")
    }

    func testEveryStateHasANonEmptyDefaultText() {
        let states: [MuiStatusTextState] = [.idle, .saving, .saved, .offline, .error]
        for state in states {
            XCTAssertFalse(MuiStatusText.defaultText(for: state).isEmpty)
            XCTAssertFalse(MuiStatusText.iconName(for: state).isEmpty)
        }
    }
}
