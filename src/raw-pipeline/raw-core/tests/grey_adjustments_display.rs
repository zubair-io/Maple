//! Display-domain adjustment-validation tests on the synthetic grey DNG:
//! the AgX-internal contrast direction gate plus the position-aware /
//! display-tail stages (vignette #1109, grain #1110, split toning #1111 —
//! tone/zoom design § 10.1–10.3). Split out of the sibling
//! `grey_adjustments.rs` when those landings pushed it over the 600-LOC
//! hard cap (#1170) — pure relocation, assertions unchanged. See spec
//! `.archived-plans/specs/2026-04-28-grey-card-adjustment-tests-design.md`.

#![cfg(feature = "test-support")]

use raw_core::pipeline::{
    develop_scene_linear_from_raw_with_quality, render_from_raw, RenderQuality,
};
use raw_core::test_support::predictions::*;
use raw_core::test_support::synth_dng::SyntheticGreyDng;
use raw_core::xmp::AdjustmentModel;

/// Float tolerance for closed-form scene-linear assertions. Same budget
/// as `grey_invariants.rs` SCENE_LINEAR_EPS — demosaic + matrix-mul drift.
const EPS_SCENE_LINEAR: f32 = 5e-4;

/// 8-bit LSB tolerance for display-encoded neutrality (R=G=B preservation).
const EPS_DISPLAY_LSB: i32 = 2;

/// Synthesise + render through the full production pipeline (incl. AgX),
/// assert per-pixel R=G=B in u8 within EPS_DISPLAY_LSB.
///
/// Duplicate of `grey_adjustments::assert_neutral_display` — integration
/// test targets are separate crates, and duplicating the one tiny shared
/// helper keeps it test-local (per the
/// `scene_tone_controls/tests_brightness.rs` precedent) instead of
/// introducing a shared include module.
fn assert_neutral_display(linear_value: f32, configure: impl FnOnce(&mut AdjustmentModel)) {
    let dng = SyntheticGreyDng {
        linear_value,
        ..Default::default()
    };
    let bytes = dng.write_to_bytes();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("synthetic DNG must decode");

    let mut model = AdjustmentModel::default();
    model.auto_exposure = raw_core::xmp::AutoExposureMode::Off;
    configure(&mut model);
    let (w, h, rgb) = render_from_raw(&raw, &model).expect("full pipeline render must succeed");

    let n = (w * h) as usize;
    for i in 0..n {
        let r = rgb[i * 3] as i32;
        let g = rgb[i * 3 + 1] as i32;
        let b = rgb[i * 3 + 2] as i32;
        assert!(
            (r - g).abs() <= EPS_DISPLAY_LSB,
            "pixel {} |R-G|={} > {} (R={} G={} B={}) at L={}",
            i,
            (r - g).abs(),
            EPS_DISPLAY_LSB,
            r,
            g,
            b,
            linear_value
        );
        assert!(
            (r - b).abs() <= EPS_DISPLAY_LSB,
            "pixel {} |R-B|={} > {} (R={} G={} B={}) at L={}",
            i,
            (r - b).abs(),
            EPS_DISPLAY_LSB,
            r,
            g,
            b,
            linear_value
        );
    }
}

#[test]
fn contrast_plus_creates_s_curve() {
    // Contrast is AgX-internal — assert direction in display-encoded u8.
    // Above-midtone values should brighten; below-midtone should darken.
    //
    // Per #429 the scene-anchor pushes every uniform synthetic scene to
    // 0.18 before AgX, which collapses both L=0.05 and L=0.50 onto the
    // same AgX position and makes the "above/below midtone" framing
    // meaningless. We pin the test against the absolute scene-linear
    // input by setting `auto_exposure = Off`.
    fn render_mean(L: f32, configure: impl FnOnce(&mut AdjustmentModel)) -> u8 {
        let dng = SyntheticGreyDng {
            linear_value: L,
            ..Default::default()
        };
        let bytes = dng.write_to_bytes();
        let raw = raw_core::decode::decode_bytes(&bytes, "dng").unwrap();
        let mut model = AdjustmentModel::default();
        model.auto_exposure = raw_core::xmp::AutoExposureMode::Off;
        configure(&mut model);
        let (w, h, rgb) = render_from_raw(&raw, &model).unwrap();
        let n = (w * h) as usize;
        let s: u32 = (0..n).map(|i| rgb[i * 3] as u32).sum();
        ((s + n as u32 / 2) / n as u32) as u8
    }
    let above_default = render_mean(0.50, |_| {});
    let above_contrast = render_mean(0.50, |m| m.contrast = 50.0);
    let below_default = render_mean(0.05, |_| {});
    let below_contrast = render_mean(0.05, |m| m.contrast = 50.0);
    assert!(
        above_contrast > above_default,
        "contrast+50 at L=0.50 should brighten: {} → {}",
        above_default,
        above_contrast
    );
    assert!(
        below_contrast < below_default,
        "contrast+50 at L=0.05 should darken: {} → {}",
        below_default,
        below_contrast
    );
}

