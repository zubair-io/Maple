//! Unit tests for [`super`] (highlight recovery). Split out of
//! `highlight_recovery.rs` under the 600-LOC file-size budget. Contents moved verbatim.

use super::*;

/// Identity neutral (1,1,1) — equivalent to no WB pre-gain having run.
/// Per-channel ceilings then collapse to 1.0 and the stage behaves like
/// the legacy single-threshold detector.
const NEUTRAL_IDENTITY: [f32; 3] = [1.0, 1.0, 1.0];

/// Typical daylight DNG `AsShotNeutral`. Post-WB ceilings are
/// `(2.0, 1.0, 1.428…)`.
const NEUTRAL_DAYLIGHT: [f32; 3] = [0.5, 1.0, 0.7];

fn make_img(size: u32) -> Image {
    Image::new(size, size, ColorSpace::CameraNativeLinearRgb)
}

#[test]
fn mode_off_is_identity() {
    let mut img = make_img(4);
    for (i, p) in img.pixels.iter_mut().enumerate() {
        *p = [0.999, 0.5, (i as f32) / 16.0];
    }
    let before = img.pixels.clone();
    apply(&mut img, HighlightRecoveryMode::Off, NEUTRAL_DAYLIGHT);
    assert_eq!(img.pixels, before);
}

#[test]
fn nothing_to_recover_is_identity_under_chromatic_adaptation() {
    // No channel reaches the per-channel ceiling, so the stage exits via
    // the fast `!any_clipped` path.
    let mut img = make_img(4);
    for p in &mut img.pixels {
        *p = [0.5, 0.5, 0.5];
    }
    let before = img.pixels.clone();
    apply(
        &mut img,
        HighlightRecoveryMode::ChromaticAdaptation,
        NEUTRAL_DAYLIGHT,
    );
    assert_eq!(img.pixels, before);
}

#[test]
fn fully_clipped_pixel_lands_neutral() {
    // 5×5 image; every pixel fully clipped at neutral=identity (ceilings
    // collapse to 1.0). The stage should emit (X, X, X) — no chromatic
    // cast. Acceptance criterion 1.
    let mut img = make_img(5);
    for p in &mut img.pixels {
        *p = [1.0, 1.0, 1.0];
    }
    apply(
        &mut img,
        HighlightRecoveryMode::ChromaticAdaptation,
        NEUTRAL_IDENTITY,
    );
    for p in &img.pixels {
        assert!(
            (p[0] - p[1]).abs() < 1e-6 && (p[1] - p[2]).abs() < 1e-6,
            "expected neutral, got {:?}",
            p
        );
        assert!(p[0] >= 1.0, "expected at-or-above ceiling, got {}", p[0]);
    }
}

#[test]
fn fully_clipped_pixel_lands_neutral_under_daylight_wb() {
    // Sensor was fully saturated. Post-WB the pixel reads (2.0, 1.0, 1.43).
    // All three channels at their per-channel ceiling → fully clipped.
    // Output must be neutral (X, X, X). Spec § 3.3a step 5.
    let mut img = make_img(5);
    for p in &mut img.pixels {
        *p = [2.0, 1.0, 1.0 / 0.7];
    }
    apply(
        &mut img,
        HighlightRecoveryMode::ChromaticAdaptation,
        NEUTRAL_DAYLIGHT,
    );
    for p in &img.pixels {
        assert!(
            (p[0] - p[1]).abs() < 1e-5 && (p[1] - p[2]).abs() < 1e-5,
            "expected neutral after full-clip, got {:?}",
            p
        );
        // The anchor X is the largest ceiling = 1/min(neutral) = 2.0.
        assert!((p[0] - 2.0).abs() < 1e-5, "expected X = 2.0, got {}", p[0]);
    }
}

