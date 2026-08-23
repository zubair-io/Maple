import XCTest
@testable import MapleUI

final class MuiPageSignInTests: XCTestCase {
    func testCanSubmitIsFalseWithEitherFieldEmpty() {
        XCTAssertFalse(MuiPageSignIn.canSubmit(email: "", password: "hunter2"))
        XCTAssertFalse(MuiPageSignIn.canSubmit(email: "a@b.com", password: ""))
        XCTAssertFalse(MuiPageSignIn.canSubmit(email: "   ", password: "   "))
    }

    func testCanSubmitIsTrueWithBothFieldsPresent() {
        XCTAssertTrue(MuiPageSignIn.canSubmit(email: "a@b.com", password: "hunter2"))
    }

    func testSubmitErrorRejectsAnEmailWithoutAnAtSign() {
        XCTAssertEqual(MuiPageSignIn.submitError(email: "not-an-email", password: "hunter2"), "Enter a valid email address.")
    }

    func testSubmitErrorRejectsAShortPassword() {
        XCTAssertEqual(MuiPageSignIn.submitError(email: "a@b.com", password: "abc"), "Incorrect email or password.")
    }

    func testSubmitErrorIsNilForAValidEmailAndPassword() {
        XCTAssertNil(MuiPageSignIn.submitError(email: "a@b.com", password: "hunter2"))
    }
}