// ---------------------------------------------------------------------------
// Vignette (#1109, tone/zoom design § 10.1) — POSITION-AWARE by design, so
// the flat-field assertion every predictor above leans on is explicitly
// WAIVED for this stage (spec § 10.1). It is replaced by: (a) bit-exact
// centre identity, (b) the corner-attenuation closed form at sampled
// coordinates via `predict_vignette`, and (c) neutrality preservation
// through the display pipeline (a uniform per-pixel scalar cannot split
// R=G=B, flat field or not).
// ---------------------------------------------------------------------------

/// Develop the synthetic grey card to scene-linear with vignette set and
/// every stage AFTER vignette that reacts to spatial gradients disabled
/// (sharpen / NR act on the vignette's radial gradient and would smear the
/// closed form; their flat-field identity only holds on flat fields).
fn develop_grey_with_vignette(
    linear_value: f32,
    amount: f32,
    feather: f32,
) -> raw_core::image::Image {
    let dng = SyntheticGreyDng {
        linear_value,
        ..Default::default()
    };
    let bytes = dng.write_to_bytes();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("synthetic DNG must decode");
    let mut model = AdjustmentModel::default();
    model.auto_exposure = raw_core::xmp::AutoExposureMode::Off;
    model.sharpen_amount = 0.0;
    model.nr_color = 0.0;
    model.vignette_amount = amount;
    model.vignette_feather = feather;
    develop_scene_linear_from_raw_with_quality(&raw, &model, RenderQuality::Full)
        .expect("scene-linear render must succeed")
}

/// (a) Centre identity: the frame centre sits at r = 0, far inside the
/// mask's inner edge, so the gain is exp2(0) = 1.0 — a bit-exact multiply.
/// The centre pixel of the vignette render must EQUAL the centre pixel of
/// the no-vignette render exactly (not merely within tolerance).
#[test]
fn vignette_center_is_bit_exact_identity() {
    let base = develop_grey_with_vignette(0.18, 0.0, 50.0);
    for &(amount, feather) in &[(-100.0_f32, 0.0_f32), (-60.0, 50.0), (80.0, 100.0)] {
        let img = develop_grey_with_vignette(0.18, amount, feather);
        let (w, h) = (img.width, img.height);
        let c = ((h / 2) * w + (w / 2)) as usize;
        assert_eq!(
            img.pixels[c], base.pixels[c],
            "centre pixel must be bit-exact identity at amount={amount} feather={feather}"
        );
    }
}

/// (b) Corner attenuation matches the position-aware closed form: each
/// sampled pixel of the vignette render equals
/// `predict_vignette(base_pixel, x, y, w, h, amount, feather)` where
/// `base_pixel` is the same coordinate of the no-vignette render (the
/// pre-vignette chain is identical, so it cancels exactly).
#[test]
fn vignette_corners_match_predictor_formula() {
    let base = develop_grey_with_vignette(0.18, 0.0, 50.0);
    for &(amount, feather) in &[(-100.0_f32, 0.0_f32), (-60.0, 50.0), (80.0, 100.0)] {
        let img = develop_grey_with_vignette(0.18, amount, feather);
        let (w, h) = (img.width, img.height);
        // Corners + edge midpoints + an in-band diagonal sample.
        let samples = [
            (0u32, 0u32),
            (w - 1, 0),
            (0, h - 1),
            (w - 1, h - 1),
            (w / 2, 0),
            (0, h / 2),
            (w / 8, h / 8),
        ];
        for (x, y) in samples {
            let i = (y * w + x) as usize;
            for c in 0..3 {
                let predicted = predict_vignette(base.pixels[i][c], x, y, w, h, amount, feather);
                assert!(
                    (img.pixels[i][c] - predicted).abs() <= EPS_SCENE_LINEAR,
                    "vignette({amount}, {feather}) at ({x},{y}) chan {c}: got {}, \
                     predicted {predicted}",
                    img.pixels[i][c]
                );
            }
        }
    }
}

