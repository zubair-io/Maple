// EditorStateTests.swift — responsive-program S5 (#625).
//
// Covers:
//   • arm(tool:) / arm(group:) — tool ↔ group cross-arming
//   • Value pipe — armed value mirrors EditSession.model, write applies
//   • commit() snapshots through EditSession.beginEdit (the undo path)
//   • Undo ring cap-32 (FIFO trim on EditSession)
//   • Tool ↔ AdjustmentModel field wiring per ToolValueMapping
//
// All tests are MainActor — EditSession + EditorState are both
// MainActor-isolated.

import XCTest
@testable import MapleCore

@MainActor
final class EditorStateTests: XCTestCase {
    // MARK: - Helpers

    private func makeSession() -> EditSession {
        EditSession.preview()
    }

    // MARK: - Arming

    func testInitDefaultsToLightExposure() {
        let state = EditorState(session: makeSession())
        XCTAssertEqual(state.armedGroup, .light)
        XCTAssertEqual(state.armedTool, .exposure)
    }

    func testArmToolSwitchesGroupAutomatically() {
        let state = EditorState(session: makeSession())
        state.arm(tool: .clarity)
        XCTAssertEqual(state.armedTool, .clarity)
        XCTAssertEqual(state.armedGroup, .effects)
    }

    func testArmGroupRetainsToolWhenStillAMember() {
        let state = EditorState(session: makeSession(), armedGroup: .light, armedTool: .shadows)
        state.arm(group: .light)
        XCTAssertEqual(state.armedTool, .shadows)
    }

    func testArmGroupSwitchesToolWhenLeavingGroup() {
        let state = EditorState(session: makeSession(), armedGroup: .light, armedTool: .exposure)
        state.arm(group: .color)
        XCTAssertEqual(state.armedGroup, .color)
        // First tool in Color is temp per Tool.tools(in: .color).
        XCTAssertEqual(state.armedTool, .temp)
    }

    // MARK: - Value pipe

    func testSetArmedDisplayValueWritesToModel() {
        let state = EditorState(session: makeSession())
        state.arm(tool: .exposure)
        state.setArmedDisplayValue(0.5)
        XCTAssertEqual(state.session.model.exposure, 0.5, accuracy: 1e-9)
        XCTAssertEqual(state.armedDisplayValue, 0.5, accuracy: 1e-9)
    }

    func testSetArmedInternalValueMapsThroughToolRange() {
        let state = EditorState(session: makeSession())
        // Exposure: internal +100 → display +4.0 EV (spec §3).
        state.arm(tool: .exposure)
        state.setArmedInternalValue(100)
        XCTAssertEqual(state.session.model.exposure, 4.0, accuracy: 1e-9)

        // Tint: internal -50 → display -50 (1:1 for symmetric ±100 tools).
        state.arm(tool: .tint)
        state.setArmedInternalValue(-50)
        XCTAssertEqual(state.session.model.tint, -50, accuracy: 1e-9)

        // Temp: internal +50 → display 9250 K (6500 + 0.5*(12000-6500)).
        state.arm(tool: .temp)
        state.setArmedInternalValue(50)
        XCTAssertEqual(state.session.model.temperature, 9250, accuracy: 1e-9)
    }

    func testStubToolWriteIsNoOp() {
        let state = EditorState(session: makeSession())
        state.arm(tool: .crop)
        // No crop field on AdjustmentModel yet — write must not crash
        // and must not mutate any wired field. (Per #643: vignette,
        // grain, splitTone are now wired; HSL/Crop/Presets remain
        // stubs pending their own specs.)
        let before = state.session.model
        state.setArmedDisplayValue(50)
        XCTAssertEqual(state.session.model, before)
    }

    func testS5EffectsToolsAreWired() {
        // Per #643: vignette / grain / splitTone gained AdjustmentModel
        // fields and are no longer stubs. Each routes to its drag-bar
        // primary scalar (`vignetteAmount`, `grainAmount`,
        // `splitToneBalance`).
        let session = makeSession()
        let state = EditorState(session: session)

        state.arm(tool: .vignette)
        state.setArmedDisplayValue(-50)
        XCTAssertEqual(session.model.vignetteAmount, -50, accuracy: 1e-9)

        state.arm(tool: .grain)
        state.setArmedDisplayValue(40)
        XCTAssertEqual(session.model.grainAmount, 40, accuracy: 1e-9)

        state.arm(tool: .splitTone)
        state.setArmedDisplayValue(25)
        XCTAssertEqual(session.model.splitToneBalance, 25, accuracy: 1e-9)
    }

    // MARK: - Commit / undo / redo

