//! Local-adjustment + mask schema types (ticket #280).
//!
//! A `LocalAdjustment` is a (mask, partial-adjustments) pair. Applied between
//! `dehaze` and `sharpen` (see `pipeline::develop`), each layer modifies the
//! scene-linear Rec.2020 buffer by applying its `PartialAdjustments` weighted
//! by the per-pixel mask value `w ∈ [0, 1]`.
//!
//! Current scope:
//!
//! * Four mask shapes — `Linear` (gradient line), `Radial` (ellipse),
//!   `Bitmap` (a host-supplied raster, #3271 — a Vision person/skin
//!   selection today), and `Everywhere` (weight 1, the no-person-detected
//!   fallback). Brush masks defer to a follow-up ticket. A `Bitmap`'s
//!   pixels never round-trip through the sidecar — `LocalAdjustment.range`
//!   and the recipe attributes do; the raster is derived data, regenerated
//!   from the recipe or read from a device-local cache.
//! * An optional [`RangeRefinement`] (#3270) narrows any mask further,
//!   evaluated on the pixel entering the stage rather than the layer's own
//!   output.
//! * Every field on `PartialAdjustments` is wired in
//!   `stages::local_adjustments::apply` (PR #1450, closed #1422) — see that
//!   module's own docs for the full per-pixel apply order and the operators
//!   behind each control.
//! * Wire format is the canonical `crs:GradientBasedCorrections` /
//!   `crs:CircularGradientBasedCorrections` nested-RDF form (#358,
//!   `xmp::local_adjustments`) — ACR/Lightroom-readable, unlike Slice 1's
//!   single `papp:LocalAdjustments` JSON attribute (still parsed for
//!   migration by [`wire::decode_local_adjustments`], never written).
//!
//! Coordinates are normalized to `[0, 1]` on each axis, origin top-left,
//! independent of pixel dimensions. This keeps masks resolution-agnostic so
//! the same XMP renders identically against full-res and downsampled
//! buffers.

pub mod flat;
mod raster;
mod wire;

pub use flat::{layers_from_flat, layers_to_flat, LAYER_FLAT_LEN};
pub use raster::MaskRaster;
pub use wire::{decode_local_adjustments, encode_local_adjustments};

/// A subset of `AdjustmentModel` that may be applied locally (within a mask).
///
/// `None` means "do not apply this control locally"; `Some(v)` means "apply
/// with strength v, scaled by mask weight." Combining strategy is per-field
/// and lives in `stages::local_adjustments::apply`.
///
/// Every field is wired in `stages::local_adjustments::apply`, applied
/// in this order: `exposure` → `temperature`/`tint` → `contrast` →
/// `highlights` → `shadows` → `whites` → `blacks` → `hue` → `saturation` →
/// `vibrance`. See that module's docs for the operator behind each control
/// (e.g. `contrast` is a scene-linear, luma-ratio-preserving power curve
/// pivoted at 0.18 grey — global contrast routes to the AgX sigmoid slope
/// instead, since AgX runs after this stage and a local mask can't share
/// that path).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PartialAdjustments {
    pub exposure: Option<f32>,
    pub contrast: Option<f32>,
    pub highlights: Option<f32>,
    pub shadows: Option<f32>,
    pub whites: Option<f32>,
    pub blacks: Option<f32>,
    pub saturation: Option<f32>,
    pub vibrance: Option<f32>,
    pub temperature: Option<f32>,
    pub tint: Option<f32>,
    /// Oklab hue rotation of the masked pixels, −100 … 100 → ±`HSL_HUE_MAX_RAD`
    /// (30° at full deflection, the HSL stage's constant). Lightness and
    /// chroma are preserved; the same soft-knee gamut handling as saturation.
    /// The control the skin-tone workflow drags (#3269).
    pub hue: Option<f32>,
}

impl PartialAdjustments {
    /// `true` iff at least one field is `Some` — i.e. the layer would change
    /// something. Used by the apply stage to skip the mask-eval cost when
    /// a layer carries no adjustments.
    pub fn is_empty(&self) -> bool {
        self.exposure.is_none()
            && self.contrast.is_none()
            && self.highlights.is_none()
            && self.shadows.is_none()
            && self.whites.is_none()
            && self.blacks.is_none()
            && self.saturation.is_none()
            && self.vibrance.is_none()
            && self.temperature.is_none()
            && self.tint.is_none()
            && self.hue.is_none()
    }
}

