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
/// Mirrors `image::apply_orientation`, just in fp32 RGBA instead of u8 RGB —
/// reproduces the per-orientation source mapping instead of going through
/// u8 because this path never quantizes — and shares its `transpose` module
/// (#2486) so the two don't drift on blocking/parallelization strategy.
pub(crate) fn apply_orientation_f32_rgba(
    rgba: &[f32],
    w: u32,
    h: u32,
    orient: crate::image::ExifOrientation,
) -> (u32, u32, Vec<f32>) {
    use crate::image::{transpose, ExifOrientation};
    let (sw, sh) = (w as usize, h as usize);
    debug_assert_eq!(rgba.len(), sw * sh * 4, "RGBA f32 buffer size mismatch");
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
        transpose::apply::<f32, 4>(rgba, sw, dw, dh, source_of)
    } else {
        transpose::scan::<f32, 4>(rgba, sw, dw, dh, source_of)
    };
    (new_w, new_h, out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::ExifOrientation;

    /// 2×3 RGBA fixture, R channel tags each pixel (G/B/A unused for the
    /// mapping check).
    fn tag_fixture_2x3() -> (u32, u32, Vec<f32>) {
        let tags = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0];
        let mut v = Vec::with_capacity(24);
        for t in tags {
            v.extend_from_slice(&[t, 0.0, 0.0, 1.0]);
        }
        (2, 3, v)
    }

    fn read_tags(rgba: &[f32]) -> Vec<f32> {
        rgba.chunks_exact(4).map(|c| c[0]).collect()
    }

    #[test]
    fn normal_is_identity() {
        let (w, h, rgba) = tag_fixture_2x3();
        let (nw, nh, out) = apply_orientation_f32_rgba(&rgba, w, h, ExifOrientation::Normal);
        assert_eq!((nw, nh), (w, h));
        assert_eq!(out, rgba);
    }

    /// Same 90° CW mapping the u8 RGB test in `image.rs` checks, so the two
    /// implementations are known to agree on this case.
    #[test]
    fn rotate90_matches_the_u8_sibling() {
        let (w, h, rgba) = tag_fixture_2x3();
        let (nw, nh, out) = apply_orientation_f32_rgba(&rgba, w, h, ExifOrientation::Rotate90);
        assert_eq!((nw, nh), (3, 2));
        assert_eq!(read_tags(&out), vec![5.0, 3.0, 1.0, 6.0, 4.0, 2.0]);
    }

    #[test]
    fn horizontal_flip_is_a_reflect_not_a_transpose() {
        let (w, h, rgba) = tag_fixture_2x3();
        let (nw, nh, out) =
            apply_orientation_f32_rgba(&rgba, w, h, ExifOrientation::HorizontalFlip);
        assert_eq!((nw, nh), (w, h));
        assert_eq!(read_tags(&out), vec![2.0, 1.0, 4.0, 3.0, 6.0, 5.0]);
    }
}
