//! Fixture-tier tests for the AUTO tone calibration (#1376) — the gate M0's
//! synthetic tests could not provide.
//!
//! These run the whole recommendation on the reference RAWs and assert
//! MAGNITUDE and SPREAD, which is precisely what sign-and-clamp testing cannot
//! do. A regression of the M0 kind (blacks at -100 on every frame) fails
//! `no_slider_rails_on_the_reference_fixture_set` on the first fixture.
//!
//! Split from `auto_adjustments_tone_tests.rs` under the 600-LOC file budget.

use super::super::*;
use crate::stages::auto_adjustments::compute_auto_adjustments;
use crate::xmp::AdjustmentModel;

/// The reference fixtures, with the extension each one actually carries.
/// `test_0001.RAW` and `test_0016.X3F` are excluded: the first is a raw
/// sensor dump the decoder does not accept by extension, the second is a
/// Sigma X3F whose develop path is covered elsewhere.
const FIXTURES: &[&str] = &[
    "test_0000.DNG",
    "test_0002.dng",
    "test_0003.CR2",
    "test_0004.fff",
    "test_0005.RAF",
    "test_0006.DNG",
    "test_0007.DNG",
    "test_0008.RAF",
    "test_0009.CR2",
    "test_0010.CR2",
    "test_0011.ARW",
    "test_0012.raf",
    "test_0013.DNG",
    "test_0014.NEF",
    "test_0015.dng",
    "test_0017.dng",
    "test_0018.dng",
    "test_0019.dng",
    "test_0020.dng",
];

fn decode(name: &str) -> crate::image::RawImage {
    let path = crate::test_support::fixtures::require_raw(name);
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {name}: {e}"));
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    crate::decode::decode_bytes(&bytes, ext).unwrap_or_else(|e| panic!("decode {name}: {e}"))
}

fn auto_for(name: &str) -> crate::stages::auto_adjustments::AutoAdjustments {
    compute_auto_adjustments(&decode(name), &AdjustmentModel::default())
        .unwrap_or_else(|e| panic!("auto {name}: {e}"))
}

/// The model AUTO produces with its tone sliders still at rest — the state
/// the tone stage receives, and therefore the state the anchor population
/// must be measured in. `Profile::Neutral` pins the AgX view transform the
/// anchors are defined against, the same pin `test_color_pipeline.sh` uses.
fn auto_base_model(a: &crate::stages::auto_adjustments::AutoAdjustments) -> AdjustmentModel {
    use crate::types::adjustment::{AutoExposureMode, Profile};
    AdjustmentModel {
        profile: Profile::Neutral,
        auto_exposure: AutoExposureMode::Off,
        exposure: a.exposure,
        temperature: a.temperature,
        tint: a.tint,
        ..AdjustmentModel::default()
    }
}

/// Display-code percentiles of a developed model, in anchor order.
fn anchor_row(raw: &crate::image::RawImage, model: &AdjustmentModel, slope: f32) -> [f32; 5] {
    use crate::pipeline::{develop_scene_linear_from_raw_with_quality, RenderQuality};
    let img =
        develop_scene_linear_from_raw_with_quality(raw, model, RenderQuality::Preview).unwrap();
    let h = LogLumaHistogram::build(&img);
    let code = |q: f32| display_code(h.percentile(q).unwrap(), slope);
    [
        code(0.005),
        code(0.10),
        code(0.95),
        code(0.995),
        code(0.75) - code(0.25),
    ]
}

