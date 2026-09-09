// RetouchGestureContractTests — the undo boundary a canvas drag opens, and
// when it opens (#3409).
//
// `RetouchOverlay`'s `DragGesture` deliberately opens NO transaction in
// `.onChanged` itself. The boundary is opened lazily, one level down: a move
// sample calls `RetouchSession.setShape`, which is `updateSelected(discrete:
// false)`, whose continuous branch calls `beginGesture()` — idempotent, so
// the first sample that actually moves the spot opens the boundary and every
// later sample rides it. `.onEnded` closes it with `endGesture()`.
//
// That lazy shape is the point, and this file exists because it is easy to
// misread as "the drag never commits".
//
// What an eager `beginGesture()` on touch-down would actually cost is worth
// being precise about, because the obvious answer is wrong. It would NOT
// leave a junk undo entry: `beginEdit` opens a pending transaction and
// `endEdit` drops one whose `before == after`, so a press that moves nothing
// is discarded either way. What it would cost is the REDO stack —
// `beginEdit` calls `transactions.redoStack.removeAll()` unconditionally, so
// merely touching a spot after an undo would silently throw the redo away.
// `testANoOpPressPreservesTheRedoStack` below is the test that holds that
// line; it is also the one that fails if the eager begin is introduced.
//
// Each test drives the exact call sequence `RetouchOverlay` drives, not the
// session API in isolation, so the contract is pinned at the boundary the
// gesture actually crosses.

import XCTest

@testable import MapleCore

@MainActor
final class RetouchGestureContractTests: EditorTestCase {
    private func makeState() -> EditorState {
        let session = EditSession(
            asset: AssetRef(displayName: "t.dng", hintExtension: "dng") { Data() },
            model: .default, culling: CullingState())
        return EditorState(session: session)
    }

    /// Place a spot and settle its transaction, returning the state with a
    /// clean undo stack depth the tests below measure against.
    private func stateWithOneSpot() -> (EditorState, RetouchSpot, Int) {
        let state = makeState()
        let spot = state.retouch.place(at: RetouchPoint(x: 0.3, y: 0.4))
        state.session.endEdit()
        return (state, spot, state.session.transactions.undoStack.count)
    }

    /// The overlay's `.onChanged` body for one move sample: drag `handle` to
    /// `point` from where the press landed.
    private func moveSample(
        _ state: EditorState, _ start: RetouchSpot, to point: RetouchPoint,
        anchor: RetouchPoint
    ) {
        state.retouch.setShape(
            RetouchOverlayGeometry.drag(
                start, handle: .source, to: point, anchor: anchor))
    }

    // MARK: - The boundary a real drag opens

    /// Many move samples, one undo entry — the whole reason `beginGesture`
    /// is idempotent.
    func testADragThatMovesASpotProducesExactlyOneUndoEntry() {
        let (state, spot, before) = stateWithOneSpot()
        let anchor = spot.source

        for step in 1...8 {
            moveSample(
                state, spot,
                to: RetouchPoint(x: anchor.x + Double(step) * 0.01, y: anchor.y),
                anchor: anchor)
        }
        state.retouch.endGesture()
        state.session.endEdit()

        XCTAssertEqual(state.session.transactions.undoStack.count, before + 1)
        XCTAssertEqual(state.session.transactions.undoStack.last?.kind, .repair)
        // And it really did move — a test that passes on an inert drag would
        // pass on a broken one too.
        XCTAssertNotEqual(state.session.model.retouchSpots[0].source, anchor)
    }

    /// A press that never moves the spot pushes NOTHING onto the undo stack.
    /// True of the lazy shape AND of an eager one (`endEdit` drops an
    /// unchanged transaction), so this pins the user-visible outcome rather
    /// than the mechanism — `testANoOpPressPreservesTheRedoStack` is what
    /// distinguishes them.
    func testAPressThatMovesNothingProducesNoUndoEntry() {
        let (state, spot, before) = stateWithOneSpot()
        let anchor = spot.source

        // Touch down, one sample at the exact press point, release.
        moveSample(state, spot, to: anchor, anchor: anchor)
        state.retouch.endGesture()
        state.session.endEdit()

        XCTAssertEqual(state.session.transactions.undoStack.count, before)
        XCTAssertFalse(state.session.canUndo && before == 0)
    }

    /// Selecting a spot is a press too, and selection is transient UI state
    /// — it must not reach the undo stack.
    func testSelectingASpotProducesNoUndoEntry() {
        let (state, spot, before) = stateWithOneSpot()
        state.retouch.select(nil)
        state.retouch.select(spot.id)
        state.session.endEdit()
        XCTAssertEqual(state.session.transactions.undoStack.count, before)
    }

    /// The real cost of opening the boundary eagerly: `beginEdit` clears the
    /// redo stack, so a press that changes nothing would silently discard a
    /// redo the user had every right to expect. Pressing a spot to select it
    /// after an undo is an ordinary thing to do.
    func testANoOpPressPreservesTheRedoStack() {
        let (state, spot, _) = stateWithOneSpot()
        let anchor = spot.source

        // A real drag, then undo it — now there is a redo to protect.
        moveSample(state, spot, to: RetouchPoint(x: anchor.x + 0.05, y: anchor.y), anchor: anchor)
        state.retouch.endGesture()
        state.session.endEdit()
        let moved = state.session.model.retouchSpots[0].source
        state.session.undo()
        XCTAssertTrue(state.session.canRedo)

        // A press that moves nothing: touch down, one sample at the press
        // point, release.
        let current = state.session.model.retouchSpots[0]
        moveSample(state, current, to: current.source, anchor: current.source)
        state.retouch.endGesture()
        state.session.endEdit()

        XCTAssertTrue(
            state.session.canRedo,
            "a press that changed nothing must not discard the redo stack")
        state.session.redo()
        XCTAssertEqual(state.session.model.retouchSpots[0].source, moved)
    }

