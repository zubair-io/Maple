//! Unit tests for [`super`] (dark-channel-prior dehaze). Split out of
//! `dehaze.rs` under the 600-LOC file-size budget. Contents moved verbatim.

use super::*;

#[test]
fn dark_channel_of_uniform_is_min_channel() {
    let mut img = Image::new(20, 20, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [0.5, 0.3, 0.8];
    }
    let dc = dark_channel(&img);
    assert!(dc.iter().all(|v| (*v - 0.3).abs() < 1e-5));
}

#[test]
fn dark_channel_single_dark_pixel_spreads_across_neighborhood() {
    let mut img = Image::new(20, 20, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [0.9, 0.9, 0.9];
    }
    img.pixels[10 * 20 + 10] = [0.1, 0.1, 0.1];
    let dc = dark_channel(&img);
    // All pixels within radius 7 of (10,10) should see the dark pixel.
    assert!((dc[10 * 20 + 10] - 0.1).abs() < 1e-5);
    assert!((dc[3 * 20 + 3] - 0.1).abs() < 1e-5);
    // A pixel at (0, 0) — distance 14 — sees 0.9 because 14 > radius 7.
    assert!((dc[0] - 0.9).abs() < 1e-5);
}

#[test]
fn atmospheric_light_picks_brightest_region() {
    let mut img = Image::new(100, 100, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [0.3, 0.3, 0.3];
    }
    for y in 0..10 {
        for x in 0..10 {
            img.pixels[y * 100 + x] = [0.95, 0.94, 0.93];
        }
    }
    let dc = dark_channel(&img);
    let a = atmospheric_light(&img, &dc);
    assert!(a[0] > 0.7, "A[R] = {}", a[0]);
    assert!(a[1] > 0.7);
    assert!(a[2] > 0.7);
}

#[test]
fn transmission_is_high_for_bright_clear_regions() {
    let mut img = Image::new(30, 30, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [1.0, 1.0, 1.0];
    }
    let a = [1.0, 1.0, 1.0];
    let t = transmission(&img, a);
    // t = 1 - 0.95 * 1 = 0.05 for pure-white image with A=(1,1,1).
    assert!(t.iter().all(|v| (*v - 0.05).abs() < 1e-5));
}

#[test]
fn box_blur_of_constant_is_constant() {
    let buf = vec![0.5f32; 40 * 40];
    let out = box_blur(&buf, 40, 40, 5);
    assert!(out.iter().all(|v| (*v - 0.5).abs() < 1e-5));
}

#[test]
fn guided_filter_of_constants_is_constant() {
    let guide = vec![0.5f32; 40 * 40];
    let p = vec![0.7f32; 40 * 40];
    let out = guided_filter(&guide, &p, 40, 40, GuidedOptions { r: 5, eps: 1e-3 });
    assert!(out.iter().all(|v| (*v - 0.7).abs() < 1e-4));
}

#[test]
fn guided_filter_preserves_smooth_transmission() {
    let w = 30;
    let h = 30;
    let mut p = vec![0.0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            p[y * w + x] = 0.3 + 0.4 * (x as f32) / (w as f32);
        }
    }
    let guide = p.clone();
    let out = guided_filter(&guide, &p, w, h, GuidedOptions { r: 8, eps: 1e-3 });
    for y in 10..20 {
        for x in 10..20 {
            let diff = (out[y * w + x] - p[y * w + x]).abs();
            assert!(diff < 0.05, "diff {} at ({},{})", diff, x, y);
        }
    }
}

#[test]
fn dehaze_zero_is_identity() {
    let mut img = Image::new(20, 20, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [0.4, 0.5, 0.6];
    }
    let before = img.pixels.clone();
    apply(&mut img, 0.0);
    for (a, b) in img.pixels.iter().zip(before.iter()) {
        assert_eq!(a, b);
    }
}

#[test]
fn dehaze_negative_uses_forward_haze_model() {
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.pixels[0] = [0.10, 0.20, 0.30];
    let a = [0.80, 0.90, 1.00];

    recover_with_mask(&mut img, -50.0, &[0.40], a, &[0.0]);

    // haze=0.5 maps t=0.4 halfway from identity transmission 1.0:
    // t_haze=0.7, output=I*0.7 + A*0.3.
    let expected = [0.31, 0.41, 0.51];
    for (actual, expected) in img.pixels[0].iter().zip(expected) {
        assert!(
            (actual - expected).abs() < 1e-6,
            "negative dehaze must move toward airlight: {actual} != {expected}"
        );
    }
}

