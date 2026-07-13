//! The pooled zero-allocation gate for `LiveSession` (epic #925, P4b-core /
//! #1027) — split out of `live_session/tests.rs` to keep each file under the
//! 600-LOC budget (mirrors `gpu_render`'s `tests` / `tests_sizing` split).
//! Reuses the sibling `tests` module's `pub(super)` fixtures
//! (`noop_model` / `mild_case` / `aggressive_case` / `neutral_case` /
//! `reference_u8`).
//!
//! CLAUDE.md's render-loop invariant: "If a new feature adds allocation inside
//! the render loop, it does not ship." These tests pin that at the
//! `FramePool` layer — a same-signature re-render is zero-alloc, a value change
//! within one signature is zero-alloc AND correct, a signature change allocates
//! once then converges to zero, and (the #1929 guard) two interleaved sessions
//! never share a pool bucket.

use super::tests::{aggressive_case, mild_case, neutral_case, noop_model, reference_u8};
use super::*;
use crate::full_chain::oracle::{nonidentity_curve, nonidentity_lut, scene_linear_rgba, Case};
use crate::{CancelToken, GpuContext};

use raw_core::types::WbMethod;
use raw_core::xmp::AdjustmentModel;

/// STEP 2b — THE ZERO-ALLOCATION GATE (CLAUDE.md: "allocation inside the render
/// loop … does not ship"). A second render at the SAME dims + inputs (same chain
/// signature) allocates ZERO new GPU buffers / bind groups, AND is bit-identical
/// to the first. Non-vacuous: the FIRST render's allocation count must be > 0
/// (else the hook isn't measuring anything). Run across a neutral (view-tail
/// only), a mild, and an aggressive (every gated stage + dehaze + the spatial
/// DAGs) signature, so the pool is exercised both near-empty and fully loaded.
#[test]
fn second_render_same_signature_allocates_nothing() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (8u32, 8u32);
    let input = scene_linear_rgba(w as usize, h as usize);
    let cancel = CancelToken::new();

    for (name, case) in [
        ("neutral", neutral_case()),
        ("mild", mild_case()),
        ("aggressive", aggressive_case()),
    ] {
        let inputs = case.gpu_inputs();
        // A fresh session per case (reset() clears the prior case's cache).
        let session = LiveSession::new(&ctx, &input, w, h).expect("session");

        // First render: fills the pool (allocations expected).
        let before_first = session.pool_alloc_count(&ctx);
        let first = session
            .render_to_buffer(&ctx, &inputs, &cancel)
            .expect("render ok")
            .unwrap();
        let first_allocs = session.pool_alloc_count(&ctx) - before_first;

        // Second render, identical signature: must reuse everything.
        let second = session
            .render_to_buffer(&ctx, &inputs, &cancel)
            .expect("render ok")
            .unwrap();
        let second_allocs = session.pool_alloc_count(&ctx) - before_first - first_allocs;

        eprintln!(
            "ZERO-ALLOC [{name}]: first render = {first_allocs} pool allocs, \
             second render = {second_allocs} pool allocs"
        );
        assert!(
            first_allocs > 0,
            "[{name}] first render did 0 pool allocs — the accounting hook is vacuous"
        );
        assert_eq!(
            second_allocs, 0,
            "[{name}] second render at the same signature allocated {second_allocs} GPU \
             resources — the render loop is not zero-alloc"
        );
        assert_eq!(
            first, second,
            "[{name}] the zero-alloc re-render must be byte-identical to the first"
        );
    }
}

