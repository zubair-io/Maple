//! `FramePool` — the dims/signature-keyed GPU-resource pool behind the live
//! render loop's zero-allocation invariant (epic #925, P4b-core / #1027).
//!
//! CLAUDE.md: "If a new feature adds allocation inside the render loop, it does
//! not ship." A second render at the same dims must allocate **zero** new GPU
//! buffers / bind groups. The pool makes that reachable: every per-dispatch
//! resource (the params uniform, the bind group, and a pass's scratch planes)
//! is created on the FIRST render of a given chain shape and **reused** on every
//! subsequent render of that shape.
//!
//! ## The signature key (the correctness landmine)
//!
//! A cached bind group references specific buffers and is built for one
//! pipeline's layout. Keying the cache by dispatch-sequence-index ALONE is
//! latently wrong: the instant a slider crosses a gating threshold (dehaze 0→0.5
//! — the whole point of the C1 gate), the pass set changes, dispatch *i* is now a
//! different kernel, and `cache[i]` would bind the wrong buffers / wrong layout.
//!
//! So the cache is keyed by the chain **signature** — the active-stage set + dims
//! + anything that changes the dispatch COUNT (capture-sharpening's iterations).
//! Within a fixed signature the dispatch sequence and its bindings are identical,
//! so sequence-indexed reuse is valid; a signature change lands in a fresh bucket
//! (allocating once for the new shape, zero thereafter). Param *values* don't
//! change the signature — only the uniform CONTENTS — so a normal slider drag
//! (same active set) stays zero-alloc: the pooled uniform is rewritten via
//! `queue.write_buffer` (not a counted allocation) while its buffer object, and
//! every bind group that references it, are reused. The signature is computed by
//! [`crate::live_chain::chain_signature`], single-sourced with the gating
//! predicates so it can't drift from which passes `build_live_chain` pushes.
//!
//! ## Rc, not Clone
//!
//! `wgpu::Buffer` / `BindGroup` are not `Clone` in wgpu 23 (the Arc-wrapping that
//! made them Clone landed in wgpu 24, and the 23 pin is load-bearing for the
//! `downlevel_defaults` ≤4-storage constraints). So the pool owns
//! [`std::rc::Rc`]`<wgpu::Buffer>` / `Rc<wgpu::BindGroup>` and hands out Rc clones
//! (a refcount bump, NOT a GPU allocation). `Rc` (not `Arc`) matches
//! [`GpuContext`]'s `!Send`/`!Sync` single-threaded-around-the-GPU design.
//!
//! ## Allocation accounting
//!
//! The only honest hook is the pool boundary: [`FramePool::alloc_count`] bumps a
//! counter when the pool actually calls `create_buffer` / `create_bind_group` (a
//! MISS), never on reuse. The zero-alloc test asserts the delta across a same-
//! signature re-render is 0 AND the first render's count was > 0 (non-vacuous).

use crate::context::GpuContext;
use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;

/// One cached dispatch's resources: the bind group + the params uniform it
/// references (so a slider drag can `write_buffer` fresh params into the same
/// buffer object), plus the storage buffers the bind group binds (held alive so
/// the cached bind group's internal references never dangle). Per-image data
/// buffers (curve / LUT / grid / AgX-LUT) ride `storage` — session-constant, so
/// caching them here both reuses and keeps them resident across ticks.
struct DispatchEntry {
    bind_group: Rc<wgpu::BindGroup>,
    uniform: Rc<wgpu::Buffer>,
    /// Identity of the pipeline this bind group was built for — `&ComputePipeline`
    /// pointer (the context owns each pipeline in a `OnceCell`, so its address is
    /// stable for the cache's lifetime, and distinct pipelines occupy distinct
    /// fields ⇒ distinct addresses). The bind group is built from the pipeline's
    /// AUTO layout (`get_bind_group_layout(0)`), which wgpu treats as EXCLUSIVE to
    /// that pipeline: binding it under a different pipeline is a validation error.
    /// So a cache hit at a cursor whose entry was built for a different pipeline
    /// must NOT be reused — see [`pool_dispatch`]'s identity guard.
    pipeline_id: usize,
    /// Storage buffers the bind group references (src/dst are NOT here — they're
    /// the session's persistent ping-pong pair, passed fresh each call but with
    /// stable identity per signature; the per-image DATA buffers ARE here, so
    /// they aren't re-uploaded on a cache hit).
    _data: Vec<Rc<wgpu::Buffer>>,
}

/// The per-signature cache bucket: dispatch entries indexed by their order within
/// the render, plus a pool of scratch planes (also order-indexed) the spatial
/// stages draw from. A monotonic cursor over each is rewound at frame start.
#[derive(Default)]
struct Bucket {
    dispatches: Vec<DispatchEntry>,
    scratch: Vec<Rc<wgpu::Buffer>>,
}

