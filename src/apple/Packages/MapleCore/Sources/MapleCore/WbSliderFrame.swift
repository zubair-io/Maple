// WbSliderFrame.swift — Swift carrier of what a capture decode hands the
// per-tick chains (#1781, #5377).
//
// raw-core's develop interprets the temperature/tint sliders in a
// camera-specific calibration frame (`wb_camera::SliderFrame`, #1727/#1756).
// The capture decode (`maple_render_*_capture*_f32`) returns the capture
// result — the RAW developed up to, but not including, white balance and the
// camera profile — together with the creative stage that renders it
// (`MapleCaptureCreative`). This struct carries both through the Swift
// session so:
//
//   * the GPU live chain (`MapleGpuLiveParams.creative_ptr`) and the CPU
//     per-tick chain (`MapleAdjustmentParams.creative_ptr`) run the same
//     creative stage the full develop runs, at the absolute slider pair —
//     live equals refine by construction (#5213);
//   * the editor seeds its As-Shot slider values from raw-core's own
//     `(sceneCCT, asShotTint)` estimate instead of the `CIRAWFilter`
//     pre-decode placeholder (whose numbers live in a DIFFERENT frame —
//     4522 K vs the slider frame's ~5520 K on test_0002).
//
// `isPresent == false` (`RawlerFallback` body, lossy LinearRaw) means the
// body has no slider frame; its creative stage still renders the decode.

import Foundation
import RawPipeline

/// A capture decode's creative stage (#5377), copied out of the decode
/// buffer once and pointed at by every tick's params. Immutable after init;
/// its tables pointer is valid for the life of the process, so the box is
/// safe to share across actors.
public final class CaptureCreative: @unchecked Sendable {
    let pointer: UnsafeMutablePointer<MapleCaptureCreative>

    /// `nil` unless the decode wrote a creative stage (`present == 1`).
    init?(_ creative: MapleCaptureCreative) {
        guard creative.present == 1 else { return nil }
        pointer = .allocate(capacity: 1)
        pointer.initialize(to: creative)
    }

    deinit {
        pointer.deinitialize(count: 1)
        pointer.deallocate()
    }

    /// The exposure gain the creative stage applies, measured on the
    /// as-shot render.
    public var aeGain: Float { pointer.pointee.ae_gain }
}

extension CaptureCreative: Equatable {
    /// One box per decode: identity is the decode's identity.
    public static func == (lhs: CaptureCreative, rhs: CaptureCreative) -> Bool {
        lhs === rhs
    }
}

/// The decode's slider frame as-shot pair and its creative stage.
public struct WbSliderFrame: Sendable, Equatable {
    /// The frame's as-shot CCT — the slider's identity temperature.
    public let sceneCCT: Float
    /// The frame's as-shot tint (in-frame estimate; may sit at the ±100
    /// rail for bodies whose as-shot chromaticity is far off the locus).
    public let asShotTint: Float
    /// The capture decode's creative stage; `nil` only for frames built
    /// without a decode.
    public let creative: CaptureCreative?

    /// Whether the export carries a real slider frame (`sceneCCT > 0`).
    public var isPresent: Bool { sceneCCT.isFinite && sceneCCT > 0 }

    public init(sceneCCT: Float, asShotTint: Float, creative: CaptureCreative? = nil) {
        self.sceneCCT = sceneCCT
        self.asShotTint = asShotTint
        self.creative = creative
    }

    /// Read the frame off a capture decode buffer. `nil` when the decode
    /// carries neither a slider frame nor a creative stage.
    init?(buffer: MapleSceneLinearBufferF32, creative: CaptureCreative?) {
        let present = buffer.wb_frame_scene_cct.isFinite && buffer.wb_frame_scene_cct > 0
        guard present || creative != nil else { return nil }
        self.sceneCCT = present ? buffer.wb_frame_scene_cct : 0
        self.asShotTint = present ? buffer.wb_frame_as_shot_tint : 0
        self.creative = creative
    }
}

extension WbSliderFrame {
    /// Point the per-tick CPU chain params at the creative stage. The frame
    /// must outlive the FFI call the params are passed to.
    func fill(_ p: inout MapleAdjustmentParams) {
        p.creative_ptr = creative.map { UnsafePointer($0.pointer) }
    }

    /// Point the GPU live params at the creative stage. The frame must
    /// outlive the FFI call the params are passed to.
    func fill(_ p: inout MapleGpuLiveParams) {
        p.creative_ptr = creative.map { UnsafePointer($0.pointer) }
    }
}
