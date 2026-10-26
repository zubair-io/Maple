import MapleCore
import XCTest

@testable import Maple

@MainActor
final class EditorPostureContinuityTests: XCTestCase {
  func testArmedToolAndModelSurviveCompactToOpenAndBack() {
    let session = EditSession.preview()
    let state = EditorState(session: session, subParamMemory: ToolSubParamMemory())
    state.arm(tool: .vibrance)

    for (width, regular, compact) in [
      (402.0, false, true),
      (951.0, true, false),
      (669.0, true, false),
      (402.0, false, true),
    ] {
      let layout = EditorLayout(
        width: CGFloat(width), idiom: .phone, regularHorizontalSizeClass: regular)
      XCTAssertEqual(layout.usesPhoneControls, compact)
      XCTAssertTrue(state.session === session)
      XCTAssertEqual(state.armedGroup, .color)
      XCTAssertEqual(state.armedTool, .vibrance)
    }
  }

  func testReflowDuringLiveSliderDragCommitsOneUndoableFinalValue() {
    let session = EditSession.preview()
    let state = EditorState(session: session, subParamMemory: ToolSubParamMemory())
    let compactSlider = LivingSliderRow(state: state, tool: .exposure).slider

    compactSlider.onEditingChanged?(true)
    for value in [0.25, 0.5, 0.75] {
      compactSlider.value = value
      XCTAssertTrue(session.undoHistory.isEmpty)
    }

    let openLayout = EditorLayout(
      width: 951, idiom: .phone, regularHorizontalSizeClass: true)
    XCTAssertFalse(openLayout.usesPhoneControls)
    XCTAssertEqual(state.armedTool, .exposure)
    XCTAssertEqual(session.model.exposure, 0.75)

    // LivingSlider.onDisappear closes the compact gesture when the control
    // family swaps; a final drag sample must survive that boundary.
    compactSlider.onEditingChanged?(false)
    XCTAssertEqual(session.undoHistory.count, 1)
    session.undo()
    XCTAssertEqual(session.model.exposure, 0)
    session.redo()
    XCTAssertEqual(session.model.exposure, 0.75)

    let openSlider = LivingSliderRow(state: state, tool: .exposure).slider
    openSlider.onEditingChanged?(true)
    openSlider.value = 1.0
    openSlider.onEditingChanged?(false)
    XCTAssertEqual(session.undoHistory.count, 2)
    session.undo()
    XCTAssertEqual(session.model.exposure, 0.75)
  }

  func testReflowFlushesDeferredSliderWithoutLosingArmedSubparameter() {
    let session = EditSession.preview()
    let state = EditorState(session: session, subParamMemory: ToolSubParamMemory())
    state.arm(tool: .noise)
    state.arm(subParamId: "deep")
    let before = session.model.deepDenoise
    let slider = LivingSliderRow(state: state, tool: .noise).slider

    slider.onEditingChanged?(true)
    slider.value = before + 10
    XCTAssertEqual(session.model.deepDenoise, before)
    XCTAssertEqual(state.deferredDisplayValue, before + 10)

    let openLayout = EditorLayout(
      width: 669, idiom: .phone, regularHorizontalSizeClass: true)
    XCTAssertFalse(openLayout.usesPhoneControls)
    XCTAssertEqual(state.armedTool, .noise)
    XCTAssertEqual(state.armedSubParamId, "deep")

    slider.onEditingChanged?(false)
    XCTAssertEqual(session.model.deepDenoise, before + 10)
    XCTAssertNil(state.deferredDisplayValue)
    XCTAssertEqual(session.undoHistory.count, 1)
    session.undo()
    XCTAssertEqual(session.model.deepDenoise, before)
    session.redo()
    XCTAssertEqual(session.model.deepDenoise, before + 10)
  }
}
