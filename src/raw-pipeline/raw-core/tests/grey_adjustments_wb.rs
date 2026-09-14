//! White-balance (temperature/tint) tests on the synthetic grey DNG. Split
//! out of `grey_adjustments.rs` under the 600-LOC file budget — adding the
//! `whites` display-domain test (#2441) pushed that file over the hard cap,
//! and this WB block was the largest self-contained slice (its own helper,
//! no shared state with the tone-slider predictors). See spec
//! `.archived-plans/specs/2026-04-28-grey-card-adjustment-tests-design.md`.

#![cfg(feature = "test-support")]

use raw_core::pipeline::{develop_scene_linear_from_raw_with_quality, RenderQuality};
use raw_core::test_support::synth_dng::SyntheticGreyDng;
use raw_core::xmp::AdjustmentModel;

/// Develop the synthetic L=0.18 grey to scene-linear with the given
/// adjustments and return a representative pixel (everything is uniform
/// for a flat synthetic input, so any pixel works — we read pixel 32×32).
///
/// The base model pins `temperature_seen = true` / `tint_seen = true` at the
/// 6500K/0 identity WB baseline so non-WB tests are unaffected by the as-shot
/// resolution introduced in #1729. WB tests (`temp_warmer_*`, `tint_*`)
/// override these flags explicitly in their `configure` closure.
fn scene_linear_pixel(configure: impl FnOnce(&mut AdjustmentModel)) -> [f32; 3] {
    let dng = SyntheticGreyDng::default();
    let bytes = dng.write_to_bytes();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").unwrap();
    let mut model = AdjustmentModel::default();
    model.temperature_seen = true;
    model.tint_seen = true;
    configure(&mut model);
    let img =
        develop_scene_linear_from_raw_with_quality(&raw, &model, RenderQuality::Full).unwrap();
    img.pixels[32 * 64 + 32]
}

#[test]
fn temp_warmer_makes_r_gt_b() {
    // temperature_seen = true: the closure explicitly authors the temperature,
    // so the as-shot fallback (#1729) must not override it.
    let p = scene_linear_pixel(|m| {
        m.temperature = 7500.0;
        m.temperature_seen = true;
    });
    assert!(
        p[0] > p[2],
        "temp+1000K should warm: R={} should exceed B={}",
        p[0],
        p[2]
    );
    assert!(
        p[0] > p[1],
        "temp+1000K should warm: R={} should exceed G={}",
        p[0],
        p[1]
    );
}

#[test]
fn temp_cooler_makes_b_gt_r() {
    let p = scene_linear_pixel(|m| {
        m.temperature = 5500.0;
        m.temperature_seen = true;
    });
    assert!(
        p[2] > p[0],
        "temp-1000K should cool: B={} should exceed R={}",
        p[2],
        p[0]
    );
    assert!(
        p[2] > p[1],
        "temp-1000K should cool: B={} should exceed G={}",
        p[2],
        p[1]
    );
}

#[test]
fn temp_symmetric() {
    // |R-B| at +1000K vs -1000K: same order of magnitude. The WB curve
    // is not perfectly linear in K (the cool side produces a larger
    // magnitude shift than the warm side at ±1000K), so we just lock
    // down "no sign flip and no 5x asymmetry" as a regression net.
    let warm = scene_linear_pixel(|m| {
        m.temperature = 7500.0;
        m.temperature_seen = true;
    });
    let cool = scene_linear_pixel(|m| {
        m.temperature = 5500.0;
        m.temperature_seen = true;
    });
    let warm_delta = (warm[0] - warm[2]).abs();
    let cool_delta = (cool[0] - cool[2]).abs();
    let ratio = warm_delta / cool_delta;
    assert!(
        ratio > 0.3 && ratio < 3.0,
        "WB +/-1000K asymmetry: warm |R-B|={}, cool |R-B|={}, ratio={}",
        warm_delta,
        cool_delta,
        ratio
    );
}

