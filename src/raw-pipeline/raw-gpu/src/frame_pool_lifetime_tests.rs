use super::*;
use crate::{CancelToken, LiveSession};

#[test]
fn retired_session_resources_are_reclaimed_without_flushing_surviving_views() {
    let ctx = GpuContext::new_blocking().unwrap();
    let inputs = crate::full_chain::oracle::Case {
        model: raw_core::types::AdjustmentModel {
            sharpen_amount: 0.,
            nr_color: 0.,
            ..Default::default()
        },
        capture: None,
        curve: None,
        lut: raw_core::view::auto_profile::lut::ColorLut::identity(2),
        wb_method: raw_core::types::WbMethod::Cat16,
        film_lut: None,
        film_strength: 0.,
    }
    .gpu_inputs();
    let cancel = CancelToken::new();
    let a = LiveSession::new(&ctx, &[0.2, 0.4, 0.6, 1.].repeat(64), 8, 8).unwrap();
    let before = a.render_to_buffer(&ctx, &inputs, &cancel).unwrap().unwrap();
    let b = LiveSession::new(&ctx, &[0.6, 0.4, 0.2, 1.].repeat(64), 8, 8).unwrap();
    b.render_to_buffer(&ctx, &inputs, &cancel).unwrap().unwrap();
    assert_eq!(ctx.frame_pool.borrow().buckets.len(), 2);
    drop(b);
    let warmed = a.pool_alloc_count(&ctx);
    assert_eq!(
        before,
        a.render_to_buffer(&ctx, &inputs, &cancel).unwrap().unwrap()
    );
    assert_eq!(ctx.frame_pool.borrow().buckets.len(), 1);
    assert_eq!(a.pool_alloc_count(&ctx), warmed);
    drop(a);
    let _next = LiveSession::new(&ctx, &[0.4, 0.4, 0.4, 1.].repeat(64), 8, 8).unwrap();
    assert!(ctx.frame_pool.borrow().buckets.is_empty());
}
