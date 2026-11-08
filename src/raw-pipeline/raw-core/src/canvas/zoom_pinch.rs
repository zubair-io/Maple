//! The live pinch and its release (docs/zoom.md, #5710, #5749).
//!
//! While the fingers are down the image point under them stays under them at
//! every scale, above fit and below it alike: the scale follows the fingers
//! with no detent, and the pan is held only by `pinch_clamped_pan`, a range
//! that is continuous across fit. Below fit the image may therefore sit
//! anywhere in the visible area. The release settles: below fit, or inside a
//! fit or fill detent band, onto that stop centred in the visible area; at any
//! other scale, into the resting pan range. The host animates from the frame
//! it last showed to the settled one.

use super::geometry::{Point, Size};
use super::zoom::CanvasZoomModel;
use super::zoom_context::CanvasZoomContext;
use super::zoom_continuity::is_magnification;
use super::zoom_rules::{detent, live_pinch_pan, pinch_scale, ZoomStop};

impl CanvasZoomModel {
    /// One pinch frame. The first frame captures the gesture so that it
    /// reproduces the frame on screen: its magnification and centroid are the
    /// baseline later frames measure from, so a capture never moves the image
    /// (#5737) — the iOS compositor freezes that frame and scales it by the
    /// ratio to the start (#5710). Non-finite or non-positive inputs are
    /// ignored.
    #[must_use]
    pub fn pinch_changed(
        self,
        magnification: f64,
        location: Point,
        context: &CanvasZoomContext,
    ) -> Self {
        if !is_magnification(magnification) || !location.is_finite() {
            return self;
        }
        let Some(start) = self.pinch_start_scale else {
            let tracked = Self {
                pinch_last_magnification: magnification,
                pinch_last_centroid: location,
                ..self
            };
            let captured = tracked.recaptured_pinch(
                context.effective_scale(self.pixel_scale),
                self.pan_offset,
                context,
            );
            return if captured.pinch_start_scale.is_some() {
                captured
            } else {
                self
            };
        };
        let next = pinch_scale(
            start,
            magnification / self.start_magnification(),
            context.fit_scale(),
        );
        let pan = live_pinch_pan(
            location,
            self.pinch_start_centroid,
            self.pinch_start_pan,
            start,
            next,
            context.viewport_points(),
        );
        Self {
            pixel_scale: next,
            fills_viewport: false,
            pan_offset: context.pinch_clamped_pan_from(pan, next, self.pinch_start_pan, start),
            pinch_last_centroid: location,
            pinch_last_magnification: magnification,
            ..self
        }
    }

    /// Pinch release: commit the final scale at the last focal point, clear
    /// the start capture, then settle. Below fit, or within fit's detent
    /// band, it returns to fit centred in the visible area; within fill's
    /// band it lands on fill; anywhere else the pan comes into the resting
    /// range. Without a prior change frame (or with a non-finite
    /// magnification) the scale is left as is, but the settle still applies.
    #[must_use]
    pub fn pinch_ended(self, magnification: f64, context: &CanvasZoomContext) -> Self {
        let fit = context.fit_scale();
        let fill = context.fill_scale();
        let committed = match self.pinch_start_scale {
            Some(start) if is_magnification(magnification) => {
                let scale = pinch_scale(start, magnification / self.start_magnification(), fit);
                let pan = live_pinch_pan(
                    self.pinch_last_centroid,
                    self.pinch_start_centroid,
                    self.pinch_start_pan,
                    start,
                    scale,
                    context.viewport_points(),
                );
                Self {
                    pixel_scale: scale,
                    pan_offset: context.pinch_clamped_pan_from(
                        pan,
                        scale,
                        self.pinch_start_pan,
                        start,
                    ),
                    ..self
                }
            }
            _ => self,
        };
        let released = Self {
            pinch_start_scale: None,
            pinch_start_pan: Size::ZERO,
            pinch_start_centroid: Point::ZERO,
            pinch_last_centroid: Point::ZERO,
            pinch_last_magnification: 0.0,
            pinch_start_magnification: 0.0,
            ..committed
        };
        let scale = context.effective_scale(released.pixel_scale);
        if scale < fit {
            return released.reset_to_fit(context);
        }
        match detent(scale, fit, fill) {
            Some(ZoomStop::Fit) => released.reset_to_fit(context),
            Some(ZoomStop::Fill) => {
                let pan = context.clamped_pan(released.pan_offset, fill);
                Self {
                    pixel_scale: fill,
                    fills_viewport: true,
                    pan_offset: pan,
                    base_pan: pan,
                    ..released
                }
            }
            Some(ZoomStop::ActualSize) | None => {
                let pan = context.clamped_pan(released.pan_offset, scale);
                Self {
                    pan_offset: pan,
                    base_pan: pan,
                    ..released
                }
            }
        }
    }

    /// Rest at the frame an interrupted settle animation was showing, so the
    /// gesture that takes over starts from what is on screen (#5742). The
    /// pan is kept exactly, even outside the new geometry's range (a settle
    /// after a chrome change interpolates from the old geometry): the
    /// gesture's clamp widens to include it, and its release settles into
    /// range. The scale is held to the zoom range. Ignored while a pinch is
    /// live, before the image size is known, or for a frame that cannot be
    /// drawn.
    #[must_use]
    pub fn hold_shown(self, scale: f64, pan: Size, context: &CanvasZoomContext) -> Self {
        let drawable = scale.is_finite() && scale > 0.0 && pan.is_finite();
        let image_known = context.display_frame_in_points(scale).is_some();
        if self.pinch_start_scale.is_some() || !drawable || !image_known {
            return self;
        }
        Self {
            pixel_scale: pinch_scale(scale, 1.0, context.fit_scale()),
            pan_offset: pan,
            base_pan: pan,
            fills_viewport: false,
            ..self
        }
        .continuing(context)
    }
}

#[cfg(test)]
#[path = "zoom_pinch_tests.rs"]
mod tests;
