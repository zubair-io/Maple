//! #1103 tests for the scene-tone-controls S/H rework: the widened
//! engagement ranges, the pole-free negative highlights half (carrying
//! forward the #1081 / PR #1117 contract on the new response), and the
//! tonal detail mask (regional vs per-pixel multiplier). Split out of the
//! sibling `tests.rs` to keep both files under the 600-LOC hard cap
//! (per CONTRIBUTING.md).

#![cfg(test)]

use super::*;

// Duplicates of `tests::model_default` / `tests::fresh_img` — the sibling
// `mod tests` is a private cousin; duplicating two tiny constructors keeps
// the helpers test-local (per the `xmp/tests_modes.rs` precedent) instead
// of widening their visibility.
fn model_default() -> AdjustmentModel {
    AdjustmentModel::default()
}

fn fresh_img(value: [f32; 3]) -> Image {
    let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = value;
    }
    img
}

/// Run the stage on a neutral pixel and return the resulting R channel
/// (R = G = B throughout — the stage scales uniformly).
fn highlights_output(value: f32, h: f32) -> f32 {
    let mut img = fresh_img([value, value, value]);
    let mut m = model_default();
    m.highlights = h;
    apply(&mut img, &m);
    let p = img.pixels[0];
    assert_eq!(p[0], p[1]);
    assert_eq!(p[1], p[2]);
    p[0]
}

// ----------------------------------------------------------------
// Ticket #1081 (PR #1117) carried into the #1103 response: the legacy
// form divided the above-knee excess by h_denom = 1 + 2h, which crosses
// zero at h = -50 — silent identity at exactly -50, ~167× blowups just
// above it, negative RGB below it. The #1103 highlights keeps the
// sign-branched cure: h < 0 expands above the knee by ×(1 + 2|h|)
// (pole-free), composed with the weighted gain 2^(0.7·|h|·w_h).
// ----------------------------------------------------------------

#[test]
fn highlights_no_pole_around_minus_50() {
    // Y = 1.5 across the old pole: finite, positive, smooth, monotonic.
    // Closed form: (1 + 0.5·(1 + 2|h|)) · 2^(0.7·|h|).
    let a = highlights_output(1.5, -49.9);
    let b = highlights_output(1.5, -50.0);
    let c = highlights_output(1.5, -50.1);
    for (h, v) in [(-49.9, a), (-50.0, b), (-50.1, c)] {
        assert!(v.is_finite(), "h={} produced non-finite {}", h, v);
        assert!(v > 0.0, "h={} produced non-positive {}", h, v);
    }
    // No blowup: neighbors stay within 10× of each other (the legacy code
    // jumped from ~167× scale to identity to sign-flipped across this range).
    assert!(
        a / b < 10.0 && b / a < 10.0,
        "jump between -49.9 ({}) and -50 ({})",
        a,
        b
    );
    assert!(
        b / c < 10.0 && c / b < 10.0,
        "jump between -50 ({}) and -50.1 ({})",
        b,
        c
    );
    // Monotonic: more-negative h brightens more.
    assert!(
        c > b && b > a,
        "not monotonic across -50: {} / {} / {}",
        a,
        b,
        c
    );
    // Pin the closed form at the old pole itself.
    let expect_b = (1.0 + 0.5 * 2.0) * (0.7_f32 * 0.5).exp2();
    assert!(
        (b - expect_b).abs() < 1e-4,
        "h=-50 expected {}, got {}",
        expect_b,
        b
    );
}

#[test]
fn highlights_minus_100_expands_per_formula() {
    // Y = 3 at h = -100: shape = 1 + (3−1)·3 = 7, gain = 2^0.7 → ≈ 11.37.
    // The legacy form mapped this pixel to −1 (negative RGB). The
    // expansion stays Y-coupled (not a uniform image-wide factor).
    let out3 = highlights_output(3.0, -100.0);
    let expect3 = 7.0 * (0.7_f32).exp2();
    assert!(
        (out3 - expect3).abs() < 1e-3,
        "Y=3 h=-100 expected {}, got {}",
        expect3,
        out3
    );
    assert!(out3 > 0.0, "RGB must stay positive, got {}", out3);
    let out15 = highlights_output(1.5, -100.0);
    let expect15 = (1.0 + 0.5 * 3.0) * (0.7_f32).exp2();
    assert!(
        (out15 - expect15).abs() < 1e-3,
        "Y=1.5 h=-100 expected {}, got {}",
        expect15,
        out15
    );
    assert!(
        ((out3 / 3.0) - (out15 / 1.5)).abs() > 0.1,
        "expansion scale must depend on Y: {} vs {}",
        out3 / 3.0,
        out15 / 1.5
    );
}

