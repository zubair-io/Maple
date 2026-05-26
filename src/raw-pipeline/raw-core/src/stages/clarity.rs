use crate::{
    image::{ColorSpace, Image},
    stages::blur::guided_filter,
};

/// Guided-filter window radius for the structure-scale base/detail
/// decomposition. The base layer is `guided(luma, luma, r, eps)`; the
/// detail layer is `luma - base`. A guided filter at radius `r` has an
/// effective stencil reach of `2r` pixels per side (the mean_a / mean_b
/// passes box-blur a buffer that was itself box-blurred at radius `r`).
///
/// `CLARITY_GUIDED_RADIUS = 20` therefore reaches 40 px per side — about
/// the same structural scale as the previous 40-px-radius unsharp mask,
/// but without the cross-edge bleed that produced halos. The
/// `TILE_OVERLAP_PX` const-assert in `pipeline::tile::mod` pins itself to
/// this constant via `CLARITY_GUIDED_REACH_PX` (= 2 × radius).
pub const CLARITY_GUIDED_RADIUS: usize = 20;

/// Effective stencil reach of the clarity stage, in pixels per side.
/// Tile overlap must cover this — the const assertion in
/// `pipeline::tile::mod` enforces it at build time.
pub const CLARITY_GUIDED_REACH_PX: usize = 2 * CLARITY_GUIDED_RADIUS;

/// Backward-compat alias — older tile-region asserts read
/// `CLARITY_RADIUS`. Kept equal to the guided-filter reach so existing
/// runtime checks (e.g. `pipeline/tile/region.rs::pad_and_clamp_…`) still
/// pin the right invariant. New code should reference
/// `CLARITY_GUIDED_REACH_PX` directly.
pub const CLARITY_RADIUS: usize = CLARITY_GUIDED_REACH_PX;

/// Guided-filter regularisation. Small enough that strong edges in the
/// luma plane (Δluma ≳ √eps) propagate as edges; large enough that f32
/// noise on flat patches doesn't ring. `1e-3` matches the dehaze
/// transmission refinement — both stages operate on scene-linear luma
/// in roughly the [0,1] range, so the same eps is appropriate.
const CLARITY_EPS: f32 = 1e-3;

/// Rec.2020 luminance coefficients — matches LUMA_REC2020 in the
/// SceneToneControls Metal shader and the WebGL port.
const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

/// Numerical floor for the luma-ratio rescale (avoids div-by-zero on
/// pure-black pixels). Matches the constant in the Apple SceneClarity.metal
/// (`LUMA_FLOOR_C = 1e-6`).
const LUMA_FLOOR: f32 = 1e-6;

