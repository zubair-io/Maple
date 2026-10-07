//! Integer crop/orthogonal-rotation mapping for native detail (#4317).
use super::{needs_apply, rect_in_pixels, snap_orthogonal, OrthogonalSnap};
use crate::{image::ExifOrientation, types::Crop};

pub struct NativeCropWindow {
    pub source: (u32, u32, u32, u32),
    pub orientation: ExifOrientation,
}

impl NativeCropWindow {
    pub fn supported(crop: &Crop) -> bool {
        !needs_apply(crop) || !matches!(snap_orthogonal(crop.angle), OrthogonalSnap::Off)
    }

    /// Rect is in cropped output coordinates; source is in the full oriented image.
    pub fn new(crop: &Crop, width: u32, height: u32, rect: (u32, u32, u32, u32)) -> Option<Self> {
        if width == 0 || height == 0 || !Self::supported(crop) {
            return None;
        }
        let (cx, cy, cw, ch) = if needs_apply(crop) {
            rect_in_pixels(crop, width, height)
        } else {
            (0, 0, width, height)
        };
        let orientation = if !needs_apply(crop) {
            ExifOrientation::Normal
        } else {
            match snap_orthogonal(crop.angle) {
                OrthogonalSnap::Zero => ExifOrientation::Normal,
                OrthogonalSnap::Cw90 => ExifOrientation::Rotate90,
                OrthogonalSnap::Cw180 => ExifOrientation::Rotate180,
                OrthogonalSnap::Cw270 => ExifOrientation::Rotate270,
                OrthogonalSnap::Off => return None,
            }
        };
        let (dw, dh) = if orientation.swaps_wh() {
            (ch, cw)
        } else {
            (cw, ch)
        };
        let (x, y, w, h) = rect;
        if w == 0 || h == 0 || x.checked_add(w)? > dw || y.checked_add(h)? > dh {
            return None;
        }
        let (sx, sy, sw, sh) = orientation.display_rect_to_sensor(x, y, w, h, cw, ch);
        Some(Self {
            source: (cx + sx, cy + sy, sw, sh),
            orientation,
        })
    }
}

#[cfg(test)]
#[path = "native_window_tests.rs"]
mod tests;
