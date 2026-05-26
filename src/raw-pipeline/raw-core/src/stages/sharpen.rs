//! Luminance-only unsharp-mask sharpening on scene-linear Rec.2020.
//!
//! Mirrors the Metal stitchable kernel `SharpenLumaUSM.metal` byte-for-byte
//! (BT.2020 luma weights, smoothstep shadow guard, scale clamp). Produces
//! a "full-strength sharpened" (amount=100, masking=0) buffer that the
//! edge-mix step at the bottom of this stage scales with the amount /
//! detail / masking sliders.
//!
//! Replaces the per-channel Richardson-Lucy iteration + overdrive that
//! lived in this file previously. The 3-iteration RL implementation
//! produced saturated chroma artefacts in shadow regions where one
//! channel (typically blue, after Bayer + WB gain) had a noise spike
//! that ratio'd to many-fold larger than the other channels — the
//! "blue specks / magenta cast in shadows" pattern observed on
//! test_0002 etc. Luma-only USM scales every RGB channel at a pixel by
//! the SAME factor, so chroma ratios are preserved by construction.
//!
//! Constants must stay in lockstep with `SharpenLumaUSM.metal`:
//!   * `LUMA_R/G/B`     — BT.2020 luma weights.
//!   * `SHADOW_EPSILON` — 1e-4 (~13 EV below mid-gray; below this the
//!                       scale is held at 1.0 so shadow noise can't
//!                       amplify).
//!   * `SHADOW_BAND`    — 4.0 (smoothstep transition width above the
//!                       epsilon).
//!   * `MAX_SCALE`      — 4.0 (per-pixel amplification cap).
//!   * `MIN_SCALE`      — 0.0 (floor; prevents channel inversion at
//!                       extreme edges into deep shadow).
//!
//! The amount/detail/masking sliders run on top exactly as the Metal
//! `sharpenEdgeMix` kernel does (mix = amount * edge_factor).

use crate::{
    image::{ColorSpace, Image},
    stages::blur::gaussian_blur_plane,
};

const LUMA_R: f32 = 0.2627;
const LUMA_G: f32 = 0.6780;
const LUMA_B: f32 = 0.0593;
const SHADOW_EPSILON: f32 = 1e-4;
const SHADOW_BAND: f32 = 4.0;
const MAX_SCALE: f32 = 4.0;
const MIN_SCALE: f32 = 0.0;

/// Apply luminance-only USM sharpening on a scene-linear Rec.2020 image.
///
/// * `amount`  — 0..150 slider (>100 boosts the mix beyond unity).
/// * `radius`  — Gaussian PSF sigma in pixels (clamped 0.5..3.0).
/// * `detail`  — 0..100 slider; controls how much sharpening leaks into
///               flat regions when masking is non-zero.
/// * `masking` — 0..100 slider; gradient threshold for edge-only mix.
///
/// `amount == 0` short-circuits the entire stage.
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

    let w_usize = img.width as usize;
    let h_usize = img.height as usize;

    // --- Luma plane and its blur (single Gaussian pass) ---
    // Gaussian blur is linear, so blur(luma) == LUMA · blur(rgb).
    // Computing luma first and blurring one plane is 3× cheaper than
    // blurring RGB and dot-producting at every output pixel.
    let luma: Vec<f32> = img.pixels.iter()
        .map(|p| LUMA_R * p[0] + LUMA_G * p[1] + LUMA_B * p[2])
        .collect();
    let luma_blur = gaussian_blur_plane(&luma, w_usize, h_usize, radius_px);

    // --- Per-pixel luma USM with shadow guard (mirrors the Metal kernel) ---
    let observed_pixels = img.pixels.clone();
    let mut sharpened_pixels: Vec<[f32; 3]> = vec![[0.0; 3]; img.pixels.len()];
    for i in 0..img.pixels.len() {
        let o = observed_pixels[i];
        let li = luma[i];
        let lb = luma_blur[i];
        let lo = li + (li - lb);

        let weight = smoothstep(SHADOW_EPSILON, SHADOW_BAND * SHADOW_EPSILON, li);
        let safe_luma = li.max(SHADOW_EPSILON);
        let raw_scale = lo / safe_luma;
        let bounded = raw_scale.clamp(MIN_SCALE, MAX_SCALE);
        let scale = 1.0 + weight * (bounded - 1.0);
        sharpened_pixels[i] = [o[0] * scale, o[1] * scale, o[2] * scale];
    }

    // --- Edge-aware amount + masking blend ---
    // amount=100 + masking=0 → full sharpened buffer (mix=1).
    // amount<100 → linear interpolation toward observed.
    // masking>0 → flat regions mix at `detail_atten`, edges at 1.0.
    let overall_mix = (amount / 100.0).clamp(0.0, 1.5);
    let detail_atten = (detail / 100.0).clamp(0.0, 1.0);
    let masking_threshold = (masking / 100.0).clamp(0.0, 1.0);

    let w = img.width as i32;
    let h = img.height as i32;

    // Central-difference luma gradient — fast Sobel approximation.
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
                // Normalise by a rough estimate: gradient around 0.2 on
                // typical edges → g_norm ∈ [0, 1].
                let g_norm = (g / 0.2).clamp(0.0, 1.0);
                if g_norm >= masking_threshold { 1.0 } else { detail_atten }
            } else {
                1.0 // masking=0 → mix everywhere equally
            };
            let mix = overall_mix * edge;
            let o = observed_pixels[i];
            let s = sharpened_pixels[i];
            img.pixels[i] = [
                o[0] + (s[0] - o[0]) * mix,
                o[1] + (s[1] - o[1]) * mix,
                o[2] + (s[2] - o[2]) * mix,
            ];
        }
    }
}

