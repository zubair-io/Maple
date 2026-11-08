use super::*;
use crate::canvas::{DoubleTapBehavior, Point, Size};

/// The audit's geometry (#5717): 1000×800pt at 1× over 4000×2000, fit 0.25.
fn audit() -> CanvasZoomContext {
    ctx((1000.0, 800.0), (4000.0, 2000.0), 1.0)
}

fn ctx(viewport: (f64, f64), image: (f64, f64), display_scale: f64) -> CanvasZoomContext {
    CanvasZoomContext::new(
        Size::new(viewport.0, viewport.1),
        Size::new(image.0, image.1),
        display_scale,
    )
}

fn assert_close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() <= 1e-9,
        "expected {expected}, got {actual}"
    );
}

fn scale_of(model: CanvasZoomModel, context: &CanvasZoomContext) -> f64 {
    context.effective_scale(model.pixel_scale)
}

fn drag(model: CanvasZoomModel, x: f64, context: &CanvasZoomContext) -> CanvasZoomModel {
    model.drag_changed(Size::new(x, 0.0), context).0
}

const AT: Point = Point { x: 500.0, y: 400.0 };

// #5736 — a viewport or image change mid-pinch.

#[test]
fn a_viewport_change_mid_pinch_does_not_move_the_photo_on_the_next_frame() {
    let before = audit();
    let narrow = ctx((700.0, 800.0), (4000.0, 2000.0), 1.0);
    let fingers = Point::new(300.0, 400.0);
    let pinching = CanvasZoomModel::default()
        .zoom_to_scale(0.5, &before)
        .pinch_changed(1.0, fingers, &before)
        .pinch_changed(2.0, fingers, &before);
    assert_close(pinching.pan_offset.width, 200.0);

    let resized = pinching.reclamp_pan(&narrow);
    assert_close(resized.pan_offset.width, 200.0);
    let next = resized.pinch_changed(2.0, fingers, &narrow);
    assert_close(next.pan_offset.width, 200.0);
    assert_close(scale_of(next, &narrow), 1.0);

    let carried = pinching.geometry_changed(&before, &narrow);
    let next = carried.pinch_changed(2.0, fingers, &narrow);
    assert_close(next.pan_offset.width, 200.0);
    assert_close(scale_of(next, &narrow), 1.0);
}

#[test]
fn the_pinch_continues_from_the_resized_frame() {
    let before = audit();
    let narrow = ctx((700.0, 800.0), (4000.0, 2000.0), 1.0);
    let fingers = Point::new(300.0, 400.0);
    let carried = CanvasZoomModel::default()
        .zoom_to_scale(0.5, &before)
        .pinch_changed(1.0, fingers, &before)
        .pinch_changed(2.0, fingers, &before)
        .geometry_changed(&before, &narrow);
    let spread = carried.pinch_changed(2.2, fingers, &narrow);
    let reference = CanvasZoomModel {
        pixel_scale: 1.0,
        pan_offset: Size::new(200.0, 0.0),
        base_pan: Size::new(200.0, 0.0),
        ..CanvasZoomModel::default()
    }
    .pinch_changed(1.0, fingers, &narrow)
    .pinch_changed(1.1, fingers, &narrow);
    assert_close(scale_of(spread, &narrow), scale_of(reference, &narrow));
    assert_close(spread.pan_offset.width, reference.pan_offset.width);
}

#[test]
fn a_resolved_extent_mid_pinch_keeps_the_photo_size_on_screen() {
    let preview = ctx((1000.0, 800.0), (2000.0, 1000.0), 1.0);
    let native = ctx((1000.0, 800.0), (4000.0, 2000.0), 1.0);
    let pinching = CanvasZoomModel::default()
        .zoom_to_scale(0.75, &preview)
        .pinch_changed(1.0, AT, &preview)
        .pinch_changed(1.5, Point::new(450.0, 400.0), &preview);
    let shown_width = preview
        .display_frame_in_points(pinching.pixel_scale)
        .unwrap()
        .width;

    let carried = pinching.image_extent_resolved(&preview, &native);
    let next = carried.pinch_changed(1.5, Point::new(450.0, 400.0), &native);
    let next_width = native
        .display_frame_in_points(next.pixel_scale)
        .unwrap()
        .width;
    assert_close(next_width, shown_width);
    assert_close(next.pan_offset.width, pinching.pan_offset.width);
}

