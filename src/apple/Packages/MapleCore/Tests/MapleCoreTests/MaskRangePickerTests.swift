// MaskRangePickerTests.swift — the mask panel's colour-range controls (#362):
// the eyedropper seeds the selected layer as one undo entry, the enable
// toggle is one transaction, and a slider write rides the drag's own
// transaction — the same boundaries the ten adjustment sliders honour.

import XCTest

@testable import MapleCore

@MainActor
final class MaskRangePickerTests: XCTestCase {
  private let point = CGPoint(x: 0.25, y: 0.75)
  private let sample = MaskRangeSample(hueDeg: 210, chromaMin: 0.05, lMin: 0.1, lMax: 0.6)

  private func session(with layer: LocalAdjustment) -> EditSession {
    let s = EditSession.preview()
    s.model.localAdjustments = [layer]
    s.selectedMaskId = layer.id
    return s
  }

  func testPickSeedsTheSelectedLayerAsOneUndoableActionKeepingWidthAndFeather() async {
    let layer = LocalAdjustment(
      mask: .everywhere,
      range: .color(
        hueDeg: 55, hueHalfWidthDeg: 40, chromaMin: 0.02, lMin: 0.15, lMax: 0.95, feather: 0.7),
      adjustments: PartialAdjustments())
    let s = session(with: layer)
    let before = s.model
    let picker = MaskRangePicker(session: s)
    let sample = sample
    picker.provider = { _, _, _ in sample }
    picker.arm()
    XCTAssertTrue(picker.isArmed)
    await picker.pick(at: point)
    XCTAssertFalse(picker.isArmed)
    XCTAssertNil(picker.message)
    XCTAssertEqual(s.undoHistory.count, 1)
    XCTAssertEqual(
      s.model.localAdjustments[0].range,
      .color(hueDeg: 210, hueHalfWidthDeg: 40, chromaMin: 0.05, lMin: 0.1, lMax: 0.6, feather: 0.7)
    )
    let sampled = s.model
    s.undo()
    XCTAssertEqual(s.model, before)
    s.redo()
    XCTAssertEqual(s.model, sampled)
  }

  func testPickEnablesARangeOnALayerThatHadNone() async {
    let layer = LocalAdjustment(
      mask: .linear(start: MaskPoint(x: 0, y: 0), end: MaskPoint(x: 1, y: 1), feather: 0.5),
      adjustments: PartialAdjustments())
    let s = session(with: layer)
    let picker = MaskRangePicker(session: s)
    let sample = sample
    picker.provider = { _, _, _ in sample }
    picker.arm()
    await picker.pick(at: point)
    XCTAssertEqual(s.model.localAdjustments[0].range, RangeRefinement.coreDefault.seeded(with: sample))
    XCTAssertEqual(s.undoHistory.count, 1)
  }

  func testArmNeedsASelectedMask() {
    let s = EditSession.preview()
    let picker = MaskRangePicker(session: s)
    picker.arm()
    XCTAssertFalse(picker.isArmed)
  }

  func testRejectionsKeepThePickerArmedWithoutEditsAndExplain() async {
    for code: Int32 in [11, 13, 15] {
      let s = session(
        with: LocalAdjustment(mask: .everywhere, range: .skinTone, adjustments: PartialAdjustments())
      )
      let picker = MaskRangePicker(session: s)
      picker.provider = { _, _, _ in throw MaskRangeSampleError(code: code) }
      picker.arm()
      await picker.pick(at: point)
      XCTAssertTrue(picker.isArmed, "code \(code)")
      XCTAssertEqual(picker.message, MaskRangeSampleError(code: code).errorDescription)
      XCTAssertTrue(s.undoHistory.isEmpty, "code \(code)")
      XCTAssertEqual(s.model.localAdjustments[0].range, .skinTone)
    }
  }

  func testPickOutsideTheImageExplainsWithoutSampling() async {
    let s = session(
      with: LocalAdjustment(mask: .everywhere, range: .skinTone, adjustments: PartialAdjustments()))
    let picker = MaskRangePicker(session: s)
    picker.provider = { _, _, _ in XCTFail("must not sample"); throw MaskRangeSampleError.failed }
    picker.arm()
    await picker.pick(at: nil)
    XCTAssertTrue(picker.isArmed)
    XCTAssertEqual(picker.message, MaskRangeSampleError.outsideImage.errorDescription)
  }

  func testModelChangeDuringTheSampleDropsIt() async {
    let s = session(
      with: LocalAdjustment(mask: .everywhere, range: .skinTone, adjustments: PartialAdjustments()))
    let picker = MaskRangePicker(session: s)
    let sample = sample
    picker.provider = { _, _, _ in
      await MainActor.run { s.model.localAdjustments[0].adjustments.exposure = 1 }
      return sample
    }
    picker.arm()
    await picker.pick(at: point)
    XCTAssertEqual(s.model.localAdjustments[0].range, .skinTone)
    XCTAssertNotNil(picker.message)
  }

