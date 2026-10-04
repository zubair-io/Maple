//! An absent curve is not a fitted identity curve: the latter has a soft knee.
use super::*;
use crate::full_chain::oracle::{
    cpu_oracle, cpu_oracle_pre_dehaze, identity_lut, max_abs_diff, Case,
};
use crate::{AirlightSource, ChainRunner, GpuContext, GpuImage};
use raw_core::types::adjustment::AutoExposureMode;
use raw_core::types::{Profile, WbMethod};
use raw_core::view::auto_profile::curve::ProfileCurve;
use raw_core::AdjustmentModel;

fn case(profile: Profile, curve: Option<ProfileCurve>, residual: bool) -> Case {
    let mut lut = identity_lut(9);
    if residual {
        // A real residual-only fit must survive absence of the tone curve.
        for value in &mut lut.data {
            *value *= 0.9;
        }
    }
    Case {
        model: AdjustmentModel {
            profile,
            temperature: 6500.0,
            tint: 0.0,
            sharpen_amount: 0.0,
            nr_color: 0.0,
            auto_exposure: AutoExposureMode::Off,
            ..AdjustmentModel::default()
        },
        capture: None,
        curve,
        lut,
        wb_method: WbMethod::Cat16,
        film_lut: None,
        film_strength: 0.0,
    }
}

fn render(ctx: &GpuContext, input: &[f32], case: &Case, live: bool) -> Vec<f32> {
    let inputs = case.gpu_inputs_for(input);
    let passes = if live {
        crate::live_chain::build_live_split(&inputs, AirlightSource::Cpu([0.0; 3])).1
    } else {
        build_split(&inputs, [0.0; 3]).1
    };
    let refs: Vec<&dyn Pass> = passes.iter().map(|pass| pass.as_ref()).collect();
    let image = GpuImage::upload(ctx, input, 8, 8);
    ChainRunner::new(ctx, &image).run_blocking(&refs)
}

#[test]
fn absent_and_present_identity_curves_match_optional_cpu_tail_on_both_composers() {
    let ctx = GpuContext::new_blocking().expect("actual GPU required");
    // Post-develop scene-linear highlights exercise the gamma-domain 0.95 knee.
    let input: Vec<f32> = (0..64)
        .flat_map(|i| {
            let value = [0.1, 0.5, 1.0, 4.0, 16.0, 100.0, 1000.0, 2.0][i % 8];
            [value, value, value, 1.0]
        })
        .collect();
    let absent = case(Profile::Neutral, None, false);
    let fitted = case(Profile::Auto, Some(ProfileCurve::identity()), false);
    let before = cpu_oracle(&input, 8, 8, &absent);
    let after = cpu_oracle(&input, 8, 8, &fitted);
    assert!(
        max_abs_diff(&before, &after) > 0.02,
        "the highlight fixture must distinguish absent from fitted identity"
    );
    for live in [false, true] {
        for (label, sample) in [
            ("Neutral absent", case(Profile::Neutral, None, false)),
            ("Auto unavailable", case(Profile::Auto, None, false)),
            (
                "fitted identity",
                case(Profile::Auto, Some(ProfileCurve::identity()), false),
            ),
            ("residual only", case(Profile::Auto, None, true)),
        ] {
            let prefix = cpu_oracle_pre_dehaze(&input, 8, 8, &sample);
            assert!(
                max_abs_diff(&input, &prefix) < 1e-6,
                "the post-develop test fixture must have an identity prefix"
            );
            let expected = cpu_oracle(&input, 8, 8, &sample);
            let actual = render(&ctx, &input, &sample, live);
            let difference = max_abs_diff(&expected, &actual);
            assert!(difference < 1e-4, "{label} live={live}: {difference}");
            if label == "residual only" {
                assert!(
                    max_abs_diff(&expected, &before) > 0.05,
                    "residual-only control must visibly retain the LUT"
                );
            }
        }
    }
}