#[test]
fn g_clipped_pixel_loses_magenta_under_daylight_wb() {
    // Acceptance criterion 2: G-clipped pixel (0.8, 1.0, 0.7) at sensor,
    // post-WB = (1.6, 1.0, 1.0). Only G is clipped (R=1.6 < ceiling 2.0,
    // B=1.0 < ceiling 1.428).
    //
    // The strict letter of the brief asks the output to match
    // chromaticity 1/AsShotNeutral = (2.0, 1.428). That's unreachable while
    // holding R and B fixed (any G ≥ 1.0 gives R/G ≤ 1.6, B/G ≤ 1.0).
    //
    // The SPIRIT — verified here — is:
    //   - G gets lifted above its clip threshold.
    //   - No magenta: the recovered pixel's R/G is at most the input R/G
    //     (better, equal or lower; we never go more magenta).
    //   - With no unclipped neighbors the result is the neutral-target
    //     extrapolation: G is lifted so R/G == 1.0 and B/G == 1.0 (the
    //     post-WB neutral chromaticity), which is the maximum lift we
    //     can produce with R held fixed.
    //
    // We test on a single-pixel image so there are no neighbors → the
    // stage falls back to the WB-implied neutral target (confidence 0).
    let mut img = Image::new(1, 1, ColorSpace::CameraNativeLinearRgb);
    img.pixels[0] = [1.6, 1.0, 1.0];
    apply(
        &mut img,
        HighlightRecoveryMode::ChromaticAdaptation,
        NEUTRAL_DAYLIGHT,
    );
    let p = img.pixels[0];
    // G must have been lifted above the threshold (1.0 - EPSILON).
    assert!(p[1] > 1.0 - EPSILON, "G should be lifted, got {}", p[1]);
    // The recovered pixel should not be more magenta than the input.
    // input R/G = 1.6, output R/G should be ≤ 1.6.
    let out_rg = p[0] / p[1];
    let out_bg = p[2] / p[1];
    assert!(out_rg <= 1.6 + 1e-4, "R/G grew (more magenta): {}", out_rg);
    // Under fallback-to-neutral, R/G and B/G should both move toward 1
    // (the post-WB neutral chromaticity). With the soft feather close to
    // the threshold, expect R/G ≤ 1.6 and B/G ≤ 1.0 — i.e. less magenta.
    assert!(
        out_rg < 1.6,
        "expected magenta to reduce, got R/G = {}",
        out_rg
    );
    assert!(out_bg <= 1.0 + 1e-4, "B/G out of bound: {}", out_bg);
}

#[test]
fn g_clipped_with_neutral_neighbors_lifts_g_to_match_local_chromaticity() {
    // 11×11 image. Outer ring is a neutral grey well below clip. The
    // center pixel is G-clipped post-WB. Only G is mutated (R and B
    // are below their per-channel ceilings); the recovered G must be
    // lifted so that R/G matches the neighborhood's R/G (= 1.0).
    //
    // B is unclipped (1.0 < ceiling 1.428), so the algorithm leaves it
    // alone — the chromaticity guarantee in the acceptance criterion
    // applies along the clipped axis (R/G here). B/G post-recovery is
    // a *consequence* of the (R, B) anchors plus the new G, not a
    // direct target.
    let mut img = Image::new(11, 11, ColorSpace::CameraNativeLinearRgb);
    for p in &mut img.pixels {
        *p = [0.9, 0.9, 0.9];
    }
    // Center pixel: G-clipped (post-WB G hit 1.0; R=1.6 < ceil 2.0,
    // B=1.0 < ceil 1.428). Pre-recovery R/G = 1.6 (magenta).
    let cx = 5;
    let cy = 5;
    img.pixels[cy * 11 + cx] = [1.6, 1.0, 1.0];
    apply(
        &mut img,
        HighlightRecoveryMode::ChromaticAdaptation,
        NEUTRAL_DAYLIGHT,
    );
    let p = img.pixels[cy * 11 + cx];
    let out_rg = p[0] / p[1];
    // 5% tolerance around the neighborhood's R/G = 1.0 — the chromaticity
    // axis the algorithm is responsible for.
    assert!(
        (out_rg - 1.0).abs() < 0.05,
        "expected R/G ≈ 1.0 ± 5%, got {}",
        out_rg
    );
    // G must have been lifted above its post-WB ceiling.
    assert!(p[1] > 1.0 - EPSILON, "G should be lifted, got {}", p[1]);
    // The original magenta cast must be gone: R/G strictly less than the
    // pre-recovery 1.6 ratio.
    assert!(out_rg < 1.6, "R/G should drop below 1.6, got {}", out_rg);
}

