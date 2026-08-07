//! Render-path insertion tests for the `film_look` stage (epic #2683, Task
//! 4). Pipeline-level coverage that threading `Option<&film::FilmLut>`
//! through `render_display_scene` is a hard no-op absent a resolved LUT
//! (regardless of `model.film_look` / `model.film_strength` — the
//! missing-asset -> identity rule a host relies on when it can't resolve a
//! `.mlut` file), and that an identity lattice at full strength reproduces
//! the no-lut render within a tight tolerance.
//!
//! Extracted as its own sibling file per the #482/#772 size-budget
//! convention already used throughout this module tree. `super` is
//! `pipeline::render`.

#![cfg(test)]

use super::*;
use crate::film::FilmLut;
use crate::test_support::synth_chart::SyntheticColorChart;
use crate::test_support::synth_dng::SyntheticGreyDng;

/// Identity lattice: node (r,g,b) stores (r,g,b)/(n-1) — sampling it
/// reproduces the input. Mirrored (not shared) from `film.rs`'s and
/// `stages::film_look`'s own private copies of the same helper — both are
/// private to their module, and `stages::film_look`'s own test module
/// already mirrors rather than shares, so this follows the established
/// pattern for the feature (#2683).
fn identity_lattice(n: usize) -> FilmLut {
    let denom = (n - 1) as f32;
    let mut data = vec![0.0f32; n * n * n * 3];
    for b in 0..n {
        for g in 0..n {
            for r in 0..n {
                let i = ((b * n + g) * n + r) * 3;
                data[i] = r as f32 / denom;
                data[i + 1] = g as f32 / denom;
                data[i + 2] = b as f32 / denom;
            }
        }
    }
    FilmLut { size: n, data }
}

/// A small synthetic Macbeth-chart RAW — 24 varied patches, decoded
/// in-memory (no on-disk fixture, so this test runs unconditionally rather
/// than being `#[cfg_attr(not(feature = "fixtures"), ignore)]`-gated).
fn synthetic_chart_raw() -> RawImage {
    let chart = SyntheticColorChart::default();
    crate::decode::decode_bytes(&chart.write_to_bytes(), "dng")
        .expect("synthetic chart must decode")
}

/// A flat, mid-gray synthetic RAW, decoded in-memory. Deliberately
/// achromatic and comfortably inside [0, 1] in every RGB primary set this
/// pipeline touches — the film_look module's own docs (`stages::film_look`)
/// note the identity lattice only round-trips exactly for IN-GAMUT pixels;
/// an out-of-gamut input is intentionally clamped before the LUT lookup
/// (see `out_of_gamut_input_blends_toward_clamped_film_arm_only` in that
/// module's own tests), which is a property of the stage, not a render-path
/// wiring bug. A flat neutral input keeps this render-path test isolated
/// from that already-covered gamut-clamp behaviour.
fn synthetic_grey_raw() -> RawImage {
    let grey = SyntheticGreyDng::default();
    crate::decode::decode_bytes(&grey.write_to_bytes(), "dng").expect("synthetic grey must decode")
}

/// `film_lut: None` must be byte-identical to the pre-#2683 baseline no
/// matter what `model.film_look` / `model.film_strength` say. A host that
/// can't resolve the LUT asset (missing `.mlut` file, disabled catalog)
/// passes `None` and must get the exact no-look render — not a render that
/// leaked partial film-look state from the XMP fields alone.
#[test]
fn film_lut_none_is_byte_identical_regardless_of_model_fields() {
    let raw = synthetic_chart_raw();
    let default_model = AdjustmentModel::default();
    let model_with_look_fields = AdjustmentModel {
        film_look: "color_negative_kodak_portra_400".to_string(),
        film_strength: 62.0,
        ..AdjustmentModel::default()
    };

    let (w1, h1, bytes1) = render_from_raw_with_quality_source_and_film(
        &raw,
        &default_model,
        RenderQuality::Full,
        None,
        None,
    )
    .expect("baseline render");
    let (w2, h2, bytes2) = render_from_raw_with_quality_source_and_film(
        &raw,
        &model_with_look_fields,
        RenderQuality::Full,
        None,
        None,
    )
    .expect("render with model fields set but lut None");

    assert_eq!((w1, h1), (w2, h2), "dimensions must match");
    assert_eq!(
        bytes1, bytes2,
        "film_lut: None must be byte-identical regardless of model.film_look / \
         model.film_strength (missing-asset -> identity rule)"
    );
}

/// An identity lattice at full strength must reproduce the no-lut render
/// within a tight mean delta. Compared in the display-encoded f32 domain
/// (`render_display_scene`'s return, one step before the `u8` terminal
/// quantize) rather than through the public `u8` entry, so dithering noise
/// can't mask or inflate the signal this test is actually measuring.
#[test]
fn film_lut_identity_lattice_at_full_strength_matches_no_lut_within_mean_delta() {
    let raw = synthetic_grey_raw();
    let no_lut_model = AdjustmentModel::default();
    let lut_model = AdjustmentModel {
        film_look: "identity_test_lattice".to_string(),
        film_strength: 100.0,
        ..AdjustmentModel::default()
    };
    let lut = identity_lattice(33);

    let baseline = render_display_scene(
        &raw,
        &no_lut_model,
        RenderQuality::Full,
        None,
        None,
        encode::TargetPrimaries::Srgb,
        None,
    )
    .expect("baseline scene");
    let with_lut = render_display_scene(
        &raw,
        &lut_model,
        RenderQuality::Full,
        None,
        None,
        encode::TargetPrimaries::Srgb,
        Some(&lut),
    )
    .expect("scene with identity lattice");

    assert_eq!(baseline.width, with_lut.width, "widths must match");
    assert_eq!(baseline.height, with_lut.height, "heights must match");
    assert_eq!(
        baseline.pixels.len(),
        with_lut.pixels.len(),
        "pixel counts must match"
    );

    let mut sum_abs_delta = 0.0f64;
    let mut n = 0u64;
    for (a, b) in baseline.pixels.iter().zip(with_lut.pixels.iter()) {
        for c in 0..3 {
            sum_abs_delta += (a[c] - b[c]).abs() as f64;
            n += 1;
        }
    }
    let mean_delta = sum_abs_delta / n as f64;
    assert!(
        mean_delta <= 1e-5,
        "identity lattice at full strength: mean abs delta {mean_delta} exceeds the 1e-5 budget"
    );
}
