//! `PresentDispatchCache` zero-allocation regression gate (#1930).
//!
//! Mirrors `live_session/tests.rs`'s `second_render_same_signature_allocates_nothing`
//! shape (build a pool/cache, assert the FIRST use allocates > 0, a SAME-identity
//! SECOND use allocates exactly 0) but at the present-pass layer instead of the
//! live chain — proving the shared `PresentDispatchCache` both `WebPresentSurface`
//! and `PersistentPresentSurface` delegate to actually holds the CLAUDE.md
//! "no allocation inside the render loop" line for the present pass, not just the
//! chain compute passes `FramePool` already covers.
//!
//! No canvas / `CAMetalLayer` needed: a present dispatch only binds a uniform +
//! whatever `wgpu::Buffer` is passed as `chain_buf`, so a plain storage buffer
//! standing in for the session's ping-pong buffer exercises the exact same
//! `create_buffer` / `create_bind_group` path the real present surfaces hit.

use super::*;
use crate::context::GpuContext;
use std::sync::Arc;

/// A storage buffer standing in for one of `LiveSession`'s persistent ping-pong
/// buffers (`chain_buf` in the real present path). Real usage flags aren't
/// needed here — `PresentDispatchCache` only cares about the buffer's ADDRESS
/// identity and binds it as a read-only storage resource.
fn make_chain_buf(ctx: &GpuContext, label: &str) -> wgpu::Buffer {
    ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size: 64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

/// STEP 1 — THE ZERO-ALLOCATION GATE (CLAUDE.md: "allocation inside the render
/// loop … does not ship"). A second present against the SAME `chain_buf`
/// identity (the steady state while dragging one slider — the active-stage set,
/// and so the final ping-pong index, doesn't change) must allocate ZERO new GPU
/// resources. Non-vacuous: the FIRST call's allocation count must be > 0.
#[test]
fn second_present_same_buffer_identity_allocates_nothing() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (_pipeline, bgl) = build_present_pipeline(&ctx, wgpu::TextureFormat::Rgba8Unorm);
    let cache = PresentDispatchCache::new();
    let chain_buf = make_chain_buf(&ctx, "chain-a");

    let base = cache.alloc_count();
    let _ = cache.get_or_build(&ctx, &bgl, &chain_buf, (8, 8));
    let first = cache.alloc_count() - base;
    assert!(
        first > 0,
        "first present-dispatch build did 0 allocs — the accounting hook is vacuous"
    );
    assert_eq!(
        first, 2,
        "first build must allocate exactly the uniform buffer + the bind group"
    );

    let _ = cache.get_or_build(&ctx, &bgl, &chain_buf, (8, 8));
    let second = cache.alloc_count() - base - first;
    assert_eq!(
        second, 0,
        "a second present at the SAME chain-buffer identity allocated {second} GPU \
         resources — the present-pass render loop is not zero-alloc (#1930)"
    );
}

/// A present against a DIFFERENT `chain_buf` identity (a pass-count parity flip,
/// or — after a session re-open — a brand new session's freshly-allocated
/// buffers) is a bounded MISS that rebuilds, never a silent stale reuse. And a
/// return to a previously-seen identity, once evicted, is ALSO a fresh miss
/// (this is a single-slot cache, not an unbounded per-identity map) — proving
/// the cache never binds a group to the WRONG buffer, only ever the CURRENT one.
#[test]
fn different_buffer_identity_forces_a_rebuild_not_a_stale_reuse() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (_pipeline, bgl) = build_present_pipeline(&ctx, wgpu::TextureFormat::Rgba8Unorm);
    let cache = PresentDispatchCache::new();
    let buf_a = make_chain_buf(&ctx, "chain-a");
    let buf_b = make_chain_buf(&ctx, "chain-b");

    let base = cache.alloc_count();
    let (_, bg_a1) = cache.get_or_build(&ctx, &bgl, &buf_a, (8, 8));
    let a1 = cache.alloc_count() - base;
    assert_eq!(a1, 2, "first build (buffer A) must allocate");

    // Switch to buffer B: the cache holds A's entry, so this MUST rebuild.
    let pre_b = cache.alloc_count();
    let (_, bg_b1) = cache.get_or_build(&ctx, &bgl, &buf_b, (8, 8));
    let b1 = cache.alloc_count() - pre_b;
    assert_eq!(
        b1, 2,
        "switching to a different chain-buffer identity must rebuild (2 allocs), \
         never silently reuse A's bind group for B's buffer"
    );
    assert!(
        !Arc::ptr_eq(&bg_a1, &bg_b1),
        "buffer A's and buffer B's bind groups must be DISTINCT objects"
    );

    // Back to A: the cache now holds B's entry, so this is ALSO a rebuild (not a
    // stale hit against the now-evicted A entry).
    let pre_a2 = cache.alloc_count();
    let (_, bg_a2) = cache.get_or_build(&ctx, &bgl, &buf_a, (8, 8));
    let a2 = cache.alloc_count() - pre_a2;
    assert_eq!(
        a2, 2,
        "returning to buffer A after B evicted it must rebuild, not reuse a stale entry"
    );
    assert!(
        !Arc::ptr_eq(&bg_a1, &bg_a2),
        "the rebuilt A dispatch must be a FRESH bind group, not A's original (evicted) one"
    );

    // And immediately re-presenting A again (now the freshly-cached entry) is a
    // zero-alloc hit, exactly like the steady-state case.
    let pre_a3 = cache.alloc_count();
    let _ = cache.get_or_build(&ctx, &bgl, &buf_a, (8, 8));
    let a3 = cache.alloc_count() - pre_a3;
    assert_eq!(a3, 0, "re-presenting the just-cached buffer must be zero-alloc");
}

/// `invalidate()` (called on a surface reconfigure — a format / bind-group-
/// layout change) must force the NEXT present to rebuild, even against the SAME
/// buffer identity that was previously cached — the old bind group is invalid
/// for a new layout regardless of which buffer it names.
#[test]
fn invalidate_forces_a_rebuild_on_the_same_identity() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (_pipeline, bgl) = build_present_pipeline(&ctx, wgpu::TextureFormat::Rgba8Unorm);
    let cache = PresentDispatchCache::new();
    let chain_buf = make_chain_buf(&ctx, "chain-a");

    let base = cache.alloc_count();
    let _ = cache.get_or_build(&ctx, &bgl, &chain_buf, (8, 8));
    let first = cache.alloc_count() - base;
    assert_eq!(first, 2);

    cache.invalidate();

    let pre = cache.alloc_count();
    let _ = cache.get_or_build(&ctx, &bgl, &chain_buf, (8, 8));
    let after_invalidate = cache.alloc_count() - pre;
    assert_eq!(
        after_invalidate, 2,
        "a present after invalidate() must rebuild even at the same buffer identity"
    );
}
