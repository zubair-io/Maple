import XCTest
@testable import MapleUI

final class MuiLivingSliderTests: XCTestCase {
    func testDragAppliesDeltaProportionallyAndSnapsToStep() {
        // +20px of a 200px track over a 10-wide range = +2.0.
        let value = MuiLivingSlider.draggedValue(startValue: 0, deltaX: 20, trackWidth: 200, range: -5...5, step: 0.1)
        XCTAssertEqual(value, 1.0, accuracy: 1e-9)
    }

    func testDragClampsToRangeMaximum() {
        let value = MuiLivingSlider.draggedValue(startValue: 0, deltaX: 300, trackWidth: 200, range: -5...5, step: 0.1)
        XCTAssertEqual(value, 5)
    }

    func testDragClampsToRangeMinimum() {
        let value = MuiLivingSlider.draggedValue(startValue: 0, deltaX: -300, trackWidth: 200, range: -5...5, step: 0.1)
        XCTAssertEqual(value, -5)
    }

    func testZeroWidthTrackReturnsStartValueUnchanged() {
        let value = MuiLivingSlider.draggedValue(startValue: 2, deltaX: 50, trackWidth: 0, range: -5...5, step: 0.1)
        XCTAssertEqual(value, 2)
    }

    func testValueLabelFormatsSigned() {
        XCTAssertEqual(MuiLivingSlider.valueLabel(value: 0, step: 0.1, unit: ""), "0.0")
        XCTAssertEqual(MuiLivingSlider.valueLabel(value: 6500, step: 50, unit: "K"), "+6500 K")
    }
}
