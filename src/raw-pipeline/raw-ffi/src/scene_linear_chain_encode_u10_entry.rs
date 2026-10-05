//! `maple_encode_display_u10` — the 10-bit display-encode FFI entry (#1626).
//!
//! Split out of `scene_linear_chain.rs` for the 600-line hard budget (the
//! same reason `scene_linear_chain_encode_entry.rs` is a sibling). The
//! f32 encode entries hand the caller a display-encoded f32 RGBA buffer the
//! host then quantizes itself (8-bit on every surface today); this entry
//! quantizes inside raw-core instead, returning packed 10-bit RGB triplets
//! (`0..=1023`) a 10-bit-capable surface (Apple `bgr10a2` / `rgba16Float`
//! `CAMetalLayer`) presents natively. The dithered 8-bit path stays the
//! universal fallback.

use crate::error::set_last_error;
use raw_core::view::encode::TargetPrimaries;

/// Apply the canonical display **encode** to a post-AgX **display-linear
/// Rec.2020** f32 RGBA buffer and quantize to 10-bit: hue-preserving Oklab
/// gamut compression against the target primaries' hull (`rec2020_to_display`,
/// #438 / #1337), `srgb_gamma_encode`, then blue-noise-dithered 10-bit
/// quantize (`dither_and_quantize_u10`, #1626).
///
/// This is `maple_encode_display_f32`'s terminal pack swapped from f32 RGBA
/// to u10 RGB — same encode math (it delegates to
/// `raw_core::pipeline::encode_display_u10_f32`, which wraps the reference
/// f32 encode), so the two entries cannot drift apart.
///
/// `in_ptr` MUST point to `16 * width * height` bytes (`4 * width * height`
/// f32 lanes, packed RGBA, alpha read but ignored); `out_ptr` MUST point to
/// `6 * width * height` bytes (`3 * width * height` u16 lanes, packed RGB,
/// every lane in `0..=1023`). The caller owns both buffers. Like the f32
/// sibling this entry performs one intermediate heap allocation of the output
/// size (the wrapped `raw_core` entry returns an owned `Vec<u16>` copied
/// into `out_ptr`).
///
/// `target_primaries` (`0` = sRGB, `1` = Display P3 —
/// `TargetPrimaries::from_u32`'s convention) selects which primaries' hull
/// the Oklab gamut compression targets — the same parameter as
/// `maple_encode_display_f32`, for the same exactly-once-conversion reason
/// (see `scene_linear_chain_encode_entry.rs`'s module doc).
///
/// Returns 0 on success, non-zero on error (call `maple_last_error`):
/// 1 = null pointer, 2 = zero dimension, 3 = pixel-count overflow,
/// 8 = encode failed, 9 = length mismatch — the same codes as the f32 entry.
#[no_mangle]
pub unsafe extern "C" fn maple_encode_display_u10(
    in_ptr: *const f32,
    width: u32,
    height: u32,
    target_primaries: u32,
    out_ptr: *mut u16,
) -> i32 {
    let context = "encode_display_u10";
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
    // Same checked-multiply guards as the f32 entry — the RGBA lane product
    // overflows 64-bit usize at u32::MAX dims. Input and output lane counts
    // differ here (4 lanes in, 3 lanes out), so both products are guarded.
    let in_lanes = match (width as usize)
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
    let out_lanes = match (width as usize)
        .checked_mul(height as usize)
        .and_then(|p| p.checked_mul(3))
    {
        Some(n) => n,
        None => {
            set_last_error(format!(
                "{context}: pixel-count overflow width={width} height={height}"
            ));
            return 3;
        }
    };

    let in_slice = std::slice::from_raw_parts(in_ptr, in_lanes);

    let out_vec = match raw_core::pipeline::encode_display_u10_f32(
        in_slice,
        width,
        height,
        TargetPrimaries::from_u32(target_primaries),
    ) {
        Ok(v) => v,
        Err(e) => {
            set_last_error(format!("{context}: {e}"));
            return 8;
        }
    };
    if out_vec.len() != out_lanes {
        set_last_error(format!(
            "{context}: encode returned {} lanes, expected {out_lanes}",
            out_vec.len(),
        ));
        return 9;
    }

    let out_slice = std::slice::from_raw_parts_mut(out_ptr, out_lanes);
    out_slice.copy_from_slice(&out_vec);
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Black in → all-zero triplets; white in → full-scale triplets. The
    /// dither cannot move either endpoint (black truncates to 0 from below,
    /// white clamps to 1023 from above), so both pin exactly.
    #[test]
    fn endpoints_hit_zero_and_full_scale_exactly() {
        let black_in = vec![0.0f32, 0.0, 0.0, 1.0];
        let mut black_out = vec![0u16; 3];
        let rc =
            unsafe { maple_encode_display_u10(black_in.as_ptr(), 1, 1, 0, black_out.as_mut_ptr()) };
        assert_eq!(rc, 0);
        assert_eq!(black_out, vec![0, 0, 0]);

        let white_in = vec![1.0f32, 1.0, 1.0, 1.0];
        let mut white_out = vec![0u16; 3];
        let rc =
            unsafe { maple_encode_display_u10(white_in.as_ptr(), 1, 1, 0, white_out.as_mut_ptr()) };
        assert_eq!(rc, 0);
        assert_eq!(white_out, vec![1023, 1023, 1023]);
    }

    /// Every output lane stays inside the 10-bit range on a saturated
    /// wide-gamut input, for both target primaries.
    #[test]
    fn lanes_stay_in_ten_bit_range_for_both_targets() {
        let input = vec![0.0f32, 0.8, 0.0, 1.0];
        for target in [0u32, 1u32] {
            let mut out = vec![0u16; 3];
            let rc =
                unsafe { maple_encode_display_u10(input.as_ptr(), 1, 1, target, out.as_mut_ptr()) };
            assert_eq!(rc, 0);
            for &lane in &out {
                assert!(lane <= 1023, "target {target}: lane {lane} out of range");
            }
        }
    }

    /// Null pointers → 1, zero dims → 2 — the same codes as the f32 entry.
    #[test]
    fn argument_validation_matches_f32_entry_codes() {
        let input = vec![0.0f32; 4];
        let mut out = vec![0u16; 3];
        let rc = unsafe { maple_encode_display_u10(std::ptr::null(), 1, 1, 0, out.as_mut_ptr()) };
        assert_eq!(rc, 1);
        let rc = unsafe { maple_encode_display_u10(input.as_ptr(), 1, 1, 0, std::ptr::null_mut()) };
        assert_eq!(rc, 1);
        let rc = unsafe { maple_encode_display_u10(input.as_ptr(), 0, 1, 0, out.as_mut_ptr()) };
        assert_eq!(rc, 2);
        let rc = unsafe { maple_encode_display_u10(input.as_ptr(), 1, 0, 0, out.as_mut_ptr()) };
        assert_eq!(rc, 2);
    }
}
