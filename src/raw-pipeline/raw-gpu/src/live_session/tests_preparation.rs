//! #4340: exact pixels, cancellation, scope exclusion and activation allocations.
use super::*;

#[test]
fn preparation_preserves_cancelled_inputs_and_skips_scope_capture() {
    let ctx = GpuContext::new_blocking().expect("GPU context");
    let pixels = crate::full_chain::oracle::scene_linear_rgba(8, 8);
    let session = LiveSession::new(&ctx, &pixels, 8, 8).unwrap();
    let mut inputs = super::tests::neutral_case().gpu_inputs();
    inputs.tone[0] = -0.0;
    let original_bits = inputs.tone.map(f32::to_bits);
    let cancelled = CancelToken::new();
    cancelled.cancel();
    let before = session.pool_alloc_count(&ctx);
    assert!(session
        .prepare_exposure_activation(&ctx, &mut inputs, &cancelled)
        .is_err());
    assert_eq!(inputs.tone.map(f32::to_bits), original_bits);
    assert_eq!(session.pool_alloc_count(&ctx), before);

    inputs.scope.enabled = true;
    let cancel = CancelToken::new();
    assert!(!session
        .prepare_exposure_activation(&ctx, &mut inputs, &cancel)
        .unwrap());
    assert_eq!(inputs.tone.map(f32::to_bits), original_bits);
    assert_eq!(session.pool_alloc_count(&ctx), before);
    assert!(inputs.scope.enabled);
    inputs.scope.enabled = false;
    inputs.tone[0] = 0.25;
    assert!(!session
        .prepare_exposure_activation(&ctx, &mut inputs, &cancel)
        .unwrap());
    assert_eq!(session.pool_alloc_count(&ctx), before);
    inputs.tone[0] = -0.0;
    assert!(session
        .prepare_exposure_activation(&ctx, &mut inputs, &cancel)
        .unwrap());
    assert_eq!(inputs.tone.map(f32::to_bits), original_bits);
}

#[test]
fn prepared_exposure_keeps_pixels_and_avoids_first_activation_allocations() {
    let ctx = GpuContext::new_blocking().expect("GPU context");
    let oracle_ctx = GpuContext::new_blocking().expect("independent oracle context");
    let pixels = crate::full_chain::oracle::scene_linear_rgba(8, 8);
    let session = LiveSession::new(&ctx, &pixels, 8, 8).unwrap();
    let cancel = CancelToken::new();
    let mut neutral = super::tests::neutral_case().gpu_inputs();
    let expected = super::tests::reference_u8(&oracle_ctx, &pixels, 8, 8, &neutral);
    session
        .prepare_exposure_activation(&ctx, &mut neutral, &cancel)
        .unwrap();
    assert_eq!(neutral.tone, [0.0; 6]);
    assert_eq!(
        session
            .render_to_buffer(&ctx, &neutral, &cancel)
            .unwrap()
            .unwrap(),
        expected
    );
    let before = session.pool_alloc_count(&ctx);
    let mut active = super::tests::neutral_case().gpu_inputs();
    active.tone[0] = 0.25;
    let active_expected = super::tests::reference_u8(&oracle_ctx, &pixels, 8, 8, &active);
    // WinUI presents this f32 chain directly. The pixel-check readback below
    // additionally allocates a dither bucket, which is not its presentation path.
    session
        .render_chain_to_f32(&ctx, &active, &cancel)
        .unwrap()
        .unwrap();
    assert_eq!(session.pool_alloc_count(&ctx), before);
    assert_eq!(
        session
            .render_to_buffer(&ctx, &active, &cancel)
            .unwrap()
            .unwrap(),
        active_expected
    );
    assert_eq!(
        session
            .render_to_buffer(&ctx, &neutral, &cancel)
            .unwrap()
            .unwrap(),
        expected
    );
}