  func testEnableToggleIsOneTransactionEachWay() {
    let layer = LocalAdjustment(
      mask: .radial(
        center: MaskPoint(x: 0.5, y: 0.5), radii: MaskPoint(x: 0.3, y: 0.2), angle: 0,
        feather: 0.5, invert: false),
      adjustments: PartialAdjustments())
    let s = session(with: layer)
    XCTAssertNil(s.maskRange(id: layer.id))
    s.setMaskRangeEnabled(id: layer.id, enabled: true)
    XCTAssertEqual(s.maskRange(id: layer.id), .coreDefault)
    XCTAssertEqual(s.undoHistory.count, 1)
    // Redundant enable writes nothing.
    s.setMaskRangeEnabled(id: layer.id, enabled: true)
    XCTAssertEqual(s.undoHistory.count, 1)
    s.setMaskRangeEnabled(id: layer.id, enabled: false)
    XCTAssertNil(s.maskRange(id: layer.id))
    XCTAssertEqual(s.undoHistory.count, 2)
    s.undo()
    XCTAssertEqual(s.maskRange(id: layer.id), .coreDefault)
  }

  func testSliderWritesRideTheDragTransaction() {
    let layer = LocalAdjustment(
      mask: .everywhere, range: .skinTone, adjustments: PartialAdjustments())
    let s = session(with: layer)
    let before = s.model
    // One drag, through the same boundary the slider's `onEditingChanged`
    // calls: press, several samples, release.
    s.setMaskDragActive(true)
    s.setMaskRangeField(id: layer.id, .hueWidth, 30)
    s.setMaskRangeField(id: layer.id, .hueWidth, 35)
    s.setMaskRangeField(id: layer.id, .feather, 0.5)
    s.setMaskDragActive(false)
    XCTAssertEqual(s.undoHistory.count, 1)
    XCTAssertEqual(s.maskRange(id: layer.id)?.value(of: .hueWidth), 35)
    XCTAssertEqual(s.maskRange(id: layer.id)?.value(of: .feather), 0.5)
    XCTAssertEqual(s.maskRange(id: layer.id)?.hueDeg, 55)
    s.undo()
    XCTAssertEqual(s.model, before)
  }

  /// #3453 review: releasing the slider must CLOSE the transaction. Left
  /// open, the drag records nothing until some later boundary closes it —
  /// and swallows whatever the user did next into the same undo entry.
  func testDragEndClosesTheTransactionSoLaterActionsAreSeparateEntries() {
    let layer = LocalAdjustment(
      mask: .everywhere, range: .skinTone, adjustments: PartialAdjustments())
    let s = session(with: layer)
    s.setMaskDragActive(true)
    s.setMaskRangeField(id: layer.id, .hueWidth, 35)
    s.setMaskDragActive(false)
    // Recorded on release, not deferred to the next boundary.
    XCTAssertEqual(s.undoHistory.count, 1)
    XCTAssertFalse(s.isAdjustingMask)
    let afterDrag = s.model

    // An unrelated action afterwards is its OWN entry.
    s.setMaskRangeEnabled(id: layer.id, enabled: false)
    XCTAssertEqual(s.undoHistory.count, 2)
    s.undo()
    XCTAssertEqual(s.model, afterDrag, "undo must return to the drag's result, not past it")
    XCTAssertEqual(s.maskRange(id: layer.id)?.value(of: .hueWidth), 35)
  }

  /// The same boundary drives the ten adjustment sliders, so two successive
  /// drags — one range, one adjustment — are two entries, not one.
  func testTwoSuccessiveDragsAreTwoEntries() {
    let layer = LocalAdjustment(
      mask: .everywhere, range: .skinTone, adjustments: PartialAdjustments())
    let s = session(with: layer)
    s.setMaskDragActive(true)
    s.setMaskRangeField(id: layer.id, .feather, 0.6)
    s.setMaskDragActive(false)
    let afterFirst = s.model

    s.setMaskDragActive(true)
    s.model.localAdjustments[0].adjustments.exposure = 1.5
    s.setMaskDragActive(false)
    XCTAssertEqual(s.undoHistory.count, 2)
    s.undo()
    XCTAssertEqual(s.model, afterFirst)
  }

  /// A drag that moves nothing records nothing — `endEdit` drops a no-op
  /// transaction, so a stray press never pollutes the history.
  func testAPressWithoutMovementRecordsNothing() {
    let s = session(
      with: LocalAdjustment(mask: .everywhere, range: .skinTone, adjustments: PartialAdjustments()))
    s.setMaskDragActive(true)
    s.setMaskDragActive(false)
    XCTAssertTrue(s.undoHistory.isEmpty)
  }

  func testSliderWriteIsIgnoredWithoutARange() {
    let layer = LocalAdjustment(mask: .everywhere, adjustments: PartialAdjustments())
    let s = session(with: layer)
    s.setMaskDragActive(true)
    s.setMaskRangeField(id: layer.id, .lMax, 0.5)
    s.setMaskDragActive(false)
    XCTAssertNil(s.maskRange(id: layer.id))
    XCTAssertTrue(s.undoHistory.isEmpty)
  }

  func testFieldAccessorsRoundTrip() {
    let base = RangeRefinement.coreDefault
    for field in RangeField.allCases {
      let v = field.range.upperBound
      let next = base.with(field, v)
      XCTAssertEqual(next.value(of: field), v, field.label)
      for other in RangeField.allCases where other != field {
        XCTAssertEqual(next.value(of: other), base.value(of: other), "\(field) leaked into \(other)")
      }
      XCTAssertEqual(next.hueDeg, base.hueDeg)
    }
  }
}
