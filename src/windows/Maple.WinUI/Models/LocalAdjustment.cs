// LocalAdjustment — hand-written C# mirror of
// `raw_core::types::local_adjustment` (#280/#358).
//
// `local_adjustments` is deliberately excluded from codegen
// (`raw-core/src/types/adjustment/schema/mod.rs`, `NON_COPYABLE_FIELDS`):
// a layer stack is a nested list, not a flat slider, so this mirror is
// permanent — the same split `CropState` and `CurvePoint` use. The XMP
// wire form (`crs:GradientBasedCorrections` /
// `crs:CircularGradientBasedCorrections`) lives in
// `Services/Xmp/XmpLocalAdjustments.cs`; `docs/xmp-canonical-format.md`
// § "Local adjustments" is the contract.
//
// Records throughout so the layer stack compares by value — a round-trip
// test can assert `SequenceEqual` on the list, and `AdjustmentStateAssert`
// relies on that.

namespace Maple.WinUI.Models
{
    /// <summary>
    /// The subset of develop controls a mask can apply locally. A null
    /// field is a true no-op ("do not apply this control here"), which is
    /// NOT the same as 0 — saturation/vibrance at 0 still round-trip the
    /// pixel through Oklab, and temperature/tint being present at all
    /// engages a CAT16 matrix.
    /// </summary>
    public sealed record PartialAdjustments
    {
        public double? Exposure { get; init; }
        public double? Contrast { get; init; }
        public double? Highlights { get; init; }
        public double? Shadows { get; init; }
        public double? Whites { get; init; }
        public double? Blacks { get; init; }
        public double? Saturation { get; init; }
        public double? Vibrance { get; init; }
        public double? Temperature { get; init; }
        public double? Tint { get; init; }
        /// <summary>Oklab hue rotation: ±100 maps to ±30°, stored as ±1 in crs:LocalHue.</summary>
        public double? Hue { get; init; }

        // The six SPATIAL controls (#3407). Unlike the eleven point controls
        // above, every one of them reads a neighbourhood rather than a single
        // pixel, so raw-core runs them as one grouped pass over the layer's
        // output and blends the result back by the mask weight. On the wire
        // they ride Adobe's ±1 fraction scale, like crs:LocalHue.

        /// <summary>Fine-detail local contrast, −100…100; crs:LocalTexture.</summary>
        public double? Texture { get; init; }
        /// <summary>Structure-scale local contrast, −100…100; crs:LocalClarity2012.</summary>
        public double? Clarity { get; init; }
        /// <summary>Haze removal, −100…100; crs:LocalDehaze.</summary>
        public double? Dehaze { get; init; }
        /// <summary>Luminance-only unsharp mask, −100…100; crs:LocalSharpness.</summary>
        public double? Sharpness { get; init; }
        /// <summary>Luminance noise reduction, 0…100; crs:LocalLuminanceNoise.</summary>
        public double? LuminanceNoise { get; init; }
        /// <summary>Chroma-fringe suppression at high-contrast edges, 0…100; crs:LocalDefringe.</summary>
        public double? Defringe { get; init; }

        /// <summary>True when no field is set — the layer would change nothing.</summary>
        public bool IsEmpty =>
            Exposure is null && Contrast is null && Highlights is null && Shadows is null
            && Whites is null && Blacks is null && Saturation is null && Vibrance is null
            && Temperature is null && Tint is null && Hue is null && SpatialIsEmpty;

        /// <summary>
        /// True when none of the six spatial controls is set — split out of
        /// <see cref="IsEmpty"/> for the same reason raw-core splits
        /// `spatial_is_empty` out of `is_empty`: the point group and the
        /// spatial group are separate passes, asked about separately.
        /// </summary>
        public bool SpatialIsEmpty =>
            Texture is null && Clarity is null && Dehaze is null
            && Sharpness is null && LuminanceNoise is null && Defringe is null;
    }

    /// <summary>Normalized 2D point: X across the width, Y down from the top edge, both in [0, 1].</summary>
    public readonly record struct MaskPoint(double X, double Y);

    /// <summary>
    /// Mask shape — the per-pixel weight w ∈ [0, 1] a layer is scaled by.
    /// Mirror of `raw_core::types::Mask`; exactly two shapes today.
    /// </summary>
    public abstract record LocalMask;

    /// <summary>
    /// A straight gradient: Start's side of the perpendicular bisector sees
    /// w = 0, End's side w = 1; Feather is the smoothstep width as a
    /// fraction of the gradient length.
    /// </summary>
    public sealed record LinearMask(MaskPoint Start, MaskPoint End, double Feather) : LocalMask;

    /// <summary>
    /// An ellipse with half-axes Radii, rotated by Angle radians about
    /// Center. Inside w = 1, outside w = 0; Feather is a fraction of the
    /// radius. Invert flips the sense (Lightroom's "Invert" toggle).
    /// </summary>
    public sealed record RadialMask(
        MaskPoint Center, MaskPoint Radii, double Angle, double Feather, bool Invert) : LocalMask;

    /// <summary>One local-adjustment layer: a mask and the controls it scales.</summary>
    public sealed record LocalAdjustment(
        LocalMask Mask, PartialAdjustments Adjustments, ColorRangeRefinement? Range = null);

    /// <summary>Color selection multiplied into the primary mask; raw-core's Color range variant.</summary>
    public sealed record ColorRangeRefinement(
        double HueDeg, double HueHalfWidthDeg, double ChromaMin, double LMin, double LMax, double Feather);
}
