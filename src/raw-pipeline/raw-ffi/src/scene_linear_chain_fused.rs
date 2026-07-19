//! Fused per-tick FFI entry (#2092, follow-on to #1959 / PR #2083).
//!
//! `ImageEditPipeline.processSceneLinear` (Apple, per slider tick) makes
//! TWO separate FFI round trips back to back: `applySceneLinearChainViaFFI`
//! (→ `maple_apply_scene_linear_chain_f32`) followed by
//! `encodeDisplaySRGBViaFFI` (→ `maple_encode_display_srgb_f32`). Between
//! the two Swift wraps the chain's output bytes into a `CIImage` and then
//! immediately renders that SAME CIImage back to bytes for the encode call
//! — a GPU wrap + CPU readback that exists only to cross the Swift/CoreImage
//! boundary twice for what is, from Rust's perspective, one straight-line
//! sequence of two pure-data transforms.
//!
//! This entry collapses that into a single call: run the two EXISTING FFI
//! entries back-to-back over one caller-provided input buffer, through one
//! Rust-owned intermediate buffer, into one caller-provided output buffer.
//! It deliberately calls `maple_apply_scene_linear_chain_f32` and
//! `maple_encode_display_srgb_f32` THEMSELVES (not a re-implementation of
//! their marshalling/math) so there is no way for this entry's output to
//! drift from the two-step Swift path — see `ChainFuseByteIdentityTests`
//! and the sibling Rust unit test in `scene_linear_chain_fused_tests.rs`
//! for the byte-identity proof.
//!
//! Swift-side use is gated to the case where NO intervening GPU stage sits
//! between the chain and the encode in `ImageEditPipeline` — see
//! `ImageEditPipeline.swift`'s `useFusedChainEncode` gate: `MetalKernels.
//! applySceneSharpen` / `applySceneNRColor` run between the two calls and
//! are non-identity whenever `sharpenAmount` / `nrColor` are non-zero, so
//! the fused path is used only when both are (numerically) zero. This
//! module makes no assumption about that — it is a pure function of its
//! inputs, unconditionally chain-then-encode, exactly mirroring what two
//! back-to-back Swift calls with no intervening stage would produce.

use crate::error::set_last_error;
use crate::scene_linear_chain::{
    maple_apply_scene_linear_chain_f32, maple_encode_display_srgb_f32, MapleAdjustmentParams,
};

