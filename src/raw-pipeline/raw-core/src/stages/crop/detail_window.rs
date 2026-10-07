//! Native crop windows, including the canonical encoded-RGB straighten sampler (#4317).
use super::{bilinear, rect_in_pixels, Crop, CropPresentation, NativeCropWindow};
use crate::{
    error::{Error, Result},
    CancelToken,
};

pub enum CropDetailWindow {
    Integer(NativeCropWindow),
    Straighten(StraightenWindow),
}

pub struct StraightenWindow {
    source: (u32, u32, u32, u32),
    full: (u32, u32),
    crop_origin: (u32, u32),
    output: (u32, u32, u32, u32),
    rotation: bilinear::RotationParams,
}

impl CropDetailWindow {
    pub fn new(crop: &Crop, width: u32, height: u32, rect: (u32, u32, u32, u32)) -> Option<Self> {
        if NativeCropWindow::supported(crop) {
            return NativeCropWindow::new(crop, width, height, rect).map(Self::Integer);
        }
        if width == 0 || height == 0 || width > i32::MAX as u32 || height > i32::MAX as u32 {
            return None;
        }
        let (x, y, w, h) = rect;
        let dims = CropPresentation::new(crop, width, height).dims;
        if w == 0 || h == 0 || x.checked_add(w)? > dims.0 || y.checked_add(h)? > dims.1 {
            return None;
        }
        let (cx, cy, _, _) = rect_in_pixels(crop, width, height);
        let rotation = bilinear::RotationParams::new(width, height, crop.angle);
        let corners = [
            (x, y),
            (x + w - 1, y),
            (x, y + h - 1),
            (x + w - 1, y + h - 1),
        ]
        .map(|(x, y)| rotation.source_pixel(cx, cy, x, y));
        if corners
            .iter()
            .any(|(x, y)| !x.is_finite() || !y.is_finite())
        {
            return None;
        }
        let [min_x, min_y, max_x, max_y] = corners.iter().fold(
            [
                f32::INFINITY,
                f32::INFINITY,
                f32::NEG_INFINITY,
                f32::NEG_INFINITY,
            ],
            |a, &(x, y)| [a[0].min(x), a[1].min(y), a[2].max(x), a[3].max(y)],
        );
        // Include interpolation neighbours and conservative f32 extremum rounding.
        let pad = (width.max(height) as f32 * f32::EPSILON * 8.0).ceil() as u32 + 2;
        let sx = (min_x.floor().max(0.0) as u32)
            .saturating_sub(pad)
            .min(width - 1);
        let sy = (min_y.floor().max(0.0) as u32)
            .saturating_sub(pad)
            .min(height - 1);
        let right = (max_x.ceil().max(0.0) as u32)
            .saturating_add(pad)
            .min(width)
            .max(sx + 1);
        let bottom = (max_y.ceil().max(0.0) as u32)
            .saturating_add(pad)
            .min(height)
            .max(sy + 1);
        Some(Self::Straighten(StraightenWindow {
            source: (sx, sy, right - sx, bottom - sy),
            full: (width, height),
            crop_origin: (cx, cy),
            output: rect,
            rotation,
        }))
    }

    pub fn source(&self) -> (u32, u32, u32, u32) {
        match self {
            Self::Integer(w) => w.source,
            Self::Straighten(w) => w.source,
        }
    }

    pub fn apply_rgb(&self, rgb: Vec<u8>, cancel: CancelToken<'_>) -> Result<(u32, u32, Vec<u8>)> {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let (sx, sy, sw, sh) = self.source();
        if rgb.len() as u64 != u64::from(sw) * u64::from(sh) * 3 {
            return Err(Error::Pipeline("crop detail source length mismatch".into()));
        }
        match self {
            Self::Integer(w) => Ok(crate::image::apply_orientation(&rgb, sw, sh, w.orientation)),
            Self::Straighten(w) => {
                let (x, y, width, height) = w.output;
                let mut output = vec![0; width as usize * height as usize * 3];
                for row in 0..height {
                    if cancel.is_cancelled() {
                        return Err(Error::Cancelled);
                    }
                    for col in 0..width {
                        let (px, py) = w.rotation.source_pixel(
                            w.crop_origin.0,
                            w.crop_origin.1,
                            x + col,
                            y + row,
                        );
                        let sample =
                            bilinear::sample_rgb_windowed(&rgb, sw, sh, (sx, sy), w.full, px, py);
                        let i = (row as usize * width as usize + col as usize) * 3;
                        output[i..i + 3].copy_from_slice(&sample);
                    }
                }
                Ok((width, height, output))
            }
        }
    }
}

#[cfg(test)]
#[path = "detail_window_tests.rs"]
mod tests;