/// Normalized 2D point: x ∈ [0,1] across the image width, y ∈ [0,1] down
/// from the top edge. Resolution-agnostic.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Point2 {
    pub x: f32,
    pub y: f32,
}

impl Point2 {
    pub const fn new(x: f32, y: f32) -> Self {
        Self { x, y }
    }
}

/// Mask shape. Each variant defines a scalar weight `w ∈ [0, 1]` at every
/// pixel.
///
/// * `Linear` — a straight gradient between two endpoints. Pixels on
///   `start`'s side of the perpendicular bisector see w=0, pixels on `end`'s
///   side see w=1, and a smoothstep transition spans `feather` units
///   (also normalized — `feather` is a fraction of the gradient length).
/// * `Radial` — an axis-aligned ellipse rotated by `angle` radians. Inside
///   the inner radius w=1; outside w=0; transition spans `feather`
///   (normalized). `invert=true` flips the sense (w=0 inside, w=1 outside),
///   which matches Lightroom's "Invert" toggle on radial masks.
#[derive(Clone, Debug, PartialEq)]
pub enum Mask {
    Linear {
        /// Start of the gradient (w=0 side).
        start: Point2,
        /// End of the gradient (w=1 side).
        end: Point2,
        /// Feather, as a fraction of the gradient length. 0 = hard step,
        /// 1 = smooth across the whole length. Clamped to [0, 1] on apply.
        feather: f32,
    },
    Radial {
        /// Centre of the ellipse in normalized coords.
        center: Point2,
        /// Half-axes (rx, ry) before rotation, in normalized units.
        radii: Point2,
        /// Rotation in radians, counter-clockwise about `center`.
        angle: f32,
        /// Feather, as a fraction of the radius. 0 = hard step.
        feather: f32,
        /// If true, mask sense is inverted (1 outside, 0 inside).
        invert: bool,
    },
    /// A host-supplied raster (#3271, spec §5.3) — a person/skin selection
    /// from `PersonSkinMaskService` today, any bitmap source in principle.
    /// `raster_id` is the flat-wire id a registered [`MaskRaster`] carries;
    /// `0` means unresolved, which evaluates to weight 0 (never a global
    /// correction) rather than silently falling back to `Everywhere`.
    Bitmap {
        recipe: BitmapRecipe,
        raster_id: u32,
    },
    /// Weight 1 everywhere — the "skin range only (whole image)" fallback
    /// when no person is detected (spec §3.2).
    Everywhere,
}

/// The recipe that regenerates a bitmap mask's raster (#3271, spec §5.3).
/// Every field is opaque identity data to Rust — the host (Apple Vision
/// today) turns it into a raster and registers it; the sidecar stores the
/// recipe, never pixels, so a device without the cached raster regenerates
/// it from these fields.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BitmapRecipe {
    pub person: u32,
    pub facial_skin: bool,
    pub body_skin: bool,
    /// Segmentation model identifier, e.g. `apple-vision-person-instance/1`.
    pub model: String,
    /// 16 lowercase hex chars, the host-computed digest that also names the
    /// raster in the registry and the on-disk cache.
    pub digest: String,
}

/// A per-pixel refinement multiplied into the primary mask's weight, computed
/// from the pixel ENTERING the local-adjustments stage (so it never chases
/// the layer's own edit, and it tracks upstream exposure / white balance).
/// Spec §5.2. One variant today; Lightroom composes range masks the same
/// way, as refinements of a primary mask rather than standalone masks.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RangeRefinement {
    /// An Oklab hue band with chroma and lightness gates. Weight is 1 inside
    /// the inner `(1 − feather)·half_width` of the band, rolls off with a
    /// raised cosine to 0 at `half_width`, gated by
    /// `smoothstep(chroma_min, 2·chroma_min, C)` and by the lightness window
    /// `[l_min, l_max]` with a fixed 0.05 L roll-off on each side.
    Color {
        hue_deg: f32,
        hue_half_width_deg: f32,
        chroma_min: f32,
        l_min: f32,
        l_max: f32,
        feather: f32,
    },
}

