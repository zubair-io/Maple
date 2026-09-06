//! A request cancelled during drawable acquisition must never encode a chain.
use super::{tests::neutral_case, with_reserved_frame};
use crate::{CancelToken, GpuContext, LiveSession};

#[test]
fn cancellation_while_reserving_a_frame_submits_no_gpu_work() {
    let ctx = GpuContext::new_blocking().expect("GPU required");
    let session = LiveSession::new(&ctx, &[0.18; 16 * 16 * 4], 16, 16).unwrap();
    let case = neutral_case();
    let inputs = case.gpu_inputs();
    let cancel = CancelToken::new();
    let signal = cancel.clone();
    let (started, waiting) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        waiting.recv().unwrap();
        signal.cancel();
        release.send(()).unwrap();
    });
    let allocations = session.pool_alloc_count(&ctx);
    let render_started = std::cell::Cell::new(false);
    let presented = with_reserved_frame(
        &cancel,
        || {
            started.send(()).unwrap();
            released.recv().unwrap();
            Ok(())
        },
        |()| {
            render_started.set(true);
            Ok(session
                .render_chain_to_f32(&ctx, &inputs, &cancel)?
                .is_some())
        },
    )
    .unwrap();
    worker.join().unwrap();
    assert!(!presented);
    assert!(
        !render_started.get(),
        "reservation cancellation must skip rendering entirely"
    );
    assert_eq!(
        session.pool_alloc_count(&ctx),
        allocations,
        "cancelled acquisition must not reach chain resources or submission"
    );

    // Non-vacuous control: the same reservation/real render does execute when
    // current, and produces an actual f32 chain result without readback.
    let current = CancelToken::new();
    assert!(with_reserved_frame(
        &current,
        || Ok(()),
        |()| {
            Ok(session
                .render_chain_to_f32(&ctx, &inputs, &current)?
                .is_some())
        }
    )
    .unwrap());
    assert!(session.pool_alloc_count(&ctx) > allocations);
}

#[test]
fn pre_cancelled_request_does_not_acquire_a_drawable() {
    let cancel = CancelToken::new();
    cancel.cancel();
    let rendered = with_reserved_frame(
        &cancel,
        || -> Result<(), String> { panic!("obsolete request acquired a drawable") },
        |()| -> Result<bool, String> { panic!("obsolete request encoded a chain") },
    )
    .unwrap();
    assert!(!rendered);
}
