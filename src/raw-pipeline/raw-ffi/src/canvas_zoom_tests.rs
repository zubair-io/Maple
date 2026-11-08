use super::*;
use crate::canvas_zoom_rules::*;

fn landscape() -> MapleCanvasZoomContext {
    MapleCanvasZoomContext {
        viewport_points: MapleCanvasSize {
            width: 1000.0,
            height: 800.0,
        },
        native_image_size: MapleCanvasSize {
            width: 8000.0,
            height: 6000.0,
        },
        display_scale: 2.0,
    }
}

fn stops(codes: &[u32]) -> MapleCanvasZoomStops {
    let mut padded = [0; 3];
    padded[..codes.len()].copy_from_slice(codes);
    MapleCanvasZoomStops {
        len: codes.len() as u32,
        stops: padded,
    }
}

#[test]
fn state_round_trips_through_the_core_model() {
    let state = MapleCanvasZoomState {
        pixel_scale: 0.5,
        pan_offset: MapleCanvasSize {
            width: 1.0,
            height: 2.0,
        },
        base_pan: MapleCanvasSize {
            width: 3.0,
            height: 4.0,
        },
        has_drag_translation_base: 1,
        drag_translation_base: MapleCanvasSize {
            width: 5.0,
            height: 6.0,
        },
        has_pinch_start_scale: 1,
        pinch_start_scale: 0.25,
        pinch_start_pan: MapleCanvasSize {
            width: 7.0,
            height: 8.0,
        },
        pinch_start_centroid: MapleCanvasPoint { x: 9.0, y: 10.0 },
        pinch_last_centroid: MapleCanvasPoint { x: 11.0, y: 12.0 },
        fills_viewport: 1,
    };
    assert_eq!(
        MapleCanvasZoomState::from(CanvasZoomModel::from(state)),
        state
    );
    assert_eq!(
        CanvasZoomModel::from(MapleCanvasZoomState::default()),
        CanvasZoomModel::default()
    );
}

#[test]
fn transitions_thread_the_state_through() {
    let context = landscape();
    let centre = MapleCanvasPoint { x: 500.0, y: 400.0 };
    let live =
        maple_canvas_zoom_pinch_changed(MapleCanvasZoomState::default(), 2.0, centre, context);
    assert_eq!(live.has_pinch_start_scale, 1);
    assert_eq!(live.pixel_scale, 0.5);
    let released = maple_canvas_zoom_pinch_ended(live, 2.0, context);
    assert_eq!(released.has_pinch_start_scale, 0);
    let panned = maple_canvas_zoom_drag_changed(
        released,
        MapleCanvasSize {
            width: 40.0,
            height: 0.0,
        },
        context,
    );
    assert!(panned.handled);
    assert_eq!(panned.state.pan_offset.width, 40.0);
    let committed = maple_canvas_zoom_drag_ended(panned.state);
    assert!(committed.handled);
    assert_eq!(committed.state.base_pan.width, 40.0);
    assert_eq!(
        maple_canvas_zoom_drag_intent(committed.state, context),
        MAPLE_CANVAS_DRAG_INTENT_PAN
    );
    assert_eq!(
        maple_canvas_zoom_wheel_intent(MapleCanvasZoomState::default(), 0, context),
        MAPLE_CANVAS_WHEEL_INTENT_EDITING
    );
}

#[test]
fn double_tap_decodes_the_behaviour_and_treats_unknown_codes_as_reset() {
    let context = landscape();
    let tap = MapleCanvasPoint { x: 250.0, y: 200.0 };
    let fit = MapleCanvasZoomState::default();
    let toggled = maple_canvas_zoom_double_tap(
        fit,
        tap,
        MAPLE_CANVAS_DOUBLE_TAP_TOGGLE_FIT_AND_100,
        context,
    );
    assert_eq!(toggled.pixel_scale, 1.0);
    assert_eq!(maple_canvas_zoom_double_tap(fit, tap, 99, context), fit);
}

#[test]
fn stop_codes_round_trip_and_unknown_codes_are_dropped() {
    let badge = maple_canvas_zoom_badge_stops(landscape());
    assert_eq!(
        badge,
        stops(&[
            MAPLE_CANVAS_ZOOM_STOP_FIT,
            MAPLE_CANVAS_ZOOM_STOP_FILL,
            MAPLE_CANVAS_ZOOM_STOP_ACTUAL_SIZE
        ])
    );
    assert_eq!(
        maple_canvas_zoom_next_stop(MAPLE_CANVAS_ZOOM_STOP_FILL, badge),
        MAPLE_CANVAS_ZOOM_STOP_ACTUAL_SIZE
    );
    assert_eq!(
        maple_canvas_zoom_next_stop(MAPLE_CANVAS_ZOOM_STOP_NONE, badge),
        MAPLE_CANVAS_ZOOM_STOP_FIT
    );
    let garbage = MapleCanvasZoomStops {
        len: 99,
        stops: [7, MAPLE_CANVAS_ZOOM_STOP_FILL, 0],
    };
    assert_eq!(
        maple_canvas_zoom_next_stop(MAPLE_CANVAS_ZOOM_STOP_FILL, garbage),
        MAPLE_CANVAS_ZOOM_STOP_FILL,
        "only the valid fill code survives, so fill wraps to itself"
    );
    assert_eq!(
        maple_canvas_zoom_distinct_stops(1.0, 1.4, 0, 1.0),
        stops(&[MAPLE_CANVAS_ZOOM_STOP_FIT, MAPLE_CANVAS_ZOOM_STOP_FILL])
    );
    assert_eq!(
        maple_canvas_zoom_distinct_stops(0.25, 0.4, 1, 1.0),
        stops(&[
            MAPLE_CANVAS_ZOOM_STOP_FIT,
            MAPLE_CANVAS_ZOOM_STOP_FILL,
            MAPLE_CANVAS_ZOOM_STOP_ACTUAL_SIZE
        ])
    );
    assert_eq!(
        maple_canvas_zoom_detent(0.25, 0.25, 1.0),
        MAPLE_CANVAS_ZOOM_STOP_FIT
    );
    assert_eq!(
        maple_canvas_zoom_current_stop(MapleCanvasZoomState::default()),
        MAPLE_CANVAS_ZOOM_STOP_FIT
    );
}

#[test]
fn zoom_out_target_flags_the_snap() {
    assert!(maple_canvas_zoom_out_target(0.3, 0.25).snap_to_fit);
    let step = maple_canvas_zoom_out_target(1.0, 0.25);
    assert!(!step.snap_to_fit);
    assert_eq!(step.scale, 0.8);
}

#[test]
fn constants_and_context_come_from_the_core() {
    let constants = maple_canvas_constants();
    assert_eq!(constants.max_pixel_scale, canvas::MAX_PIXEL_SCALE);
    assert_eq!(constants.max_texture_edge, canvas::MAX_TEXTURE_EDGE);
    let sanitized = maple_canvas_zoom_context_sanitize(MapleCanvasZoomContext {
        display_scale: 0.0,
        ..landscape()
    });
    assert_eq!(sanitized.display_scale, 0.001);
    assert_eq!(maple_canvas_zoom_fit_scale(landscape()), 0.25);
    assert_eq!(
        maple_canvas_zoom_viewport_px(landscape()),
        MapleCanvasSize {
            width: 2000.0,
            height: 1600.0
        }
    );
}