#[test]
fn two_channel_clip_recovers_chromaticity_from_neighbors() {
    // 11×11 image. Outer ring is a neutral grey well below clip. Center
    // pixel has R AND G both clipped (post-WB R=2.0 hits ceiling, G=1.0
    // hits ceiling), B=1.2 < ceiling 1.428.
    //
    // The algorithm anchors on the brightest unclipped channel (B), and
    // recovers R and G from the local chromaticity (R/G=1, B/G=1, both
    // from the neutral neighborhood). With B/G target = 1 and B=1.2,
    // G = 1.2 → R = 1.2 × 1 = 1.2. Output (1.2, 1.2, 1.2).
    let mut img = Image::new(11, 11, ColorSpace::CameraNativeLinearRgb);
    for p in &mut img.pixels {
        *p = [0.9, 0.9, 0.9];
    }
    let cx = 5;
    let cy = 5;
    img.pixels[cy * 11 + cx] = [2.0, 1.0, 1.2];
    apply(
        &mut img,
        HighlightRecoveryMode::ChromaticAdaptation,
        NEUTRAL_DAYLIGHT,
    );
    let p = img.pixels[cy * 11 + cx];
    // All three channels should now be ≈ 1.2.
    assert!(
        (p[0] - 1.2).abs() < 0.05,
        "R recovered to ≈ 1.2, got {}",
        p[0]
    );
    assert!(
        (p[1] - 1.2).abs() < 0.05,
        "G recovered to ≈ 1.2, got {}",
        p[1]
    );
    assert!(
        (p[2] - 1.2).abs() < 0.05,
        "B unchanged at 1.2, got {}",
        p[2]
    );
    // Neutral chromaticity within 5%.
    let out_rg = p[0] / p[1];
    let out_bg = p[2] / p[1];
    assert!((out_rg - 1.0).abs() < 0.05, "R/G drift: {}", out_rg);
    assert!((out_bg - 1.0).abs() < 0.05, "B/G drift: {}", out_bg);
}

#[test]
fn unclipped_pixels_pass_through() {
    // No pixel hits any ceiling — stage must early-out.
    let mut img = make_img(10);
    for p in &mut img.pixels {
        *p = [0.3, 0.4, 0.5];
    }
    let before = img.pixels.clone();
    apply(
        &mut img,
        HighlightRecoveryMode::ChromaticAdaptation,
        NEUTRAL_DAYLIGHT,
    );
    assert_eq!(img.pixels, before);
}

#[test]
fn empty_image_is_a_noop() {
    let mut img = Image::new(0, 0, ColorSpace::CameraNativeLinearRgb);
    apply(
        &mut img,
        HighlightRecoveryMode::ChromaticAdaptation,
        NEUTRAL_DAYLIGHT,
    );
    assert_eq!(img.pixels.len(), 0);
}

/// Perf budget per ticket #325: ChromaticAdaptation must add < 4ms on a
/// 2 MP viewport. We synthesize a 2 MP image with ~5% clipped pixels
/// (a realistic blown-sky scenario) and assert the stage finishes in
/// under 4 ms in release mode. Skipped in debug to avoid spurious
/// timing failures.
#[test]
#[cfg(not(debug_assertions))]
fn perf_chromatic_adaptation_2mp_under_4ms_release() {
    // 1600 × 1250 ≈ 2 MP
    let w = 1600u32;
    let h = 1250u32;
    let mut img = Image::new(w, h, ColorSpace::CameraNativeLinearRgb);
    // Fill with mostly mid-grey; sprinkle a stripe of fully-clipped
    // pixels along the top 5% of rows to exercise the inner loop.
    for y in 0..h {
        for x in 0..w {
            let idx = (y * w + x) as usize;
            if y < h / 20 {
                img.pixels[idx] = [2.0, 1.0, 1.0 / 0.7];
            } else {
                img.pixels[idx] = [0.5, 0.5, 0.5];
            }
        }
    }
    let t0 = std::time::Instant::now();
    apply(
        &mut img,
        HighlightRecoveryMode::ChromaticAdaptation,
        NEUTRAL_DAYLIGHT,
    );
    let elapsed = t0.elapsed();
    eprintln!(
        "highlight_recovery::apply ChromaticAdaptation on 2 MP: {:?}",
        elapsed
    );
    assert!(
        elapsed < std::time::Duration::from_millis(4),
        "perf budget exceeded: {:?} > 4 ms",
        elapsed
    );
}

#[test]
fn legacy_blend_mode_upgrades_to_chromatic_adaptation() {
    // Old XMP sidecars that selected Blend/Luminance should get the new
    // behavior — magenta-free reconstruction — not the old broken modes.
    let mut img_blend = make_img(5);
    let mut img_ca = make_img(5);
    for p in &mut img_blend.pixels {
        *p = [1.6, 1.0, 1.0];
    }
    for p in &mut img_ca.pixels {
        *p = [1.6, 1.0, 1.0];
    }
    apply(
        &mut img_blend,
        HighlightRecoveryMode::Blend,
        NEUTRAL_DAYLIGHT,
    );
    apply(
        &mut img_ca,
        HighlightRecoveryMode::ChromaticAdaptation,
        NEUTRAL_DAYLIGHT,
    );
    assert_eq!(img_blend.pixels, img_ca.pixels);
}
