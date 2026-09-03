//! Mask weight evaluation (per-pixel `w ∈ [0, 1]`).
//!
//! Pure functions of `(mask, x_norm, y_norm)`. No allocations. Inputs are
//! normalized image coordinates: `x_norm ∈ [0, 1]` left→right, `y_norm ∈
//! [0, 1]` top→bottom. Aspect ratio is NOT corrected here — the mask
//! semantics are defined in normalized space, which means a "circular"
//! radial mask on a 16:9 image draws as an ellipse on screen unless the UI
//! pre-corrects. The same convention is what Lightroom uses internally; UI
//! layers stretch/transform on top.

use crate::types::{Mask, MaskRaster, Point2};
use std::sync::Arc;

/// Smoothstep S(t) = 3t² − 2t³, clamped to [0, 1].
#[inline]
fn smoothstep(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Resolve the raster a [`Mask::Bitmap`] refers to: by `raster_id` first
/// (the flat-wire path — the FFI registry stamps a resolved id back onto
/// the layer), falling back to the recipe's digest (the in-memory /
/// XMP-parsed path, where no id has been assigned yet). `None` for every
/// other mask variant, and for a `Bitmap` whose raster is not registered —
/// an unresolved recipe evaluates to weight 0 (§ [`evaluate`]), never a
/// silent global correction.
pub fn resolve<'a>(mask: &Mask, rasters: &'a [Arc<MaskRaster>]) -> Option<&'a MaskRaster> {
    let Mask::Bitmap { recipe, raster_id } = mask else {
        return None;
    };
    rasters
        .iter()
        .find(|r| *raster_id != 0 && r.id == *raster_id)
        .or_else(|| {
            rasters
                .iter()
                .find(|r| !recipe.digest.is_empty() && r.digest == recipe.digest)
        })
        .map(|r| r.as_ref())
}

/// Compute the mask weight at normalized point (`x`, `y`). `raster` is the
/// result of [`resolve`] for this mask — irrelevant for every variant
/// except `Bitmap`, where `None` (unresolved) evaluates to 0.
pub fn evaluate(mask: &Mask, raster: Option<&MaskRaster>, x: f32, y: f32) -> f32 {
    let p = Point2::new(x, y);
    match mask {
        Mask::Linear {
            start,
            end,
            feather,
        } => linear_weight(*start, *end, *feather, p),
        Mask::Radial {
            center,
            radii,
            angle,
            feather,
            invert,
        } => {
            let w = radial_weight(*center, *radii, *angle, *feather, p);
            if *invert {
                1.0 - w
            } else {
                w
            }
        }
        Mask::Bitmap { .. } => raster.map(|r| r.sample(x, y)).unwrap_or(0.0),
        Mask::Everywhere => 1.0,
    }
}

/// Linear gradient weight along the line from `start` to `end`.
///
/// Projects `p` onto the gradient line, computes the parametric
/// position `t = (P · D) / |D|²` where `D = end − start`. Below `t == feather/2`
/// the weight is 0; above `t == 1 − feather/2` the weight is 1; in between
/// a smoothstep ramps the weight up.
///
/// **Feather convention:** `feather` is the fractional width of the smooth
/// transition, centered on `t == 0.5`. `feather == 0` gives a hard step;
/// `feather == 1` gives a smooth ramp from t=0 to t=1; values in between
/// scale the transition band. The Lightroom default of 50% maps to
/// `feather == 0.5`.
fn linear_weight(start: Point2, end: Point2, feather: f32, p: Point2) -> f32 {
    let dx = end.x - start.x;
    let dy = end.y - start.y;
    let len_sq = dx * dx + dy * dy;
    if len_sq <= f32::EPSILON {
        // Degenerate: start == end. Treat as no gradient (w=0 everywhere)
        // rather than divide by zero. UI must prevent this in normal use.
        return 0.0;
    }
    let t = ((p.x - start.x) * dx + (p.y - start.y) * dy) / len_sq;
    let feather = feather.clamp(0.0, 1.0);
    if feather <= f32::EPSILON {
        // Hard step at t=0.5.
        if t < 0.5 {
            0.0
        } else {
            1.0
        }
    } else {
        let lo = 0.5 - feather * 0.5;
        let hi = 0.5 + feather * 0.5;
        smoothstep((t - lo) / (hi - lo))
    }
}