/// GLSL-style smoothstep (matches Metal's built-in).
#[inline]
fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// "Broken" reference implementation: per-channel unsharp instead of
    /// luma-scaled. Mirrors the pre-#439 RGB unsharp pattern — each channel
    /// gets its own blur and its own delta — which produces chroma fringing
    /// on coloured edges (the failure mode this stage was rewritten to
    /// eliminate). Used by `broken_per_channel_reference_does_drift_chroma`
    /// below to prove the no-chroma-drift assertions in the real test would
    /// fire on a regression to per-channel. Not called by production code.
    fn apply_broken_per_channel(
        img: &mut Image,
        amount: f32,
        radius: f32,
        detail: f32,
        masking: f32,
    ) {
        img.assert_space(ColorSpace::SceneLinearRec2020);
        if amount.abs() < 1e-3 { return; }
        let radius_px = radius.clamp(0.5, 3.0).round() as usize;
        let radius_px = radius_px.max(1);
        let w = img.width as usize;
        let h = img.height as usize;

        // Per-channel blur — every channel gets its own Gaussian.
        let planes: [Vec<f32>; 3] = [
            img.pixels.iter().map(|p| p[0]).collect(),
            img.pixels.iter().map(|p| p[1]).collect(),
            img.pixels.iter().map(|p| p[2]).collect(),
        ];
        let blurred: [Vec<f32>; 3] = [
            gaussian_blur_plane(&planes[0], w, h, radius_px),
            gaussian_blur_plane(&planes[1], w, h, radius_px),
            gaussian_blur_plane(&planes[2], w, h, radius_px),
        ];

        // Per-channel unsharp: each channel's sharpened value is built from
        // its own delta. Apply the same shadow guard / clamp shape as the
        // real impl so the only structural difference is per-channel vs
        // luma-shared. (The shadow guard here uses each channel
        // individually, which is itself part of the failure mode.)
        let observed = img.pixels.clone();
        let mut sharpened: Vec<[f32; 3]> = vec![[0.0; 3]; img.pixels.len()];
        for i in 0..img.pixels.len() {
            for c in 0..3 {
                let oi = planes[c][i];
                let ob = blurred[c][i];
                let lo = oi + (oi - ob);
                let weight = smoothstep(SHADOW_EPSILON, SHADOW_BAND * SHADOW_EPSILON, oi);
                let safe = oi.max(SHADOW_EPSILON);
                let raw_scale = lo / safe;
                let bounded = raw_scale.clamp(MIN_SCALE, MAX_SCALE);
                let scale = 1.0 + weight * (bounded - 1.0);
                sharpened[i][c] = observed[i][c] * scale;
            }
        }

        // Edge-aware mix mirrors the real path. Build the gradient from
        // the per-channel-summed (proxy luma) so the mix factor isn't the
        // discriminator; the chroma-drift signal must come from the
        // per-channel scale itself.
        let proxy_luma: Vec<f32> = observed.iter().map(|p| p[0] + p[1] + p[2]).collect();
        let overall_mix = (amount / 100.0).clamp(0.0, 1.5);
        let detail_atten = (detail / 100.0).clamp(0.0, 1.0);
        let masking_threshold = (masking / 100.0).clamp(0.0, 1.0);
        let w_i = img.width as i32;
        let h_i = img.height as i32;
        let gradient = |x: i32, y: i32| -> f32 {
            let idx = |xi: i32, yi: i32| -> usize {
                let xc = xi.clamp(0, w_i - 1) as usize;
                let yc = yi.clamp(0, h_i - 1) as usize;
                yc * (w_i as usize) + xc
            };
            let gx = proxy_luma[idx(x + 1, y)] - proxy_luma[idx(x - 1, y)];
            let gy = proxy_luma[idx(x, y + 1)] - proxy_luma[idx(x, y - 1)];
            (gx * gx + gy * gy).sqrt()
        };
        for y in 0..h_i {
            for x in 0..w_i {
                let i = (y * w_i + x) as usize;
                let edge = if masking_threshold > 1e-3 {
                    let g = gradient(x, y);
                    let g_norm = (g / 0.2).clamp(0.0, 1.0);
                    if g_norm >= masking_threshold { 1.0 } else { detail_atten }
                } else {
                    1.0
                };
                let mix = overall_mix * edge;
                let o = observed[i];
                let s = sharpened[i];
                img.pixels[i] = [
                    o[0] + (s[0] - o[0]) * mix,
                    o[1] + (s[1] - o[1]) * mix,
                    o[2] + (s[2] - o[2]) * mix,
                ];
            }
        }
    }

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
        // On a perfectly flat field, luma USM has luma_in == luma_blur,
        // so the unsharp delta is zero and scale = 1.0 (identity).
        let mut img = Image::new(20, 20, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.5, 0.5, 0.5]; }
        apply(&mut img, 100.0, 1.0, 25.0, 0.0);
        for p in &img.pixels {
            for &c in p {
                assert!((c - 0.5).abs() < 1e-4, "{} drifted from 0.5", c);
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
        let right_idx = 2 * 16 + 8; // first pixel after the edge
        let left_idx = 2 * 16 + 7;  // last pixel before the edge
        assert!(img.pixels[right_idx][0] >= before[right_idx][0] - 0.01,
            "right side: {} vs {}", img.pixels[right_idx][0], before[right_idx][0]);
        assert!(img.pixels[left_idx][0] <= before[left_idx][0] + 0.01,
            "left side: {} vs {}", img.pixels[left_idx][0], before[left_idx][0]);
    }

    #[test]
    fn preserves_scene_headroom() {
        // Above-display values must remain finite (no NaN/Inf).
        let mut img = Image::new(10, 10, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [5.0, 3.0, 1.5]; }
        apply(&mut img, 100.0, 1.0, 25.0, 0.0);
        for p in &img.pixels {
            for &c in p {
                assert!(c.is_finite());
            }
        }
    }

    /// Regression for the test_0002 magenta-cast bug: a strongly blue-biased
    /// pixel inside an otherwise mid-gray field must not have its chroma
    /// ratio diverge — luma-only USM scales every channel by the SAME factor,
    /// so the R:G:B ratio of the output equals the R:G:B ratio of the input.
    /// Pre-fix the per-channel Richardson-Lucy update could pump B up several×
    /// while leaving R/G untouched, producing a magenta cast.
    #[test]
    fn chroma_ratio_is_preserved() {
        let w = 16u32;
        let h = 16u32;
        let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        // Mid-gray field with one strongly blue pixel (R:G:B = 1:1:4).
        for p in &mut img.pixels { *p = [0.18, 0.18, 0.18]; }
        let cx = (w / 2) as usize;
        let cy = (h / 2) as usize;
        let center = cy * (w as usize) + cx;
        img.pixels[center] = [0.10, 0.10, 0.40];
        apply(&mut img, 100.0, 1.0, 25.0, 0.0);

        let p = img.pixels[center];
        // Original chroma ratio: B/R = 4.0, G/R = 1.0.
        let r = p[0].max(1e-6);
        let bg_ratio = p[2] / r;
        let gr_ratio = p[1] / r;
        assert!((bg_ratio - 4.0).abs() < 1e-3,
            "B/R ratio drifted from 4.0: got {}", bg_ratio);
        assert!((gr_ratio - 1.0).abs() < 1e-3,
            "G/R ratio drifted from 1.0: got {}", gr_ratio);
    }

    /// Regression for test_0004 (Hasselblad H5D-40 ColorChecker SG): strongly
    /// negative scene-linear values produced by inv(CM) projecting saturated
    /// patches must not blow up the sharpened output. Luma-only USM with the
    /// shadow guard clamps `weight=0` for `luma_in < epsilon`, keeping the
    /// scale at 1.0 in deep shadow.
    #[test]
    fn negative_pixels_stay_bounded() {
        let w = 16u32;
        let h = 16u32;
        let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.18, 0.18, 0.18]; }
        // One strongly negative R pixel (mimics test_0004 worst case).
        img.pixels[(h / 2 * w + w / 2) as usize] = [-0.5, 0.18, 0.18];
        apply(&mut img, 40.0, 1.0, 25.0, 0.0);
        for (i, p) in img.pixels.iter().enumerate() {
            for (c, &v) in p.iter().enumerate() {
                assert!(v.is_finite(),
                    "pixel {} channel {} is NOT finite: {}", i, c, v);
                assert!(v.abs() < 5.0,
                    "pixel {} channel {} blew up: {} (pre-fix this exceeded 100)",
                    i, c, v);
            }
        }
    }

    /// Regression for ticket #439 (luminance-only to avoid color fringing on
    /// high-contrast edges). A vertical step edge that ALSO carries chroma
    /// — saturated red on one side, saturated cyan on the other — would
    /// fringe under any per-channel sharpener: red and cyan have opposite
    /// channel dominance (red is R-heavy, cyan is G+B-heavy), so an RGB
    /// unsharp-mask boosts R on the red side and G+B on the cyan side,
    /// pulling the edge pixels toward magenta / yellow casts they shouldn't
    /// carry.
    ///
    /// Under luma-only USM the scale is a single scalar per pixel applied
    /// to all three channels, so R:G:B ratios are preserved on both sides
    /// of the edge AND on the transition pixels themselves. We assert that
    /// every pixel on the canvas — including the edge transition — keeps
    /// the chroma ratio it started with (within a tight tolerance).
    #[test]
    fn saturated_edge_has_no_chroma_fringing() {
        let w = 32u32;
        let h = 8u32;
        let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        // Left half: saturated red. Right half: saturated cyan. Both
        // sides carry strong chroma with opposite channel dominance
        // (R-heavy vs G+B-heavy), so an RGB-per-channel sharpener
        // would boost R on the red side and G+B on the cyan side
        // independently — that's exactly the failure mode the ticket
        // calls out. Our assertions are on *ratio preservation*, which
        // the luma-only path enforces by construction regardless of
        // the luma magnitudes of the two sides.
        let left = [0.40_f32, 0.05, 0.05];
        let right = [0.05_f32, 0.40, 0.40];
        for y in 0..h as usize {
            for x in 0..w as usize {
                let p = if x < (w / 2) as usize { left } else { right };
                img.pixels[y * w as usize + x] = p;
            }
        }
        let before = img.pixels.clone();
        apply(&mut img, 100.0, 1.0, 25.0, 0.0);

        // Every pixel: scaled by a single scalar k, so output/input
        // must be identical across the three channels.
        for i in 0..img.pixels.len() {
            let a = before[i];
            let b = img.pixels[i];
            // Reconstruct the per-channel scale.
            let kr = b[0] / a[0].max(1e-6);
            let kg = b[1] / a[1].max(1e-6);
            let kb = b[2] / a[2].max(1e-6);
            assert!(
                (kr - kg).abs() < 1e-4 && (kg - kb).abs() < 1e-4,
                "pixel {} drifted off luma-only scaling: in={:?} out={:?} kr/kg/kb = {} {} {}",
                i, a, b, kr, kg, kb,
            );
            // Chroma ratio (R:G:B) must be preserved bit-for-bit (within
            // float tolerance): if a[0]/a[1] == c, then b[0]/b[1] == c.
            let r_in = a[0] / a[1].max(1e-6);
            let r_out = b[0] / b[1].max(1e-6);
            let g_in = a[2] / a[1].max(1e-6);
            let g_out = b[2] / b[1].max(1e-6);
            assert!(
                (r_in - r_out).abs() < 1e-4,
                "pixel {} R/G chroma ratio drifted: in={} out={}",
                i, r_in, r_out,
            );
            assert!(
                (g_in - g_out).abs() < 1e-4,
                "pixel {} B/G chroma ratio drifted: in={} out={}",
                i, g_in, g_out,
            );
        }

        // And the edge should actually have moved — confirm the test
        // isn't trivially passing because sharpening did nothing.
        let cy = (h / 2) as usize;
        let left_edge = cy * (w as usize) + (w as usize / 2 - 1);
        let right_edge = cy * (w as usize) + (w as usize / 2);
        let left_delta = (img.pixels[left_edge][1] - before[left_edge][1]).abs()
            + (img.pixels[left_edge][2] - before[left_edge][2]).abs();
        let right_delta = (img.pixels[right_edge][1] - before[right_edge][1]).abs()
            + (img.pixels[right_edge][2] - before[right_edge][2]).abs();
        assert!(
            left_delta > 1e-4 || right_delta > 1e-4,
            "sharpen did nothing on the edge — chroma-ratio test is vacuous",
        );
    }

    /// Control test for `saturated_edge_has_no_chroma_fringing`: run the
    /// broken per-channel reference on the same red/cyan edge fixture and
    /// assert it DOES drift chroma. This proves the assertion mechanism
    /// in the real test would catch a regression to per-channel unsharp —
    /// the failure mode pre-#439 sharpen exhibited.
    ///
    /// PR #450 did the same negative-case validation for clarity by hand
    /// (inverting the implementation locally); this test pins it
    /// permanently for sharpen. Closes part of #457.
    #[test]
    fn broken_per_channel_reference_does_drift_chroma() {
        let w = 32u32;
        let h = 8u32;
        let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        let left = [0.40_f32, 0.05, 0.05];
        let right = [0.05_f32, 0.40, 0.40];
        for y in 0..h as usize {
            for x in 0..w as usize {
                let p = if x < (w / 2) as usize { left } else { right };
                img.pixels[y * w as usize + x] = p;
            }
        }
        let before = img.pixels.clone();
        apply_broken_per_channel(&mut img, 100.0, 1.0, 25.0, 0.0);

        // Inverted-impl expectation: somewhere on this fixture, the broken
        // per-channel scales must diverge (kr != kg or kg != kb beyond
        // f32 round-off). The same tolerance as the real test (1e-4) is
        // used as the failure threshold so this control proves the EXACT
        // assertion in `saturated_edge_has_no_chroma_fringing` would bite.
        let mut drifted = false;
        let mut worst_pixel = (0usize, [0f32; 3], [0f32; 3], 0f32, 0f32, 0f32);
        let mut worst_spread = 0.0f32;
        for i in 0..img.pixels.len() {
            let a = before[i];
            let b = img.pixels[i];
            let kr = b[0] / a[0].max(1e-6);
            let kg = b[1] / a[1].max(1e-6);
            let kb = b[2] / a[2].max(1e-6);
            let spread = (kr - kg).abs().max((kg - kb).abs());
            if spread > worst_spread {
                worst_spread = spread;
                worst_pixel = (i, a, b, kr, kg, kb);
            }
            if (kr - kg).abs() >= 1e-4 || (kg - kb).abs() >= 1e-4 {
                drifted = true;
            }
        }
        assert!(
            drifted,
            "control failed: broken per-channel reference did NOT drift \
             chroma above the real test's 1e-4 tolerance — \
             saturated_edge_has_no_chroma_fringing would not bite on a \
             regression. Worst pixel: idx={} in={:?} out={:?} \
             kr/kg/kb={}/{}/{} (max spread {:.2e})",
            worst_pixel.0, worst_pixel.1, worst_pixel.2,
            worst_pixel.3, worst_pixel.4, worst_pixel.5, worst_spread,
        );
    }

    #[test]
    fn smoothstep_endpoints() {
        assert_eq!(smoothstep(0.0, 1.0, -0.5), 0.0);
        assert_eq!(smoothstep(0.0, 1.0, 0.0), 0.0);
        assert!((smoothstep(0.0, 1.0, 0.5) - 0.5).abs() < 1e-6);
        assert_eq!(smoothstep(0.0, 1.0, 1.0), 1.0);
        assert_eq!(smoothstep(0.0, 1.0, 1.5), 1.0);
    }
}
