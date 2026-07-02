//! Ignored diagnostic dumps for the synthetic-grey adjustment suite. Split
//! out of `grey_adjustments.rs` under the 600-LOC file budget — both tests
//! are `#[ignore]` inspection tools, self-contained (they build their own
//! helpers inline), run via `--ignored --nocapture`.

#![cfg(feature = "test-support")]

use raw_core::pipeline::{
    develop_scene_linear_from_raw_with_quality, render_from_raw, RenderQuality,
};
use raw_core::test_support::predictions::*;
use raw_core::test_support::synth_dng::SyntheticGreyDng;
use raw_core::xmp::AdjustmentModel;

/// Print the maximum |delta| between Maple's actual scene-linear
/// output and the closed-form prediction, per adjustment, across an
/// L sweep that includes L = 0.
///
/// Run with `--ignored --nocapture` to inspect:
///   cargo test -p raw-core --features test-support --test grey_adjustments \
///       dump_scene_linear_deltas -- --ignored --nocapture
#[test]
#[ignore]
fn dump_scene_linear_deltas() {
    fn worst_delta(
        L: f32,
        configure: impl FnOnce(&mut AdjustmentModel),
        predict: impl Fn(f32) -> f32,
    ) -> f32 {
        let dng = SyntheticGreyDng {
            linear_value: L,
            ..Default::default()
        };
        let bytes = dng.write_to_bytes();
        let raw = raw_core::decode::decode_bytes(&bytes, "dng").unwrap();
        let mut model = AdjustmentModel::default();
        configure(&mut model);
        let img =
            develop_scene_linear_from_raw_with_quality(&raw, &model, RenderQuality::Full).unwrap();
        let expected = predict(L);
        let mut worst = 0.0f32;
        for p in &img.pixels {
            for c in 0..3 {
                let d = (p[c] - expected).abs();
                if d > worst {
                    worst = d;
                }
            }
        }
        worst
    }
    fn dump(label: &str, delta: f32, predicted: f32) {
        let rel = if predicted.abs() > 1e-9 {
            delta / predicted.abs()
        } else {
            f32::NAN
        };
        println!(
            "{:32} |Δ|={:.3e}  (predicted={:.4}, rel={:.3e})",
            label, delta, predicted, rel
        );
    }
    for L in [0.0, 0.05, 0.18, 0.50] {
        let pl = format!("L={}", L);
        dump(
            &format!("{}/exposure +1", pl),
            worst_delta(L, |m| m.exposure = 1.0, |s| predict_exposure(s, 1.0)),
            predict_exposure(L, 1.0),
        );
        dump(
            &format!("{}/exposure -1", pl),
            worst_delta(L, |m| m.exposure = -1.0, |s| predict_exposure(s, -1.0)),
            predict_exposure(L, -1.0),
        );
        dump(
            &format!("{}/brightness +50", pl),
            worst_delta(L, |m| m.brightness = 50.0, |s| predict_brightness(s, 50.0)),
            predict_brightness(L, 50.0),
        );
        dump(
            &format!("{}/shadows +50", pl),
            worst_delta(L, |m| m.shadows = 50.0, |s| predict_shadows(s, 50.0)),
            predict_shadows(L, 50.0),
        );
        dump(
            &format!("{}/whites +50", pl),
            worst_delta(L, |m| m.whites = 50.0, |s| predict_whites(s, 50.0)),
            predict_whites(L, 50.0),
        );
        dump(
            &format!("{}/blacks +50", pl),
            worst_delta(L, |m| m.blacks = 50.0, |s| predict_blacks(s, 50.0)),
            predict_blacks(L, 50.0),
        );
        dump(
            &format!("{}/saturation +50", pl),
            worst_delta(L, |m| m.saturation = 50.0, |s| predict_saturation(s, 50.0)),
            predict_saturation(L, 50.0),
        );
        dump(
            &format!("{}/vibrance +50", pl),
            worst_delta(L, |m| m.vibrance = 50.0, |s| predict_vibrance(s, 50.0)),
            predict_vibrance(L, 50.0),
        );
    }
}

/// Print the per-channel u8 mean for every adjustment case the Apple
/// UITest covers. Run with `--ignored --nocapture` to dump; the integers
/// it prints get hard-coded into SyntheticGreyUITests.swift's `cases[]`.
///
/// Run:
///   cargo test -p raw-core --features test-support --test grey_adjustments \
///       dump_display_means -- --ignored --nocapture
#[test]
#[ignore]
fn dump_display_means() {
    fn mean(label: &str, configure: impl FnOnce(&mut AdjustmentModel)) {
        let dng = SyntheticGreyDng::default(); // L = 0.18, 64×64 RGGB
        let bytes = dng.write_to_bytes();
        let raw = raw_core::decode::decode_bytes(&bytes, "dng").unwrap();
        let mut model = AdjustmentModel::default();
        configure(&mut model);
        let (w, h, rgb) = render_from_raw(&raw, &model).unwrap();
        let n = (w * h) as usize;
        let mr: u32 = (0..n).map(|i| rgb[i * 3] as u32).sum();
        let mg: u32 = (0..n).map(|i| rgb[i * 3 + 1] as u32).sum();
        let mb: u32 = (0..n).map(|i| rgb[i * 3 + 2] as u32).sum();
        let nu = n as u32;
        let avg = |s: u32| (s + nu / 2) / nu;
        println!("{:24} R={} G={} B={}", label, avg(mr), avg(mg), avg(mb));
    }
    mean("default", |_| {});
    mean("exposure +1", |m| m.exposure = 1.0);
    mean("exposure -1", |m| m.exposure = -1.0);
    mean("shadows +50", |m| m.shadows = 50.0);
    mean("whites -50", |m| m.whites = -50.0);
    mean("contrast +50", |m| m.contrast = 50.0);
}
