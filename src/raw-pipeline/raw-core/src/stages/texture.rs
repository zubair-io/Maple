use crate::{
    image::{ColorSpace, Image},
    stages::blur::{guided_filter, GuidedOptions},
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

/// Identity threshold for the luma-ratio rescale (#1088). Pixels with
/// `luma <= LUMA_FLOOR` (including negative luma) pass through unchanged
/// — see the sibling constant in `stages::clarity` for the full
/// rationale (below the floor the quotient stops being a ratio and a
/// near-black pixel beside bright content exploded to `scale ≈ -3e5` at
/// texture +100). Matches the `LUMA_FLOOR` constant in the raw-gpu WGSL
/// recombine (`guided_combine.wgsl`).
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
    if texture.abs() < 1e-3 {
        return;
    }
    let amount = texture / 100.0;

    let w = img.width as usize;
    let h = img.height as usize;

    let luma_plane: Vec<f32> = img
        .pixels
        .iter()
        .map(|p| LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2])
        .collect();
    let base = guided_filter(
        &luma_plane,
        &luma_plane,
        w,
        h,
        GuidedOptions {
            r: TEXTURE_GUIDED_RADIUS,
            eps: TEXTURE_EPS,
        },
    );

    for (i, p) in img.pixels.iter_mut().enumerate() {
        let luma = luma_plane[i];
        // Identity at/below the luma floor (#1088) — identical guard to
        // `stages::clarity::apply` (texture IS clarity at radius 2).
        // Above the floor, dividing by `luma` is bit-identical to the
        // old `luma.max(LUMA_FLOOR)` divisor.
        if luma <= LUMA_FLOOR {
            continue;
        }
        let detail = luma - base[i];
        let boost = luma + detail * amount;
        let scale = boost / luma;
        p[0] *= scale;
        p[1] *= scale;
        p[2] *= scale;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stages::blur::gaussian_blur_plane;

    /// "Broken" reference implementation: per-channel unsharp instead of
    /// luma-scaled. This is the regression mode the ticket flags — pre-#206
    /// clarity / pre-#265 texture both shipped per-channel unsharps that
    /// fringed at coloured edges. Used by
    /// `broken_per_channel_reference_does_drift_chroma` below to prove the
    /// no-chroma-drift assertions in the real test (above) would fire on a
    /// regression. Not called by production code.
    fn apply_broken_per_channel(img: &mut Image, texture: f32) {
        img.assert_space(ColorSpace::SceneLinearRec2020);
        if texture.abs() < 1e-3 {
            return;
        }
        let amount = texture / 100.0;
        let w = img.width as usize;
        let h = img.height as usize;
        // Per-channel base via a separable Gaussian blur (matches the
        // pre-#206 unsharp pattern: blur each channel, subtract for detail,
        // amplify, add back). Using gaussian_blur_plane here keeps the
        // reference cheap and obviously distinct from the luma-only path.
        let mut planes: [Vec<f32>; 3] = [
            img.pixels.iter().map(|p| p[0]).collect(),
            img.pixels.iter().map(|p| p[1]).collect(),
            img.pixels.iter().map(|p| p[2]).collect(),
        ];
        let radius = TEXTURE_GUIDED_RADIUS.max(1);
        let blurred: [Vec<f32>; 3] = [
            gaussian_blur_plane(&planes[0], w, h, radius),
            gaussian_blur_plane(&planes[1], w, h, radius),
            gaussian_blur_plane(&planes[2], w, h, radius),
        ];
        for i in 0..img.pixels.len() {
            for c in 0..3 {
                let detail = planes[c][i] - blurred[c][i];
                planes[c][i] = planes[c][i] + detail * amount;
            }
            img.pixels[i] = [planes[0][i], planes[1][i], planes[2][i]];
        }
    }

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
        for p in &mut img.pixels {
            *p = [0.5, 0.5, 0.5];
        }
        apply(&mut img, 100.0);
        for p in &img.pixels {
            for c in 0..3 {
                assert!(
                    (p[c] - 0.5).abs() < 1e-4,
                    "channel {} drifted off the flat 0.5: {}",
                    c,
                    p[c]
                );
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
            *p = if i < 5 {
                [0.3, 0.3, 0.3]
            } else {
                [0.7, 0.7, 0.7]
            };
        }
        let before = img.pixels.clone();
        apply(&mut img, 100.0);
        // Darker side stays ≤ before; brighter side stays ≥ before
        // (modulo a tiny f32 round-off allowance).
        assert!(
            img.pixels[4][0] <= before[4][0] + 0.01,
            "dark side at edge: {} vs before {}",
            img.pixels[4][0],
            before[4][0]
        );
        assert!(
            img.pixels[5][0] >= before[5][0] - 0.01,
            "bright side at edge: {} vs before {}",
            img.pixels[5][0],
            before[5][0]
        );
        // Every pixel stays neutral.
        for (i, p) in img.pixels.iter().enumerate() {
            assert!(
                (p[0] - p[1]).abs() < 1e-3 && (p[1] - p[2]).abs() < 1e-3,
                "pixel {} no longer neutral: {:?}",
                i,
                p
            );
        }
    }

    /// Coloured-edge regression — same shape as the clarity test, smaller
    /// radius. Per-channel unsharp would have shifted chromaticity at the
    /// edge; luma-space preserves it. This case is a same-chromaticity
    /// brightness step (warm-skin shadow → warm-skin mid). For the
    /// different-chromaticity step (saturated primary → neutral grey)
    /// see `preserves_chromaticity_across_a_saturated_edge` below.
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
            assert!(
                p[0].is_finite() && p[1].is_finite() && p[2].is_finite(),
                "pixel {} not finite: {:?}",
                i,
                p
            );
            let ratio_rg = p[0] / p[1];
            let ratio_rb = p[0] / p[2];
            assert!(
                (ratio_rg - r_g_ref).abs() < 1e-3,
                "pixel {}: R/G ratio {} drifted from {} (RGB={:?})",
                i,
                ratio_rg,
                r_g_ref,
                p
            );
            assert!(
                (ratio_rb - r_b_ref).abs() < 1e-3,
                "pixel {}: R/B ratio {} drifted from {} (RGB={:?})",
                i,
                ratio_rb,
                r_b_ref,
                p
            );
        }
    }

    // Per-side tolerances for the saturated-edge chromaticity invariant.
    // Shared between the real test
    // (`preserves_chromaticity_across_a_saturated_edge`) and its control
    // (`broken_per_channel_reference_does_drift_chroma`) so the control
    // proves drift exceeds the EXACT threshold the real test asserts on —
    // otherwise drift in the 1e-5..1e-4 band would slip past the control
    // while still failing the real test (or vice versa).
    const SAT_EDGE_RED_SIDE_TOL: f32 = 1e-6;
    const SAT_EDGE_GREY_SIDE_TOL: f32 = 1e-5;

    /// No-chroma-drift regression on a *saturated* edge — the strictest
    /// luminance-only check. One side is a fully-saturated Rec.2020 red
    /// primary `[1.0, 0.0, 0.0]`, the other side is neutral grey
    /// `[0.5, 0.5, 0.5]`. The luma values differ (≈0.26 vs ≈0.50), so the
    /// guided filter sees a real edge and the detail layer is non-zero on
    /// both sides — i.e. texture actually fires here.
    ///
    /// Because the stage scales R, G, B by a single scalar, the red side
    /// must stay on the red axis (G == 0, B == 0) and the grey side must
    /// stay neutral (R == G == B) after texture=+100. A per-channel
    /// unsharp regression would leak energy across channels at the edge —
    /// red side gains green/blue tint, grey side becomes non-neutral —
    /// and this test catches that immediately.
    #[test]
    fn preserves_chromaticity_across_a_saturated_edge() {
        let w = 16usize;
        let h = 1usize;
        let mut img = Image::new(w as u32, h as u32, ColorSpace::SceneLinearRec2020);
        for (i, p) in img.pixels.iter_mut().enumerate() {
            *p = if i < w / 2 {
                [1.0, 0.0, 0.0] // fully saturated red
            } else {
                [0.5, 0.5, 0.5] // neutral grey, comparable luma magnitude
            };
        }
        apply(&mut img, 100.0);
        for (i, p) in img.pixels.iter().enumerate() {
            assert!(
                p[0].is_finite() && p[1].is_finite() && p[2].is_finite(),
                "pixel {} not finite: {:?}",
                i,
                p
            );
            if i < w / 2 {
                // Red-side: G and B must remain at zero — a per-channel
                // unsharp would pull them off zero at the edge.
                assert!(
                    p[1].abs() < SAT_EDGE_RED_SIDE_TOL,
                    "red-side pixel {}: G drifted off zero: {:?}",
                    i,
                    p
                );
                assert!(
                    p[2].abs() < SAT_EDGE_RED_SIDE_TOL,
                    "red-side pixel {}: B drifted off zero: {:?}",
                    i,
                    p
                );
            } else {
                // Grey-side: R == G == B (within f32 round-off).
                assert!(
                    (p[0] - p[1]).abs() < SAT_EDGE_GREY_SIDE_TOL,
                    "grey-side pixel {}: R-G drifted: {:?}",
                    i,
                    p
                );
                assert!(
                    (p[1] - p[2]).abs() < SAT_EDGE_GREY_SIDE_TOL,
                    "grey-side pixel {}: G-B drifted: {:?}",
                    i,
                    p
                );
            }
        }
    }

    /// Control test for `preserves_chromaticity_across_a_saturated_edge`:
    /// run the broken per-channel reference on the same fixture and assert
    /// that it DOES drift chroma. This proves the assertion mechanism in
    /// the real test would catch a regression to per-channel unsharp —
    /// without it, a future "simplification" back to per-channel could
    /// silently slip through if the saturated-edge assertions were vacuous.
    ///
    /// PR #450 did the same negative-case validation for clarity by hand
    /// (inverting the implementation locally); this test pins it
    /// permanently for texture. Closes part of #457.
    #[test]
    fn broken_per_channel_reference_does_drift_chroma() {
        let w = 16usize;
        let h = 1usize;
        let mut img = Image::new(w as u32, h as u32, ColorSpace::SceneLinearRec2020);
        for (i, p) in img.pixels.iter_mut().enumerate() {
            *p = if i < w / 2 {
                [1.0, 0.0, 0.0] // fully saturated red
            } else {
                [0.5, 0.5, 0.5] // neutral grey
            };
        }
        apply_broken_per_channel(&mut img, 100.0);

        // Inverted-impl expectation: the per-channel unsharp must drift
        // chroma somewhere on this fixture. Either the red-side zero
        // channels lift off zero, or the grey-side neutrality breaks
        // (R != G or G != B). At least one of these must fire — if both
        // hold, the broken reference isn't actually drifting and the real
        // test is vacuous. We check ALL pixels because the edge is
        // narrow; the broken-impl drift is largest at the transition.
        //
        // Tolerances MUST match the real test's per-side thresholds
        // (SAT_EDGE_RED_SIDE_TOL / SAT_EDGE_GREY_SIDE_TOL) — otherwise
        // drift in the gap between the two tolerances would slip past
        // this control while still tripping the real assertion, leaving
        // the assertion mechanism unproven for that band.
        let mut red_zero_leaked = false;
        let mut grey_lost_neutrality = false;
        for (i, p) in img.pixels.iter().enumerate() {
            if i < w / 2 {
                if p[1].abs() >= SAT_EDGE_RED_SIDE_TOL || p[2].abs() >= SAT_EDGE_RED_SIDE_TOL {
                    red_zero_leaked = true;
                }
            } else {
                if (p[0] - p[1]).abs() >= SAT_EDGE_GREY_SIDE_TOL
                    || (p[1] - p[2]).abs() >= SAT_EDGE_GREY_SIDE_TOL
                {
                    grey_lost_neutrality = true;
                }
            }
        }
        assert!(
            red_zero_leaked || grey_lost_neutrality,
            "control failed: broken per-channel reference did NOT drift \
             chroma above the real test's per-side tolerances \
             (red {:.0e}, grey {:.0e}) — \
             preserves_chromaticity_across_a_saturated_edge would not \
             bite on a regression. Pixels: {:?}",
            SAT_EDGE_RED_SIDE_TOL,
            SAT_EDGE_GREY_SIDE_TOL,
            img.pixels,
        );
    }

    #[test]
    fn handles_pure_black_pixels() {
        let mut img = Image::new(20, 20, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = [0.0, 0.0, 0.0];
        }
        img.pixels[10 * 20 + 10] = [0.5, 0.5, 0.5];
        apply(&mut img, 100.0);
        for (i, p) in img.pixels.iter().enumerate() {
            for &c in p {
                assert!(c.is_finite(), "pixel {} channel not finite: {:?}", i, p);
            }
        }
    }

    /// #1088 regression — the luma-floor blowup, texture flavour (texture
    /// IS clarity at radius 2; same guard, same fixture shape — see the
    /// clarity sibling test for the full numbers). A sub-floor-luma pixel
    /// with non-tiny mixed-sign channels and a negative-luma pixel sit in
    /// a bright field at texture +100: both must pass through identity,
    /// and nothing in the image may blow past the input range (pre-fix
    /// the sub-floor pixel hit `scale ≈ -1e5` against the pinned 1e-6
    /// divisor).
    #[test]
    fn near_black_beside_bright_is_identity_not_speckle() {
        let w = 48usize;
        let h = 8usize;
        let mut img = Image::new(w as u32, h as u32, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = [0.8, 0.8, 0.8];
        }
        let r = 0.1f32;
        let b = 0.0f32;
        let g = (5e-7 - LUMA_REC2020[0] * r - LUMA_REC2020[2] * b) / LUMA_REC2020[1];
        let sub_floor = [r, g, b];
        let sub_floor_luma = LUMA_REC2020[0] * r + LUMA_REC2020[1] * g + LUMA_REC2020[2] * b;
        assert!(
            sub_floor_luma > 0.0 && sub_floor_luma <= LUMA_FLOOR,
            "fixture bug: luma {} not in (0, LUMA_FLOOR]",
            sub_floor_luma
        );
        let neg_luma = [0.05f32, -0.05, 0.01];

        let i_sub = 4 * w + 10;
        let i_neg = 4 * w + 30;
        img.pixels[i_sub] = sub_floor;
        img.pixels[i_neg] = neg_luma;

        apply(&mut img, 100.0);

        assert_eq!(
            img.pixels[i_sub], sub_floor,
            "sub-floor-luma pixel must pass through identity"
        );
        assert_eq!(
            img.pixels[i_neg], neg_luma,
            "negative-luma pixel must pass through identity"
        );
        for (i, p) in img.pixels.iter().enumerate() {
            for &c in p {
                assert!(
                    c.is_finite() && c.abs() <= 8.0,
                    "pixel {} blew past the input range: {:?}",
                    i,
                    p
                );
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
            if x >= w {
                break;
            }
            let v = img.pixels[row * w + x][0];
            let over = (v - bg).max(0.0);
            if over > max_overshoot {
                max_overshoot = over;
            }
        }
        assert!(
            max_overshoot / bg < 0.02,
            "halo overshoot {:.4} / bg {:.4} = {:.2}% exceeds 2%",
            max_overshoot,
            bg,
            100.0 * max_overshoot / bg
        );
    }
}
