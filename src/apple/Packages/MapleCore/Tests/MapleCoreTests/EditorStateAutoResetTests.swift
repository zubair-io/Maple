// EditorStateAutoResetTests.swift — AUTO (#1379) and RESET (#1372) tests.
//
// Pure code-move from EditorStateTests.swift to clear the 600-LOC file budget.
// All tests are MainActor — EditorState + EditSession are MainActor-isolated.

import XCTest
@testable import MapleCore

@MainActor
final class EditorStateAutoResetTests: XCTestCase {

    // MARK: - Helpers

    private func makeSession() -> EditSession {
        EditSession.preview()
    }

    /// A file-backed session (AUTO is gated on `asset.primaryURL`).
    private func makeFileBackedSession() -> EditSession {
        EditSession(
            asset: AssetRef(url: URL(fileURLWithPath: "/tmp/maple-auto-test.dng")),
            model: .default,
            culling: CullingState()
        )
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
        // #1387: AUTO's exposure is measured against an AE-Off probe, so
        // autoExposure must flip alongside exposure — otherwise a
        // Profile.neutral decode double-counts the AE anchor gain.
        XCTAssertEqual(after.autoExposure, .off)
        // One undo entry restores the pre-AUTO model.
        XCTAssertTrue(state.canUndo)
        state.undo()
        XCTAssertEqual(state.session.model.exposure, AdjustmentModel.default.exposure, accuracy: 1e-9)
        XCTAssertEqual(state.session.model.autoExposure, AdjustmentModel.default.autoExposure)
    }

    /// #1387 — the exact regression this ticket closes: on `Profile.neutral`
    /// the Apple decode honours the sidecar's `auto_exposure` (default On)
    /// rather than forcing it off the way `Profile.auto` does, so AUTO must
    /// explicitly pin `autoExposure = .off` alongside its exposure
    /// recommendation or the AE anchor gain and AUTO's lift double-count,
    /// rendering too bright.
    func testApplyAutoSetsAutoExposureOffOnNeutralProfile() async {
        let session = makeFileBackedSession()
        let state = EditorState(session: session)
        state.autoProvider = { _ in
            AutoAdjustmentsResult(
                exposure: 0.8, temperature: 6500, tint: 0,
                contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0
            )
        }
        var dirty = session.model
        dirty.profile = .neutral
        XCTAssertEqual(dirty.autoExposure, .on, "precondition: fresh model starts AE-On")
        session.model = dirty

        await state.applyAuto()

        let after = state.session.model
        XCTAssertEqual(after.profile, .neutral, "AUTO must not touch the render profile")
        XCTAssertEqual(after.autoExposure, .off,
                       "AUTO must pin autoExposure Off on Neutral so the decode it measured "
                       + "the recommendation against is the one that actually renders")
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