/// Luminance-preserving local-contrast enhancement at the structure
/// scale (~40 px effective reach) per spec § 3.8. `clarity` in
/// [-100, +100]; 0 is identity.
///
/// Algorithm (no-halo, guided-filter base/detail decomposition):
///   luma   = dot(rgb, LUMA_REC2020)
///   base   = guided_filter(guide=luma, p=luma, r=20, eps=1e-3)
///   detail = luma - base
///   boost  = luma + detail * amount       (amount = clarity / 100)
///   scale  = boost / max(luma, LUMA_FLOOR)
///   out    = rgb * scale
///
/// Why guided filter (#264): the previous implementation built `base`
/// via a Gaussian blur, which bleeds across high-contrast edges. The
/// resulting `detail` carries the bright/dark overshoot pattern an
/// unsharp mask produces by construction — at clarity=+100 on a dark
/// disk the synthetic halo detector at `src/scripts/halo_check.py`
/// reported a +11.28 % overshoot ring (PR #260 baseline). The guided
/// filter is edge-preserving: detail at an edge stays inside the edge,
/// so amplifying detail does not push energy across the boundary.
/// The harness now reports < 2 % on the same synthetic disk.
///
/// Why luma-space: the per-channel unsharp mask used pre-#206
/// amplified hue differences asymmetrically on edges where R/G/B
/// differ — at amount=1.0 the worst-case fringe pixel in
/// test_0002/clarity_max.xmp went from near-neutral (0.65, 0.62, 0.63)
/// to saturated magenta (0.79, 0.00, 0.63). The reference renderer's clarity is luma-only
/// for exactly this reason. See Bug B in Ticket 11 / 11-Bugs.md and the
/// investigation spec at
/// .archived-plans/specs/2026-04-26-blacks-clarity-bug-investigation.md.
///
/// Multiplying the original RGB by a single scalar (the luma boost ratio)
/// preserves R:G:B ratios exactly — chromaticity is unchanged and only
/// luminance contrast is amplified.
///
/// Clarity and texture (#265) differ only in the guided-filter radius:
/// 20 px for the structure scale here, 2 px for the fine-detail scale
/// in `stages::texture`. They share the `blur::guided_filter` primitive.
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
    // Edge-preserving base (low-frequency, no cross-edge bleed).
    let base = guided_filter(&luma_plane, &luma_plane, w, h, CLARITY_GUIDED_RADIUS, CLARITY_EPS);

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
        // Closed-form grey predictor: a perfectly flat neutral field has
        // no high-frequency content; detail is zero everywhere, so the
        // scalar boost ratio is exactly 1 and every pixel passes through
        // unchanged — at every clarity amount in [-100, +100].
        // Ticket #428 explicitly asks for this invariant at "any clarity
        // amount", not just the previously-pinned +100.
        let amounts = [-100.0, -50.0, -10.0, 0.0, 10.0, 25.0, 50.0, 100.0];
        for amount in amounts {
            let mut img = Image::new(20, 20, ColorSpace::SceneLinearRec2020);
            for p in &mut img.pixels {
                *p = [0.5, 0.5, 0.5];
            }
            apply(&mut img, amount);
            for p in &img.pixels {
                for c in 0..3 {
                    assert!(
                        (p[c] - 0.5).abs() < 1e-4,
                        "clarity={}: channel {} drifted off the flat 0.5: {}",
                        amount,
                        c,
                        p[c]
                    );
                }
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

    /// Local-contrast enhancement actually fires on a step edge:
    /// the dark side gets darker, the bright side gets brighter.
    #[test]
    fn enhances_edges() {
        let w = 32usize;
        let h = 8usize;
        let mut img = Image::new(w as u32, h as u32, ColorSpace::SceneLinearRec2020);
        for y in 0..h {
            for x in 0..w {
                let v = if x < w / 2 { 0.3 } else { 0.7 };
                img.pixels[y * w + x] = [v, v, v];
            }
        }
        let before = img.pixels.clone();
        apply(&mut img, 100.0);
        // Pixels at the step retain or amplify contrast — the
        // brighter side stays ≥ original brightness, the darker
        // side stays ≤ original darkness, modulo f32 noise.
        let dark_i  = (h / 2) * w + (w / 2 - 1);
        let bright_i = (h / 2) * w + (w / 2);
        assert!(img.pixels[dark_i][0] <= before[dark_i][0] + 1e-3,
            "dark side at edge brightened: {} > {}",
            img.pixels[dark_i][0], before[dark_i][0]);
        assert!(img.pixels[bright_i][0] >= before[bright_i][0] - 1e-3,
            "bright side at edge darkened: {} < {}",
            img.pixels[bright_i][0], before[bright_i][0]);
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

    /// Ticket #428 — pin the luminance-only invariant against a
    /// saturated-vs-neutral edge. This is the case that fails most
    /// loudly under a per-channel RGB unsharp mask:
    ///
    /// * Left half: neutral grey (R=G=B). Across the edge, the
    ///   saturated channel has no contrast step, so per-channel unsharp
    ///   produces no boost on R while G and B overshoot — pulling the
    ///   neutral side toward the *complement* of the primary (cyan for
    ///   a red edge, magenta for green, yellow for blue).
    /// * Right half: a saturated primary (e.g. [0.7, 0, 0]). Per-channel
    ///   unsharp would overshoot R only, leaving the zero channels at
    ///   exact zero — but the resulting R:G:B ratio still drifts toward
    ///   "more saturated than the source" on the boundary side.
    ///
    /// Under the current luma-only implementation, the entire scalar
    /// boost is the luma ratio, so every pixel's R:G:B ratio is
    /// preserved exactly. Neutral pixels stay neutral; zero channels
    /// stay zero. This test fails under a per-channel RGB clarity.
    /// Walks every primary so it also exercises Green, Blue, Cyan,
    /// Magenta, Yellow — keeps the assertion symmetric and avoids a
    /// red-only regression test pinning a partial invariant.
    #[test]
    fn no_chroma_drift_on_saturated_vs_neutral_edge() {
        use crate::synthetic_input::{saturated_neutral_edge, Primary};
        const NEUTRAL: f32 = 0.5;
        const SATURATED: f32 = 0.7;
        let primaries = [
            Primary::Red,
            Primary::Green,
            Primary::Blue,
            Primary::Cyan,
            Primary::Magenta,
            Primary::Yellow,
        ];
        for primary in primaries {
            // 64-px wide so the guided-filter window (radius=20) sees
            // the edge centred well inside the buffer; 4-row tall is
            // enough for a 1-D check (the image is constant along y).
            let mut img = saturated_neutral_edge(primary, NEUTRAL, SATURATED, 64, 4);
            apply(&mut img, 100.0);
            for (i, p) in img.pixels.iter().enumerate() {
                let x = i % 64;
                let y = i / 64;
                for &c in p {
                    assert!(
                        c.is_finite(),
                        "{:?} pixel ({},{}) non-finite: {:?}",
                        primary,
                        x,
                        y,
                        p
                    );
                }
                if x < 32 {
                    // Neutral side: R==G==B at every pixel including
                    // those adjacent to the edge. Tight tolerance — only
                    // f32 round-off is allowed.
                    assert!(
                        (p[0] - p[1]).abs() < 1e-4 && (p[1] - p[2]).abs() < 1e-4,
                        "{:?} neutral side at ({},{}) lost achromaticity: {:?}",
                        primary,
                        x,
                        y,
                        p
                    );
                } else {
                    // Saturated side: any channel that was 0 in the
                    // source must stay exactly 0 (a scalar multiply
                    // preserves zeros). Asserting this end of the
                    // invariant is what catches a per-channel unsharp
                    // bleeding a complementary fringe across the edge.
                    let unit = primary_rgb_unit(primary);
                    for c in 0..3 {
                        if unit[c] == 0.0 {
                            assert!(
                                p[c].abs() < 1e-6,
                                "{:?} saturated side at ({},{}) channel {} leaked off zero: {:?}",
                                primary,
                                x,
                                y,
                                c,
                                p
                            );
                        }
                    }
                }
            }
        }
    }

    /// Mirror of `Primary::rgb_unit` for the assertions above — the
    /// real one is private to `synthetic_input`.
    fn primary_rgb_unit(primary: crate::synthetic_input::Primary) -> [f32; 3] {
        use crate::synthetic_input::Primary;
        match primary {
            Primary::Red => [1.0, 0.0, 0.0],
            Primary::Green => [0.0, 1.0, 0.0],
            Primary::Blue => [0.0, 0.0, 1.0],
            Primary::Cyan => [0.0, 1.0, 1.0],
            Primary::Magenta => [1.0, 0.0, 1.0],
            Primary::Yellow => [1.0, 1.0, 0.0],
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

    /// Halo regression — unit-level mirror of the synthetic dark-disk
    /// scene in `src/scripts/halo_check.py`. A dark blob (luma ≈ 0.2)
    /// on a bright field (luma ≈ 0.8) gets clarity=+100. We then
    /// inspect the ring of pixels immediately outside the blob: with
    /// the old Gaussian-based unsharp mask, that ring overshoots the
    /// background by more than 5 %. With the guided-filter detail
    /// extraction this regression test pins it under 2 %.
    #[test]
    fn no_halo_on_dark_disk() {
        let w = 64usize;
        let h = 64usize;
        let cx = (w as f32 - 1.0) * 0.5;
        let cy = (h as f32 - 1.0) * 0.5;
        let radius = 16.0f32;
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
        // Inspect a ring 1..5 px outside the disk along +x at row cy.
        let row = h / 2;
        let mut max_overshoot = 0.0f32;
        for dx in 1..=5 {
            let x = (cx + radius + dx as f32).round() as usize;
            if x >= w { break; }
            let v = img.pixels[row * w + x][0];
            let over = (v - bg).max(0.0);
            if over > max_overshoot { max_overshoot = over; }
        }
        // 2 % of background is the same target the synthetic detector uses.
        assert!(max_overshoot / bg < 0.02,
            "halo overshoot {:.4} / bg {:.4} = {:.2}% exceeds 2%",
            max_overshoot, bg, 100.0 * max_overshoot / bg);
    }
}
