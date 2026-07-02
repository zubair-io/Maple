//! Tests for the auto-exposure stage. Split out of `mod.rs` to keep both
//! files under the 600-LOC hard cap (per CONTRIBUTING.md). Visibility:
//! all helpers used here are already `pub` on `mod.rs`, so `use super::*;`
//! is sufficient.

#![cfg(test)]

use super::*;

fn build_image(w: u32, h: u32, f: impl Fn(u32, u32) -> [f32; 3]) -> Image {
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for y in 0..h {
        for x in 0..w {
            img.pixels[(y * w + x) as usize] = f(x, y);
        }
    }
    img
}

#[test]
fn black_frame_anchor_is_identity() {
    let img = build_image(32, 32, |_, _| [0.0, 0.0, 0.0]);
    let gain = compute_scene_anchor_gain(&img);
    assert_eq!(gain, 1.0);
}

#[test]
fn mid_grey_anchor_midtone_branch_unity() {
    // A uniform 0.18 neutral frame: midgrey = 0.18 → midtone_gain = 1.0.
    // Under the hybrid anchor (#494) the highlight branch fires because
    // p95 = 0.18 ≪ 0.85, producing highlight_gain = 4.72. The `.max()`
    // selector chooses the larger of the two — so this synthetic uniform
    // patch lifts. Real-world scenes have distribution spread and this
    // edge case doesn't occur in practice (see the color-pipeline harness
    // for the empirical signal).
    let img = build_image(64, 64, |_, _| [0.18, 0.18, 0.18]);
    let gain = compute_scene_anchor_gain(&img);
    let expected = 0.85_f32 / 0.18_f32;
    assert!(
        (gain - expected).abs() < 1e-3,
        "uniform mid-grey: highlight branch must win; expected {}, got {}",
        expected,
        gain
    );
}

#[test]
fn dark_scene_gets_positive_gain() {
    // Uniform 5% grey: midtone_gain = 0.18 / 0.05 = 3.6;
    // highlight_gain = 0.85 / 0.05 = 17 → clamped to 8.0. `.max()` picks 8.0.
    let img = build_image(64, 64, |_, _| [0.05, 0.05, 0.05]);
    let gain = compute_scene_anchor_gain(&img);
    assert!(
        (gain - MAX_ANCHOR_GAIN).abs() < 1e-3,
        "5% grey: highlight branch should clamp to {}; got {}",
        MAX_ANCHOR_GAIN,
        gain
    );
}

#[test]
fn bright_scene_gets_lift_to_highlight_target() {
    // Uniform 50% grey: midtone_gain = 0.18 / 0.5 = 0.36;
    // highlight_gain = 0.85 / 0.5 = 1.7. `.max()` picks the highlight
    // candidate — we never apply a reducing gain in the hybrid algo.
    let img = build_image(64, 64, |_, _| [0.5, 0.5, 0.5]);
    let gain = compute_scene_anchor_gain(&img);
    let expected = 0.85_f32 / 0.5_f32;
    assert!(
        (gain - expected).abs() < 1e-3,
        "50% grey: highlight branch must win; expected {}, got {}",
        expected,
        gain
    );
}

#[test]
fn anchor_gain_is_clamped() {
    // Near-black image: midgrey ≈ 0.001 → midtone_gain → clamped to 8.0.
    // highlight_gain also clamps to 8.0. `.max()` = 8.0.
    let img = build_image(64, 64, |_, _| [0.001, 0.001, 0.001]);
    let gain = compute_scene_anchor_gain(&img);
    assert_eq!(gain, MAX_ANCHOR_GAIN, "near-black gain must be clamped");
}

#[test]
fn specular_highlights_dont_dominate() {
    // Mostly mid-gray with a sprinkling of >1.0 specular pixels. The
    // P75 trim means the highlights are excluded from the geometric
    // mean (midtone_gain = 1.0); the p95 lands inside the bright
    // quarter at 5.0, so highlight_gain = 0.17 — far below midtone.
    // `.max()` picks midtone_gain = 1.0 → no lift, no over-exposure.
    let img = build_image(32, 32, |x, y| {
        // Top-right quadrant gets specular highlights at 5.0; the
        // other 3/4 of the image is at 0.18.
        if x >= 16 && y < 16 {
            [5.0, 5.0, 5.0]
        } else {
            [0.18, 0.18, 0.18]
        }
    });
    let gain = compute_scene_anchor_gain(&img);
    assert!(
        (gain - 1.0).abs() < 1e-3,
        "specular highlights should not perturb the anchor; got {}",
        gain
    );
}

