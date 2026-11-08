//! The canvas zoom/pan/gesture state machine (docs/zoom.md, #1099, #5710).
//!
//! `pixel_scale` is real screen pixels per image pixel: `0` = fit (resolved
//! at read time), `fit × MIN_FIT_FRACTION` the floor, fill = the image covers
//! the viewport (tracked across resizes), `1` = 100%, `MAX_PIXEL_SCALE` the
//! cap. A pinch derives every frame from start-captured values (its
//! magnification is cumulative), and settles on fit or fill inside their
//! detent bands. Pan is clamped so the image never detaches from the
//! viewport, and stays centred on an axis where it does not overflow.
//!
//! Each transition consumes the model and returns the next one.

use super::geometry::{Point, Size};
use super::zoom_context::CanvasZoomContext;
use super::zoom_rules::{
    anchored_pan, clamped_explicit_zoom, crosses_fit, detent, live_pinch_pan, next_stop,
    pinch_scale, zoom_in_target, zoom_out_target, ZoomOutResult, ZoomStop,
};

/// Upper clamp on `pixel_scale` (800%).
pub const MAX_PIXEL_SCALE: f64 = 8.0;
/// Floor for explicit zoom targets so a programmatic 0 cannot re-enter fit.
pub const MIN_EXPLICIT_ZOOM: f64 = 0.05;
/// Zoom-in/out step factor: five steps to double.
pub const ZOOM_STEP: f64 = 1.25;
/// Detent band as a fraction of a stop's scale.
pub const DETENT_TOLERANCE: f64 = 0.04;
/// Zoom-out floor as a fraction of fit.
pub const MIN_FIT_FRACTION: f64 = 0.5;
/// Command-scroll zoom: scale multiplies by `2^(normalized_delta_y × this)`.
pub const WHEEL_ZOOM_SENSITIVITY: f64 = 0.015;

/// Double-tap / double-click behaviour, configured per surface.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DoubleTapBehavior {
    /// Always return to fit.
    ResetToFit,
    /// Editor: fit ↔ 100%, zooming in anchored at the tap.
    ToggleFitAnd100,
}

/// The zoom state. Fields are public so bindings can round-trip it as a
/// plain value; only the transitions below keep it consistent.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CanvasZoomModel {
    /// User-intent scale: 0 = fit, 1 = 100%, at most `MAX_PIXEL_SCALE`.
    pub pixel_scale: f64,
    /// Points; positive = image dragged right/down.
    pub pan_offset: Size,
    /// Pan committed at the end of the last drag; live drags add to it.
    pub base_pan: Size,
    /// The drag translation recorded while a pinch suppressed the drag: the
    /// platform drag reports translation cumulative from the touch start and
    /// never resets when a pinch ends, so a post-pinch drag measures from here.
    pub drag_translation_base: Option<Size>,
    /// Scale captured on the first pinch frame; `Some` while a pinch is live.
    pub pinch_start_scale: Option<f64>,
    /// Pan captured on the first pinch frame; each frame re-derives from it.
    pub pinch_start_pan: Size,
    /// Centroid (viewport points) the scale change anchors at.
    pub pinch_start_centroid: Point,
    /// Latest live centroid, so the release commits at the same focal point.
    pub pinch_last_centroid: Point,
    /// True while the zoom is the fill stop; fill is re-resolved whenever the
    /// viewport or image changes (a rotation keeps the image covering it).
    pub fills_viewport: bool,
}

impl CanvasZoomModel {
    /// True once the user has zoomed away from fit, in or out.
    #[must_use]
    pub fn is_zoomed_in(&self) -> bool {
        self.pixel_scale > 0.0
    }

    /// One pinch frame. The first frame captures the start scale, pan and
    /// centroid; a capture frame at magnification 1 changes nothing else,
    /// because the iOS compositor freezes that frame and scales it by the
    /// ratio to the start — snapping it to a detent would count the detent
    /// twice (#5710). Non-finite inputs are ignored.
    #[must_use]
    pub fn pinch_changed(
        self,
        magnification: f64,
        location: Point,
        context: &CanvasZoomContext,
    ) -> Self {
        if !magnification.is_finite() || !location.is_finite() {
            return self;
        }
        let is_capture_frame = self.pinch_start_scale.is_none();
        let start = self
            .pinch_start_scale
            .unwrap_or_else(|| context.effective_scale(self.pixel_scale));
        let captured = if is_capture_frame {
            Self {
                pinch_start_scale: Some(start),
                pinch_start_pan: self.pan_offset,
                pinch_start_centroid: location,
                ..self
            }
        } else {
            self
        };
        if is_capture_frame && magnification == 1.0 {
            return Self {
                pinch_last_centroid: location,
                ..captured
            };
        }
        let next = pinch_scale(
            start,
            magnification,
            context.fit_scale(),
            context.fill_scale(),
        );
        let pan = live_pinch_pan(
            location,
            captured.pinch_start_centroid,
            captured.pinch_start_pan,
            start,
            next,
            context.viewport_points(),
        );
        Self {
            pixel_scale: next,
            fills_viewport: false,
            pan_offset: context.clamped_pan(pan, next),
            pinch_last_centroid: location,
            ..captured
        }
    }