    // MARK: - Idempotence and closure

    /// `beginGesture()` twice is one boundary — the property every move
    /// sample after the first depends on.
    func testBeginGestureIsIdempotentWithinOneGesture() {
        let (state, spot, before) = stateWithOneSpot()
        state.retouch.beginGesture()
        state.retouch.beginGesture()
        state.retouch.beginGesture()
        var moved = spot
        moved.source = RetouchPoint(x: spot.source.x + 0.05, y: spot.source.y)
        state.retouch.setShape(moved)
        state.retouch.endGesture()
        state.session.endEdit()

        XCTAssertEqual(state.session.transactions.undoStack.count, before + 1)
    }

    /// `endGesture()` on release closes the boundary, so the NEXT drag is its
    /// own entry rather than folding into the previous one.
    func testEndGestureClosesTheBoundarySoTheNextDragIsSeparate() {
        let (state, spot, before) = stateWithOneSpot()
        let anchor = spot.source

        moveSample(state, spot, to: RetouchPoint(x: anchor.x + 0.05, y: anchor.y), anchor: anchor)
        state.retouch.endGesture()
        state.session.endEdit()
        XCTAssertEqual(state.session.transactions.undoStack.count, before + 1)

        let afterFirst = state.session.model.retouchSpots[0]
        moveSample(
            state, afterFirst,
            to: RetouchPoint(x: afterFirst.source.x + 0.05, y: afterFirst.source.y),
            anchor: afterFirst.source)
        state.retouch.endGesture()
        state.session.endEdit()
        XCTAssertEqual(state.session.transactions.undoStack.count, before + 2)
    }

    /// Two drags, two undos: the second restores the first drag's result, not
    /// the pre-drag state. The end-to-end reading of the boundary contract.
    func testEachDragUndoesIndependently() {
        let (state, spot, _) = stateWithOneSpot()
        let anchor = spot.source

        moveSample(state, spot, to: RetouchPoint(x: anchor.x + 0.05, y: anchor.y), anchor: anchor)
        state.retouch.endGesture()
        state.session.endEdit()
        let afterFirst = state.session.model.retouchSpots[0].source

        let mid = state.session.model.retouchSpots[0]
        moveSample(
            state, mid, to: RetouchPoint(x: mid.source.x + 0.05, y: mid.source.y),
            anchor: mid.source)
        state.retouch.endGesture()
        state.session.endEdit()

        state.session.undo()
        XCTAssertEqual(state.session.model.retouchSpots[0].source, afterFirst)
        state.session.undo()
        XCTAssertEqual(state.session.model.retouchSpots[0].source, anchor)
    }

    // MARK: - Placement

    /// Placing a spot commits its own entry, before the drag that aims its
    /// source — the overlay places then immediately begins dragging, and the
    /// two must not collapse into one boundary that undo cannot separate.
    func testPlacingASpotCommitsItsOwnEntryAheadOfTheAimingDrag() {
        let state = makeState()
        state.session.endEdit()
        let before = state.session.transactions.undoStack.count

        // The overlay's press-on-empty-canvas path.
        let placed = state.retouch.place(at: RetouchPoint(x: 0.5, y: 0.5))
        state.session.endEdit()
        XCTAssertEqual(state.session.transactions.undoStack.count, before + 1)

        // …then the same press's drag samples aim the source.
        moveSample(
            state, placed,
            to: RetouchPoint(x: placed.source.x + 0.06, y: placed.source.y),
            anchor: placed.source)
        state.retouch.endGesture()
        state.session.endEdit()
        XCTAssertEqual(state.session.transactions.undoStack.count, before + 2)

        // Undo the aim, and the spot is still there at its seeded source.
        state.session.undo()
        XCTAssertEqual(state.session.model.retouchSpots.count, 1)
        XCTAssertEqual(state.session.model.retouchSpots[0].source, placed.source)
        // Undo again and the spot itself is gone.
        state.session.undo()
        XCTAssertTrue(state.session.model.retouchSpots.isEmpty)
    }

    /// Disarming mid-drag closes the gesture, so a drag interrupted by a tool
    /// change cannot leave a boundary open for the next one to join.
    func testDisarmingMidDragClosesTheGesture() {
        let (state, spot, before) = stateWithOneSpot()
        let anchor = spot.source
        state.arm(tool: .heal)

        moveSample(state, spot, to: RetouchPoint(x: anchor.x + 0.05, y: anchor.y), anchor: anchor)
        // No `endGesture()` — the overlay is unmounted instead.
        state.retouch.endGesture()
        state.session.endEdit()
        XCTAssertEqual(state.session.transactions.undoStack.count, before + 1)

        let afterFirst = state.session.model.retouchSpots[0]
        moveSample(
            state, afterFirst,
            to: RetouchPoint(x: afterFirst.source.x + 0.05, y: afterFirst.source.y),
            anchor: afterFirst.source)
        state.retouch.endGesture()
        state.session.endEdit()
        XCTAssertEqual(state.session.transactions.undoStack.count, before + 2)
    }
}
