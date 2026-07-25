// EditorStatePresetsTests.swift — preset apply / value-pipe tests (#1115).
//
// Split out of EditorStateTests.swift to clear the 600-LOC file budget —
// same pure code-move pattern as EditorStateAutoResetTests.swift and
// EditorStateBlackWhiteTests.swift. Covers:
//   • applyPreset sparse merge, clamping, enum guards, unknown-only
//   • armedToolAcceptsValueEdits gating for presets and the stub tools
//   • the presets pill's inert value pipe
//   • capturePresetFields sparseness
//
// All tests are MainActor — EditorState + EditSession are MainActor-isolated.

import XCTest
@testable import MapleCore

@MainActor
final class EditorStatePresetsTests: XCTestCase {
    // MARK: - Helpers

    private func makeSession() -> EditSession {
        EditSession.preview()
    }

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

        // …the S5 effects (#1109 / #1110 / #1111, colour grading extended to
        // four wheels at #275) joined the value-carrying set…
        for tool in [Tool.vignette, .grain, .colorGrade] {
            state.arm(tool: tool)
            XCTAssertTrue(state.armedToolAcceptsValueEdits, "\(tool) should accept value edits")
        }

        // …B&W Mix (#276) joined too — its eight sub-params carry the value pipe…
        state.arm(tool: .bwMix)
        XCTAssertTrue(state.armedToolAcceptsValueEdits, "bwMix should accept value edits")

        // …presets (wired but value-less) and the gated stubs don't. HSL
        // is absent on purpose — it has no tool-level range but always
        // carries an armed sub-param, so it DOES accept edits (#274,
        // covered by `EditorHSLTests`); B&W Mix has the same shape and is
        // asserted positively just above.
        for tool in [Tool.presets, .crop] {
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
}
