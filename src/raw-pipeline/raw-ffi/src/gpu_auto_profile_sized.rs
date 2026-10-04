//! Explicit render-size calibration boundary (#4136 / #4120).
//! Windows host adoption is a separate delivery under #4120; this entry does
//! not change existing hosts' standalone calibration or decode policy.
use super::*;

/// Fit Auto Profile for the native renderer's explicitly sized develop.
/// `max_long_edge` must be nonzero and is interpreted identically to
/// `render_sized_from_raw_with_quality_and_source` (including caps above sensor
/// size). Live edits do not enter the fit model. Artifacts use the render-size
/// cache origin, separate from the legacy standalone fit.
///
/// All pointer, buffer, quality and return-code contracts match
/// `maple_gpu_fit_auto_profile`. Zero edge returns -1 without touching buffers.
/// A warm call reuses the decoded RAW and shared size-specific fit artifacts.
/// Never call the solver per slider tick; retain the returned host artifacts.
///
/// # Safety
/// `raw_path` must be a valid UTF-8 C string; `xmp_path` may be null.
/// `curve_out` must hold MAPLE_PROFILE_CURVE_FLAT_LEN aligned writable floats.
/// `lut_out` must hold `lut_capacity_floats` aligned writable floats.
/// `curve_present` and `lut_size` must be valid writable out-parameters.
#[no_mangle]
pub unsafe extern "C" fn maple_gpu_fit_auto_profile_at_render_size(
    raw_path: *const c_char,
    xmp_path: *const c_char,
    quality_preview: i32,
    max_long_edge: u32,
    curve_out: *mut f32,
    curve_present: *mut i32,
    lut_out: *mut f32,
    lut_capacity_floats: usize,
    lut_size: *mut u32,
) -> i32 {
    if max_long_edge == 0 {
        return -1;
    }
    fit_auto_profile(
        raw_path,
        xmp_path,
        quality_preview,
        curve_out,
        curve_present,
        lut_out,
        lut_capacity_floats,
        lut_size,
        FitCap::Render(max_long_edge),
    )
}

#[cfg(test)]
#[path = "gpu_auto_profile_sized_tests.rs"]
mod tests;