/// The skin preset (spec §5.2). `hue_deg = 55°` is the commonly-cited
/// "skin locus" angle; the other values were the design's starting seed.
///
/// Measured against `examples/skin-range-probe.rs` on the two portrait
/// fixtures (2026-09-03): `test_0002` (studio, near-neutral as-shot WB)
/// clusters tightly at hue 53–63° (p5–p95), matching this preset closely.
/// `test_0003` (warm, backlit outdoor light) clusters at hue −48° to +16°
/// across two different skin patches, with chroma sitting near this
/// preset's `chroma_min` floor — a real, ~80–100° divergence from
/// `test_0002`, not a measurement artifact (checked against two separate
/// regions of the same photo). No single hue band centered anywhere
/// reasonable covers both without becoming wide enough to admit most
/// non-green/cyan hues, which would defeat the refinement's purpose.
///
/// This preset is therefore deliberately left at its literature-reasonable
/// seed rather than fit to either fixture: within this epic's design (spec
/// §5.3), the geometric Vision person/face mask is the primary selector,
/// and this colour range is a coarse refinement on TOP of it — excluding
/// obviously non-skin colours (saturated backgrounds, dark clothing) within
/// the already-geometric person region, not a universal skin detector
/// expected to be white-balance-invariant on its own. A future per-scene or
/// per-mask-adjustable range (the eyedropper #362 already plans) is the
/// right fix for a photo like `test_0003`, not a wider global constant.
pub const SKIN_TONE_RANGE: RangeRefinement = RangeRefinement::Color {
    hue_deg: 55.0,
    hue_half_width_deg: 25.0,
    chroma_min: 0.02,
    l_min: 0.15,
    l_max: 0.95,
    feather: 0.3,
};

/// One local-adjustment layer.
#[derive(Clone, Debug, PartialEq)]
pub struct LocalAdjustment {
    /// Mask shape — determines the per-pixel weight w ∈ [0, 1].
    pub mask: Mask,
    /// Refinement multiplied into the mask weight; `None` = the primary mask
    /// alone.
    pub range: Option<RangeRefinement>,
    /// Adjustments to apply, scaled by the mask weight.
    pub adjustments: PartialAdjustments,
}

impl LocalAdjustment {
    /// Construct a linear-mask layer with the given start/end points and
    /// adjustments. Feather defaults to 0.5 (Lightroom's typical default).
    pub fn linear(start: Point2, end: Point2, adjustments: PartialAdjustments) -> Self {
        Self {
            mask: Mask::Linear {
                start,
                end,
                feather: 0.5,
            },
            range: None,
            adjustments,
        }
    }

    /// Construct a radial-mask layer.
    pub fn radial(center: Point2, radii: Point2, adjustments: PartialAdjustments) -> Self {
        Self {
            mask: Mask::Radial {
                center,
                radii,
                angle: 0.0,
                feather: 0.5,
                invert: false,
            },
            range: None,
            adjustments,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_adjustments_default_is_empty() {
        assert!(PartialAdjustments::default().is_empty());
    }

    #[test]
    fn partial_adjustments_with_exposure_is_not_empty() {
        let p = PartialAdjustments {
            exposure: Some(0.5),
            ..Default::default()
        };
        assert!(!p.is_empty());
    }

    #[test]
    fn partial_adjustments_with_only_hue_is_not_empty() {
        let p = PartialAdjustments {
            hue: Some(5.0),
            ..Default::default()
        };
        assert!(!p.is_empty());
    }

    #[test]
    fn linear_helper_carries_inputs() {
        let p = PartialAdjustments {
            exposure: Some(1.0),
            ..Default::default()
        };
        let la = LocalAdjustment::linear(Point2::new(0.0, 0.0), Point2::new(1.0, 0.0), p);
        match la.mask {
            Mask::Linear {
                start,
                end,
                feather,
            } => {
                assert_eq!(start, Point2::new(0.0, 0.0));
                assert_eq!(end, Point2::new(1.0, 0.0));
                assert!((feather - 0.5).abs() < 1e-6);
            }
            _ => panic!("expected Linear mask"),
        }
        assert_eq!(la.adjustments.exposure, Some(1.0));
    }

    #[test]
    fn radial_helper_carries_inputs() {
        let p = PartialAdjustments {
            exposure: Some(-1.0),
            ..Default::default()
        };
        let la = LocalAdjustment::radial(Point2::new(0.5, 0.5), Point2::new(0.2, 0.1), p);
        match la.mask {
            Mask::Radial {
                center,
                radii,
                angle,
                feather,
                invert,
            } => {
                assert_eq!(center, Point2::new(0.5, 0.5));
                assert_eq!(radii, Point2::new(0.2, 0.1));
                assert_eq!(angle, 0.0);
                assert!((feather - 0.5).abs() < 1e-6);
                assert!(!invert);
            }
            _ => panic!("expected Radial mask"),
        }
        assert_eq!(la.adjustments.exposure, Some(-1.0));
    }
}
