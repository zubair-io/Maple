//! A white-balance drag on the capture-first creative stage allocates no GPU
//! resource and uploads no table after its first tick (#5376).

use super::tests::neutral_case;
use super::*;
use crate::live_chain::tests_creative::{capture_rgba, creative_inputs, custom};
use crate::{CancelToken, FullChainInputs, GpuContext};
use raw_core::test_support::creative::{creative_stage, Tables};
use raw_core::xmp::HighlightRecoveryMode;

#[test]
fn white_balance_ticks_are_zero_alloc_and_upload_no_table() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (16u32, 12u32);
    let input = capture_rgba((w * h) as usize);
    let cancel = CancelToken::new();
    let stage = creative_stage(Tables::DualHueSatMapAndLook, 1.5);
    let wire = stage.gpu_wire();
    let session = LiveSession::new(&ctx, &input, w, h).expect("session");
    let ticks = [
        (5200.0, 4.0),
        (3300.0, 12.0),
        (4100.0, -6.0),
        (9000.0, 20.0),
        (2500.0, 0.0),
        (5200.0, 4.0),
    ];
    let render = |temperature: f32, tint: f32| {
        let model = custom(temperature, tint, HighlightRecoveryMode::Off);
        let plan = stage.gpu_plan(&wire, &model).unwrap();
        let inputs = FullChainInputs {
            creative: Some(creative_inputs(&plan)),
            ..neutral_case().gpu_inputs_for(&input)
        };
        session
            .render_to_buffer(&ctx, &inputs, &cancel)
            .expect("render ok")
            .unwrap()
    };

    let before = session.pool_alloc_count(&ctx);
    let first = render(ticks[0].0, ticks[0].1);
    assert!(
        session.pool_alloc_count(&ctx) > before,
        "the first tick must fill the pool, or the hook measures nothing"
    );
    let (warm_allocs, warm_uploads) = (
        session.pool_alloc_count(&ctx),
        ctx.frame_pool.borrow().data_upload_count(),
    );
    let outputs: Vec<_> = ticks[1..]
        .iter()
        .map(|&(t, tint)| render(t, tint))
        .collect();
    assert_eq!(session.pool_alloc_count(&ctx), warm_allocs);
    assert_eq!(ctx.frame_pool.borrow().data_upload_count(), warm_uploads);
    assert_ne!(outputs[0], first, "a white-balance tick must move pixels");
    assert_ne!(outputs[0], outputs[1]);
    assert_eq!(
        outputs[4], first,
        "returning to a value restores its pixels"
    );
}