#[test]
fn highlights_monotonic_across_full_slider_range() {
    // Fixed Y = 2 swept across the full documented slider range. The output
    // must be strictly monotonic (decreasing) in h — the legacy code was
    // violently non-monotonic across h = -50 (expansion → identity →
    // sign-flip). Both #1103 factors are decreasing in h: the shape
    // (compress harder / expand less) and the weighted gain 2^(−0.7·h).
    let sweep: &[f32] = &[-100.0, -75.0, -50.0, -25.0, 0.0, 25.0, 50.0, 75.0, 100.0];
    let mut prev: Option<(f32, f32)> = None;
    for &h in sweep {
        let out = highlights_output(2.0, h);
        assert!(
            out.is_finite() && out > 0.0,
            "h={} produced non-finite/non-positive {}",
            h,
            out
        );
        if let Some((ph, pv)) = prev {
            assert!(
                out < pv,
                "output must strictly decrease in h: h={} → {}, h={} → {}",
                ph,
                pv,
                h,
                out
            );
        }
        prev = Some((h, out));
    }
}

#[test]
fn highlights_negative_preserves_hue_above_knee() {
    // Same contract as the positive-branch hue tests: the only operation
    // on RGB is a uniform scalar multiply, so R:G:B ratios survive.
    // [2.0, 1.5, 1.5] → Y ≈ 1.6364 > 1 (the expansion branch fires).
    let cases: &[f32] = &[-25.0, -50.0, -100.0];
    for &h in cases {
        let mut img = fresh_img([2.0, 1.5, 1.5]);
        let mut m = model_default();
        m.highlights = h;
        apply(&mut img, &m);
        let p = img.pixels[0];
        let ratio_rg = p[0] / p[1];
        let ratio_rb = p[0] / p[2];
        assert!(
            (ratio_rg - 4.0 / 3.0).abs() / (4.0 / 3.0) < 0.001,
            "h={} R:G drift {}",
            h,
            ratio_rg
        );
        assert!(
            (ratio_rb - 4.0 / 3.0).abs() / (4.0 / 3.0) < 0.001,
            "h={} R:B drift {}",
            h,
            ratio_rb
        );
        // Direction: negative h brightens above the knee.
        assert!(
            p[0] > 2.0,
            "h={} should expand R above 2.0, got {}",
            h,
            p[0]
        );
        for &c in &p {
            assert!(
                c.is_finite() && c > 0.0,
                "h={} non-finite/non-positive {}",
                h,
                c
            );
        }
    }
}

// ----------------------------------------------------------------
// The tonal detail mask (#1103, spec § 4.2): regional (blurred-luma)
// multiplier in smooth/textured regions, per-pixel at strong edges.
// ----------------------------------------------------------------

/// On a finely-textured patch (ripple ≪ the halo edge threshold) the
/// REGIONAL luma drives the multiplier: every pixel of the patch receives
/// (nearly) the same gain, so local contrast RATIOS survive a strong
/// shadows push instead of the dark phase of the texture being lifted
/// proportionally more (the "muddy shadows" failure).
#[test]
fn mask_texture_patch_receives_uniform_gain() {
    let w = 64usize;
    let h = 64usize;
    let mut img = Image::new(w as u32, h as u32, ColorSpace::SceneLinearRec2020);
    // Mean 0.06 (deep shadow), ±0.02 checkerboard ripple — per-pixel
    // w_s(0.04) vs w_s(0.08) differ a lot; regional w_s(0.06) is shared.
    for y in 0..h {
        for x in 0..w {
            let v = if (x + y) % 2 == 0 { 0.04 } else { 0.08 };
            img.pixels[y * w + x] = [v, v, v];
        }
    }
    let mut m = model_default();
    m.shadows = 100.0;
    apply(&mut img, &m);
    // Interior pixels (away from the border where the shrinking-window
    // blur sees asymmetric context): the applied multiplier must be the
    // REGIONAL one — identical (within float noise) for dark and bright
    // phase pixels.
    let i_dark = 32 * w + 32; // (32+32)%2==0 → 0.04
    let i_brt = 32 * w + 33;
    let m_dark = img.pixels[i_dark][0] / 0.04;
    let m_brt = img.pixels[i_brt][0] / 0.08;
    assert!(
        (m_dark - m_brt).abs() / m_brt < 0.01,
        "texture patch must get a uniform regional gain: dark mult {} vs bright mult {}",
        m_dark,
        m_brt
    );
    // The shared gain matches the regional closed form at the patch mean
    // (Yb ≈ 0.06) — NOT the per-pixel curve at either phase extreme
    // (mult(0.04) ≈ 2.59, mult(0.06) ≈ 2.34, mult(0.08) ≈ 2.05).
    let regional = shadows_mult(0.06, 1.0);
    assert!(
        (m_dark - regional).abs() < 0.08,
        "patch gain {} should track the regional closed form {} at the patch mean",
        m_dark,
        regional
    );
}