/// ANCHOR PROVENANCE. Re-derives the committed anchor constants from the
/// reference fixture set and asserts they still match.
///
/// The anchors are the population median, per percentile, of where the
/// twenty reference photographs' tones land once AUTO has set exposure and
/// white balance and BEFORE any tone slider moves — see the module doc.
/// Measuring in any other state (Maple's `auto_exposure: On` default
/// render, say) makes the tone sliders silently absorb the level difference
/// between that state and AUTO's, which is how the first cut of this
/// calibration drove `highlights` to its clamp on `test_0000`.
///
/// If the view transform, the exposure heuristic, or the reference set
/// moves, this fails and the constants must be re-derived from the printed
/// table rather than silently targeting a distribution that no longer
/// describes the set.
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn committed_anchors_match_the_reference_population() {
    let mut columns: Vec<[f32; 5]> = Vec::new();
    println!(
        "{:<14}{:>9}{:>9}{:>9}{:>9}{:>10}",
        "fixture", "p0.5", "p10", "p95", "p99.5", "p75-p25"
    );
    for name in FIXTURES {
        let raw = decode(name);
        let a = compute_auto_adjustments(&raw, &AdjustmentModel::default()).unwrap();
        let row = anchor_row(&raw, &auto_base_model(&a), 1.0);
        println!(
            "{:<14}{:>9.4}{:>9.4}{:>9.4}{:>9.4}{:>10.4}",
            name, row[0], row[1], row[2], row[3], row[4]
        );
        columns.push(row);
    }

    let median = |i: usize| {
        let mut v: Vec<f32> = columns.iter().map(|r| r[i]).collect();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v[v.len() / 2]
    };
    let measured = [median(0), median(1), median(2), median(3), median(4)];
    let committed = [
        ANCHOR_P005,
        ANCHOR_P10,
        ANCHOR_P95,
        ANCHOR_P995,
        ANCHOR_MID_SPREAD,
    ];
    println!("measured medians: {measured:?}");
    println!("committed anchors: {committed:?}");

    // The four LEVEL-SENSITIVE endpoints ARE the population median, so they
    // must track it exactly.
    for (i, label) in ["p0.5", "p10", "p95", "p99.5"].iter().enumerate() {
        assert!(
            (measured[i] - committed[i]).abs() < 0.01,
            "{label} anchor drifted: committed {}, reference population now {} \
             — re-derive the constants",
            committed[i],
            measured[i]
        );
    }

    // The midtone-spread anchor is ACR's, not the population's — it must
    // NOT track the population. What it must do is stay CLOSE to it, since
    // that closeness is the whole argument for using ACR's number here: it
    // is what keeps `contrast` corrections small and two-sided rather than
    // a constant push in one direction.
    let spread_gap = (measured[4] - ANCHOR_MID_SPREAD).abs();
    println!("midtone-spread gap to the ACR anchor: {spread_gap:.4}");
    assert!(
        spread_gap < 0.08,
        "the ACR midtone-spread anchor is {ANCHOR_MID_SPREAD} but the reference \
         population now sits at {} (gap {spread_gap:.4}) — too far apart for the \
         level-invariance argument to hold; re-examine before shipping",
        measured[4]
    );
}

/// The per-fixture table the PR quotes, and the reasonableness gate.
///
/// Two assertions, and BOTH are needed to describe "not railed":
///
/// 1. MAGNITUDE — nothing reaches ±`SOFT_LIMIT`. M0 returned −100 on every
///    frame, so this alone fails M0 on the first fixture.
/// 2. SPREAD — no slider may collapse onto one value across the set. This
///    is the assertion sign-and-clamp testing structurally cannot make, and
///    it is what caught the two intermediate versions of this calibration:
///    both produced values comfortably inside the limit, and both handed
///    the SAME number to most of the fixtures because the solve had
///    saturated. A slider that says the same thing about every photograph
///    is not calibrated, whatever its magnitude.
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn no_slider_rails_on_the_reference_fixture_set() {
    /// Minimum standard deviation, in slider units, of each slider's values
    /// across the set. A saturated slider lands near zero here.
    const MIN_SPREAD: f32 = 8.0;

    let mut columns: [Vec<f32>; 5] = Default::default();
    println!(
        "{:<14}{:>8}{:>9}{:>7}{:>10}{:>12}{:>9}{:>8}{:>8}",
        "fixture",
        "exp EV",
        "temp K",
        "tint",
        "contrast",
        "highlights",
        "shadows",
        "whites",
        "blacks"
    );
    let mut contrast_engaged = 0usize;
    let mut worst = (0.0_f32, String::new());
    let mut violations: Vec<String> = Vec::new();
    for name in FIXTURES {
        let a = auto_for(name);
        println!(
            "{:<14}{:>8.2}{:>9.0}{:>7.1}{:>10.1}{:>12.1}{:>9.1}{:>8.1}{:>8.1}",
            name,
            a.exposure,
            a.temperature,
            a.tint,
            a.contrast,
            a.highlights,
            a.shadows,
            a.whites,
            a.blacks
        );
        if a.contrast != 0.0 {
            contrast_engaged += 1;
        }
        for (i, (label, v)) in [
            ("contrast", a.contrast),
            ("highlights", a.highlights),
            ("shadows", a.shadows),
            ("whites", a.whites),
            ("blacks", a.blacks),
        ]
        .into_iter()
        .enumerate()
        {
            assert!(v.is_finite(), "{name}/{label} = {v}");
            if v.abs() >= SOFT_LIMIT {
                violations.push(format!("{name}/{label} = {v:.1}"));
            }
            if v.abs() > worst.0 {
                worst = (v.abs(), format!("{name}/{label}"));
            }
            columns[i].push(v);
        }
    }
    println!(
        "largest magnitude: {:.1} at {}   contrast engaged on {}/{}",
        worst.0,
        worst.1,
        contrast_engaged,
        FIXTURES.len()
    );

    // Collected rather than asserted inline so the whole table always
    // prints — a partial table is useless for re-calibration.
    assert!(
        violations.is_empty(),
        "{} slider value(s) reached the soft limit ±{SOFT_LIMIT}: {}",
        violations.len(),
        violations.join(", ")
    );

    // (2) SPREAD — no slider may say the same thing about every photograph.
    let labels = ["contrast", "highlights", "shadows", "whites", "blacks"];
    for (i, label) in labels.iter().enumerate() {
        let v = &columns[i];
        let mean = v.iter().sum::<f32>() / v.len() as f32;
        let sd = (v.iter().map(|x| (x - mean).powi(2)).sum::<f32>() / v.len() as f32).sqrt();
        println!("{label:<11} mean {mean:>7.1}  sd {sd:>6.1}");
        assert!(
            sd > MIN_SPREAD,
            "{label} varies by only sd {sd:.1} across the set — the solve has \
             collapsed onto one value and the slider carries no information \
             about the scene"
        );
    }

    // The dead 2.5-stop threshold is gone: contrast must actually engage.
    assert!(
        contrast_engaged * 2 > FIXTURES.len(),
        "contrast engaged on only {contrast_engaged}/{} fixtures — the slider is \
         inert again",
        FIXTURES.len()
    );
}

