use crate::error::set_last_error;
use raw_core::view::auto_profile::{lut::ColorLut, MAX_LUT_SIZE};

/// Applies the canonical display LUT in place, preserving alpha.
///
/// # Safety
/// `rgba` must address `rgba_len` writable floats and `lut` must address
/// `lut_len` readable floats for the duration of the call. The allocations
/// must be disjoint; dimensions and alignment are checked before access.
#[no_mangle]
pub unsafe extern "C" fn maple_apply_display_lut_rgba_f32(
    rgba: *mut f32,
    rgba_len: usize,
    lut: *const f32,
    lut_len: usize,
    size: u32,
) -> i32 {
    let size = size as usize;
    if rgba.is_null()
        || lut.is_null()
        || rgba_len % 4 != 0
        || rgba_len > isize::MAX as usize / std::mem::size_of::<f32>()
        || !(2..=MAX_LUT_SIZE).contains(&size)
        || lut_len != size * size * size * 3
    {
        set_last_error("invalid display LUT buffer or dimensions".into());
        return 1;
    }
    let rgba_start = rgba as usize;
    let lut_start = lut as usize;
    let rgba_end = rgba_start.checked_add(rgba_len * std::mem::size_of::<f32>());
    let lut_end = lut_start.checked_add(lut_len * std::mem::size_of::<f32>());
    let disjoint = match (rgba_end, lut_end) {
        (Some(a), Some(b)) => a <= lut_start || b <= rgba_start,
        _ => false,
    };
    if !disjoint
        || rgba_start % std::mem::align_of::<f32>() != 0
        || lut_start % std::mem::align_of::<f32>() != 0
    {
        set_last_error("display LUT buffers overlap or are unaligned".into());
        return 1;
    }
    let pixels = std::slice::from_raw_parts_mut(rgba, rgba_len);
    let grid = std::slice::from_raw_parts(lut, lut_len);
    for pixel in pixels.chunks_exact_mut(4) {
        let rgb = ColorLut::sample_grid(size, grid, [pixel[0], pixel[1], pixel[2]]);
        pixel[..3].copy_from_slice(&rgb);
    }
    0
}

#[cfg(test)]
#[path = "auto_profile_lut_apply_tests.rs"]
mod tests;
