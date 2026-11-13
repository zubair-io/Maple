//! #4738 (b): perspective warp for a host that runs the chain itself.
//!
//! raw-core's `render` applies `perspective` in `finish` (after develop and
//! orientation, before crop) and the GPU-live present warps per tick; a
//! host developing through the scene-linear FFI (Apple refine / export)
//! had no way to apply it, so every export silently dropped the
//! correction. Same `Perspective::inverse_matrix` + `warp_f32_rgba` the
//! core and the GPU parity tests use, on f32 RGBA.

use crate::error::set_last_error;
use raw_core::stages::perspective::{aspect_ratio, warp_f32_rgba, Homography, Perspective};

/// # Safety
/// `in_ptr`/`out_ptr` must each address `width * height * 4` `f32`s. The
/// seven scalars are the `perspective_*` model fields (`scale` is a
/// percentage; `100` is identity).
#[no_mangle]
pub unsafe extern "C" fn maple_apply_perspective_f32(
    in_ptr: *const f32,
    width: u32,
    height: u32,
    vertical: f32,
    horizontal: f32,
    rotate: f32,
    scale: f32,
    aspect: f32,
    x: f32,
    y: f32,
    out_ptr: *mut f32,
) -> i32 {
    crate::error::catch_panic_rc("maple_apply_perspective_f32", || {
        const CONTEXT: &str = "apply_perspective_f32";
        if in_ptr.is_null() || out_ptr.is_null() {
            set_last_error(format!("{CONTEXT}: null pointer"));
            return 1;
        }
        if width == 0 || height == 0 {
            set_last_error(format!(
                "{CONTEXT}: zero dimension width={width} height={height}"
            ));
            return 2;
        }
        let lanes = match (width as usize)
            .checked_mul(height as usize)
            .and_then(|p| p.checked_mul(4))
        {
            Some(n) => n,
            None => {
                set_last_error(format!(
                    "{CONTEXT}: pixel-count overflow width={width} height={height}"
                ));
                return 3;
            }
        };
        let input = std::slice::from_raw_parts(in_ptr, lanes);
        let output = std::slice::from_raw_parts_mut(out_ptr, lanes);
        let perspective = Perspective {
            vertical,
            horizontal,
            rotate,
            scale,
            aspect,
            x,
            y,
        };
        if perspective.is_identity() {
            output.copy_from_slice(input);
            return 0;
        }
        let inverse = perspective.inverse_matrix(aspect_ratio(width, height));
        if inverse == Homography::IDENTITY {
            output.copy_from_slice(input);
            return 0;
        }
        let warped = warp_f32_rgba(input, width, height, &inverse);
        if warped.len() != lanes {
            set_last_error(format!(
                "{CONTEXT}: warp returned {} lanes, expected {lanes}",
                warped.len()
            ));
            return 9;
        }
        output.copy_from_slice(&warped);
        0
    })
}