/// (b²) The −100 corner attenuation hits the formula's full depth: the
/// 64×64 card's corner radius (~1.39) saturates the mask, so the corner
/// must sit at exactly exp2(−1.5) ≈ 0.354× of the base corner.
#[test]
fn vignette_minus100_corner_full_attenuation() {
    let base = develop_grey_with_vignette(0.18, 0.0, 50.0);
    let img = develop_grey_with_vignette(0.18, -100.0, 50.0);
    let ratio = img.pixels[0][1] / base.pixels[0][1];
    let expected = (-1.5_f32).exp2();
    assert!(
        (ratio - expected).abs() < 1e-4,
        "corner ratio {ratio} != exp2(-1.5) = {expected}"
    );
}

/// (c) Neutrality through the FULL display pipeline: vignette is a uniform
/// per-pixel scalar, so R=G=B survives it even though the field is no
/// longer flat. (The flatness waiver does not waive neutrality.)
#[test]
fn vignette_preserves_neutrality_display() {
    assert_neutral_display(0.18, |m| {
        m.vignette_amount = -80.0;
        m.vignette_feather = 30.0;
    });
    assert_neutral_display(0.18, |m| {
        m.vignette_amount = 60.0;
        m.vignette_feather = 100.0;
    });
}

/// Defaults-identity: vignette amount 0 (any feather) leaves the develop
/// output bit-for-bit identical — the stage must short-circuit.
#[test]
fn vignette_zero_amount_is_bit_identical() {
    let base = develop_grey_with_vignette(0.18, 0.0, 50.0);
    let img = develop_grey_with_vignette(0.18, 0.0, 95.0);
    assert_eq!(
        base.pixels, img.pixels,
        "feather without amount must be a no-op"
    );
}

// ---------------------------------------------------------------------------
// Film grain (#1110, tone/zoom design § 10.2) — runs in the DISPLAY tail
// (post-AgX), deliberately position-dependent. Like vignette, the flat-
// field invariant is WAIVED (spec § 10.2); the develop-level gates are
// mean preservation and neutrality through the full display pipeline,
// plus bit-identity at amount 0. The exact per-pixel + predicted-std
// gates live at the stage level (`stages::grain::tests`) where the
// display-linear domain is directly accessible.
// ---------------------------------------------------------------------------

/// Render the synthetic grey card through the FULL display pipeline with
/// grain set; returns (w, h, u8 RGB).
fn render_grey_with_grain(linear_value: f32, amount: f32, size: f32) -> (u32, u32, Vec<u8>) {
    let dng = SyntheticGreyDng {
        linear_value,
        ..Default::default()
    };
    let bytes = dng.write_to_bytes();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("synthetic DNG must decode");
    let mut model = AdjustmentModel::default();
    model.auto_exposure = raw_core::xmp::AutoExposureMode::Off;
    model.grain_amount = amount;
    model.grain_size = size;
    render_from_raw(&raw, &model).expect("full pipeline render must succeed")
}

