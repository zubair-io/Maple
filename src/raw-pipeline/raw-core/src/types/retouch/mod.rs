//! Clone / heal spot list (#3409) — the persistable half of the repair
//! brush.
//!
//! A [`RetouchSpot`] is a circular destination disc plus the circular source
//! disc its pixels come from. Two kinds: `Clone` copies the source patch
//! verbatim, `Heal` copies only the source's high-frequency detail onto the
//! destination's own low-frequency colour. The apply stage lives in
//! `crate::stages::retouch`; this module is schema only (no I/O, matching
//! the `types` module contract).
//!
//! **Coordinate convention.** `center` and `source` are normalised
//! image-relative coordinates in `[0, 1]`, x left→right and y top→bottom,
//! exactly the convention `types::local_adjustment::Mask` uses — the same
//! numbers a mask pin carries, so both tools share one UI transform.
//!
//! **Radius convention.** Unlike a mask, a repair spot has to be a circle in
//! PIXEL space: a clone patch copied through an elliptical stencil on a 3:2
//! frame would take a visibly different shape than the brush the user drew.
//! `radius` is therefore a fraction of the image's WIDTH, and the apply stage
//! turns it into one pixel radius used on both axes. `feather` is a fraction
//! of that radius (`0` = hard edge, `1` = the whole disc is transition), and
//! `opacity` scales the composite.
//!
//! **Identity.** An empty spot list is a bit-identical skip in every render
//! path, which is what keeps the colour-parity budgets untouched for every
//! fixture that has no spots.

use crate::types::local_adjustment::Point2;

/// How a spot's source pixels are combined with its destination.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum RetouchKind {
    /// Source detail on destination colour — a Gaussian low/high split.
    /// Lightroom's "Heal", and the default a new spot is created with.
    #[default]
    Heal,
    /// Straight copy of the source patch.
    Clone,
}

impl RetouchKind {
    /// The Adobe `crs:SpotType` wire spelling.
    pub fn wire(self) -> &'static str {
        match self {
            RetouchKind::Heal => "heal",
            RetouchKind::Clone => "clone",
        }
    }

    /// Parse a `crs:SpotType` value. `None` for anything this build does not
    /// model, which the tolerant XMP reader turns into "skip this spot"
    /// rather than a failed parse.
    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "heal" => Some(RetouchKind::Heal),
            "clone" => Some(RetouchKind::Clone),
            _ => None,
        }
    }
}

/// One repair spot. Ordered: the list applies front to back, so a later
/// spot can source from an earlier spot's result (Lightroom's own stacking).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RetouchSpot {
    pub kind: RetouchKind,
    /// Destination disc centre, normalised `[0, 1]`.
    pub center: Point2,
    /// Source disc centre, normalised `[0, 1]`.
    pub source: Point2,
    /// Disc radius as a fraction of image WIDTH (see the module doc).
    pub radius: f32,
    /// Soft-edge width as a fraction of `radius`, `[0, 1]`.
    pub feather: f32,
    /// Composite strength, `[0, 1]`.
    pub opacity: f32,
}

/// The size a freshly-placed spot gets when the UI has no better idea —
/// 2 % of the frame width, matching Lightroom's default spot on import.
pub const DEFAULT_RADIUS: f32 = 0.02;
/// Default soft edge: half the radius.
pub const DEFAULT_FEATHER: f32 = 0.5;

impl RetouchSpot {
    /// A spot with the default feather and opacity.
    pub fn new(kind: RetouchKind, center: Point2, source: Point2, radius: f32) -> Self {
        Self {
            kind,
            center,
            source,
            radius,
            feather: DEFAULT_FEATHER,
            opacity: 1.0,
        }
    }

    /// True when this spot can change a pixel. A zero/negative radius, a
    /// zero opacity, a non-finite coordinate, or a source that coincides
    /// with the destination all render as nothing, so the stage skips them
    /// instead of doing the patch work.
    pub fn is_effective(&self) -> bool {
        let finite = self.center.x.is_finite()
            && self.center.y.is_finite()
            && self.source.x.is_finite()
            && self.source.y.is_finite()
            && self.radius.is_finite()
            && self.feather.is_finite()
            && self.opacity.is_finite();
        let moved = (self.source.x - self.center.x).abs() > f32::EPSILON
            || (self.source.y - self.center.y).abs() > f32::EPSILON;
        finite && self.radius > 0.0 && self.opacity > 0.0 && moved
    }

    /// `feather` and `opacity` clamped into their documented ranges. A
    /// hand-edited sidecar can carry anything; the stage evaluates the
    /// clamped values rather than producing a negative coverage.
    pub fn clamped_feather(&self) -> f32 {
        self.feather.clamp(0.0, 1.0)
    }

    /// See [`Self::clamped_feather`].
    pub fn clamped_opacity(&self) -> f32 {
        self.opacity.clamp(0.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_wire_round_trips() {
        for k in [RetouchKind::Heal, RetouchKind::Clone] {
            assert_eq!(RetouchKind::from_wire(k.wire()), Some(k));
        }
        assert_eq!(RetouchKind::from_wire("perspectiveHeal"), None);
    }

    #[test]
    fn default_kind_is_heal() {
        assert_eq!(RetouchKind::default(), RetouchKind::Heal);
    }

    #[test]
    fn ineffective_spots_are_rejected() {
        let base = RetouchSpot::new(
            RetouchKind::Heal,
            Point2::new(0.5, 0.5),
            Point2::new(0.6, 0.5),
            DEFAULT_RADIUS,
        );
        assert!(base.is_effective());

        let zero_radius = RetouchSpot {
            radius: 0.0,
            ..base
        };
        assert!(!zero_radius.is_effective());

        let zero_opacity = RetouchSpot {
            opacity: 0.0,
            ..base
        };
        assert!(!zero_opacity.is_effective());

        // Source on top of the destination copies a patch onto itself.
        let not_moved = RetouchSpot {
            source: base.center,
            ..base
        };
        assert!(!not_moved.is_effective());

        let nan = RetouchSpot {
            source: Point2::new(f32::NAN, 0.5),
            ..base
        };
        assert!(!nan.is_effective());
    }

    #[test]
    fn out_of_range_feather_and_opacity_clamp() {
        let s = RetouchSpot {
            feather: 4.0,
            opacity: -1.0,
            ..RetouchSpot::new(
                RetouchKind::Clone,
                Point2::new(0.5, 0.5),
                Point2::new(0.6, 0.5),
                DEFAULT_RADIUS,
            )
        };
        assert_eq!(s.clamped_feather(), 1.0);
        assert_eq!(s.clamped_opacity(), 0.0);
    }
}
