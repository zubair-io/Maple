//! Continuity across everything that is not finger or pointer motion
//! (docs/zoom.md § Continuity, #5717).
//!
//! The rule: only finger or pointer motion moves the image. A zoom command,
//! a geometry change (viewport, chrome insets, display density, image
//! extent) or a lost gesture end lands somewhere the host can draw, and any
//! gesture still live continues from exactly that frame: the next pinch or
//! drag frame with the same cumulative input reproduces it, and later frames
//! move on from it. Every transition that is not a gesture frame ends in
//! `continuing`, which re-captures the live gestures on its result.

use super::geometry::{Point, Size};
use super::zoom::{CanvasZoomModel, MAX_PIXEL_SCALE};
use super::zoom_context::CanvasZoomContext;
use super::zoom_rules::{pinch_scale, ZoomStop};

/// A cumulative pinch magnification a frame can be derived from.
pub(super) fn is_magnification(magnification: f64) -> bool {
    magnification.is_finite() && magnification > 0.0
}

impl CanvasZoomModel {
    /// Record the live pinch input without moving the committed frame, for a
    /// host that freezes the frame during a pinch and draws the live one as a
    /// compositor transform (Apple iOS). The other transitions then know the
    /// frame on screen. Not a pinch, or non-finite or non-positive input:
    /// unchanged.
    #[must_use]
    pub fn pinch_tracked(self, magnification: f64, location: Point) -> Self {
        if self.pinch_start_scale.is_none()
            || !is_magnification(magnification)
            || !location.is_finite()
        {
            return self;
        }
        Self {
            pinch_last_magnification: magnification,
            pinch_last_centroid: location,
            ..self
        }
    }

    /// A new drag gesture began. Commits what the previous drag left on
    /// screen, whose release may never have arrived (a cancelled gesture,
    /// #5739), and starts the new drag from it. A live pinch keeps its own
    /// pan; only the drag bookkeeping is cleared then.
    #[must_use]
    pub fn drag_began(self) -> Self {
        let committed = if self.pinch_start_scale.is_none() {
            Self {
                base_pan: self.pan_offset,
                ..self
            }
        } else {
            self
        };
        Self {
            drag_translation_base: None,
            drag_last_translation: None,
            ..committed
        }
    }

    /// A gesture was cancelled instead of ending (its view went away, the
    /// app left the foreground): a live pinch ends at its last input and
    /// settles, a live drag commits where it is.
    #[must_use]
    pub fn gestures_cancelled(self, context: &CanvasZoomContext) -> Self {
        let released = if self.pinch_start_scale.is_some() {
            self.pinch_ended(self.last_magnification(), context)
        } else {
            self
        };
        released.drag_ended().0
    }

    /// The frame on screen as (resolved scale, pan): during a pinch, the
    /// frame its latest input produces; otherwise the resting frame.
    #[must_use]
    pub fn shown_frame(&self, context: &CanvasZoomContext) -> (f64, Size) {
        let shown = if self.pinch_start_scale.is_some() {
            self.pinch_changed(self.last_magnification(), self.pinch_last_centroid, context)
        } else {
            *self
        };
        (context.effective_scale(shown.pixel_scale), shown.pan_offset)
    }

    /// The geometry changed from `previous` to `context`: a viewport resize
    /// or rotation, chrome insets, the display density (#5740), or the image
    /// extent (a placeholder size replaced by the original's). Fit re-fits,
    /// fill re-resolves and 100% stays 1:1; a free scale keeps the picture's
    /// size on screen when the extent changes. The image point at the
    /// viewport centre stays there (so a resize or an inset change keeps the
    /// pan), as far as the pan range allows. A live pinch continues from the
    /// frame it was showing, carried the same way (#5736).
    #[must_use]
    pub fn geometry_changed(
        self,
        previous: &CanvasZoomContext,
        context: &CanvasZoomContext,
    ) -> Self {
        let live = self.pinch_start_scale.map(|_| self.shown_frame(previous));
        let committed = self.carried(previous, context).resolved_at_rest(context);
        match live {
            Some((scale, pan)) => {
                let carried_scale = carried_free_scale(scale, previous, context);
                let carried_pan = carried_pan(pan, scale, carried_scale, previous, context);
                committed.with_live_drag_rebased().recaptured_pinch(
                    carried_scale,
                    carried_pan,
                    context,
                )
            }
            None => committed.continuing(context),
        }
    }

