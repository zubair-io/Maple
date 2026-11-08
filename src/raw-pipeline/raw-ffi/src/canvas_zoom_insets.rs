//! Visible-area FFI for the canvas zoom model (#5749): the chrome insets a
//! host passes on its `MapleCanvasZoomContext`, the queries that resolve
//! against the visible area, and holding the frame an interrupted settle
//! animation was showing.

use crate::canvas_math::MapleCanvasSize;
use crate::canvas_zoom::{zoom_transition, MapleCanvasZoomContext, MapleCanvasZoomState};
use raw_core::canvas::{CanvasZoomContext, Insets};

/// Points of the viewport the host's chrome covers from each edge.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MapleCanvasInsets {
    pub top: f64,
    pub left: f64,
    pub bottom: f64,
    pub right: f64,
}

impl From<MapleCanvasInsets> for Insets {
    fn from(insets: MapleCanvasInsets) -> Self {
        Insets::new(insets.top, insets.left, insets.bottom, insets.right)
    }
}

impl From<Insets> for MapleCanvasInsets {
    fn from(insets: Insets) -> Self {
        Self {
            top: insets.top,
            left: insets.left,
            bottom: insets.bottom,
            right: insets.right,
        }
    }
}

/// `pixel_scale` with `0 == fit` resolved against the visible area.
#[no_mangle]
pub extern "C" fn maple_canvas_zoom_effective_scale(
    context: MapleCanvasZoomContext,
    pixel_scale: f64,
) -> f64 {
    crate::error::catch_panic("maple_canvas_zoom_effective_scale", 1.0, || {
        CanvasZoomContext::from(context).effective_scale(pixel_scale)
    })
}

/// The pan that centres the image in the visible area.
#[no_mangle]
pub extern "C" fn maple_canvas_zoom_home_pan(context: MapleCanvasZoomContext) -> MapleCanvasSize {
    crate::error::catch_panic(
        "maple_canvas_zoom_home_pan",
        MapleCanvasSize::default(),
        || CanvasZoomContext::from(context).home_pan().into(),
    )
}

/// Rest at the frame an interrupted settle was showing (`scale` real pixels
/// per image pixel, `pan` points from the viewport centre).
#[no_mangle]
pub extern "C" fn maple_canvas_zoom_hold_shown(
    state: MapleCanvasZoomState,
    scale: f64,
    pan: MapleCanvasSize,
    context: MapleCanvasZoomContext,
) -> MapleCanvasZoomState {
    zoom_transition(
        "maple_canvas_zoom_hold_shown",
        state,
        context,
        |model, ctx| model.hold_shown(scale, pan.into(), ctx),
    )
}
