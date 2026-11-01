import XCTest

@testable import MapleUI

final class MuiSliderTests: XCTestCase {
  func testUnsignedPercentReadoutHasNoSignAndNoSpace() {
    XCTAssertEqual(MuiSlider.valueLabel(value: 0, range: 0...100, step: 1, unit: "%"), "0%")
    XCTAssertEqual(MuiSlider.valueLabel(value: 50, range: 0...100, step: 1, unit: "%"), "50%")
  }

  func testUnsignedPlainValueAndOtherUnits() {
    XCTAssertEqual(MuiSlider.valueLabel(value: 40, range: 0...150, step: 1, unit: ""), "40")
    XCTAssertEqual(
      MuiSlider.valueLabel(value: 5500, range: 2000...10000, step: 50, unit: "K"), "5500 K")
  }

  func testSignedReadoutUsesPlusTrueMinusAndNoSignAtZero() {
    XCTAssertEqual(
      MuiSlider.valueLabel(value: 0.3, range: -2...2, step: 0.1, unit: "EV"), "+0.3 EV")
    XCTAssertEqual(
      MuiSlider.valueLabel(value: -0.3, range: -2...2, step: 0.1, unit: "EV"), "\u{2212}0.3 EV")
    XCTAssertEqual(MuiSlider.valueLabel(value: 0, range: -2...2, step: 0.1, unit: "EV"), "0.0 EV")
  }

  func testNegativeValueThatRoundsToZeroShowsNoSign() {
    XCTAssertEqual(
      MuiSlider.valueLabel(value: -0.04, range: -2...2, step: 0.1, unit: "EV"), "0.0 EV")
    XCTAssertEqual(
      MuiSlider.spokenValue(value: -0.04, range: -2...2, step: 0.1, unit: "EV"), "0.0 EV")
  }

  func testSpokenValue() {
    XCTAssertEqual(
      MuiSlider.spokenValue(value: 50, range: 0...100, step: 1, unit: "%"), "50 percent")
    XCTAssertEqual(
      MuiSlider.spokenValue(value: 0.3, range: -2...2, step: 0.1, unit: "EV"), "plus 0.3 EV")
    XCTAssertEqual(
      MuiSlider.spokenValue(value: -0.3, range: -2...2, step: 0.1, unit: "EV"), "minus 0.3 EV")
    XCTAssertEqual(MuiSlider.spokenValue(value: 40, range: 0...150, step: 1, unit: ""), "40")
  }

  func testWarningReasonIsAppendedToAccessibilityValue() {
    let reason = "Not applied: the frames form separate pieces, so the edges stay as stitched."
    XCTAssertEqual(
      MuiSlider.accessibilityValue(
        value: 0, range: 0...100, step: 1, unit: "%", helper: reason, helperTone: .warning),
      "0 percent. \(reason)")
  }

  func testMutedHelperIsAHintNotPartOfTheValue() {
    let help = "Stretches the edges toward a full rectangle."
    XCTAssertEqual(
      MuiSlider.accessibilityValue(
        value: 50, range: 0...100, step: 1, unit: "%", helper: help, helperTone: .muted),
      "50 percent")
    XCTAssertEqual(MuiSlider.accessibilityHint(helper: help, helperTone: .muted), help)
    XCTAssertNil(MuiSlider.accessibilityHint(helper: help, helperTone: .warning))
    XCTAssertNil(MuiSlider.accessibilityHint(helper: nil, helperTone: .muted))
  }

  func testOnlyANonEmptyWarningHelperIsAnnounced() {
    let reason = "Not applied: warping this shape would fold the image."
    XCTAssertEqual(MuiSlider.warningReason(helper: reason, helperTone: .warning), reason)
    XCTAssertNil(MuiSlider.warningReason(helper: reason, helperTone: .muted))
    XCTAssertNil(MuiSlider.warningReason(helper: "", helperTone: .warning))
    XCTAssertNil(MuiSlider.warningReason(helper: nil, helperTone: .warning))
  }

  func testCommitFiresOnlyWhenTheValueChanged() {
    XCTAssertTrue(MuiSlider.shouldCommit(start: 10, end: 11))
    XCTAssertFalse(MuiSlider.shouldCommit(start: 10, end: 10))
    XCTAssertFalse(MuiSlider.shouldCommit(start: nil, end: 10))
  }

  func testTapBandIsAtLeast44Points() {
    XCTAssertGreaterThanOrEqual(MuiSlider.minimumTapHeight, 44)
  }
}
