//! EXIF-orientation helper for packed `[f32; 4]` RGBA buffers.
//!
//! Mirrors `apply_orientation` from `crate::image` (which works on
//! interleaved `u8` RGB) but operates on packed f32 RGBA so the
//! scene-linear FFI tail can rotate without quantising. The alpha lane is
//! always `1.0` in practice, but we copy it through for symmetry with
//! anything downstream that might want it.

/// Apply EXIF orientation to a packed `[f32; 4]` RGBA buffer (treated as
/// straight alpha — alpha lane is always 1.0 here, but we copy it through
/// for symmetry with the future development chain).
///
/// Mirrors `apply_orientation` from `image.rs:159-193`, just in fp32 RGBA
/// instead of u8 RGB. We reproduce the per-orientation source mapping
/// instead of going through u8 because the new path never quantizes.
pub(crate) fn apply_orientation_f32_rgba(
    rgba: &[f32],
    w: u32,
    h: u32,
    orient: crate::image::ExifOrientation,
) -> (u32, u32, Vec<f32>) {
    use crate::image::ExifOrientation;
    let (sw, sh) = (w as usize, h as usize);
    debug_assert_eq!(rgba.len(), sw * sh * 4, "RGBA f32 buffer size mismatch");
    if orient == ExifOrientation::Normal {
        return (w, h, rgba.to_vec());
    }
    let (new_w, new_h) = if orient.swaps_wh() { (h, w) } else { (w, h) };
    let (dw, dh) = (new_w as usize, new_h as usize);
    let mut out = vec![0.0f32; dw * dh * 4];
    for yp in 0..dh {
        for xp in 0..dw {
            let (sx, sy) = match orient {
                ExifOrientation::Normal => (xp, yp),
                ExifOrientation::HorizontalFlip => (sw - 1 - xp, yp),
                ExifOrientation::Rotate180 => (sw - 1 - xp, sh - 1 - yp),
                ExifOrientation::VerticalFlip => (xp, sh - 1 - yp),
                ExifOrientation::Transpose => (yp, xp),
                ExifOrientation::Rotate90 => (yp, sh - 1 - xp),
                ExifOrientation::Transverse => (sw - 1 - yp, sh - 1 - xp),
                ExifOrientation::Rotate270 => (sw - 1 - yp, xp),
            };
            let si = (sy * sw + sx) * 4;
            let di = (yp * dw + xp) * 4;
            out[di] = rgba[si];
            out[di + 1] = rgba[si + 1];
            out[di + 2] = rgba[si + 2];
            out[di + 3] = rgba[si + 3];
        }
    }
    (new_w, new_h, out)
}