/// THE LIVE-EDIT GATE: a slider drag WITHIN one signature (same active set,
/// changed VALUE) must (a) produce the correct NEW pixels — matching a reference
/// render of the new value — and (b) still allocate ZERO new GPU resources. This
/// is the actual hot path P4b serves, and the one the same-inputs re-render tests
/// can't see: with identical inputs, a stale uniform / stale data buffer would go
/// green. Two value-change paths:
///   - exposure 0.3 → 0.4: the UNIFORM-on-hit path (`encode_simple` rewrites the
///     pooled uniform every call).
///   - parametric_lights 15 → 40: the DATA-BUFFER-on-hit path (`pool_data_storage`
///     must rewrite the pooled tone-curve storage every call — without that, the
///     edit would bind the first render's stale curve and the preview would freeze).
#[test]
fn same_signature_value_change_is_correct_and_zero_alloc() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (8u32, 8u32);
    let input = scene_linear_rgba(w as usize, h as usize);
    let cancel = CancelToken::new();

    // Build two cases that share an active-stage SET but differ in a VALUE.
    let make_case = |mutate: &dyn Fn(&mut AdjustmentModel)| -> Case {
        let mut model = noop_model();
        // Engage scene-tone (exposure) AND tone-curves (parametric) on BOTH so the
        // active mask — and thus the signature — is identical across the value
        // change; the mutation only shifts magnitudes.
        model.exposure = 0.3;
        model.parametric_lights = 15.0;
        mutate(&mut model);
        Case {
            model,
            capture: None,
            curve: nonidentity_curve(),
            lut: nonidentity_lut(9),
            wb_method: WbMethod::Cat16,
        }
    };

    let base_case = make_case(&|_| {});
    let edited_case = make_case(&|m| {
        m.exposure = 0.4; // uniform-path change
        m.parametric_lights = 40.0; // data-buffer-path change
    });
    let base = base_case.gpu_inputs();
    let edited = edited_case.gpu_inputs();

    // Same signature (only values differ)? Compared at a fixed stand-in session
    // id (`0`) — this assertion is about SHAPE (active set), not session
    // identity (#1929), so both sides just need the SAME id, not a real one.
    assert_eq!(
        crate::chain_signature(&base, (w, h), 0),
        crate::chain_signature(&edited, (w, h), 0),
        "test setup: the two cases must share a chain signature (same active set)"
    );

    let session = LiveSession::new(&ctx, &input, w, h).expect("session");

    // Render base (fills the cache for this signature).
    let _ = session
        .render_to_buffer(&ctx, &base, &cancel)
        .expect("render ok")
        .unwrap();

    // Now the EDIT: same signature, changed values. Snapshot allocs around it.
    let pre_edit = session.pool_alloc_count(&ctx);
    let got = session
        .render_to_buffer(&ctx, &edited, &cancel)
        .expect("render ok")
        .unwrap();
    let edit_allocs = session.pool_alloc_count(&ctx) - pre_edit;

    // (a) Correct NEW pixels: matches a reference render of the EDITED inputs
    //     (direct chain+dither, no pool). If the uniform / data buffer weren't
    //     rewritten on the hit, `got` would still be the BASE output → mismatch.
    let want = reference_u8(&ctx, &input, w, h, &edited);
    let mismatches = got.iter().zip(&want).filter(|(a, b)| a != b).count();
    eprintln!(
        "LIVE-EDIT: edit render = {edit_allocs} pool allocs, {mismatches} / {} bytes differ vs reference",
        want.len()
    );
    assert_eq!(
        mismatches, 0,
        "same-signature value change produced STALE pixels ({mismatches} bytes differ from the \
         reference render of the edited inputs) — a pooled uniform/data buffer wasn't rewritten"
    );

    // (b) Zero-alloc: the edit reused the cached resources.
    assert_eq!(
        edit_allocs, 0,
        "a same-signature value-change render allocated {edit_allocs} GPU resources — not zero-alloc"
    );

    // And the edited output must actually DIFFER from the base (else the test is
    // vacuous — a no-op edit can't prove freshness).
    let base_out = reference_u8(&ctx, &input, w, h, &base);
    assert_ne!(
        got, base_out,
        "the edit produced the BASE pixels — the value change had no effect (vacuous)"
    );
}

/// A slider crossing a GATING threshold (e.g. dehaze 0→engaged) changes the chain
/// signature → a fresh pool bucket (allocations expected the first time that
/// shape is seen), but a re-render of the NEW shape is again zero-alloc. This pins
/// the signature-keyed cache: a new shape never reuses (binds) the old shape's
/// resources, and each shape converges to zero-alloc independently.
#[test]
fn signature_change_allocates_once_then_zero() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (8u32, 8u32);
    let input = scene_linear_rgba(w as usize, h as usize);
    let cancel = CancelToken::new();
    let session = LiveSession::new(&ctx, &input, w, h).expect("session");

    // Shape A: neutral (view tail only).
    let a = neutral_case().gpu_inputs();
    let base = session.pool_alloc_count(&ctx);
    session
        .render_to_buffer(&ctx, &a, &cancel)
        .expect("render ok")
        .unwrap();
    let a1 = session.pool_alloc_count(&ctx) - base;
    session
        .render_to_buffer(&ctx, &a, &cancel)
        .expect("render ok")
        .unwrap();
    let a2 = session.pool_alloc_count(&ctx) - base - a1;
    assert!(a1 > 0, "shape A first render must allocate");
    assert_eq!(a2, 0, "shape A re-render must be zero-alloc");

    // Shape B: dehaze engaged — a DIFFERENT signature → its own bucket allocates.
    let mut b_case = neutral_case();
    b_case.model.dehaze = 40.0;
    let b = b_case.gpu_inputs();
    let pre_b = session.pool_alloc_count(&ctx);
    session
        .render_to_buffer(&ctx, &b, &cancel)
        .expect("render ok")
        .unwrap();
    let b1 = session.pool_alloc_count(&ctx) - pre_b;
    session
        .render_to_buffer(&ctx, &b, &cancel)
        .expect("render ok")
        .unwrap();
    let b2 = session.pool_alloc_count(&ctx) - pre_b - b1;
    eprintln!("SIGNATURE-CHANGE: shape A allocs={a1}, shape B allocs={b1} (B re-render={b2})");
    assert!(
        b1 > 0,
        "shape B (dehaze on) is a new signature — its first render must allocate"
    );
    assert_eq!(b2, 0, "shape B re-render must be zero-alloc");

    // Returning to shape A is zero-alloc (its bucket is still cached).
    let pre_a3 = session.pool_alloc_count(&ctx);
    session
        .render_to_buffer(&ctx, &a, &cancel)
        .expect("render ok")
        .unwrap();
    let a3 = session.pool_alloc_count(&ctx) - pre_a3;
    assert_eq!(
        a3, 0,
        "returning to shape A must reuse its cached bucket (zero-alloc)"
    );
}

