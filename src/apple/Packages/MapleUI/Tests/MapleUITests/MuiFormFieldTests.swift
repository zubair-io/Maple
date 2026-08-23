import XCTest
@testable import MapleUI

final class MuiFormFieldTests: XCTestCase {
    func testDisplayLabelAppendsRequiredMarker() {
        XCTAssertEqual(MuiFormField.displayLabel(label: "Display name", required: true), "Display name *")
    }

    func testDisplayLabelLeavesOptionalLabelUnchanged() {
        XCTAssertEqual(MuiFormField.displayLabel(label: "Nickname", required: false), "Nickname")
    }
}
