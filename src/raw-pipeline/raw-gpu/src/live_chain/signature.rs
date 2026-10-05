//! The live pool's chain SIGNATURE (`chain_signature`), split out of
//! `live_chain.rs` to keep that module inside the file-size budget. Its
//! inputs are the same `FullChainInputs` and the same `active_mask` the
//! gating builder uses — nothing here is independent of that module.

use super::noop::{
    scene_tone_dispatch_shape, scene_tone_is_noop, tone_curves_is_noop, wb_is_noop, SLIDER_EPS,
};
use crate::color_grade::color_grade_is_identity;
use crate::display_tone_curve::display_tone_curve_is_identity;
use crate::full_chain::{hsl_pass_for, FullChainInputs, InputShape};
use crate::local_adjustments::local_adjustments_are_active;

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
///   fixed when present, gated via `active_mask` bit 20; the tone-curve slots are
///   `NUM_SLOTS × SLOT_STRIDE`-fixed; the AgX LUT is a const). Without it, a residual
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
    // …and, since #3407, each layer's SHAPE key: which controls are present
    // and which spatial kernels are engaged. Those decide how many passes
    // the stage contributes and how many pooled scratch buffers each draws,
    // so two models with the same layer COUNT can still need different
    // chains. Values still do not participate — see `layer_shape_key`.
    for layer in crate::local_adjustments::logical_layers(&inputs.local_adjustments) {
        // Group layout changes per-layer storage sizes even at an identical
        // total record count; pooled bindings must follow that split.
        layer.len().hash(&mut h);
        crate::local_spatial::layer_shape_key(layer).hash(&mut h);
    }
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

/// The active-stage bitmask — which gated passes [`super::build_live_split`] includes
/// for `inputs`, one bit per scene-linear stage (the view tail is always-on, so
/// it isn't represented). SINGLE-SOURCED with the builder: every bit uses the
/// exact same predicate the corresponding `if` in `build_live_split` uses, so the
/// mask can't disagree with which passes actually get pushed. Used by
/// [`chain_signature`] to key the live pool's bind-group cache.
pub(crate) fn active_mask(inputs: &FullChainInputs) -> u32 {
    let mut m = 0u32;
    let is_raw_shape = inputs.input_shape == InputShape::PostDcpRec2020Fp16;
    // Encode input_shape in the top 2 bits of the mask so a shape change lands
    // in a fresh pool bucket (different passes = different bind-group layouts).
    m |= ((inputs.input_shape as u32) & 0b11) << 30;
    // Bit 0: capture_sharpening — RAW-only (#1331); always 0 for non-RAW shapes.
    if is_raw_shape && inputs.capture_sharpening.is_some() {
        m |= 1 << 0;
    }
    // Bit 1: WB — engaged for ALL shapes when the slider is outside the skip
    // band (the builder now includes WB unconditionally for non-RAW too).
    if !wb_is_noop(inputs.wb_temperature, inputs.wb_tint) {
        m |= 1 << 1;
    }
    if !scene_tone_is_noop(&inputs.tone) {
        m |= 1 << 2;
    }
    if !tone_curves_is_noop(&inputs.tone_curves) {
        m |= 1 << 3;
    }
    if inputs.vibrance.abs() >= SLIDER_EPS {
        m |= 1 << 4;
    }
    if inputs.saturation.abs() >= SLIDER_EPS {
        m |= 1 << 5;
    }
    if !hsl_pass_for(inputs).is_noop() {
        m |= 1 << 15;
    }
    if inputs.clarity.abs() >= SLIDER_EPS {
        m |= 1 << 6;
    }
    if inputs.texture.abs() >= SLIDER_EPS {
        m |= 1 << 7;
    }
    if inputs.dehaze.abs() >= SLIDER_EPS {
        m |= 1 << 8;
    }
    if local_adjustments_are_active(&inputs.local_adjustments, inputs.scope.layer) {
        m |= 1 << 16;
    }
    // Bit 19: defringe (#3411) — same predicate as the `build_live_split` gate.
    if inputs.defringe.is_engaged() {
        m |= 1 << 19;
    }
    if inputs.vignette_amount.abs() >= SLIDER_EPS {
        m |= 1 << 9;
    }
    if inputs.sharpen_amount.abs() >= SLIDER_EPS {
        m |= 1 << 10;
    }
    if inputs.nr_luminance.abs() >= SLIDER_EPS {
        m |= 1 << 11;
    }
    if inputs.nr_color.abs() >= SLIDER_EPS {
        m |= 1 << 12;
    }
    if inputs.grain_amount.abs() >= SLIDER_EPS {
        m |= 1 << 13;
    }
    if !color_grade_is_identity(&crate::full_chain::color_grade_sliders(inputs)) {
        m |= 1 << 14;
    }
    // Bit 17: film look (epic #2683, Task 7) — loaded LUT + engaged strength.
    if inputs.film_lut_size > 0 && inputs.film_strength > SLIDER_EPS {
        m |= 1 << 17;
    }
    // Bit 18: display-referred tone curves (#2232).
    if !display_tone_curve_is_identity(&inputs.display_tone_curves) {
        m |= 1 << 18;
    }
    // Bit 20: Auto Profile curve pass (#4216) — RAW-only, engaged when host supplies
    // a curve of PROFILE_CURVE_FLAT_LEN.
    if is_raw_shape && inputs.profile_curve_flat.len() == crate::PROFILE_CURVE_FLAT_LEN {
        m |= 1 << 20;
    }
    m
}

// Compile-time guard: `active_mask` packs `input_shape` into the top 2 bits
// of a u32 (shift left by 30). That encoding supports at most 4 variants
// (discriminants 0–3). If a 5th variant (discriminant 4) is ever added, the
// shift would produce a value with bit 32 set, which is out-of-range for u32
// in debug (overflow panic) or silently truncated in release. The assert below
// turns that scenario into a compile error with a clear message instead.
// There is no `const fn` way to iterate an enum's discriminants in stable Rust,
// so we assert on the known highest discriminant value directly.
const _: () = assert!(
    InputShape::SrgbGammaEncoded8 as u32 <= 3,
    "InputShape has a variant with discriminant > 3; active_mask's 2-bit \
     `input_shape` pack in the top 2 bits of u32 (shift 30) would overflow. \
     Widen the encoding or increase the shift before adding a 5th variant."
);
