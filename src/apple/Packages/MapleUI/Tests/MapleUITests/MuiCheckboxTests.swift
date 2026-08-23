import XCTest
@testable import MapleUI

final class MuiCheckboxTests: XCTestCase {
    func testUncheckedAccessibilityValue() {
        XCTAssertEqual(MuiCheckbox.accessibilityValue(for: .unchecked), "Unchecked")
    }

    func testCheckedAccessibilityValue() {
        XCTAssertEqual(MuiCheckbox.accessibilityValue(for: .checked), "Checked")
    }

    func testIndeterminateAccessibilityValueIsAnnouncedDistinctly() {
        let value = MuiCheckbox.accessibilityValue(for: .indeterminate)
        XCTAssertEqual(value, "Mixed")
        XCTAssertNotEqual(value, MuiCheckbox.accessibilityValue(for: .checked))
        XCTAssertNotEqual(value, MuiCheckbox.accessibilityValue(for: .unchecked))
    }
}
