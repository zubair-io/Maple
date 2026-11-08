//! The per-call geometry every zoom transition resolves against.

use super::geometry::Size;
use super::mapping::CanvasMath;
use super::zoom::{MAX_PIXEL_SCALE, MIN_FIT_FRACTION};

/// Smallest accepted points→pixels factor; keeps every division finite.
const MIN_DISPLAY_SCALE: f64 = 0.001;

/// The live viewport (points), the trustworthy image extent (oriented source
/// pixels, `ZERO` until known) and the points→real-pixels factor. Built fresh
/// for every transition so the math always sees the current viewport.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CanvasZoomContext {
    viewport_points: Size,
    native_image_size: Size,
    display_scale: f64,
}

impl CanvasZoomContext {
    /// Non-finite or negative sizes become `ZERO`; `display_scale` is raised
    /// to at least `0.001`, and a non-finite one becomes `1`.
    #[must_use]
    pub fn new(viewport_points: Size, native_image_size: Size, display_scale: f64) -> Self {
        Self {
            viewport_points: viewport_points.sanitized_extent(),
            native_image_size: native_image_size.sanitized_extent(),
            display_scale: if display_scale.is_finite() {
                display_scale.max(MIN_DISPLAY_SCALE)
            } else {
                1.0
            },
        }
    }

    #[must_use]
    pub fn viewport_points(&self) -> Size {
        self.viewport_points
    }

    #[must_use]
    pub fn native_image_size(&self) -> Size {
        self.native_image_size
    }

    #[must_use]
    pub fn display_scale(&self) -> f64 {
        self.display_scale
    }

    /// The viewport in real screen pixels — what the render pipeline targets.
    #[must_use]
    pub fn viewport_px(&self) -> Size {
        Size::new(
            self.viewport_points.width * self.display_scale,
            self.viewport_points.height * self.display_scale,
        )
    }

    /// The mapping snapshot at a user-intent scale and pan.
    #[must_use]
    pub fn canvas_math(&self, pixel_scale: f64, pan_offset: Size) -> CanvasMath {
        CanvasMath::new(
            self.viewport_px(),
            self.native_image_size,
            pixel_scale,
            pan_offset,
            self.display_scale,
        )
    }

    /// Real pixels per image pixel at fit; `1` while the image or viewport is
    /// unknown.
    #[must_use]
    pub fn fit_scale(&self) -> f64 {
        self.canvas_math(0.0, Size::ZERO).fit_pixel_scale()
    }

    /// The fill scale, capped at `MAX_PIXEL_SCALE` (a sliver image would
    /// otherwise ask for an unbounded zoom).
    #[must_use]
    pub fn fill_scale(&self) -> f64 {
        self.canvas_math(0.0, Size::ZERO)
            .fill_pixel_scale()
            .min(MAX_PIXEL_SCALE)
    }

    /// The zoom-out floor: `fit × MIN_FIT_FRACTION`.
    #[must_use]
    pub fn min_scale(&self) -> f64 {
        self.fit_scale() * MIN_FIT_FRACTION
    }

    /// `pixel_scale` with `0 == fit` resolved (and a NaN or negative scale
    /// read as fit).
    #[must_use]
    pub fn effective_scale(&self, pixel_scale: f64) -> f64 {
        self.canvas_math(pixel_scale, Size::ZERO)
            .effective_pixel_scale()
    }

    /// The image's on-screen frame in points; `None` until the size is known.
    #[must_use]
    pub fn display_frame_in_points(&self, pixel_scale: f64) -> Option<Size> {
        self.canvas_math(pixel_scale, Size::ZERO)
            .display_frame_in_points()
    }

    /// Largest pan magnitude per axis (points) that keeps the image attached
    /// to the viewport: zero on an axis where the image does not overflow, so
    /// it stays centred there (the letterbox axis).
    #[must_use]
    pub fn max_pan_offset(&self, pixel_scale: f64) -> Size {
        match self.display_frame_in_points(pixel_scale) {
            Some(frame) => Size::new(
                ((frame.width - self.viewport_points.width) / 2.0).max(0.0),
                ((frame.height - self.viewport_points.height) / 2.0).max(0.0),
            ),
            None => Size::ZERO,
        }
    }

    /// `pan` clamped into `±max_pan_offset` per axis; a NaN component becomes
    /// zero.
    #[must_use]
    pub fn clamped_pan(&self, pan: Size, pixel_scale: f64) -> Size {
        let limit = self.max_pan_offset(pixel_scale);
        Size::new(
            clamp_symmetric(pan.width, limit.width),
            clamp_symmetric(pan.height, limit.height),
        )
    }
}

fn clamp_symmetric(value: f64, limit: f64) -> f64 {
    if value.is_nan() {
        0.0
    } else {
        value.max(-limit).min(limit)
    }
}
