use crate::{
    image::{ColorSpace, Image},
    stages::blur::gaussian_blur_plane,
};

const TEXTURE_RADIUS: usize = 3;

/// Rec.2020 luminance coefficients — matches LUMA_REC2020 in the Apple
/// SceneToneControls / SceneClarity Metal shaders and the WebGL ports.
const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

/// Numerical floor for the luma-ratio rescale (avoids div-by-zero on
/// pure-black pixels). Matches the `LUMA_FLOOR_C = 1e-6` constant in the
/// Apple Metal kernel.
const LUMA_FLOOR: f32 = 1e-6;

/// Luminance-preserving unsharp mask at radius 3 for fine-frequency local
/// contrast per spec § 3.8. `texture` in [-100, +100]; 0 is identity.
///
/// Identical algorithm to `stages::clarity::apply` — only the radius
/// differs (3 vs 40). Sharing a single luma-space implementation also
/// matches the Apple Metal layout where `applySceneClarity` and
/// `applySceneTexture` differ only in the upstream blur radius and
/// share the same extract / combine kernels (see SceneClarity.metal).
///
/// Why luma-space: the previous per-channel unsharp amplified hue
/// differences asymmetrically on coloured edges, surfacing as
/// magenta/cyan halos around fine detail. See Bug B in Ticket 11 /
/// 11-Bugs.md and the investigation spec at
/// docs/superpowers/specs/2026-04-26-blacks-clarity-bug-investigation.md.
pub fn apply(img: &mut Image, texture: f32) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if texture.abs() < 1e-3 { return; }
    let amount = texture / 100.0;

    let w = img.width as usize;
    let h = img.height as usize;

    let luma_plane: Vec<f32> = img.pixels.iter()
        .map(|p| LUMA_REC2020[0] * p[0]
              + LUMA_REC2020[1] * p[1]
              + LUMA_REC2020[2] * p[2])
        .collect();
    let luma_blurred = gaussian_blur_plane(&luma_plane, w, h, TEXTURE_RADIUS);

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
        let mut img = Image::new(10, 10, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.5, 0.5, 0.5]; }
        apply(&mut img, 100.0);
        for p in &img.pixels {
            for c in 0..3 {
                assert!((p[c] - 0.5).abs() < 1e-4,
                    "channel {} drifted off the flat 0.5: {}", c, p[c]);
            }
        }
    }

    /// A monochrome step edge gets sharper with positive texture, and
    /// every pixel stays neutral grey (no chroma fringing — the luma-only
    /// unsharp only touches luminance).
    #[test]
    fn enhances_edges() {
        let mut img = Image::new(10, 1, ColorSpace::SceneLinearRec2020);
        for (i, p) in img.pixels.iter_mut().enumerate() {
            *p = if i < 5 { [0.3, 0.3, 0.3] } else { [0.7, 0.7, 0.7] };
        }
        let before = img.pixels.clone();
        apply(&mut img, 100.0);
        // Darker side stays ≤ before; brighter side stays ≥ before
        // (modulo a tiny f32 round-off allowance).
        assert!(img.pixels[4][0] <= before[4][0] + 0.01,
            "dark side at edge: {} vs before {}", img.pixels[4][0], before[4][0]);
        assert!(img.pixels[5][0] >= before[5][0] - 0.01,
            "bright side at edge: {} vs before {}", img.pixels[5][0], before[5][0]);
        // Every pixel stays neutral.
        for (i, p) in img.pixels.iter().enumerate() {
            assert!((p[0] - p[1]).abs() < 1e-3 && (p[1] - p[2]).abs() < 1e-3,
                "pixel {} no longer neutral: {:?}", i, p);
        }
    }

    /// Coloured-edge regression — same shape as the clarity test, smaller
    /// radius. Per-channel unsharp would have shifted chromaticity at the
    /// edge; luma-space preserves it.
    #[test]
    fn preserves_chromaticity_across_a_coloured_edge() {
        let w = 16usize;
        let h = 1usize;
        let mut img = Image::new(w as u32, h as u32, ColorSpace::SceneLinearRec2020);
        for (i, p) in img.pixels.iter_mut().enumerate() {
            *p = if i < w / 2 {
                [0.30, 0.20, 0.15]
            } else {
                [0.30 * 5.0 / 3.0, 0.20 * 5.0 / 3.0, 0.15 * 5.0 / 3.0]
            };
        }
        apply(&mut img, 100.0);
        let r_g_ref = 1.5;
        let r_b_ref = 2.0;
        for (i, p) in img.pixels.iter().enumerate() {
            assert!(p[0].is_finite() && p[1].is_finite() && p[2].is_finite(),
                "pixel {} not finite: {:?}", i, p);
            let ratio_rg = p[0] / p[1];
            let ratio_rb = p[0] / p[2];
            assert!((ratio_rg - r_g_ref).abs() < 1e-3,
                "pixel {}: R/G ratio {} drifted from {} (RGB={:?})", i, ratio_rg, r_g_ref, p);
            assert!((ratio_rb - r_b_ref).abs() < 1e-3,
                "pixel {}: R/B ratio {} drifted from {} (RGB={:?})", i, ratio_rb, r_b_ref, p);
        }
    }

    #[test]
    fn handles_pure_black_pixels() {
        let mut img = Image::new(20, 20, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.0, 0.0, 0.0]; }
        img.pixels[10 * 20 + 10] = [0.5, 0.5, 0.5];
        apply(&mut img, 100.0);
        for (i, p) in img.pixels.iter().enumerate() {
            for &c in p {
                assert!(c.is_finite(), "pixel {} channel not finite: {:?}", i, p);
            }
        }
    }
}