    /// Pinch release: commit the final scale at the last focal point, clear
    /// the start capture, and settle on fit or fill inside its band. Without a
    /// prior change frame (or with a non-finite magnification) the scale is
    /// left as is, but the detent still applies.
    #[must_use]
    pub fn pinch_ended(self, magnification: f64, context: &CanvasZoomContext) -> Self {
        let fit = context.fit_scale();
        let fill = context.fill_scale();
        let committed = match self.pinch_start_scale {
            Some(start) if magnification.is_finite() => {
                let scale = pinch_scale(start, magnification, fit, fill);
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
                    pan_offset: context.clamped_pan(pan, scale),
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
            ..committed
        };
        match detent(context.effective_scale(released.pixel_scale), fit, fill) {
            Some(ZoomStop::Fit) => released.reset_to_fit(),
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
            Some(ZoomStop::ActualSize) | None => Self {
                base_pan: released.pan_offset,
                ..released
            },
        }
    }

    /// One drag frame. Returns whether the drag was consumed as a pan. While a
    /// pinch owns the gesture the drag only records its translation as the
    /// post-pinch baseline; with nothing to pan it belongs to the editing
    /// surface. A non-finite translation is ignored.
    #[must_use]
    pub fn drag_changed(self, translation: Size, context: &CanvasZoomContext) -> (Self, bool) {
        if !translation.is_finite() {
            return (self, false);
        }
        if self.pinch_start_scale.is_some() {
            return (
                Self {
                    drag_translation_base: Some(translation),
                    ..self
                },
                false,
            );
        }
        if !self.can_pan(context) {
            return (self, false);
        }
        let baseline = self.drag_translation_base.unwrap_or(Size::ZERO);
        let raw = Size::new(
            self.base_pan.width + translation.width - baseline.width,
            self.base_pan.height + translation.height - baseline.height,
        );
        (
            Self {
                pan_offset: context.clamped_pan(raw, self.pixel_scale),
                ..self
            },
            true,
        )
    }

    /// Drag release: clears the touch baseline and commits the pan. Returns
    /// whether a pan was committed — never while a pinch still owns the
    /// gesture (both fingers lifting can deliver the drag end first).
    #[must_use]
    pub fn drag_ended(self) -> (Self, bool) {
        let ended = Self {
            drag_translation_base: None,
            ..self
        };
        if ended.pinch_start_scale.is_some() || !ended.is_zoomed_in() {
            return (ended, false);
        }
        (
            Self {
                base_pan: ended.pan_offset,
                ..ended
            },
            true,
        )
    }

    /// Absorb a drag translation into the baseline without panning (the
    /// host's post-pinch cooldown). A non-finite translation is ignored.
    #[must_use]
    pub fn rebase_drag_baseline(self, translation: Size) -> Self {
        if !translation.is_finite() {
            return self;
        }
        Self {
            drag_translation_base: Some(translation),
            ..self
        }
    }

    /// Two-finger scroll / wheel pan by `delta` points while zoomed.
    #[must_use]
    pub fn wheel_pan(self, delta: Size, context: &CanvasZoomContext) -> Self {
        if !self.is_zoomed_in() || !delta.is_finite() {
            return self;
        }
        let pan = context.clamped_pan(
            Size::new(
                self.pan_offset.width + delta.width,
                self.pan_offset.height + delta.height,
            ),
            self.pixel_scale,
        );
        Self {
            pan_offset: pan,
            base_pan: pan,
            ..self
        }
    }

    /// Command-scroll zoom anchored at the cursor; positive deltas zoom in.
    /// Crossing fit settles there at once (a wheel has no gesture end).
    #[must_use]
    pub fn wheel_zoom(
        self,
        normalized_delta_y: f64,
        location: Point,
        context: &CanvasZoomContext,
    ) -> Self {
        if !normalized_delta_y.is_finite() || !location.is_finite() {
            return self;
        }
        let current = context.effective_scale(self.pixel_scale);
        let factor = (normalized_delta_y * WHEEL_ZOOM_SENSITIVITY).exp2();
        let next = (current * factor)
            .min(MAX_PIXEL_SCALE)
            .max(context.min_scale());
        if crosses_fit(current, next, context.fit_scale()) {
            return self.reset_to_fit();
        }
        let pan = context.clamped_pan(
            anchored_pan(
                location,
                context.viewport_points(),
                self.pan_offset,
                current,
                next,
            ),
            next,
        );
        Self {
            pixel_scale: next,
            fills_viewport: false,
            pan_offset: pan,
            base_pan: pan,
            ..self
        }
    }

    /// Double-tap per `behavior`. The editor zooms fit → 100% anchored at the
    /// tap (the viewport centre when the tap location is not finite) and any
    /// zoomed state back to fit.
    #[must_use]
    pub fn double_tap(
        self,
        location: Point,
        behavior: DoubleTapBehavior,
        context: &CanvasZoomContext,
    ) -> Self {
        if behavior == DoubleTapBehavior::ResetToFit || self.is_zoomed_in() {
            return self.reset_to_fit();
        }
        let viewport = context.viewport_points();
        let anchor = if location.is_finite() {
            location
        } else {
            Point::new(viewport.width / 2.0, viewport.height / 2.0)
        };
        let target = 1.0;
        let pan = context.clamped_pan(
            anchored_pan(
                anchor,
                viewport,
                self.pan_offset,
                context.effective_scale(self.pixel_scale),
                target,
            ),
            target,
        );
        Self {
            pixel_scale: target,
            fills_viewport: false,
            pan_offset: pan,
            base_pan: pan,
            ..self
        }
    }

    /// Fit mode with every pan and gesture capture cleared.
    #[must_use]
    pub fn reset_to_fit(self) -> Self {
        Self::default()
    }

    /// Explicit zoom target (toolbar "100%", ⌘1), clamped, re-centred.
    #[must_use]
    pub fn zoom_to_scale(self, scale: f64) -> Self {
        Self {
            pixel_scale: clamped_explicit_zoom(scale),
            fills_viewport: false,
            pan_offset: Size::ZERO,
            base_pan: Size::ZERO,
            ..self
        }
    }

    /// The fill stop, centred; the overflowing axis can then be panned.
    #[must_use]
    pub fn zoom_to_fill(self, context: &CanvasZoomContext) -> Self {
        Self {
            pixel_scale: context.fill_scale(),
            fills_viewport: true,
            pan_offset: Size::ZERO,
            base_pan: Size::ZERO,
            ..self
        }
    }

    /// Badge tap: the next stop in `fit → fill → 100%`; a free scale returns
    /// to fit.
    #[must_use]
    pub fn advance_stop(self, context: &CanvasZoomContext) -> Self {
        match next_stop(self.current_stop(), Self::badge_stops(context).as_slice()) {
            ZoomStop::Fit => self.reset_to_fit(),
            ZoomStop::Fill => self.zoom_to_fill(context),
            ZoomStop::ActualSize => self.zoom_to_scale(1.0),
        }
    }

    /// Zoom-in step anchored at the viewport centre; reaching fit from below
    /// settles on it.
    #[must_use]
    pub fn step_zoom_in(self, context: &CanvasZoomContext) -> Self {
        let current = context.effective_scale(self.pixel_scale);
        let next = zoom_in_target(current);
        if crosses_fit(current, next, context.fit_scale()) {
            return self.reset_to_fit();
        }
        self.rescaled_pan(current, next, context)
            .at_free_scale(next)
    }

    /// Zoom-out step anchored at the viewport centre; reaching fit from above
    /// settles on it.
    #[must_use]
    pub fn step_zoom_out(self, context: &CanvasZoomContext) -> Self {
        let current = context.effective_scale(self.pixel_scale);
        match zoom_out_target(current, context.fit_scale()) {
            ZoomOutResult::SnapToFit => self.reset_to_fit(),
            ZoomOutResult::Scale(next) => self
                .rescaled_pan(current, next, context)
                .at_free_scale(next),
        }
    }

    /// Re-resolve against fresh geometry (viewport resize, rotation, image
    /// size landing): fill follows the new viewport — or becomes fit when the
    /// two now coincide — and the pan is pulled back inside the legal range.
    #[must_use]
    pub fn reclamp_pan(self, context: &CanvasZoomContext) -> Self {
        if !self.is_zoomed_in() {
            return self;
        }
        let resolved = if !self.fills_viewport {
            self
        } else if Self::badge_stops(context).contains(ZoomStop::Fill) {
            Self {
                pixel_scale: context.fill_scale(),
                ..self
            }
        } else {
            return self.reset_to_fit();
        };
        let clamped = context.clamped_pan(resolved.pan_offset, resolved.pixel_scale);
        if clamped == resolved.pan_offset {
            resolved
        } else {
            Self {
                pan_offset: clamped,
                base_pan: clamped,
                ..resolved
            }
        }
    }

    fn at_free_scale(self, scale: f64) -> Self {
        Self {
            pixel_scale: scale,
            fills_viewport: false,
            ..self
        }
    }

    /// Centre-anchored pan rescale shared by the zoom steps.
    fn rescaled_pan(self, current: f64, next: f64, context: &CanvasZoomContext) -> Self {
        if current.is_nan() || current <= 0.0 {
            return self;
        }
        let ratio = next / current;
        let pan = context.clamped_pan(
            Size::new(
                self.pan_offset.width * ratio,
                self.pan_offset.height * ratio,
            ),
            next,
        );
        Self {
            pan_offset: pan,
            base_pan: pan,
            ..self
        }
    }
}

#[cfg(test)]
#[path = "zoom_tests.rs"]
mod tests;
