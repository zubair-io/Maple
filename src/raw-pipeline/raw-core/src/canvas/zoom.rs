//! The canvas zoom/pan/gesture state machine (docs/zoom.md, #1099, #5710).
//!
//! `pixel_scale` is real screen pixels per image pixel: `0` = fit (resolved
//! at read time), `fit × MIN_FIT_FRACTION` the floor, fill = the image covers
//! the viewport (tracked across resizes), `1` = 100%, and the cap
//! `max_zoom(fit, fill)` — `MAX_PIXEL_SCALE`, raised to fit or fill when
//! either exceeds it. Fit, fill and the centred "home" pan resolve against the visible part
//! of the viewport (`CanvasZoomContext` insets). The pinch transitions live in
//! `zoom_pinch.rs`. At rest the pan is clamped so the image never detaches
//! from the visible area, and stays centred in it on an axis where it does not
//! overflow.
//!
//! Each transition consumes the model and returns the next one.

use super::geometry::{Point, Size};
use super::zoom_context::CanvasZoomContext;
use super::zoom_rules::{
    anchored_pan, clamped_explicit_zoom, crosses_fit, next_stop, zoom_in_target, zoom_out_target,
    ZoomOutResult, ZoomStop,
};

/// Upper clamp on `pixel_scale` (800%) for gestures and steps, raised to fit
/// or fill when either exceeds it (`max_zoom`); always the clamp for an
/// explicit `zoom_to_scale` target.
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
    /// User-intent scale: 0 = fit, 1 = 100%, at most the context's
    /// `max_scale`.
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
    /// Cumulative magnification at the capture: the pinch scales by
    /// `magnification / pinch_start_magnification` (1 when unset), so a
    /// capture at any magnification reproduces the frame on screen.
    pub pinch_start_magnification: f64,
    /// Cumulative magnification of the latest pinch input (with
    /// `pinch_last_centroid`, the live pinch input). A transition that is not
    /// finger motion re-captures the pinch on what it produced, so the next
    /// frame continues from there (#5736, #5737).
    pub pinch_last_magnification: f64,
    /// The latest cumulative translation of a live drag, `Some` from its
    /// first frame to its release. A transition that commits the pan mid-drag
    /// rebases the drag on it (#5738).
    pub drag_last_translation: Option<Size>,
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

    /// One drag frame. Returns whether the drag was consumed as a pan. While a
    /// pinch owns the gesture the drag only records its translation as the
    /// post-pinch baseline; with nothing to pan it belongs to the editing
    /// surface. A non-finite translation is ignored.
    #[must_use]
    pub fn drag_changed(self, translation: Size, context: &CanvasZoomContext) -> (Self, bool) {
        if !translation.is_finite() {
            return (self, false);
        }
        let tracked = Self {
            drag_last_translation: Some(translation),
            ..self
        };
        if tracked.pinch_start_scale.is_some() {
            return (
                Self {
                    drag_translation_base: Some(translation),
                    ..tracked
                },
                false,
            );
        }
        if !tracked.can_pan(context) {
            return (tracked, false);
        }
        let baseline = tracked.drag_translation_base.unwrap_or(Size::ZERO);
        let raw = Size::new(
            tracked.base_pan.width + translation.width - baseline.width,
            tracked.base_pan.height + translation.height - baseline.height,
        );
        (
            Self {
                pan_offset: context.clamped_pan_from(raw, tracked.pixel_scale, tracked.base_pan),
                ..tracked
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
            drag_last_translation: None,
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
            drag_last_translation: Some(translation),
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
        .continuing(context)
    }

    /// Command-scroll zoom anchored at the cursor; positive deltas zoom in.
    /// Crossing fit settles there at once (a wheel has no gesture end); a
    /// wheel against the cap or the floor changes nothing.
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
            .min(context.max_scale().max(current))
            .max(context.min_scale().min(current));
        if next == current {
            return self;
        }
        if crosses_fit(current, next, context.fit_scale()) {
            return self.reset_to_fit(context);
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
        .continuing(context)
    }

    /// Double-tap per `behavior`. The editor zooms fit → 100% anchored at the
    /// tap (the visible centre when the tap location is not finite) and any
    /// zoomed state back to fit. An image that fits at or above 100% zooms to
    /// `max_scale` instead, since 100% would shrink it, and stays at fit when
    /// that is inside fit's detent band.
    #[must_use]
    pub fn double_tap(
        self,
        location: Point,
        behavior: DoubleTapBehavior,
        context: &CanvasZoomContext,
    ) -> Self {
        if behavior == DoubleTapBehavior::ResetToFit || self.is_zoomed_in() {
            return self.reset_to_fit(context);
        }
        let viewport = context.viewport_points();
        let anchor = if location.is_finite() {
            location
        } else {
            context.visible_centre()
        };
        let fit = context.fit_scale();
        // Fit reads 1 while the image or viewport is unknown; that is not
        // an image that fits at 100%.
        let shrinks_at_100 = context.geometry_known() && fit >= 1.0;
        let target = if shrinks_at_100 {
            context.max_scale()
        } else {
            1.0
        };
        if shrinks_at_100 && target <= fit * (1.0 + DETENT_TOLERANCE) {
            return self;
        }
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
        .continuing(context)
    }

    /// Fit mode, centred in the visible area. A live pinch or drag
    /// continues from fit (#5737).
    #[must_use]
    pub fn reset_to_fit(self, context: &CanvasZoomContext) -> Self {
        let home = context.home_pan();
        Self {
            pixel_scale: 0.0,
            fills_viewport: false,
            pan_offset: home,
            base_pan: home,
            ..self
        }
        .continuing(context)
    }

    /// Explicit zoom target (toolbar "100%", ⌘1), clamped, re-centred in the
    /// visible area.
    #[must_use]
    pub fn zoom_to_scale(self, scale: f64, context: &CanvasZoomContext) -> Self {
        let home = context.home_pan();
        Self {
            pixel_scale: clamped_explicit_zoom(scale),
            fills_viewport: false,
            pan_offset: home,
            base_pan: home,
            ..self
        }
        .continuing(context)
    }

    /// The fill stop, centred in the visible area; the overflowing axis can
    /// then be panned.
    #[must_use]
    pub fn zoom_to_fill(self, context: &CanvasZoomContext) -> Self {
        let home = context.home_pan();
        Self {
            pixel_scale: context.fill_scale(),
            fills_viewport: true,
            pan_offset: home,
            base_pan: home,
            ..self
        }
        .continuing(context)
    }

    /// Badge tap: the next stop in `fit → fill → 100%`; a free scale returns
    /// to fit.
    #[must_use]
    pub fn advance_stop(self, context: &CanvasZoomContext) -> Self {
        match next_stop(self.current_stop(), Self::badge_stops(context).as_slice()) {
            ZoomStop::Fit => self.reset_to_fit(context),
            ZoomStop::Fill => self.zoom_to_fill(context),
            ZoomStop::ActualSize => self.zoom_to_scale(1.0, context),
        }
    }

    /// Zoom-in step anchored at the visible centre; reaching fit from below
    /// settles on it, and a step at the cap changes nothing.
    #[must_use]
    pub fn step_zoom_in(self, context: &CanvasZoomContext) -> Self {
        let current = context.effective_scale(self.pixel_scale);
        let next = zoom_in_target(current, context.max_scale());
        if next <= current {
            return self;
        }
        if crosses_fit(current, next, context.fit_scale()) {
            return self.reset_to_fit(context);
        }
        self.rescaled_pan(current, next, context)
            .at_free_scale(next)
            .continuing(context)
    }

    /// Zoom-out step anchored at the visible centre; reaching fit from above
    /// settles on it, and a step at (or below) the floor changes nothing.
    #[must_use]
    pub fn step_zoom_out(self, context: &CanvasZoomContext) -> Self {
        let current = context.effective_scale(self.pixel_scale);
        match zoom_out_target(current, context.fit_scale()) {
            ZoomOutResult::SnapToFit => self.reset_to_fit(context),
            ZoomOutResult::Scale(next) if next >= current => self,
            ZoomOutResult::Scale(next) => self
                .rescaled_pan(current, next, context)
                .at_free_scale(next)
                .continuing(context),
        }
    }

    /// Re-resolve against fresh geometry when the previous geometry is not
    /// known (`geometry_changed` carries the zoom when it is): fit re-centres
    /// in the new visible area, fill follows it — or becomes fit when the two
    /// now coincide — and any other pan is pulled back inside the legal
    /// range, so a pan already inside it does not move. A live pinch or drag
    /// continues from the result (#5736).
    #[must_use]
    pub fn reclamp_pan(self, context: &CanvasZoomContext) -> Self {
        self.resolved_at_rest(context)
            .continuing_in_new_geometry(context)
    }

    /// `reclamp_pan` without re-capturing a live gesture.
    pub(super) fn resolved_at_rest(self, context: &CanvasZoomContext) -> Self {
        if !self.is_zoomed_in() {
            let home = context.home_pan();
            return Self {
                pixel_scale: 0.0,
                fills_viewport: false,
                pan_offset: home,
                base_pan: home,
                ..self
            };
        }
        let resolved = if !self.fills_viewport {
            self
        } else if Self::badge_stops(context).contains(ZoomStop::Fill) {
            Self {
                pixel_scale: context.fill_scale(),
                ..self
            }
        } else {
            let home = context.home_pan();
            return Self {
                pixel_scale: 0.0,
                fills_viewport: false,
                pan_offset: home,
                base_pan: home,
                ..self
            };
        };
        let clamped = context.clamped_pan(resolved.pan_offset, resolved.pixel_scale);
        Self {
            pan_offset: clamped,
            base_pan: clamped,
            ..resolved
        }
    }

    fn at_free_scale(self, scale: f64) -> Self {
        Self {
            pixel_scale: scale,
            fills_viewport: false,
            ..self
        }
    }

    /// Pan rescale anchored at the visible centre, shared by the zoom steps.
    fn rescaled_pan(self, current: f64, next: f64, context: &CanvasZoomContext) -> Self {
        if current.is_nan() || current <= 0.0 {
            return self;
        }
        let pan = context.clamped_pan(
            anchored_pan(
                context.visible_centre(),
                context.viewport_points(),
                self.pan_offset,
                current,
                next,
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
