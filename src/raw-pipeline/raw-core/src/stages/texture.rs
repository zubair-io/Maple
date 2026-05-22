use crate::{
    image::{ColorSpace, Image},
    stages::blur::guided_filter,
};

/// Guided-filter window radius for the fine-detail base/detail
/// decomposition. Effective stencil reach is `2r = 4` px per side —
/// well below the clarity reach so no tile-overlap adjustment is
/// needed (the const-assert in `pipeline::tile::mod` is dominated by
/// clarity's much larger reach).
const TEXTURE_GUIDED_RADIUS: usize = 2;

/// Guided-filter regularisation. Same value as clarity / dehaze —
/// scene-linear luma sits in roughly the [0,1] range across all three
/// stages so the same eps preserves real edges and squelches f32 noise.
const TEXTURE_EPS: f32 = 1e-3;

/// Rec.2020 luminance coefficients — matches LUMA_REC2020 in the Apple
/// SceneToneControls / SceneClarity Metal shaders and the WebGL ports.
const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

/// Numerical floor for the luma-ratio rescale (avoids div-by-zero on
/// pure-black pixels). Matches the `LUMA_FLOOR_C = 1e-6` constant in the
/// Apple Metal kernel.
const LUMA_FLOOR: f32 = 1e-6;

/// Luminance-preserving local-contrast enhancement at the fine-detail
/// scale (~4 px effective reach) per spec § 3.8. `texture` in
/// [-100, +100]; 0 is identity.
///
/// Identical algorithm to `stages::clarity::apply` — only the
/// guided-filter radius differs (2 vs 20). Sharing
/// `blur::guided_filter` keeps both stages structurally aligned and
/// makes it easy to verify they fix the same halo defect.
///
/// Why guided filter (#265): the previous radius-3 Gaussian-blur
/// unsharp produced a smaller-amplitude version of the same halo ring
/// clarity (#264) exhibited — the synthetic halo detector reported
/// +4.13 % overshoot at texture=+100 on the dark-disk fixture. Edge-
/// preserving base/detail decomposition keeps the detail layer
/// confined to each side of an edge, so amplification does not push
/// energy across the boundary.
///
/// Why luma-space: the previous per-channel unsharp amplified hue
/// differences asymmetrically on coloured edges, surfacing as
/// magenta/cyan halos around fine detail. See Bug B in Ticket 11 /
/// 11-Bugs.md and the investigation spec at
/// .archived-plans/specs/2026-04-26-blacks-clarity-bug-investigation.md.
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
    let base = guided_filter(&luma_plane, &luma_plane, w, h, TEXTURE_GUIDED_RADIUS, TEXTURE_EPS);

    for (i, p) in img.pixels.iter_mut().enumerate() {
        let luma = luma_plane[i];
        let detail = luma - base[i];
        let boost = luma + detail * amount;
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

    /// Halo regression for #265 — same shape as the clarity test but at
    /// the smaller texture radius. A dark blob on a bright field gets
    /// texture=+100; the brightest ring just outside the blob must not
    /// exceed background by more than 2 %.
    #[test]
    fn no_halo_on_dark_disk() {
        let w = 64usize;
        let h = 64usize;
        let cx = (w as f32 - 1.0) * 0.5;
        let cy = (h as f32 - 1.0) * 0.5;
        let radius = 8.0f32;
        let mut img = Image::new(w as u32, h as u32, ColorSpace::SceneLinearRec2020);
        for y in 0..h {
            for x in 0..w {
                let dx = x as f32 - cx;
                let dy = y as f32 - cy;
                let d = (dx * dx + dy * dy).sqrt();
                let v: f32 = if d < radius { 0.2 } else { 0.8 };
                img.pixels[y * w + x] = [v, v, v];
            }
        }
        let bg = 0.8f32;
        apply(&mut img, 100.0);
        let row = h / 2;
        let mut max_overshoot = 0.0f32;
        for dx in 1..=5 {
            let x = (cx + radius + dx as f32).round() as usize;
            if x >= w { break; }
            let v = img.pixels[row * w + x][0];
            let over = (v - bg).max(0.0);
            if over > max_overshoot { max_overshoot = over; }
        }
        assert!(max_overshoot / bg < 0.02,
            "halo overshoot {:.4} / bg {:.4} = {:.2}% exceeds 2%",
            max_overshoot, bg, 100.0 * max_overshoot / bg);
    }
}
