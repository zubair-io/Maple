import XCTest

@testable import MapleCore

@MainActor
final class BlackWhiteMixInteractionTests: XCTestCase {
  func testRepeatedMixTicksHaveOneUndoAndRetainBlackWhiteMode() {
    let session = EditSession.preview()
    let state = EditorState(session: session)
    state.setBlackWhite(.on)
    session.endEdit()
    let count = session.transactions.undoStack.count
    for value in [10.0, 20.0, 35.0] {
      state.setBlackWhiteMixValue(value, bandID: "red")
    }
    state.endGesture()
    XCTAssertEqual(session.model.grayMixerRed, 35)
    XCTAssertEqual(session.transactions.undoStack.count, count + 1)
    state.undo()
    XCTAssertEqual(session.model.grayMixerRed, 0)
    XCTAssertEqual(session.model.blackWhite, .on)
    state.redo()
    XCTAssertEqual(session.model.grayMixerRed, 35)
  }

  func testReleaseAndBandSwitchKeepDistinctUndoBoundaries() {
    let session = EditSession.preview()
    let state = EditorState(session: session)
    state.setBlackWhiteMixValue(20, bandID: "aqua")
    state.setBlackWhiteMixValue(30, bandID: "aqua")
    state.endGesture()
    state.setBlackWhiteMixValue(40, bandID: "aqua")
    // Arming another band interrupts the earlier gesture, as another row can.
    state.setBlackWhiteMixValue(-15, bandID: "blue")
    state.endGesture()
    state.undo()
    XCTAssertEqual(session.model.grayMixerBlue, 0)
    XCTAssertEqual(session.model.grayMixerAqua, 40)
    state.undo()
    XCTAssertEqual(session.model.grayMixerAqua, 30)
    state.undo()
    XCTAssertEqual(session.model.grayMixerAqua, 0)
  }

  func testNoOpAndUnknownBandDoNotClearRedoOrCreateHistory() {
    let session = EditSession.preview()
    let state = EditorState(session: session)
    state.setBlackWhiteMixValue(10, bandID: "magenta")
    state.endGesture()
    state.undo()
    state.setBlackWhiteMixValue(0, bandID: "magenta")
    state.setBlackWhiteMixValue(10, bandID: "unknown")
    state.endGesture()
    XCTAssertFalse(state.canUndo)
    XCTAssertTrue(state.canRedo)
  }
}
