//! Shared manual warp for a host's completed display-encoded CPU buffer (#2435).
use crate::error::{catch_panic_rc, set_last_error};
use raw_core::{
    image::ExifOrientation,
    stages::geometry::{self, Geometry, Transform},
};

/// Warp an opaque, display-oriented RGBA f32 buffer in place, before quantization.
/// Returns 0 on success, 1 for invalid input, or 99 for a contained panic.
/// Failure leaves the caller's pixels unchanged. Performs no allocation.
///
/// # Safety
/// Both pointers must address `width * height * 4` writable f32 lanes and
/// must not overlap. Scratch contents are unspecified after the call.
#[no_mangle]
pub unsafe extern "C" fn maple_apply_geometry_f32(
    pixels: *mut f32,
    scratch: *mut f32,
    width: u32,
    height: u32,
    perspective_h: f32,
    perspective_v: f32,
    rotation: f32,
    aspect: f32,
    scale: f32,
) -> i32 {
    let Some(lanes) = (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(4))
        .filter(|n| *n <= isize::MAX as usize / 4)
    else {
        set_last_error("manual geometry buffer size overflow".into());
        return 1;
    };
    if pixels.is_null() || scratch.is_null() || lanes == 0 {
        set_last_error("manual geometry requires a nonempty buffer".into());
        return 1;
    }
    if (pixels as usize).abs_diff(scratch as usize) < lanes * 4 {
        set_last_error("manual geometry buffers must not overlap".into());
        return 1;
    }
    let controls = Geometry {
        perspective_h,
        perspective_v,
        rotation,
        aspect,
        scale,
    };
    let inverse = match controls.inverse_sensor(width, height, ExifOrientation::Normal) {
        Ok(inverse) => inverse,
        Err(message) => {
            set_last_error(message.into());
            return 1;
        }
    };
    if inverse == Transform::IDENTITY {
        return 0;
    }
    catch_panic_rc("maple_apply_geometry_f32", || {
        let samples = std::slice::from_raw_parts_mut(pixels.cast::<[f32; 4]>(), lanes / 4);
        let output = std::slice::from_raw_parts_mut(scratch.cast::<[f32; 4]>(), lanes / 4);
        geometry::apply_into(samples, output, width as usize, height as usize, inverse);
        for (out, p) in samples.iter_mut().zip(output) {
            out.copy_from_slice(&[p[0], p[1], p[2], 1.0]);
        }
        0
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn overlapping_buffers_are_rejected_without_mutation() {
        let mut buffer = [0.1, 0.2, 0.3, 1.0];
        let original = buffer;
        let rc = unsafe {
            maple_apply_geometry_f32(
                buffer.as_mut_ptr(),
                buffer.as_mut_ptr(),
                1,
                1,
                0.0,
                0.0,
                180.0,
                1.0,
                1.0,
            )
        };
        assert_ne!(rc, 0);
        assert_eq!(buffer, original);
    }
    #[test]
    fn invalid_controls_leave_cpu_fallback_buffer_untouched() {
        let mut buffer = [0.1, 0.2, 0.3, 1.0];
        let original = buffer;
        let mut scratch = [0.0; 4];
        let rc = unsafe {
            maple_apply_geometry_f32(
                buffer.as_mut_ptr(),
                scratch.as_mut_ptr(),
                1,
                1,
                0.0,
                0.0,
                0.0,
                1.0,
                -1.0,
            )
        };
        assert_ne!(rc, 0);
        assert_eq!(buffer, original);
    }
    #[test]
    fn cpu_fallback_rotates_encoded_pixels_before_quantization() {
        let mut buffer = [0.1, 0.2, 0.3, 1.0, 0.4, 0.5, 0.6, 1.0];
        let mut scratch = [0.0; 8];
        let rc = unsafe {
            maple_apply_geometry_f32(
                buffer.as_mut_ptr(),
                scratch.as_mut_ptr(),
                2,
                1,
                0.0,
                0.0,
                180.0,
                1.0,
                1.0,
            )
        };
        assert_eq!(rc, 0);
        for (a, b) in buffer.iter().zip([0.4, 0.5, 0.6, 1.0, 0.1, 0.2, 0.3, 1.0]) {
            assert!((a - b).abs() < 1e-6);
        }
    }
}