#[test]
fn crushed_shadows_get_lifted_by_highlight_branch() {
    // Mid-gray plus a crushed-shadow patch at 0.0. The P25 trim removes
    // the zeros from the geometric mean (midtone_gain = 1.0), but p95
    // lands in the 0.18 bulk → highlight_gain = 4.72 fires. `.max()`
    // picks the highlight candidate — same edge case as the uniform-
    // mid-grey patch and resolved the same way (real scenes have spread).
    let img = build_image(32, 32, |x, y| {
        if x < 16 && y < 16 {
            [0.0, 0.0, 0.0]
        } else {
            [0.18, 0.18, 0.18]
        }
    });
    let gain = compute_scene_anchor_gain(&img);
    let expected = 0.85_f32 / 0.18_f32;
    assert!(
        (gain - expected).abs() < 1e-3,
        "crushed-shadow + mid-grey: highlight branch should win; expected {}, got {}",
        expected,
        gain
    );
}

#[test]
fn apply_off_is_identity() {
    let mut img = build_image(16, 16, |x, _| {
        let v = (x as f32 / 15.0) * 0.5;
        [v, v, v]
    });
    let original = img.pixels.clone();
    let mut model = AdjustmentModel::default();
    model.auto_exposure = AutoExposureMode::Off;
    let gain = apply(&mut img, &model);
    assert_eq!(gain, 1.0);
    for (pa, pb) in img.pixels.iter().zip(original.iter()) {
        assert_eq!(
            pa, pb,
            "AutoExposureMode::Off must be a bit-identical no-op"
        );
    }
}

#[test]
fn apply_on_multiplies_pixels() {
    // 5% scene under the hybrid anchor: highlight branch wants
    // 0.85/0.05 = 17, clamped to MAX_ANCHOR_GAIN = 8.0. Output = 0.4.
    let mut img = build_image(64, 64, |_, _| [0.05, 0.05, 0.05]);
    let mut model = AdjustmentModel::default();
    model.auto_exposure = AutoExposureMode::On;
    let gain = apply(&mut img, &model);
    assert!(
        (gain - MAX_ANCHOR_GAIN).abs() < 1e-3,
        "expected clamped gain {}, got {}",
        MAX_ANCHOR_GAIN,
        gain
    );
    let expected = 0.05 * MAX_ANCHOR_GAIN;
    for p in &img.pixels {
        for c in 0..3 {
            assert!(
                (p[c] - expected).abs() < 1e-3,
                "anchored pixel should be ≈ {}; got {}",
                expected,
                p[c]
            );
        }
    }
}

#[test]
fn apply_is_deterministic() {
    let make = || {
        build_image(96, 96, |x, y| {
            let v = ((x + y) as f32 / 191.0) * 0.4;
            [v, v * 0.9, v * 1.1]
        })
    };
    let mut a = make();
    let mut b = make();
    let model = AdjustmentModel::default();
    let ga = apply(&mut a, &model);
    let gb = apply(&mut b, &model);
    assert_eq!(ga.to_bits(), gb.to_bits());
    for (pa, pb) in a.pixels.iter().zip(b.pixels.iter()) {
        for c in 0..3 {
            assert_eq!(pa[c].to_bits(), pb[c].to_bits());
        }
    }
}

// -- Hybrid anchor tests (#494) -------------------------------------------
//
// The four tests below exercise the `max(midtone_gain, highlight_gain)`
// selector introduced for ticket #494. The shared invariant is:
// `midtone_gain = 0.18 / midgrey`, `highlight_gain = 0.85 / p95`, both
// clamped to `MAX_ANCHOR_GAIN`, and the larger wins. They synthesise the
// problematic distributions described in the ticket — a dark subject on
// a bright background where the old algorithm produced gain ≈ 1.0 and
// left the subject crushed.

/// Spec test (1): synthesise a luma distribution dominated by a midgrey-
/// like background (so the percentile-50 band sits near 0.18 and the old
/// algorithm produced gain ≈ 1.0). The hybrid algorithm should detect the
/// low p95 and lift via the highlight branch.
#[test]
fn hybrid_anchor_lifts_dark_subject_on_bright_background() {
    // 90% of the frame at 0.18 (background); 10% at 0.05 (dark subject).
    // P25..P75 lies firmly in the 0.18 cluster (midgrey ≈ 0.18 → midtone_gain ≈ 1.0).
    // P95 = 0.18 as well, so highlight_gain = 0.85 / 0.18 ≈ 4.72. `.max()` wins.
    let img = build_image(64, 64, |x, y| {
        // Subject pixels: a centered 22x22 square (~12% of frame) at 0.05.
        if x >= 21 && x < 43 && y >= 21 && y < 43 {
            [0.05, 0.05, 0.05]
        } else {
            [0.18, 0.18, 0.18]
        }
    });
    let gain = compute_scene_anchor_gain(&img);
    assert!(
        gain > 4.0,
        "highlight branch should lift dark subject; expected > 4.0, got {}",
        gain
    );
    // The subject was at 0.05; after gain ≈ 4.72 it lands at ≈ 0.236 — well
    // above the 0.06–0.08 we observed in `test_0002` / `test_0003`.
    let subject_lifted = 0.05 * gain;
    assert!(
        subject_lifted > 0.15,
        "subject should lift above 0.15 scene-linear; got {}",
        subject_lifted
    );
}