#[test]
fn ios_tracked_input_carries_the_live_frame_not_the_frozen_one() {
    let before = audit();
    let narrow = ctx((700.0, 800.0), (4000.0, 2000.0), 1.0);
    let fingers = Point::new(300.0, 400.0);
    let frozen = CanvasZoomModel::default()
        .zoom_to_scale(0.5, &before)
        .pinch_changed(1.0, fingers, &before)
        .pinch_tracked(2.0, fingers);
    assert_close(frozen.pixel_scale, 0.5);
    let (shown_scale, shown_pan) = frozen.shown_frame(&before);
    assert_close(shown_scale, 1.0);
    assert_close(shown_pan.width, 200.0);

    let carried = frozen.geometry_changed(&before, &narrow);
    assert_close(carried.pixel_scale, 0.5);
    let (scale, pan) = carried.shown_frame(&narrow);
    assert_close(scale, 1.0);
    assert_close(pan.width, 200.0);
}

// #5737 — a zoom command during a pinch.

#[test]
fn a_reset_during_a_pinch_is_not_undone_by_the_next_frame() {
    let context = audit();
    let next = CanvasZoomModel::default()
        .pinch_changed(1.0, AT, &context)
        .pinch_changed(2.0, AT, &context)
        .reset_to_fit(&context)
        .pinch_changed(2.01, AT, &context);
    assert_close(scale_of(next, &context), 0.25 * 2.01 / 2.0);
}

#[test]
fn a_double_tap_during_a_pinch_continues_from_100_percent() {
    let context = audit();
    let next = CanvasZoomModel::default()
        .pinch_changed(1.0, AT, &context)
        .double_tap(AT, DoubleTapBehavior::ToggleFitAnd100, &context)
        .pinch_changed(1.05, AT, &context);
    assert_close(scale_of(next, &context), 1.05);
}

#[test]
fn a_capture_frame_away_from_one_does_not_move_the_photo() {
    let context = audit();
    let zoomed = CanvasZoomModel::default().zoom_to_scale(1.0, &context);
    let captured = zoomed.pinch_changed(2.01, AT, &context);
    assert_close(scale_of(captured, &context), 1.0);
    assert_eq!(captured.pan_offset, zoomed.pan_offset);
    let next = captured.pinch_changed(2.01 * 1.1, AT, &context);
    assert_close(scale_of(next, &context), 1.1);
}

#[test]
fn a_command_below_the_pinch_floor_holds_the_next_frame_at_the_floor() {
    let context = audit();
    let pinching = CanvasZoomModel::default()
        .pinch_changed(1.0, AT, &context)
        .zoom_to_scale(0.05, &context);
    let first = pinching.pinch_changed(1.0, AT, &context);
    let again = first.pinch_changed(1.0, AT, &context);
    assert_close(scale_of(first, &context), context.min_scale());
    assert_eq!(first, again);
}

// #5738 — wheel or keyboard during a drag.

#[test]
fn a_wheel_pan_during_a_drag_does_not_double_the_drag() {
    let context = audit();
    let dragging = drag(
        CanvasZoomModel::default().zoom_to_fill(&context),
        -100.0,
        &context,
    );
    assert_close(dragging.pan_offset.width, -100.0);
    let wheeled = dragging.wheel_pan(Size::new(-48.0, 0.0), &context);
    assert_close(wheeled.pan_offset.width, -148.0);
    assert_close(drag(wheeled, -101.0, &context).pan_offset.width, -149.0);
}

#[test]
fn a_zoom_step_during_a_drag_does_not_double_the_drag() {
    let context = audit();
    let dragging = drag(
        CanvasZoomModel::default().zoom_to_scale(1.0, &context),
        -100.0,
        &context,
    );
    let stepped = dragging.step_zoom_in(&context);
    assert_close(stepped.pan_offset.width, -125.0);
    assert_close(drag(stepped, -101.0, &context).pan_offset.width, -126.0);
}

#[test]
fn zooming_in_under_a_drag_that_started_at_fit_pans_only_by_new_motion() {
    let context = audit();
    let at_fit = drag(CanvasZoomModel::default(), -100.0, &context);
    assert_eq!(at_fit.pan_offset, Size::ZERO);
    let zoomed = at_fit.zoom_to_scale(1.0, &context);
    assert_close(drag(zoomed, -110.0, &context).pan_offset.width, -10.0);
}

// #5739 — a drag whose end never arrived.

#[test]
fn a_new_drag_after_a_lost_end_continues_from_the_screen() {
    let context = audit();
    let lost = drag(
        CanvasZoomModel::default().zoom_to_scale(1.0, &context),
        100.0,
        &context,
    );
    assert_close(lost.pan_offset.width, 100.0);
    let next = drag(lost.drag_began(), 1.0, &context);
    assert_close(next.pan_offset.width, 101.0);
}

