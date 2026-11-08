//! The per-call geometry every zoom transition resolves against.

use super::geometry::{Insets, Point, Size};
use super::mapping::CanvasMath;
use super::zoom::{MAX_PIXEL_SCALE, MIN_FIT_FRACTION};

/// Smallest accepted points→pixels factor; keeps every division finite.
const MIN_DISPLAY_SCALE: f64 = 0.001;

/// The live viewport (points), the trustworthy image extent (oriented source
/// pixels, `ZERO` until known), the points→real-pixels factor and the insets
/// the host's chrome covers. Built fresh for every transition so the math
/// always sees the current viewport.
///
/// The image is drawn across the whole viewport, but fit, fill, the
/// re-centring "home" position and the pan range all resolve against the
/// VISIBLE area — the viewport minus the insets — so the photo settles
/// centred in what the user can actually see.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CanvasZoomContext {
    viewport_points: Size,
    native_image_size: Size,
    display_scale: f64,
    insets: Insets,
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
            insets: Insets::ZERO,
        }
    }

    /// The same geometry with `insets` of the viewport covered by chrome,
    /// sanitized against the viewport (`Insets::sanitized_within`).
    #[must_use]
    pub fn with_insets(self, insets: Insets) -> Self {
        Self {
            insets: insets.sanitized_within(self.viewport_points),
            ..self
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

    #[must_use]
    pub fn insets(&self) -> Insets {
        self.insets
    }

    /// The part of the viewport the chrome leaves uncovered, in points.
    #[must_use]
    pub fn visible_points(&self) -> Size {
        Size::new(
            self.viewport_points.width - self.insets.left - self.insets.right,
            self.viewport_points.height - self.insets.top - self.insets.bottom,
        )
    }

    /// Centre of the visible area, in viewport points.
    #[must_use]
    pub fn visible_centre(&self) -> Point {
        Point::new(
            self.insets.left + self.visible_points().width / 2.0,
            self.insets.top + self.visible_points().height / 2.0,
        )
    }

    /// The pan that centres the image in the visible area: the offset of the
    /// visible centre from the viewport centre. Fit, fill and every
    /// re-centring zoom land here.
    #[must_use]
    pub fn home_pan(&self) -> Size {
        Size::new(
            (self.insets.left - self.insets.right) / 2.0,
            (self.insets.top - self.insets.bottom) / 2.0,
        )
    }

    /// The viewport in real screen pixels — what the render pipeline targets.
    #[must_use]
    pub fn viewport_px(&self) -> Size {
        Size::new(
            self.viewport_points.width * self.display_scale,
            self.viewport_points.height * self.display_scale,
        )
    }

    /// The mapping snapshot at a user-intent scale and pan, over the whole
    /// viewport. Fit (`0`) resolves to the visible-area fit first, so the
    /// snapshot draws the image at the size the zoom model means.
    #[must_use]
    pub fn canvas_math(&self, pixel_scale: f64, pan_offset: Size) -> CanvasMath {
        CanvasMath::new(
            self.viewport_px(),
            self.native_image_size,
            self.effective_scale(pixel_scale),
            pan_offset,
            self.display_scale,
        )
    }

    /// The visible area as a mapping snapshot, for the fit and fill scales.
    fn visible_math(&self) -> CanvasMath {
        let visible = self.visible_points();
        CanvasMath::new(
            Size::new(
                visible.width * self.display_scale,
                visible.height * self.display_scale,
            ),
            self.native_image_size,
            0.0,
            Size::ZERO,
            self.display_scale,
        )
    }

    /// Real pixels per image pixel at which the image fits the visible area;
    /// `1` while the image or viewport is unknown.
    #[must_use]
    pub fn fit_scale(&self) -> f64 {
        self.visible_math().fit_pixel_scale()
    }

    /// The scale at which the image covers the visible area, capped at
    /// `MAX_PIXEL_SCALE` (a sliver image would otherwise ask for an unbounded
    /// zoom).
    #[must_use]
    pub fn fill_scale(&self) -> f64 {
        self.visible_math().fill_pixel_scale().min(MAX_PIXEL_SCALE)
    }

    /// The zoom-out floor: `fit × MIN_FIT_FRACTION`.
    #[must_use]
    pub fn min_scale(&self) -> f64 {
        self.fit_scale() * MIN_FIT_FRACTION
    }

    /// `pixel_scale` with `0 == fit` resolved (and a non-finite or negative
    /// scale read as fit).
    #[must_use]
    pub fn effective_scale(&self, pixel_scale: f64) -> f64 {
        if pixel_scale.is_finite() && pixel_scale > 0.0 {
            pixel_scale
        } else {
            self.fit_scale()
        }
    }

    /// The image's on-screen frame in points; `None` until the size is known.
    #[must_use]
    pub fn display_frame_in_points(&self, pixel_scale: f64) -> Option<Size> {
        self.canvas_math(pixel_scale, Size::ZERO)
            .display_frame_in_points()
    }

    /// Largest pan per axis (points) away from `home_pan` that keeps the
    /// image covering the visible area: zero on an axis where the image does
    /// not overflow it, so the image stays centred there (the letterbox
    /// axis, and every axis below fit).
    #[must_use]
    pub fn max_pan_offset(&self, pixel_scale: f64) -> Size {
        let overflow = self.visible_overflow(pixel_scale);
        Size::new(overflow.width.max(0.0), overflow.height.max(0.0))
    }

    /// The resting pan range: `pan` clamped into `home_pan ± max_pan_offset`
    /// per axis; a NaN component becomes the home position.
    #[must_use]
    pub fn clamped_pan(&self, pan: Size, pixel_scale: f64) -> Size {
        self.pan_within(pan, self.max_pan_offset(pixel_scale))
    }

    /// The live-pinch pan range, which is continuous across fit: per axis the
    /// image either covers the visible area (larger than it) or stays inside
    /// it (smaller), so `home_pan ± |frame − visible| / 2`. At the size where
    /// the two meet the range is the home position from both sides, so a
    /// pinch crossing fit never jumps, and below fit the image may sit
    /// anywhere in the visible area — wherever the fingers put it.
    #[must_use]
    pub fn pinch_clamped_pan(&self, pan: Size, pixel_scale: f64) -> Size {
        let overflow = self.visible_overflow(pixel_scale);
        self.pan_within(pan, Size::new(overflow.width.abs(), overflow.height.abs()))
    }

    /// Half of `display frame − visible area` per axis (points), negative
    /// where the image is smaller; zero while the frame is unknown.
    fn visible_overflow(&self, pixel_scale: f64) -> Size {
        let visible = self.visible_points();
        self.display_frame_in_points(pixel_scale)
            .map_or(Size::ZERO, |frame| {
                Size::new(
                    (frame.width - visible.width) / 2.0,
                    (frame.height - visible.height) / 2.0,
                )
            })
    }

    /// `clamped_pan`, widened toward a drag's `base` pan where that lies
    /// outside the range (the frame an interrupted settle was showing): the
    /// drag starts exactly there and can move the photo back in, never
    /// further out.
    #[must_use]
    pub fn clamped_pan_from(&self, pan: Size, pixel_scale: f64, base: Size) -> Size {
        let excess = difference(base, self.clamped_pan(base, pixel_scale));
        self.pan_within_widened(pan, self.max_pan_offset(pixel_scale), excess)
    }

    /// `pinch_clamped_pan`, widened the same way toward the pinch's start
    /// pan where that lies outside its own range at the start scale.
    #[must_use]
    pub fn pinch_clamped_pan_from(
        &self,
        pan: Size,
        pixel_scale: f64,
        start_pan: Size,
        start_scale: f64,
    ) -> Size {
        let excess = difference(start_pan, self.pinch_clamped_pan(start_pan, start_scale));
        let overflow = self.visible_overflow(pixel_scale);
        let limit = Size::new(overflow.width.abs(), overflow.height.abs());
        self.pan_within_widened(pan, limit, excess)
    }

    fn pan_within(&self, pan: Size, limit: Size) -> Size {
        self.pan_within_widened(pan, limit, Size::ZERO)
    }

    fn pan_within_widened(&self, pan: Size, limit: Size, excess: Size) -> Size {
        let home = self.home_pan();
        Size::new(
            home.width + clamp_widened(pan.width - home.width, limit.width, excess.width),
            home.height + clamp_widened(pan.height - home.height, limit.height, excess.height),
        )
    }
}

fn difference(a: Size, b: Size) -> Size {
    Size::new(a.width - b.width, a.height - b.height)
}

/// `value` within `±limit`, the bound on `excess`'s side pushed out by it.
fn clamp_widened(value: f64, limit: f64, excess: f64) -> f64 {
    if value.is_nan() {
        0.0
    } else {
        let excess = if excess.is_finite() { excess } else { 0.0 };
        value
            .max(-limit + excess.min(0.0))
            .min(limit + excess.max(0.0))
    }
}
