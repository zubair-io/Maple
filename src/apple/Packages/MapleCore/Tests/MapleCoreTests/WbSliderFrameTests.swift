// WbSliderFrameTests.swift — the decode-exported slider frame and creative
// stage (#1781, #5377).
//
// Covers:
//   * `WbSliderFrame` presence semantics,
//   * `fill(_:)` pointing both params structs at the capture decode's
//     creative stage, and leaving them null without one,
//   * `EditSession.adoptDecodedWbFrame` — the decode's numbers win over the
//     `CIRAWFilter` placeholder for an untouched As-Shot model, and only
//     then,
//   * `EditSession.wbDeltaAnchor` — the frame's own as-shot pair when a
//     frame is present, the legacy as-shot estimate otherwise.

import XCTest
import RawPipeline
@testable import MapleCore

@MainActor
final class WbSliderFrameTests: XCTestCase {
    private func frame(sceneCCT: Float = 5520, asShotTint: Float = -12) -> WbSliderFrame {
        WbSliderFrame(sceneCCT: sceneCCT, asShotTint: asShotTint)
    }

    private func creative() -> CaptureCreative {
        var flat = MapleCaptureCreative()
        flat.present = 1
        flat.ae_gain = 1.7
        return CaptureCreative(flat)!
    }

    private func rawSession() -> EditSession {
        EditSession(asset: AssetRef(
            displayName: "frame.dng", hintExtension: "dng", stableID: "wbframe-test",
            explicitIsRaw: true, bytesProvider: { Data() }
        ))
    }

    // MARK: - Presence + creative stage

    func testPresenceRequiresPositiveSceneCCT() {
        XCTAssertTrue(frame().isPresent)
        XCTAssertFalse(frame(sceneCCT: 0).isPresent)
        XCTAssertFalse(frame(sceneCCT: -5520).isPresent)
        XCTAssertFalse(frame(sceneCCT: .nan).isPresent)
    }

    func testOnlyACaptureDecodeMakesACreativeStage() {
        XCTAssertNil(CaptureCreative(MapleCaptureCreative()))
        XCTAssertEqual(creative().aeGain, 1.7)
    }

    func testABufferWithoutAFrameKeepsItsCreativeStage() {
        let stage = creative()
        let fromBuffer = WbSliderFrame(buffer: MapleSceneLinearBufferF32(), creative: stage)
        XCTAssertNotNil(fromBuffer)
        XCTAssertFalse(fromBuffer?.isPresent ?? true)
        XCTAssertTrue(fromBuffer?.creative === stage)
        XCTAssertNil(WbSliderFrame(buffer: MapleSceneLinearBufferF32(), creative: nil))
    }

    /// #5377: both params structs point at the decode's creative stage;
    /// a frame without one leaves them null.
    func testFillPointsBothParamsAtTheCreativeStage() {
        let stage = creative()
        let f = WbSliderFrame(sceneCCT: 5520, asShotTint: -12, creative: stage)
        var cpu = MapleAdjustmentParams()
        var gpu = MapleGpuLiveParams()
        f.fill(&cpu)
        f.fill(&gpu)
        XCTAssertEqual(cpu.creative_ptr, UnsafePointer(stage.pointer))
        XCTAssertEqual(gpu.creative_ptr, UnsafePointer(stage.pointer))
        XCTAssertEqual(cpu.creative_ptr?.pointee.ae_gain, 1.7)

        var none = MapleGpuLiveParams()
        frame().fill(&none)
        XCTAssertNil(none.creative_ptr)
    }

    func testMakeParamsCarriesTheCreativeStage() {
        let stage = creative()
        let f = WbSliderFrame(sceneCCT: 5520, asShotTint: -12, creative: stage)
        XCTAssertNil(PipelineRenderer.makeParams(from: .default).creative_ptr)
        XCTAssertEqual(
            PipelineRenderer.makeParams(from: .default, wbFrame: f).creative_ptr,
            UnsafePointer(stage.pointer))
        XCTAssertEqual(
            PipelineRenderer.makeGpuLiveParams(from: .default, wbFrame: f).creative_ptr,
            UnsafePointer(stage.pointer))
    }

