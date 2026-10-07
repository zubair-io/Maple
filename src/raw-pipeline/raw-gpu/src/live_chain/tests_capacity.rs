use super::tests::neutral_case;
use super::*;
use crate::{CancelToken, GpuContext, LiveSession};

#[test]
fn curve_capacity_uses_normalized_knots_without_truncation() {
    let points: Vec<_> = (0..32)
        .map(|i| (i as f32 / 31.0, i as f32 / 40.0))
        .collect();
    assert!(crate::tone_curves::point_curve_fits_gpu(&points));
    let oversized: Vec<_> = (0..33)
        .map(|i| (i as f32 / 32.0, i as f32 / 40.0))
        .collect();
    assert!(!crate::tone_curves::point_curve_fits_gpu(&oversized));
    let duplicates = vec![(0.5, 0.6); 100];
    assert!(crate::tone_curves::point_curve_fits_gpu(&duplicates));
}

#[test]
fn oversized_curves_fail_before_encoding_and_the_session_remains_usable() {
    let ctx = GpuContext::new_blocking().unwrap();
    let pixels = crate::full_chain::oracle::scene_linear_rgba(16, 8);
    let session = LiveSession::new(&ctx, &pixels, 16, 8).unwrap();
    let points: Vec<_> = (0..40)
        .map(|i| (i as f32 / 39.0, i as f32 / 50.0))
        .collect();
    let baseline = session.pool_alloc_count(&ctx);
    for index in 0..8 {
        let case = neutral_case();
        let mut inputs = case.gpu_inputs();
        let curves = [
            &mut inputs.tone_curves.luma,
            &mut inputs.tone_curves.red,
            &mut inputs.tone_curves.green,
            &mut inputs.tone_curves.blue,
            &mut inputs.display_tone_curves.master,
            &mut inputs.display_tone_curves.red,
            &mut inputs.display_tone_curves.green,
            &mut inputs.display_tone_curves.blue,
        ];
        *curves.into_iter().nth(index).unwrap() = points.clone();
        assert!(session
            .render_chain_to_f32(&ctx, &inputs, &CancelToken::new())
            .is_err());
        assert!(session
            .render_to_buffer(&ctx, &inputs, &CancelToken::new())
            .is_err());
        assert_eq!(session.pool_alloc_count(&ctx), baseline);
    }
    let case = neutral_case();
    assert!(session
        .render_to_buffer(&ctx, &case.gpu_inputs(), &CancelToken::new())
        .unwrap()
        .is_some());
}
