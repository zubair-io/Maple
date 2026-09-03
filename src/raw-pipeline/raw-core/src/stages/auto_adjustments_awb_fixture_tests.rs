//! Fixture-tier gate for the auto white balance estimate (#2247) — the
//! assertions the synthetic tests cannot make: that on real photographs the
//! recommendation stays inside its band around the camera's reading, moves
//! toward ACR's Auto rather than away from it, carries information (it is
//! not the as-shot reading with extra steps), and is a fixed point of the
//! develop chain it feeds.
//!
//! #2247's failure mode was a tint railed 80 units from the as-shot value
//! on frames that carried no cast at all. Sign-and-clamp testing cannot see
//! that; a per-fixture bound on the distance from the camera's reading can.

use super::*;
use crate::pipeline::{develop_scene_linear_from_raw_with_quality, RenderQuality};
use crate::stages::auto_adjustments::compute_auto_adjustments;
use crate::test_support::fixtures::{decode_raw, REFERENCE_RAWS};
use crate::types::adjustment::AutoExposureMode;

/// ACR's own Auto white balance on the reference set, as `(fixture, K, tint)`
/// in ACR's slider frame — the frame `stages::wb_camera` renders in (#1894).
///
/// PROVENANCE. ACR writes only `crs:WhiteBalance="Auto"` into the
/// `wb_auto.xmp` sidecars, never the pair it resolved, so the numbers are
/// recovered from the renders: `src/scripts/fit_acr_auto_wb.py` renders each
/// fixture at a candidate pair (`maple-cli render --profile neutral`), diffs
/// it against `test-fixtures/references/<stem>/down/wb_auto.png` with
/// `compare_images.py`, and Newton-steps temperature on the blue-minus-red
/// bias and tint on the green-minus-mean bias until the three channel
/// biases agree (a pure exposure/tone residual, no cast). Fixtures without
/// a `wb_auto` reference (test_0019, test_0020) and the fixture whose
/// calibration cannot be inverted (test_0004, as-shot rails to +180 tint)
/// are absent. Re-run the script when the reference set changes.
const ACR_AUTO: &[(&str, f32, f32)] = &[
    ("test_0000.DNG", 6536.0, -0.8),
    ("test_0002.dng", 5134.0, -24.6),
    ("test_0003.CR2", 8288.0, -12.3),
    ("test_0005.RAF", 6019.0, 18.3),
    ("test_0006.DNG", 3729.0, 10.4),
    ("test_0007.DNG", 2859.0, 10.7),
    ("test_0008.RAF", 5511.0, 7.9),
    ("test_0009.CR2", 6234.0, 0.4),
    ("test_0010.CR2", 7974.0, 41.0),
    ("test_0011.ARW", 7279.0, 2.6),
    ("test_0012.raf", 6718.0, 6.0),
    ("test_0013.DNG", 7318.0, 5.1),
    ("test_0014.NEF", 7101.0, 15.5),
    ("test_0015.dng", 4466.0, -107.2),
    ("test_0017.dng", 4599.0, 5.5),
    ("test_0018.dng", 5620.0, -1.8),
];

/// Slack on the band assertions: f32 through two reciprocal conversions.
const BAND_SLACK: f32 = 0.5;

/// AUTO's mean mired distance to ACR's Auto must be at most this fraction of
/// the as-shot reading's. Measured 0.65 when the bound was calibrated
/// (28.2 vs 43.3 mired); the headroom absorbs fixture-set churn, not a
/// regression of the estimator.
const ACR_MIRED_RATIO_MAX: f32 = 0.85;

/// AUTO's mean tint distance to ACR's Auto may not exceed the as-shot
/// reading's by more than this. Measured 2.1 units BETTER (10.9 vs 13.0).
const ACR_TINT_SLACK: f32 = 1.0;

/// A move this large (mired) counts as "AUTO said something": at least half
/// the set must clear it, or the estimate has collapsed onto the prior.
const INFORMATIVE_MIRED: f32 = 5.0;

fn mired(k: f32) -> f32 {
    1.0e6 / k
}

struct Row {
    name: &'static str,
    shot: (f32, f32),
    auto: (f32, f32),
}

