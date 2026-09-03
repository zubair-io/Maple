//! The live pool's chain SIGNATURE (`chain_signature`), split out of
//! `live_chain.rs` to keep that module inside the file-size budget. Its
//! inputs are the same `FullChainInputs` and the same `active_mask` the
//! gating builder uses — nothing here is independent of that module.

use super::active_mask;
use super::noop::scene_tone_dispatch_shape;
use crate::full_chain::FullChainInputs;

/// The chain SIGNATURE for the live pool ([`crate::frame_pool`]): a hash of the
/// SESSION identity + the active-stage mask + the render dims + anything that
/// changes the DISPATCH SEQUENCE within an active stage. The pool keys its
/// bind-group / scratch cache by this, so two renders with the same signature
/// share resources (zero alloc on the second) while a signature change (a
/// slider crossing a gating threshold, a dims change, a different
/// capture-sharpening iteration count, or a DIFFERENT SESSION) lands in a fresh
/// bucket — never binding a stale buffer to the wrong kernel.
///
/// ## Session-identity salt (#1929)
///
/// `session_id` is a value unique to the calling [`crate::LiveSession`] (see
/// [`crate::LiveSession`]'s internal counter). On Apple, [`crate::GpuContext`] —
/// and therefore the [`crate::frame_pool::FramePool`] this signature keys — is a
/// PROCESS-WIDE static shared across every live session (`GpuShared` in
/// `raw-ffi`), not per-session. Without a session-unique component, two
/// sequentially-interleaved OPEN sessions of matching dims/active-mask (e.g. an
/// old `EditSession` tearing down while a new one's first present races it, or a
/// fast-preview session live alongside a refine session) would hash to the SAME
/// bucket: `LiveSession::new` resets the pool as a stale-CLOSED-session guard,
/// but that reset only protects against a session that has already gone away —
/// it does nothing once a SECOND session starts rendering into the same
/// (now-shared) bucket a first, still-open session already populated. A
/// subsequent render on the first session would then hit a bind group built
/// (and forever bound, per wgpu's immutable bind groups) against the SECOND
/// session's ping-pong buffers, silently corrupting its output. Salting the
/// signature with the session's own identity means two sessions NEVER share a
/// bucket, matching or not, so this cross-session collision can't happen.
///
/// Dispatch-count drivers folded in beyond the on/off mask:
/// - **scene-tone dispatch shape**: highlights/shadows replace the one-dispatch
///   point path with a masked luma/blur DAG, while pre/post point steps are
///   independently gated. Reusing a point-path bucket for a masked path can bind
///   the shadow mask to another stage's scratch buffers.
/// - **capture-sharpening `iterations`**: its encode loop is `for _ in
///   0..iterations`, so a different count = a different dispatch sequence.
/// - NLM's shift-loop count is a CONST per pass (`LUMA_SEARCH_RADIUS` /
///   `CHROMA_SEARCH_RADIUS`), captured by the nr_luminance / nr_color mask bits —
///   no extra field needed. The box-blur sweeps and dehaze's DAG are fixed once
///   their stage is active.
///
/// Pooled-data-buffer SIZE drivers folded in (#1079):
/// - **`residual_lut_size`**: the residual-LUT pass's pooled storage buffer is
///   `size³·3` floats — the ONE pooled data buffer whose byte length can vary at
///   a constant active mask (the Auto Profile curve is `PROFILE_CURVE_FLAT_LEN`-
///   fixed, the tone-curve slots are `NUM_SLOTS × SLOT_STRIDE`-fixed, the AgX
///   LUT is a const). Without it, a residual LUT GROWING mid-session would make
///   `pool_scratch` replace the too-small buffer while the cached bind group at
///   the same signature kept referencing the OLD one — the dispatch would read
///   stale LUT data. Folding the size in lands the new shape in a fresh bucket.
pub fn chain_signature(inputs: &FullChainInputs, dims: (u32, u32), session_id: u64) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    // Session salt FIRST (#1929) — two sessions never share a bucket regardless
    // of how their mask/dims/dispatch-count components happen to collide.
    session_id.hash(&mut h);
    active_mask(inputs).hash(&mut h);
    dims.0.hash(&mut h);
    dims.1.hash(&mut h);
    scene_tone_dispatch_shape(&inputs.tone).hash(&mut h);
    // Capture-sharpening iterations drive the RL dispatch-loop length.
    let cs_iters = inputs
        .capture_sharpening
        .as_ref()
        .map(|p| p.iterations)
        .unwrap_or(0);
    cs_iters.hash(&mut h);
    // The residual-LUT edge drives the pooled grid buffer's byte length (#1079).
    // Hash as u64 so the signature is stable across usize widths.
    (inputs.residual_lut_size as u64).hash(&mut h);
    // The film LUT's CONTENT identity (epic #2683, Task 7): `active_mask`
    // only tells us a look is on/off, not WHICH look — switching to a
    // different look at a constant mask/strength-band would otherwise reuse
    // a cached bind group still pointing at the OLD grid buffer. `film_lut_size`
    // additionally covers a different-sized grid replacing the pooled buffer
    // (same shape as the `residual_lut_size` fold above).
    (inputs.film_lut_key as u64).hash(&mut h);
    (inputs.film_lut_size as u64).hash(&mut h);
    // The local-adjustment LAYER COUNT is the second pooled data buffer whose
    // byte length can vary at a constant active mask (#1698): adding a layer
    // mid-session would otherwise leave the cached bind group at this signature
    // pointing at the replaced, too-small buffer. The per-layer VALUES
    // deliberately do not participate — a mask drag rewrites a same-sized one.
    (inputs.local_adjustments.len() as u64).hash(&mut h);
    // The mask-plane TOTAL FLOAT COUNT (#3271) is the third such buffer: a
    // bitmap mask being added, removed, or resized (a different Vision
    // selection on the same session) changes `LocalAdjustmentsPass::new`'s
    // concatenated plane length independent of the layer count above. Per-
    // pixel VALUES deliberately do not participate — the same reasoning as
    // the layer stack: identical dims/id at a new weight is a same-sized
    // buffer, and hashing megapixel content here would defeat the point of a
    // cheap signature.
    let plane_len: u64 = inputs
        .mask_rasters
        .iter()
        .map(|r| r.data.len() as u64)
        .sum();
    plane_len.hash(&mut h);
    h.finish()
}
