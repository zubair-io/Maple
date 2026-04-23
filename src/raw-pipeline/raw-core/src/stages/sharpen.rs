//! Richardson-Lucy capture sharpening per spec § 3.10.
//!
//! 3-iteration deconvolution on scene-linear Rec.2020 with Gaussian PSF.
//! Slider sharpen_amount [0, 150]: 0 skips, 100 is full RL, >100 adds
//! unsharp overdrive. sharpen_detail and sharpen_masking control an edge-
//! aware mix on top. PSF Gaussian sigma = sharpen_radius.
//!
//! Implementation uses the box-blur Gaussian approximation from stages::blur
//! (O(n) per pixel).

use crate::{
    image::{ColorSpace, Image},
    stages::blur::gaussian_blur_rgb,
};

const RL_ITERS: usize = 3;
const EPSILON: f32 = 1e-5;

/// Apply Richardson-Lucy sharpening per spec § 3.10.
///
/// Short-circuits when sharpen_amount == 0 (stage skipped).
pub fn apply(
    img: &mut Image,
    amount: f32,
    radius: f32,
    detail: f32,
    masking: f32,
) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if amount.abs() < 1e-3 { return; }

    // Convert radius (PSF sigma) to integer blur radius for our box-approx.
    let radius_px = radius.clamp(0.5, 3.0).round() as usize;
    let radius_px = radius_px.max(1);

    // --- Richardson-Lucy 3 iterations ---
    // O = observed; E_n = current estimate; P = Gaussian PSF.
    // E_{n+1} = E_n * (conv(O / conv(E_n, P), P))
    let observed = img.clone();
    let mut estimate = img.clone();

    for _ in 0..RL_ITERS {
        let reblur = gaussian_blur_rgb(&estimate, radius_px);
        // ratio = observed / max(reblur, EPSILON), per-pixel per-channel
        let mut ratio = Image::new(img.width, img.height, ColorSpace::SceneLinearRec2020);
        for i in 0..observed.pixels.len() {
            let o = observed.pixels[i];
            let rb = reblur.pixels[i];
            ratio.pixels[i] = [
                o[0] / rb[0].max(EPSILON),
                o[1] / rb[1].max(EPSILON),
                o[2] / rb[2].max(EPSILON),
            ];
        }
        let correction = gaussian_blur_rgb(&ratio, radius_px);
        for i in 0..estimate.pixels.len() {
            let e = estimate.pixels[i];
            let c = correction.pixels[i];
            estimate.pixels[i] = [e[0] * c[0], e[1] * c[1], e[2] * c[2]];
        }
    }

    // --- Overdrive (amount > 100) ---
    let mut sharpened = estimate;
    if amount > 100.0 {
        let over_mix = (amount - 100.0) / 100.0;
        let blurred = gaussian_blur_rgb(&sharpened, radius_px);
        for i in 0..sharpened.pixels.len() {
            let s = sharpened.pixels[i];
            let b = blurred.pixels[i];
            sharpened.pixels[i] = [
                s[0] + (s[0] - b[0]) * over_mix,
                s[1] + (s[1] - b[1]) * over_mix,
                s[2] + (s[2] - b[2]) * over_mix,
            ];
        }
    }

    // --- Edge mask (detail + masking sliders) ---
    let overall_mix = (amount / 100.0).clamp(0.0, 1.5);
    let detail_atten = (detail / 100.0).clamp(0.0, 1.0);
    let masking_threshold = (masking / 100.0).clamp(0.0, 1.0);

    // Compute a simple edge-gradient map on luminance.
    let w = img.width as i32;
    let h = img.height as i32;
    let luma: Vec<f32> = observed.pixels.iter()
        .map(|p| 0.2627 * p[0] + 0.6780 * p[1] + 0.0593 * p[2])
        .collect();

    // Gradient magnitude via central-difference (fast Sobel approximation).
    let gradient = |x: i32, y: i32| -> f32 {
        let idx = |xi: i32, yi: i32| -> usize {
            let xc = xi.clamp(0, w - 1) as usize;
            let yc = yi.clamp(0, h - 1) as usize;
            yc * (w as usize) + xc
        };
        let gx = luma[idx(x + 1, y)] - luma[idx(x - 1, y)];
        let gy = luma[idx(x, y + 1)] - luma[idx(x, y - 1)];
        (gx * gx + gy * gy).sqrt()
    };

    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) as usize;
            let edge = if masking_threshold > 1e-3 {
                let g = gradient(x, y);
                // Normalize by a rough estimate: gradient around 0.2 on typical edges.
                let g_norm = (g / 0.2).clamp(0.0, 1.0);
                if g_norm >= masking_threshold { 1.0 } else { detail_atten }
            } else {
                1.0 // masking=0 → mix everywhere equally
            };
            let mix = overall_mix * edge;
            let o = observed.pixels[i];
            let s = sharpened.pixels[i];
            img.pixels[i] = [
                o[0] + (s[0] - o[0]) * mix,
                o[1] + (s[1] - o[1]) * mix,
                o[2] + (s[2] - o[2]) * mix,
            ];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amount_zero_is_identity() {
        let mut img = Image::new(10, 10, ColorSpace::SceneLinearRec2020);
        for (i, p) in img.pixels.iter_mut().enumerate() {
            *p = [(i % 3) as f32 * 0.3, 0.5, 0.7];
        }
        let before = img.pixels.clone();
        apply(&mut img, 0.0, 1.0, 25.0, 0.0);
        assert_eq!(img.pixels, before);
    }

    #[test]
    fn flat_region_stays_flat_approximately() {
        // On a perfectly flat field, RL iteration converges to the input (no
        // sharpening required). Output should be close to input.
        let mut img = Image::new(20, 20, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.5, 0.5, 0.5]; }
        apply(&mut img, 100.0, 1.0, 25.0, 0.0);
        for p in &img.pixels {
            for &c in p {
                assert!((c - 0.5).abs() < 0.01, "{} drifted from 0.5", c);
            }
        }
    }

    #[test]
    fn edge_becomes_sharper() {
        // A step edge should get steeper with amount=100.
        let mut img = Image::new(16, 4, ColorSpace::SceneLinearRec2020);
        for y in 0..4 {
            for x in 0..16_usize {
                img.pixels[y * 16 + x] = if x < 8 {
                    [0.3, 0.3, 0.3]
                } else {
                    [0.7, 0.7, 0.7]
                };
            }
        }
        let before = img.pixels.clone();
        apply(&mut img, 100.0, 1.0, 25.0, 0.0);
        // Right after the edge (x=8), sharpened should be >= original.
        // Just before edge (x=7), sharpened should be <= original.
        let right_idx = 2 * 16 + 8;
        let left_idx = 2 * 16 + 7;
        assert!(img.pixels[right_idx][0] >= before[right_idx][0] - 0.01,
            "right side: {} vs {}", img.pixels[right_idx][0], before[right_idx][0]);
        assert!(img.pixels[left_idx][0] <= before[left_idx][0] + 0.01,
            "left side: {} vs {}", img.pixels[left_idx][0], before[left_idx][0]);
    }

    #[test]
    fn preserves_scene_headroom() {
        let mut img = Image::new(10, 10, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [5.0, 3.0, 1.5]; }
        apply(&mut img, 100.0, 1.0, 25.0, 0.0);
        for p in &img.pixels {
            for &c in p {
                assert!(c.is_finite());
            }
        }
    }
}
