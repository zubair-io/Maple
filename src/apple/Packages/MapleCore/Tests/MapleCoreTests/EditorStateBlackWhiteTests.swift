// EditorStateBlackWhiteTests.swift — Black & white mix (#276) tests.
//
// Split out of EditorStateTests.swift to clear the 600-LOC file budget —
// same pure code-move pattern as EditorStateAutoResetTests.swift. Covers:
//   • bwMix wiring — the drag bar drives grayMixerRed, the seven other
//     bands route through the sub-param pipe (mirrors testSplitTone/
//     testGrain/testVignetteIsWiredAndWritesThroughSubParams)
//   • bwMix's sub-param catalog (ids, labels, ranges, defaults)
//   • EditorState.visibleTools(in:) hides `.hsl` while blackWhite == .on
//     and restores it when back to .off
//   • EditorState.setBlackWhite(_:) arms off `.hsl` when it was armed,
//     leaves any other armed tool alone, and commits its own undo entry
//
// All tests are MainActor — EditorState + EditSession are MainActor-isolated.

import XCTest
@testable import MapleCore

@MainActor
final class EditorStateBlackWhiteTests: XCTestCase {

    // MARK: - Helpers

    private func makeSession() -> EditSession {
        EditSession.preview()
    }

    // MARK: - Wiring

    func testBwMixIsWiredAndWritesThroughSubParams() {
        // #276: bwMix is a real pipeline stage (same `hsl` stage as the HSL
        // rows) — the drag bar drives `grayMixerRed` (first sub-param), and
        // the other seven band chips route the same value pipe.
        let session = makeSession()
        let state = EditorState(session: session)

        state.arm(tool: .bwMix)
        XCTAssertEqual(state.armedGroup, .color)
        state.setArmedDisplayValue(40)
        XCTAssertEqual(session.model.grayMixerRed, 40, accuracy: 1e-9)

        state.arm(subParamId: "aqua")
        state.setArmedDisplayValue(-25)
        XCTAssertEqual(session.model.grayMixerAqua, -25, accuracy: 1e-9)
        // The sibling band is untouched.
        XCTAssertEqual(session.model.grayMixerRed, 40, accuracy: 1e-9)

        state.arm(subParamId: "magenta")
        state.setArmedDisplayValue(60)
        XCTAssertEqual(session.model.grayMixerMagenta, 60, accuracy: 1e-9)
    }