#[test]
fn a_new_drag_after_a_post_pinch_baseline_starts_clean() {
    let context = audit();
    let rebased = CanvasZoomModel::default()
        .zoom_to_scale(1.0, &context)
        .rebase_drag_baseline(Size::new(40.0, 0.0));
    let next = drag(rebased.drag_began(), 5.0, &context);
    assert_close(next.pan_offset.width, 5.0);
}

#[test]
fn a_cancelled_pinch_ends_at_its_last_frame() {
    let context = audit();
    let pinching = CanvasZoomModel::default()
        .zoom_to_scale(1.0, &context)
        .pinch_changed(1.0, AT, &context)
        .pinch_changed(1.5, AT, &context);
    let cancelled = pinching.pinch_cancelled(&context);
    assert_eq!(cancelled.pinch_start_scale, None);
    assert_close(scale_of(cancelled, &context), 1.5);
    let next = cancelled.pinch_changed(1.3, AT, &context);
    assert_close(scale_of(next, &context), 1.5);
}

#[test]
fn a_cancelled_drag_leaves_a_live_pinch_live() {
    let context = audit();
    let fingers = Point::new(600.0, 400.0);
    let pinching = CanvasZoomModel::default()
        .zoom_to_scale(1.0, &context)
        .pinch_changed(1.0, fingers, &context)
        .pinch_changed(1.5, fingers, &context);
    let dragging = drag(pinching, 30.0, &context);
    let cancelled = dragging.drag_cancelled();
    assert_eq!(cancelled.pinch_start_scale, pinching.pinch_start_scale);
    assert_eq!(
        cancelled.pinch_changed(1.5, fingers, &context),
        dragging
            .pinch_changed(1.5, fingers, &context)
            .drag_cancelled()
    );
    assert_close(
        cancelled
            .pinch_changed(1.5, fingers, &context)
            .pan_offset
            .width,
        pinching.pan_offset.width,
    );
}

#[test]
fn a_drag_outliving_a_cancelled_pinch_moves_by_new_motion_only() {
    let context = audit();
    let dragging = drag(
        CanvasZoomModel::default()
            .zoom_to_scale(1.0, &context)
            .pinch_changed(1.0, AT, &context)
            .pinch_changed(1.5, AT, &context),
        40.0,
        &context,
    );
    let cancelled = dragging.pinch_cancelled(&context);
    let next = drag(cancelled, 41.0, &context);
    assert_close(next.pan_offset.width, cancelled.pan_offset.width + 1.0);
}

#[test]
fn a_capture_that_cannot_be_made_changes_nothing() {
    let broken = CanvasZoomModel {
        pan_offset: Size::new(f64::NAN, 0.0),
        ..CanvasZoomModel::default().zoom_to_scale(1.0, &audit())
    };
    let captured = broken.pinch_changed(1.0, AT, &audit());
    assert_eq!(captured.pinch_start_scale, None);
    assert_eq!(captured.pixel_scale, broken.pixel_scale);
}

// #5740 — a display-density change while zoomed.

#[test]
fn a_density_change_keeps_the_centred_image_point() {
    let one = ctx((1000.0, 800.0), (6000.0, 4000.0), 1.0);
    let two = ctx((1000.0, 800.0), (6000.0, 4000.0), 2.0);
    let panned = CanvasZoomModel::default()
        .zoom_to_scale(1.0, &one)
        .wheel_pan(Size::new(1000.0, 0.0), &one);
    assert_close(panned.pan_offset.width, 1000.0);
    let moved = panned.geometry_changed(&one, &two);
    assert_close(moved.pixel_scale, 1.0);
    assert_close(moved.pan_offset.width, 500.0);
    assert_close(moved.base_pan.width, 500.0);
}

#[test]
fn a_density_change_mid_pinch_continues_from_the_carried_frame() {
    let one = ctx((1000.0, 800.0), (6000.0, 4000.0), 1.0);
    let two = ctx((1000.0, 800.0), (6000.0, 4000.0), 2.0);
    let fingers = Point::new(700.0, 400.0);
    let pinching = CanvasZoomModel::default()
        .zoom_to_scale(1.0, &one)
        .pinch_changed(1.0, fingers, &one)
        .pinch_changed(1.2, fingers, &one);
    let carried = pinching.geometry_changed(&one, &two);
    let next = carried.pinch_changed(1.2, fingers, &two);
    assert_close(scale_of(next, &two), 1.2);
    assert_close(next.pan_offset.width, pinching.pan_offset.width / 2.0);
}

// The resting rules geometry_changed keeps.