/// Radial weight against an axis-aligned ellipse rotated by `angle` radians
/// about `center`. Returns 1 inside the inner radius, 0 outside the
/// outer radius (where the outer radius is the geometric ellipse and the
/// inner radius is `1 - feather` of that — i.e. `feather` is the fractional
/// width of the falloff band measured radially).
fn radial_weight(center: Point2, radii: Point2, angle: f32, feather: f32, p: Point2) -> f32 {
    if radii.x.abs() <= f32::EPSILON || radii.y.abs() <= f32::EPSILON {
        return 0.0;
    }
    // Inverse-rotate the sample point into the ellipse's local frame.
    let cos_a = angle.cos();
    let sin_a = angle.sin();
    let dx = p.x - center.x;
    let dy = p.y - center.y;
    let lx = cos_a * dx + sin_a * dy;
    let ly = -sin_a * dx + cos_a * dy;
    // Normalized radial distance in ellipse-space: d == 1 on the boundary.
    let d_sq = (lx / radii.x).powi(2) + (ly / radii.y).powi(2);
    let d = d_sq.sqrt();
    let feather = feather.clamp(0.0, 1.0);
    if feather <= f32::EPSILON {
        if d <= 1.0 {
            1.0
        } else {
            0.0
        }
    } else {
        // Falloff band: from d = 1 - feather (w=1) to d = 1 (w=0).
        let lo = 1.0 - feather;
        let hi = 1.0;
        // smoothstep gives w=1 at d=lo, w=0 at d=hi. Flip via 1 - smoothstep.
        1.0 - smoothstep((d - lo) / (hi - lo))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn linear_mask() -> Mask {
        Mask::Linear {
            start: Point2::new(0.0, 0.5),
            end: Point2::new(1.0, 0.5),
            feather: 0.0,
        }
    }

    #[test]
    fn linear_hard_step_at_midpoint() {
        let m = linear_mask();
        assert_eq!(evaluate(&m, None, 0.0, 0.5), 0.0);
        assert_eq!(evaluate(&m, None, 0.49, 0.5), 0.0);
        // At exactly t=0.5 the half-open branch returns 1.0.
        assert_eq!(evaluate(&m, None, 0.5, 0.5), 1.0);
        assert_eq!(evaluate(&m, None, 1.0, 0.5), 1.0);
    }

    #[test]
    fn linear_feather_midpoint_is_half() {
        // feather=1 → smoothstep spans the whole line. At t=0.5
        // smoothstep(0.5) = 0.5.
        let m = Mask::Linear {
            start: Point2::new(0.0, 0.5),
            end: Point2::new(1.0, 0.5),
            feather: 1.0,
        };
        let w = evaluate(&m, None, 0.5, 0.5);
        assert!((w - 0.5).abs() < 1e-5, "midpoint weight: {}", w);
    }

    #[test]
    fn linear_off_axis_point_uses_projection() {
        // Off-axis y point projects to the line. With horizontal gradient,
        // y has no effect on the weight.
        let m = linear_mask();
        assert_eq!(evaluate(&m, None, 0.75, 0.0), evaluate(&m, None, 0.75, 1.0));
    }

    #[test]
    fn linear_degenerate_returns_zero() {
        let m = Mask::Linear {
            start: Point2::new(0.5, 0.5),
            end: Point2::new(0.5, 0.5),
            feather: 0.0,
        };
        assert_eq!(evaluate(&m, None, 0.5, 0.5), 0.0);
    }

    fn radial_mask() -> Mask {
        Mask::Radial {
            center: Point2::new(0.5, 0.5),
            radii: Point2::new(0.25, 0.25),
            angle: 0.0,
            feather: 0.0,
            invert: false,
        }
    }

    #[test]
    fn radial_centre_is_one_outside_is_zero() {
        let m = radial_mask();
        assert!((evaluate(&m, None, 0.5, 0.5) - 1.0).abs() < 1e-5);
        // Outside the radius.
        assert_eq!(evaluate(&m, None, 0.9, 0.9), 0.0);
    }

    #[test]
    fn radial_on_boundary_is_one_inside() {
        // Hard step: at d=1 (exactly on the ellipse boundary) the branch
        // returns 1.0 (`d <= 1.0`).
        let m = radial_mask();
        assert!((evaluate(&m, None, 0.75, 0.5) - 1.0).abs() < 1e-5);
    }

    #[test]
    fn radial_feather_smooth_falloff() {
        let m = Mask::Radial {
            center: Point2::new(0.5, 0.5),
            radii: Point2::new(0.5, 0.5),
            angle: 0.0,
            feather: 1.0,
            invert: false,
        };
        // At centre: d=0, w=1.
        assert!((evaluate(&m, None, 0.5, 0.5) - 1.0).abs() < 1e-5);
        // At edge (d=1): w=0.
        assert!(evaluate(&m, None, 1.0, 0.5).abs() < 1e-5);
        // Half-distance d=0.5: smoothstep(0.5) = 0.5, weight = 1 - 0.5 = 0.5.
        let w = evaluate(&m, None, 0.75, 0.5);
        assert!((w - 0.5).abs() < 1e-5, "midpoint weight: {}", w);
    }

    #[test]
    fn radial_invert_flips_sense() {
        let m = Mask::Radial {
            center: Point2::new(0.5, 0.5),
            radii: Point2::new(0.25, 0.25),
            angle: 0.0,
            feather: 0.0,
            invert: true,
        };
        // Centre: inverted, w=0.
        assert!(evaluate(&m, None, 0.5, 0.5).abs() < 1e-5);
        // Outside: inverted, w=1.
        assert!((evaluate(&m, None, 0.9, 0.9) - 1.0).abs() < 1e-5);
    }

    #[test]
    fn radial_angle_rotates_ellipse() {
        // Elongated ellipse along x: at 90° rotation it should be elongated
        // along y instead. Sample a point that's outside the un-rotated
        // ellipse but inside the rotated one.
        let m_unrotated = Mask::Radial {
            center: Point2::new(0.5, 0.5),
            radii: Point2::new(0.4, 0.1),
            angle: 0.0,
            feather: 0.0,
            invert: false,
        };
        let m_rotated = Mask::Radial {
            center: Point2::new(0.5, 0.5),
            radii: Point2::new(0.4, 0.1),
            angle: std::f32::consts::FRAC_PI_2,
            feather: 0.0,
            invert: false,
        };
        // Point (0.5, 0.7): along the y-axis from centre, 0.2 away.
        // Un-rotated ellipse: rx=0.4, ry=0.1 → ry² < 0.2² so outside. w=0.
        // Rotated 90°: now ry=0.4 along the new y-axis, so 0.2 < 0.4. w=1.
        assert_eq!(evaluate(&m_unrotated, None, 0.5, 0.7), 0.0);
        assert!((evaluate(&m_rotated, None, 0.5, 0.7) - 1.0).abs() < 1e-5);
    }

    #[test]
    fn everywhere_is_weight_one_at_any_point() {
        assert_eq!(evaluate(&Mask::Everywhere, None, 0.0, 0.0), 1.0);
        assert_eq!(evaluate(&Mask::Everywhere, None, 0.5, 0.9), 1.0);
    }

    #[test]
    fn bitmap_samples_the_resolved_raster() {
        use crate::types::BitmapRecipe;
        let raster = Arc::new(MaskRaster::from_u8(3, "0123456789abcdef", 2, 1, &[0, 255]));
        let m = Mask::Bitmap {
            recipe: BitmapRecipe::default(),
            raster_id: 3,
        };
        let resolved = resolve(&m, std::slice::from_ref(&raster));
        assert!((evaluate(&m, resolved, 0.0, 0.0)).abs() < 1e-6);
        assert!((evaluate(&m, resolved, 1.0, 0.0) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn bitmap_with_no_registered_raster_is_weight_zero() {
        use crate::types::BitmapRecipe;
        let m = Mask::Bitmap {
            recipe: BitmapRecipe::default(),
            raster_id: 42,
        };
        assert_eq!(resolve(&m, &[]), None);
        assert_eq!(evaluate(&m, None, 0.5, 0.5), 0.0);
    }

    #[test]
    fn resolve_falls_back_to_digest_when_id_is_zero() {
        use crate::types::BitmapRecipe;
        let raster = Arc::new(MaskRaster::from_u8(9, "aabbccddeeff0011", 1, 1, &[200]));
        let m = Mask::Bitmap {
            recipe: BitmapRecipe {
                digest: "aabbccddeeff0011".into(),
                ..Default::default()
            },
            raster_id: 0,
        };
        let resolved = resolve(&m, std::slice::from_ref(&raster));
        assert!(resolved.is_some());
        assert!((resolved.unwrap().sample(0.0, 0.0) - 200.0 / 255.0).abs() < 1e-6);
    }

    #[test]
    fn resolve_returns_none_for_geometric_masks() {
        let rasters = [Arc::new(MaskRaster::from_u8(1, "0123456789abcdef", 1, 1, &[255]))];
        assert!(resolve(&linear_mask(), &rasters).is_none());
        assert!(resolve(&radial_mask(), &rasters).is_none());
        assert!(resolve(&Mask::Everywhere, &rasters).is_none());
    }
}
