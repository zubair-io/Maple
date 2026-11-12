import XCTest

@testable import MapleCore

/// The step between two states of the edit history (#5122): what the editor
/// confirms with a haptic, and what it must stay silent for.
@MainActor
final class EditHistoryEventTests: XCTestCase {
  private func mark(
    _ depth: Int, newest: UInt64, _ kind: EditTransaction.Kind? = .adjustment, loaded: Bool = true
  ) -> EditHistoryMark {
    EditHistoryMark(depth: depth, newestID: newest, lastKind: kind, isLoaded: loaded)
  }

  func testACommitBringsANewTransactionID() {
    XCTAssertEqual(
      EditHistoryEvent.between(mark(0, newest: 0, nil), mark(1, newest: 1, .auto)), .commit(.auto))
    XCTAssertEqual(
      EditHistoryEvent.between(mark(3, newest: 7), mark(4, newest: 8, .preset)), .commit(.preset))
  }

  func testACommitIntoAFullRingKeepsItsDepth() {
    let cap = EditSession.undoStackCap
    XCTAssertEqual(
      EditHistoryEvent.between(mark(cap, newest: 40), mark(cap, newest: 41, .reset)),
      .commit(.reset))
  }

  func testUndoAndRedoMoveOneEntryWithoutANewID() {
    XCTAssertEqual(EditHistoryEvent.between(mark(4, newest: 8), mark(3, newest: 8)), .undo)
    XCTAssertEqual(EditHistoryEvent.between(mark(3, newest: 8), mark(4, newest: 8)), .redo)
  }

  func testACommitAfterAnUndoIsACommitNotARedo() {
    // Undone entry 8 sits on the redo stack; the new edit is 9.
    XCTAssertEqual(
      EditHistoryEvent.between(mark(3, newest: 8), mark(4, newest: 9, .paste)), .commit(.paste))
  }

  func testAnUnchangedHistoryIsNoEvent() {
    XCTAssertNil(EditHistoryEvent.between(mark(4, newest: 8), mark(4, newest: 8)))
  }

  func testLoadingOrSwappingAHistoryIsNoEvent() {
    // The saved sidecar arrives; another session's history is adopted.
    XCTAssertNil(
      EditHistoryEvent.between(mark(0, newest: 0, nil, loaded: false), mark(1, newest: 5, .auto)))
    XCTAssertNil(EditHistoryEvent.between(mark(0, newest: 0, nil), mark(6, newest: 12, .auto)))
    // A reload drops the ring.
    XCTAssertNil(EditHistoryEvent.between(mark(6, newest: 12), mark(0, newest: 0, nil)))
    XCTAssertNil(EditHistoryEvent.between(mark(6, newest: 12), mark(2, newest: 12)))
  }

  func testOnlyOneTapEditsLandAtOnce() {
    let atOnce = EditTransaction.Kind.allCases.filter(\.landsAtOnce)
    XCTAssertEqual(Set(atOnce), [.auto, .paste, .preset, .reset, .variant])
  }

  func testASessionReportsEachStepOfItsHistory() {
    let session = EditSession.preview()
    session.hasLoadedSidecar = true
    let state = EditorState(session: session)
    var marks = [session.editHistoryMark]
    func step() -> EditHistoryEvent? {
      marks.append(session.editHistoryMark)
      return EditHistoryEvent.between(marks[marks.count - 2], marks[marks.count - 1])
    }

    state.commit()
    session.model.exposure = 0.5
    XCTAssertNil(step(), "an open gesture has not committed")
    state.endGesture()
    XCTAssertEqual(step(), .commit(.adjustment))

    // Undoing the transaction that is already the last committed one.
    session.undo()
    XCTAssertEqual(step(), .undo)
    session.redo()
    XCTAssertEqual(step(), .redo)

    state.resetToFactoryDefaults()
    XCTAssertEqual(step(), .commit(.reset))
    session.undo()
    XCTAssertEqual(step(), .undo)
    session.undo()
    XCTAssertEqual(step(), .undo)
    XCTAssertEqual(session.editHistoryMark.depth, 0)

    state.commit()
    session.model.contrast = 10
    state.endGesture()
    XCTAssertEqual(step(), .commit(.adjustment), "a commit after undos is not a redo")
  }

  func testAnUndoOfTheCurrentTransactionNotifiesObservers() {
    let session = EditSession.preview()
    session.hasLoadedSidecar = true
    let state = EditorState(session: session)
    state.commit()
    session.model.exposure = 0.5
    state.endGesture()

    let notified = expectation(description: "the mark's observer hears the undo")
    withObservationTracking {
      _ = session.editHistoryMark
    } onChange: {
      notified.fulfill()
    }
    session.undo()
    wait(for: [notified], timeout: 1)
  }
}