/// The dims/signature-keyed pool. Lives on [`GpuContext`] behind a `RefCell`
/// (interior mutability — `Pass::encode` only sees `&GpuContext`). Single render
/// in flight per context (ctx is `!Sync`), so the cursors are unambiguous.
#[derive(Default)]
pub struct FramePool {
    /// Per-signature buckets. The key is the chain signature
    /// ([`crate::live_chain::chain_signature`]).
    buckets: HashMap<u64, Bucket>,
    /// The active signature for the in-flight render (set by [`FramePool::begin_frame`]).
    current_sig: u64,
    /// Whether a frame is in flight (guards against a stray pooled alloc outside
    /// a `begin_frame` … render window — those fall back to a plain allocation).
    frame_active: bool,
    /// Monotonic dispatch cursor within the current frame (rewound at frame start).
    dispatch_cursor: usize,
    /// Monotonic scratch cursor within the current frame (rewound at frame start).
    scratch_cursor: usize,
    /// Count of ACTUAL `create_buffer` / `create_bind_group` calls (misses) — the
    /// allocation accounting hook. Never bumped on reuse.
    alloc_count: Cell<u64>,
}

impl FramePool {
    /// Begin a render for chain signature `sig`: select that signature's bucket
    /// and rewind the dispatch + scratch cursors so this render reuses the same
    /// resources the last render of `sig` created. Must be paired with
    /// [`FramePool::end_frame`].
    pub fn begin_frame(&mut self, sig: u64) {
        self.current_sig = sig;
        self.frame_active = true;
        self.dispatch_cursor = 0;
        self.scratch_cursor = 0;
        self.buckets.entry(sig).or_default();
    }

    /// End the in-flight render. (Cursors stay where they are until the next
    /// `begin_frame` rewinds them; this just clears the active flag so a stray
    /// out-of-frame alloc falls back to a plain create.)
    pub fn end_frame(&mut self) {
        self.frame_active = false;
    }

    /// Drop every cached bucket — used when a new [`crate::LiveSession`] is bound
    /// to this context. STALE-REFERENCE SAFETY: cached bind groups hold internal
    /// references to the SESSION's ping-pong buffers; a new session at the same
    /// dims (same signature) allocates fresh ping-pong buffers, so a bind group
    /// cached against the old (dropped) ones would dangle. Clearing the cache on
    /// session creation ties cache lifetime to the session's buffer lifetime. The
    /// hot path is ticks WITHIN one session (where the cache is fully live), not
    /// new-image churn, so the lost cross-session reuse costs nothing real.
    pub fn reset(&mut self) {
        self.buckets.clear();
        self.frame_active = false;
        self.dispatch_cursor = 0;
        self.scratch_cursor = 0;
        // `alloc_count` is intentionally NOT reset — it's a cumulative diagnostic
        // the zero-alloc test snapshots a delta across, so it must survive resets.
    }

    /// Total pool allocations (misses) so far — the honest zero-alloc hook. A
    /// same-signature re-render leaves this UNCHANGED.
    pub fn alloc_count(&self) -> u64 {
        self.alloc_count.get()
    }
}

/// Get-or-create the next pooled scratch plane of `byte_len` bytes for the
/// current frame's signature, advancing the scratch cursor. On the first render
/// of a signature the plane is created (an allocation); on subsequent same-
/// signature renders the same `Rc<Buffer>` is returned (zero allocation).
///
/// `make` builds the buffer on a miss; it is called ONLY on a miss, so a cache
/// hit does no `create_buffer`. The returned `Rc` is cheap to clone and outlives
/// the `RefCell` borrow (the caller holds it for the encoder's lifetime).
pub(crate) fn pool_scratch(
    ctx: &GpuContext,
    byte_len: u64,
    make: impl FnOnce(&wgpu::Device) -> wgpu::Buffer,
) -> Rc<wgpu::Buffer> {
    let mut pool = ctx.frame_pool.borrow_mut();
    if !pool.frame_active {
        // Outside a pooled render window (e.g. a stage unit test): plain alloc.
        pool.alloc_count.set(pool.alloc_count.get() + 1);
        return Rc::new(make(&ctx.device));
    }
    let sig = pool.current_sig;
    let cursor = pool.scratch_cursor;
    pool.scratch_cursor += 1;

    // Hit path: a cached plane at this cursor that's big enough (same-dims ⇒ same
    // size; a smaller cached plane can't happen within a fixed signature).
    if let Some(existing) = pool.buckets.get(&sig).and_then(|b| b.scratch.get(cursor)) {
        if existing.size() >= byte_len {
            return Rc::clone(existing);
        }
    }

    // Miss: create (count it), then store at the cursor (replacing any too-small
    // slot). The alloc-count bump happens before the bucket borrow so the `Cell`
    // and the `&mut buckets` don't overlap.
    let buf = Rc::new(make(&ctx.device));
    pool.alloc_count.set(pool.alloc_count.get() + 1);
    let bucket = pool.buckets.get_mut(&sig).expect("bucket created in begin_frame");
    if cursor < bucket.scratch.len() {
        bucket.scratch[cursor] = Rc::clone(&buf);
    } else {
        bucket.scratch.push(Rc::clone(&buf));
    }
    buf
}

