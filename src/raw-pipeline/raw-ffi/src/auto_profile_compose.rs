use crate::error::catch_panic_rc;
use raw_core::view::auto_profile::{
    bake_auto_profile_lut, bake_profile_lut, lut::ColorLut, ProfileCurve, MAX_LUT_SIZE,
    PROFILE_CURVE_FLAT_LEN,
};

/// Compose the host's retained Auto Profile artifacts using shared-core math (#4138).
/// Omit a stage with a null pointer and zero length/size. Returns 0 on success,
/// 1 when both stages are absent, -1 for invalid input, -2 for insufficient
/// output capacity, or 99 for a caught panic. Output is untouched on error.
/// Bake once per fit; retain the cube across slider ticks. Windows adoption
/// and integrated color/performance qualification remain tracked by #4120.
///
/// # Safety
/// Nonnull inputs must address the specified readable floats; `out` must
/// address `out_capacity_floats` writable floats. Buffers must remain valid
/// throughout this synchronous call. Alignment and dimensions are checked.
/// Output may overlap either input: all input reads finish before publication.
#[no_mangle]
pub unsafe extern "C" fn maple_compose_auto_profile_lut(
    curve: *const f32,
    curve_len: usize,
    residual: *const f32,
    residual_len: usize,
    residual_size: u32,
    size: u32,
    out: *mut f32,
    out_capacity_floats: usize,
) -> i32 {
    catch_panic_rc("maple_compose_auto_profile_lut", || {
        let size = size as usize;
        let residual_size = residual_size as usize;
        let aligned = |pointer: usize| pointer % std::mem::align_of::<f32>() == 0;
        if out.is_null() || !aligned(out as usize) || !(2..=MAX_LUT_SIZE).contains(&size) {
            return -1;
        }
        let no_curve = curve.is_null() && curve_len == 0;
        let no_residual = residual.is_null() && residual_len == 0 && residual_size == 0;
        if (!no_curve
            && (curve.is_null() || !aligned(curve as usize) || curve_len != PROFILE_CURVE_FLAT_LEN))
            || (!no_residual
                && (residual.is_null()
                    || !aligned(residual as usize)
                    || !(2..=MAX_LUT_SIZE).contains(&residual_size)
                    || Some(residual_len)
                        != residual_size.checked_pow(3).and_then(|n| n.checked_mul(3))))
        {
            return -1;
        }
        if no_curve && no_residual {
            return 1;
        }
        let Some(required) = size.checked_pow(3).and_then(|n| n.checked_mul(3)) else {
            return -1;
        };
        if out_capacity_floats < required {
            return -2;
        }
        let parsed = if no_curve {
            ProfileCurve::identity()
        } else {
            let flat = std::slice::from_raw_parts(curve, curve_len);
            if !flat.iter().all(|value| value.is_finite()) {
                return -1;
            }
            match ProfileCurve::from_flat(flat) {
                Some(parsed) => parsed,
                None => return -1,
            }
        };
        let cube = if no_residual {
            bake_profile_lut(&parsed, size)
        } else {
            let data = std::slice::from_raw_parts(residual, residual_len);
            if !data.iter().all(|value| value.is_finite()) {
                return -1;
            }
            let residual = ColorLut {
                size: residual_size,
                data: data.to_vec(),
            };
            if no_curve {
                // An absent curve must skip its highlight soft knee (#4212).
                let mut cube = ColorLut::identity(size).data;
                residual.apply(&mut cube);
                cube
            } else {
                bake_auto_profile_lut(&parsed, &residual, size)
            }
        };
        if cube.len() != required {
            return -1;
        }
        std::ptr::copy_nonoverlapping(cube.as_ptr(), out, required);
        0
    })
}

#[cfg(test)]
#[path = "auto_profile_compose_tests.rs"]
mod tests;