/// Tint follows the reference-renderer convention: tint>0 = magenta (R+B grows vs 2G),
/// tint<0 = green (R+B shrinks vs 2G).
///
/// Fixed by ticket #1725: tint is now displaced perpendicular to the
/// Planckian locus in CIE 1960 uv space (the DNG/ACR convention) rather
/// than as a pure +y displacement in CIE xy, which had a temperature-axis
/// component mixed in and inverted the green/magenta direction relative to
/// the reference renderer at the grey harness level.
#[test]
fn tint_plus_pushes_magenta() {
    // tint_seen = true: the closure explicitly authors the tint value, so the
    // as-shot fallback (#1729) must not override it. temperature_seen is
    // already set by scene_linear_pixel's base model (6500K identity).
    let default_p = scene_linear_pixel(|_| {});
    let p = scene_linear_pixel(|m| {
        m.tint = 50.0;
        m.tint_seen = true;
    });
    let default_diff = (default_p[0] + default_p[2]) - 2.0 * default_p[1];
    let tinted_diff = (p[0] + p[2]) - 2.0 * p[1];
    assert!(
        tinted_diff > default_diff,
        "tint+50 should grow R+B vs 2G (reference-renderer convention: magenta): \
         default {} → tinted {}. If this fails, Maple's tint sign is \
         inverted vs the reference renderer — investigate, do not flip the assertion.",
        default_diff,
        tinted_diff
    );
}

#[test]
fn tint_minus_pushes_green() {
    let default_p = scene_linear_pixel(|_| {});
    let p = scene_linear_pixel(|m| {
        m.tint = -50.0;
        m.tint_seen = true;
    });
    let default_diff = (default_p[0] + default_p[2]) - 2.0 * default_p[1];
    let tinted_diff = (p[0] + p[2]) - 2.0 * p[1];
    assert!(
        tinted_diff < default_diff,
        "tint-50 should shrink R+B vs 2G (reference-renderer convention: green): \
         default {} → tinted {}. If this fails, Maple's tint sign is \
         inverted vs the reference renderer — investigate, do not flip the assertion.",
        default_diff,
        tinted_diff
    );
}

/// (#1729 / round-trip fix) ACR anchoring: when tint is explicitly set but
/// temperature is not (`temperature_seen=false, tint_seen=true`), the develop
/// pipeline resolves the missing temperature to 6500 K (D65 — the identity in
/// the post-DCP scene-linear space).
///
/// Rationale: after `apply_pre_gain` + DCP the image is in scene-linear
/// Rec.2020 D65. In that space `white_balance::apply(6500, 0)` is the
/// identity, so "as-shot" ≡ 6500 K. The raw file's `as_shot_cct` is the
/// PHYSICAL shooting-illuminant CCT; using it as the anchor double-applies the
/// CCT correction that DCP already baked in and breaks the round-trip
/// (Custom+Tint=0+no-Temperature must reproduce as-shot exactly).
///
/// We assert that the tint-only render (temperature_seen=false, tint_seen=true)
/// is bit-identical to the explicit 6500 K + same-tint render.
#[test]
fn tint_only_anchors_to_d65_not_as_shot_cct() {
    let dng = raw_core::test_support::synth_dng::SyntheticGreyDng::default();
    let bytes = dng.write_to_bytes();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("synthetic DNG decode");

    // Tint-only render: temperature_seen=false, tint_seen=true.
    let mut model_tint_only = raw_core::xmp::AdjustmentModel::default();
    model_tint_only.auto_exposure = raw_core::xmp::AutoExposureMode::Off;
    model_tint_only.tint = 50.0;
    model_tint_only.tint_seen = true;
    // temperature_seen = false → pipeline anchors to 6500 K (D65 identity).
    let img_tint_only =
        develop_scene_linear_from_raw_with_quality(&raw, &model_tint_only, RenderQuality::Full)
            .expect("scene-linear render");

    // Explicit 6500 K + same tint: temperature_seen=true, tint_seen=true.
    let mut model_6500 = raw_core::xmp::AdjustmentModel::default();
    model_6500.auto_exposure = raw_core::xmp::AutoExposureMode::Off;
    model_6500.temperature = 6500.0;
    model_6500.temperature_seen = true;
    model_6500.tint = 50.0;
    model_6500.tint_seen = true;
    let img_6500 =
        develop_scene_linear_from_raw_with_quality(&raw, &model_6500, RenderQuality::Full)
            .expect("scene-linear render");

    // The two renders must be identical: absent temperature anchors to 6500 K.
    for (i, (a, b)) in img_tint_only
        .pixels
        .iter()
        .zip(img_6500.pixels.iter())
        .enumerate()
    {
        assert_eq!(
            a, b,
            "pixel {i}: tint-only render differs from explicit-6500K render \
             (tint_only={a:?}, 6500={b:?}); absent temperature must anchor to 6500 K (D65)"
        );
    }
}