/// At a strong edge the halo mask falls back to the per-pixel response:
/// the bright side of a hard shadow boundary must NOT inherit the dark
/// region's lift (that inheritance is exactly what produces halos).
#[test]
fn mask_strong_edge_falls_back_per_pixel() {
    let w = 64usize;
    let h = 16usize;
    let mut img = Image::new(w as u32, h as u32, ColorSpace::SceneLinearRec2020);
    for y in 0..h {
        for x in 0..w {
            let v = if x < w / 2 { 0.01 } else { 0.9 };
            img.pixels[y * w + x] = [v, v, v];
        }
    }
    let mut m = model_default();
    m.shadows = 100.0;
    apply(&mut img, &m);
    // A bright-side pixel adjacent to the edge: per-pixel w_s(0.9) = 0
    // (Y ≥ 0.25), so its multiplier must stay ≈ 1 even though the blurred
    // luma there is well inside the shadows band. Allow a few % for the
    // partial halo transition.
    let i_bright_edge = (h / 2) * w + (w / 2 + 1);
    let mult = img.pixels[i_bright_edge][0] / 0.9;
    assert!(
        (mult - 1.0).abs() < 0.05,
        "bright side of a strong edge must keep its per-pixel response, got mult {}",
        mult
    );
    // Far from the edge both regimes agree with the closed form.
    let i_dark_far = (h / 2) * w + 4;
    let dark_mult = img.pixels[i_dark_far][0] / 0.01;
    assert!(
        dark_mult > 2.0,
        "deep-shadow side must be strongly lifted, got {}",
        dark_mult
    );
}

/// Uniform field: the blur degenerates (Yb == Y), the mix collapses to the
/// per-pixel curve, and the output matches the closed-form predictor —
/// the grey-card contract that keeps `test_grey_adjustments.sh` valid.
#[test]
fn mask_uniform_field_matches_closed_form() {
    for &(s, hgt) in &[
        (100.0_f32, 0.0_f32),
        (-60.0, 0.0),
        (0.0, 70.0),
        (0.0, -70.0),
        (40.0, -30.0),
    ] {
        let w = 16usize;
        let hpx = 16usize;
        let mut img = Image::new(w as u32, hpx as u32, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = [0.12, 0.12, 0.12];
        }
        let mut m = model_default();
        m.shadows = s;
        m.highlights = hgt;
        apply(&mut img, &m);
        // Every pixel identical (flatness) …
        let first = img.pixels[0];
        for (i, p) in img.pixels.iter().enumerate() {
            for c in 0..3 {
                assert!(
                    (p[c] - first[c]).abs() < 1e-6,
                    "s={} h={}: flat field broke at {}: {} vs {}",
                    s,
                    hgt,
                    i,
                    p[c],
                    first[c]
                );
            }
        }
        // … and matching the per-pixel closed form (mask degenerated),
        // composed left-to-right exactly like the stage: highlights sees
        // 0.12, shadows sees the highlights output.
        let h_amount = hgt / 100.0;
        let mut expected = 0.12_f32;
        if hgt.abs() >= 1e-3 {
            expected *= highlights_mult(
                expected,
                h_amount,
                1.0 + 2.0 * h_amount,
                1.0 + 2.0 * h_amount.abs(),
            );
        }
        if s.abs() >= 1e-3 {
            expected *= shadows_mult(expected, s / 100.0);
        }
        assert!(
            (first[0] - expected).abs() < 1e-5,
            "s={} h={}: expected {}, got {}",
            s,
            hgt,
            expected,
            first[0]
        );
    }
}

// ----------------------------------------------------------------
// Resolution-invariant mask radius + the tile-overlap registration.
// ----------------------------------------------------------------

#[test]
fn mask_radius_follows_long_edge_convention() {
    // σ = 15 px at the 2000-px reference long edge; gaussian_blur_plane
    // approximates σ ≈ radius/3, so radius = 3σ = 45 at the reference.
    assert_eq!(sh_mask_blur_radius(2000), 45);
    // Scales linearly with the long edge (12288-px 100 MP frame → ~276).
    assert_eq!(sh_mask_blur_radius(4000), 90);
    assert_eq!(
        sh_mask_blur_radius(12288),
        (3.0_f32 * 15.0 * 12288.0 / 2000.0).round() as usize
    );
    // Tiny inputs never reach radius 0 (the blur primitive treats 0 as
    // identity, which would silently disable the regional mask).
    assert_eq!(sh_mask_blur_radius(1), 1);
}

#[test]
fn mask_reach_registered_for_tile_overlap() {
    // Two cascaded masked steps (highlights, then shadows reading the
    // highlights output) — reaches compound: 2 × blur radius. The #11
    // overlap calculator consumes this.
    assert_eq!(sh_mask_reach_px(2000), 2 * sh_mask_blur_radius(2000));
    assert_eq!(sh_mask_reach_px(12288), 2 * sh_mask_blur_radius(12288));
}
