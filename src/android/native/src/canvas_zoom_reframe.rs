//! The zoom carried across a change that is not a gesture (#5748): a new
//! viewport (rotation, a fold posture), a new image extent under a crop or
//! straighten, and a gesture that was cancelled instead of ending. The rule
//! is the one the screen shows: the image point at the viewport centre stays
//! at the centre, as far as the pan limit allows.

use super::*;

/// `model` carried from `previous` to `next`. `extent` is where the next
/// image lies in the previous image's pixels (the whole previous image when
/// only the viewport changed; the new crop's rectangle when a crop changed).
/// 100% stays 1:1, fill re-resolves, and a free scale keeps the content's
/// size on screen within the next floor and cap; a live pinch keeps the
/// content's size on screen at any stop. The result is not yet clamped: the
/// caller's `continued` re-resolves it at rest, or holds a live pinch only
/// to the pinch's floor and cap and continues it.
pub(super) fn reframe(
    model: CanvasZoomModel,
    extent: Rect,
    previous: &CanvasZoomContext,
    next: &CanvasZoomContext,
) -> CanvasZoomModel {
    if !model.is_zoomed_in() {
        return model;
    }
    if !extent.is_finite() || extent.width <= 0.0 || extent.height <= 0.0 {
        return model;
    }
    let old_image = previous.native_image_size();
    let new_image = next.native_image_size();
    let start = previous.effective_scale(model.pixel_scale);
    let kept_size = (start * extent.width / new_image.width).min(MAX_PIXEL_SCALE);
    let scale = if model.pinch_start_scale.is_some() {
        kept_size
    } else {
        match model.current_stop() {
            Some(ZoomStop::Fill) => next.fill_scale(),
            Some(ZoomStop::Fit | ZoomStop::ActualSize) => model.pixel_scale,
            None => kept_size.max(next.min_scale()),
        }
    };
    let to_image = previous.display_scale() / start;
    let centred = Point::new(
        old_image.width / 2.0 - model.pan_offset.width * to_image,
        old_image.height / 2.0 - model.pan_offset.height * to_image,
    );
    let mapped = Point::new(
        (centred.x - extent.x) * new_image.width / extent.width,
        (centred.y - extent.y) * new_image.height / extent.height,
    );
    let to_points = next.effective_scale(scale) / next.display_scale();
    let pan = Size::new(
        (new_image.width / 2.0 - mapped.x) * to_points,
        (new_image.height / 2.0 - mapped.y) * to_points,
    );
    if !pan.is_finite() || !scale.is_finite() {
        return model;
    }
    CanvasZoomModel {
        pixel_scale: scale,
        pan_offset: pan,
        base_pan: pan,
        ..model
    }
}

/// Ends a pinch or drag whose gesture was cancelled (its view left the
/// screen, or the activity was recreated mid-gesture) at its last input, so
/// the next gesture starts from what is on screen.
pub(super) fn settle(model: CanvasZoomModel, context: &CanvasZoomContext) -> CanvasZoomModel {
    model.pinch_cancelled(context).drag_ended().0
}
