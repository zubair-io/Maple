import SwiftUI
import XCTest
@testable import MapleUI

final class MuiInputTests: XCTestCase {
    func testStepIncrementsWithinBounds() {
        let config = MuiInputNumericConfig(min: -5, max: 5, step: 0.5)
        XCTAssertEqual(MuiInput.steppedValue(current: "0", delta: 0.5, config: config), "0.5")
    }

    func testStepClampsAtMaximum() {
        let config = MuiInputNumericConfig(min: -5, max: 5, step: 1)
        XCTAssertEqual(MuiInput.steppedValue(current: "4.5", delta: 1, config: config), "5")
    }

    func testStepClampsAtMinimum() {
        let config = MuiInputNumericConfig(min: -5, max: 5, step: 1)
        XCTAssertEqual(MuiInput.steppedValue(current: "-4.5", delta: -1, config: config), "-5")
    }

    func testStepFromNonNumericCurrentTreatsItAsZero() {
        let config = MuiInputNumericConfig(min: -5, max: 5, step: 1)
        XCTAssertEqual(MuiInput.steppedValue(current: "", delta: 1, config: config), "1")
    }

    func testFieldFontDefaultsToSystemDesign() {
        XCTAssertEqual(MuiInput.fieldFont(monospaced: false, size: .md), .system(size: 14))
    }

    func testFieldFontSwitchesToMonospacedDesign() {
        XCTAssertEqual(MuiInput.fieldFont(monospaced: true, size: .md), .system(size: 14, design: .monospaced))
    }

    func testFieldFontRespectsSmallSize() {
        XCTAssertEqual(MuiInput.fieldFont(monospaced: true, size: .sm), .system(size: 13, design: .monospaced))
    }

    func testFieldFontMonospacedDiffersFromDefault() {
        XCTAssertNotEqual(
            MuiInput.fieldFont(monospaced: true, size: .md),
            MuiInput.fieldFont(monospaced: false, size: .md)
        )
    }
}
