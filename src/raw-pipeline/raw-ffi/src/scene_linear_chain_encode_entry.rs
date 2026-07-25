//! `maple_encode_display_srgb_f32` — the canonical display **encode** FFI
//! entry, split out of `scene_linear_chain.rs` for the 600-line hard budget
//! (#482 / #772 convention, the same reason `scene_linear_chain_f32_entry.rs`
//! is a sibling). Moved verbatim — no behaviour change. The `#[no_mangle]`
//! symbol is unaffected by module placement.

use crate::error::set_last_error;

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
#[no_mangle]
pub unsafe extern "C" fn maple_encode_display_srgb_f32(
    in_ptr: *const f32,
    width: u32,
    height: u32,
    out_ptr: *mut f32,
) -> i32 {
    if in_ptr.is_null() || out_ptr.is_null() {
        set_last_error("encode_display_srgb_f32: null pointer".into());
        return 1;
    }
    if width == 0 || height == 0 {
        set_last_error(format!(
            "encode_display_srgb_f32: zero dimension width={} height={}",
            width, height
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
                "encode_display_srgb_f32: pixel-count overflow width={} height={}",
                width, height
            ));
            return 3;
        }
    };

    let in_slice = std::slice::from_raw_parts(in_ptr, lanes);

    let out_vec = match raw_core::pipeline::encode_display_srgb_f32(in_slice, width, height) {
        Ok(v) => v,
        Err(e) => {
            set_last_error(format!("encode_display_srgb_f32: {}", e));
            return 8;
        }
    };
    if out_vec.len() != lanes {
        set_last_error(format!(
            "encode_display_srgb_f32: encode returned {} lanes, expected {}",
            out_vec.len(),
            lanes
        ));
        return 9;
    }

    let out_slice = std::slice::from_raw_parts_mut(out_ptr, lanes);
    out_slice.copy_from_slice(&out_vec);
    0
}