#[test]
fn sky_mask_is_zero_for_hazy_pixels_one_for_sky() {
    // Hazy mid-distance pixel: dc ~ 0.3 → mask 0.
    // Sky pixel: dc ~ 0.85 → mask 1.
    // Transition is smooth.
    let dc = vec![0.30f32, 0.45, 0.50, 0.55, 0.85];
    let raw: Vec<f32> = dc
        .iter()
        .map(|&v| smoothstep(SKY_MASK_LOW, SKY_MASK_HIGH, v))
        .collect();
    assert!(raw[0] < 1e-5, "haze sample should be 0, got {}", raw[0]);
    assert!(
        raw[4] > 1.0 - 1e-5,
        "sky sample should be 1, got {}",
        raw[4]
    );
    // Monotonically non-decreasing.
    for i in 1..raw.len() {
        assert!(
            raw[i] >= raw[i - 1] - 1e-6,
            "smoothstep not monotone at {}: {} -> {}",
            i,
            raw[i - 1],
            raw[i]
        );
    }
    // Mid-band (0.50, the arithmetic midpoint of SKY_MASK_LOW..SKY_MASK_HIGH)
    // is around 0.5.
    assert!(
        (raw[2] - 0.5).abs() < 0.1,
        "midpoint near 0.5, got {}",
        raw[2]
    );
}

#[test]
fn smoothstep_matches_glsl_definition() {
    assert_eq!(smoothstep(0.0, 1.0, -0.5), 0.0);
    assert_eq!(smoothstep(0.0, 1.0, 1.5), 1.0);
    // smoothstep(0, 1, 0.5) = 0.5 by symmetry of 3t² − 2t³ around t=0.5.
    assert!((smoothstep(0.0, 1.0, 0.5) - 0.5).abs() < 1e-6);
}

/// Build the synthetic split scene used by `dehaze_preserves_sky_attacks_haze`
/// and the companion "without mask the test fails" assertion below.
/// Sky on top half, hazy mid-distance content on the bottom half with a
/// low-contrast checker that exercises the DCP path.
///
/// The sky is `0.85` everywhere except a small "specular" patch at `0.97`
/// that pulls the estimated atmospheric light `A` above the sky body.
/// Without that separation `A ≈ sky` and `J = (I − A)/t + A ≈ I` even
/// without the mask, which would make the mask un-testable (Copilot
/// review on PR #316 flagged this).
fn build_sky_haze_scene(w: usize, h: usize) -> Image {
    let mut img = Image::new(w as u32, h as u32, ColorSpace::SceneLinearRec2020);
    for y in 0..h {
        for x in 0..w {
            if y < h / 2 {
                // Sky proxy: every channel high → dark channel is also high.
                img.pixels[y * w + x] = [0.85, 0.85, 0.85];
            } else {
                // Hazy base + low-contrast feature.
                let dark_feature = (x / 6) % 2 == 0 && (y / 6) % 2 == 0;
                let v = if dark_feature { 0.22 } else { 0.30 };
                img.pixels[y * w + x] = [v, v, v];
            }
        }
    }
    // Add a bright "specular" patch in the sky corner so the atmospheric-
    // light estimator A lands distinctly *above* the sky body (0.85).
    // Atmospheric_light picks the top-dc positions and averages the
    // original pixels there. The patch must be larger than the dark-
    // channel neighbourhood (15×15) so its interior pixels have dc =
    // patch brightness rather than being min-filtered down to the
    // surrounding sky level. With a 20×20 patch, the centre cells have
    // 15×15 neighbourhoods fully inside the patch and dc = 0.95 — which
    // sorts above the sky body's dc = 0.85, so A ≈ [0.95, 0.95, 0.95].
    // That gives the sky body a meaningful (I − A) = −0.10 to amplify,
    // which is what makes the no-mask path move the sky.
    for y in 0..20 {
        for x in 0..20 {
            img.pixels[y * w + x] = [0.95, 0.95, 0.95];
        }
    }
    img
}

