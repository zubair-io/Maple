//! Bounded shared panel reduction for Windows #3885. Hosts run this off the
//! UI/present path and publish it with its source frame's generation token.
use crate::error::{catch_panic_rc, set_last_error};
use raw_core::scope::panel::{reduce_panel, PANEL_VALUES};
use raw_core::scope::SCOPE_SNAPSHOT_MAX_DIM;

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
