//! Perceptual hue-constancy gate (#1625): never skips, synthesises its own
//! input, and needs no fixtures — it belongs to the same always-on family
//! as `grey_invariants.rs` / `color_chart_invariants.rs`.
//!
//! We lean on Oklab as the hue authority in several places — vibrance
//! (`stages/vibrance.rs`), saturation (`stages/saturation.rs`), and both
//! gamut compressors (`color/oklab_gamut.rs`'s Oklab soft-compress, run
//! from both `agx::apply` and `view::encode::rec2020_to_srgb`). Oklab's own
//! hue is not perfectly constant under chroma scaling — most notably blue
//! drifts toward purple as chroma increases, a documented Oklab weakness —
//! and because the same space backs saturation *and* gamut mapping, any
//! blue/purple hue error is systemic rather than local to one stage.
//!
//! `color::oklab_gamut::tests::soft_compress_invariants_across_hue_and_lightness`
//! already gates the isolated gamut-compress function's own hue error at
//! <2° in pure Oklab float math. This gate is the end-to-end companion: it
//! builds a constant-Oklab-hue, constant-lightness chroma ramp
//! (`synthetic_input::chroma_ramp`) at three hues the ticket calls out by
//! name — blue (264°, inside the 240–280° window), magenta (328°), and a
//! saturated red-orange (45°, distinct from the `Skin` axis's desaturated
//! peach at 53°) — plus the two hues the #1627 banding gate already
//! exercises (foliage yellow-green, skin) for free extra coverage, then
//! renders each ramp through the REAL pipeline (view transform, and
//! separately the slider chain with vibrance/saturation pushed to
//! representative non-zero values) and measures how far the RENDERED
//! output's Oklab hue has drifted from the hue the input was built at.
//!
//! Measured baseline (release, this commit): worst drift 1.43° (`Skin`,
//! view-transform-only), comfortably under the ticket's proposed 2° budget
//! — see `MAX_HUE_DRIFT_DEG`. Every case is green, so the Munsell-style
//! correction the ticket floats as a fallback was not needed.

use raw_core::color::oklab::srgb_linear_to_oklab;
use raw_core::pipeline::{render_from_scene_linear, render_from_scene_linear_with_chain};
use raw_core::synthetic_input::{chroma_ramp, RampHue};
use raw_core::view::gamma::srgb_degamma;
use raw_core::xmp::AdjustmentModel;

/// Ceiling on end-to-end Oklab hue drift, in degrees. The ticket (#1625)
/// proposes <= 2°; worst measured today is 1.43° (see module doc). Budgets
/// only ever go down (repo convention, `docs/testing.md`) — tighten this
/// the moment a real fix lands and drops the measured worst case.
const MAX_HUE_DRIFT_DEG: f32 = 2.0;

/// Below this recovered Oklab chroma, the 8-bit dithered quantization the
/// render path ends on makes the hue *angle* numerically noisy — a $\pm$0.5
/// LSB dither offset on a near-neutral pixel swings `atan2(b, a)` by tens
/// of degrees despite the pixel being visually indistinguishable from
/// neutral. `soft_compress_invariants_across_hue_and_lightness` (pure
/// float Oklab, no quantization) uses a 2e-3 floor for the same reason;
/// ours is larger because it is measured after a real 8-bit round trip.
const MIN_MEASURABLE_CHROMA: f32 = 0.03;

/// Width of the synthetic chroma ramp. 64 columns gives ~14 measurable
/// samples per hue past the noise floor without wasting cycles — this
/// gate runs in milliseconds and should stay that way.
const RAMP_WIDTH: u32 = 64;

const HUES: [RampHue; 5] = [
    RampHue::Blue,
    RampHue::Magenta,
    RampHue::Orange,
    RampHue::FoliageYellowGreen,
    RampHue::Skin,
];

/// One measured (chroma-fraction, hue-drift-degrees) sample past the
/// near-neutral noise floor.
struct Sample {
    chroma_frac: f32,
    drift_deg: f32,
}

/// Decode the render path's dithered 8-bit sRGB output back to Oklab and
/// measure hue drift, per ramp column, against the hue the input was
/// built at. Skips columns whose recovered chroma is below
/// `MIN_MEASURABLE_CHROMA`.
fn measure_drift(hue: RampHue, bytes: &[u8], width: u32) -> Vec<Sample> {
    let (hue_deg, _l) = hue.hue_and_lightness();
    let mut out = Vec::new();
    for x in 0..width as usize {
        let i = x * 3;
        let lin = [
            srgb_degamma(bytes[i] as f32 / 255.0),
            srgb_degamma(bytes[i + 1] as f32 / 255.0),
            srgb_degamma(bytes[i + 2] as f32 / 255.0),
        ];
        let lab = srgb_linear_to_oklab(lin);
        let c_out = (lab[1] * lab[1] + lab[2] * lab[2]).sqrt();
        if c_out < MIN_MEASURABLE_CHROMA {
            continue;
        }
        let out_hue = lab[2].atan2(lab[1]).to_degrees();
        let mut drift = out_hue - hue_deg;
        while drift > 180.0 {
            drift -= 360.0;
        }
        while drift < -180.0 {
            drift += 360.0;
        }
        out.push(Sample {
            chroma_frac: x as f32 / (width - 1) as f32,
            drift_deg: drift,
        });
    }
    out
}

