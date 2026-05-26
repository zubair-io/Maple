//! Capture sharpening — Richardson–Lucy deconvolution against a true
//! Gaussian PSF, applied to a luminance plane so chroma noise doesn't get
//! amplified.
//!
//! The PSF is an exact separable Gaussian of `sigma` pixels, windowed to
//! `±ceil(3·sigma)` taps and renormalized so the kernel sums to 1.0. Two
//! 1D convolutions (horizontal then vertical) replace the previous
//! tripled-box-blur approximation — at the small sigmas this stage uses
//! (0.5..2.0 px) the box-blur fit was visibly different from a real
//! Gaussian, and the integer-radius round-off prevented sub-pixel tuning.
//!
//! Off by default: the helper at `pipeline::capture_sharpening_helper`
//! returns `None` when `amount == 0`, so this stage is never called and
//! the pre-#427 baseline is bit-identical. At `strength == 0.0` the
//! algorithm itself is also a bit-exact no-op — verified in the tests
//! below.
//!
//! Asserts `ColorSpace::SceneLinearRec2020` since every other stage here
//! lives in that space. Rec.709 luminance weights are still a reasonable
//! approximation for Rec.2020 at the small magnitudes capture sharpening
//! operates on; a Rec.2020-exact vector can be swapped in later if the
//! parity harness flags it.

use crate::image::{ColorSpace, Image};

#[derive(Clone, Copy, Debug)]
pub struct CaptureSharpeningParams {
    /// Gaussian PSF sigma in pixels. The kernel is windowed to
    /// `±ceil(3·sigma)` taps and renormalized; `sigma <= 0` short-circuits
    /// the stage.
    pub sigma: f32,
    /// Number of Richardson–Lucy iterations. Reference default: 2.
    pub iterations: u32,
    /// Above this luminance, fade sharpening to avoid amplifying near-clipped
    /// highlights into ringing.
    pub highlight_threshold: f32,
    /// Strength multiplier. 1.0 = full effect; 0.0 = off (bit-identical no-op).
    pub strength: f32,
}