    func testFramesOfDifferentDecodesDiffer() {
        XCTAssertEqual(frame(), frame())
        XCTAssertNotEqual(
            WbSliderFrame(sceneCCT: 5520, asShotTint: -12, creative: creative()),
            WbSliderFrame(sceneCCT: 5520, asShotTint: -12, creative: creative()))
    }

    // MARK: - Adoption (#1781 scope addition: the decode's number wins)

    func testAdoptReSeedsUntouchedPlaceholderModel() {
        let session = rawSession()
        // Pre-decode placeholder seed (the CIRAWFilter numbers).
        session.asShotCCT = 4522
        session.asShotTint = -43.65
        session.wbSeedTemperature = 4522
        session.wbSeedTint = -43.65
        session.model.temperature = 4522
        session.model.tint = -43.65
        session.originalModel.temperature = 4522
        session.originalModel.tint = -43.65

        session.adoptDecodedWbFrame(frame(sceneCCT: 5520, asShotTint: -100))

        XCTAssertEqual(session.asShotCCT ?? 0, 5520, accuracy: 0.01)
        XCTAssertEqual(session.asShotTint ?? 0, -100, accuracy: 0.01)
        XCTAssertEqual(session.model.temperature, 5520, accuracy: 0.01)
        XCTAssertEqual(session.model.tint, -100, accuracy: 0.01)
        XCTAssertEqual(session.originalModel.temperature, 5520, accuracy: 0.01)
        XCTAssertEqual(session.originalModel.tint, -100, accuracy: 0.01)
    }

    /// #5377: a capture decode with no slider frame renders the slider pair
    /// as an absolute post-DCP white balance, so an untouched placeholder
    /// model re-seeds to the develop's identity, and a second decode with
    /// the same pair replaces the frame without re-seeding.
    func testAdoptReSeedsAFramelessCaptureToTheDevelopIdentity() {
        let session = rawSession()
        session.wbSeedTemperature = 5000
        session.wbSeedTint = 10
        session.model.temperature = 5000
        session.model.tint = 10
        session.originalModel.temperature = 5000
        session.originalModel.tint = 10

        session.adoptDecodedWbFrame(WbSliderFrame(sceneCCT: 0, asShotTint: 0, creative: creative()))

        XCTAssertEqual(session.model.temperature, 6500)
        XCTAssertEqual(session.model.tint, 0)
        XCTAssertEqual(session.originalModel.temperature, 6500)

        session.model.temperature = 6000
        let next = WbSliderFrame(sceneCCT: 0, asShotTint: 0, creative: creative())
        session.adoptDecodedWbFrame(next)
        XCTAssertEqual(session.model.temperature, 6000, "the same pair must not re-seed")
        XCTAssertEqual(session.wbSliderFrame, next, "the newer decode's stage must replace the old")
    }

    /// A bytes-backed RAW (no `primaryURL`) never gets the `CIRAWFilter`
    /// placeholder — hydration seeds the model with the DEFAULTS and
    /// records them as the seed. Adoption must still re-seed (the
    /// placeholder-equality gate this replaces left these sessions stuck
    /// at 6500/0).
    func testAdoptReSeedsDefaultSeededModelWithoutPlaceholder() {
        let session = rawSession()
        // No placeholder read: asShot stays nil, seed = model defaults.
        session.wbSeedTemperature = session.model.temperature
        session.wbSeedTint = session.model.tint

        session.adoptDecodedWbFrame(frame(sceneCCT: 5520, asShotTint: -100))

        XCTAssertEqual(session.model.temperature, 5520, accuracy: 0.01)
        XCTAssertEqual(session.model.tint, -100, accuracy: 0.01)
        XCTAssertEqual(session.originalModel.temperature, 5520, accuracy: 0.01)
        XCTAssertEqual(session.originalModel.tint, -100, accuracy: 0.01)
    }

