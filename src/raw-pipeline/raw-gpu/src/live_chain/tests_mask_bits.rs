//! Mask-bit uniqueness on the live pool key (#5099): the retargeted-HueSatMap
//! WB variant and the colour curves are independent passes, so toggling
//! either with the other engaged must change `chain_signature`, or the frame
//! pool would replay the other shape's bind groups by ordinal.

use super::tests::{neutral_case, TEST_SESSION_ID};
use super::*;
use crate::color_curves::ColorCurveInputs;
use crate::dehaze::AirlightSource;
use crate::{WbHsmInputs, WbHsmTables};

const TABLES: [f32; 2 * 2 * 2 * 1 * 3] = [
    0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, //
    5.0, 1.1, 1.0, 5.0, 1.1, 1.0, 5.0, 1.1, 1.0, 5.0, 1.1, 1.0,
];

fn hsm() -> WbHsmInputs<'static> {
    let identity = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    WbHsmInputs {
        dims: [2, 2, 1],
        srgb: false,
        tables: WbHsmTables::Borrowed(&TABLES),
        to_pro: identity,
        delta_pro: identity,
        from_pro: identity,
        w_target: 0.8,
        w_anchor: 0.2,
        inverse_iterations: 4,
        lift_bisection_steps: 24,
    }
}

fn curves() -> ColorCurveInputs<'static> {
    ColorCurveInputs {
        hue_vs_hue: vec![(0.0, 0.5), (0.15, 0.72), (0.4, 0.5)].into(),
        ..Default::default()
    }
}

#[test]
fn hsm_variant_and_colour_curves_toggle_the_signature_independently() {
    let build = |hsm_on: bool, curves_on: bool| {
        let mut inputs = neutral_case().gpu_inputs();
        inputs.wb_temperature = 5200.0;
        inputs.wb_tint = 12.0;
        inputs.wb_hsm = hsm_on.then(hsm);
        inputs.color_curves = if curves_on {
            curves()
        } else {
            ColorCurveInputs::default()
        };
        inputs
    };
    let signature = |inputs: &FullChainInputs| chain_signature(inputs, (8, 8), TEST_SESSION_ID);
    let pass_count =
        |inputs: &FullChainInputs| build_live_chain(inputs, AirlightSource::Cpu([0.0; 3])).len();

    let both = build(true, true);
    let hsm_only = build(true, false);
    let curves_only = build(false, true);
    assert_ne!(pass_count(&both), pass_count(&hsm_only));
    assert_ne!(
        signature(&both),
        signature(&hsm_only),
        "toggling colour curves with the HueSatMap variant engaged must change the key"
    );
    assert_ne!(
        signature(&both),
        signature(&curves_only),
        "toggling the HueSatMap variant with colour curves engaged must change the key"
    );
    assert_ne!(signature(&hsm_only), signature(&curves_only));
}
