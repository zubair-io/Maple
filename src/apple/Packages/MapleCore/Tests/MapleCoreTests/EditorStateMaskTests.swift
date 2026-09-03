// EditorStateMaskTests.swift — the mask-editing session on EditorState
// (#355): selection, add/remove, undo boundaries, the arm hook.

import XCTest

@testable import MapleCore

@MainActor
final class EditorStateMaskTests: XCTestCase {
    private func makeState() -> EditorState {
        EditorState(session: EditSession.preview())
    }

    func testMaskToolIsAnUnwiredDetailTool() {
        XCTAssertEqual(Tool.mask.group, .detail)
        XCTAssertFalse(Tool.mask.isWired)
        XCTAssertNil(ToolValueMapping.displayRange(for: .mask))
        XCTAssertTrue(Tool.tools(in: .detail).contains(.mask))
    }

    func testAddSelectsTheNewLayerAndPushesOneUndoEntry() {
        let state = makeState()
        XCTAssertNil(state.selectedMask)
        let index = state.addLinearMask()
        XCTAssertEqual(index, 0)
        XCTAssertEqual(state.selectedMaskIndex, 0)
        XCTAssertEqual(state.session.model.localAdjustments.count, 1)
        XCTAssertTrue(state.canUndo)
        state.undo()
        XCTAssertTrue(state.session.model.localAdjustments.isEmpty)
        XCTAssertNil(state.selectedMask, "a stale index reads as no selection")
    }

    func testRadialDefaultUsesTheImageAspect() {
        let state = makeState()
        state.addRadialMask()
        guard case .radial(let center, _, _, _, _) = state.selectedMask!.mask else { return XCTFail("expected radial") }
        XCTAssertEqual(center, MaskPoint(x: 0.5, y: 0.5))
    }

    func testRemoveMovesSelectionToTheNearestSurvivor() {
        let state = makeState()
        state.addLinearMask()
        state.addRadialMask()
        state.addLinearMask()
        state.selectMask(2)
        state.removeMask(at: 2)
        XCTAssertEqual(state.selectedMaskIndex, 1)
        state.removeSelectedMask()
        XCTAssertEqual(state.selectedMaskIndex, 0)
        state.removeSelectedMask()
        XCTAssertNil(state.selectedMaskIndex)
        XCTAssertTrue(state.session.model.localAdjustments.isEmpty)
    }

    func testSelectRejectsAnOutOfRangeIndex() {
        let state = makeState()
        state.addLinearMask()
        state.selectMask(5)
        XCTAssertNil(state.selectedMaskIndex)
        state.selectMask(0)
        XCTAssertEqual(state.selectedMaskIndex, 0)
    }

    func testContinuousEditsShareOneUndoEntryPerGesture() {
        let state = makeState()
        state.addLinearMask()
        // Add = 1 entry. Now a "drag" of three writes.
        state.setMaskAdjustment(\.exposure, 0.25)
        state.setMaskAdjustment(\.exposure, 0.5)
        state.setMaskAdjustment(\.exposure, 0.75)
        state.endMaskGesture()
        XCTAssertEqual(state.maskAdjustment(\.exposure), 0.75)
        state.undo()
        XCTAssertNil(state.selectedMask?.adjustments.exposure, "one undo reverts the whole drag")
        XCTAssertEqual(state.session.model.localAdjustments.count, 1, "…but not the add")
    }

    func testDiscreteEditsCommitTheirOwnEntry() {
        let state = makeState()
        state.addRadialMask()
        state.setSelectedMaskInverted(true)
        guard case .radial(_, _, _, _, let invert) = state.selectedMask!.mask else { return XCTFail("expected radial") }
        XCTAssertTrue(invert)
        state.setMaskAdjustment(\.contrast, 20)
        state.endMaskGesture()
        state.resetSelectedMaskAdjustments()
        XCTAssertTrue(state.selectedMask!.adjustments.isEmpty)
        state.undo()
        XCTAssertEqual(state.maskAdjustment(\.contrast), 20)
        state.undo()
        XCTAssertNil(state.selectedMask?.adjustments.contrast)
        state.undo()
        guard case .radial(_, _, _, _, let invertBefore) = state.selectedMask!.mask else { return XCTFail("expected radial") }
        XCTAssertFalse(invertBefore)
    }

    func testFeatherIsClampedAndInvertIsANoOpOnLinear() {
        let state = makeState()
        state.addLinearMask()
        state.setSelectedMaskFeather(1.7)
        state.setSelectedMaskInverted(true)
        guard case .linear(_, _, let feather) = state.selectedMask!.mask else { return XCTFail("shape changed") }
        XCTAssertEqual(feather, 1)
    }

    func testShapeDragWritesThroughTheOpenGesture() {
        let state = makeState()
        state.addLinearMask()
        let moved = LocalMask.linear(start: MaskPoint(x: 0.1, y: 0.1), end: MaskPoint(x: 0.9, y: 0.9), feather: 0.5)
        state.setSelectedMaskShape(moved)
        state.endMaskGesture()
        XCTAssertEqual(state.selectedMask?.mask, moved)
    }

    func testArmingMaskSelectsTheFirstLayerWhenNothingIsSelected() {
        let state = makeState()
        state.session.model.localAdjustments = [
            LocalAdjustment(mask: MaskGeometry.defaultLinear(), adjustments: PartialAdjustments()),
        ]
        state.arm(tool: .mask)
        XCTAssertEqual(state.armedTool, .mask)
        XCTAssertEqual(state.armedGroup, .detail)
        XCTAssertEqual(state.selectedMaskIndex, 0)
        XCTAssertFalse(state.armedToolAcceptsValueEdits)
    }

    func testStripDropsTheLayerStackFromTheDecodeModel() {
        var model = AdjustmentModel()
        model.localAdjustments = [
            LocalAdjustment(mask: MaskGeometry.defaultLinear(), adjustments: PartialAdjustments(exposure: 1)),
        ]
        XCTAssertTrue(RawCoreBridge.stripAppleGPUStages(model).localAdjustments.isEmpty)
    }
}
