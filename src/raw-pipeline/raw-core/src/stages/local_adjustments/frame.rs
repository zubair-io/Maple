//! Where a buffer pixel sits in the frame masks are authored in (#4426).
//!
//! Masks are normalised over the upright, EXIF-oriented whole frame. The
//! develop and tile chains run on SENSOR-framed buffers and orient last, so
//! each buffer pixel is first placed in the sensor frame (`origin + (x, y)`,
//! #1157) and then carried through the same pixel permutation
//! `image::apply_orientation` applies, before normalising by the ORIENTED
//! frame's extent. For `Normal` the sequence is exactly the pre-#4426
//! `(origin + x) as f32 * inv_w`, so an unrotated render is bit-identical.

use crate::image::ExifOrientation;

#[derive(Clone, Copy, Debug)]
pub(super) struct MaskFrame {
    /// Upright pixel = `linear · (origin + (x, y)) + offset`, each linear
    /// entry in {-1, 0, 1}: the orientation's pixel permutation as integer
    /// affine, so the per-pixel cost is branch-free and `Normal` stays the
    /// identity `(origin + x, origin + y)`.
    origin: (i32, i32),
    linear: [i32; 4],
    offset: (i32, i32),
    inv: (f32, f32),
}

/// `1 / (dim - 1)` so the first pixel maps to 0.0 and the last to 1.0 (mask
/// endpoints on image corners), and 0.0 for a single-pixel axis where that
/// denominator is undefined.
fn inv_extent(dim: u32) -> f32 {
    if dim > 1 {
        1.0 / (dim as f32 - 1.0)
    } else {
        0.0
    }
}

impl MaskFrame {
    /// `full` is the SENSOR-framed extent the buffer is a window of;
    /// `orientation` maps that frame onto the one masks are authored in.
    pub(super) fn new(origin: (i32, i32), full: (u32, u32), orientation: ExifOrientation) -> Self {
        let (display_w, display_h) = if orientation.swaps_wh() {
            (full.1, full.0)
        } else {
            full
        };
        let (last_x, last_y) = (full.0 as i32 - 1, full.1 as i32 - 1);
        let (linear, offset) = match orientation {
            ExifOrientation::Normal => ([1, 0, 0, 1], (0, 0)),
            ExifOrientation::HorizontalFlip => ([-1, 0, 0, 1], (last_x, 0)),
            ExifOrientation::Rotate180 => ([-1, 0, 0, -1], (last_x, last_y)),
            ExifOrientation::VerticalFlip => ([1, 0, 0, -1], (0, last_y)),
            ExifOrientation::Transpose => ([0, 1, 1, 0], (0, 0)),
            ExifOrientation::Rotate90 => ([0, -1, 1, 0], (last_y, 0)),
            ExifOrientation::Transverse => ([0, -1, -1, 0], (last_y, last_x)),
            ExifOrientation::Rotate270 => ([0, 1, -1, 0], (0, last_x)),
        };
        Self {
            origin,
            linear,
            offset,
            inv: (inv_extent(display_w), inv_extent(display_h)),
        }
    }

    /// The authored-frame normalised point for buffer pixel `(x, y)`.
    #[inline]
    pub(super) fn normalized(&self, x: usize, y: usize) -> (f32, f32) {
        let sx = self.origin.0 + x as i32;
        let sy = self.origin.1 + y as i32;
        let [a, b, c, d] = self.linear;
        let dx = a * sx + b * sy + self.offset.0;
        let dy = c * sx + d * sy + self.offset.1;
        (dx as f32 * self.inv.0, dy as f32 * self.inv.1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_orientation_matches_the_pixel_permutation_apply_orientation_uses() {
        let (w, h) = (7u32, 5u32);
        let ids: Vec<u32> = (0..w * h).flat_map(|i| [i; 3]).collect();
        for tag in 1..=8 {
            let orientation = ExifOrientation::from_u16(tag);
            let (dw, dh, oriented) = crate::image::apply_orientation(&ids, w, h, orientation);
            let frame = MaskFrame::new((0, 0), (w, h), orientation);
            for display_y in 0..dh {
                for display_x in 0..dw {
                    let id = oriented[((display_y * dw + display_x) * 3) as usize];
                    let (nx, ny) = frame.normalized((id % w) as usize, (id / w) as usize);
                    assert_eq!(
                        (nx, ny),
                        (
                            display_x as f32 * inv_extent(dw),
                            display_y as f32 * inv_extent(dh)
                        ),
                        "tag {tag} sensor id {id}"
                    );
                }
            }
        }
    }

    #[test]
    fn a_window_is_placed_in_the_sensor_frame_before_orienting() {
        let whole = MaskFrame::new((0, 0), (9, 4), ExifOrientation::Rotate90);
        let window = MaskFrame::new((3, -1), (9, 4), ExifOrientation::Rotate90);
        assert_eq!(window.normalized(2, 3), whole.normalized(5, 2));
    }
}
