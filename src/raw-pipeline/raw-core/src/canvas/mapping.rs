//! Viewport ↔ image mapping for one canvas snapshot: the fit and fill scales,
//! the on-screen frame, the two render-phase targets and the visible source
//! rect used for deep-zoom tiles.

use super::geometry::{Rect, Size};

/// Largest render-target edge any canvas target is clamped to: the texture
/// edge every shipping GPU accepts (Metal reports 16384; #2061).
pub const MAX_TEXTURE_EDGE: f64 = 16384.0;

/// The refine target never exceeds this multiple of the viewport long edge:
/// an uncapped `native × pixel_scale` refine on a 100 MP RAW was a ~1.4 GB f32
/// buffer that got iOS jetsam-killed (#1637).
const REFINE_HEADROOM: f64 = 2.0;

/// One canvas snapshot.
///
/// `viewport_px` is in real screen pixels, `native_image_size` in oriented
/// source pixels (`ZERO` until the image size is known), `pixel_scale` is real
/// pixels per image pixel with `0` = fit, `pan_offset` is in points (positive
/// = image dragged right/down), and `display_scale` converts points to pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CanvasMath {
    viewport_px: Size,
    native_image_size: Size,
    pixel_scale: f64,
    pan_offset: Size,
    display_scale: f64,
}

impl CanvasMath {
    /// Non-finite or negative sizes become `ZERO` (unknown), a non-finite or
    /// negative `pixel_scale` becomes fit, a non-finite pan component becomes
    /// zero, and a non-finite `display_scale` becomes zero (degenerate: the
    /// point-based outputs then report no frame).
    #[must_use]
    pub fn new(
        viewport_px: Size,
        native_image_size: Size,
        pixel_scale: f64,
        pan_offset: Size,
        display_scale: f64,
    ) -> Self {
        Self {
            viewport_px: viewport_px.sanitized_extent(),
            native_image_size: native_image_size.sanitized_extent(),
            pixel_scale: if pixel_scale.is_finite() && pixel_scale >= 0.0 {
                pixel_scale
            } else {
                0.0
            },
            pan_offset: pan_offset.sanitized_offset(),
            display_scale: if display_scale.is_finite() {
                display_scale
            } else {
                0.0
            },
        }
    }

    /// The native size when both axes are positive; `None` before the image
    /// size is known, so fit math never anchors to a preview-sized buffer.
    #[must_use]
    pub fn image_extent(&self) -> Option<Size> {
        let size = self.native_image_size;
        (size.width > 0.0 && size.height > 0.0).then_some(size)
    }

    fn viewport_is_positive(&self) -> bool {
        self.viewport_px.width > 0.0 && self.viewport_px.height > 0.0
    }

    /// Scale at which the whole image fits the viewport; `1` when the image
    /// or the viewport is unknown.
    #[must_use]
    pub fn fit_pixel_scale(&self) -> f64 {
        match self.image_extent() {
            Some(extent) if self.viewport_is_positive() => {
                (self.viewport_px.width / extent.width).min(self.viewport_px.height / extent.height)
            }
            _ => 1.0,
        }
    }

    /// Scale at which the image covers the whole viewport; `1` when the image
    /// or the viewport is unknown.
    #[must_use]
    pub fn fill_pixel_scale(&self) -> f64 {
        match self.image_extent() {
            Some(extent) if self.viewport_is_positive() => {
                (self.viewport_px.width / extent.width).max(self.viewport_px.height / extent.height)
            }
            _ => 1.0,
        }
    }

    /// `pixel_scale` with the `0 == fit` sentinel resolved.
    #[must_use]
    pub fn effective_pixel_scale(&self) -> f64 {
        if self.pixel_scale == 0.0 {
            self.fit_pixel_scale()
        } else {
            self.pixel_scale
        }
    }

    /// The image's on-screen frame in points; `None` until the image size is
    /// known or when `display_scale` is not positive.
    #[must_use]
    pub fn display_frame_in_points(&self) -> Option<Size> {
        let extent = self.image_extent()?;
        if self.display_scale <= 0.0 {
            return None;
        }
        let scale = self.effective_pixel_scale();
        Some(Size::new(
            extent.width * scale / self.display_scale,
            extent.height * scale / self.display_scale,
        ))
    }

    /// Fast-phase target: the viewport itself; `None` while it is unset.
    #[must_use]
    pub fn fast_target_size(&self) -> Option<Size> {
        (!self.viewport_px.is_zero()).then_some(self.viewport_px)
    }

    /// Refine-phase target: `native × min(pixel_scale, 1)`, never below the
    /// fast target and never above `REFINE_HEADROOM ×` the viewport long edge
    /// or `MAX_TEXTURE_EDGE`. Fit, and any scale below fit, therefore equal the
    /// fast target. Before the native size is known it is the fast target
    /// times `pixel_scale` within `1 … REFINE_HEADROOM`.
    #[must_use]
    pub fn refined_target_size(&self) -> Option<Size> {
        let fast = self.fast_target_size()?;
        if self.native_image_size.is_zero() {
            let multiplier = self.pixel_scale.clamp(1.0, REFINE_HEADROOM);
            return Some(Size::new(
                (fast.width * multiplier).min(MAX_TEXTURE_EDGE),
                (fast.height * multiplier).min(MAX_TEXTURE_EDGE),
            ));
        }
        let cap = (fast.width.max(fast.height) * REFINE_HEADROOM).min(MAX_TEXTURE_EDGE);
        let scale = self.pixel_scale.min(1.0);
        Some(Size::new(
            (self.native_image_size.width * scale)
                .max(fast.width)
                .min(cap),
            (self.native_image_size.height * scale)
                .max(fast.height)
                .min(cap),
        ))
    }

    /// The region of the oriented image on screen, in source pixels, clamped
    /// inside the image. The viewport centre maps to the image centre shifted
    /// opposite the pan. `Rect::ZERO` when the image, viewport, scale or
    /// display scale is degenerate.
    #[must_use]
    pub fn visible_source_rect(&self) -> Rect {
        let zoom = self.effective_pixel_scale();
        let extent = match self.image_extent() {
            Some(extent)
                if zoom > 0.0 && self.viewport_is_positive() && self.display_scale > 0.0 =>
            {
                extent
            }
            _ => return Rect::ZERO,
        };
        let visible_width = self.viewport_px.width / zoom;
        let visible_height = self.viewport_px.height / zoom;
        let centre_x = extent.width / 2.0 - self.pan_offset.width * self.display_scale / zoom;
        let centre_y = extent.height / 2.0 - self.pan_offset.height * self.display_scale / zoom;
        let max_origin_x = (extent.width - visible_width).max(0.0);
        let max_origin_y = (extent.height - visible_height).max(0.0);
        Rect {
            x: (centre_x - visible_width / 2.0).min(max_origin_x).max(0.0),
            y: (centre_y - visible_height / 2.0).min(max_origin_y).max(0.0),
            width: visible_width.min(extent.width),
            height: visible_height.min(extent.height),
        }
    }
}

#[cfg(test)]
#[path = "mapping_tests.rs"]
mod tests;