fn rows() -> Vec<Row> {
    println!(
        "{:<14}{:>10}{:>8}{:>10}{:>8}{:>9}{:>8}",
        "fixture", "shot K", "tint", "auto K", "tint", "Δmired", "Δtint"
    );
    REFERENCE_RAWS
        .iter()
        .map(|name| {
            let raw = decode_raw(name);
            let shot = dcp::estimate_as_shot_cct_tint(&raw).unwrap();
            let a = compute_auto_adjustments(&raw, &AdjustmentModel::default()).unwrap();
            let auto = (a.temperature, a.tint);
            println!(
                "{:<14}{:>10.0}{:>8.1}{:>10.0}{:>8.1}{:>9.1}{:>8.1}",
                name,
                shot.0,
                shot.1,
                auto.0,
                auto.1,
                mired(auto.0) - mired(shot.0),
                auto.1 - shot.1
            );
            assert!(
                auto.0.is_finite() && auto.1.is_finite(),
                "{name}: non-finite recommendation {auto:?}"
            );
            Row { name, shot, auto }
        })
        .collect()
}

/// The per-fixture table the PR quotes, and the band: on every fixture whose
/// as-shot reading is a usable prior, the recommendation sits within
/// `MAX_MIRED_MOVE` / `MAX_TINT_MOVE` of it — the #2247 railing (−83.6
/// against +3.9 on test_0017) is 87 units out.
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn auto_wb_stays_inside_its_band_around_the_camera_reading() {
    let (t_lo, t_hi) = schema_range("temperature");
    let (tint_lo, tint_hi) = schema_range("tint");
    let violations: Vec<String> = rows()
        .iter()
        .filter(|r| (t_lo..=t_hi).contains(&r.shot.0) && (tint_lo..=tint_hi).contains(&r.shot.1))
        .filter(|r| {
            (mired(r.auto.0) - mired(r.shot.0)).abs() > MAX_MIRED_MOVE + BAND_SLACK
                || (r.auto.1 - r.shot.1).abs() > MAX_TINT_MOVE + BAND_SLACK
        })
        .map(|r| format!("{}: auto {:?} vs as-shot {:?}", r.name, r.auto, r.shot))
        .collect();
    assert!(
        violations.is_empty(),
        "{} fixture(s) outside the band (±{MAX_MIRED_MOVE} mired, ±{MAX_TINT_MOVE} tint): {}",
        violations.len(),
        violations.join("; ")
    );
}

/// Calibration against the reference renderer: across the set, AUTO must land
/// closer to ACR's Auto than the as-shot reading does on temperature, and no
/// worse on tint — and it must actually move, on at least half the fixtures.
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn auto_wb_moves_toward_acr_auto_and_carries_information() {
    let rows = rows();
    let acr = |name: &str| {
        ACR_AUTO
            .iter()
            .find(|(n, _, _)| *n == name)
            .map(|(_, k, t)| (*k, *t))
    };
    let scored: Vec<(&Row, (f32, f32))> = rows
        .iter()
        .filter_map(|r| acr(r.name).map(|a| (r, a)))
        .collect();
    assert_eq!(
        scored.len(),
        ACR_AUTO.len(),
        "every ACR_AUTO row must match a fixture"
    );
    let n = scored.len() as f32;
    let mean =
        |f: &dyn Fn(&Row, (f32, f32)) -> f32| scored.iter().map(|(r, a)| f(r, *a)).sum::<f32>() / n;
    let shot_mired = mean(&|r, a| (mired(r.shot.0) - mired(a.0)).abs());
    let auto_mired = mean(&|r, a| (mired(r.auto.0) - mired(a.0)).abs());
    let shot_tint = mean(&|r, a| (r.shot.1 - a.1).abs());
    let auto_tint = mean(&|r, a| (r.auto.1 - a.1).abs());
    println!(
        "distance to ACR Auto — mired: as-shot {shot_mired:.1}, AUTO {auto_mired:.1}; \
         tint: as-shot {shot_tint:.1}, AUTO {auto_tint:.1}"
    );
    assert!(
        auto_mired <= ACR_MIRED_RATIO_MAX * shot_mired,
        "AUTO is not closer to ACR's Auto than the camera's own reading on temperature: \
         {auto_mired:.1} vs {shot_mired:.1} mired (max ratio {ACR_MIRED_RATIO_MAX})"
    );
    assert!(
        auto_tint <= shot_tint + ACR_TINT_SLACK,
        "AUTO's tint moved away from ACR's Auto: {auto_tint:.1} vs as-shot {shot_tint:.1}"
    );
    let informative = rows
        .iter()
        .filter(|r| (mired(r.auto.0) - mired(r.shot.0)).abs() > INFORMATIVE_MIRED)
        .count();
    println!(
        "moved more than {INFORMATIVE_MIRED} mired on {informative}/{} fixtures",
        rows.len()
    );
    assert!(
        informative * 2 >= rows.len(),
        "AUTO moved on only {informative}/{} fixtures — the estimate has collapsed onto the prior",
        rows.len()
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
