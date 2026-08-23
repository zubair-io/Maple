import XCTest
import SwiftUI
@testable import MapleUI

final class MuiSetupWizardTests: XCTestCase {
    func testStatusBeforeCurrentIsDone() {
        XCTAssertEqual(MuiSetupWizard<EmptyView>.status(for: 0, current: 2), .done)
        XCTAssertEqual(MuiSetupWizard<EmptyView>.status(for: 1, current: 2), .done)
    }

    func testStatusAtCurrentIsActive() {
        XCTAssertEqual(MuiSetupWizard<EmptyView>.status(for: 2, current: 2), .active)
    }

    func testStatusAfterCurrentIsPending() {
        XCTAssertEqual(MuiSetupWizard<EmptyView>.status(for: 3, current: 2), .pending)
    }
}