impl Default for CaptureSharpeningParams {
    fn default() -> Self {
        Self {
            sigma: 0.68,
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

/// Build a windowed, renormalized 1D Gaussian kernel of length `2*half+1`,
/// where `half = ceil(3 * sigma).max(1) as usize`. The kernel is symmetric
/// around index `half`; weights are `exp(-(k^2)/(2σ²))` and the whole array
/// is divided by its sum so the convolution preserves DC.
fn gaussian_kernel_1d(sigma: f32) -> Vec<f32> {
    debug_assert!(sigma > 0.0 && sigma.is_finite());
    let half = (3.0 * sigma).ceil().max(1.0) as usize;
    let two_sigma_sq = 2.0 * sigma * sigma;
    let mut k: Vec<f32> = (0..=2 * half)
        .map(|i| {
            let x = i as f32 - half as f32;
            (-(x * x) / two_sigma_sq).exp()
        })
        .collect();
    let sum: f32 = k.iter().sum();
    let inv = 1.0 / sum;
    for v in &mut k {
        *v *= inv;
    }
    k
}

/// Separable 1D Gaussian blur of a single-channel plane. Edge handling
/// clamps the sample index to `[0, w-1]` / `[0, h-1]` — matches the
/// previous box-blur behavior at borders.
fn gaussian_blur_plane(buf: &[f32], w: usize, h: usize, sigma: f32) -> Vec<f32> {
    let kernel = gaussian_kernel_1d(sigma);
    let half = kernel.len() / 2;

    // Horizontal pass: tmp[y*w + x] = sum_k kernel[k] * buf[y*w + clamp(x + k - half)]
    let mut tmp = vec![0.0_f32; buf.len()];
    let w_i = w as isize;
    for y in 0..h {
        let row_in = &buf[y * w..(y + 1) * w];
        let row_out = &mut tmp[y * w..(y + 1) * w];
        for x in 0..w {
            let mut acc = 0.0_f32;
            for (k_idx, &k) in kernel.iter().enumerate() {
                let xi = (x as isize + k_idx as isize - half as isize)
                    .clamp(0, w_i - 1) as usize;
                acc += k * row_in[xi];
            }
            row_out[x] = acc;
        }
    }

    // Vertical pass: out[y*w + x] = sum_k kernel[k] * tmp[clamp(y + k - half)*w + x]
    let mut out = vec![0.0_f32; buf.len()];
    let h_i = h as isize;
    for y in 0..h {
        let row_out = &mut out[y * w..(y + 1) * w];
        for x in 0..w {
            let mut acc = 0.0_f32;
            for (k_idx, &k) in kernel.iter().enumerate() {
                let yi = (y as isize + k_idx as isize - half as isize)
                    .clamp(0, h_i - 1) as usize;
                acc += k * tmp[yi * w + x];
            }
            row_out[x] = acc;
        }
    }
    out
}

/// Apply capture sharpening in place.
///
/// No-op when `sigma <= 0`, `iterations == 0`, or `strength <= 0`.
/// `strength == 0.0` is a bit-exact no-op — see `disabled_at_zero_strength`.
pub fn apply_capture_sharpening(image: &mut Image, params: &CaptureSharpeningParams) {
    if !params.sigma.is_finite()
        || params.sigma <= 0.0
        || params.iterations == 0
        || params.strength <= 0.0
    {
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
        let blur_est = gaussian_blur_plane(&estimate, w, h, params.sigma);
        let mut ratio = vec![0.0_f32; n];
        for (i, r) in ratio.iter_mut().enumerate() {
            let denom = blur_est[i].max(1e-6);
            *r = (original[i] / denom).clamp(0.0, 100.0);
        }
        let blur_ratio = gaussian_blur_plane(&ratio, w, h, params.sigma);
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
    fn gaussian_kernel_sums_to_one() {
        for &sigma in &[0.25_f32, 0.5, 0.68, 1.0, 1.5, 2.0, 4.0] {
            let k = gaussian_kernel_1d(sigma);
            let sum: f32 = k.iter().sum();
            assert!(
                (sum - 1.0).abs() < 1e-6,
                "kernel for sigma={sigma} sums to {sum}, expected 1.0"
            );
            // Window size matches ceil(3*sigma).max(1) → length 2*half+1.
            let expected_half = (3.0 * sigma).ceil().max(1.0) as usize;
            assert_eq!(k.len(), 2 * expected_half + 1, "kernel size for sigma={sigma}");
            // Symmetry: k[i] == k[len-1-i].
            for i in 0..k.len() / 2 {
                assert!(
                    (k[i] - k[k.len() - 1 - i]).abs() < 1e-6,
                    "kernel asymmetric at sigma={sigma}, i={i}"
                );
            }
        }
    }

    #[test]
    fn gaussian_kernel_subpixel_sigma_does_not_explode() {
        // ceil(3*0.1) = 1, so kernel has 3 taps. Center is enormously
        // dominant; renormalization should still produce a finite sum-1
        // kernel with all-finite weights.
        let k = gaussian_kernel_1d(0.1);
        assert_eq!(k.len(), 3);
        let sum: f32 = k.iter().sum();
        assert!((sum - 1.0).abs() < 1e-6);
        for &v in &k {
            assert!(v.is_finite() && v >= 0.0);
        }
        // Center weight dominates at sub-pixel sigma (>0.99).
        assert!(k[1] > 0.99, "center weight {} at sigma=0.1 too small", k[1]);
    }

    /// Bit-exact no-op when `strength == 0.0`. This is the ticket's
    /// "off by default must remain bit-identical" assertion at the stage
    /// level: a non-trivial synthetic input must come back unchanged.
    /// Run on a multi-channel image with a sharp step so the assert
    /// catches any accidental side effect of the blur/RL passes (even
    /// though we short-circuit before any work runs).
    #[test]
    fn disabled_at_zero_strength() {
        let mut img = build_image(32, 16, |x, y| {
            let v = if x < 16 { 0.2 } else { 0.8 };
            [v, v * 0.9 + (y as f32) * 1e-3, v * 1.1 - (x as f32) * 1e-4]
        });
        let before = img.pixels.clone();
        apply_capture_sharpening(
            &mut img,
            &CaptureSharpeningParams {
                strength: 0.0,
                ..Default::default()
            },
        );
        assert_eq!(img.pixels, before, "strength=0 must be a bit-exact no-op");
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
    fn disabled_at_zero_sigma() {
        let mut img = build_image(16, 16, |x, _| {
            let v = x as f32 / 15.0;
            [v, v, v]
        });
        let before = img.pixels.clone();
        apply_capture_sharpening(
            &mut img,
            &CaptureSharpeningParams {
                sigma: 0.0,
                ..Default::default()
            },
        );
        assert_eq!(img.pixels, before);
    }

    #[test]
    fn disabled_at_nonfinite_sigma() {
        // Defensive: non-finite sigma must not panic or produce non-finite
        // pixels. Mirrors the helper's `is_finite` guard.
        for sigma in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, -1.0] {
            let mut img = build_image(8, 8, |_, _| [0.5, 0.5, 0.5]);
            let before = img.pixels.clone();
            apply_capture_sharpening(
                &mut img,
                &CaptureSharpeningParams {
                    sigma,
                    ..Default::default()
                },
            );
            assert_eq!(img.pixels, before, "non-finite/negative sigma {sigma} must be a no-op");
        }
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

    #[test]
    fn larger_sigma_blurs_more_than_smaller_sigma() {
        // Single bright pixel: a larger sigma must diffuse more energy
        // into the immediate neighbor than a smaller sigma does. This is
        // the property that the integer-radius approximation could not
        // express within `radius==1` — both sigma=0.5 and sigma=0.9
        // rounded to the same integer radius.
        let mut buf = vec![0.0_f32; 21 * 21];
        buf[10 * 21 + 10] = 1.0;

        let small = gaussian_blur_plane(&buf, 21, 21, 0.5);
        let large = gaussian_blur_plane(&buf, 21, 21, 0.9);

        // Center retains less energy under the larger blur.
        assert!(
            large[10 * 21 + 10] < small[10 * 21 + 10],
            "larger sigma left more at center: small={}, large={}",
            small[10 * 21 + 10],
            large[10 * 21 + 10]
        );
        // Direct neighbor gains more energy under the larger blur.
        assert!(
            large[10 * 21 + 11] > small[10 * 21 + 11],
            "larger sigma diffused less to neighbor: small={}, large={}",
            small[10 * 21 + 11],
            large[10 * 21 + 11]
        );
    }
}
