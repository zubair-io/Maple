//! DNG ProfileToneCurve (tag 50940) — DNG 1.4 § 6.4.4.
//!
//! A 1D tone curve stored as a sequence of `(input, output)` `f32` pairs, both
//! in [0, 1]. The curve is piecewise-linear between the lattice points; any
//! value outside the input range clamps to the nearest endpoint's output.
//!
//! Per the DNG SDK reference implementation (`dng_camera_profile.cpp`),
//! the curve is applied in the camera profile's working space — linear
//! ProPhoto D50 — between HSM/PLT (which also live in ProPhoto-D50) and the
//! gamut conversion to Rec.2020 D65. A neutral-preserving curve operates on
//! the *luminance* (max channel) of the pixel and rescales R/G/B by the
//! ratio `curve(luma) / luma` to preserve hue and saturation. This matches
//! the DNG spec's "tone curve preserves color" intent.

use rayon::prelude::*;

use crate::image::Image;

/// One ProfileToneCurve, fully expanded into `(input, output)` pairs sorted
/// by `input` ascending.
#[derive(Clone, Debug)]
pub struct ProfileToneCurve {
    /// `(input, output)` lattice points, sorted by input ascending. Length
    /// always >= 2 (otherwise [`ProfileToneCurve::from_floats`] returns
    /// `None`). Both axes are in [0, 1] per spec.
    pub points: Vec<(f32, f32)>,
}

impl ProfileToneCurve {
    /// Build from a flat float array as returned by the IFD reader. The DNG
    /// spec requires an even count and >= 4 floats (>= 2 pairs); odd count
    /// or zero pairs returns `None`. Pairs are NOT sorted by the spec but
    /// are normally written in ascending input order; we sort to be safe.
    pub fn from_floats(floats: Vec<f32>) -> Option<Self> {
        if floats.len() < 4 || floats.len() % 2 != 0 {
            return None;
        }
        let mut points: Vec<(f32, f32)> = floats.chunks(2).map(|c| (c[0], c[1])).collect();
        // Stable sort by input. Real DNGs are already sorted, so this is a
        // no-op in practice — included as a defense against malformed files.
        points.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        Some(Self { points })
    }

