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
        // and must not mutate any field. HSL / Crop / Presets are stubs
        // pending their own specs; the S5 effects all left the #952 stub
        // list as their stages landed (#1109 / #1110 / #1111).
        let before = state.session.model
        state.setArmedDisplayValue(50)
        XCTAssertEqual(state.session.model, before)
    }

    func testSplitToneIsWiredAndWritesThroughSubParams() {
        // #1111: splitTone left the stub list — the drag bar drives
        // `splitToneBalance` (the schema-declared primary), and the four
        // hue/sat chips route the same value pipe.
        let session = makeSession()
        let state = EditorState(session: session)

        state.arm(tool: .splitTone)
        state.setArmedDisplayValue(25)
        XCTAssertEqual(session.model.splitToneBalance, 25, accuracy: 1e-9)

        state.arm(subParamId: "shadowHue")
        state.setArmedDisplayValue(30)
        XCTAssertEqual(session.model.splitToneShadowHue, 30, accuracy: 1e-9)

        state.arm(subParamId: "shadowSat")
        state.setArmedDisplayValue(60)
        XCTAssertEqual(session.model.splitToneShadowSaturation, 60, accuracy: 1e-9)

        state.arm(subParamId: "highlightHue")
        state.setArmedDisplayValue(210)
        XCTAssertEqual(session.model.splitToneHighlightHue, 210, accuracy: 1e-9)

        state.arm(subParamId: "highlightSat")
        state.setArmedDisplayValue(40)
        XCTAssertEqual(session.model.splitToneHighlightSaturation, 40, accuracy: 1e-9)
        XCTAssertEqual(session.model.splitToneBalance, 25, accuracy: 1e-9)
    }

    func testGrainIsWiredAndWritesThroughSubParams() {
        // #1110: grain left the stub list — the drag bar drives
        // `grainAmount` (first sub-param; one-sided 0..100), and the size
        // / roughness chips route the same value pipe.
        let session = makeSession()
        let state = EditorState(session: session)

        state.arm(tool: .grain)
        state.setArmedDisplayValue(40)
        XCTAssertEqual(session.model.grainAmount, 40, accuracy: 1e-9)

        state.arm(subParamId: "size")
        state.setArmedDisplayValue(70)
        XCTAssertEqual(session.model.grainSize, 70, accuracy: 1e-9)

        state.arm(subParamId: "roughness")
        state.setArmedDisplayValue(20)
        XCTAssertEqual(session.model.grainRoughness, 20, accuracy: 1e-9)
        XCTAssertEqual(session.model.grainAmount, 40, accuracy: 1e-9)
    }

    func testVignetteIsWiredAndWritesThroughSubParams() {
        // #1109: vignette left the stub list — the drag bar drives
        // `vignetteAmount` (first sub-param), and arming the feather chip
        // routes the same value pipe to `vignetteFeather`.
        let session = makeSession()
        let state = EditorState(session: session)

        state.arm(tool: .vignette)
        state.setArmedDisplayValue(-50)
        XCTAssertEqual(session.model.vignetteAmount, -50, accuracy: 1e-9)

        state.arm(subParamId: "feather")
        state.setArmedDisplayValue(80)
        XCTAssertEqual(session.model.vignetteFeather, 80, accuracy: 1e-9)
        XCTAssertEqual(session.model.vignetteAmount, -50, accuracy: 1e-9)
    }

    func testCaptureSharpeningToolsWireToModel() {
        // #875: capture-sharpening Amount / Sigma relocated from the
        // removed Develop tab into the Detail group.
        let session = makeSession()
        let state = EditorState(session: session)

        // Amount: one-sided 0..100, internal +100 → display 100.
        state.arm(tool: .captureSharpen)
        state.setArmedInternalValue(100)
        XCTAssertEqual(session.model.captureSharpeningAmount, 100, accuracy: 1e-9)
        // Internal -100 → display 0 (the floor, not -100).
        state.setArmedInternalValue(-100)
        XCTAssertEqual(session.model.captureSharpeningAmount, 0, accuracy: 1e-9)

        // Sigma: 0.5..2.0 px centred on 1.0 at v=0.
        state.arm(tool: .captureSigma)
        state.setArmedInternalValue(0)
        XCTAssertEqual(session.model.captureSharpeningSigma, 1.0, accuracy: 1e-9)
        state.setArmedInternalValue(100)
        XCTAssertEqual(session.model.captureSharpeningSigma, 2.0, accuracy: 1e-9)
        state.setArmedInternalValue(-100)
        XCTAssertEqual(session.model.captureSharpeningSigma, 0.5, accuracy: 1e-9)
    }

    func testCaptureSigmaInternalRoundTrips() {
        // displayValue ∘ internalValue must be identity across the band so
        // the value chip and reset agree with the drag-bar.
        for d in stride(from: 0.5, through: 2.0, by: 0.1) {
            let v = ToolValueMapping.internalValue(for: .captureSigma, displayValue: d)
            let back = ToolValueMapping.displayValue(for: .captureSigma, internalValue: v)
            XCTAssertEqual(back, d, accuracy: 1e-9)
        }
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
        // Capture sharpening (#875): Amount default 0, Sigma default 1.0 px.
        XCTAssertEqual(ToolValueMapping.defaultDisplayValue(for: .captureSharpen), 0, accuracy: 1e-9)
        XCTAssertEqual(ToolValueMapping.defaultDisplayValue(for: .captureSigma), 1.0, accuracy: 1e-9)
    }

    // MARK: - Wheel nudge (#1099)

    func testWheelNudgeAppliesStepsTimesUnit() {
        let session = makeSession()
        let state = EditorState(session: session)
        state.arm(tool: .contrast)
        // Contrast is symmetric ±100 → internal == display, so 3 detents
        // × unit 1 lands at +3.
        state.wheelNudge(steps: 3, unit: 1, at: Date())
        XCTAssertEqual(session.model.contrast, 3, accuracy: 1e-9)
    }

    func testWheelNudgeBurstSharesOneUndoSnapshot() {
        let session = makeSession()
        let state = EditorState(session: session)
        state.arm(tool: .contrast)
        let t0 = Date()
        state.wheelNudge(steps: 1, unit: 1, at: t0)
        state.wheelNudge(steps: 1, unit: 1, at: t0.addingTimeInterval(0.1))
        state.wheelNudge(steps: 1, unit: 1, at: t0.addingTimeInterval(0.2))
        XCTAssertEqual(session.model.contrast, 3, accuracy: 1e-9)
        // One burst = one snapshot: a single undo returns to the start.
        state.undo()
        XCTAssertEqual(session.model.contrast, 0, accuracy: 1e-9)
        XCTAssertFalse(state.canUndo)
    }

    func testWheelNudgeOnValuelessToolPushesNoUndoSnapshot() {
        let session = makeSession()
        let state = EditorState(session: session)
        // Presets is wired but value-less (`displayRange == nil`) — the
        // burst commit must not fire for it, same contract as DragBar's
        // `armedToolAcceptsValueEdits` hit-testing gate.
        state.arm(tool: .presets)
        state.wheelNudge(steps: 3, unit: 1, at: Date())
        XCTAssertFalse(state.canUndo)
    }

    func testWheelNudgePauseStartsNewBurst() {
        let session = makeSession()
        let state = EditorState(session: session)
        state.arm(tool: .contrast)
        let t0 = Date()
        state.wheelNudge(steps: 1, unit: 1, at: t0)
        // > 0.5 s pause — a fresh burst, so a second snapshot.
        state.wheelNudge(steps: 1, unit: 1, at: t0.addingTimeInterval(0.8))
        XCTAssertEqual(session.model.contrast, 2, accuracy: 1e-9)
        state.undo()
        XCTAssertEqual(session.model.contrast, 1, accuracy: 1e-9)
        state.undo()
        XCTAssertEqual(session.model.contrast, 0, accuracy: 1e-9)
    }

    func testWheelNudgeToolSwitchWithinWindowStartsNewBurst() {
        // #1125 review: scroll Tool A, switch to Tool B, scroll again
        // within the 0.5 s window — the burst must break on the tool
        // change so the two tools' edits land in SEPARATE undo
        // snapshots.
        let session = makeSession()
        let state = EditorState(session: session)
        let t0 = Date()
        state.arm(tool: .contrast)
        state.wheelNudge(steps: 5, unit: 1, at: t0)
        state.arm(tool: .tint)
        state.wheelNudge(steps: 3, unit: 1, at: t0.addingTimeInterval(0.1))
        XCTAssertEqual(session.model.contrast, 5, accuracy: 1e-9)
        XCTAssertEqual(session.model.tint, 3, accuracy: 1e-9)
        // First undo unwinds ONLY the tint nudge…
        state.undo()
        XCTAssertEqual(session.model.tint, 0, accuracy: 1e-9)
        XCTAssertEqual(session.model.contrast, 5, accuracy: 1e-9)
        // …second undo unwinds the contrast burst.
        state.undo()
        XCTAssertEqual(session.model.contrast, 0, accuracy: 1e-9)
        XCTAssertFalse(state.canUndo)
    }

    func testWheelNudgeReturnToFirstToolStartsAnotherBurst() {
        // A→B→A inside the window: the return to A is still a tool
        // change relative to the LAST nudge, so it opens a third
        // snapshot rather than gluing onto A's first burst.
        let session = makeSession()
        let state = EditorState(session: session)
        let t0 = Date()
        state.arm(tool: .contrast)
        state.wheelNudge(steps: 1, unit: 1, at: t0)
        state.arm(tool: .tint)
        state.wheelNudge(steps: 1, unit: 1, at: t0.addingTimeInterval(0.1))
        state.arm(tool: .contrast)
        state.wheelNudge(steps: 1, unit: 1, at: t0.addingTimeInterval(0.2))
        state.undo()
        XCTAssertEqual(session.model.contrast, 1, accuracy: 1e-9)
        XCTAssertEqual(session.model.tint, 1, accuracy: 1e-9)
        state.undo()
        XCTAssertEqual(session.model.tint, 0, accuracy: 1e-9)
        state.undo()
        XCTAssertEqual(session.model.contrast, 0, accuracy: 1e-9)
    }

    func testWheelNudgeIgnoresZeroStepsAndUnwiredTools() {
        let session = makeSession()
        let state = EditorState(session: session)
        let before = session.model
        state.arm(tool: .contrast)
        state.wheelNudge(steps: 0, unit: 1, at: Date())
        XCTAssertFalse(state.canUndo, "zero steps must not open a snapshot")
        state.arm(tool: .hsl) // stub — not wired
        state.wheelNudge(steps: 2, unit: 1, at: Date())
        XCTAssertFalse(state.canUndo)
        XCTAssertEqual(session.model, before)
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

    func testTwentyFiveToolsExist() {
        // 22 base tools + Capture Sharpening Amount / Sigma, relocated to
        // the Detail group when the Develop tab was removed (#875), +
        // Brightness in Light (#1108 / #1102).
        XCTAssertEqual(Tool.allCases.count, 25)
    }

    func testToolGroupMembership() {
        // Light gained Brightness (#1108): 6 → 7.
        XCTAssertEqual(Tool.tools(in: .light).count, 7)
        XCTAssertEqual(Tool.tools(in: .color).count, 5)
        XCTAssertEqual(Tool.tools(in: .effects).count, 6)
        // Detail gained captureSharpen + captureSigma (#875): 5 → 7.
        XCTAssertEqual(Tool.tools(in: .detail).count, 7)
    }

    func testBrightnessToolWiresToModel() {
        // Brightness (#1108): real pipeline stage since #1102
        // (scene_tone_controls midtone-band gain), symmetric ±100,
        // placed in Light directly after Exposure.
        XCTAssertEqual(Tool.tools(in: .light)[1], .brightness)
        let session = makeSession()
        let state = EditorState(session: session)
        state.arm(tool: .brightness)
        XCTAssertEqual(state.armedGroup, .light)
        state.setArmedDisplayValue(30)
        XCTAssertEqual(session.model.brightness, 30, accuracy: 1e-9)
        state.setArmedInternalValue(-50)
        XCTAssertEqual(session.model.brightness, -50, accuracy: 1e-9)
        state.resetArmedTool()
        XCTAssertEqual(session.model.brightness, 0, accuracy: 1e-9)
    }

    func testWiredToolsCoverTwentyThreeTools() {
        // The S5 effects all left the #952 stub list as their stages
        // landed (vignette #1109, grain #1110, splitTone #1111). HSL
        // (#636) / Crop (#638) remain stubs pending their own specs. Per
        // #875: captureSharpen / captureSigma stay wired to the
        // captureSharpening* fields. Presets left the stub list at #1115 —
        // wired, but value-less (nil displayRange keeps its value pipe
        // inert). Brightness joined wired at #1108.
        let wired = Tool.allCases.filter { $0.isWired }
        XCTAssertEqual(wired.count, 23)
        XCTAssertFalse(Tool.hsl.isWired)
        XCTAssertTrue(Tool.vignette.isWired)
        XCTAssertTrue(Tool.grain.isWired)
        XCTAssertTrue(Tool.splitTone.isWired)
        XCTAssertFalse(Tool.crop.isWired)
        XCTAssertTrue(Tool.presets.isWired)
        XCTAssertNil(ToolValueMapping.displayRange(for: .presets))
        XCTAssertTrue(Tool.captureSharpen.isWired)
        XCTAssertTrue(Tool.captureSigma.isWired)
    }

    // MARK: - Presets (#1115)

    private func preset(
        _ fields: [String: PresetFieldValue],
        name: String = "Test"
    ) -> Preset {
        Preset(id: "p1", name: name, fields: fields)
    }

    func testApplyPresetSparseMergesWithOneUndoEntry() {
        let session = makeSession()
        let state = EditorState(session: session)

        // Pre-existing edit the preset must not clobber.
        state.arm(tool: .exposure)
        state.commit()
        state.setArmedDisplayValue(1.5)

        let ok = state.applyPreset(preset([
            "contrast": .number(-50),
            "saturation": .number(-100),
        ]))
        XCTAssertTrue(ok)
        XCTAssertEqual(session.model.contrast, -50, accuracy: 1e-9)
        XCTAssertEqual(session.model.saturation, -100, accuracy: 1e-9)
        // Sparse merge: untouched fields keep their current values.
        XCTAssertEqual(session.model.exposure, 1.5, accuracy: 1e-9)

        // ONE undo entry: a single undo restores the full pre-apply state.
        state.undo()
        XCTAssertEqual(session.model.contrast, 0, accuracy: 1e-9)
        XCTAssertEqual(session.model.saturation, 0, accuracy: 1e-9)
        XCTAssertEqual(session.model.exposure, 1.5, accuracy: 1e-9)

        // Redo replays the whole preset in one step.
        state.redo()
        XCTAssertEqual(session.model.contrast, -50, accuracy: 1e-9)
        XCTAssertEqual(session.model.saturation, -100, accuracy: 1e-9)
    }

    func testApplyPresetClampsSkipsAndGuardsEnums() {
        let session = makeSession()
        let state = EditorState(session: session)

        XCTAssertTrue(state.applyPreset(preset([
            "exposure": .number(9.5),              // clamped to +4
            "future_curve_strength": .number(0.5), // unknown → skipped
            "profile": .string("Neutral"),         // known variant → applied
            "look": .string("WarpDrive"),          // unknown variant → skipped
        ])))
        XCTAssertEqual(session.model.exposure, 4.0, accuracy: 1e-9)
        XCTAssertEqual(session.model.profile, .neutral)
        XCTAssertEqual(session.model.look, .default) // unchanged default
    }

    func testApplyPresetUnknownOnlyReturnsFalseAndPushesNoUndo() {
        let session = makeSession()
        let state = EditorState(session: session)
        let before = session.model

        XCTAssertFalse(state.applyPreset(preset(["future_only": .number(1)])))
        XCTAssertEqual(session.model, before)
        XCTAssertFalse(state.canUndo)
    }

    func testArmedToolAcceptsValueEditsGatesPresetsAndStubs() {
        // `DragBar` disables hit-testing on this flag so its touch-down
        // `commit()` can't push junk undo snapshots for tools without a
        // value pipe (#1115 review).
        let state = EditorState(session: makeSession())

        // Value-carrying wired tools accept edits…
        for tool in [Tool.exposure, .temp, .sharpen, .captureSigma] {
            state.arm(tool: tool)
            XCTAssertTrue(state.armedToolAcceptsValueEdits, "\(tool) should accept value edits")
        }

        // …the S5 effects (#1109 / #1110 / #1111) joined the value-carrying set…
        for tool in [Tool.vignette, .grain, .splitTone] {
            state.arm(tool: tool)
            XCTAssertTrue(state.armedToolAcceptsValueEdits, "\(tool) should accept value edits")
        }

        // …presets (wired but value-less) and the gated stubs don't.
        for tool in [Tool.presets, .hsl, .crop] {
            state.arm(tool: tool)
            XCTAssertFalse(state.armedToolAcceptsValueEdits, "\(tool) must not accept value edits")
        }
    }

    func testPresetsPillValuePipeIsInert() {
        // Presets is wired (#1115) but value-less: drags and resets must
        // not mutate the model NOR push junk undo entries.
        let session = makeSession()
        let state = EditorState(session: session)
        let before = session.model

        state.arm(tool: .presets)
        state.setArmedDisplayValue(50)
        state.resetArmedTool()

        XCTAssertEqual(session.model, before)
        XCTAssertEqual(state.armedDisplayValue, 0, accuracy: 1e-9)
        XCTAssertFalse(state.canUndo)
    }

    func testCapturePresetFieldsIsSparse() {
        let session = makeSession()
        let state = EditorState(session: session)

        XCTAssertTrue(state.capturePresetFields().isEmpty)

        state.arm(tool: .exposure)
        state.setArmedDisplayValue(1.25)
        state.arm(tool: .noise)
        state.setArmedDisplayValue(40)
        session.model.profile = .neutral

        XCTAssertEqual(state.capturePresetFields(), [
            "exposure": .number(1.25),
            "nr_luminance": .number(40),
            "profile": .string("Neutral"),
        ])
    }

    // MARK: - Reset to factory defaults (#1372)

    func testResetToFactoryDefaultsRestoresDefaultsWithAsShotWBAndAutoProfile() {
        let session = makeSession()
        let state = EditorState(session: session)
        session.asShotCCT = 5200
        session.asShotTint = 7

        var dirty = session.model
        dirty.exposure = 2
        dirty.contrast = 40
        dirty.saturation = -30
        dirty.profile = .neutral
        dirty.temperature = 9000
        dirty.crop = Crop(top: 0.1, left: 0.1, bottom: 0.9, right: 0.9, angle: 5)
        session.model = dirty
        let preservedCrop = session.model.crop

        state.resetToFactoryDefaults()

        let m = state.session.model
        // Develop sliders back to factory defaults.
        XCTAssertEqual(m.exposure, AdjustmentModel.default.exposure, accuracy: 1e-9)
        XCTAssertEqual(m.contrast, AdjustmentModel.default.contrast, accuracy: 1e-9)
        XCTAssertEqual(m.saturation, AdjustmentModel.default.saturation, accuracy: 1e-9)
        // White balance → camera As-Shot; profile → Auto.
        XCTAssertEqual(m.temperature, 5200, accuracy: 1e-9)
        XCTAssertEqual(m.tint, 7, accuracy: 1e-9)
        XCTAssertEqual(m.profile, .auto)
        // Crop / rotation preserved.
        XCTAssertEqual(m.crop, preservedCrop)
        XCTAssertEqual(m.crop.angle, 5, accuracy: 1e-9)
        // One undo entry restores the full pre-reset model.
        XCTAssertTrue(state.canUndo)
        state.undo()
        XCTAssertEqual(state.session.model.exposure, 2, accuracy: 1e-9)
        XCTAssertEqual(state.session.model.profile, .neutral)
    }

    func testResetToFactoryDefaultsFallsBackToNeutralWBWithoutAsShot() {
        let session = makeSession()
        let state = EditorState(session: session)
        session.asShotCCT = nil
        session.asShotTint = nil
        var dirty = session.model
        dirty.temperature = 9000
        dirty.tint = 30
        session.model = dirty

        state.resetToFactoryDefaults()

        let m = state.session.model
        XCTAssertEqual(m.temperature, 6500, accuracy: 1e-9)
        XCTAssertEqual(m.tint, 0, accuracy: 1e-9)
        XCTAssertEqual(m.profile, .auto)
    }

    // MARK: - AUTO (#1379)

    /// A file-backed session (AUTO is gated on `asset.primaryURL`).
    private func makeFileBackedSession() -> EditSession {
        EditSession(
            asset: AssetRef(url: URL(fileURLWithPath: "/tmp/maple-auto-test.dng")),
            model: .default,
            culling: CullingState()
        )
    }

    func testApplyAutoAppliesExposureOnlyLeavingWBAndToneUntouched() async {
        let session = makeFileBackedSession()
        let state = EditorState(session: session)
        // The injected result includes WB + tone, but AUTO applies EXPOSURE only.
        state.autoProvider = { _ in
            AutoAdjustmentsResult(
                exposure: 1.2, temperature: 5200, tint: 8,
                contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0
            )
        }
        // Pre-set WB + a tone slider to prove AUTO leaves them untouched.
        var dirty = session.model
        dirty.contrast = 40
        dirty.temperature = 7000
        dirty.tint = 12
        session.model = dirty

        await state.applyAuto()

        let after = state.session.model
        XCTAssertEqual(after.exposure, 1.2, accuracy: 1e-9)
        // White balance is NOT touched by AUTO (gray-world unreliable); tone is
        // deferred to #1376 — both keep the pre-AUTO values.
        XCTAssertEqual(after.temperature, 7000, accuracy: 1e-9)
        XCTAssertEqual(after.tint, 12, accuracy: 1e-9)
        XCTAssertEqual(after.contrast, 40, accuracy: 1e-9)
        // One undo entry restores the pre-AUTO model.
        XCTAssertTrue(state.canUndo)
        state.undo()
        XCTAssertEqual(state.session.model.exposure, AdjustmentModel.default.exposure, accuracy: 1e-9)
    }

    func testApplyAutoClampsExposureAndIgnoresWB() async {
        let session = makeFileBackedSession()
        let state = EditorState(session: session)
        state.autoProvider = { _ in
            AutoAdjustmentsResult(
                exposure: 99, temperature: 99999, tint: 999,
                contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0
            )
        }
        await state.applyAuto()
        let m = state.session.model
        XCTAssertEqual(m.exposure, AdjustmentModel.exposureRange.upperBound, accuracy: 1e-9)
        // WB is not applied — stays at the model default despite the huge
        // injected temperature/tint.
        XCTAssertEqual(m.temperature, AdjustmentModel.default.temperature, accuracy: 1e-9)
        XCTAssertEqual(m.tint, AdjustmentModel.default.tint, accuracy: 1e-9)
    }

    func testApplyAutoNoOpWhenAssetHasNoFileURL() async {
        // The bytes-backed preview asset has no primaryURL → AUTO is a no-op:
        // the analyzer never runs and the model is untouched (had it run, the
        // injected result would have set exposure to 1).
        let state = EditorState(session: makeSession())
        state.autoProvider = { _ in
            AutoAdjustmentsResult(
                exposure: 1, temperature: 5000, tint: 0,
                contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0
            )
        }
        await state.applyAuto()
        XCTAssertEqual(state.session.model.exposure, AdjustmentModel.default.exposure, accuracy: 1e-9)
        XCTAssertFalse(state.canUndo)
    }
}
