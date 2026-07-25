// AdjustmentModel+BlackWhite.swift — Black & white mix toggle (#276).
//
// Split out of `AdjustmentModel.swift` to keep that file under
// `CONTRIBUTING.md`'s 600-line hard budget (same reason `CullingState` /
// `CullFlag` split into their own file in this change). Mirrors
// `raw_core::types::adjustment::BlackWhiteMode`.

import Foundation

// MARK: - BlackWhiteMode

/// Black & white mix toggle (raw-core ticket #276). Mirrors
/// `raw_core::types::adjustment::BlackWhiteMode` — gates the 8-band Oklab
/// stage (the same stage the HSL sliders drive) into its monochrome path:
/// the `grayMixer*` weights become per-hue-band luminance weights and
/// chroma is forced to zero. `.off` (default) matches raw-core's parse
/// default; the 24 HSL sliders are inert while this is `.on`, and the
/// eight `grayMixer*` weights are inert while it is `.off`. XMP key
/// `crs:ConvertToGrayscale` (`"True"`/`"False"`); `.off` (default) omits
/// the attribute on write, same convention as `AutoExposureMode`.
public enum BlackWhiteMode: String, Codable, Sendable, Hashable, CaseIterable {
    case off = "Off"
    case on  = "On"
}
