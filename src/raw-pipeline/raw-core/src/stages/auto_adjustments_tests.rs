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
