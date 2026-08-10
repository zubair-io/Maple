// FilmStrengthCommitTests.swift — reported-bug repro for epic #2683.
//
// Bug: "applying the effect at 100% strength shuts the effect off."
// Reproduces the EXACT write path `FilmSection`'s strength `LivingSlider`
// binding drives — `EditorState.arm(subParamId:)` /
// `setArmedDisplayValue(_:)` / `commit()` — with no SwiftUI involved, so
// the failure (if real) is pinned at the model/logic seam per the
// systematic-debugging brief.

import XCTest
@testable import MapleCore

@MainActor
final class FilmStrengthCommitTests: XCTestCase {

    private func makeState() -> EditorState {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("dng")
        let session = EditSession(asset: AssetRef(url: url))
        return EditorState(session: session, armedGroup: .effects, armedTool: .filmLook)
    }

    /// Mirrors `FilmSection.strengthSlider`'s `Binding.set` closure exactly.
    private func dragStrength(_ state: EditorState, to value: Double) {
        let sub = Tool.filmLook.subParams[0]
        if state.armedSubParamId != sub.id {
            state.arm(subParamId: sub.id)
        }
        state.setArmedDisplayValue(value)
    }

    func testCommittingStrengthAtOneHundredKeepsTheLookArmed() {
        let state = makeState()
        // Mirrors FilmSection.selectLook: commit boundary, then the write.
        state.commit()
        state.session.model.filmLook = "kodak_portra_400"
        XCTAssertEqual(state.session.model.filmStrength, 100, "fresh model starts at the canonical default")

        // Drag the strength slider down, then back up to exactly 100 (the
        // field's own default value) and release.
        dragStrength(state, to: 80)
        dragStrength(state, to: 100)
        state.commit()

        XCTAssertEqual(
            state.session.model.filmLook, "kodak_portra_400",
            "committing strength back to its default (100) must not clear the chosen look")
        XCTAssertEqual(state.session.model.filmStrength, 100)
    }

    /// The look is selected fresh (strength already sitting at its 100
    /// default) and the user drags straight to 100 without ever leaving it
    /// — the simplest form of the reported repro.
    func testSelectingALookThenCommittingAtDefaultStrengthStaysArmed() {
        let state = makeState()
        state.commit()
        state.session.model.filmLook = "kodak_portra_400"

        dragStrength(state, to: 100)
        state.commit()

        XCTAssertEqual(state.session.model.filmLook, "kodak_portra_400")
        XCTAssertEqual(state.session.model.filmStrength, 100)
    }

    /// The resolved GPU-live lattice must still be present after the same
    /// sequence — pins the render-facing half of the contract, not just the
    /// model field.
    func testResolvedLatticeSurvivesACommitAtDefaultStrength() async {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("dng")
        let session = EditSession(
            asset: AssetRef(url: url),
            filmLutStore: FilmLutStore(bundle: .module)
        )
        let state = EditorState(session: session, armedGroup: .effects, armedTool: .filmLook)

        state.commit()
        state.session.model.filmLook = "test_lut"
        dragStrength(state, to: 80)
        dragStrength(state, to: 100)
        state.commit()

        let driver = GpuLiveDriver()
        await session.syncFilmLutForPresent(driver: driver)

        XCTAssertNotNil(
            driver.currentFilmLutKey,
            "the resolved lattice must still be pushed to the driver after a commit at strength 100")
        XCTAssertEqual(driver.currentFilmLutKey, FilmLutStore.fnv1aHash("test_lut"))
    }
}