    /// Evaluate the curve at `x`. Out-of-range inputs clamp to the curve's
    /// endpoints' outputs (per DNG SDK behaviour). Linear interpolation
    /// between adjacent points.
    pub fn eval(&self, x: f32) -> f32 {
        // Empty / degenerate guard — `from_floats` already filters these,
        // but be defensive on direct construction.
        if self.points.is_empty() {
            return x;
        }
        let first = self.points[0];
        let last = self.points[self.points.len() - 1];
        if x <= first.0 {
            return first.1;
        }
        if x >= last.0 {
            return last.1;
        }
        // Binary search the bracketing pair. Linear scan is fine for ~257
        // points (Apple's typical PTC size); binary search future-proofs
        // against larger curves at no cost.
        let n = self.points.len();
        let mut lo = 0usize;
        let mut hi = n - 1;
        while hi - lo > 1 {
            let mid = (lo + hi) / 2;
            if self.points[mid].0 <= x {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let (xa, ya) = self.points[lo];
        let (xb, yb) = self.points[hi];
        if (xb - xa).abs() < f32::EPSILON {
            return ya;
        }
        let t = (x - xa) / (xb - xa);
        ya + t * (yb - ya)
    }
}

/// Apply the curve to an `Image` in-place. Hue/saturation-preserving
/// luminance retargeting: compute the max channel, look up the curve at
/// that point, and scale R/G/B by `output / input`. Pixels with max <= 0
/// are passed through unchanged (curve(0) = 0 by definition for a typical
/// PTC starting at the origin; preserves the negative-component intent
/// the HSM stage handles separately).
///
/// Per DNG 1.4 § 6.4.4 / DNG SDK `dng_camera_profile.cpp`: the curve is a
/// "monotonic, saturation-preserving" tone mapping. Operating on the max
/// channel and scaling proportionally is the SDK's reference algorithm.
pub fn apply(img: &mut Image, curve: &ProfileToneCurve) {
    img.pixels.par_iter_mut().for_each(|p| {
        let max = p[0].max(p[1]).max(p[2]);
        if max <= 0.0 || !max.is_finite() {
            return;
        }
        let mapped = curve.eval(max);
        if mapped == max {
            return;
        }
        let scale = mapped / max;
        p[0] *= scale;
        p[1] *= scale;
        p[2] *= scale;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::ColorSpace;

    #[test]
    fn from_floats_rejects_odd_count() {
        assert!(ProfileToneCurve::from_floats(vec![0.0, 0.0, 0.5]).is_none());
    }

    #[test]
    fn from_floats_rejects_too_few_points() {
        assert!(ProfileToneCurve::from_floats(vec![0.0, 0.0]).is_none());
    }

    #[test]
    fn from_floats_accepts_two_pairs() {
        let c = ProfileToneCurve::from_floats(vec![0.0, 0.0, 1.0, 1.0]).unwrap();
        assert_eq!(c.points.len(), 2);
    }

    #[test]
    fn identity_curve_is_no_op() {
        // (0,0) and (1,1) — perfectly linear identity.
        let c = ProfileToneCurve::from_floats(vec![0.0, 0.0, 1.0, 1.0]).unwrap();
        for x in [0.0_f32, 0.18, 0.5, 0.9, 1.0] {
            assert!(
                (c.eval(x) - x).abs() < 1e-6,
                "id curve at {} = {}",
                x,
                c.eval(x)
            );
        }
    }

    #[test]
    fn eval_clamps_below_first_input() {
        let c = ProfileToneCurve::from_floats(vec![0.1, 0.2, 1.0, 1.0]).unwrap();
        assert!((c.eval(-1.0) - 0.2).abs() < 1e-6);
        assert!((c.eval(0.05) - 0.2).abs() < 1e-6);
    }

    #[test]
    fn eval_clamps_above_last_input() {
        let c = ProfileToneCurve::from_floats(vec![0.0, 0.0, 0.9, 0.95]).unwrap();
        assert!((c.eval(2.0) - 0.95).abs() < 1e-6);
    }

    #[test]
    fn eval_interpolates_between_lattice_points() {
        // (0,0) → (0.5, 0.25) → (1, 1). At 0.25 (midway 0..0.5), output = 0.125
        let c = ProfileToneCurve::from_floats(vec![0.0, 0.0, 0.5, 0.25, 1.0, 1.0]).unwrap();
        assert!((c.eval(0.25) - 0.125).abs() < 1e-6);
    }

    #[test]
    fn apply_identity_preserves_in_range_pixels() {
        // Identity curve on [0,1]. HDR pixels above max input clamp to
        // curve(1.0) = 1.0 — not a no-op for those — so only in-range
        // pixels round-trip exactly. This matches DNG SDK behaviour: the
        // tone curve is a [0,1] -> [0,1] map.
        let c = ProfileToneCurve::from_floats(vec![0.0, 0.0, 1.0, 1.0]).unwrap();
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [0.18, 0.18, 0.18];
        img.pixels[1] = [0.7, 0.4, 0.2];
        img.pixels[2] = [0.95, 0.6, 0.3];
        img.pixels[3] = [0.0, 0.0, 0.0];
        let before = img.pixels.clone();
        apply(&mut img, &c);
        for (a, b) in before.iter().zip(img.pixels.iter()) {
            for c in 0..3 {
                assert!(
                    (a[c] - b[c]).abs() < 1e-5,
                    "identity PTC mutated pixel: before={:?} after={:?}",
                    a,
                    b
                );
            }
        }
    }

    #[test]
    fn apply_identity_clamps_hdr_pixels_to_curve_endpoint() {
        // Pixel max > 1 → curve clamps to last output (1.0 for identity), so
        // scale = 1.0 / max < 1.0. Documents the expected HDR-pixel behaviour.
        let c = ProfileToneCurve::from_floats(vec![0.0, 0.0, 1.0, 1.0]).unwrap();
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [1.5, 1.0, 0.05];
        apply(&mut img, &c);
        // max was 1.5, eval(1.5) clamps to 1.0, scale = 1/1.5 = 2/3.
        let expected_scale = 1.0_f32 / 1.5;
        let exp = [
            1.5 * expected_scale,
            1.0 * expected_scale,
            0.05 * expected_scale,
        ];
        for c_i in 0..3 {
            assert!(
                (img.pixels[0][c_i] - exp[c_i]).abs() < 1e-5,
                "ch{} = {} (want {})",
                c_i,
                img.pixels[0][c_i],
                exp[c_i]
            );
        }
    }

    #[test]
    fn apply_doubling_curve_scales_pixels_uniformly() {
        // Curve that doubles every input up to 0.5 (then clamps).
        // f(0)=0, f(0.5)=1.0, f(1)=1.0
        let c = ProfileToneCurve::from_floats(vec![0.0, 0.0, 0.5, 1.0, 1.0, 1.0]).unwrap();
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [0.4, 0.2, 0.1];
        apply(&mut img, &c);
        // max was 0.4, eval(0.4) = lerp((0,0),(0.5,1),0.4/0.5) = 0.8
        // scale = 0.8 / 0.4 = 2.0
        assert!((img.pixels[0][0] - 0.8).abs() < 1e-4);
        assert!((img.pixels[0][1] - 0.4).abs() < 1e-4);
        assert!((img.pixels[0][2] - 0.2).abs() < 1e-4);
    }

    #[test]
    fn apply_preserves_hue_via_max_channel_scaling() {
        // Doubling curve. A red-tinted pixel (1.0, 0.5, 0.5) has max=1.0.
        // f(1.0) = 1.0 (identity at top), so scale = 1.0 → no change.
        let c = ProfileToneCurve::from_floats(vec![0.0, 0.0, 1.0, 1.0]).unwrap();
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [1.0, 0.5, 0.5];
        apply(&mut img, &c);
        assert!((img.pixels[0][0] - 1.0).abs() < 1e-5);
        assert!((img.pixels[0][1] - 0.5).abs() < 1e-5);
        assert!((img.pixels[0][2] - 0.5).abs() < 1e-5);
    }

    #[test]
    fn apply_skips_zero_max_pixels() {
        let c = ProfileToneCurve::from_floats(vec![0.0, 0.5, 1.0, 0.5]).unwrap();
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [0.0, 0.0, 0.0];
        apply(&mut img, &c);
        // Black stays black even with a curve that doesn't pass through origin.
        assert_eq!(img.pixels[0], [0.0, 0.0, 0.0]);
    }

    #[test]
    fn apply_skips_negative_pixels_via_max_channel_check() {
        // Curve that boosts contrast.
        let c = ProfileToneCurve::from_floats(vec![0.0, 0.0, 0.5, 0.7, 1.0, 1.0]).unwrap();
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = [-0.1, -0.05, -0.02];
        let before = img.pixels[0];
        apply(&mut img, &c);
        // max = -0.02 <= 0 → bypass.
        assert_eq!(img.pixels[0], before);
    }
}
