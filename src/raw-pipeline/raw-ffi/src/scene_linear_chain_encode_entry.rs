//! `maple_encode_display_srgb_f32` / `maple_encode_display_f32` — the
//! canonical display **encode** FFI entries, split out of `scene_linear_chain.rs`
//! for the 600-line hard budget (#482 / #772 convention, the same reason
//! `scene_linear_chain_f32_entry.rs` is a sibling).
//!
//! `maple_encode_display_f32` (#3190) is the P3-aware sibling the Apple CPU
//! display path needs: `maple_apply_scene_linear_chain_f32` only runs its own
//! inline display-primary conversion when the caller's `target_primaries` is
//! non-`Srgb`, and the CPU path deliberately keeps that field pinned to
//! `Srgb` so the chain call NEVER does the conversion — otherwise a caller
//! that then also ran the (pre-#3190, sRGB-only) encode entry would convert
//! Rec.2020 → P3 in the chain call and then wrongly re-interpret that P3
//! buffer as Rec.2020 in the encode call, converting it a SECOND time (a
//! real color bug, not a toggle). Decoupling the target from
//! `MapleAdjustmentParams.target_primaries` and passing it explicitly to the
//! encode entry instead keeps the conversion to exactly once, wherever the
//! caller wants it to happen.

use crate::error::set_last_error;
use raw_core::view::encode::TargetPrimaries;

/// Shared body for both encode entries below — validates arguments, runs
/// `raw_core::pipeline::encode_display_f32` at `target`, and copies the
/// result into `out_ptr`. See [`maple_encode_display_f32`]'s doc for the
/// full stage description; `context` prefixes every `set_last_error` message
/// so a failure names the entry point that actually rejected the call.
///
/// # Safety
/// `in_ptr` and `out_ptr` must be valid for `4 * width * height` f32
/// reads/writes respectively (or null, checked below).
unsafe fn encode_display_inner(
    context: &str,
    in_ptr: *const f32,
    width: u32,
    height: u32,
    target: TargetPrimaries,
    out_ptr: *mut f32,
) -> i32 {
    if in_ptr.is_null() || out_ptr.is_null() {
        set_last_error(format!("{context}: null pointer"));
        return 1;
    }
    if width == 0 || height == 0 {
        set_last_error(format!(
            "{context}: zero dimension width={width} height={height}"
        ));
        return 2;
    }
    // Same checked-multiply guards as the chain entries — at u32::MAX dims the
    // RGBA lane product is ~2^66, which exceeds 64-bit usize. Without the
    // guards the unchecked product would wrap and feed nonsense to
    // from_raw_parts (UB).
    let lanes = match (width as usize)
        .checked_mul(height as usize)
        .and_then(|p| p.checked_mul(4))
    {
        Some(n) => n,
        None => {
            set_last_error(format!(
                "{context}: pixel-count overflow width={width} height={height}"
            ));
            return 3;
        }
    };

    let in_slice = std::slice::from_raw_parts(in_ptr, lanes);

    let out_vec = match raw_core::pipeline::encode_display_f32(in_slice, width, height, target) {
        Ok(v) => v,
        Err(e) => {
            set_last_error(format!("{context}: {e}"));
            return 8;
        }
    };
    if out_vec.len() != lanes {
        set_last_error(format!(
            "{context}: encode returned {} lanes, expected {lanes}",
            out_vec.len(),
        ));
        return 9;
    }

    let out_slice = std::slice::from_raw_parts_mut(out_ptr, lanes);
    out_slice.copy_from_slice(&out_vec);
    0
}

/// Apply the canonical display **encode** to a post-AgX **display-linear
/// Rec.2020** f32 RGBA buffer: hue-preserving Oklab gamut compression
/// (`rec2020_to_srgb`, #438) followed by `srgb_gamma_encode`. Returns
/// **sRGB-gamma-encoded sRGB-primary** f32 RGBA.
///
/// This is the exact pair of view-encode stages the CPU/CLI reference runs
/// between AgX and the Auto Profile cube (`agx → rec2020_to_srgb →
/// srgb_gamma_encode → auto_profile`). The Apple canvas previously reached
/// sRGB implicitly at the CoreImage `createCGImage` boundary, which does a
/// per-channel clamp of the Rec.2020→sRGB matrix output — NOT the Oklab
/// chroma compression — so saturated wide-gamut greens clipped and diverged
/// from the reference (#871 / #877). Routing the Apple encode through this
/// entry makes the canvas gamut-correct by construction (it shares raw-core's
/// reference math), and lands the buffer in the [0,1]³ sRGB-gamma-encoded
/// sRGB-primary space the Auto Profile cube was fit/baked in, so the cube
/// applies on the matching domain.
///
/// `in_ptr` and `out_ptr` MUST point to buffers of size
/// `16 * width * height` bytes (= `4 * width * height` f32 lanes). The caller
/// owns both buffers. Like the chain entries this performs one intermediate
/// heap allocation of the output size (the wrapped `raw_core` entry returns
/// an owned `Vec<f32>` copied into `out_ptr`). `out_ptr` may alias `in_ptr`.
///
/// Returns 0 on success, non-zero on error (call `maple_last_error`).
///
/// Kept as its own symbol (rather than retired in favor of
/// `maple_encode_display_f32` at a hardcoded `Srgb` target) per the
/// append-only FFI convention — existing callers keep compiling unchanged.
#[no_mangle]
pub unsafe extern "C" fn maple_encode_display_srgb_f32(
    in_ptr: *const f32,
    width: u32,
    height: u32,
    out_ptr: *mut f32,
) -> i32 {
    encode_display_inner(
        "encode_display_srgb_f32",
        in_ptr,
        width,
        height,
        TargetPrimaries::Srgb,
        out_ptr,
    )
}

/// P3-aware sibling of [`maple_encode_display_srgb_f32`] (#3190): identical
/// contract, plus `target_primaries` (`0` = sRGB, `1` = Display P3 —
/// `TargetPrimaries::from_u32`'s convention, matching `MapleAdjustmentParams`
/// / `MapleGpuLiveParams`) selecting which primaries' hull the Oklab gamut
/// compression targets. See the module doc for why this needs to be a
/// SEPARATE parameter from `MapleAdjustmentParams.target_primaries` rather
/// than reusing that field.
#[no_mangle]
pub unsafe extern "C" fn maple_encode_display_f32(
    in_ptr: *const f32,
    width: u32,
    height: u32,
    target_primaries: u32,
    out_ptr: *mut f32,
) -> i32 {
    encode_display_inner(
        "encode_display_f32",
        in_ptr,
        width,
        height,
        TargetPrimaries::from_u32(target_primaries),
        out_ptr,
    )
}
