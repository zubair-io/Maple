//! EXIF-orientation helper for packed `u8` RGBA rasters (#3505).
//!
//! `image::apply_orientation` is hard-wired to 3-channel RGB (it calls
//! `transpose::{apply,scan}::<T, 3>`), so `RasterImage::auto_orient` used to
//! route every image — RGBA included — through `to_rgb_bytes()` first,
//! silently dropping the alpha channel on the way through any non-identity
//! EXIF orientation. Mirrors `pipeline::orient::apply_orientation_f32_rgba`
//! (same per-orientation source mapping, `<T, 4>` instead of `<T, 3>`) so a
//! 4-channel raster keeps its alpha channel through every orientation.

use crate::image::{transpose, ExifOrientation};

/// Apply EXIF orientation to a packed `u8` RGBA buffer. Returns `(new_w,
/// new_h, rotated_samples)`, alpha bytes carried through untouched.
pub(crate) fn apply_orientation_rgba_u8(
    rgba: &[u8],
    w: u32,
    h: u32,
    orient: ExifOrientation,
) -> (u32, u32, Vec<u8>) {
    let (sw, sh) = (w as usize, h as usize);
    debug_assert_eq!(rgba.len(), sw * sh * 4, "RGBA buffer size mismatch");
    if orient == ExifOrientation::Normal {
        return (w, h, rgba.to_vec());
    }
    let (new_w, new_h) = if orient.swaps_wh() { (h, w) } else { (w, h) };
    let (dw, dh) = (new_w as usize, new_h as usize);
    let source_of = |xp: usize, yp: usize| match orient {
        ExifOrientation::Normal => (xp, yp),
        ExifOrientation::HorizontalFlip => (sw - 1 - xp, yp),
        ExifOrientation::Rotate180 => (sw - 1 - xp, sh - 1 - yp),
        ExifOrientation::VerticalFlip => (xp, sh - 1 - yp),
        ExifOrientation::Transpose => (yp, xp),
        ExifOrientation::Rotate90 => (yp, sh - 1 - xp),
        ExifOrientation::Transverse => (sw - 1 - yp, sh - 1 - xp),
        ExifOrientation::Rotate270 => (sw - 1 - yp, xp),
    };
    let out = if orient.swaps_wh() {
        transpose::apply::<u8, 4>(rgba, sw, dw, dh, source_of)
    } else {
        transpose::scan::<u8, 4>(rgba, sw, dw, dh, source_of)
    };
    (new_w, new_h, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2×1 RGBA: pixel (0,0) opaque red, pixel (1,0) half-transparent blue.
    fn fixture_2x1() -> (u32, u32, Vec<u8>) {
        (
            2,
            1,
            vec![
                255, 0, 0, 255, // (0,0) opaque red
                0, 0, 255, 128, // (1,0) half-transparent blue
            ],
        )
    }

    #[test]
    fn normal_is_identity() {
        let (w, h, rgba) = fixture_2x1();
        let (nw, nh, out) = apply_orientation_rgba_u8(&rgba, w, h, ExifOrientation::Normal);
        assert_eq!((nw, nh), (w, h));
        assert_eq!(out, rgba);
    }

    /// Orientation 6 (Rotate90) on a 2×1 image yields a 1×2 image with row 0
    /// = the source's leftmost column, row 1 = the source's rightmost column
    /// (same per-orientation source mapping as the RGB and f32-RGBA
    /// siblings — verified against `rotate90_matches_the_u8_sibling` in
    /// `pipeline::orient`) — i.e. the opaque red pixel comes first, and the
    /// half-transparent blue pixel's alpha byte survives untouched.
    #[test]
    fn rotate90_keeps_alpha_channel_and_swaps_dims() {
        let (w, h, rgba) = fixture_2x1();
        let (nw, nh, out) = apply_orientation_rgba_u8(&rgba, w, h, ExifOrientation::Rotate90);
        assert_eq!((nw, nh), (1, 2));
        assert_eq!(out.len(), 8);
        assert_eq!(&out[0..4], &[255, 0, 0, 255], "row 0: opaque red");
        assert_eq!(
            &out[4..8],
            &[0, 0, 255, 128],
            "row 1: half-transparent blue"
        );
    }
}