    /// Authored sidecar values ⇒ hydration records NO seed ⇒ adoption
    /// never touches the model, even if the sliders numerically equal the
    /// defaults.
    func testAdoptLeavesSidecarSeededModelAlone() {
        let session = rawSession()
        session.wbSeedTemperature = nil
        session.wbSeedTint = nil

        session.adoptDecodedWbFrame(frame(sceneCCT: 5520, asShotTint: -100))

        XCTAssertEqual(session.model.temperature, 6500, accuracy: 0.01)
        XCTAssertEqual(session.model.tint, 0, accuracy: 0.01)
    }

    func testAdoptLeavesUserAuthoredWBAlone() {
        let session = rawSession()
        session.asShotCCT = 4522
        session.asShotTint = -43.65
        // The user (or a sidecar) authored an explicit WB — not the seed.
        session.model.temperature = 6282
        session.model.tint = -44
        session.originalModel.temperature = 6282
        session.originalModel.tint = -44

        session.adoptDecodedWbFrame(frame())

        // Estimate updates; the authored model does not.
        XCTAssertEqual(session.asShotCCT ?? 0, 5520, accuracy: 0.01)
        XCTAssertEqual(session.model.temperature, 6282, accuracy: 0.01)
        XCTAssertEqual(session.model.tint, -44, accuracy: 0.01)
    }

    func testAdoptIgnoresAbsentFrame() {
        let session = rawSession()
        session.asShotCCT = 4522
        session.asShotTint = -43.65

        session.adoptDecodedWbFrame(nil)
        session.adoptDecodedWbFrame(frame(sceneCCT: 0))

        XCTAssertNil(session.wbSliderFrame)
        XCTAssertEqual(session.asShotCCT ?? 0, 4522, accuracy: 0.01)
    }

    // MARK: - Anchor derivation

    func testAnchorIsFrameAsShotWhenFramePresent() {
        let session = rawSession()
        session.asShotCCT = 4522
        session.asShotTint = -43.65
        session.adoptDecodedWbFrame(frame())

        // #1976: the anchor is the WB the strip-XMP decode actually baked —
        // the frame's own as-shot pair, NOT a 6500/0 constant (which
        // described a warm develop that never existed and cyan-overcooled
        // every settled render).
        let anchor = session.wbDeltaAnchor
        XCTAssertEqual(anchor?.temperature ?? 0, 5520, accuracy: 0.01)
        XCTAssertEqual(anchor?.tint ?? 0, -12, accuracy: 0.01)
    }

    func testAnchorPrefersFrameOverStaleSessionEstimate() {
        // Directly assign the frame (bypassing adoption's estimate update)
        // to prove the anchor binds to the frame metadata itself, not to
        // whatever placeholder the session estimates happen to hold.
        let session = rawSession()
        session.asShotCCT = 6500 // stale placeholder
        session.asShotTint = 0
        session.wbSliderFrame = frame(sceneCCT: 4522, asShotTint: -43.79)

        let anchor = session.wbDeltaAnchor
        XCTAssertEqual(anchor?.temperature ?? 0, 4522, accuracy: 0.01)
        XCTAssertEqual(anchor?.tint ?? 0, -43.79, accuracy: 0.01)
    }

    func testAnchorFallsBackToAsShotEstimateWithoutFrame() {
        let session = rawSession()
        session.asShotCCT = 4522
        session.asShotTint = -43.65

        let anchor = session.wbDeltaAnchor
        XCTAssertEqual(anchor?.temperature ?? 0, 4522, accuracy: 0.01)
        XCTAssertEqual(anchor?.tint ?? 0, -43.65, accuracy: 0.01)
    }
}