    /// The committed zoom carried from `previous` to `context`, before the
    /// resting clamp.
    fn carried(self, previous: &CanvasZoomContext, context: &CanvasZoomContext) -> Self {
        if !self.is_zoomed_in() {
            return self;
        }
        let start = previous.effective_scale(self.pixel_scale);
        let scale = match self.current_stop() {
            Some(ZoomStop::Fill) => context.fill_scale(),
            Some(ZoomStop::Fit | ZoomStop::ActualSize) => self.pixel_scale,
            None => carried_free_scale(start, previous, context),
        };
        let pan = carried_pan(
            self.pan_offset,
            start,
            context.effective_scale(scale),
            previous,
            context,
        );
        Self {
            pixel_scale: scale,
            pan_offset: pan,
            base_pan: pan,
            ..self
        }
    }

    /// Re-capture the live gestures on this result, so their next frame with
    /// the same input reproduces it.
    pub(super) fn continuing(self, context: &CanvasZoomContext) -> Self {
        let dragged = self.with_live_drag_rebased();
        if dragged.pinch_start_scale.is_none() {
            return dragged;
        }
        dragged.recaptured_pinch(
            context.effective_scale(dragged.pixel_scale),
            dragged.pan_offset,
            context,
        )
    }

    /// A live drag (outside a pinch, which owns the gesture) measures its
    /// next frame from the committed pan: `base + translation − baseline`
    /// lands on the current pan at the latest translation.
    fn with_live_drag_rebased(self) -> Self {
        match (self.pinch_start_scale, self.drag_last_translation) {
            (None, Some(translation)) => {
                let baseline = self.drag_translation_base.unwrap_or(Size::ZERO);
                Self {
                    base_pan: Size::new(
                        self.pan_offset.width - (translation.width - baseline.width),
                        self.pan_offset.height - (translation.height - baseline.height),
                    ),
                    ..self
                }
            }
            _ => self,
        }
    }

    /// The pinch capture whose next frame at the latest input lands on
    /// `scale` and `pan`, first held to the live pinch's own limits (the
    /// floor, the cap and the pinch pan range) so that frame cannot jump to
    /// them. The committed scale and pan are left untouched, so a host that
    /// freezes the frame during a pinch keeps it frozen.
    pub(super) fn recaptured_pinch(
        self,
        scale: f64,
        pan: Size,
        context: &CanvasZoomContext,
    ) -> Self {
        let magnification = self.last_magnification();
        let held_scale = pinch_scale(scale, 1.0, context.fit_scale());
        let held_pan = context.pinch_clamped_pan(pan, held_scale);
        if !held_scale.is_finite() || held_scale <= 0.0 {
            return self;
        }
        let centroid = self.pinch_last_centroid;
        let viewport = context.viewport_points();
        let offset = Size::new(
            centroid.x - viewport.width / 2.0,
            centroid.y - viewport.height / 2.0,
        );
        Self {
            pinch_start_scale: Some(held_scale / magnification),
            pinch_start_pan: Size::new(
                offset.width - (offset.width - held_pan.width) / magnification,
                offset.height - (offset.height - held_pan.height) / magnification,
            ),
            pinch_start_centroid: centroid,
            pinch_last_magnification: magnification,
            ..self
        }
    }

    /// The latest pinch magnification; 1 when none was recorded.
    pub(super) fn last_magnification(&self) -> f64 {
        if is_magnification(self.pinch_last_magnification) {
            self.pinch_last_magnification
        } else {
            1.0
        }
    }
}

/// A free scale across an extent change keeps the picture's size on screen
/// (the extent is the same picture at another resolution), held to the new
/// zoom range. Unchanged when either extent is unknown.
fn carried_free_scale(
    scale: f64,
    previous: &CanvasZoomContext,
    context: &CanvasZoomContext,
) -> f64 {
    let old = previous.native_image_size();
    let new = context.native_image_size();
    let known = old.width > 0.0 && old.height > 0.0 && new.width > 0.0 && new.height > 0.0;
    if !known || old == new {
        return scale;
    }
    (scale * old.width / new.width)
        .min(MAX_PIXEL_SCALE)
        .max(context.min_scale())
}

/// The pan that keeps the image point at the viewport centre there: the pan
/// scales with the picture's on-screen size per axis. Unchanged while either
/// frame is unknown.
fn carried_pan(
    pan: Size,
    scale: f64,
    carried_scale: f64,
    previous: &CanvasZoomContext,
    context: &CanvasZoomContext,
) -> Size {
    let frames = previous
        .display_frame_in_points(scale)
        .zip(context.display_frame_in_points(carried_scale));
    let Some((old, new)) = frames else {
        return pan;
    };
    let ratio = |new: f64, old: f64| if old > 0.0 { new / old } else { 1.0 };
    let carried = Size::new(
        pan.width * ratio(new.width, old.width),
        pan.height * ratio(new.height, old.height),
    );
    if carried.is_finite() {
        carried
    } else {
        pan
    }
}

#[cfg(test)]
#[path = "zoom_continuity_tests.rs"]
mod tests;