    func testBwMixSubParamCatalog() {
        let subs = Tool.bwMix.subParams
        XCTAssertEqual(subs.map(\.id),
                       ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"])
        XCTAssertTrue(Tool.bwMix.isMultiParam)
        XCTAssertEqual(Tool.bwMix.defaultSubParamId, "red")
        for sub in subs {
            XCTAssertEqual(sub.range, AdjustmentModel.grayMixerRedRange) // all eight share ±100
            XCTAssertEqual(sub.defaultDisplayValue, 0, accuracy: 1e-9)
        }
    }

    // MARK: - Tool visibility gate

    func testVisibleToolsHidesHSLWhileBlackWhiteIsOn() {
        let session = makeSession()
        let state = EditorState(session: session)

        // Off (default): HSL is present (a stub, but visible) alongside bwMix.
        XCTAssertTrue(state.visibleTools(in: .color).contains(.hsl))
        XCTAssertTrue(state.visibleTools(in: .color).contains(.bwMix))
        XCTAssertEqual(state.visibleTools(in: .color).count, Tool.tools(in: .color).count)

        // On: HSL disappears from the Color group's visible tool list…
        session.model.blackWhite = .on
        XCTAssertFalse(state.visibleTools(in: .color).contains(.hsl))
        XCTAssertTrue(state.visibleTools(in: .color).contains(.bwMix))
        XCTAssertEqual(state.visibleTools(in: .color).count, Tool.tools(in: .color).count - 1)

        // …other groups are unaffected.
        XCTAssertEqual(state.visibleTools(in: .light), Tool.tools(in: .light))

        // Off again: HSL returns.
        session.model.blackWhite = .off
        XCTAssertTrue(state.visibleTools(in: .color).contains(.hsl))
    }

    // MARK: - setBlackWhite(_:)

    func testSetBlackWhiteArmsOffHSLAndCommitsUndo() {
        let session = makeSession()
        let state = EditorState(session: session)
        state.arm(tool: .hsl)
        XCTAssertEqual(state.armedTool, .hsl)

        state.setBlackWhite(.on)
        XCTAssertEqual(session.model.blackWhite, .on)
        // Armed tool moved off `.hsl` — it just disappeared from the
        // visible tool list, so nothing may remain armed on it.
        XCTAssertEqual(state.armedTool, .bwMix)
        XCTAssertEqual(state.armedGroup, .color)

        // The toggle is undoable as its own snapshot.
        XCTAssertTrue(state.canUndo)
        state.undo()
        XCTAssertEqual(session.model.blackWhite, .off)
    }

    /// The control surfaces render `HSLSection` outside the pill row —
    /// pinned to the Color section in `StackedAdjustmentsPanel`, keyed on
    /// the armed tool everywhere else — so they gate on this instead of
    /// `visibleTools(in:)`. It must track the toggle exactly.
    func testShowsHSLSurfaceTracksTheToggle() {
        let session = makeSession()
        let state = EditorState(session: session)
        XCTAssertTrue(state.showsHSLSurface)

        state.setBlackWhite(.on)
        XCTAssertFalse(state.showsHSLSurface)
        XCTAssertEqual(state.showsHSLSurface,
                       state.visibleTools(in: .color).contains(.hsl),
                       "must stay derived from visibleTools(in:)")

        state.setBlackWhite(.off)
        XCTAssertTrue(state.showsHSLSurface)
    }

    /// A preset (or any direct model write) can turn Black & White on
    /// without going through `setBlackWhite`, so the surface gate must key
    /// off the model rather than off the re-arm that `setBlackWhite` does.
    func testShowsHSLSurfaceFalseWhenBlackWhiteSetDirectlyOnTheModel() {
        let session = makeSession()
        let state = EditorState(session: session)
        state.arm(tool: .hsl)
        session.model.blackWhite = .on

        XCTAssertFalse(state.showsHSLSurface)
        XCTAssertFalse(state.visibleTools(in: .color).contains(.hsl))
    }

    /// Four of the five control surfaces render `HSLSection` on
    /// `armedTool == .hsl`, and `DragBar` scrubs whatever is armed through
    /// `armedSubParamId`. So `.hsl` must not merely be hidden from the
    /// pill row while B&W is on — it must not be readable as the armed
    /// tool at all, however the mode arrived on the model.
    func testArmedToolNormalisesHSLAwayWhileBlackWhiteIsOn() {
        let session = makeSession()
        let state = EditorState(session: session)
        state.arm(tool: .hsl)
        XCTAssertEqual(state.armedTool, .hsl)

        // Straight onto the model — a preset apply, an undo, a sidecar
        // load. No call to setBlackWhite, so no explicit re-arm runs.
        session.model.blackWhite = .on
        XCTAssertEqual(state.armedTool, .bwMix)
        XCTAssertEqual(state.armedGroup, .color)

        // Back off: the user never re-armed, so HSL returns.
        session.model.blackWhite = .off
        XCTAssertEqual(state.armedTool, .hsl)
    }

    /// The explicit re-arm in `setBlackWhite` must survive the read-time
    /// normalisation: flipping the switch off again has to leave `.bwMix`
    /// armed, not silently restore `.hsl`.
    func testSetBlackWhiteReArmIsStickyAcrossToggleOff() {
        let session = makeSession()
        let state = EditorState(session: session)
        state.arm(tool: .hsl)

        state.setBlackWhite(.on)
        XCTAssertEqual(state.armedTool, .bwMix)

        state.setBlackWhite(.off)
        XCTAssertEqual(state.armedTool, .bwMix, "the re-arm must stick")
    }

    func testSetBlackWhiteLeavesOtherArmedToolsAlone() {
        let session = makeSession()
        let state = EditorState(session: session)
        state.arm(tool: .exposure)

        state.setBlackWhite(.on)
        XCTAssertEqual(state.armedTool, .exposure, "non-hsl armed tool must be untouched")

        state.setBlackWhite(.off)
        XCTAssertEqual(state.armedTool, .exposure)
        XCTAssertEqual(session.model.blackWhite, .off)
    }
}
