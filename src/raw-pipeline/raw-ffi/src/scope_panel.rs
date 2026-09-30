//! Bounded shared panel reduction for Windows #3885. Hosts run this off the
//! UI/present path and publish it with its source frame's generation token.
use crate::error::{catch_panic_rc, set_last_error};
use raw_core::scope::panel::{reduce_panel, PANEL_VALUES};
use raw_core::scope::SCOPE_SNAPSHOT_MAX_DIM;

/// Collect scope data from the CPU renderer's final display-encoded RGBA f32
/// buffer, including any host-applied display LUT. No image-sized copy or
/// second develop pass; only bounded scope output is allocated.
/// Returns 0 on success, -1 for invalid input/capacity, 99 on panic.
///
/// # Safety
/// `rgba` is readable for `lanes` f32 values; `out` and its declared buffers
/// are writable and disjoint from input for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn maple_scope_from_display_f32(
    rgba: *const f32,
    lanes: usize,
    width: u32,
    height: u32,
    out: *mut crate::MapleScopeStats,
) -> i32 {
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(4));
    if rgba.is_null() || out.is_null() || width == 0 || height == 0 || expected != Some(lanes) {
        set_last_error("CPU scope: invalid display buffer".into());
        return -1;
    }
    if (*out).bins_ptr.is_null()
        || (*out).bins_len < 128 * 128
        || (*out).snapshot_ptr.is_null()
        || (*out).snapshot_len < SCOPE_SNAPSHOT_MAX_DIM * SCOPE_SNAPSHOT_MAX_DIM * 3
    {
        set_last_error("CPU scope: insufficient bounded output capacity".into());
        return -1;
    }
    catch_panic_rc("CPU scope", || {
        let encoded = std::slice::from_raw_parts(rgba, lanes);
        let hist = raw_core::scope::vectorscope_histogram_rgba(encoded, false);
        let snapshot = raw_core::scope::snapshot_rgba_f32(encoded, width, height);
        crate::scope_stats::write_stats(out, 1, hist.total, &hist.bins);
        crate::scope_stats::write_snapshot(out, snapshot.width, snapshot.height, &snapshot.rgb);
        0
    })
}

/// Reduce an RGB8 snapshot to 448 doubles: 64-bin R/G/B histogram counts,
/// then 64-column luma and R/G/B means. Returns 0 on success, -1 for invalid
/// input/capacity, 99 on panic. Errors leave the output unchanged.
///
/// # Safety
/// Non-null pointers must be valid for their declared lengths, with output
/// writable and disjoint from input. Null RGB is allowed only with zero length.
#[no_mangle]
pub unsafe extern "C" fn maple_scope_panel_reduce(
    rgb: *const u8,
    rgb_len: u32,
    width: u32,
    height: u32,
    out: *mut f64,
    out_len: u32,
) -> i32 {
    if (rgb.is_null() && rgb_len != 0) || out.is_null() || out_len < PANEL_VALUES as u32 {
        set_last_error("scope panel: invalid pointers or output capacity".into());
        return -1;
    }
    // Validate dimensions/length before constructing a foreign slice.
    if width > SCOPE_SNAPSHOT_MAX_DIM
        || height > SCOPE_SNAPSHOT_MAX_DIM
        || rgb_len as u64 != width as u64 * height as u64 * 3
    {
        set_last_error("scope panel: invalid bounded RGB snapshot dimensions".into());
        return -1;
    }
    catch_panic_rc("scope panel", || {
        let pixels = if rgb_len == 0 {
            &[]
        } else {
            std::slice::from_raw_parts(rgb, rgb_len as usize)
        };
        let mut values = [0.0; PANEL_VALUES];
        if let Err(error) = reduce_panel(pixels, width, height, &mut values) {
            set_last_error(error.into());
            return -1;
        }
        std::ptr::copy_nonoverlapping(values.as_ptr(), out, PANEL_VALUES);
        0
    })
}