/// (a) Mean preservation through the display pipeline: zero-mean noise
/// must not shift the card's average by more than ~half an 8-bit LSB.
/// (The sRGB OETF between the grain injection and the u8 output is
/// locally near-linear, so the zero-mean property survives to first
/// order; 0.5 LSB absorbs the second-order curvature + dither.)
#[test]
fn grain_preserves_mean_display() {
    let (w, h, base) = render_grey_with_grain(0.18, 0.0, 25.0);
    let (_, _, grained) = render_grey_with_grain(0.18, 70.0, 25.0);
    let n = (w * h * 3) as f64;
    let mean_base: f64 = base.iter().map(|&v| v as f64).sum::<f64>() / n;
    let mean_grained: f64 = grained.iter().map(|&v| v as f64).sum::<f64>() / n;
    assert!(
        (mean_base - mean_grained).abs() < 0.5,
        "grain must preserve the mean: base {mean_base}, grained {mean_grained}"
    );
    // Non-vacuous: the grain actually moved pixels.
    let moved = base.iter().zip(&grained).filter(|(a, b)| a != b).count();
    assert!(
        moved > (w * h) as usize / 4,
        "grain at amount 70 must visibly perturb the card ({moved} bytes moved)"
    );
}

/// (b) Neutrality: monochromatic noise (same n on all channels) keeps
/// R=G=B through the whole display pipeline.
#[test]
fn grain_preserves_neutrality_display() {
    assert_neutral_display(0.18, |m| {
        m.grain_amount = 70.0;
        m.grain_size = 30.0;
        m.grain_roughness = 60.0;
    });
}

/// (c) Defaults-identity: amount 0 with non-default size/roughness is a
/// bit-identical no-op (the stage must short-circuit on amount alone).
#[test]
fn grain_zero_amount_is_bit_identical() {
    let (_, _, base) = render_grey_with_grain(0.18, 0.0, 25.0);
    let (_, _, sized) = render_grey_with_grain(0.18, 0.0, 90.0);
    assert_eq!(base, sized, "size without amount must be a no-op");
}

// ---------------------------------------------------------------------------
// Split toning (#1111, tone/zoom design § 10.3) — runs in the DISPLAY tail
// (post-AgX, before grain), deliberately tints neutrals (its job is to
// move grey toward the chosen hues), so the R=G=B NEUTRALITY invariant is
// the thing being intentionally broken at non-zero saturations. The grey
// gates are: (a) exact neutrality preservation at ZERO saturations, (b)
// the engaged tint moves the card in the predicted hue direction with L
// (tone) untouched — via the exact Oklab predictor at the stage level
// (predictions_display.rs), and a direction check through the full
// pipeline here.
// ---------------------------------------------------------------------------

/// Render the grey card with colour grading set.
fn render_grey_with_color_grade(
    linear_value: f32,
    configure: impl FnOnce(&mut AdjustmentModel),
) -> (u32, u32, Vec<u8>) {
    let dng = SyntheticGreyDng {
        linear_value,
        ..Default::default()
    };
    let bytes = dng.write_to_bytes();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("synthetic DNG must decode");
    let mut model = AdjustmentModel::default();
    model.auto_exposure = raw_core::xmp::AutoExposureMode::Off;
    configure(&mut model);
    render_from_raw(&raw, &model).expect("full pipeline render must succeed")
}

/// (a) Zero saturations leave the pipeline bit-identical, whatever the
/// hues and balance say (neutral-preserving gate).
#[test]
fn color_grade_zero_saturation_is_bit_identical() {
    let (_, _, base) = render_grey_with_color_grade(0.18, |_| {});
    let (_, _, hued) = render_grey_with_color_grade(0.18, |m| {
        m.split_tone_shadow_hue = 220.0;
        m.split_tone_highlight_hue = 40.0;
        m.color_grade_midtone_hue = 150.0;
        m.color_grade_global_hue = 310.0;
        m.split_tone_balance = 60.0;
    });
    assert_eq!(
        base, hued,
        "hues/balance without saturation must be a no-op"
    );
}

