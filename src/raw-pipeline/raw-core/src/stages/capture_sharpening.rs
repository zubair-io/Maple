//! Capture sharpening — Richardson–Lucy deconvolution against a narrow
//! Gaussian PSF, applied to a luminance plane so chroma noise doesn't get
//! amplified.
//!
//! Adapted from the reference Maple implementation (`capture_sharpening.rs`).
//! Structural changes for `_Maple`'s idioms:
//!   - operates on `Image` (Vec<[f32;3]>) rather than the reference's flat
//!     `DemosaicedImage { pixels: Vec<f32> }`.
//!   - uses integer `radius` + tripled-box-blur approximation (matches other
//!     stages in `_Maple`) instead of a real `sigma` Gaussian. The reference
//!     default sigma=0.68 corresponds to radius≈2 at the approximation's
//!     3-pass geometry.
//!   - asserts `ColorSpace::SceneLinearRec2020` since every other stage here
//!     lives in that space. Rec.709 luminance weights are still a reasonable
//!     approximation for Rec.2020 at the small magnitudes capture sharpening
//!     operates on; a Rec.2020-exact vector can be swapped in later if the
//!     parity harness flags it.
//!
//! NOT YET wired into the render pipeline — follow-up commit will add it
//! between demosaic and tone adjustments once sigma/strength are plumbed
//! through the adjustment model and XMP schema.

use crate::image::{ColorSpace, Image};
use crate::stages::blur::gaussian_blur_plane;

#[derive(Clone, Copy, Debug)]
pub struct CaptureSharpeningParams {
    /// Blur radius in pixels for the deconvolution PSF. The reference default
    /// sigma=0.68 maps to `radius ≈ 2` under the tripled-box approximation.
    pub radius: usize,
    /// Number of Richardson–Lucy iterations. Reference default: 2.
    pub iterations: u32,
    /// Above this luminance, fade sharpening to avoid amplifying near-clipped
    /// highlights into ringing.
    pub highlight_threshold: f32,
    /// Strength multiplier. 1.0 = full effect; 0.0 = off.
    pub strength: f32,
}

impl Default for CaptureSharpeningParams {
    fn default() -> Self {
        Self {
            radius: 2,
            iterations: 2,
            highlight_threshold: 0.99,
            strength: 1.0,
        }
    }
}

/// Rec 709 luminance weights. Close enough to Rec.2020 for the tiny
/// corrections capture sharpening applies; replace with Rec.2020 exact
/// coefficients (0.2627, 0.6780, 0.0593) if parity calls for it.
const LUM_WEIGHTS: [f32; 3] = [0.2126, 0.7152, 0.0722];