/// Maximum per-channel relative change between `before` and `after` over
/// the row range `[y0, y1)`.
fn max_rel_change(before: &[[f32; 3]], after: &[[f32; 3]], w: usize, y0: usize, y1: usize) -> f32 {
    let mut max_rel = 0.0f32;
    for y in y0..y1 {
        for x in 0..w {
            let b = before[y * w + x];
            let a = after[y * w + x];
            for c in 0..3 {
                let rel = (a[c] - b[c]).abs() / b[c].max(1e-6);
                if rel > max_rel {
                    max_rel = rel;
                }
            }
        }
    }
    max_rel
}

#[test]
fn dehaze_preserves_sky_attacks_haze() {
    // Synthetic split scene (issue #272): bright "sky" on top, hazy mid-
    // distance content on the bottom. At dehaze=+100 the sky must barely
    // move (< 5% per channel) and the hazy region must change substantially.
    let w = 60usize;
    let h = 60usize;
    let mut img = build_sky_haze_scene(w, h);
    let before = img.pixels.clone();
    apply(&mut img, 100.0);

    // Pure-sky band (top quarter, well clear of the haze boundary): the
    // mask is fully saturated here, so per-channel change must stay under
    // 5%. Boundary rows in the lower-sky band are intentionally excluded —
    // the mask feathers there by design, so the pixels move some
    // (small) amount. The "without mask, sky moves substantially"
    // assertion in `dehaze_without_sky_mask_breaks_sky_preservation`
    // covers the load-bearing claim that the mask is what suppresses
    // movement in the sky.
    let pure_sky_rows = h / 4;
    for y in 0..pure_sky_rows {
        for x in 0..w {
            let b = before[y * w + x];
            let a = img.pixels[y * w + x];
            for c in 0..3 {
                let rel = (a[c] - b[c]).abs() / b[c].max(1e-6);
                assert!(
                    rel < 0.05,
                    "sky pixel ({}, {}) ch{} moved {:.3} → {:.3} (rel {:.3})",
                    x,
                    y,
                    c,
                    b[c],
                    a[c],
                    rel
                );
            }
        }
    }
    // Hazy half: at least one strong-feature pixel must change substantially.
    let haze_max_rel = max_rel_change(&before, &img.pixels, w, h / 2, h);
    assert!(
        haze_max_rel > 0.10,
        "expected dehaze to substantially modify the hazy half, got max rel {:.3}",
        haze_max_rel
    );
}

/// Companion to `dehaze_preserves_sky_attacks_haze`: prove the sky mask is
/// load-bearing. Re-runs the same recovery math but with the mask forced
/// to zero everywhere — the sky-preservation property must FAIL, i.e. the
/// pure-sky band must move by *much* more than the 5%-per-channel
/// ceiling the masked variant enforces. If this assertion ever fires,
/// the masked test is no longer load-bearing evidence that the mask
/// works.
#[test]
fn dehaze_without_sky_mask_breaks_sky_preservation() {
    let w = 60usize;
    let h = 60usize;
    let mut img = build_sky_haze_scene(w, h);
    let before = img.pixels.clone();

    // Run the full recovery pipeline with a zero mask (mask disabled).
    let zero_mask = vec![0.0f32; w * h];
    apply_with_mask_override(&mut img, 100.0, &zero_mask);

    // Check the exact same pure-sky band the masked test asserts on.
    // The masked test requires every pixel-channel here to move < 5%;
    // the no-mask path must blow well past that — we require > 20% to
    // leave headroom and make the contrast unambiguous.
    let pure_sky_rows = h / 4;
    let sky_max_rel = max_rel_change(&before, &img.pixels, w, 0, pure_sky_rows);
    assert!(
        sky_max_rel > 0.20,
        "without the sky mask the sky should move substantially, got max rel {:.3} \
         (if this fires, the masked sky-preservation test is no longer load-bearing \
         evidence that the mask works)",
        sky_max_rel
    );
}

#[test]
fn dehaze_positive_increases_contrast() {
    // A flat hazy field with a slightly darker region should remain finite
    // and within reasonable bounds after dehaze.
    let mut img = Image::new(30, 30, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [0.5, 0.5, 0.5];
    }
    for y in 10..20 {
        for x in 10..20 {
            img.pixels[y * 30 + x] = [0.35, 0.35, 0.35];
        }
    }
    apply(&mut img, 100.0);
    assert!(img.pixels.iter().all(|p| p.iter().all(|v| v.is_finite())));
    let after = img.pixels[10 * 30 + 10][0];
    assert!(after >= 0.0 && after <= 1.5);
}
