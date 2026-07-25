// EditorHSLTests.swift — 8-band HSL panel wiring (#274).
//
// Split out of `EditorStateTests.swift` under the 600-LOC file budget.
// Covers the parts of `EditorState` that only HSL exercises: a wired
// tool with NO tool-level display range, whose every edit travels the
// sub-param value pipe, and the group reset that has to reach all 24 of
// its band fields.
//
// The catalog itself (ids, labels, ranges, key paths) is covered by
// `EditorSubParamTests`; the per-band gradient tracks by
// `GradientCatalogTests`.
//
// All tests are MainActor — EditSession + EditorState are both
// MainActor-isolated.

import XCTest
@testable import MapleCore

@MainActor
final class EditorHSLTests: XCTestCase {
    private func makeSession() -> EditSession {
        EditSession.preview()
    }

    func testHSLAcceptsSubParamEdits() {
        // #274: HSL is wired but has NO tool-level display range — every
        // edit goes through one of its 24 sub-params. Arming the tool
        // must land on `hueRed` and the value pipe must accept writes.
        let session = makeSession()
        let state = EditorState(session: session)

        state.arm(tool: .hsl)
        XCTAssertNil(ToolValueMapping.displayRange(for: .hsl))
        XCTAssertEqual(state.armedSubParamId, "hueRed")
        XCTAssertTrue(state.armedToolAcceptsValueEdits)

        state.setArmedDisplayValue(40)
        XCTAssertEqual(session.model.hueAdjustmentRed, 40, accuracy: 1e-9)

        state.arm(subParamId: "satAqua")
        state.setArmedDisplayValue(-25)
        XCTAssertEqual(session.model.saturationAdjustmentAqua, -25, accuracy: 1e-9)

        state.arm(subParamId: "lumMagenta")
        state.setArmedDisplayValue(60)
        XCTAssertEqual(session.model.luminanceAdjustmentMagenta, 60, accuracy: 1e-9)

        // Resetting the armed pair clears only that band/channel.
        state.resetArmedTool()
        XCTAssertEqual(session.model.luminanceAdjustmentMagenta, 0, accuracy: 1e-9)
        XCTAssertEqual(session.model.hueAdjustmentRed, 40, accuracy: 1e-9)
        XCTAssertEqual(session.model.saturationAdjustmentAqua, -25, accuracy: 1e-9)
    }

    func testResetGroupClearsHSLBandsAndTheGroupSliders() {
        // #274: "Reset Color" must reach HSL's 24 band fields. Before it
        // routed through `EditorState.resetGroup`, the three control
        // surfaces each filtered on a non-nil tool-level display range,
        // which HSL has not — so every band survived a group reset.
        let session = makeSession()
        let state = EditorState(session: session)

        state.arm(tool: .saturation)
        state.setArmedDisplayValue(70)
        state.arm(tool: .hsl)
        state.arm(subParamId: "hueRed")
        state.setArmedDisplayValue(45)
        state.arm(subParamId: "lumBlue")
        state.setArmedDisplayValue(-30)
        // An out-of-group field must survive the Color reset.
        state.arm(tool: .clarity)
        state.setArmedDisplayValue(20)

        state.resetGroup(.color)

        XCTAssertEqual(session.model.saturation, 0, accuracy: 1e-9)
        XCTAssertEqual(session.model.hueAdjustmentRed, 0, accuracy: 1e-9)
        XCTAssertEqual(session.model.luminanceAdjustmentBlue, 0, accuracy: 1e-9)
        XCTAssertEqual(session.model.temperature, 6500, accuracy: 1e-9)
        XCTAssertEqual(session.model.clarity, 20, accuracy: 1e-9,
                       "Effects must be untouched by a Color reset")

        // One undo boundary: a single undo restores everything the reset
        // cleared.
        state.undo()
        XCTAssertEqual(session.model.hueAdjustmentRed, 45, accuracy: 1e-9)
        XCTAssertEqual(session.model.luminanceAdjustmentBlue, -30, accuracy: 1e-9)
        XCTAssertEqual(session.model.saturation, 70, accuracy: 1e-9)
    }

    func testHSLInternalValueMapsAnchoredAcrossFullRange() {
        // The drag bar's ±100 internal scale maps 1:1 onto the ±100 field
        // range for every HSL sub-param (anchored at the 0 default), so a
        // wheel nudge or a drag lands on the value the chip shows.
        let session = makeSession()
        let state = EditorState(session: session)
        state.arm(tool: .hsl)
        state.arm(subParamId: "hueGreen")

        state.setArmedInternalValue(100)
        XCTAssertEqual(session.model.hueAdjustmentGreen, 100, accuracy: 1e-9)
        state.setArmedInternalValue(-100)
        XCTAssertEqual(session.model.hueAdjustmentGreen, -100, accuracy: 1e-9)
        state.setArmedInternalValue(0)
        XCTAssertEqual(session.model.hueAdjustmentGreen, 0, accuracy: 1e-9)
        XCTAssertEqual(state.armedInternalValue, 0, accuracy: 1e-9)
    }
}
