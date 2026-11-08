//! Live gestures across discontinuities that are not finger motion (#5714).
//!
//! The one rule: a change of geometry (viewport or image extent, including a
//! placeholder size replaced by the original's) or of the fingers taking part
//! in a pinch re-captures the gesture in progress, so the next frame with the
//! same cumulative finger input reproduces the current zoom exactly and the
//! gesture then continues from it. The shared model keeps the live input and
//! does the re-capture (`raw_core::canvas` continuity, #5717); this file picks
//! the transition for each Android event.

use super::*;

/// `model` under `context`, with any live gesture continuing from it. At
/// rest the zoom re-resolves for the new geometry. A live pinch instead keeps
/// the frame Android is drawing (the committed one) as it stands, outside the
/// resting range and below fit alike, held only to the pinch's floor and cap,
/// as the shared model's `geometry_changed` carries a live pinch; its release
/// settles. The re-capture makes that frame the one the pinch's next
/// identical input draws.
pub(super) fn continued(model: CanvasZoomModel, context: &CanvasZoomContext) -> CanvasZoomModel {
    if model.pinch_start_scale.is_none() {
        return model.reclamp_pan(context);
    }
    let magnification = model.pinch_last_magnification;
    let centroid = model.pinch_last_centroid;
    // A pinch frame with no start captures the frame as it stands (#5737);
    // repeating the input then commits the frame that capture draws. Every
    // caller is a geometry change, so the frame is first held to the new
    // geometry's floor and cap: a pinch beginning at rest would otherwise
    // keep a scale outside them.
    let recaptured = CanvasZoomModel {
        pinch_start_scale: None,
        pixel_scale: held_pinch_scale(
            context.effective_scale(model.pixel_scale),
            context.fit_scale(),
            context.fill_scale(),
        ),
        ..model
    }
    .pinch_changed(magnification, centroid, context);
    if recaptured.pinch_start_scale.is_none() {
        return model;
    }
    recaptured.pinch_changed(magnification, centroid, context)
}

/// `model` re-resolved and re-captured for `geometry` when it differs from the
/// geometry of the previous call (`stored`, `None` before the first): a new
/// viewport keeps the image point at its centre (`reframe`). Adoption and a
/// reframe carry their own previous extent, and a drag release uses no
/// geometry.
pub(super) fn rebased_for_geometry(
    model: CanvasZoomModel,
    op: u32,
    stored: Option<Geometry>,
    geometry: Geometry,
) -> CanvasZoomModel {
    match stored {
        Some(previous)
            if previous != geometry
                && !matches!(op, OP_ADOPT_IMAGE | OP_REFRAME_IMAGE | OP_DRAG_ENDED) =>
        {
            let context = geometry.context();
            let carried = if previous.image == geometry.image {
                reframe(
                    model,
                    Rect::from_size(previous.image),
                    &previous.context(),
                    &context,
                )
            } else {
                model
            };
            continued(carried, &context)
        }
        _ => model,
    }
}

/// The fingers taking part in a pinch changed: the pinch continues about
/// their new centroid `at` (viewport pixels) from the current zoom. Kotlin's
/// magnification carries across the change, so only the centroid moves.
pub(super) fn rebase_pinch(
    model: CanvasZoomModel,
    at: Point,
    context: &CanvasZoomContext,
) -> CanvasZoomModel {
    let magnification = model.pinch_last_magnification;
    model.pinch_rebased(
        magnification,
        model.pinch_last_centroid,
        magnification,
        at,
        context,
    )
}

/// Carries the zoom across the image extent changing under it (a placeholder
/// size replaced by the original's): a free scale keeps its on-screen size,
/// a named stop keeps its meaning (100% stays 1:1, fill re-resolves), and the
/// image point under `anchor` (viewport pixels) stays as close as the pan
/// clamp allows. The caller continues any live gesture from the result.
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
        None => (start_scale * next.fit_scale() / previous.fit_scale()).min(next.max_scale()),
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
}