/// SESSION-IDENTITY GUARD (#1929): two `LiveSession`s sharing the SAME
/// `GpuContext` — the real Apple shape, where `GpuContext`/`FramePool` is a
/// process-wide static (`GpuShared`) reused across every live session, not
/// per-session — must never collide in the frame pool even when their chain
/// signature SHAPE (active mask + dims) matches.
///
/// Before the fix, `chain_signature` hashed only `(active_mask, dims, cs_iters,
/// residual_lut_size)`. `LiveSession::new`'s `frame_pool.reset()` only guards
/// against a stale CLOSED session's leftovers — it does nothing once a SECOND
/// session opens (which itself calls `reset()`, wiping the FIRST session's
/// cache) and then renders (repopulating the shared-signature bucket with ITS
/// OWN ping-pong buffers). A wgpu bind group's buffer bindings are frozen at
/// creation, so the first session's NEXT render at that same signature would
/// hit the cache and dispatch against the SECOND session's buffers instead of
/// its own — silently corrupting output instead of erroring.
///
/// Reproduce by interleaving two sessions with DIFFERENT image content (so a
/// buffer mix-up is visible in the output bytes) but the SAME dims and the SAME
/// (neutral) inputs (so pre-fix they'd share one chain-signature bucket):
/// render A once, open+render B (which resets the pool then repopulates the
/// bucket with B's buffers), then render A again. A's second render must be
/// byte-identical to its first — same session, same inputs, same dims, a
/// deterministic chain.
#[test]
fn interleaved_sessions_do_not_share_pool_buckets() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (8u32, 8u32);
    let cancel = CancelToken::new();
    let inputs = neutral_case().gpu_inputs();

    // Two DIFFERENT images (content, not shape) so a cross-session buffer
    // mix-up is visible in the output bytes even though A and B share dims and
    // the (neutral) chain signature shape.
    let image_a = scene_linear_rgba(w as usize, h as usize);
    let image_b: Vec<f32> = std::iter::repeat([0.2f32, 0.35, 0.55, 1.0])
        .take((w * h) as usize)
        .flatten()
        .collect();
    assert_ne!(image_a, image_b, "test setup: the two images must differ");

    let session_a = LiveSession::new(&ctx, &image_a, w, h).expect("session a");
    let a_first = session_a
        .render_to_buffer(&ctx, &inputs, &cancel)
        .expect("render ok")
        .unwrap();

    // Session B: same dims, same (neutral) inputs → same chain-signature SHAPE
    // as A, pre-#1929. Its `new()` resets the pool (dropping A's cached
    // bucket), then its render repopulates that bucket with B's OWN buffers.
    let session_b = LiveSession::new(&ctx, &image_b, w, h).expect("session b");
    let _b_first = session_b
        .render_to_buffer(&ctx, &inputs, &cancel)
        .expect("render ok")
        .unwrap();

    // A renders again — identical session, inputs, and dims as its first
    // render, so the output MUST be byte-identical. Pre-fix, A's second render
    // would hit the bucket B just populated (no session salt) and dispatch
    // against B's ping-pong buffers, corrupting A's output.
    let a_second = session_a
        .render_to_buffer(&ctx, &inputs, &cancel)
        .expect("render ok")
        .unwrap();

    assert_eq!(
        a_first, a_second,
        "session A's second render diverged from its first — the frame pool \
         handed A a bind group cached by session B (no session-identity salt \
         in chain_signature, #1929)"
    );
}