    func testCommitSnapshotsThroughEditSession() {
        let session = makeSession()
        let state = EditorState(session: session)
        state.arm(tool: .contrast)

        XCTAssertFalse(session.canUndo)
        state.commit()
        state.setArmedDisplayValue(25)
        XCTAssertTrue(session.canUndo)

        state.undo()
        XCTAssertEqual(session.model.contrast, 0, accuracy: 1e-9)
        XCTAssertTrue(session.canRedo)

        state.redo()
        XCTAssertEqual(session.model.contrast, 25, accuracy: 1e-9)
    }

    func testIsDirtyReflectsModelDivergence() {
        let state = EditorState(session: makeSession())
        XCTAssertFalse(state.isDirty)
        state.setArmedDisplayValue(0.1)
        XCTAssertTrue(state.isDirty)
    }

    func testResetArmedToolReturnsToDefault() {
        let session = makeSession()
        let state = EditorState(session: session)
        state.arm(tool: .temp)
        state.setArmedDisplayValue(7500)
        XCTAssertEqual(session.model.temperature, 7500, accuracy: 1e-9)
        state.resetArmedTool()
        XCTAssertEqual(session.model.temperature, 6500, accuracy: 1e-9)
        // Reset should have snapshotted so undo can put 7500 back.
        state.undo()
        XCTAssertEqual(session.model.temperature, 7500, accuracy: 1e-9)
    }

    func testResetArmedToolReturnsColorNRToCanonicalDefault() {
        // Color NR defaults to 25 on AdjustmentModel — resetting must
        // land on 25, not 0, so a fresh asset reads as unmodified after
        // reset.
        let session = makeSession()
        let state = EditorState(session: session)
        state.arm(tool: .colorNR)
        state.setArmedDisplayValue(80)
        state.resetArmedTool()
        XCTAssertEqual(session.model.nrColor, 25, accuracy: 1e-9)
    }

    func testCanonicalDefaultsMatchAdjustmentModel() {
        XCTAssertEqual(ToolValueMapping.defaultDisplayValue(for: .exposure), 0, accuracy: 1e-9)
        XCTAssertEqual(ToolValueMapping.defaultDisplayValue(for: .temp), 6500, accuracy: 1e-9)
        XCTAssertEqual(ToolValueMapping.defaultDisplayValue(for: .sharpen), 40, accuracy: 1e-9)
        XCTAssertEqual(ToolValueMapping.defaultDisplayValue(for: .colorNR), 25, accuracy: 1e-9)
        XCTAssertEqual(ToolValueMapping.defaultDisplayValue(for: .noise), 0, accuracy: 1e-9)
    }

    // MARK: - Undo cap

    func testUndoStackCapsAtThirtyTwo() {
        let session = makeSession()
        let state = EditorState(session: session)
        state.arm(tool: .exposure)

        // Push 40 commits with monotonically-increasing exposure values
        // (0.01, 0.02, …, 0.40). After the cap kicks in, only the most
        // recent 32 should be undoable.
        for i in 1...40 {
            state.commit()
            state.setArmedDisplayValue(Double(i) * 0.01)
        }

        XCTAssertEqual(session.model.exposure, 0.40, accuracy: 1e-9)

        // Pop 32 undo steps. After the last one, exposure should equal the
        // value pushed onto the snapshot stack at commit #9 (i.e. exposure
        // BEFORE the i=9 setValue ran → 0.08). The 8 oldest snapshots
        // (commits #1-#8) should have rolled off the cap.
        for _ in 0..<EditSession.undoStackCap {
            state.undo()
        }
        XCTAssertEqual(session.model.exposure, 0.08, accuracy: 1e-9)
        // 33rd undo is a no-op (cap-bounded).
        XCTAssertFalse(state.canUndo)
        state.undo()
        XCTAssertEqual(session.model.exposure, 0.08, accuracy: 1e-9)
    }

    // MARK: - Tool catalog sanity

    func testTwentyTwoToolsExist() {
        XCTAssertEqual(Tool.allCases.count, 22)
    }

    func testToolGroupMembership() {
        XCTAssertEqual(Tool.tools(in: .light).count, 6)
        XCTAssertEqual(Tool.tools(in: .color).count, 5)
        XCTAssertEqual(Tool.tools(in: .effects).count, 6)
        XCTAssertEqual(Tool.tools(in: .detail).count, 5)
    }

    func testWiredToolsCoverNineteenFields() {
        // Per #643: vignette / grain / splitTone gained AdjustmentModel
        // fields, leaving HSL/Crop/Presets as the v0.1 stubs (each tracked
        // by its own spec ticket — #636, #638, #639).
        let wired = Tool.allCases.filter { $0.isWired }
        XCTAssertEqual(wired.count, 19)
        XCTAssertFalse(Tool.hsl.isWired)
        XCTAssertFalse(Tool.crop.isWired)
        XCTAssertFalse(Tool.presets.isWired)
        XCTAssertTrue(Tool.vignette.isWired)
        XCTAssertTrue(Tool.grain.isWired)
        XCTAssertTrue(Tool.splitTone.isWired)
    }
}
