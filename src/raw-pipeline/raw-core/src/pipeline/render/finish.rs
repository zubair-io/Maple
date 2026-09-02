//! The geometry tail every display-referred render ends on: EXIF orientation,
//! then crop / straighten.
//!
//! Split out of `render/mod.rs` (#943) because export needs the identical tail
//! at 16-bit depth. Both steps are pure pixel movement — no colour arithmetic
//! survives past the quantizer — so one depth-generic implementation serves
//! the 8-bit canvas render and the 16-bit export master, and neither can
//! silently drift from the other's framing.

use super::stage;
use crate::{
    image::{apply_orientation, ExifOrientation},
    stages::crop::{self, Sample},
    types::Crop,
};

/// Orient into display framing, then apply the crop.
///
/// Orientation runs first and unconditionally (it is a cheap permutation and
/// keeps every upstream stage indifferent to sensor-vs-display framing); the
/// crop is skipped entirely when it is identity, so the parity-harness
/// baseline pays no extra allocation. Invalid rects are treated as identity.
///
/// `samples` is taken by value, not borrowed, so the fully-identity case
/// (`Normal` orientation, identity crop — every caller here already owns a
/// freshly quantized buffer it doesn't need afterward) can return it
/// straight back with no clone and no allocation at all, and a `Normal` +
/// real crop can crop directly out of the caller's own buffer instead of
/// cloning it first. Without this, `apply_orientation`'s `Normal` arm still
/// pays a full-buffer `to_vec()` (~27 ms at 100 MP,
/// `examples/tick-tail-bench.rs`) for a caller that had no use for a second
/// copy in the first place (#2486; the crop case caught by Copilot review
/// on the same PR).
pub(super) fn apply_geometry<T: Sample>(
    samples: Vec<T>,
    width: u32,
    height: u32,
    orientation: ExifOrientation,
    crop_rect: &Crop,
) -> (u32, u32, Vec<T>) {
    if orientation == ExifOrientation::Normal {
        return if crop_rect.is_identity() {
            (width, height, samples)
        } else {
            stage("crop", || {
                crop::apply_int_rgb(&samples, width, height, crop_rect)
            })
        };
    }
    let (w, h, oriented) = stage("apply_orientation", || {
        apply_orientation(&samples, width, height, orientation)
    });
    if crop_rect.is_identity() {
        return (w, h, oriented);
    }
    stage("crop", || crop::apply_int_rgb(&oriented, w, h, crop_rect))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 2×1 RGB pair, distinct per pixel so a swap is detectable.
    fn pair<T: Sample>(a: [T; 3], b: [T; 3]) -> Vec<T> {
        vec![a[0], a[1], a[2], b[0], b[1], b[2]]
    }

    #[test]
    fn identity_orientation_and_crop_pass_through_unchanged() {
        let src = pair::<u8>([10, 20, 30], [40, 50, 60]);
        let (w, h, out) =
            apply_geometry(src.clone(), 2, 1, ExifOrientation::Normal, &Crop::IDENTITY);
        assert_eq!((w, h), (2, 1));
        assert_eq!(out, src);
    }

    /// The fully-identity case (#2486) returns the caller's own allocation
    /// rather than a fresh one — checked by pointer identity, since the data
    /// equality case above wouldn't distinguish "same buffer" from "an equal
    /// clone of it".
    #[test]
    fn identity_case_reuses_the_input_allocation() {
        let src = pair::<u8>([10, 20, 30], [40, 50, 60]);
        let src_ptr = src.as_ptr();
        let (_, _, out) = apply_geometry(src, 2, 1, ExifOrientation::Normal, &Crop::IDENTITY);
        assert_eq!(
            out.as_ptr(),
            src_ptr,
            "expected the identity path to move, not clone"
        );
    }

    /// The whole point of the depth-generic tail: both depths must agree about
    /// where pixels land. Same geometry, same permutation, different samples.
    #[test]
    fn both_depths_permute_identically() {
        let eight = pair::<u8>([1, 2, 3], [4, 5, 6]);
        let sixteen = pair::<u16>([1, 2, 3], [4, 5, 6]);
        let (w8, h8, out8) =
            apply_geometry(eight, 2, 1, ExifOrientation::Rotate180, &Crop::IDENTITY);
        let (w16, h16, out16) =
            apply_geometry(sixteen, 2, 1, ExifOrientation::Rotate180, &Crop::IDENTITY);
        assert_eq!((w8, h8), (w16, h16));
        let widened: Vec<u16> = out8.iter().map(|&v| v as u16).collect();
        assert_eq!(widened, out16);
    }

    #[test]
    fn orientation_that_swaps_axes_reports_swapped_dims() {
        let src = pair::<u16>([1, 2, 3], [4, 5, 6]);
        let (w, h, out) = apply_geometry(src, 2, 1, ExifOrientation::Rotate90, &Crop::IDENTITY);
        assert_eq!((w, h), (1, 2));
        assert_eq!(out.len(), 6);
    }

    /// `Normal` orientation with a REAL crop (Copilot review on #3155):
    /// must crop directly out of the caller's buffer rather than paying
    /// `apply_orientation`'s `Normal`-arm `to_vec()` first. Checked by
    /// equivalence against calling `crop::apply_int_rgb` on the original
    /// samples directly — the two must agree exactly, since skipping the
    /// no-op orientation permutation must not change a single pixel.
    #[test]
    fn normal_orientation_with_real_crop_matches_cropping_directly() {
        let w = 4u32;
        let h = 4u32;
        let src: Vec<u8> = (0..(w * h * 3) as u8).collect();
        let crop = Crop {
            top: 0.25,
            left: 0.25,
            bottom: 0.75,
            right: 0.75,
            angle: 0.0,
        };
        let (gw, gh, geometry_out) =
            apply_geometry(src.clone(), w, h, ExifOrientation::Normal, &crop);
        let (cw, ch, crop_out) = crop::apply_int_rgb(&src, w, h, &crop);
        assert_eq!((gw, gh), (cw, ch));
        assert_eq!(geometry_out, crop_out);
    }
}
