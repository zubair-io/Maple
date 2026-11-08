use std::sync::{Mutex, MutexGuard};

use super::*;

/// The scratch block is one static; tests run on parallel threads.
static SCRATCH_LOCK: Mutex<()> = Mutex::new(());

fn exclusive_scratch() -> MutexGuard<'static, ()> {
    let guard = SCRATCH_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    write_model(CanvasZoomModel::default());
    guard
}

/// 1000×726 points at 2× over a 4000×2500 image: fit 0.5, fill 0.5808.
fn set_landscape_context() {
    write(CanvasSlot::ViewportWidth, 1000.0);
    write(CanvasSlot::ViewportHeight, 726.0);
    write(CanvasSlot::NativeWidth, 4000.0);
    write(CanvasSlot::NativeHeight, 2500.0);
    write(CanvasSlot::DisplayScale, 2.0);
}

#[test]
fn slots_cover_the_block_in_order() {
    assert_eq!(
        CanvasSlot::DisplayScale as usize + 1,
        CanvasSlot::PixelScale as usize
    );
    assert_eq!(CanvasSlot::FillsViewport as usize + 1, SLOT_COUNT);
    assert_eq!(
        canvas_scratch_ptr() % 8,
        0,
        "Float64Array views need 8-byte alignment"
    );
}

#[test]
fn model_round_trips_through_the_scratch_block() {
    let _guard = exclusive_scratch();
    let model = CanvasZoomModel {
        pixel_scale: 1.5,
        pan_offset: Size::new(-12.0, 7.5),
        base_pan: Size::new(3.0, -4.0),
        drag_translation_base: Some(Size::new(9.0, 10.0)),
        pinch_start_scale: Some(0.75),
        pinch_start_pan: Size::new(1.0, 2.0),
        pinch_start_centroid: Point::new(100.0, 200.0),
        pinch_last_centroid: Point::new(110.0, 190.0),
        pinch_start_magnification: 1.25,
        pinch_last_magnification: 1.75,
        drag_last_translation: Some(Size::new(-6.0, 8.0)),
        fills_viewport: true,
    };
    write_model(model);
    assert_eq!(read_model(), model);
    write_model(CanvasZoomModel::default());
    assert_eq!(read_model(), CanvasZoomModel::default());
}

#[test]
fn transitions_resolve_against_the_written_context() {
    let _guard = exclusive_scratch();
    set_landscape_context();
    assert_eq!(canvas_zoom_effective_scale(), 0.5);
    assert_eq!(stop_code(read_model().current_stop()), CanvasZoomStop::Fit);
    assert_eq!(canvas_zoom_wheel_intent(false), CanvasWheelIntent::Editing);
    assert_eq!(canvas_zoom_wheel_intent(true), CanvasWheelIntent::Zoom);
    assert_eq!(canvas_zoom_next_badge_stop(), CanvasZoomStop::Fill);

    canvas_zoom_double_tap(500.0, 363.0, CanvasDoubleTap::ToggleFitAnd100);
    assert_eq!(read(CanvasSlot::PixelScale), 1.0);
    assert_eq!(
        stop_code(read_model().current_stop()),
        CanvasZoomStop::ActualSize
    );
    assert_eq!(canvas_zoom_wheel_intent(false), CanvasWheelIntent::Pan);
    assert_eq!(canvas_zoom_next_badge_stop(), CanvasZoomStop::Fit);

    canvas_zoom_wheel_pan(10_000.0, 0.0);
    let limit = read_context().max_pan_offset(1.0).width;
    assert_eq!(read(CanvasSlot::PanX), limit);
    assert!(canvas_zoom_drag_changed(-5.0, 0.0));
    assert_eq!(read(CanvasSlot::PanX), limit - 5.0);
    assert!(canvas_zoom_drag_ended());
    assert_eq!(read(CanvasSlot::BasePanX), limit - 5.0);

    canvas_zoom_double_tap(0.0, 0.0, CanvasDoubleTap::ToggleFitAnd100);
    assert_eq!(read_model(), CanvasZoomModel::default());
}

