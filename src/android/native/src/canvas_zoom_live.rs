//! Live gestures across discontinuities that are not finger motion (#5714).
//!
//! The one rule: a change of geometry (viewport or image extent, including a
//! placeholder size replaced by the original's) or of the fingers taking part
//! in a pinch re-captures the gesture in progress, so the next frame with the
//! same cumulative finger input reproduces the current zoom exactly and the
//! gesture then continues from it. Every such event goes through
//! [`recapture_live_gesture`].

use super::*;

/// The live gesture's last cumulative input as Kotlin sent it: the pinch
/// magnification (0 when no pinch is in progress) and the drag translation
/// (zero once the drag ends, and at fit, where nothing pans). The model keeps
/// only clamped results, which cannot recover these once a pinch or drag has
/// run into a limit.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct LiveGesture {
    pub(super) pinch_magnification: f64,
    pub(super) drag_translation: Size,
}

impl LiveGesture {
    pub(super) fn read(state: &[f64; STATE_LEN]) -> Self {
        Self {
            pinch_magnification: state[PINCH_MAGNIFICATION_SLOT],
            drag_translation: Size::new(
                state[DRAG_TRANSLATION_SLOT],
                state[DRAG_TRANSLATION_SLOT + 1],
            ),
        }
    }

    pub(super) fn write(self, state: &mut [f64; STATE_LEN]) {
        state[PINCH_MAGNIFICATION_SLOT] = self.pinch_magnification;
        state[DRAG_TRANSLATION_SLOT] = self.drag_translation.width;
        state[DRAG_TRANSLATION_SLOT + 1] = self.drag_translation.height;
    }

    /// The input to keep after `op` (first arguments `a`, `b`) produced
    /// `next`: the latest values Kotlin sent while each gesture is live.
    pub(super) fn after(self, op: u32, a: f64, b: f64, next: &CanvasZoomModel) -> Self {
        let pinch_magnification = match (next.pinch_start_scale, op) {
            (None, _) => 0.0,
            (Some(_), OP_PINCH_CHANGED) if a.is_finite() => a,
            (Some(_), _) => self.pinch_magnification,
        };
        let translation = Size::new(a, b);
        let drag_translation = match op {
            _ if !next.is_zoomed_in() => Size::ZERO,
            OP_DRAG_ENDED => Size::ZERO,
            OP_DRAG_CHANGED | OP_REBASE_DRAG if translation.is_finite() => translation,
            _ => self.drag_translation,
        };
        Self {
            pinch_magnification,
            drag_translation,
        }
    }
}

/// Re-anchors the live gesture on `model` under `context`, so the gesture's
/// next frame with the same cumulative input reproduces the result. A drag's
/// committed pan absorbs its translation so far; a pinch restarts at its last
/// centroid with its magnification so far, as if it had begun on `model`,
/// after first settling on the floor, cap, fit or fill band its next frame
/// would apply under `context`.
pub(super) fn recapture_live_gesture(
    model: CanvasZoomModel,
    live: LiveGesture,
    context: &CanvasZoomContext,
) -> CanvasZoomModel {
    let drag_base = model.drag_translation_base.unwrap_or(Size::ZERO);
    let dragged = Size::new(
        live.drag_translation.width - drag_base.width,
        live.drag_translation.height - drag_base.height,
    );
    let rebased = if model.is_zoomed_in() {
        CanvasZoomModel {
            base_pan: Size::new(
                model.pan_offset.width - dragged.width,
                model.pan_offset.height - dragged.height,
            ),
            ..model
        }
    } else {
        model
    };
    let magnification = live.pinch_magnification;
    if rebased.pinch_start_scale.is_none() || !magnification.is_finite() || magnification <= 0.0 {
        return rebased;
    }
    let captured = recapture_pinch(rebased, magnification, context);
    let settled = captured.pinch_changed(magnification, captured.pinch_last_centroid, context);
    recapture_pinch(settled, magnification, context)
}

/// The pinch start that makes `magnification` about the last centroid land
/// exactly on `model`.
fn recapture_pinch(
    model: CanvasZoomModel,
    magnification: f64,
    context: &CanvasZoomContext,
) -> CanvasZoomModel {
    let centroid = model.pinch_last_centroid;
    let viewport = context.viewport_points();
    let offset = Size::new(
        centroid.x - viewport.width / 2.0,
        centroid.y - viewport.height / 2.0,
    );
    CanvasZoomModel {
        pinch_start_scale: Some(context.effective_scale(model.pixel_scale) / magnification),
        pinch_start_centroid: centroid,
        pinch_start_pan: Size::new(
            offset.width - (offset.width - model.pan_offset.width) / magnification,
            offset.height - (offset.height - model.pan_offset.height) / magnification,
        ),
        ..model
    }
}

/// `model` re-resolved and re-captured for `geometry` when it differs from the
/// geometry of the previous call (`stored`, `None` before the first). Adoption
/// carries its own previous extent, and a drag release uses no geometry.
pub(super) fn rebased_for_geometry(
    model: CanvasZoomModel,
    op: u32,
    live: LiveGesture,
    stored: Option<Geometry>,
    geometry: Geometry,
) -> CanvasZoomModel {
    match stored {
        Some(previous) if previous != geometry && !matches!(op, OP_ADOPT_IMAGE | OP_DRAG_ENDED) => {
            let context = geometry.context();
            recapture_live_gesture(model.reclamp_pan(&context), live, &context)
        }
        _ => model,
    }
}

/// The fingers taking part in a pinch changed: the pinch continues about
/// their new centroid `at` (viewport pixels) from the current zoom.
pub(super) fn rebase_pinch(
    model: CanvasZoomModel,
    at: Point,
    live: LiveGesture,
    context: &CanvasZoomContext,
) -> CanvasZoomModel {
    if model.pinch_start_scale.is_none() || !at.is_finite() {
        return model;
    }
    let moved = CanvasZoomModel {
        pinch_last_centroid: at,
        ..model
    };
    recapture_live_gesture(moved, live, context)
}

/// Carries the zoom across the image extent changing under it (a placeholder
/// size replaced by the original's): a free scale keeps its on-screen size,
/// a named stop keeps its meaning (100% stays 1:1, fill re-resolves), and the
/// image point under `anchor` (viewport pixels) stays as close as the pan
/// clamp allows. The caller re-captures any live gesture on the result.
pub(super) fn adopt_image_size(
    model: CanvasZoomModel,
    anchor: Point,
    previous: &CanvasZoomContext,
    next: &CanvasZoomContext,
) -> CanvasZoomModel {
    if !model.is_zoomed_in() {
        return model;
    }
    let start_scale = previous.effective_scale(model.pixel_scale);
    let scale = match model.current_stop() {
        Some(ZoomStop::Fill) => next.fill_scale(),
        Some(ZoomStop::Fit | ZoomStop::ActualSize) => model.pixel_scale,
        None => (start_scale * next.fit_scale() / previous.fit_scale()).min(MAX_PIXEL_SCALE),
    };
    let pan = anchored_pan(
        anchor,
        next.viewport_points(),
        model.pan_offset,
        start_scale * previous.native_image_size().width,
        next.effective_scale(scale) * next.native_image_size().width,
    );
    CanvasZoomModel {
        pixel_scale: scale,
        pan_offset: pan,
        base_pan: pan,
        ..model
    }
    .reclamp_pan(next)
}
