// LocalAdjustment.swift — hand-written Swift mirror of
// `raw_core::types::local_adjustment` (#280/#358).
//
// `local_adjustments` is deliberately excluded from codegen
// (`raw-core/src/types/adjustment/schema/mod.rs`, `NON_COPYABLE_FIELDS`):
// a layer stack is a nested list, not a flat slider, so
// `AdjustmentModel+Generated.swift` never carries it and this mirror is
// permanent — the same generated-fields / hand-written-type split `Crop`
// and `ToneCurve` use. The XMP wire form (`crs:GradientBasedCorrections` /
// `crs:CircularGradientBasedCorrections`) lives in
// `XMPSerialization+LocalAdjustments.swift`; `docs/xmp-canonical-format.md`
// § "Local adjustments" is the contract.
//
// Coordinates are normalized to `[0, 1]` on each axis, origin top-left,
// independent of pixel dimensions — the same convention `Crop` uses — so
// one sidecar renders identically against full-res and downsampled buffers.

import Foundation

/// The subset of develop controls a mask can apply locally. Mirror of
/// `raw_core::types::PartialAdjustments`: a `nil` field is a true no-op
/// ("do not apply this control here"), which is NOT the same as `0` —
/// `saturation`/`vibrance` at `0` still round-trip the pixel through Oklab,
/// and `temperature`/`tint` being present at all engages a CAT16 matrix.
public struct PartialAdjustments: Codable, Sendable, Equatable, Hashable {
    public var exposure: Double?
    public var contrast: Double?
    public var highlights: Double?
    public var shadows: Double?
    public var whites: Double?
    public var blacks: Double?
    public var saturation: Double?
    public var vibrance: Double?
    public var temperature: Double?
    public var tint: Double?

    public init(
        exposure: Double? = nil,
        contrast: Double? = nil,
        highlights: Double? = nil,
        shadows: Double? = nil,
        whites: Double? = nil,
        blacks: Double? = nil,
        saturation: Double? = nil,
        vibrance: Double? = nil,
        temperature: Double? = nil,
        tint: Double? = nil
    ) {
        self.exposure = exposure
        self.contrast = contrast
        self.highlights = highlights
        self.shadows = shadows
        self.whites = whites
        self.blacks = blacks
        self.saturation = saturation
        self.vibrance = vibrance
        self.temperature = temperature
        self.tint = tint
    }

    /// True when no field is set — the layer would change nothing.
    public var isEmpty: Bool {
        exposure == nil && contrast == nil && highlights == nil && shadows == nil
            && whites == nil && blacks == nil && saturation == nil && vibrance == nil
            && temperature == nil && tint == nil
    }
}

/// Normalized 2D point: `x` across the width, `y` down from the top edge.
public struct MaskPoint: Codable, Sendable, Equatable, Hashable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

/// Mask shape — the per-pixel weight `w ∈ [0, 1]` a layer is scaled by.
/// Mirror of `raw_core::types::Mask`.
///
/// - `linear`: a straight gradient. `start`'s side of the perpendicular
///   bisector sees `w = 0`, `end`'s side `w = 1`; `feather` is the
///   smoothstep width as a fraction of the gradient length.
/// - `radial`: an ellipse with half-axes `radii`, rotated by `angle`
///   radians about `center`. Inside `w = 1`, outside `w = 0`; `feather` is
///   a fraction of the radius. `invert` flips the sense (Lightroom's
///   "Invert" toggle).
public enum LocalMask: Codable, Sendable, Equatable, Hashable {
    case linear(start: MaskPoint, end: MaskPoint, feather: Double)
    case radial(center: MaskPoint, radii: MaskPoint, angle: Double, feather: Double, invert: Bool)
}

/// One local-adjustment layer: a mask and the controls it scales.
public struct LocalAdjustment: Codable, Sendable, Equatable, Hashable {
    public var mask: LocalMask
    public var adjustments: PartialAdjustments

    public init(mask: LocalMask, adjustments: PartialAdjustments) {
        self.mask = mask
        self.adjustments = adjustments
    }
}
