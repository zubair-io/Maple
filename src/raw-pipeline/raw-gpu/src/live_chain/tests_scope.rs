//! The scope pass's load-bearing precondition (#3272): every RGBA pass in the
//! live chain must carry the alpha lane through UNCHANGED, since the
//! `local_adjustments` kernel writes the scope-target layer's weight into it
//! and nothing downstream may disturb that value before the scope pass reads
//! it at the end of the view tail. Split out of `tests.rs` (600-LOC budget);
//! reuses its `pub(super)` `run_live_chain` so this drives the exact same
//! headless harness the neutral/single-stage gates do.

use super::tests::run_live_chain;
use crate::full_chain::oracle::{identity_curve, identity_lut, scene_linear_rgba, Case};
use raw_core::types::adjustment::AutoExposureMode;
use raw_core::types::WbMethod;
use raw_core::xmp::AdjustmentModel;

/// Many sliders past their no-op thresholds at once, so the live chain
/// includes a large fraction of its passes — an alpha bug in any ONE of them
/// would otherwise hide behind the others being gated out.
fn many_stages_active_case() -> Case {
    let model = AdjustmentModel {
        temperature: 5200.0,
        tint: 8.0,
        exposure: 0.4,
        contrast: 15.0,
        highlights: -20.0,
        shadows: 25.0,
        whites: 10.0,
        blacks: -10.0,
        vibrance: 20.0,
        saturation: 15.0,
        clarity: 30.0,
        texture: 20.0,
        dehaze: 15.0,
        vignette_amount: -20.0,
        vignette_feather: 60.0,
        sharpen_amount: 50.0,
        nr_luminance: 20.0,
        nr_color: 25.0,
        grain_amount: 15.0,
        auto_exposure: AutoExposureMode::Off,
        ..AdjustmentModel::default()
    };
    Case {
        model,
        capture: None,
        curve: identity_curve(),
        lut: identity_lut(9),
        wb_method: WbMethod::Cat16,
        film_lut: None,
        film_strength: 0.0,
    }
}

/// Seed a distinctive alpha ramp, run the chain with NO scope target, and
/// require the output alpha to equal the input alpha bit-for-bit: the scope
/// pass depends on this lane surviving untouched end to end.
#[test]
fn every_rgba_pass_in_the_live_chain_preserves_alpha() {
    let (w, h) = (16usize, 12usize);
    let mut input = scene_linear_rgba(w, h);
    for (i, px) in input.chunks_exact_mut(4).enumerate() {
        px[3] = (i % 97) as f32 / 96.0;
    }
    let case = many_stages_active_case();
    let inputs = case.gpu_inputs();
    let out = run_live_chain(&input, w as u32, h as u32, &inputs);
    for (i, (a, b)) in input.chunks_exact(4).zip(out.chunks_exact(4)).enumerate() {
        assert_eq!(
            a[3], b[3],
            "alpha changed at pixel {i}: {} -> {}",
            a[3], b[3]
        );
    }
}