/// Asserts every sample stays within budget and prints the worst one. Rust
/// captures stdout by default, so the `println!` is silent on a green run
/// here — it surfaces on a local `cargo test -- --nocapture` (used to
/// derive `MAX_HUE_DRIFT_DEG` above) and automatically once a case fails,
/// which is when the number is actually needed.
fn assert_within_budget(hue: RampHue, variant: &str, samples: &[Sample]) {
    assert!(
        !samples.is_empty(),
        "{:?}/{variant}: zero samples past the noise floor — ramp or filter is broken",
        hue
    );
    let worst = samples
        .iter()
        .max_by(|a, b| a.drift_deg.abs().total_cmp(&b.drift_deg.abs()))
        .expect("non-empty");
    println!(
        "hue_constancy {:?}/{variant}: worst drift {:.3}deg at chroma_frac={:.3} (budget {:.1}deg)",
        hue, worst.drift_deg, worst.chroma_frac, MAX_HUE_DRIFT_DEG
    );
    for s in samples {
        assert!(
            s.drift_deg.abs() <= MAX_HUE_DRIFT_DEG,
            "{:?}/{variant}: hue drift {:.3}deg at chroma_frac={:.3} exceeds budget {:.1}deg",
            hue,
            s.drift_deg,
            s.chroma_frac,
            MAX_HUE_DRIFT_DEG
        );
    }
}

/// View-transform-only leg: AgX + the Rec.2020->sRGB gamut compressor,
/// nothing else — isolates the two Oklab gamut compressors the ticket
/// names, with vibrance/saturation held at their identity default.
fn view_transform_only_case(hue: RampHue) {
    let ramp = chroma_ramp(hue, RAMP_WIDTH, 1);
    let model = AdjustmentModel::default();
    let (w, _h, bytes) =
        render_from_scene_linear(ramp, &model).expect("synthetic render must succeed");
    let samples = measure_drift(hue, &bytes, w);
    assert_within_budget(hue, "view-transform-only", &samples);
}

/// Slider-chain leg: vibrance and saturation pushed to representative
/// non-zero values (matching a real edit, not just the identity
/// short-circuit), through the same AgX + gamut-compress tail.
fn vibrance_saturation_case(hue: RampHue) {
    let ramp = chroma_ramp(hue, RAMP_WIDTH, 1);
    let model = AdjustmentModel {
        vibrance: 50.0,
        saturation: 30.0,
        ..AdjustmentModel::default()
    };
    let (w, _h, bytes) = render_from_scene_linear_with_chain(ramp, &model)
        .expect("synthetic chain render must succeed");
    let samples = measure_drift(hue, &bytes, w);
    assert_within_budget(hue, "vibrance+saturation", &samples);
}

#[test]
fn blue_hue_constancy_view_transform() {
    view_transform_only_case(RampHue::Blue);
}

#[test]
fn blue_hue_constancy_vibrance_saturation() {
    vibrance_saturation_case(RampHue::Blue);
}

#[test]
fn magenta_hue_constancy_view_transform() {
    view_transform_only_case(RampHue::Magenta);
}

#[test]
fn magenta_hue_constancy_vibrance_saturation() {
    vibrance_saturation_case(RampHue::Magenta);
}

#[test]
fn orange_hue_constancy_view_transform() {
    view_transform_only_case(RampHue::Orange);
}

#[test]
fn orange_hue_constancy_vibrance_saturation() {
    vibrance_saturation_case(RampHue::Orange);
}

#[test]
fn foliage_hue_constancy_view_transform() {
    view_transform_only_case(RampHue::FoliageYellowGreen);
}

#[test]
fn foliage_hue_constancy_vibrance_saturation() {
    vibrance_saturation_case(RampHue::FoliageYellowGreen);
}

#[test]
fn skin_hue_constancy_view_transform() {
    view_transform_only_case(RampHue::Skin);
}

#[test]
fn skin_hue_constancy_vibrance_saturation() {
    vibrance_saturation_case(RampHue::Skin);
}

/// `HUES` must list exactly the hues the dedicated `#[test]` functions
/// above cover — this can't be checked by introspecting the test binary,
/// so it's asserted against an explicit mirror of that list instead.
/// Catches a hue silently falling off (or duplicating on) `HUES` without a
/// matching pair of tests being added or removed above.
#[test]
fn hues_matches_the_dedicated_test_functions_above() {
    let tested = [
        RampHue::Blue,
        RampHue::Magenta,
        RampHue::Orange,
        RampHue::FoliageYellowGreen,
        RampHue::Skin,
    ];
    assert_eq!(
        HUES, tested,
        "HUES no longer matches the per-hue #[test] functions above — update both together"
    );
}