#[test]
fn pinch_matches_the_core_model() {
    let _guard = exclusive_scratch();
    set_landscape_context();
    let context = read_context();
    let expected = CanvasZoomModel::default()
        .pinch_changed(1.0, Point::new(400.0, 300.0), &context)
        .pinch_changed(2.0, Point::new(420.0, 310.0), &context)
        .pinch_ended(2.0, &context);

    canvas_zoom_pinch_changed(1.0, 400.0, 300.0);
    canvas_zoom_pinch_changed(2.0, 420.0, 310.0);
    canvas_zoom_pinch_ended(2.0);
    assert_eq!(read_model(), expected);
    assert_eq!(read(CanvasSlot::PixelScale), 1.0);
}

#[test]
fn a_pinch_continues_from_a_mid_pinch_zoom_across_calls() {
    let _guard = exclusive_scratch();
    set_landscape_context();
    let context = read_context();
    let expected = CanvasZoomModel::default()
        .pinch_changed(1.0, Point::new(400.0, 300.0), &context)
        .pinch_changed(1.6, Point::new(420.0, 310.0), &context)
        .wheel_zoom(40.0, Point::new(500.0, 363.0), &context)
        .pinch_changed(1.8, Point::new(430.0, 320.0), &context);

    canvas_zoom_pinch_changed(1.0, 400.0, 300.0);
    canvas_zoom_pinch_changed(1.6, 420.0, 310.0);
    canvas_zoom_wheel_zoom(40.0, 500.0, 363.0);
    assert_eq!(read(CanvasSlot::PinchStartMagnification), 1.6);
    canvas_zoom_pinch_changed(1.8, 430.0, 320.0);
    assert_eq!(read_model(), expected);
}

#[test]
fn a_drag_continues_from_a_mid_drag_wheel_pan_across_calls() {
    let _guard = exclusive_scratch();
    set_landscape_context();
    canvas_zoom_to_scale(1.0);
    let context = read_context();
    let expected = read_model()
        .drag_changed(Size::new(-20.0, 0.0), &context)
        .0
        .wheel_pan(Size::new(-30.0, 0.0), &context)
        .drag_changed(Size::new(-25.0, 0.0), &context)
        .0;

    assert!(canvas_zoom_drag_changed(-20.0, 0.0));
    canvas_zoom_wheel_pan(-30.0, 0.0);
    assert!(canvas_zoom_drag_changed(-25.0, 0.0));
    assert_eq!(read_model(), expected);
    assert_eq!(read(CanvasSlot::PanX), -55.0);
}

#[test]
fn steps_and_stops_match_the_core_model() {
    let _guard = exclusive_scratch();
    set_landscape_context();
    let context = read_context();

    canvas_zoom_step_out();
    assert_eq!(
        read_model(),
        CanvasZoomModel::default().step_zoom_out(&context)
    );
    canvas_zoom_step_in();
    assert_eq!(stop_code(read_model().current_stop()), CanvasZoomStop::Fit);

    canvas_zoom_advance_stop();
    assert_eq!(stop_code(read_model().current_stop()), CanvasZoomStop::Fill);
    assert_eq!(read(CanvasSlot::PixelScale), context.fill_scale());

    write(CanvasSlot::ViewportWidth, 726.0);
    write(CanvasSlot::ViewportHeight, 1000.0);
    canvas_zoom_reclamp_pan();
    assert_eq!(read(CanvasSlot::PixelScale), read_context().fill_scale());

    canvas_zoom_to_scale(0.0);
    assert_eq!(
        read(CanvasSlot::PixelScale),
        crate::canvas::MIN_EXPLICIT_ZOOM
    );
    canvas_zoom_wheel_zoom(-10_000.0, 0.0, 0.0);
    assert_eq!(
        canvas_zoom_effective_scale(),
        crate::canvas::MIN_EXPLICIT_ZOOM
    );
    canvas_zoom_reset_to_fit();
    canvas_zoom_wheel_zoom(-10_000.0, 0.0, 0.0);
    assert_eq!(canvas_zoom_effective_scale(), read_context().min_scale());
    canvas_zoom_reset_to_fit();
    assert_eq!(read_model(), CanvasZoomModel::default());
}
