// WbSliderFrameTests.swift — #1781: the decode-exported WB slider frame.
//
// Covers the Swift half of the live-vs-refine WB parity fix:
//   * `WbSliderFrame` presence semantics + the flat-C-array round trip,
//   * `fill(_:)` writing the `wb_frame_*` tails of both params structs,
//   * `EditSession.adoptDecodedWbFrame` — the decode's numbers win over the
//     `CIRAWFilter` placeholder for an untouched As-Shot model, and only
//     then,
//   * `EditSession.wbDeltaAnchor` — the strip-XMP decode-bake anchor when a
//     frame is present, the legacy as-shot estimate otherwise.

import XCTest
import RawPipeline
@testable import MapleCore

@MainActor
final class WbSliderFrameTests: XCTestCase {
    private func frame(sceneCCT: Float = 5520, asShotTint: Float = -12) -> WbSliderFrame {
        WbSliderFrame(
            mCold: [0.89, -0.10, 0.08, -0.43, 1.21, 0.22, -0.03, 0.14, 0.76],
            cctCold: 2856,
            mWarm: [0.75, -0.06, -0.05, -0.43, 1.21, 0.22, -0.09, 0.23, 0.65],
            cctWarm: 6504,
            sceneCCT: sceneCCT,
            asShotTint: asShotTint
        )
    }

    private func rawSession() -> EditSession {
        EditSession(asset: AssetRef(
            displayName: "frame.dng", hintExtension: "dng", stableID: "wbframe-test",
            explicitIsRaw: true, bytesProvider: { Data() }
        ))
    }

    // MARK: - Presence + round trip

    func testPresenceRequiresPositiveSceneCCT() {
        XCTAssertTrue(frame().isPresent)
        XCTAssertFalse(frame(sceneCCT: 0).isPresent)
        XCTAssertFalse(frame(sceneCCT: -5520).isPresent)
        XCTAssertFalse(frame(sceneCCT: .nan).isPresent)
    }

    func testTupleArrayRoundTrip() {
        let a: [Float] = [1, 2, 3, 4, 5, 6, 7, 8, 9]
        XCTAssertEqual(WbSliderFrame.array9(WbSliderFrame.tuple9(a)), a)
    }

    func testFillWritesAdjustmentParamsTail() {
        let f = frame()
        var p = MapleAdjustmentParams()
        f.fill(&p)
        XCTAssertEqual(p.wb_frame_scene_cct, 5520)
        XCTAssertEqual(p.wb_frame_as_shot_tint, -12)
        XCTAssertEqual(p.wb_frame_cct_cold, 2856)
        XCTAssertEqual(p.wb_frame_cct_warm, 6504)
        XCTAssertEqual(WbSliderFrame.array9(p.wb_frame_m_cold), f.mCold)
        XCTAssertEqual(WbSliderFrame.array9(p.wb_frame_m_warm), f.mWarm)
    }

    func testFillWritesGpuLiveParamsTail() {
        let f = frame()
        var p = MapleGpuLiveParams()
        f.fill(&p)
        XCTAssertEqual(p.wb_frame_scene_cct, 5520)
        XCTAssertEqual(p.wb_frame_as_shot_tint, -12)
        XCTAssertEqual(WbSliderFrame.array9(p.wb_frame_m_cold), f.mCold)
    }

    func testMakeParamsLeavesTailZeroWithoutFrame() {
        let p = PipelineRenderer.makeParams(from: .default)
        XCTAssertEqual(p.wb_frame_scene_cct, 0)
        XCTAssertEqual(WbSliderFrame.array9(p.wb_frame_m_cold), Array(repeating: 0, count: 9))
    }

    func testMakeGpuLiveParamsCarriesFrame() {
        let p = PipelineRenderer.makeGpuLiveParams(
            from: .default, asShotCCT: 6500, asShotTint: 0, wbFrame: frame()
        )
        XCTAssertEqual(p.wb_frame_scene_cct, 5520)
        XCTAssertEqual(p.decoded_temperature, 6500)
        XCTAssertEqual(p.decoded_tint, 0)
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

    func testAnchorIsDecodeBakeWhenFramePresent() {
        let session = rawSession()
        session.asShotCCT = 4522
        session.asShotTint = -43.65
        session.adoptDecodedWbFrame(frame())

        let anchor = session.wbDeltaAnchor
        XCTAssertEqual(anchor?.temperature ?? 0, 6500, accuracy: 0.01)
        XCTAssertEqual(anchor?.tint ?? -1, 0, accuracy: 0.01)
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
