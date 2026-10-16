//! Unit tests for [`super`] (auto-exposure percentile histogram; the AWB
//! tests moved to `auto_adjustments_awb_tests.rs` with the estimator, #2247). Split out of `auto_adjustments.rs` under the 600-LOC file-size
//! budget (PR #1730). Contents moved verbatim; same sibling `#[path]` split
//! pattern as `stages/nlm.rs` (`nlm_tests.rs`, #951) and
//! `stages/white_balance.rs` (`white_balance_tests.rs`, #1725).

use super::*;

fn flat_image(r: f32, g: f32, b: f32) -> Image {
    let mut img = Image::new(128, 128, ColorSpace::SceneLinearRec2020);
    for px in &mut img.pixels {
        *px = [r, g, b];
    }
    img
}

fn flat_histogram(luma: f32) -> [u32; HIST_BINS] {
    build_luma_histogram(&flat_image(luma, luma, luma))
}

// ---- Exposure tests ----

#[test]
fn midgray_recommends_zero_exposure() {
    let h = flat_histogram(0.18);
    let ev = compute_exposure(&h);
    assert!(ev.abs() < 0.05, "got {}", ev);
}

#[test]
fn near_correct_exposure_is_left_alone_by_deadband() {
    // A frame already close to mid-gray (median 0.15 → +0.26 EV raw) falls
    // inside the deadband and AUTO leaves it untouched.
    let h = flat_histogram(0.15);
    let ev = compute_exposure(&h);
    assert_eq!(ev, 0.0, "deadband should leave a near-correct frame alone");
}

#[test]
fn dark_scene_recommends_damped_positive_exposure() {
    // 0.045 = 0.18 / 4 → +2.0 EV raw. AUTO applies HALF (a conservative
    // nudge), so ≈ +1.0 EV rather than the full correction.
    let h = flat_histogram(0.045);
    let ev = compute_exposure(&h);
    assert!(
        (ev - 1.0).abs() < 0.15,
        "expected ~+1.0 (damped), got {}",
        ev
    );
}

#[test]
fn exposure_clamped_to_slider_range() {
    let h = flat_histogram(0.0001);
    let ev = compute_exposure(&h);
    assert!(ev <= EXPOSURE_CLAMP_EV, "got {}", ev);
    assert!(ev >= -EXPOSURE_CLAMP_EV, "got {}", ev);
}

#[test]
fn exposure_is_finite_on_pure_black() {
    let h = flat_histogram(0.0);
    let ev = compute_exposure(&h);
    assert!(ev.is_finite(), "got {}", ev);
}

#[test]
fn exposure_protects_highlights_against_median_overdrive() {
    // A dark subject (drags the median down) in front of a bright
    // background near clipping. The median rule alone would brighten
    // ~+1.85 EV and blow the highlights; highlight protection must cap it
    // to a gentle nudge.
    let mut img = Image::new(128, 128, ColorSpace::SceneLinearRec2020);
    let n = img.pixels.len();
    let split = (n * 6) / 10; // 60% dark subject, 40% bright background
    for px in img.pixels[..split].iter_mut() {
        *px = [0.05, 0.05, 0.05];
    }
    for px in img.pixels[split..].iter_mut() {
        *px = [0.82, 0.82, 0.82];
    }
    let h = build_luma_histogram(&img);
    let ev = compute_exposure(&h);
    // Median ≈ 0.05 → naive rule = log2(0.18/0.05) ≈ +1.85 EV. With
    // p99 ≈ 0.82, highlight protection caps at log2(0.92/0.82) ≈ +0.17 EV.
    assert!(ev > 0.0, "should still brighten a little, got {}", ev);
    assert!(
        ev < 0.5,
        "highlight protection must cap the brightening, got {}",
        ev
    );
}

#[test]
fn auto_recommendation_is_independent_of_authored_color_nr() {
    let raw = crate::decode::decode(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/batch-transfer/source.dng"),
    )
    .unwrap();
    let expected = compute_auto_adjustments(
        &raw,
        &AdjustmentModel {
            nr_color: 0.0,
            ..Default::default()
        },
    )
    .unwrap();
    for nr_color in [25.0, 100.0] {
        let authored = AdjustmentModel {
            nr_color,
            ..Default::default()
        };
        let before = authored.clone();
        let actual = compute_auto_adjustments(&raw, &authored).unwrap();
        assert_eq!(authored, before, "analysis mutated authored settings");
        assert_eq!(actual, expected, "color NR changed the Auto recommendation");
        assert_eq!(probe_model(&authored).nr_color, nr_color);
    }
}

/// Population statistics remain stable without color NLM even when an
/// individual 5×5 eyedropper sample would be noisy (#4671).
#[test]
fn auto_population_handles_independent_sensor_read_noise() {
    let dng = crate::test_support::synth_dng::SyntheticGreyDng {
        linear_value: 0.08,
        width: 128,
        height: 128,
        ..Default::default()
    }
    .with_hasselblad_dcp();
    let clean = crate::decode::decode_bytes(&dng.write_to_bytes(), "dng").unwrap();
    let model = AdjustmentModel::default();
    let expected = compute_auto_adjustments(&clean, &model).unwrap();
    let errors: Vec<_> = (1..=12_u32)
        .map(|seed| {
            let mut raw = clean.clone();
            raw.iso = 6400;
            let mut state = seed;
            let mut uniform = || {
                state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                (state as f64 + 0.5) / 4294967296.0
            };
            let sigma = 0.006 * (raw.white_level - raw.black_level[0]) as f64;
            for value in &mut raw.raw_data {
                let normal =
                    (-2.0 * uniform().ln()).sqrt() * (std::f64::consts::TAU * uniform()).cos();
                let noisy = *value as f64 + normal * sigma;
                assert!(noisy > 0.0 && noisy < raw.white_level as f64);
                *value = noisy.round() as u16;
            }
            let actual = compute_auto_adjustments(&raw, &model).unwrap();
            [
                (1e6 / actual.temperature - 1e6 / expected.temperature) as f64,
                (actual.tint - expected.tint) as f64,
            ]
        })
        .collect();
    for channel in 0..2 {
        let rms =
            (errors.iter().map(|e| e[channel].powi(2)).sum::<f64>() / errors.len() as f64).sqrt();
        assert!(
            rms < 1.0,
            "noise RMS in mired/tint channel {channel}: {rms}"
        );
    }
}
