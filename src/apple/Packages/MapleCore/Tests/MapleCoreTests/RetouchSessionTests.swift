// RetouchSessionTests — the clone / heal session (#3409): placement,
// selection, the brush, undo boundaries, and the decode-scope invalidation
// that makes repair a decode-product edit. Mirrors the web
// `retouch-session.service.spec.ts`.

import XCTest

@testable import MapleCore

@MainActor
final class RetouchSessionTests: EditorTestCase {
    private func makeState() -> EditorState {
        let session = EditSession(
            asset: AssetRef(displayName: "t.dng", hintExtension: "dng") { Data() },
            model: .default, culling: CullingState())
        return EditorState(session: session)
    }

    func testHealIsAnUnwiredDetailToolTheDragBarRejects() {
        XCTAssertEqual(Tool.heal.group, .detail)
        XCTAssertFalse(Tool.heal.isWired)
        let state = makeState()
        state.arm(tool: .heal)
        XCTAssertEqual(state.armedTool, .heal)
    }

    func testPlacingASpotSelectsItAndSeedsAnOffsetSource() {
        let state = makeState()
        let spot = state.retouch.place(at: RetouchPoint(x: 0.4, y: 0.6))
        XCTAssertEqual(state.session.model.retouchSpots.count, 1)
        XCTAssertEqual(state.retouch.selectedSpotID, spot.id)
        XCTAssertEqual(spot.center, RetouchPoint(x: 0.4, y: 0.6))
        // A spot whose source sits on its destination samples itself and
        // renders nothing, so the seed must be offset.
        XCTAssertGreaterThan(spot.source.x, spot.center.x)
        XCTAssertTrue(spot.isEffective)
    }

    func testPlacingCommitsOneRepairTransactionScopedToDecode() {
        let state = makeState()
        state.retouch.place(at: RetouchPoint(x: 0.4, y: 0.6))
        state.session.endEdit()
        let tx = state.session.transactions.undoStack.last
        XCTAssertEqual(tx?.kind, .repair)
        XCTAssertEqual(tx?.invalidation, .decode)
    }

    /// The scope classification is what makes a spot edit re-decode; assert
    /// it directly so a regression names itself.
    func testAnySpotChangeClassifiesAsDecode() {
        var before = AdjustmentModel.default
        var after = before
        after.retouchSpots = [
            RetouchSpot(
                kind: .heal,
                center: RetouchPoint(x: 0.25, y: 0.5),
                source: RetouchPoint(x: 0.75, y: 0.5),
                radius: 0.05)
        ]
        XCTAssertEqual(InvalidationScope.classify(from: before, to: after), .decode)
        before.retouchSpots = after.retouchSpots
        XCTAssertEqual(InvalidationScope.classify(from: before, to: after), .none)
    }

    func testUndoRemovesThePlacedSpot() {
        let state = makeState()
        state.retouch.place(at: RetouchPoint(x: 0.4, y: 0.6))
        state.session.endEdit()
        state.session.undo()
        XCTAssertTrue(state.session.model.retouchSpots.isEmpty)
    }

    func testTheBrushSeedsANewSpotAndRewritesTheSelectedOne() {
        let state = makeState()
        state.retouch.setKind(.clone)
        state.retouch.setRadius(0.08)
        state.retouch.setFeather(0.25)
        state.retouch.setOpacity(0.5)
        state.retouch.place(at: RetouchPoint(x: 0.3, y: 0.3))
        let placed = state.session.model.retouchSpots[0]
        XCTAssertEqual(placed.kind, .clone)
        XCTAssertEqual(placed.radius, 0.08, accuracy: 1e-9)
        XCTAssertEqual(placed.feather, 0.25, accuracy: 1e-9)
        XCTAssertEqual(placed.opacity, 0.5, accuracy: 1e-9)
        state.retouch.setOpacity(0.9)
        XCTAssertEqual(state.session.model.retouchSpots[0].opacity, 0.9, accuracy: 1e-9)
    }

    func testSelectingASpotLoadsItsShapeIntoTheBrush() {
        let state = makeState()
        state.retouch.setRadius(0.03)
        let first = state.retouch.place(at: RetouchPoint(x: 0.2, y: 0.2))
        // Deselect first: a brush change with a spot selected deliberately
        // rewrites that spot.
        state.retouch.select(nil)
        state.retouch.setRadius(0.09)
        state.retouch.place(at: RetouchPoint(x: 0.7, y: 0.7))
        XCTAssertEqual(state.retouch.brushRadius, 0.09, accuracy: 1e-9)
        state.retouch.select(first.id)
        XCTAssertEqual(state.retouch.brushRadius, 0.03, accuracy: 1e-9)
    }

    func testOneContinuousGestureIsOneUndoEntry() {
        let state = makeState()
        let spot = state.retouch.place(at: RetouchPoint(x: 0.4, y: 0.6))
        state.session.endEdit()
        let before = state.session.transactions.undoStack.count
        var moved = spot
        moved.source = RetouchPoint(x: 0.9, y: 0.6)
        state.retouch.setShape(moved)
        moved.source = RetouchPoint(x: 0.92, y: 0.6)
        state.retouch.setShape(moved)
        state.retouch.endGesture()
        state.session.endEdit()
        XCTAssertEqual(state.session.transactions.undoStack.count, before + 1)
    }

    func testARedundantWritePushesNothing() {
        let state = makeState()
        let spot = state.retouch.place(at: RetouchPoint(x: 0.4, y: 0.6))
        state.session.endEdit()
        let before = state.session.transactions.undoStack.count
        state.retouch.setShape(spot)
        state.session.endEdit()
        XCTAssertEqual(state.session.transactions.undoStack.count, before)
    }

    func testDeleteKeepsTheSelectionInRangeAndResetDropsEverything() {
        let state = makeState()
        state.retouch.place(at: RetouchPoint(x: 0.2, y: 0.2))
        let second = state.retouch.place(at: RetouchPoint(x: 0.5, y: 0.5))
        let third = state.retouch.place(at: RetouchPoint(x: 0.8, y: 0.8))
        state.retouch.delete(third.id)
        XCTAssertEqual(state.session.model.retouchSpots.count, 2)
        XCTAssertEqual(state.retouch.selectedSpotID, second.id)
        state.retouch.resetAll()
        XCTAssertTrue(state.session.model.retouchSpots.isEmpty)
        XCTAssertNil(state.retouch.selectedSpotID)
    }

    /// Repair spots are a decode-product field `stripAppleGPUStages` must
    /// NOT clear — the decode is the only place they can be applied.
    func testStripAppleGPUStagesKeepsRepairSpots() {
        var model = AdjustmentModel.default
        model.retouchSpots = [
            RetouchSpot(
                kind: .heal,
                center: RetouchPoint(x: 0.25, y: 0.5),
                source: RetouchPoint(x: 0.75, y: 0.5),
                radius: 0.05)
        ]
        model.localAdjustments = []
        let stripped = RawCoreBridge.stripAppleGPUStages(model)
        XCTAssertEqual(stripped.retouchSpots, model.retouchSpots)
    }
}
