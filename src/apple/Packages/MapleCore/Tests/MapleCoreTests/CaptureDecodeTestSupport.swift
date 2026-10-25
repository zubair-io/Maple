// CaptureDecodeTestSupport.swift — how the tests drive a capture decode
// (#5377) the way the editor does.

import Foundation
@testable import MapleCore

extension ImageEditPipeline.SceneLinearDecodeResult {
    /// `model` at this decode's As-Shot white balance: the frame's own pair,
    /// which the editor seeds an untouched model with
    /// (`EditSession.adoptDecodedWbFrame`). The creative stage reads the
    /// slider pair as absolute, so an unseeded model would render at the
    /// literal 6500 K / 0 default instead.
    func atAsShot(_ model: AdjustmentModel) -> AdjustmentModel {
        guard let frame = wbFrame, frame.isPresent else { return model }
        var seeded = model
        seeded.temperature = Double(frame.sceneCCT)
        seeded.tint = Double(frame.asShotTint)
        return seeded
    }
}
