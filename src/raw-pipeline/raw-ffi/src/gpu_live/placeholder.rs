//! The canvas placeholder's `CAMetalLayer` present (#5758): the host's
//! decoded thumbnail or preview, drawn on the live canvas's own surface
//! before the photo's render lands, so the first chain present replaces it
//! in the same drawable.

use super::{ensure_context, present::lock_for_present};
use crate::error::{catch_panic_rc, set_last_error};
use raw_core::canvas::Size;
use raw_core::canvas_placeholder::{
    encode_placeholder, placeholder_surface_dims, PlaceholderColorSpace,
};
use raw_core::view::encode::TargetPrimaries;
use std::os::raw::c_void;

const RC_PLACEHOLDER_CANCELLED: i32 = 4;

/// Present an 8-bit RGBA still (`row_bytes` per row, alpha ignored) as the
/// canvas placeholder in `layer`. `source_color_space` is the still's
/// encoding (0 sRGB, 1 Display P3) and `target_primaries` the canvas's, as
/// for the live chain (0 sRGB, 1 Display P3); the still is re-encoded into
/// the chain's output encoding, then the chain's present pass resamples it
/// to a surface sized by fitting the still's aspect into
/// `viewport_width_px × viewport_height_px` (the still's own size while the
/// viewport is unknown, 0). The surface cache, `surface_generation` and
/// `layer` contract are `maple_gpu_present_chain`'s: the same surface, so
/// the live chain's next present replaces this frame in one drawable.
///
/// No live session is needed. The re-encode runs before the shared GPU lock
/// is taken, so it never holds up a slider present.
///
/// Returns 0 when presented. `4` when `cancel` was set first (the host's
/// live chain has started presenting), or set while the frame was in flight.
/// `-1` a null pointer or a malformed still, `-5` GPU init failed, `-4` the
/// present failed, `99` a contained panic.
///
/// # Safety
/// `rgba` valid for `(height - 1) × row_bytes + width × 4` bytes; `layer` a
/// valid `CAMetalLayer*` outliving the call (see `maple_gpu_present_chain`);
/// `cancel` null or a valid flag.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn maple_gpu_present_placeholder(
    rgba: *const u8,
    width: u32,
    height: u32,
    row_bytes: usize,
    source_color_space: u32,
    target_primaries: u32,
    viewport_width_px: f64,
    viewport_height_px: f64,
    layer: *mut c_void,
    cancel: *const crate::cancel::MapleCancelFlag,
    surface_generation: u64,
) -> i32 {
    if rgba.is_null() || layer.is_null() {
        set_last_error("gpu_present_placeholder: null pointer".into());
        return -1;
    }
    let edge_limit = raw_core::canvas_placeholder::PLACEHOLDER_MAX_EDGE;
    if width == 0
        || height == 0
        || width > edge_limit
        || height > edge_limit
        || row_bytes < width as usize * 4
    {
        set_last_error(format!(
            "gpu_present_placeholder: unusable size {width}x{height}"
        ));
        return -1;
    }
    let Some(len) = (height as usize)
        .checked_sub(1)
        .and_then(|rows| rows.checked_mul(row_bytes))
        .and_then(|bytes| bytes.checked_add(width as usize * 4))
        .filter(|&bytes| bytes <= isize::MAX as usize)
    else {
        set_last_error(format!(
            "gpu_present_placeholder: bad geometry {width}x{height} stride {row_bytes}"
        ));
        return -1;
    };
    let pixels = std::slice::from_raw_parts(rgba, len);
    let token = crate::cancel::gpu_token(cancel);
    if token.is_cancelled() {
        return RC_PLACEHOLDER_CANCELLED;
    }
    catch_panic_rc("gpu_present_placeholder", || {
        let mut texels = vec![[0.0f32; 4]; width as usize * height as usize];
        if let Err(error) = encode_placeholder(
            pixels,
            (width, height),
            row_bytes,
            PlaceholderColorSpace::from_u32(source_color_space),
            TargetPrimaries::from_u32(target_primaries),
            &mut texels,
        ) {
            set_last_error(format!("gpu_present_placeholder: {error:?}"));
            return -1;
        }
        let viewport = Size::new(viewport_width_px, viewport_height_px);
        let Some(surface) = placeholder_surface_dims((width, height), viewport) else {
            set_last_error("gpu_present_placeholder: empty still".into());
            return -1;
        };
        let mut shared = match lock_for_present(&token) {
            Ok(shared) => shared,
            Err(rc) => return rc,
        };
        if let Err(error) = ensure_context(&mut shared) {
            set_last_error(format!("gpu_present_placeholder: {error}"));
            return -5;
        }
        let state = shared.as_mut().expect("initialized above");
        if let Err(error) = raw_gpu::PlaceholderSource::upload(
            &state.ctx,
            &mut state.placeholder,
            &texels,
            (width, height),
        ) {
            set_last_error(format!("gpu_present_placeholder: {error}"));
            return -1;
        }
        let source = state.placeholder.as_ref().expect("uploaded above");
        // SAFETY: as `maple_gpu_present_chain` — `layer` is a valid
        // CAMetalLayer* per this fn's contract, keyed with the generation.
        match raw_gpu::present_placeholder_to_surface(
            &state.ctx,
            source,
            layer,
            &mut state.present_surface,
            surface_generation,
            surface,
            &token,
        ) {
            Ok(true) => 0,
            Ok(false) => RC_PLACEHOLDER_CANCELLED,
            Err(error) => {
                set_last_error(format!("gpu_present_placeholder present: {error}"));
                -4
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cancel::{maple_cancel_flag_free, maple_cancel_flag_new, maple_cancel_flag_set};

    /// Never dereferenced: every case returns before the layer is touched.
    fn unused_layer() -> *mut c_void {
        std::ptr::NonNull::<u8>::dangling().as_ptr().cast()
    }

    fn present(rgba: *const u8, dims: (u32, u32), row_bytes: usize, layer: *mut c_void) -> i32 {
        let cancel = maple_cancel_flag_new();
        unsafe {
            maple_cancel_flag_set(cancel);
            let rc = maple_gpu_present_placeholder(
                rgba, dims.0, dims.1, row_bytes, 0, 0, 1000.0, 800.0, layer, cancel, 0,
            );
            maple_cancel_flag_free(cancel);
            rc
        }
    }

    #[test]
    fn a_null_layer_or_still_is_refused() {
        let rgba = [0u8; 16];
        assert_eq!(present(rgba.as_ptr(), (2, 2), 8, std::ptr::null_mut()), -1);
        assert_eq!(present(std::ptr::null(), (2, 2), 8, unused_layer()), -1);
    }

    #[test]
    fn an_unusable_size_is_refused_before_reading_pixels() {
        let rgba = [0u8; 16];
        assert_eq!(present(rgba.as_ptr(), (0, 2), 8, unused_layer()), -1);
        assert_eq!(present(rgba.as_ptr(), (2, 0), 8, unused_layer()), -1);
        let too_wide = raw_core::canvas_placeholder::PLACEHOLDER_MAX_EDGE + 1;
        assert_eq!(
            present(
                rgba.as_ptr(),
                (too_wide, 1),
                too_wide as usize * 4,
                unused_layer()
            ),
            -1
        );
        assert_eq!(present(rgba.as_ptr(), (2, 2), 7, unused_layer()), -1);
        assert_eq!(
            present(rgba.as_ptr(), (2, 2), usize::MAX / 2, unused_layer()),
            -1
        );
    }

    #[test]
    fn a_cancelled_placeholder_is_dropped_before_the_gpu() {
        let rgba = [0u8; 16];
        assert_eq!(
            present(rgba.as_ptr(), (2, 2), 8, unused_layer()),
            RC_PLACEHOLDER_CANCELLED
        );
    }
}
