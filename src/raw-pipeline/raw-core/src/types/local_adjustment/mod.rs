//! Local-adjustment + mask schema types (ticket #280, foundation slice).
//!
//! A `LocalAdjustment` is a (mask, partial-adjustments) pair. Applied between
//! `dehaze` and `sharpen` (see `pipeline::develop`), each layer modifies the
//! scene-linear Rec.2020 buffer by applying its `PartialAdjustments` weighted
//! by the per-pixel mask value `w ∈ [0, 1]`.
//!
//! Foundation scope (this slice):
//!
//! * Two mask shapes — `Linear` (gradient line) and `Radial` (ellipse).
//!   Brush, AI subject / sky, and range masks defer to follow-up tickets.
//! * `PartialAdjustments` lists the full eventual surface but only `exposure`
//!   is wired in `stages::local_adjustments::apply`. The other fields are
//!   carried through the type + XMP round-trip so the wire format settles
//!   before UI ships; they become functional in subsequent slices.
//! * Wire format is a single `papp:LocalAdjustments` attribute (compact JSON,
//!   implemented in [`wire`]) in the XMP sidecar. The brief's
//!   `crs:GradientBasedCorrections` / nested `rdf:Bag` form is the long-run
//!   goal — converting to it requires extending the attribute-only XMP
//!   walker to track `Bag` / `li` state, which is its own slice. Because no
//!   UI ships in this PR, no user-created sidecars exist yet, so the wire
//!   format can be revised non-breakingly in a follow-up.
//!
//! Coordinates are normalized to `[0, 1]` on each axis, origin top-left,
//! independent of pixel dimensions. This keeps masks resolution-agnostic so
//! the same XMP renders identically against full-res and downsampled
//! buffers.

pub mod flat;
mod wire;

pub use flat::{layers_from_flat, layers_to_flat, LAYER_FLAT_LEN};
pub use wire::{decode_local_adjustments, encode_local_adjustments};

/// A subset of `AdjustmentModel` that may be applied locally (within a mask).
///
/// `None` means "do not apply this control locally"; `Some(v)` means "apply
/// with strength v, scaled by mask weight." Combining strategy is per-field
/// and lives in `stages::local_adjustments::apply`.
///
/// **Currently functional:** `exposure` (additive EV, multiplied through
/// `exp2(w * exposure)`).
///
/// **Carried through the schema + XMP but no-op in apply (TODO #280 slice 2+):**
/// `contrast`, `highlights`, `shadows`, `whites`, `blacks`, `saturation`,
/// `vibrance`, `temperature`, `tint`.
///
/// Note on `contrast`: global contrast routes to the AgX sigmoid slope (see
/// `view::agx`). A local contrast control can't share that path because AgX
/// runs after this stage; the working assumption is a scene-linear contrast
/// curve around 0.18 grey but the algorithm is a Slice-N decision.
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
}

/// One local-adjustment layer.
#[derive(Clone, Debug, PartialEq)]
pub struct LocalAdjustment {
    /// Mask shape — determines the per-pixel weight w ∈ [0, 1].
    pub mask: Mask,
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
