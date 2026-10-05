//! Synthetic round-trip tests for the M3 WB-offset estimator (#1740).
//!
//! The #1720 validation pattern: fabricate `DisplayPair`s with a KNOWN
//! analytic cast (no RAW decode, no fixtures), run the estimator, assert the
//! recovered gains reproduce the known cast. Held-out behaviour (outliers,
//! clip, disagreement, adversarial inputs) is asserted the same way.

use super::*;
use crate::color::dng_temperature::temp_tint_to_xy;
use crate::view::encode::srgb_gamma;

const CAST: [f32; 3] = [1.1, 1.0, 0.9];

/// One fabricated pair: neutral Maple grey at linear `v`, JPEG carrying
/// `gains` (plus an overall brightness `k`, which the estimator must ignore —
/// brightness belongs to the tonescale, not the WB offset).
fn cast_pair(v: f32, gains: [f32; 3], k: f32) -> DisplayPair {
    let enc = |x: f32| srgb_gamma(x.clamp(0.0, 1.0));
    DisplayPair {
        maple: [enc(v), enc(v), enc(v)],
        jpeg: [enc(k * gains[0] * v), enc(k * v), enc(k * gains[2] * v)],
    }
}

/// Neutral ramp of `n` pairs under `gains`, spanning linear 0.02..0.70 —
/// safely inside the clip guard (even at 1.2x brightness under the test
/// cast) and the linear floor at both ends.
fn cast_ramp(n: usize, gains: [f32; 3], k: f32) -> Vec<DisplayPair> {
    (0..n)
        .map(|i| {
            let v = 0.02 + 0.68 * i as f32 / (n - 1).max(1) as f32;
            cast_pair(v, gains, k)
        })
        .collect()
}

fn assert_gains_close(est: &WbEstimate, expected: [f32; 3], tol: f32) {
    for c in 0..3 {
        assert!(
            (est.gains[c] - expected[c]).abs() <= tol,
            "channel {c}: got {:.5}, want {:.5} (tol {tol})",
            est.gains[c],
            expected[c]
        );
    }
}

#[test]
fn recovers_known_cast_and_ignores_brightness() {
    let est = estimate_illuminant_gains(&cast_ramp(2000, CAST, 1.2));
    assert!(est.confident);
    assert_eq!(est.pairs_used, 2000);
    assert_eq!(est.pairs_total, 2000);
    assert_gains_close(&est, CAST, 1e-3);
}

#[test]
fn recovers_cast_under_quantization_like_noise() {
    // Deterministic ±1% multiplicative noise (sin phases, no RNG): the JPEG
    // side of a real frame is 8-bit quantized, so the median must absorb it.
    let noisy: Vec<DisplayPair> = (0..2000)
        .map(|i| {
            let v = 0.02 + 0.68 * i as f32 / 1999.0;
            let wobble = |c: usize| 1.0 + 0.01 * ((i * 7 + c * 131) as f32).sin();
            let enc = |x: f32| srgb_gamma(x.clamp(0.0, 1.0));
            DisplayPair {
                maple: [enc(v), enc(v), enc(v)],
                jpeg: [
                    enc(CAST[0] * v * wobble(0)),
                    enc(v * wobble(1)),
                    enc(CAST[2] * v * wobble(2)),
                ],
            }
        })
        .collect();
    let est = estimate_illuminant_gains(&noisy);
    assert!(est.confident);
    assert_gains_close(&est, CAST, 0.02);
}

#[test]
fn median_ignores_outlier_votes() {
    let mut pairs = cast_ramp(1900, CAST, 1.0);
    // 5% outlier votes: neutral Maple pixels whose JPEG side is a random
    // hue (mis-gated content). The median must not move, and the (p90-p10)
    // spread must still sit inside the cast mass, not the outliers.
    for i in 0..100 {
        let v = 0.1 + 0.6 * i as f32 / 99.0;
        let enc = |x: f32| srgb_gamma(x.clamp(0.0, 1.0));
        pairs.push(DisplayPair {
            maple: [enc(v), enc(v), enc(v)],
            jpeg: [
                enc(v * (0.5 + (i as f32).sin().abs())),
                enc(v * (0.5 + ((i + 50) as f32).sin().abs())),
                enc(v * (0.5 + ((i + 100) as f32).sin().abs())),
            ],
        });
    }
    let est = estimate_illuminant_gains(&pairs);
    assert!(est.confident);
    assert_gains_close(&est, CAST, 0.02);
}

#[test]
fn cast_free_frame_reports_near_d65() {
    let est = estimate_illuminant_gains(&cast_ramp(2000, [1.0, 1.0, 1.0], 1.0));
    assert!(est.confident);
    assert_gains_close(&est, [1.0, 1.0, 1.0], 1e-3);
    assert!(
        (6300.0..=6700.0).contains(&est.temperature_k),
        "temp {}",
        est.temperature_k
    );
    // The Robertson locus sits ~10 tint units off CIE D65, so a faithfully
    // measured cast-free frame reads ≈ +10 — that offset is the DNG SDK's
    // own math (shared with the slider frame, so the numbers stay
    // comparable), NOT estimator error. The decayed anchor stays exactly
    // (6500, 0): it means "no data", not "D65 measured".
    assert!(est.tint.abs() <= 12.0, "tint {}", est.tint);
}