/// A get-or-create result for a pooled dispatch's bind group: the bind group to
/// bind + the uniform buffer to (re)write the params into. On a cache hit the
/// `miss` closure is NOT called (so no buffers / bind group / data uploads
/// happen); the caller just `write_buffer`s fresh params into `uniform`.
pub(crate) struct PooledDispatch {
    pub bind_group: Rc<wgpu::BindGroup>,
    pub uniform: Rc<wgpu::Buffer>,
}

/// What a dispatch's `miss` closure produces: the freshly-created uniform, bind
/// group, and the per-image data buffers the bind group references (held alive).
pub(crate) struct DispatchResources {
    pub bind_group: wgpu::BindGroup,
    pub uniform: wgpu::Buffer,
    pub data: Vec<Rc<wgpu::Buffer>>,
}

/// Get-or-create the next pooled dispatch (bind group + uniform) for the current
/// frame's signature, advancing the dispatch cursor. `make` is called ONLY on a
/// miss — it builds the uniform + bind group + any per-image data buffers. On a
/// hit, the cached entry is returned and `make` never runs (zero allocation; the
/// data buffers stay resident via the cached entry).
///
/// The caller `write_buffer`s the current params into the returned `uniform`
/// before dispatching (cheap, not a counted alloc), so param VALUES update every
/// tick while the buffer object + bind group are reused.
pub(crate) fn pool_dispatch(
    ctx: &GpuContext,
    pipeline: &wgpu::ComputePipeline,
    make: impl FnOnce(&wgpu::Device) -> DispatchResources,
) -> PooledDispatch {
    // Identity of the pipeline this dispatch will bind under — used to reject a
    // cache hit whose entry was built for a DIFFERENT pipeline (see below).
    let pipeline_id = std::ptr::from_ref(pipeline) as usize;
    let mut pool = ctx.frame_pool.borrow_mut();
    if !pool.frame_active {
        // Outside a pooled window: plain alloc (no caching).
        let res = make(&ctx.device);
        pool.alloc_count.set(pool.alloc_count.get() + 2); // uniform + bind group
        return PooledDispatch {
            bind_group: Rc::new(res.bind_group),
            uniform: Rc::new(res.uniform),
        };
    }
    let sig = pool.current_sig;
    let cursor = pool.dispatch_cursor;
    pool.dispatch_cursor += 1;
    {
        let bucket = pool.buckets.get(&sig).expect("bucket created in begin_frame");
        if let Some(entry) = bucket.dispatches.get(cursor) {
            // Reuse ONLY when the cached entry was built for THIS pipeline. A bind
            // group derived from a pipeline's auto layout is EXCLUSIVE to that
            // pipeline, so if the dispatch sequence ever shifts under a stable
            // signature (a signature-completeness gap) and this cursor now binds a
            // different pipeline, returning the cached bind group is a wgpu
            // validation error that freezes the live canvas (#1667). On a
            // mismatch, fall through and rebuild for the correct pipeline — a
            // bounded extra allocation, never a hard failure.
            if entry.pipeline_id == pipeline_id {
                return PooledDispatch {
                    bind_group: Rc::clone(&entry.bind_group),
                    uniform: Rc::clone(&entry.uniform),
                };
            }
        }
    }
    // Miss (or pipeline mismatch): build everything, count the two creates, cache it.
    let res = make(&ctx.device);
    pool.alloc_count.set(pool.alloc_count.get() + 2);
    let bind_group = Rc::new(res.bind_group);
    let uniform = Rc::new(res.uniform);
    let entry = DispatchEntry {
        bind_group: Rc::clone(&bind_group),
        uniform: Rc::clone(&uniform),
        pipeline_id,
        _data: res.data,
    };
    let bucket = pool.buckets.get_mut(&sig).expect("bucket created in begin_frame");
    // A fresh cursor appends (the first render fills the Vec in dispatch order); a
    // pipeline-mismatch rebuild REPLACES the stale entry at an existing cursor.
    // Either way the Vec stays dispatch-indexed.
    debug_assert!(
        cursor <= bucket.dispatches.len(),
        "dispatch cursor past the append point"
    );
    if cursor < bucket.dispatches.len() {
        bucket.dispatches[cursor] = entry;
    } else {
        bucket.dispatches.push(entry);
    }
    PooledDispatch { bind_group, uniform }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "frame_pool_tests.rs"]
mod frame_pool_tests;
