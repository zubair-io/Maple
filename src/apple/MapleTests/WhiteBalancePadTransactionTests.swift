import MapleCore
import MapleUI
import XCTest

@testable import Maple

/// The editor's white-balance pad (#5121): one drag or one held arrow key
/// is one Undo step, written as the Temperature and Tint sliders write it.
@MainActor
final class WhiteBalancePadTransactionTests: XCTestCase {
  func testADragIsOneUndoEntryCarryingItsFinalPair() {
    let session = EditSession.preview()
    let state = EditorState(session: session)
    let before = session.model
    let pad = WhiteBalancePad(state: state).pad

    pad.onEditingChanged?(true)
    for tick in 1...120 {
      pad.value = MuiPad2DValue(x: -Double(tick) / 200, y: Double(tick) / 400)
      XCTAssertTrue(session.undoHistory.isEmpty, "A drag sample must not allocate history")
    }
    let release = MuiPad2DValue(x: -0.5, y: 0.25)
    pad.value = release
    pad.onEditingChanged?(false)

    let pair = WhiteBalancePad.pair(at: release)
    XCTAssertEqual(pair.temperature, 4500)
    XCTAssertEqual(pair.tint, 38)
    XCTAssertEqual(session.undoHistory.count, 1)
    XCTAssertEqual(session.model.temperature, pair.temperature)
    XCTAssertEqual(session.model.tint, pair.tint)
    XCTAssertEqual(session.model.wbSource, .manual)
    XCTAssertEqual(session.model.whiteBalancePreset, .custom)
    session.undo()
    XCTAssertEqual(session.model, before)
    session.redo()
    XCTAssertEqual(session.model.temperature, pair.temperature)
    XCTAssertEqual(session.model.tint, pair.tint)
  }

  func testThePuckShowsTheStoredPair() {
    let session = EditSession.preview()
    session.model.temperature = 4500
    session.model.tint = 75
    let pad = WhiteBalancePad(state: EditorState(session: session)).pad
    XCTAssertEqual(pad.value.x, -0.5, accuracy: 1e-9)
    XCTAssertEqual(pad.value.y, 0.5, accuracy: 1e-9)
    XCTAssertEqual(pad.valueText, "Temperature 4500 K, tint +75")
  }

  func testAPadWriteEqualsTheTwoSliderWrites() {
    let padSession = EditSession.preview()
    let pad = WhiteBalancePad(state: EditorState(session: padSession)).pad
    pad.onEditingChanged?(true)
    pad.value = MuiPad2DValue(x: 0.3, y: -0.2)
    pad.onEditingChanged?(false)

    let sliderSession = EditSession.preview()
    let sliders = EditorState(session: sliderSession)
    for (tool, value) in [(Tool.temp, 8500.0), (Tool.tint, -30.0)] {
      let slider = LivingSliderRow(state: sliders, tool: tool).slider
      slider.onEditingChanged?(true)
      slider.value = value
      slider.onEditingChanged?(false)
    }

    XCTAssertEqual(padSession.model, sliderSession.model)
    XCTAssertEqual(
      XMPSerializer.serialize(model: padSession.model, culling: CullingState()),
      XMPSerializer.serialize(model: sliderSession.model, culling: CullingState()))
  }

  /// A held key repeats between one key-down and one key-up.
  func testAHeldArrowKeyIsOneUndoEntry() {
    let session = EditSession.preview()
    let state = EditorState(session: session)
    let before = session.model
    let pad = WhiteBalancePad(state: state).pad

    pad.onEditingChanged?(true)
    for _ in 1...3 { pad.onStep?(.right) }
    pad.onStep?(.down)
    pad.onEditingChanged?(false)

    XCTAssertEqual(session.undoHistory.count, 1)
    XCTAssertEqual(session.model.temperature, before.temperature + 300)
    XCTAssertEqual(session.model.tint, before.tint - 1)
    session.undo()
    XCTAssertEqual(session.model, before)
  }

  func testSeparateDragsKeepTheirOwnBeforeValues() {
    let session = EditSession.preview()
    let state = EditorState(session: session)
    let before = session.model
    let pad = WhiteBalancePad(state: state).pad

    for x in [-0.5, 0.5] {
      pad.onEditingChanged?(true)
      pad.value = MuiPad2DValue(x: x, y: 0)
      pad.onEditingChanged?(false)
    }
    XCTAssertEqual(session.undoHistory.count, 2)
    session.undo()
    XCTAssertEqual(session.model.temperature, 4500)
    session.undo()
    XCTAssertEqual(session.model, before)
  }

  func testATouchThatMovesNothingLeavesNoHistory() {
    let session = EditSession.preview()
    let pad = WhiteBalancePad(state: EditorState(session: session)).pad
    pad.onEditingChanged?(true)
    pad.value = pad.value
    pad.onEditingChanged?(false)
    XCTAssertTrue(session.undoHistory.isEmpty)
    XCTAssertFalse(session.canUndo)
  }

  func testThePadIsOffWhileTheOriginalIsShown() {
    let session = EditSession.preview()
    let state = EditorState(session: session)
    XCTAssertFalse(WhiteBalancePad(state: state).pad.disabled)
    session.showingOriginal = true
    XCTAssertTrue(WhiteBalancePad(state: state).pad.disabled)
  }
}