#[test]
fn temp_tint_round_trips_through_xy() {
    let est = estimate_illuminant_gains(&cast_ramp(2000, CAST, 1.0));
    assert!(est.confident);
    let (x0, y0) = gains_to_xy(est.gains);
    let (x1, y1) = temp_tint_to_xy(est.temperature_k, est.tint);
    assert!((x1 - x0).abs() < 1e-3, "x: {x1} vs {x0}");
    assert!((y1 - y0).abs() < 1e-3, "y: {y1} vs {y0}");
}

#[test]
fn gains_to_xy_pins_d65() {
    let (x, y) = gains_to_xy([1.0, 1.0, 1.0]);
    assert!((x - 0.3127).abs() < 1e-4, "x: {x}");
    assert!((y - 0.3290).abs() < 1e-4, "y: {y}");
}

#[test]
fn clipped_scene_decays_to_identity() {
    let blown: Vec<DisplayPair> = (0..500)
        .map(|i| {
            let v = 0.5 + 0.5 * i as f32 / 499.0;
            DisplayPair {
                maple: [v, v, v],
                jpeg: [1.0, 0.5 * v, 0.5 * v],
            }
        })
        .collect();
    let est = estimate_illuminant_gains(&blown);
    assert!(!est.confident);
    assert_eq!(est.pairs_used, 0);
    assert_eq!(est.gains, [1.0, 1.0, 1.0]);
    assert_eq!(est.temperature_k, 6500.0);
    assert_eq!(est.tint, 0.0);
}

#[test]
fn too_few_pairs_decays_to_identity() {
    let est = estimate_illuminant_gains(&cast_ramp(10, CAST, 1.0));
    assert!(!est.confident);
    assert_eq!(est.pairs_used, 10);
    assert_eq!(est.gains, [1.0, 1.0, 1.0]);
    assert_eq!(est.temperature_k, 6500.0);
    assert_eq!(est.tint, 0.0);
}

#[test]
fn disagreeing_population_decays_to_identity() {
    // Two casts half a stop apart on red: the diagonal model is wrong for
    // this frame (luma-dependent tone leaking into ratios), so the spread
    // gate must trip even though every pair votes.
    let mut pairs = cast_ramp(1000, [1.2, 1.0, 0.9], 1.0);
    pairs.extend(cast_ramp(1000, [0.8, 1.0, 1.1], 1.0));
    let est = estimate_illuminant_gains(&pairs);
    assert_eq!(est.pairs_used, 2000);
    assert!(
        est.spread_log2 > MAX_SPREAD_LOG2,
        "spread {}",
        est.spread_log2
    );
    assert!(!est.confident);
    assert_eq!(est.gains, [1.0, 1.0, 1.0]);
}

#[test]
fn railed_gains_decay_to_identity() {
    // A 4.5x red ratio is content or clip, not an illuminant gap between two
    // white-balanced renders: it rails the ±2-stop clamp, and a railed
    // estimate must not present as confident (#1371's lesson). The ramp runs
    // dark (linear ≤ 0.20) so the 4.5x red votes instead of clipping — the
    // decay must come from the rail, not the clip guard.
    let dark: Vec<DisplayPair> = (0..2000)
        .map(|i| {
            let v = 0.02 + 0.18 * i as f32 / 1999.0;
            cast_pair(v, [4.5, 1.0, 1.0], 1.0)
        })
        .collect();
    let est = estimate_illuminant_gains(&dark);
    assert_eq!(est.pairs_used, 2000);
    assert!(!est.confident);
    assert_eq!(est.gains, [1.0, 1.0, 1.0]);
}

#[test]
fn non_finite_pairs_are_skipped() {
    let mut pairs = cast_ramp(1000, CAST, 1.0);
    pairs.push(DisplayPair {
        maple: [f32::NAN, 0.5, 0.5],
        jpeg: [0.5, 0.5, 0.5],
    });
    pairs.push(DisplayPair {
        maple: [0.5, 0.5, 0.5],
        jpeg: [f32::INFINITY, 0.5, 0.5],
    });
    let est = estimate_illuminant_gains(&pairs);
    assert!(est.confident);
    assert_eq!(est.pairs_used, 1000);
    assert_eq!(est.pairs_total, 1002);
    assert!(est.gains.iter().all(|v| v.is_finite()));
    assert!(est.temperature_k.is_finite() && est.tint.is_finite());
}

#[test]
fn estimate_is_deterministic() {
    let pairs = cast_ramp(2000, CAST, 1.0);
    let a = estimate_illuminant_gains(&pairs);
    let b = estimate_illuminant_gains(&pairs);
    assert_eq!(a.gains, b.gains);
    assert_eq!(a.temperature_k, b.temperature_k);
    assert_eq!(a.tint, b.tint);
    assert_eq!(a.to_json(), b.to_json());
}

#[test]
fn json_shape_carries_every_field() {
    let est = estimate_illuminant_gains(&cast_ramp(2000, CAST, 1.0));
    let json = est.to_json();
    for key in [
        "\"gains\"",
        "\"temperature_k\"",
        "\"tint\"",
        "\"pairs_used\":2000",
        "\"pairs_total\":2000",
        "\"spread_log2\"",
        "\"confident\":true",
    ] {
        assert!(json.contains(key), "missing {key} in {json}");
    }
    let decayed = estimate_illuminant_gains(&[]);
    assert!(decayed.to_json().contains("\"confident\":false"));
    assert!(decayed
        .to_json()
        .contains("\"gains\":[1.0000,1.0000,1.0000]"));
}