/// (b) An engaged warm-shadow tint moves a DARK grey card toward red
/// (R > G > B) through the full pipeline, and a cool-highlight tint moves
/// a BRIGHT card toward blue — the zone split works end-to-end.
///
/// The bright card is exposed at +2 EV of mid-grey, which AgX renders to
/// display-linear ~0.48. Under the Oklab-lightness zone axis that lands
/// firmly in the highlight zone; under a display-linear-Y axis it would
/// not, which is exactly why the stage keys on lightness (#275).
#[test]
fn color_grade_tints_in_the_predicted_direction() {
    let warm_shadows = |m: &mut AdjustmentModel| {
        m.split_tone_shadow_hue = 30.0; // Oklab ~red-orange direction
        m.split_tone_shadow_saturation = 80.0;
    };
    let (w, h, dark) = render_grey_with_color_grade(0.05, warm_shadows);
    let n = (w * h) as usize;
    let (mut r, mut g, mut b) = (0f64, 0f64, 0f64);
    for i in 0..n {
        r += dark[i * 3] as f64;
        g += dark[i * 3 + 1] as f64;
        b += dark[i * 3 + 2] as f64;
    }
    assert!(
        r / n as f64 > g / n as f64 && g / n as f64 > b / n as f64,
        "warm shadows on a dark card must order R > G > B (got {r:.1}/{g:.1}/{b:.1})"
    );

    let cool_highlights = |m: &mut AdjustmentModel| {
        m.split_tone_highlight_hue = 250.0; // Oklab ~blue direction
        m.split_tone_highlight_saturation = 80.0;
    };
    let (w2, h2, bright) = render_grey_with_color_grade(0.75, cool_highlights);
    let n2 = (w2 * h2) as usize;
    let (mut r2, mut b2) = (0f64, 0f64);
    for i in 0..n2 {
        r2 += bright[i * 3] as f64;
        b2 += bright[i * 3 + 2] as f64;
    }
    assert!(
        b2 / n2 as f64 > r2 / n2 as f64,
        "cool highlights on a bright card must lift B over R (got R {r2:.1} vs B {b2:.1})"
    );
}

/// (c) The crossover splits: shadow saturation alone must move a DARK
/// card far more than a BRIGHT one (and vice versa is covered by the
/// direction test above).
#[test]
fn color_grade_shadow_tint_fades_with_luminance() {
    let chroma_spread = |lv: f32| {
        let (w, h, px) = render_grey_with_color_grade(lv, |m| {
            m.split_tone_shadow_hue = 30.0;
            m.split_tone_shadow_saturation = 100.0;
        });
        let n = (w * h) as usize;
        let mut spread = 0f64;
        for i in 0..n {
            let r = px[i * 3] as f64;
            let b = px[i * 3 + 2] as f64;
            spread += r - b;
        }
        spread / n as f64
    };
    let dark = chroma_spread(0.04);
    let bright = chroma_spread(0.80);
    assert!(
        dark > bright + 2.0,
        "the shadow tint must concentrate in dark tones: dark spread {dark:.2} vs bright {bright:.2}"
    );
}

/// (d) The MIDTONE wheel — new at #275 — colours a mid-grey card and
/// fades out toward both ends, so the three zones really are three.
#[test]
fn color_grade_midtone_wheel_owns_mid_grey() {
    let spread = |lv: f32| {
        let (w, h, px) = render_grey_with_color_grade(lv, |m| {
            m.color_grade_midtone_hue = 30.0; // warm
            m.color_grade_midtone_saturation = 100.0;
        });
        let n = (w * h) as usize;
        let mut s = 0f64;
        for i in 0..n {
            s += px[i * 3] as f64 - px[i * 3 + 2] as f64;
        }
        s / n as f64
    };
    let mid = spread(0.18);
    let dark = spread(0.01);
    assert!(
        mid > 4.0,
        "the midtone wheel must colour a mid-grey card (R-B spread {mid:.2})"
    );
    assert!(
        dark < 0.5 * mid,
        "the midtone wheel must fade toward black: dark {dark:.2} vs mid {mid:.2}"
    );
}

/// (e) The GLOBAL wheel — also new at #275 — tints every tone, so a dark
/// and a bright card both move, unlike any zone wheel.
#[test]
fn color_grade_global_wheel_tints_every_tone() {
    let spread = |lv: f32| {
        let (w, h, px) = render_grey_with_color_grade(lv, |m| {
            m.color_grade_global_hue = 30.0;
            m.color_grade_global_saturation = 100.0;
        });
        let n = (w * h) as usize;
        let mut s = 0f64;
        for i in 0..n {
            s += px[i * 3] as f64 - px[i * 3 + 2] as f64;
        }
        s / n as f64
    };
    for lv in [0.02f32, 0.18, 1.5] {
        let d = spread(lv);
        assert!(
            d > 2.0,
            "the global wheel must tint a {lv}-linear card too (R-B spread {d:.2})"
        );
    }
}