/// The calibration must MOVE the render toward its anchors, not merely
/// keep the numbers small. Renders each sampled fixture twice — exposure +
/// white balance only (what M0 shipped), then with the tone sliders — and
/// compares the summed anchor error.
///
/// This is the assertion that catches the M0 failure mode directly, and the
/// reason a sign-and-clamp test was never enough: `blacks = −100` has the
/// right sign on a milky frame, but it drives the rendered p0.5 far PAST
/// its anchor, so the error grows. Only a test that measures the rendered
/// result can tell the two apart.
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn tone_calibration_moves_the_render_toward_its_anchors() {
    // Sampled subset — spans the set's dynamic-range extremes (test_0011
    // and test_0020 are the widest, test_0018/0019 the flattest) without
    // paying for twenty full develops twice over.
    const SAMPLE: &[&str] = &[
        "test_0000.DNG",
        "test_0009.CR2",
        "test_0011.ARW",
        "test_0014.NEF",
        "test_0017.dng",
        "test_0019.dng",
    ];
    let targets = [
        ANCHOR_P005,
        ANCHOR_P10,
        ANCHOR_P95,
        ANCHOR_P995,
        ANCHOR_MID_SPREAD,
    ];
    let err = |v: [f32; 5]| -> f32 {
        v.iter()
            .zip(targets.iter())
            .map(|(x, t)| (x - t).abs())
            .sum()
    };

    let mut improved = 0usize;
    for name in SAMPLE {
        let raw = decode(name);
        let a = compute_auto_adjustments(&raw, &AdjustmentModel::default()).unwrap();
        let base = auto_base_model(&a);
        let toned = AdjustmentModel {
            contrast: a.contrast,
            highlights: a.highlights,
            shadows: a.shadows,
            whites: a.whites,
            blacks: a.blacks,
            ..base.clone()
        };
        let e_before = err(anchor_row(&raw, &base, 1.0));
        let e_after = err(anchor_row(&raw, &toned, 1.0 + (a.contrast / 100.0) * 0.5));
        println!(
            "{name:<14} anchor error  exposure+WB only {e_before:.4}  \
             with tone {e_after:.4}  ({:+.1}%)",
            100.0 * (e_after - e_before) / e_before.max(1e-6)
        );
        if e_after <= e_before {
            improved += 1;
        }
    }
    assert_eq!(
        improved,
        SAMPLE.len(),
        "tone calibration must not move any sampled fixture AWAY from its \
         anchors ({improved}/{} improved)",
        SAMPLE.len()
    );
}
