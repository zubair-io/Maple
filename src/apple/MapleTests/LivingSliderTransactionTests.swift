import MapleCore
import XCTest

@testable import Maple_Exposure

@MainActor
final class LivingSliderTransactionTests: XCTestCase {
  func testFirstDragCreatesOneUndoEntryOnlyAtRelease() {
    let session = EditSession.preview()
    let state = EditorState(session: session)
    let slider = LivingSliderRow(state: state, tool: .exposure).slider

    slider.onEditingChanged?(true)
    for tick in 1...120 {
      slider.value = Double(tick) / 100
      XCTAssertTrue(session.undoHistory.isEmpty, "A drag tick must not allocate history")
    }
    // The release location can be newer than the final continuous sample.
    slider.value = 1.25
    slider.onEditingChanged?(false)
    XCTAssertEqual(session.undoHistory.count, 1)
    XCTAssertEqual(session.model.exposure, 1.25)
    session.undo()
    XCTAssertEqual(session.model.exposure, 0)
    session.redo()
    XCTAssertEqual(session.model.exposure, 1.25)
  }

  func testSeparateDragsPreserveTheirOwnBeforeValues() {
    let session = EditSession.preview()
    let state = EditorState(session: session)
    let slider = LivingSliderRow(state: state, tool: .exposure).slider

    for value in [0.4, 0.8] {
      slider.onEditingChanged?(true)
      slider.value = value
      slider.onEditingChanged?(false)
    }
    XCTAssertEqual(session.undoHistory.count, 2)
    session.undo()
    XCTAssertEqual(session.model.exposure, 0.4)
    session.undo()
    XCTAssertEqual(session.model.exposure, 0)
  }

  func testTouchWithoutValueChangeLeavesNoHistory() {
    let session = EditSession.preview()
    let state = EditorState(session: session)
    let slider = LivingSliderRow(state: state, tool: .exposure).slider
    slider.onEditingChanged?(true)
    slider.onEditingChanged?(false)
    XCTAssertTrue(session.undoHistory.isEmpty)
    XCTAssertFalse(session.canUndo)
  }

  func testCurveDragClosesOneTransactionWithItsFinalPoint() {
    let session = EditSession.preview()
    let state = EditorState(session: session, armedTool: .toneCurve)
    let plot = ToneCurveSection(state: state).curvePlot
    plot.onEditingChanged(true)
    for tick in 1...120 {
      plot.onChange([(x: 0, y: 0), (x: 0.5, y: Double(tick) / 200), (x: 1, y: 1)])
      XCTAssertTrue(session.undoHistory.isEmpty)
    }
    plot.onChange([(x: 0, y: 0), (x: 0.5, y: 0.65), (x: 1, y: 1)])
    plot.onEditingChanged(false)
    XCTAssertEqual(session.undoHistory.count, 1)
    XCTAssertEqual(session.model.toneCurveLuma.points[1].y, 0.65)
    session.undo()
    XCTAssertTrue(session.model.toneCurveLuma.isIdentity)
    session.redo()
    XCTAssertEqual(session.model.toneCurveLuma.points[1].y, 0.65)
  }

}
