//! Byte-identity proof for #2486: the cache-blocked, rayon-parallel
//! `apply_orientation` must produce exactly the same output as the old
//! naive row-major implementation, for every `ExifOrientation`, at sizes
//! that straddle the transpose module's block boundary on both axes.
//!
//! `naive_apply_orientation` below is a frozen copy of `apply_orientation`
//! as it stood before #2486 (the single row-major loop with no blocking or
//! parallelism) — the oracle every orientation is hashed against.

use raw_core::image::{apply_orientation, ExifOrientation};

const ALL_ORIENTATIONS: [ExifOrientation; 8] = [
    ExifOrientation::Normal,
    ExifOrientation::HorizontalFlip,
    ExifOrientation::Rotate180,
    ExifOrientation::VerticalFlip,
    ExifOrientation::Transpose,
    ExifOrientation::Rotate90,
    ExifOrientation::Transverse,
    ExifOrientation::Rotate270,
];

/// Frozen pre-#2486 reference: plain row-major gather, no blocking.
fn naive_apply_orientation<T: Copy + Default>(
    rgb: &[T],
    w: u32,
    h: u32,
    orient: ExifOrientation,
) -> (u32, u32, Vec<T>) {
    let (sw, sh) = (w as usize, h as usize);
    if orient == ExifOrientation::Normal {
        return (w, h, rgb.to_vec());
    }
    let (new_w, new_h) = if orient.swaps_wh() { (h, w) } else { (w, h) };
    let (dw, dh) = (new_w as usize, new_h as usize);
    let mut out = vec![T::default(); dw * dh * 3];
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
            let si = (sy * sw + sx) * 3;
            let di = (yp * dw + xp) * 3;
            out[di] = rgb[si];
            out[di + 1] = rgb[si + 1];
            out[di + 2] = rgb[si + 2];
        }
    }
    (new_w, new_h, out)
}

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, &b| {
        (h ^ b as u64).wrapping_mul(0x1000_0000_01b3)
    })
}

/// Sizes chosen to straddle the transpose module's 64-pixel block edge on
/// both axes (63/64/65/200), plus a degenerate 1×1.
const SIZES: [(u32, u32); 5] = [(1, 1), (63, 65), (64, 64), (65, 63), (200, 130)];

#[test]
fn u8_output_is_byte_identical_to_the_pre_2486_reference() {
    for (w, h) in SIZES {
        let n = (w as usize) * (h as usize) * 3;
        let buf: Vec<u8> = (0..n).map(|i| (i % 251) as u8).collect();
        for orient in ALL_ORIENTATIONS {
            let (nw, nh, got) = apply_orientation(&buf, w, h, orient);
            let (ew, eh, want) = naive_apply_orientation(&buf, w, h, orient);
            assert_eq!((nw, nh), (ew, eh), "{w}x{h} {orient:?}: dims diverged");
            assert_eq!(
                fnv1a(&got),
                fnv1a(&want),
                "{w}x{h} {orient:?}: pixel hash diverged from the pre-#2486 reference"
            );
            assert_eq!(got, want, "{w}x{h} {orient:?}: pixel mismatch");
        }
    }
}

/// Same proof at 16-bit depth (the export master path), since
/// `apply_orientation` is generic over the sample type.
#[test]
fn u16_output_is_identical_to_the_pre_2486_reference() {
    for (w, h) in SIZES {
        let n = (w as usize) * (h as usize) * 3;
        let buf: Vec<u16> = (0..n).map(|i| (i % 65521) as u16).collect();
        for orient in ALL_ORIENTATIONS {
            let (nw, nh, got) = apply_orientation(&buf, w, h, orient);
            let (ew, eh, want) = naive_apply_orientation(&buf, w, h, orient);
            assert_eq!((nw, nh), (ew, eh), "{w}x{h} {orient:?}: dims diverged");
            assert_eq!(got, want, "{w}x{h} {orient:?}: pixel mismatch");
        }
    }
}
