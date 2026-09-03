// LocalAdjustment.swift — hand-written Swift mirror of
// `raw_core::types::local_adjustment` (#280/#358, extended by #3274).
//
// `local_adjustments` is deliberately excluded from codegen
// (`raw-core/src/types/adjustment/schema/mod.rs`, `NON_COPYABLE_FIELDS`):
// a layer stack is a nested list, not a flat slider, so
// `AdjustmentModel+Generated.swift` never carries it and this mirror is
// permanent — the same generated-fields / hand-written-type split `Crop`
// and `ToneCurve` use. The XMP wire form (`crs:GradientBasedCorrections` /
// `crs:CircularGradientBasedCorrections` / `crs:MaskGroupBasedCorrections`)
// lives in `XMPSerialization+LocalAdjustments.swift`;
// `docs/xmp-canonical-format.md` § "Local adjustments" is the contract.
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
    /// Oklab hue rotation, −100…100 → ±30° (#3269, `crs:LocalHue`). Applied
    /// after `blacks` and before `saturation`, reusing saturation's
    /// soft-knee gamut handling.
    public var hue: Double?

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
        tint: Double? = nil,
        hue: Double? = nil
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
        self.hue = hue
    }

    /// True when no field is set — the layer would change nothing.
    public var isEmpty: Bool {
        exposure == nil && contrast == nil && highlights == nil && shadows == nil
            && whites == nil && blacks == nil && saturation == nil && vibrance == nil
            && temperature == nil && tint == nil && hue == nil
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

/// How a `.bitmap` mask's raster was produced (#3275). The raster itself is
/// a cache derivative keyed by `digest`, never stored in the sidecar — this
/// records enough to regenerate or invalidate it. Mirror of
/// `raw_core::types::BitmapRecipe`.
public struct BitmapRecipe: Codable, Sendable, Equatable, Hashable {
    public var person: Int
    public var facialSkin: Bool
    public var bodySkin: Bool
    public var model: String
    public var digest: String

    public init(person: Int, facialSkin: Bool, bodySkin: Bool, model: String, digest: String) {
        self.person = person
        self.facialSkin = facialSkin
        self.bodySkin = bodySkin
        self.model = model
        self.digest = digest
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
/// - `bitmap`: a per-pixel raster produced off-sidecar (#3271/#3275), keyed
///   by `rasterId` in the live raster registry; `recipe` records how to
///   rebuild it.
/// - `everywhere`: weight 1 over the whole frame — the whole-image case a
///   range refinement then narrows.
public enum LocalMask: Codable, Sendable, Equatable, Hashable {
    case linear(start: MaskPoint, end: MaskPoint, feather: Double)
    case radial(center: MaskPoint, radii: MaskPoint, angle: Double, feather: Double, invert: Bool)
    case bitmap(recipe: BitmapRecipe, rasterId: UInt32)
    case everywhere
}

/// An optional colour-range gate multiplied into the mask weight (#3270) —
/// an Oklab band, so "the skin in this gradient" is one layer rather than a
/// hand-painted mask. Mirror of `raw_core::types::RangeRefinement`.
public enum RangeRefinement: Codable, Sendable, Equatable, Hashable {
    case color(
        hueDeg: Double, hueHalfWidthDeg: Double, chromaMin: Double,
        lMin: Double, lMax: Double, feather: Double)

    /// The preset the skin-tone workflow arms by default (spec §3.2).
    public static let skinTone: RangeRefinement = .color(
        hueDeg: 55.0, hueHalfWidthDeg: 25.0, chromaMin: 0.02,
        lMin: 0.15, lMax: 0.95, feather: 0.3
    )
}

/// One local-adjustment layer: a mask, an optional colour-range refinement,
/// and the controls they scale.
public struct LocalAdjustment: Codable, Sendable, Equatable, Hashable, Identifiable {
    /// Stable identity for SwiftUI list/selection only — deliberately NOT
    /// part of `==`/`hash` (see below) and not present in the Rust type.
    public let id: UUID
    public var mask: LocalMask
    public var range: RangeRefinement?
    public var adjustments: PartialAdjustments

    public init(
        id: UUID = UUID(),
        mask: LocalMask,
        range: RangeRefinement? = nil,
        adjustments: PartialAdjustments
    ) {
        self.id = id
        self.mask = mask
        self.range = range
        self.adjustments = adjustments
    }

    public static func == (lhs: LocalAdjustment, rhs: LocalAdjustment) -> Bool {
        // Identity excluded from equality: two layers with the same content
        // but different UUIDs (e.g. a decode/re-encode round trip) compare
        // equal — matching the Rust `LocalAdjustment`'s derived `PartialEq`,
        // which has no id field at all.
        lhs.mask == rhs.mask && lhs.range == rhs.range && lhs.adjustments == rhs.adjustments
    }

    // Hashes only the fields `==` compares — `id` must stay out so two
    // equal values (per the override above) never hash unequally.
    public func hash(into hasher: inout Hasher) {
        hasher.combine(mask)
        hasher.combine(range)
        hasher.combine(adjustments)
    }

    private enum CodingKeys: String, CodingKey {
        case id, mask, range, adjustments
    }

    /// `id` is decoded leniently: it is a UI-side identity with no Rust
    /// counterpart, so a sidecar/JSON written before #3274 (or by any other
    /// platform's writer) carries no `id` field and must still decode.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        self.mask = try c.decode(LocalMask.self, forKey: .mask)
        self.range = try c.decodeIfPresent(RangeRefinement.self, forKey: .range)
        self.adjustments = try c.decode(PartialAdjustments.self, forKey: .adjustments)
    }
}
