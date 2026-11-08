//! Canvas geometry shared by every platform shell (#5714): the fit / fill /
//! 100% zoom model with its gesture transitions, and the mapping between the
//! viewport and the oriented image (fit scale, on-screen frame, render
//! targets, visible source rect).
//!
//! Every type is a `Copy` value with no allocation, and every function is a
//! total function of its inputs: non-finite or negative sizes, a zero
//! viewport, or a missing image extent degrade to documented fallbacks rather
//! than panicking. Units: viewport and pan in POINTS unless a name says `px`;
//! image extents in oriented source pixels; a `pixel_scale` is real screen
//! pixels per image pixel, with `0` meaning fit-to-viewport.

mod geometry;
mod mapping;
mod zoom;
mod zoom_context;
mod zoom_queries;
mod zoom_rules;

pub use geometry::{Point, Rect, Size};
pub use mapping::{CanvasMath, MAX_TEXTURE_EDGE};
pub use zoom::{
    CanvasZoomModel, DoubleTapBehavior, DETENT_TOLERANCE, MAX_PIXEL_SCALE, MIN_EXPLICIT_ZOOM,
    MIN_FIT_FRACTION, WHEEL_ZOOM_SENSITIVITY, ZOOM_STEP,
};
pub use zoom_context::CanvasZoomContext;
pub use zoom_queries::{DragIntent, WheelIntent};
pub use zoom_rules::{
    anchored_pan, clamped_explicit_zoom, crosses_fit, detent, distinct_stops, live_pinch_pan,
    next_stop, pinch_scale, zoom_in_target, zoom_out_target, ZoomOutResult, ZoomStop, ZoomStops,
};
