//! Fixture-tier gate for the auto white balance estimate (#2247) — the
//! assertion the synthetic tests cannot make: that the estimate agrees with
//! the camera's own reading on real photographs, and that it is a fixed
//! point of the develop chain it feeds.
//!
//! #2247's failure mode was a tint railed 80 units from the as-shot value
//! on frames that carried no cast at all. Sign-and-clamp testing cannot see
//! that; a per-fixture bound on the distance from the camera's reading can.

use super::*;
use crate::pipeline::{develop_scene_linear_from_raw_with_quality, RenderQuality};
use crate::stages::auto_adjustments::compute_auto_adjustments;
use crate::test_support::fixtures::{decode_raw, REFERENCE_RAWS};
use crate::types::adjustment::AutoExposureMode;

/// Tint may not stray further than this from the camera's as-shot reading.
/// The reference set's own spread (printed by the test) sits well inside;
/// the shipped estimator's −83.6 on test_0017 is 87 units out.
const TINT_TOLERANCE: f32 = 20.0;

/// Temperature band, as |log2(auto / as-shot)| — half a stop of reciprocal
/// CCT either way. ACR's Auto on the same set moves cooler on most frames
/// by less than this.
const CCT_TOLERANCE_LOG2: f32 = 0.5;

/// The per-fixture table the PR quotes, and the agreement gate.
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn auto_wb_agrees_with_the_camera_as_shot_reading_across_the_reference_set() {
    println!(
        "{:<14}{:>10}{:>8}{:>10}{:>8}{:>8}{:>10}",
        "fixture", "shot K", "tint", "auto K", "tint", "Δtint", "log2 ΔK"
    );
    let violations: Vec<String> = REFERENCE_RAWS
        .iter()
        .filter_map(|name| {
            let raw = decode_raw(name);
            let (shot_k, shot_tint) = dcp::estimate_as_shot_cct_tint(&raw).unwrap();
            let a = compute_auto_adjustments(&raw, &AdjustmentModel::default()).unwrap();
            let d_tint = a.tint - shot_tint;
            let d_log2 = (a.temperature / shot_k).log2();
            println!(
                "{:<14}{:>10.0}{:>8.1}{:>10.0}{:>8.1}{:>8.1}{:>10.3}",
                name, shot_k, shot_tint, a.temperature, a.tint, d_tint, d_log2
            );
            assert!(
                a.temperature.is_finite() && a.tint.is_finite(),
                "{name}: non-finite recommendation {a:?}"
            );
            let out_of_band = d_tint.abs() > TINT_TOLERANCE || d_log2.abs() > CCT_TOLERANCE_LOG2;
            out_of_band.then(|| {
                format!(
                    "{name}: auto {:.0} K / {:.1} vs as-shot {shot_k:.0} K / {shot_tint:.1}",
                    a.temperature, a.tint
                )
            })
        })
        .collect();
    assert!(
        violations.is_empty(),
        "{} fixture(s) outside the as-shot agreement band (tint ±{TINT_TOLERANCE}, \
         CCT ±{CCT_TOLERANCE_LOG2} log2): {}",
        violations.len(),
        violations.join("; ")
    );
}

/// The estimate must be a fixed point of the chain it drives: develop at
/// the recommendation, estimate again, get the same pair back. This is the
/// frame-consistency assertion — an estimate solved in a frame the chain
/// does not render in (defect 4 in the module doc) overshoots on the
/// second pass instead of standing still.
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn auto_wb_is_a_fixed_point_of_its_own_recommendation() {
    // Calibrated bodies only: the generic tier (test_0006 is an 8-bit lossy
    // LinearRaw whose WB is a post-DCP CAT16 delta from 6500 K / 0) reads its
    // residual against the probe's own render, so a second pass at the
    // recommendation measures a neutral probe and answers 6500 K / 0 — the
    // right answer for that tier, but not a fixed point of the slider pair.
    const SAMPLE: &[&str] = &[
        "test_0000.DNG",
        "test_0003.CR2",
        "test_0007.DNG",
        "test_0011.ARW",
        "test_0017.dng",
    ];
    for name in SAMPLE {
        let raw = decode_raw(name);
        let first = compute_auto_adjustments(&raw, &AdjustmentModel::default()).unwrap();
        let balanced = AdjustmentModel {
            auto_exposure: AutoExposureMode::Off,
            temperature: first.temperature,
            tint: first.tint,
            temperature_seen: true,
            tint_seen: true,
            ..AdjustmentModel::default()
        };
        let probe =
            develop_scene_linear_from_raw_with_quality(&raw, &balanced, RenderQuality::Preview)
                .unwrap();
        let second = compute_awb(&probe, &raw, &balanced);
        println!(
            "{name:<14} first {:.0} K / {:.1}   re-estimated at that render {:.0} K / {:.1}",
            first.temperature, first.tint, second.0, second.1
        );
        assert!(
            ((second.0 / first.temperature).log2().abs() < 0.03)
                && (second.1 - first.tint).abs() < 1.5,
            "{name}: not a fixed point — first {:?}, second {second:?}",
            (first.temperature, first.tint)
        );
    }
}
