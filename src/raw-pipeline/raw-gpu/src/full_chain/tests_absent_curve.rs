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

/// Exercise the encoded-f32 look boundary from both actual composers. Values
/// above one distinguish a genuinely absent residual from a present identity
/// grid: raw-core skips None, while ColorLut::sample clamps a present grid.
#[test]
fn absent_residual_preserves_hdr_while_present_identity_matches_cpu_clamping() {
    let ctx = GpuContext::new_blocking().expect("actual GPU required");
    let input: Vec<f32> = (0..64)
        .flat_map(|i| [1.25 + i as f32 / 64.0, 0.5, -0.25, 0.75])
        .collect();
    let sample = case(Profile::Neutral, None, false);
    let identity = identity_lut(9);
    let expected_present: Vec<f32> = input
        .chunks_exact(4)
        .flat_map(|px| {
            let rgb = identity.sample([px[0], px[1], px[2]]);
            [rgb[0], rgb[1], rgb[2], px[3]]
        })
        .collect();
    assert!(max_abs_diff(&input, &expected_present) > 0.25);
    for live in [false, true] {
        let mut absent_inputs = sample.gpu_inputs();
        absent_inputs.residual_lut_size = 0;
        absent_inputs.residual_lut_data = Vec::new().into();
        let present_inputs = sample.gpu_inputs();
        let absent_suffix = if live {
            crate::live_chain::build_live_split(&absent_inputs, AirlightSource::Cpu([0.0; 3])).1
        } else {
            build_split(&absent_inputs, [0.0; 3]).1
        };
        let present_suffix = if live {
            crate::live_chain::build_live_split(&present_inputs, AirlightSource::Cpu([0.0; 3])).1
        } else {
            build_split(&present_inputs, [0.0; 3]).1
        };
        // Both composers append the residual LAST, directly after gamma.
        // Their shared upstream stage count differs (full includes neutral
        // stages); the actual absent composition defines this boundary.
        let boundary = absent_suffix.len();
        assert_eq!(present_suffix.len(), boundary + 1);
        for (present, suffix) in [(false, &absent_suffix), (true, &present_suffix)] {
            let refs: Vec<&dyn Pass> = suffix[boundary..]
                .iter()
                .map(|pass| pass.as_ref())
                .collect();
            assert_eq!(refs.len(), usize::from(present));
            let image = GpuImage::upload(&ctx, &input, 8, 8);
            let actual = ChainRunner::new(&ctx, &image).run_blocking(&refs);
            let expected = if present { &expected_present } else { &input };
            assert!(
                max_abs_diff(&actual, expected) < 1e-4,
                "residual presence={present} live={live} must match raw-core optional sampling"
            );
        }
    }
}
