// WbSliderFrame.swift — Swift carrier of the decode-exported WB slider frame
// (#1781).
//
// raw-core's develop chain interprets the temperature/tint sliders in a
// camera-specific calibration frame (`wb_camera::SliderFrame`, #1727/#1756).
// The scene-linear decode FFI exports the resolved frame's data on
// `MapleSceneLinearBufferF32` (`wb_frame_*` tail fields); this struct carries
// it through the Swift session so:
//
//   * the GPU live chain (`MapleGpuLiveParams.wb_frame_*`) and the CPU
//     per-tick chain (`MapleAdjustmentParams.wb_frame_*`) derive their WB
//     delta in the SAME frame the full develop uses — closing the
//     live-vs-refine seam (#1781's TestFlight band);
//   * the editor seeds its As-Shot slider values from raw-core's own
//     `(sceneCCT, asShotTint)` estimate instead of the `CIRAWFilter`
//     pre-decode placeholder (whose numbers live in a DIFFERENT frame —
//     4522 K vs the slider frame's ~5520 K on test_0002).
//
// `isPresent == false` (all-zero export: `RawlerFallback` body, lossy
// LinearRaw, non-RAW asset, or a pre-#1781 Rust core) means "no frame" —
// every consumer then keeps its legacy behaviour unchanged.

import Foundation
import RawPipeline

/// The decode-exported WB slider frame: two calibration endpoints
/// (XYZ→camera, row-major 3×3 as 9 floats), their CCTs, and the frame's
/// as-shot `(sceneCCT, asShotTint)` estimate.
public struct WbSliderFrame: Sendable, Equatable {
    /// Cold calibration endpoint, row-major 9 floats.
    public let mCold: [Float]
    public let cctCold: Float
    /// Warm calibration endpoint, row-major 9 floats (equal to `mCold`,
    /// with equal CCTs, for a single-calibration frame).
    public let mWarm: [Float]
    public let cctWarm: Float
    /// The frame's as-shot CCT — the slider's identity temperature.
    public let sceneCCT: Float
    /// The frame's as-shot tint (in-frame estimate; may sit at the ±100
    /// rail for bodies whose as-shot chromaticity is far off the locus).
    public let asShotTint: Float
    /// The RENDER PROFILE's CM (row-major 9 floats, XYZ→camera — the
    /// conjugation basis the GPU-live WB delta is built in (#1904 seam
    /// fix). Empty ⇒ absent; the Rust side then falls back to the value
    /// frame (pre-fix behaviour), so an un-populated frame stays sound.
    public let renderCm: [Float]

    /// Whether the export carries a real frame (`sceneCCT > 0`). All-zero
    /// exports read as absent — consumers keep legacy behaviour.
    public var isPresent: Bool { sceneCCT.isFinite && sceneCCT > 0 }

    public init(
        mCold: [Float], cctCold: Float,
        mWarm: [Float], cctWarm: Float,
        sceneCCT: Float, asShotTint: Float,
        renderCm: [Float] = []
    ) {
        self.mCold = mCold
        self.cctCold = cctCold
        self.mWarm = mWarm
        self.cctWarm = cctWarm
        self.sceneCCT = sceneCCT
        self.asShotTint = asShotTint
        self.renderCm = renderCm
    }

    /// Read the export off a decode buffer. Returns `nil` when the buffer
    /// carries no frame (`wb_frame_scene_cct <= 0` or non-finite — the
    /// same presence predicate as Rust's `SliderFrameExport::is_present`).
    init?(buffer: MapleSceneLinearBufferF32) {
        guard buffer.wb_frame_scene_cct.isFinite, buffer.wb_frame_scene_cct > 0 else { return nil }
        self.mCold = Self.array9(buffer.wb_frame_m_cold)
        self.cctCold = buffer.wb_frame_cct_cold
        self.mWarm = Self.array9(buffer.wb_frame_m_warm)
        self.cctWarm = buffer.wb_frame_cct_warm
        self.sceneCCT = buffer.wb_frame_scene_cct
        self.asShotTint = buffer.wb_frame_as_shot_tint
        self.renderCm = Self.array9(buffer.wb_frame_render_cm)
    }

    /// The imported C `float[9]` (a 9-tuple in Swift) as an array.
    static func array9(
        _ t: (Float, Float, Float, Float, Float, Float, Float, Float, Float)
    ) -> [Float] {
        [t.0, t.1, t.2, t.3, t.4, t.5, t.6, t.7, t.8]
    }

    /// An array back to the imported C `float[9]` 9-tuple shape. Missing
    /// lanes read 0 (defensive; the initializers above always carry 9).
    static func tuple9(
        _ a: [Float]
    ) -> (Float, Float, Float, Float, Float, Float, Float, Float, Float) {
        let v = { (i: Int) -> Float in i < a.count ? a[i] : 0 }
        return (v(0), v(1), v(2), v(3), v(4), v(5), v(6), v(7), v(8))
    }
}

extension WbSliderFrame {
    /// Fill the six `wb_frame_*` tail fields of the per-tick CPU chain
    /// params. Absent frame ⇒ the fields stay zero (the legacy path).
    func fill(_ p: inout MapleAdjustmentParams) {
        p.wb_frame_m_cold = Self.tuple9(mCold)
        p.wb_frame_cct_cold = cctCold
        p.wb_frame_m_warm = Self.tuple9(mWarm)
        p.wb_frame_cct_warm = cctWarm
        p.wb_frame_scene_cct = sceneCCT
        p.wb_frame_as_shot_tint = asShotTint
        p.wb_frame_render_cm = Self.tuple9(renderCm)
    }

    /// Fill the six `wb_frame_*` tail fields of the GPU live params.
    func fill(_ p: inout MapleGpuLiveParams) {
        p.wb_frame_m_cold = Self.tuple9(mCold)
        p.wb_frame_cct_cold = cctCold
        p.wb_frame_m_warm = Self.tuple9(mWarm)
        p.wb_frame_cct_warm = cctWarm
        p.wb_frame_scene_cct = sceneCCT
        p.wb_frame_as_shot_tint = asShotTint
        p.wb_frame_render_cm = Self.tuple9(renderCm)
    }

    // NOTE (#1976): there is deliberately NO decode-bake constant here.
    // The strip-XMP decode OMITS the WB fields (`omitWhiteBalance`,
    // #1883), so the buffer is an As-Shot develop — the per-tick delta
    // anchor is this frame's own `(sceneCCT, asShotTint)` pair
    // (`EditSession.wbDeltaAnchor`), which is also what seeds the sliders,
    // making the untouched-open delta exact identity. The old
    // `decodeBakeAnchor = (6500, 0)` constant described the pre-#1894
    // slider encoding of that same develop; after #1894 moved the identity
    // position to the as-shot pair it silently became a false statement
    // about the buffer and produced the global cyan overcool.
}
