//! Re-capturing a live pinch when the fingers taking part change (#5732).
//!
//! A platform pinch keeps reporting after one finger lifts (or lands again):
//! its centroid jumps to the remaining finger and its cumulative
//! magnification can step, though the user did not zoom or pan. Fed straight
//! into `pinch_changed`, that jump moves the image by half the finger spread
//! as the fingers come off the glass. `pinch_rebased` re-anchors the gesture
//! so the new input reproduces the view the last frame showed, and later
//! frames continue from it.

use super::geometry::Point;
use super::zoom::CanvasZoomModel;
use super::zoom_context::CanvasZoomContext;

impl CanvasZoomModel {
    /// The fingers of a live pinch changed. `shown_magnification` at
    /// `shown_location` is the input of the last frame on screen;
    /// `magnification` and `location` are the gesture's input now. Returns a
    /// model whose next `pinch_changed(magnification, location)` lands on the
    /// shown scale and pan. The committed scale and pan are left untouched,
    /// so a host that freezes the frame during a pinch keeps it frozen. Not a
    /// pinch, or non-finite or non-positive input: unchanged.
    #[must_use]
    pub fn pinch_rebased(
        self,
        shown_magnification: f64,
        shown_location: Point,
        magnification: f64,
        location: Point,
        context: &CanvasZoomContext,
    ) -> Self {
        let is_valid = |m: f64| m.is_finite() && m > 0.0;
        if self.pinch_start_scale.is_none()
            || !is_valid(shown_magnification)
            || !is_valid(magnification)
            || !shown_location.is_finite()
            || !location.is_finite()
        {
            return self;
        }
        let shown = self.pinch_changed(shown_magnification, shown_location, context);
        Self {
            pinch_last_magnification: magnification,
            pinch_last_centroid: location,
            ..self
        }
        .recaptured_pinch(
            context.effective_scale(shown.pixel_scale),
            shown.pan_offset,
            context,
        )
    }
}

#[cfg(test)]
#[path = "zoom_rebase_tests.rs"]
mod tests;