#[test]
fn a_resize_while_zoomed_keeps_the_pan() {
    let before = audit();
    let narrow = ctx((700.0, 800.0), (4000.0, 2000.0), 1.0);
    let panned = CanvasZoomModel::default()
        .zoom_to_scale(1.0, &before)
        .wheel_pan(Size::new(300.0, 0.0), &before);
    assert_eq!(
        panned.geometry_changed(&before, &narrow),
        panned.reclamp_pan(&narrow)
    );
}

#[test]
fn an_unknown_previous_extent_opens_at_fit() {
    let unknown = ctx((1000.0, 800.0), (0.0, 0.0), 1.0);
    let native = audit();
    let model = CanvasZoomModel::default().zoom_to_scale(0.5, &unknown);
    assert_eq!(
        model.geometry_changed(&unknown, &native),
        CanvasZoomModel::default().reset_to_fit(&native)
    );
}

#[test]
fn fit_re_fits_across_any_geometry_change() {
    let before = audit();
    let after = ctx((700.0, 900.0), (4000.0, 2000.0), 2.0);
    let fit = CanvasZoomModel::default().geometry_changed(&before, &after);
    assert_eq!(fit, CanvasZoomModel::default().reset_to_fit(&after));
}

#[test]
fn tracking_outside_a_pinch_or_with_bad_input_changes_nothing() {
    let model = CanvasZoomModel::default();
    assert_eq!(model.pinch_tracked(2.0, AT), model);
    let pinching = model.pinch_changed(1.0, AT, &audit());
    assert_eq!(pinching.pinch_tracked(f64::NAN, AT), pinching);
    assert_eq!(pinching.pinch_tracked(0.0, AT), pinching);
    assert_eq!(
        pinching.pinch_tracked(2.0, Point::new(f64::INFINITY, 0.0)),
        pinching
    );
}

// The handoff never moves what the screen shows.

#[test]
fn a_viewport_growing_mid_pinch_keeps_the_shown_pan_even_outside_the_new_range() {
    let before = audit();
    let wide = ctx((3800.0, 800.0), (4000.0, 2000.0), 1.0);
    let fingers = Point::new(200.0, 400.0);
    let pinching = CanvasZoomModel::default()
        .zoom_to_scale(1.0, &before)
        .pinch_changed(1.0, fingers, &before)
        .pinch_changed(1.0, Point::new(1200.0, 400.0), &before);
    let shown = pinching.pan_offset.width;
    assert!(shown.abs() > wide.pinch_clamped_pan(pinching.pan_offset, 1.0).width.abs());

    let carried = pinching.geometry_changed(&before, &wide);
    assert_close(carried.pan_offset.width, shown);
    let next = carried.pinch_changed(1.0, Point::new(1200.0, 400.0), &wide);
    assert_close(next.pan_offset.width, shown);
    let back = carried.pinch_changed(1.0, Point::new(1100.0, 400.0), &wide);
    assert_close(back.pan_offset.width, shown - 100.0);
}

#[test]
fn a_pinch_after_holding_an_out_of_range_frame_starts_from_it() {
    let context = audit();
    let held = CanvasZoomModel::default()
        .zoom_to_scale(1.0, &context)
        .hold_shown(1.0, Size::new(1700.0, 0.0), &context);
    assert_close(held.pan_offset.width, 1700.0);
    let captured = held.pinch_changed(1.3, AT, &context);
    let next = captured.pinch_changed(1.3, AT, &context);
    assert_close(next.pan_offset.width, 1700.0);
    assert_close(scale_of(next, &context), 1.0);
}

#[test]
fn a_drag_after_a_command_moves_by_new_motion_only() {
    let context = audit();
    let dragging = drag(
        CanvasZoomModel::default().zoom_to_scale(1.0, &context),
        -100.0,
        &context,
    );
    let reset = dragging.reset_to_fit(&context);
    assert_eq!(reset.pan_offset, Size::ZERO);
    let zoomed = reset.zoom_to_scale(1.0, &context);
    assert_close(drag(zoomed, -130.0, &context).pan_offset.width, -30.0);
}

#[test]
fn a_viewport_growth_past_a_below_fit_pinch_draws_the_frame_the_next_one_shows() {
    let before = audit();
    let grown = ctx((2000.0, 1600.0), (4000.0, 2000.0), 1.0);
    let pinching = CanvasZoomModel::default()
        .reset_to_fit(&before)
        .pinch_changed(1.0, AT, &before)
        .pinch_changed(0.55, AT, &before);
    let carried = pinching.geometry_changed(&before, &grown);
    let next = carried.pinch_changed(0.55, AT, &grown);
    assert_close(carried.pixel_scale, next.pixel_scale);
    assert_close(carried.pan_offset.width, next.pan_offset.width);
    assert_close(carried.pan_offset.height, next.pan_offset.height);
}
