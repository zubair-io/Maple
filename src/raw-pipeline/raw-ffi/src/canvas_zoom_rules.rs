//! Stateless canvas zoom rules over FFI (#5714): detents, zoom-out targets,
//! stop cycles and the focal-anchored pan formulas from `raw_core::canvas`.
//! Stops travel as `MAPLE_CANVAS_ZOOM_STOP_*` codes; an unknown code reads as
//! "no stop" and is dropped from a stop list.

use crate::canvas_math::{MapleCanvasPoint, MapleCanvasSize};
use crate::canvas_zoom::MapleCanvasZoomContext;
use raw_core::canvas::{self, CanvasZoomModel, ZoomOutResult, ZoomStop, ZoomStops};

pub const MAPLE_CANVAS_ZOOM_STOP_NONE: u32 = 0;
pub const MAPLE_CANVAS_ZOOM_STOP_FIT: u32 = 1;
pub const MAPLE_CANVAS_ZOOM_STOP_FILL: u32 = 2;
pub const MAPLE_CANVAS_ZOOM_STOP_ACTUAL_SIZE: u32 = 3;

/// One zoom-out step: `snap_to_fit`, or else `scale`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MapleCanvasZoomOutTarget {
    pub snap_to_fit: bool,
    pub scale: f64,
}

/// Up to three stop codes in cycle order; `len` counts the valid entries.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MapleCanvasZoomStops {
    pub len: u32,
    pub stops: [u32; 3],
}

pub(crate) fn stop_code(stop: Option<ZoomStop>) -> u32 {
    match stop {
        None => MAPLE_CANVAS_ZOOM_STOP_NONE,
        Some(ZoomStop::Fit) => MAPLE_CANVAS_ZOOM_STOP_FIT,
        Some(ZoomStop::Fill) => MAPLE_CANVAS_ZOOM_STOP_FILL,
        Some(ZoomStop::ActualSize) => MAPLE_CANVAS_ZOOM_STOP_ACTUAL_SIZE,
    }
}

fn stop_from_code(code: u32) -> Option<ZoomStop> {
    match code {
        MAPLE_CANVAS_ZOOM_STOP_FIT => Some(ZoomStop::Fit),
        MAPLE_CANVAS_ZOOM_STOP_FILL => Some(ZoomStop::Fill),
        MAPLE_CANVAS_ZOOM_STOP_ACTUAL_SIZE => Some(ZoomStop::ActualSize),
        _ => None,
    }
}

fn stops_to_ffi(stops: ZoomStops) -> MapleCanvasZoomStops {
    let slice = stops.as_slice();
    MapleCanvasZoomStops {
        len: slice.len() as u32,
        stops: std::array::from_fn(|index| stop_code(slice.get(index).copied())),
    }
}

/// The valid stops among the first `len` (at most three) codes.
fn stops_from_ffi(stops: MapleCanvasZoomStops) -> ZoomStops {
    let len = (stops.len as usize).min(stops.stops.len());
    let mut decoded = [ZoomStop::Fit; 3];
    let mut count = 0;
    for stop in stops.stops[..len]
        .iter()
        .filter_map(|&code| stop_from_code(code))
    {
        decoded[count] = stop;
        count += 1;
    }
    ZoomStops::from_slice(&decoded[..count])
}

#[no_mangle]
pub extern "C" fn maple_canvas_zoom_badge_stops(
    context: MapleCanvasZoomContext,
) -> MapleCanvasZoomStops {
    crate::error::catch_panic(
        "maple_canvas_zoom_badge_stops",
        MapleCanvasZoomStops::default(),
        || stops_to_ffi(CanvasZoomModel::badge_stops(&context.into())),
    )
}

/// `has_actual_size` = 0 means the surface has no 100% stop and
/// `actual_size` is ignored.
#[no_mangle]
pub extern "C" fn maple_canvas_zoom_distinct_stops(
    fit: f64,
    fill: f64,
    has_actual_size: u8,
    actual_size: f64,
) -> MapleCanvasZoomStops {
    crate::error::catch_panic(
        "maple_canvas_zoom_distinct_stops",
        MapleCanvasZoomStops::default(),
        || {
            let actual = (has_actual_size != 0).then_some(actual_size);
            stops_to_ffi(canvas::distinct_stops(fit, fill, actual))
        },
    )
}

#[no_mangle]
pub extern "C" fn maple_canvas_zoom_next_stop(current: u32, stops: MapleCanvasZoomStops) -> u32 {
    crate::error::catch_panic(
        "maple_canvas_zoom_next_stop",
        MAPLE_CANVAS_ZOOM_STOP_FIT,
        || {
            let next = canvas::next_stop(stop_from_code(current), stops_from_ffi(stops).as_slice());
            stop_code(Some(next))
        },
    )
}

#[no_mangle]
pub extern "C" fn maple_canvas_zoom_detent(scale: f64, fit: f64, fill: f64) -> u32 {
    crate::error::catch_panic(
        "maple_canvas_zoom_detent",
        MAPLE_CANVAS_ZOOM_STOP_NONE,
        || stop_code(canvas::detent(scale, fit, fill)),
    )
}

#[no_mangle]
pub extern "C" fn maple_canvas_zoom_pinch_scale(start: f64, magnification: f64, fit: f64) -> f64 {
    crate::error::catch_panic("maple_canvas_zoom_pinch_scale", start, || {
        canvas::pinch_scale(start, magnification, fit)
    })
}

#[no_mangle]
pub extern "C" fn maple_canvas_zoom_crosses_fit(current: f64, next: f64, fit: f64) -> bool {
    crate::error::catch_panic("maple_canvas_zoom_crosses_fit", false, || {
        canvas::crosses_fit(current, next, fit)
    })
}

#[no_mangle]
pub extern "C" fn maple_canvas_zoom_out_target(current: f64, fit: f64) -> MapleCanvasZoomOutTarget {
    crate::error::catch_panic(
        "maple_canvas_zoom_out_target",
        MapleCanvasZoomOutTarget {
            snap_to_fit: true,
            scale: 0.0,
        },
        || match canvas::zoom_out_target(current, fit) {
            ZoomOutResult::SnapToFit => MapleCanvasZoomOutTarget {
                snap_to_fit: true,
                scale: 0.0,
            },
            ZoomOutResult::Scale(scale) => MapleCanvasZoomOutTarget {
                snap_to_fit: false,
                scale,
            },
        },
    )
}

#[no_mangle]
pub extern "C" fn maple_canvas_zoom_anchored_pan(
    anchor: MapleCanvasPoint,
    viewport_points: MapleCanvasSize,
    start_pan: MapleCanvasSize,
    start_scale: f64,
    new_scale: f64,
) -> MapleCanvasSize {
    crate::error::catch_panic("maple_canvas_zoom_anchored_pan", start_pan, || {
        canvas::anchored_pan(
            anchor.into(),
            viewport_points.into(),
            start_pan.into(),
            start_scale,
            new_scale,
        )
        .into()
    })
}

#[no_mangle]
pub extern "C" fn maple_canvas_zoom_live_pinch_pan(
    live_centroid: MapleCanvasPoint,
    start_centroid: MapleCanvasPoint,
    start_pan: MapleCanvasSize,
    start_scale: f64,
    new_scale: f64,
    viewport_points: MapleCanvasSize,
) -> MapleCanvasSize {
    crate::error::catch_panic("maple_canvas_zoom_live_pinch_pan", start_pan, || {
        canvas::live_pinch_pan(
            live_centroid.into(),
            start_centroid.into(),
            start_pan.into(),
            start_scale,
            new_scale,
            viewport_points.into(),
        )
        .into()
    })
}
