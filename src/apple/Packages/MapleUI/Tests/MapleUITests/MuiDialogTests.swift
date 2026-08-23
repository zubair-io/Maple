import XCTest
@testable import MapleUI

final class MuiDialogTests: XCTestCase {
    func testConfirmPayloadForConfirmVariantIsAlwaysEmpty() {
        XCTAssertEqual(MuiDialog.confirmPayload(variant: .confirm, promptValue: "ignored"), "")
        XCTAssertEqual(MuiDialog.confirmPayload(variant: .confirm, promptValue: ""), "")
    }

    func testConfirmPayloadForPromptVariantPassesThroughTheTypedValue() {
        XCTAssertEqual(MuiDialog.confirmPayload(variant: .prompt, promptValue: "New album"), "New album")
        XCTAssertEqual(MuiDialog.confirmPayload(variant: .prompt, promptValue: ""), "")
    }
}