/// Run the per-tick scene-linear chain (`maple_apply_scene_linear_chain_f32`)
/// and the display encode (`maple_encode_display_srgb_f32`) back-to-back
/// over a single input buffer, writing the final sRGB-gamma-encoded
/// sRGB-primary f32 RGBA result directly to `out_ptr` — no Swift-side
/// CIImage wrap/readback between the two stages.
///
/// `in_ptr` and `out_ptr` MUST point to buffers of size
/// `16 * width * height` bytes (= `4 * width * height` f32 lanes), same
/// layout as the two underlying entries (`extendedLinearITUR_2020` input,
/// sRGB-gamma-encoded sRGB-primary output). `out_ptr` may alias `in_ptr`
/// (the intermediate chain result is held in a Rust-owned buffer, so
/// aliasing the caller's in/out pointers is safe — unlike the two-step
/// entries, whose callers already treat aliasing as unsupported for that
/// same reason with a fresh output allocation each time).
///
/// Returns 0 on success. On failure, no new error CODES are introduced —
/// callers already branch on 1/2/3/8/9 for the two-step calls — but the
/// message provenance splits in two (PR #2095 review):
///
///   * Argument-validation failures (null pointer → 1, zero dimension → 2,
///     pixel-count overflow → 3) are caught by THIS entry's own guards
///     before either stage runs, so `maple_last_error()` carries a message
///     prefixed `apply_chain_and_encode_display_f32:` — the entry that
///     actually rejected the arguments names itself.
///   * Genuine stage failures (and any validation the inner entries do on
///     their own behalf) propagate the failing stage's rc AND its
///     `maple_last_error()` message verbatim — nothing here overwrites
///     them after the fact.
///
/// `out_ptr` is left unspecified (not necessarily untouched) on failure,
/// matching the two-step entries' existing contract.
#[no_mangle]
pub unsafe extern "C" fn maple_apply_chain_and_encode_display_f32(
    in_ptr: *const f32,
    width: u32,
    height: u32,
    params: *const MapleAdjustmentParams,
    out_ptr: *mut f32,
) -> i32 {
    if in_ptr.is_null() || params.is_null() || out_ptr.is_null() {
        set_last_error("apply_chain_and_encode_display_f32: null pointer".into());
        return 1;
    }
    if width == 0 || height == 0 {
        set_last_error(format!(
            "apply_chain_and_encode_display_f32: zero dimension width={} height={}",
            width, height
        ));
        return 2;
    }
    // Same checked-multiply guard as the two underlying entries — needed
    // here too because THIS function sizes the intermediate buffer before
    // handing it to the chain call.
    let lanes = match (width as usize)
        .checked_mul(height as usize)
        .and_then(|p| p.checked_mul(4))
    {
        Some(n) => n,
        None => {
            set_last_error(format!(
                "apply_chain_and_encode_display_f32: pixel-count overflow width={} height={}",
                width, height
            ));
            return 3;
        }
    };

    // Intermediate buffer: the chain's output / the encode's input. Owned
    // entirely by this call (never exposed to the caller), dropped when
    // this function returns. This is the ONE Rust-side allocation that
    // replaces the Swift-side CIImage wrap + CIContext.render readback the
    // two-step path pays per tick.
    //
    // Allocated UNINITIALIZED (capacity only, len 0) rather than
    // `vec![0f32; lanes]` — the zero-fill memset is ~33 MB per tick at the
    // 1920×1080 fast-phase viewport, pure waste on the hot path
    // (PR #2095 review). Written through the raw `as_mut_ptr()`, with
    // `set_len` deferred until the write is proven complete below.
    let mut intermediate: Vec<f32> = Vec::with_capacity(lanes);

    // Stage 1: the exact same chain entry the two-step path calls.
    //
    // SAFETY (uninitialized out-buffer): `maple_apply_scene_linear_chain_f32`
    // treats `out_ptr` as WRITE-ONLY — its single write is the final
    // `out_slice.copy_from_slice(&out_vec)` (a pure memcpy, no reads of the
    // destination), executed only AFTER validating `out_vec.len() == lanes`;
    // every earlier return leaves `out_ptr` untouched. Handing it
    // `lanes`-capacity uninitialized memory is therefore exactly the
    // C-ABI out-parameter contract that entry documents ("out_ptr MUST
    // point to buffers of size ... The caller owns both buffers") and
    // already serves for C/Swift callers, whose buffers are equally
    // arbitrary from Rust's perspective.
    let rc = maple_apply_scene_linear_chain_f32(
        in_ptr,
        width,
        height,
        params,
        intermediate.as_mut_ptr(),
    );
    if rc != 0 {
        // `maple_apply_scene_linear_chain_f32` already called
        // `set_last_error` with its own message; propagate its code as-is.
        // `intermediate` still has len 0 here — it drops without any of
        // its (possibly uninitialized) capacity ever being read.
        return rc;
    }
    // SAFETY: rc == 0 means the chain's `copy_from_slice` ran, which
    // requires it wrote ALL `lanes` lanes (it length-checks first and a
    // partial write is impossible — the only write is the full memcpy).
    // Every element in 0..lanes is therefore initialized, so exposing
    // them via `set_len` is sound. `lanes <= capacity` by construction
    // (`with_capacity(lanes)` above).
    unsafe { intermediate.set_len(lanes) };

    // Stage 2: the exact same encode entry the two-step path calls, fed
    // directly from the chain's output — no intervening wrap/readback.
    maple_encode_display_srgb_f32(intermediate.as_ptr(), width, height, out_ptr)
}
