use super::*;
use crate::canvas_math::MapleCanvasSize;
use crate::canvas_zoom::{
    maple_canvas_zoom_drag_changed, maple_canvas_zoom_pinch_changed,
    maple_canvas_zoom_reset_to_fit, maple_canvas_zoom_to_scale, maple_canvas_zoom_wheel_pan,
    MapleCanvasInsets,
};

fn context(display_scale: f64) -> MapleCanvasZoomContext {
    MapleCanvasZoomContext {
        viewport_points: MapleCanvasSize {
            width: 1000.0,
            height: 800.0,
        },
        native_image_size: MapleCanvasSize {
            width: 6000.0,
            height: 4000.0,
        },
        display_scale,
        insets: MapleCanvasInsets::default(),
    }
}

fn size(width: f64) -> MapleCanvasSize {
    MapleCanvasSize { width, height: 0.0 }
}

const AT: MapleCanvasPoint = MapleCanvasPoint { x: 500.0, y: 400.0 };

#[test]
fn a_density_change_rescales_the_pan() {
    let one = context(1.0);
    let zoomed = maple_canvas_zoom_to_scale(MapleCanvasZoomState::default(), 1.0, one);
    let panned = maple_canvas_zoom_wheel_pan(zoomed, size(1000.0), one);
    let moved = maple_canvas_zoom_geometry_changed(panned, one, context(2.0));
    assert_eq!(moved.pan_offset.width, 500.0);
}

#[test]
fn a_resolved_extent_keeps_the_displayed_size() {
    let provisional = MapleCanvasZoomContext {
        native_image_size: MapleCanvasSize {
            width: 1500.0,
            height: 1000.0,
        },
        ..context(1.0)
    };
    let zoomed = maple_canvas_zoom_to_scale(MapleCanvasZoomState::default(), 1.0, provisional);
    let resolved = maple_canvas_zoom_image_extent_resolved(zoomed, provisional, context(1.0));
    assert!((resolved.pixel_scale - 0.25).abs() < 1e-12);
}

#[test]
fn a_reset_mid_pinch_keeps_the_pinch_live_from_fit() {
    let ctx = context(1.0);
    let captured = maple_canvas_zoom_pinch_changed(MapleCanvasZoomState::default(), 1.0, AT, ctx);
    let live = maple_canvas_zoom_pinch_changed(captured, 2.0, AT, ctx);
    let reset = maple_canvas_zoom_reset_to_fit(live, ctx);
    assert_eq!(reset.has_pinch_start_scale, 1);
    assert_eq!(reset.pinch_start_magnification, 2.0);
    let next = maple_canvas_zoom_pinch_changed(reset, 2.0, AT, ctx);
    assert!((next.pixel_scale - 1000.0 / 6000.0).abs() < 1e-12);
}

#[test]
fn a_drag_after_a_lost_release_continues_from_the_screen() {
    let ctx = context(1.0);
    let zoomed = maple_canvas_zoom_to_scale(MapleCanvasZoomState::default(), 1.0, ctx);
    let lost = maple_canvas_zoom_drag_changed(zoomed, size(100.0), ctx).state;
    assert_eq!(lost.has_drag_last_translation, 1);
    let began = maple_canvas_zoom_drag_began(lost);
    assert_eq!(began.has_drag_last_translation, 0);
    let next = maple_canvas_zoom_drag_changed(began, size(1.0), ctx).state;
    assert_eq!(next.pan_offset.width, 101.0);
}

#[test]
fn tracking_then_cancelling_ends_the_pinch_at_its_last_input() {
    let ctx = context(1.0);
    let zoomed = maple_canvas_zoom_to_scale(MapleCanvasZoomState::default(), 1.0, ctx);
    let captured = maple_canvas_zoom_pinch_changed(zoomed, 1.0, AT, ctx);
    let tracked = maple_canvas_zoom_pinch_tracked(captured, 1.5, AT);
    assert_eq!(tracked.pixel_scale, 1.0);
    let drag_cancelled = maple_canvas_zoom_drag_cancelled(tracked);
    assert_eq!(drag_cancelled.has_pinch_start_scale, 1);
    let cancelled = maple_canvas_zoom_pinch_cancelled(drag_cancelled, ctx);
    assert_eq!(cancelled.has_pinch_start_scale, 0);
    assert!((cancelled.pixel_scale - 1.5).abs() < 1e-12);
}

/// The layout every host's FFI binding passes by value.
#[test]
fn the_state_layout_hosts_mirror() {
    assert_eq!(std::mem::size_of::<MapleCanvasZoomState>(), 176);
    assert_eq!(std::mem::align_of::<MapleCanvasZoomState>(), 8);
}