/// Apply capture sharpening in place.
///
/// No-op when `radius == 0`, `iterations == 0`, or `strength <= 0`.
pub fn apply_capture_sharpening(image: &mut Image, params: &CaptureSharpeningParams) {
    if params.radius == 0 || params.iterations == 0 || params.strength <= 0.0 {
        return;
    }
    image.assert_space(ColorSpace::SceneLinearRec2020);

    let w = image.width as usize;
    let h = image.height as usize;
    let n = w * h;

    // Extract luminance.
    let mut original = vec![0.0_f32; n];
    for i in 0..n {
        let p = image.pixels[i];
        original[i] = LUM_WEIGHTS[0] * p[0] + LUM_WEIGHTS[1] * p[1] + LUM_WEIGHTS[2] * p[2];
    }

    // Richardson–Lucy: estimate = estimate * blur(original / blur(estimate)).
    // Two iterations by default — matches the reference engine's behaviour.
    let mut estimate = original.clone();
    for _ in 0..params.iterations {
        let blur_est = gaussian_blur_plane(&estimate, w, h, params.radius);
        let mut ratio = vec![0.0_f32; n];
        for (i, r) in ratio.iter_mut().enumerate() {
            let denom = blur_est[i].max(1e-6);
            *r = (original[i] / denom).clamp(0.0, 100.0);
        }
        let blur_ratio = gaussian_blur_plane(&ratio, w, h, params.radius);
        for (e, &b) in estimate.iter_mut().zip(blur_ratio.iter()) {
            *e *= b;
        }
    }

    // Scale each channel by (new_Y / old_Y), blending toward no-op near
    // clipped highlights. Small-`y_old` pixels are left alone to avoid
    // divide-by-zero noise amplification in shadows.
    let strength = params.strength;
    let hi_thresh = params.highlight_threshold;
    image.pixels.iter_mut().enumerate().for_each(|(i, px)| {
        let y_old = original[i];
        if y_old < 1e-6 {
            return;
        }
        let blend = if y_old < hi_thresh {
            strength
        } else {
            let t = ((1.0 - y_old) / (1.0 - hi_thresh)).clamp(0.0, 1.0);
            strength * t
        };
        if blend <= 0.0 {
            return;
        }
        let y_new = estimate[i];
        let y_target = y_old * (1.0 - blend) + y_new * blend;
        let scale = y_target / y_old;
        px[0] *= scale;
        px[1] *= scale;
        px[2] *= scale;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_image(w: u32, h: u32, f: impl Fn(u32, u32) -> [f32; 3]) -> Image {
        let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        for y in 0..h {
            for x in 0..w {
                img.pixels[(y * w + x) as usize] = f(x, y);
            }
        }
        img
    }

    #[test]
    fn disabled_at_zero_iterations() {
        let mut img = build_image(16, 16, |x, _| {
            let v = x as f32 / 15.0;
            [v, v, v]
        });
        let before = img.pixels.clone();
        apply_capture_sharpening(
            &mut img,
            &CaptureSharpeningParams {
                iterations: 0,
                ..Default::default()
            },
        );
        assert_eq!(img.pixels, before);
    }

    #[test]
    fn disabled_at_zero_radius() {
        let mut img = build_image(16, 16, |x, _| {
            let v = x as f32 / 15.0;
            [v, v, v]
        });
        let before = img.pixels.clone();
        apply_capture_sharpening(
            &mut img,
            &CaptureSharpeningParams {
                radius: 0,
                ..Default::default()
            },
        );
        assert_eq!(img.pixels, before);
    }

    #[test]
    fn sharpens_blurry_step_edge() {
        // Make a blurry step edge then sharpen: edge gradient should grow.
        let (w, h) = (64u32, 16u32);
        let mut img = build_image(w, h, |x, _| {
            let v = if x < 28 {
                0.3
            } else if x < 36 {
                let t = (x - 28) as f32 / 8.0;
                0.3 + 0.4 * t
            } else {
                0.7
            };
            [v, v, v]
        });
        let before = img.pixels.clone();
        apply_capture_sharpening(&mut img, &CaptureSharpeningParams::default());

        let edge_grad = |pixels: &[[f32; 3]]| -> f32 {
            let mut m: f32 = 0.0;
            for y in 0..h {
                for x in 1..w {
                    let l = pixels[(y * w + x - 1) as usize][0];
                    let r = pixels[(y * w + x) as usize][0];
                    m = m.max((r - l).abs());
                }
            }
            m
        };
        let g_before = edge_grad(&before);
        let g_after = edge_grad(&img.pixels);
        assert!(
            g_after > g_before,
            "capture sharpening did not enhance edge: before={g_before} after={g_after}"
        );
    }

    #[test]
    fn preserves_flat_regions_within_tolerance() {
        let mut img = build_image(32, 32, |_, _| [0.5, 0.5, 0.5]);
        let before = img.pixels.clone();
        apply_capture_sharpening(&mut img, &CaptureSharpeningParams::default());
        for (a, b) in img.pixels.iter().zip(before.iter()) {
            for c in 0..3 {
                assert!(
                    (a[c] - b[c]).abs() < 1e-3,
                    "flat region drifted: {:?} vs {:?}",
                    a,
                    b
                );
            }
        }
    }

    #[test]
    fn near_clipped_highlights_stay_safe() {
        let mut img = build_image(16, 16, |x, _| {
            let v = if x < 8 { 0.999 } else { 0.5 };
            [v, v, v]
        });
        apply_capture_sharpening(&mut img, &CaptureSharpeningParams::default());
        for p in &img.pixels {
            for &v in p.iter() {
                assert!(v.is_finite(), "non-finite output");
                assert!(v < 1.5, "highlight exploded: {v}");
            }
        }
    }
}
