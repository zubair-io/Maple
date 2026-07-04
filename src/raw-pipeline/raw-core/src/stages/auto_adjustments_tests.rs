//! Unit tests for [`super`] (auto-exposure percentile histogram + AWB gray-
//! world). Split out of `auto_adjustments.rs` under the 600-LOC file-size
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

/// Minimal synthetic `RawImage` for AWB fallback tests — no embedded
/// color matrix, so `dcp::profile_for` takes the rawler-fallback tier
/// (synthetic D65→Rec.2020 CM, "never identity"). Same literal shape as
/// `color::dcp::tests::make_raw`.
fn make_raw(as_shot_neutral: [f32; 3]) -> RawImage {
    RawImage {
        width: 1,
        height: 1,
        cfa: crate::image::CfaPattern::Rggb,
        black_level: [0; 4],
        white_level: 1,
        raw_data: vec![0],
        as_shot_neutral,
        as_shot_cct: None,
        camera_make: "Test".into(),
        camera_model: "Test".into(),
        unique_camera_model: None,
        color_matrices: std::collections::HashMap::new(),
        forward_matrices: std::collections::HashMap::new(),
        orientation: crate::image::ExifOrientation::Normal,
        baseline_exposure: 0.0,
        hsm_data: std::collections::HashMap::new(),
        plt: None,
        profile_tone_curve: None,
        profile_gain_table_map: None,
        crop_rect: None,
        iso: 100,
        noise_profile: None,
        opcode_list3: None,
        aperture: None,
        focal_length: None,
    }
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

// ---- AWB tests ----

#[test]
fn awb_pure_grey_returns_near_d65() {
    // A neutral scene (all pixels equal) with D65 probe model should
    // return approximately 6500K / 0 tint.
    let img = flat_image(0.18, 0.18, 0.18);
    // A grey probe has plenty of surviving pixels, so this exercises the
    // real gray-world path (not the AsShotNeutral fallback).
    let raw = make_raw([0.5, 1.0, 0.7]);
    let (temp, tint) = compute_awb(&img, &raw);
    // Neutral probe at D65 should give near-D65 result.
    assert!(
        (temp - 6500.0).abs() < 1500.0,
        "pure-grey should give temperature near 6500K, got {}",
        temp
    );
    assert!(
        tint.abs() < 30.0,
        "pure-grey should give tint near 0, got {}",
        tint
    );
}

#[test]
fn awb_warm_cast_gives_lower_kelvin() {
    // A GENTLE warm (reddish) tint that stays within the chroma gate.
    // R > G = B: chroma saturation = |R - mean| / max = |0.30-0.25|/0.30 = 0.167 < 0.25 ✓
    // After gating, the neutral is dominated by the warm-biased pixels →
    // neutral.R > neutral.B → target_gain_rb = B/R < 1 → LOW CCT (warm source).
    let img = flat_image(0.30, 0.25, 0.20);
    let raw = make_raw([0.5, 1.0, 0.7]);
    let (temp, _tint) = compute_awb(&img, &raw);
    // A gentle warm scene (R>B within gate) → slider CCT < 6500K.
    assert!(temp < 6500.0,
        "gentle-warm-cast scene (R>B, within chroma gate) should give temperature < 6500K, got {}", temp);
}

#[test]
fn awb_saturated_subject_does_not_dominate() {
    // Mix of neutral pixels + very saturated red pixels.
    // After chroma gating, the saturated pixels should be excluded and the
    // estimate should remain near the neutral result.
    let mut img = Image::new(128, 128, ColorSpace::SceneLinearRec2020);
    let pixels = &mut img.pixels;
    // 75% neutral at 0.4
    let neutral_count = (pixels.len() * 3) / 4;
    for px in pixels[..neutral_count].iter_mut() {
        *px = [0.4, 0.4, 0.4];
    }
    // 25% saturated red (R=1.0, G=0.05, B=0.05)
    for px in pixels[neutral_count..].iter_mut() {
        *px = [0.8, 0.05, 0.05];
    }
    let raw = make_raw([0.5, 1.0, 0.7]);
    let (temp, tint) = compute_awb(&img, &raw);
    // The estimate should be near neutral (6500K) because the saturated
    // red pixels are excluded by the chroma gate. Allow ±3000K tolerance
    // since the gray-world estimate from 75% neutral grey pixels can still
    // be pushed somewhat by boundary effects at the gate threshold.
    assert!(
        (temp - 6500.0).abs() < 3000.0,
        "saturated red subject should not dominate: got {} K",
        temp
    );
    assert!(
        tint.abs() < 50.0,
        "saturated red subject should not drag tint: got {}",
        tint
    );
}

#[test]
fn awb_too_few_pixels_falls_back_to_as_shot_neutral() {
    // An image with mostly crushed/clipped pixels → fallback to the
    // camera-matrix-aware as-shot estimate (#1725 — was
    // `neutral_to_temp_tint(as_shot_neutral)` directly, which rails to
    // tint=-100 for camera-native neutrals; see
    // `estimate_cct_tint_from_scene_xyz`'s doc comment for why).
    let mut img = Image::new(16, 16, ColorSpace::SceneLinearRec2020);
    // All pixels are crushed black (below AWB_LUMA_MIN) — none survive the gate.
    for px in &mut img.pixels {
        *px = [0.001, 0.001, 0.001];
    }
    let as_shot_neutral = [0.52_f32, 1.0, 0.68];
    let raw = make_raw(as_shot_neutral);
    let (temp_fallback, tint_fallback) =
        crate::color::dcp::estimate_as_shot_cct_tint(&raw).unwrap();
    let (temp, tint) = compute_awb(&img, &raw);
    // Should match the fallback result exactly.
    assert!(
        (temp - temp_fallback).abs() < 1.0,
        "fallback temp mismatch: got {}, expected {}",
        temp,
        temp_fallback
    );
    assert!(
        (tint - tint_fallback).abs() < 1.0,
        "fallback tint mismatch: got {}, expected {}",
        tint,
        tint_fallback
    );
}
