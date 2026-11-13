//! Display-P3 encode entries that run the Auto tail inside the encode (#4741).
//!
//! The Apple CoreImage path otherwise applies the Auto tail as an sRGB colour
//! cube after an sRGB encode, which caps a P3 canvas, patch or export at the
//! sRGB gamut. These entries take the composed curve∘residual lattice that cube
//! is baked from (`maple_compute_auto_profile_lut`) and return P3-encoded
//! pixels with the tail already applied; the host applies no cube afterwards.

use crate::error::set_last_error;
use crate::scene_linear_chain::MapleAdjustmentParams;
use crate::scene_linear_chain_curves::{MapleChainWindow, MapleToneCurves};
use crate::scene_linear_chain_curves_target::{chain_and_encode_target, DisplayEncode};
use raw_core::view::auto_profile::MAX_LUT_SIZE;

/// Borrow `lut_ptr` as an `n³ × 3` lattice, or set the error and return `None`.
///
/// # Safety
/// A non-null `lut_ptr` must address `lut_size³ * 3` readable f32 for `'a`.
unsafe fn borrow_lut<'a>(context: &str, lut_ptr: *const f32, lut_size: u32) -> Option<&'a [f32]> {
    let n = lut_size as usize;
    if lut_ptr.is_null() || !(2..=MAX_LUT_SIZE).contains(&n) {
        set_last_error(format!("{context}: invalid lattice (size {lut_size})"));
        return None;
    }
    Some(std::slice::from_raw_parts(lut_ptr, n.pow(3) * 3))
}

/// Encode `rendered` (display-linear Rec.2020 RGBA) to P3 with the tail.
pub(crate) fn encode_p3_auto(
    rendered: &[f32],
    width: u32,
    height: u32,
    lut: &[f32],
    lut_size: usize,
) -> raw_core::error::Result<Vec<f32>> {
    raw_core::pipeline::encode_display_p3_auto_f32(rendered, width, height, lut_size, lut)
}

/// Copy a finished encode to `out_ptr`, or set the error. Called only after
/// every borrow of the input has ended, so `out_ptr` may alias it.
///
/// # Safety
/// `out_ptr` must address `encoded.len()` writable f32 that no live borrow
/// aliases.
pub(crate) unsafe fn write_encoded(
    context: &str,
    encoded: raw_core::error::Result<Vec<f32>>,
    out_ptr: *mut f32,
) -> i32 {
    match encoded {
        Ok(encoded) => {
            std::slice::from_raw_parts_mut(out_ptr, encoded.len()).copy_from_slice(&encoded);
            0
        }
        Err(e) => {
            set_last_error(format!("{context}: {e}"));
            8
        }
    }
}

/// [`crate::scene_linear_chain::maple_encode_display_f32`] at Display P3 with
/// the Auto tail `lut` (`lut_size`³ RGB, layout `((b*n+g)*n+r)*3+c`) applied
/// gamut-preservingly. Returns P3-gamma-encoded f32 RGBA; alpha is 1.0.
///
/// Returns 0 on success; 1 null pointer or invalid lattice; 2 zero dimension;
/// 3 pixel-count overflow; 8 encode error (`maple_last_error` is set).
///
/// # Safety
/// `in_ptr` and `out_ptr` must each address `4 * width * height` f32 (they may
/// alias); `lut_ptr` must address `lut_size³ * 3` f32.
#[no_mangle]
pub unsafe extern "C" fn maple_encode_display_p3_auto_f32(
    in_ptr: *const f32,
    width: u32,
    height: u32,
    lut_ptr: *const f32,
    lut_size: u32,
    out_ptr: *mut f32,
) -> i32 {
    const CONTEXT: &str = "encode_display_p3_auto_f32";
    crate::error::catch_panic_rc("maple_encode_display_p3_auto_f32", || {
        if in_ptr.is_null() || out_ptr.is_null() {
            set_last_error(format!("{CONTEXT}: null pointer"));
            return 1;
        }
        let Some(lut) = borrow_lut(CONTEXT, lut_ptr, lut_size) else {
            return 1;
        };
        if width == 0 || height == 0 {
            set_last_error(format!(
                "{CONTEXT}: zero dimension width={width} height={height}"
            ));
            return 2;
        }
        let Some(lanes) = (width as usize)
            .checked_mul(height as usize)
            .and_then(|p| p.checked_mul(4))
        else {
            set_last_error(format!("{CONTEXT}: pixel-count overflow"));
            return 3;
        };
        let encoded = encode_p3_auto(
            std::slice::from_raw_parts(in_ptr, lanes),
            width,
            height,
            lut,
            lut_size as usize,
        );
        write_encoded(CONTEXT, encoded, out_ptr)
    })
}

/// The fused chain + P3 Auto encode: the chain of
/// `maple_apply_chain_and_encode_display_target_curves_f32` (or, with a
/// non-null `window`, of `maple_apply_chain_and_encode_display_target_window_f32`)
/// followed by [`maple_encode_display_p3_auto_f32`] in one call.
///
/// Returns as the target entries do, plus 1 for an invalid lattice.
///
/// # Safety
/// As `maple_apply_chain_and_encode_display_target_window_f32`, except that
/// `window` may be null (full frame); `lut_ptr` must address `lut_size³ * 3` f32.
#[no_mangle]
pub unsafe extern "C" fn maple_apply_chain_and_encode_display_p3_auto_f32(
    in_ptr: *const f32,
    width: u32,
    height: u32,
    params: *const MapleAdjustmentParams,
    curves: *const MapleToneCurves,
    lut_ptr: *const f32,
    lut_size: u32,
    window: *const MapleChainWindow,
    haze: *const crate::MapleHazeMap,
    out_ptr: *mut f32,
) -> i32 {
    crate::error::catch_panic_rc("maple_apply_chain_and_encode_display_p3_auto_f32", || {
        let Some(lut) = borrow_lut(
            "apply_chain_and_encode_display_p3_auto_f32",
            lut_ptr,
            lut_size,
        ) else {
            return 1;
        };
        chain_and_encode_target(
            in_ptr,
            width,
            height,
            params,
            curves,
            DisplayEncode::P3Auto {
                lut,
                lut_size: lut_size as usize,
            },
            out_ptr,
            window.as_ref().map(Into::into),
            haze,
        )
    })
}

#[cfg(test)]
#[path = "scene_linear_chain_p3_auto_tests.rs"]
mod tests;
