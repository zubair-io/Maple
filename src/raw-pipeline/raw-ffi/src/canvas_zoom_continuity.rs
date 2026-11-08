//! Continuity FFI for the canvas zoom model (#5717): the transitions that
//! keep a live pinch or drag continuous across what is not finger motion —
//! a geometry change, a new drag after a lost release, a cancelled gesture —
//! and the live pinch input a frame-freezing host records.

use crate::canvas_math::MapleCanvasPoint;
use crate::canvas_zoom::{zoom_transition, MapleCanvasZoomContext, MapleCanvasZoomState};
use raw_core::canvas::{CanvasZoomContext, CanvasZoomModel};

/// The geometry changed from `previous` to `context` (viewport, insets,
/// display scale or image extent): the zoom carries across and a live pinch
/// or drag continues from the frame on screen.
#[no_mangle]
pub extern "C" fn maple_canvas_zoom_geometry_changed(
    state: MapleCanvasZoomState,
    previous: MapleCanvasZoomContext,
    context: MapleCanvasZoomContext,
) -> MapleCanvasZoomState {
    zoom_transition(
        "maple_canvas_zoom_geometry_changed",
        state,
        context,
        |model, ctx| model.geometry_changed(&CanvasZoomContext::from(previous), ctx),
    )
}

/// The picture's real extent (`context`) replaced the provisional one the
/// host gave while it was unknown (`previous`): the photo keeps its rect on
/// screen exactly, at rest, mid-pinch and mid-drag.
#[no_mangle]
pub extern "C" fn maple_canvas_zoom_image_extent_resolved(
    state: MapleCanvasZoomState,
    previous: MapleCanvasZoomContext,
    context: MapleCanvasZoomContext,
) -> MapleCanvasZoomState {
    zoom_transition(
        "maple_canvas_zoom_image_extent_resolved",
        state,
        context,
        |model, ctx| model.image_extent_resolved(&CanvasZoomContext::from(previous), ctx),
    )
}

/// A new drag gesture began: commit what the previous drag left on screen.
#[no_mangle]
pub extern "C" fn maple_canvas_zoom_drag_began(
    state: MapleCanvasZoomState,
) -> MapleCanvasZoomState {
    crate::error::catch_panic("maple_canvas_zoom_drag_began", state, || {
        CanvasZoomModel::from(state).drag_began().into()
    })
}

/// Record the live pinch input without moving the committed frame.
#[no_mangle]
pub extern "C" fn maple_canvas_zoom_pinch_tracked(
    state: MapleCanvasZoomState,
    magnification: f64,
    location: MapleCanvasPoint,
) -> MapleCanvasZoomState {
    crate::error::catch_panic("maple_canvas_zoom_pinch_tracked", state, || {
        CanvasZoomModel::from(state)
            .pinch_tracked(magnification, location.into())
            .into()
    })
}

/// The pinch was cancelled: it ends at its last input and settles; a live
/// drag continues from the result.
#[no_mangle]
pub extern "C" fn maple_canvas_zoom_pinch_cancelled(
    state: MapleCanvasZoomState,
    context: MapleCanvasZoomContext,
) -> MapleCanvasZoomState {
    zoom_transition(
        "maple_canvas_zoom_pinch_cancelled",
        state,
        context,
        |model, ctx| model.pinch_cancelled(ctx),
    )
}

/// The drag was cancelled: it commits where it is; a live pinch stays live.
#[no_mangle]
pub extern "C" fn maple_canvas_zoom_drag_cancelled(
    state: MapleCanvasZoomState,
) -> MapleCanvasZoomState {
    crate::error::catch_panic("maple_canvas_zoom_drag_cancelled", state, || {
        CanvasZoomModel::from(state).drag_cancelled().into()
    })
}

#[cfg(test)]
#[path = "canvas_zoom_continuity_tests.rs"]
mod tests;