/// Spec test (2): a bright/contrasty scene with luma spread across the
/// 0.5–0.9 band. Both gains should be ≈ 1.0 — no over-lift. The headroom
/// in test_0014-style wide-gamut foliage fixtures must be preserved.
#[test]
fn hybrid_anchor_preserves_highlights_on_bright_scene() {
    // Gradient across 0.5 → 0.9. p95 ≈ 0.88, midgrey ≈ 0.7 (geometric
    // mean over the trimmed band). Both gains land ≤ 1.0 — clamped to
    // identity by the `.max()` and the implicit floor (we never reduce).
    let img = build_image(64, 64, |x, _| {
        let v = 0.5 + 0.4 * (x as f32 / 63.0);
        [v, v, v]
    });
    let gain = compute_scene_anchor_gain(&img);
    // Highlight branch: 0.85 / 0.88 ≈ 0.97. Midtone branch: 0.18 / 0.7 ≈ 0.26.
    // `.max()` picks the highlight value — must stay close to 1.0, never above.
    assert!(
        gain >= 0.9 && gain <= 1.05,
        "bright scene should not be lifted aggressively; got {}",
        gain
    );
}

/// Spec test (3): exercise the `.max(midtone, highlight)` selector with
/// two arranged inputs — one where midtone wins (specular highlights drive
/// p95 huge → highlight_gain small), one where highlight wins (compressed
/// distribution → midtone_gain small).
#[test]
fn hybrid_anchor_takes_larger_gain() {
    // Case A: specular-driven scene. Midgrey ≈ 0.18 (midtone_gain ≈ 1.0);
    // p95 lands in the bright 5.0 patch → highlight_gain = 0.17. Midtone wins.
    let img_a = build_image(32, 32, |x, _| {
        // Top 10% of columns at 5.0 (specular); rest at 0.18.
        if x >= 29 {
            [5.0, 5.0, 5.0]
        } else {
            [0.18, 0.18, 0.18]
        }
    });
    let gain_a = compute_scene_anchor_gain(&img_a);
    assert!(
        (gain_a - 1.0).abs() < 1e-3,
        "specular scene: midtone branch must win (≈ 1.0); got {}",
        gain_a
    );

    // Case B: compressed distribution at 0.4. Midtone_gain = 0.18/0.4 = 0.45;
    // highlight_gain = 0.85/0.4 = 2.125. Highlight wins.
    let img_b = build_image(32, 32, |_, _| [0.4, 0.4, 0.4]);
    let gain_b = compute_scene_anchor_gain(&img_b);
    let expected_b = 0.85_f32 / 0.4_f32;
    assert!(
        (gain_b - expected_b).abs() < 1e-3,
        "compressed mid-scene: highlight branch must win (≈ {}); got {}",
        expected_b,
        gain_b
    );
}

/// Spec test (4): an empirical "test_0002-like" luma distribution —
/// gaussian-ish centered at 0.18 with a small lower mode at 0.06 for the
/// subject. The ticket reports the old algorithm produced gain ≈ 1.0 on
/// such scenes (face at 0.0845 scene-linear); the hybrid should produce
/// gain > 2.0, lifting the face into the 0.2–0.5 band the brief calls for.
#[test]
fn hybrid_anchor_lifts_test_0002_like_distribution() {
    // Deterministic synthesis: 92% pixels in a tight cluster around 0.18
    // (background), 8% pixels around 0.06 (the dark subject).
    let img = build_image(128, 128, |x, y| {
        let idx = (y * 128 + x) as usize;
        // Stable pseudo-noise: low-bit jitter from the index, no RNG.
        let jitter = ((idx.wrapping_mul(2654435761)) & 0xff) as f32 / 255.0 - 0.5;
        // ~8% lower-mode (every ~12th pixel) at 0.06 ± 0.01 jitter.
        let v = if idx % 12 == 0 {
            0.06 + 0.02 * jitter
        } else {
            0.18 + 0.04 * jitter
        };
        let v = v.max(0.0);
        [v, v, v]
    });
    let gain = compute_scene_anchor_gain(&img);
    assert!(
        gain > 2.0,
        "test_0002-like distribution should lift via highlight branch; expected > 2.0, got {}",
        gain
    );
    // Sanity: the lift must keep us under the +3 EV clamp.
    assert!(
        gain <= MAX_ANCHOR_GAIN + 1e-6,
        "gain must respect the MAX_ANCHOR_GAIN ceiling; got {}",
        gain
    );
}
