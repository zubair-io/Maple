import XCTest

@testable import MapleCore

/// The white-balance pad (#5121): the same pad positions as web's
/// `wb-pad.spec.ts`, and the same sidecar as the Temperature and Tint sliders.
@MainActor
final class WhiteBalancePadMathTests: XCTestCase {
  func testPadEdgesAndCentreMatchTheWebPad() {
    XCTAssertEqual(WhiteBalancePadMath.temperature(atFraction: 0), 2000)
    XCTAssertEqual(WhiteBalancePadMath.temperature(atFraction: 0.5), 7000)
    XCTAssertEqual(WhiteBalancePadMath.temperature(atFraction: 1), 12000)
    XCTAssertEqual(WhiteBalancePadMath.tint(atFraction: 0), -150)
    XCTAssertEqual(WhiteBalancePadMath.tint(atFraction: 0.5), 0)
    XCTAssertEqual(WhiteBalancePadMath.tint(atFraction: 1), 150)
  }

  func testValuesRoundTripThroughThePad() {
    let x = WhiteBalancePadMath.fraction(forTemperature: 5600)
    XCTAssertEqual(WhiteBalancePadMath.temperature(atFraction: x), 5600)
    let y = WhiteBalancePadMath.fraction(forTint: 35)
    XCTAssertEqual(WhiteBalancePadMath.tint(atFraction: y), 35)
  }

  func testPositionsAreWholeUnits() {
    XCTAssertEqual(WhiteBalancePadMath.temperature(atFraction: 0.1234), 3234)
    XCTAssertEqual(WhiteBalancePadMath.tint(atFraction: 0.61234), 34)
  }

  func testOutOfRangeInputStaysOnThePad() {
    XCTAssertEqual(WhiteBalancePadMath.temperature(atFraction: -0.5), 2000)
    XCTAssertEqual(WhiteBalancePadMath.tint(atFraction: 1.5), 150)
    XCTAssertEqual(WhiteBalancePadMath.fraction(forTemperature: 20000), 1)
    XCTAssertEqual(WhiteBalancePadMath.fraction(forTint: -400), 0)
  }

  func testPadWriteMatchesTheSliderWritesInTheSidecar() throws {
    var sampled = AdjustmentModel.default
    sampled.temperature = 5300
    sampled.tint = 12
    sampled.whiteBalancePreset = .custom
    sampled.wbSource = .sampled
    sampled.wbSampleX = 0.25
    sampled.wbSampleY = 0.75
    sampled.wbAlgorithmVersion = 1

    let fromPad = WhiteBalancePadMath.applying(temperature: 4800, tint: -9, to: sampled)
    var fromSliders = sampled
    ToolValueMapping.apply(4800, to: &fromSliders, tool: .temp)
    ToolValueMapping.apply(-9, to: &fromSliders, tool: .tint)

    XCTAssertEqual(fromPad, fromSliders)
    XCTAssertEqual(fromPad.temperature, 4800)
    XCTAssertEqual(fromPad.tint, -9)
    XCTAssertEqual(fromPad.wbSource, .manual)
    XCTAssertEqual(fromPad.whiteBalancePreset, .custom)
    XCTAssertEqual(fromPad.wbSampleX, 0)
    XCTAssertEqual(fromPad.wbSampleY, 0)
    XCTAssertEqual(fromPad.wbAlgorithmVersion, 0)
    XCTAssertEqual(
      XMPSerializer.serialize(model: fromPad, culling: CullingState()),
      XMPSerializer.serialize(model: fromSliders, culling: CullingState()))

    let (reopened, _) = try XMPParser.parse(
      XMPSerializer.serialize(model: fromPad, culling: CullingState()))
    XCTAssertEqual(reopened.temperature, 4800)
    XCTAssertEqual(reopened.tint, -9)
    XCTAssertEqual(reopened.wbSource, .manual)
  }

  func testAnUnmovedPairKeepsItsProvenance() {
    var sampled = AdjustmentModel.default
    sampled.temperature = 5300
    sampled.tint = 12
    sampled.wbSource = .sampled
    sampled.wbAlgorithmVersion = 1
    XCTAssertEqual(WhiteBalancePadMath.applying(temperature: 5300, tint: 12, to: sampled), sampled)
  }

  func testWritesClampToTheAdjustmentRanges() {
    let model = WhiteBalancePadMath.applying(
      temperature: 99_999, tint: -999, to: AdjustmentModel.default)
    XCTAssertEqual(model.temperature, 12000)
    XCTAssertEqual(model.tint, -150)
  }

  func testKeyStepsMoveOneAxisAndStopAtTheRange() {
    var model = AdjustmentModel.default
    model.temperature = 6500
    model.tint = 0
    let warmer = WhiteBalancePadMath.stepping(model, temperatureSteps: 1)
    XCTAssertEqual(warmer.temperature, 6600)
    XCTAssertEqual(warmer.tint, 0)
    let greener = WhiteBalancePadMath.stepping(model, tintSteps: -1)
    XCTAssertEqual(greener.temperature, 6500)
    XCTAssertEqual(greener.tint, -1)

    model.temperature = 11950
    XCTAssertEqual(WhiteBalancePadMath.stepping(model, temperatureSteps: 1).temperature, 12000)
    model.tint = -150
    XCTAssertEqual(WhiteBalancePadMath.stepping(model, tintSteps: -1).tint, -150)
  }

  func testAKeyStepBringsAStoredOutOfRangeAxisBackIntoRange() {
    var model = AdjustmentModel.default
    model.tint = 180
    let stepped = WhiteBalancePadMath.stepping(model, temperatureSteps: -1)
    XCTAssertEqual(stepped.temperature, model.temperature - 100)
    XCTAssertEqual(stepped.tint, 150)
  }

  func testOneGestureOfManyPadWritesIsOneUndoStep() {
    let session = EditSession.preview()
    let state = EditorState(session: session)
    let before = session.model

    state.commit(description: "White Balance")
    for tick in 1...120 {
      session.model = WhiteBalancePadMath.applying(
        temperature: 6500 - Double(tick) * 10, tint: Double(tick) / 4, to: session.model)
      XCTAssertTrue(session.undoHistory.isEmpty, "A pad sample must not allocate history")
    }
    state.endGesture()

    XCTAssertEqual(session.undoHistory.count, 1)
    XCTAssertEqual(session.model.temperature, 5300)
    XCTAssertEqual(session.model.tint, 30)
    XCTAssertEqual(session.model.wbSource, .manual)
    session.undo()
    XCTAssertEqual(session.model, before)
    session.redo()
    XCTAssertEqual(session.model.temperature, 5300)
    XCTAssertEqual(session.model.tint, 30)
  }

  func testAGestureThatWritesNothingLeavesNoHistory() {
    let session = EditSession.preview()
    let state = EditorState(session: session)
    state.commit(description: "White Balance")
    state.endGesture()
    XCTAssertTrue(session.undoHistory.isEmpty)
    XCTAssertFalse(session.canUndo)
  }
}
