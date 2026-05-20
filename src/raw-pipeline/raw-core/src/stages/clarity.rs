use crate::{
    image::{ColorSpace, Image},
    stages::blur::gaussian_blur_plane,
};

const CLARITY_RADIUS: usize = 40;

/// Rec.2020 luminance coefficients — matches LUMA_REC2020 in the
/// SceneToneControls Metal shader and the WebGL port.
const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

/// Numerical floor for the luma-ratio rescale (avoids div-by-zero on
/// pure-black pixels). Matches the constant in the Apple SceneClarity.metal
/// (`LUMA_FLOOR_C = 1e-6`).
const LUMA_FLOOR: f32 = 1e-6;

/// Luminance-preserving unsharp mask at radius 40 for mid-frequency local
/// contrast per spec § 3.8. `clarity` in [-100, +100]; 0 is identity.
///
/// Algorithm:
///   luma          = dot(rgb, LUMA_REC2020)
///   luma_blurred  = gaussian_blur_plane(luma, radius=40)
///   luma_boost    = luma + (luma - luma_blurred) * amount
///   out_rgb       = rgb * (luma_boost / max(luma, LUMA_FLOOR))
///
/// Why luma-space: the previous per-channel unsharp (`out = src + (src -
/// blurred) * amount` in RGB) amplified hue differences asymmetrically on
/// edges where R/G/B differ — at amount=1.0 the worst-case fringe pixel
/// in test_0002/clarity_max.xmp went from near-neutral (0.65, 0.62, 0.63)
/// to saturated magenta (0.79, 0.00, 0.63). ACR's clarity is luma-only
/// for exactly this reason. See Bug B in Ticket 11 / 11-Bugs.md and the
/// investigation spec at
/// .archived-plans/specs/2026-04-26-blacks-clarity-bug-investigation.md.
///
/// Multiplying the original RGB by a single scalar (the luma boost ratio)
/// preserves R:G:B ratios exactly — chromaticity is unchanged and only
/// luminance contrast is amplified. That's the textbook "structure" effect
/// clarity is supposed to deliver.
///
/// Mirrors the Metal `SceneClarity.metal` shader (clarityExtractLuma +
/// clarityCombine, with the shared SeparableGaussianBlur compute kernel
/// in the middle) and the WebGL port in
/// src/web/projects/maple-common/src/lib/webgl/shaders/scene-clarity.ts
/// byte-for-byte at the algorithm level.
pub fn apply(img: &mut Image, clarity: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if clarity.abs() < 1e-3 { return; }
    let amount = clarity / 100.0;

    let w = img.width as usize;
    let h = img.height as usize;

    // Build the luma plane.
    let luma_plane: Vec<f32> = img.pixels.iter()
        .map(|p| LUMA_REC2020[0] * p[0]
              + LUMA_REC2020[1] * p[1]
              + LUMA_REC2020[2] * p[2])
        .collect();
    let luma_blurred = gaussian_blur_plane(&luma_plane, w, h, CLARITY_RADIUS);

    for (i, p) in img.pixels.iter_mut().enumerate() {
        let luma = luma_plane[i];
        let boost = luma + (luma - luma_blurred[i]) * amount;
        let scale = boost / luma.max(LUMA_FLOOR);
        p[0] *= scale;
        p[1] *= scale;
        p[2] *= scale;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_at_zero() {
        let mut img = Image::new(10, 10, ColorSpace::SceneLinearRec2020);
        for (i, p) in img.pixels.iter_mut().enumerate() {
            *p = [(i % 3) as f32 * 0.3, 0.5, 0.7];
        }
        let before = img.pixels.clone();
        apply(&mut img, 0.0);
        for (a, b) in img.pixels.iter().zip(before.iter()) {
            assert_eq!(a, b);
        }
    }

    #[test]
    fn flat_input_stays_flat() {
        // A perfectly flat field has no high-frequency content; unsharp adds nothing.
        let mut img = Image::new(20, 20, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.5, 0.5, 0.5]; }
        apply(&mut img, 100.0);
        for p in &img.pixels {
            for c in 0..3 {
                assert!((p[c] - 0.5).abs() < 1e-4,
                    "channel {} drifted off the flat 0.5: {}", c, p[c]);
            }
        }
    }

    #[test]
    fn preserves_scene_headroom() {
        let mut img = Image::new(10, 10, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [5.0, 3.0, 1.5]; }
        apply(&mut img, 100.0);
        for p in &img.pixels {
            for &c in p {
                assert!(c.is_finite());
            }
        }
    }

    /// Regression for Ticket 11 Bug B. Build a coloured edge — half
    /// the pixels are warm-skin RGB, half are slightly-darker warm-skin
    /// RGB — and assert that after clarity at full strength every pixel
    /// retains the original chromaticity (R:G:B ratio). Pre-fix the
    /// per-channel unsharp would amplify R/G/B asymmetry asymmetrically
    /// at the edge and the warm-skin pixels would shift toward magenta.
    #[test]
    fn preserves_chromaticity_across_a_coloured_edge() {
        let w = 16usize;
        let h = 1usize;
        let mut img = Image::new(w as u32, h as u32, ColorSpace::SceneLinearRec2020);
        // Step from warm-skin "shadow" (R=0.30, G=0.20, B=0.15) to warm-skin
        // "mid" — same chromaticity (R/G = 1.5, R/B = 2.0), brighter by 5/3×.
        for (i, p) in img.pixels.iter_mut().enumerate() {
            *p = if i < w / 2 {
                [0.30, 0.20, 0.15]
            } else {
                [0.30 * 5.0 / 3.0, 0.20 * 5.0 / 3.0, 0.15 * 5.0 / 3.0]
            };
        }
        apply(&mut img, 100.0);

        // Reference R:G and R:B ratios (pre-clarity) — should be preserved.
        let r_g_ref = 1.5;
        let r_b_ref = 2.0;
        for (i, p) in img.pixels.iter().enumerate() {
            assert!(p[0].is_finite() && p[1].is_finite() && p[2].is_finite(),
                "pixel {} not finite: {:?}", i, p);
            // Ratio preserved within a tight tolerance — the only deviation
            // possible is f32 round-off and the LUMA_FLOOR floor (which only
            // kicks in for pure-black pixels, not here).
            let ratio_rg = p[0] / p[1];
            let ratio_rb = p[0] / p[2];
            assert!((ratio_rg - r_g_ref).abs() < 1e-3,
                "pixel {}: R/G ratio {} drifted from {} (RGB={:?})", i, ratio_rg, r_g_ref, p);
            assert!((ratio_rb - r_b_ref).abs() < 1e-3,
                "pixel {}: R/B ratio {} drifted from {} (RGB={:?})", i, ratio_rb, r_b_ref, p);
        }
    }

    /// Pure-black pixels (luma=0) must not produce NaN or Inf via div-by-zero.
    #[test]
    fn handles_pure_black_pixels() {
        let mut img = Image::new(20, 20, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.0, 0.0, 0.0]; }
        // Plant a single bright pixel so the blur is non-flat.
        img.pixels[10 * 20 + 10] = [0.5, 0.5, 0.5];
        apply(&mut img, 100.0);
        for (i, p) in img.pixels.iter().enumerate() {
            for &c in p {
                assert!(c.is_finite(), "pixel {} channel not finite: {:?}", i, p);
            }
        }
    }
}
