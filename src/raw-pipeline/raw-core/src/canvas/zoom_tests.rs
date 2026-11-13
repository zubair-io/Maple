use super::*;
use crate::canvas::{pinch_scale, DragIntent, Point, Size, WheelIntent};

fn context(viewport: (f64, f64), native: (f64, f64)) -> CanvasZoomContext {
    CanvasZoomContext::new(
        Size::new(viewport.0, viewport.1),
        Size::new(native.0, native.1),
        2.0,
    )
}

/// 1000×800pt @2× over 8000×6000: fit 0.25, fill 0.2667 (overlapping bands).
fn landscape() -> CanvasZoomContext {
    context((1000.0, 800.0), (8000.0, 6000.0))
}

/// 1000×800pt @2× over 6000×6000: fit 0.2667, fill 0.3333 (separate bands);
/// the fill frame overflows vertically only.
fn square() -> CanvasZoomContext {
    context((1000.0, 800.0), (6000.0, 6000.0))
}

const FIT: f64 = 1600.0 / 6000.0;
const FILL: f64 = 2000.0 / 6000.0;

fn fit_model() -> CanvasZoomModel {
    CanvasZoomModel::default()
}

fn assert_close(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() <= tolerance,
        "expected {expected}, got {actual}"
    );
}

fn drag(model: CanvasZoomModel, x: f64, y: f64, ctx: &CanvasZoomContext) -> CanvasZoomModel {
    model.drag_changed(Size::new(x, y), ctx).0
}

fn pinch(model: CanvasZoomModel, magnification: f64, ctx: &CanvasZoomContext) -> CanvasZoomModel {
    model
        .pinch_changed(1.0, Point::new(500.0, 400.0), ctx)
        .pinch_changed(magnification, Point::new(500.0, 400.0), ctx)
        .pinch_ended(magnification, ctx)
}

#[test]
fn context_fit_and_effective_scale() {
    let ctx = landscape();
    assert_close(ctx.fit_scale(), 0.25, 1e-9);
    assert_close(ctx.effective_scale(0.0), 0.25, 1e-9);
    assert_close(ctx.effective_scale(1.0), 1.0, 1e-9);
    assert_eq!(ctx.viewport_px(), Size::new(2000.0, 1600.0));
}

#[test]
fn context_display_frame_and_max_pan() {
    let ctx = landscape();
    assert_eq!(
        ctx.display_frame_in_points(0.0),
        Some(Size::new(1000.0, 750.0))
    );
    assert_eq!(
        ctx.display_frame_in_points(1.0),
        Some(Size::new(4000.0, 3000.0))
    );
    assert_eq!(ctx.max_pan_offset(0.0), Size::ZERO);
    assert_eq!(ctx.max_pan_offset(1.0), Size::new(1500.0, 1100.0));
}

#[test]
fn context_clamps_pan_symmetrically() {
    let ctx = landscape();
    assert_eq!(
        ctx.clamped_pan(Size::new(9000.0, -9000.0), 1.0),
        Size::new(1500.0, -1100.0)
    );
    assert_eq!(
        ctx.clamped_pan(Size::new(100.0, 50.0), 1.0),
        Size::new(100.0, 50.0)
    );
    assert_eq!(
        ctx.clamped_pan(Size::new(f64::NAN, f64::INFINITY), 1.0),
        Size::new(0.0, 1100.0)
    );
}

#[test]
fn context_fill_scale_covers_the_viewport_and_is_capped() {
    let ctx = square();
    assert_close(ctx.fill_scale(), FILL, 1e-9);
    assert_close(landscape().fill_scale(), 1600.0 / 6000.0, 1e-9);
    let frame = ctx
        .display_frame_in_points(ctx.fill_scale())
        .expect("sized");
    assert!(frame.width >= 1000.0 - 1e-9 && frame.height >= 800.0 - 1e-9);
    let sliver = context((1000.0, 800.0), (20000.0, 100.0));
    assert_eq!(sliver.fill_scale(), MAX_PIXEL_SCALE);
    assert_close(ctx.min_scale(), FIT * 0.5, 1e-9);
}

#[test]
fn context_sanitizes_bad_geometry() {
    let ctx = CanvasZoomContext::new(Size::new(f64::NAN, 800.0), Size::new(-1.0, 10.0), 0.0);
    assert_eq!(ctx.viewport_points(), Size::ZERO);
    assert_eq!(ctx.native_image_size(), Size::ZERO);
    assert_eq!(ctx.display_scale(), 0.001);
    assert_eq!(ctx.fit_scale(), 1.0);
    let unscaled = CanvasZoomContext::new(Size::ZERO, Size::ZERO, f64::INFINITY);
    assert_eq!(unscaled.display_scale(), 1.0);
}

#[test]
fn drag_intent_is_editing_at_fit_and_pan_when_zoomed() {
    let ctx = landscape();
    let model = fit_model();
    assert!(!model.is_zoomed_in());
    assert_eq!(model.drag_intent(&ctx), DragIntent::Editing);
    let zoomed = model.zoom_to_scale(1.0, &CanvasZoomContext::default());
    assert!(zoomed.is_zoomed_in());
    assert_eq!(zoomed.drag_intent(&ctx), DragIntent::Pan);
    assert_eq!(
        zoomed
            .reset_to_fit(&CanvasZoomContext::default())
            .drag_intent(&ctx),
        DragIntent::Editing
    );
}

#[test]
fn wheel_intent_matrix() {
    let ctx = landscape();
    let model = fit_model();
    assert_eq!(model.wheel_intent(true, &ctx), WheelIntent::Zoom);
    assert_eq!(model.wheel_intent(false, &ctx), WheelIntent::Editing);
    let zoomed = model.zoom_to_scale(2.0, &CanvasZoomContext::default());
    assert_eq!(zoomed.wheel_intent(true, &ctx), WheelIntent::Zoom);
    assert_eq!(zoomed.wheel_intent(false, &ctx), WheelIntent::Pan);
}

#[test]
fn drag_at_fit_is_not_consumed() {
    let ctx = landscape();
    let (model, consumed) = fit_model().drag_changed(Size::new(120.0, -40.0), &ctx);
    assert!(!consumed, "fit-mode drags belong to the editing surface");
    assert_eq!(model.pan_offset, Size::ZERO);
    assert!(!model.drag_ended().1);
}

#[test]
fn drag_when_zoomed_pans_and_commits_on_end() {
    let ctx = landscape();
    let (panned, consumed) = fit_model()
        .zoom_to_scale(1.0, &CanvasZoomContext::default())
        .drag_changed(Size::new(100.0, 50.0), &ctx);
    assert!(consumed);
    assert_eq!(panned.pan_offset, Size::new(100.0, 50.0));
    let (committed, did_commit) = panned.drag_ended();
    assert!(did_commit);
    assert_eq!(
        drag(committed, 10.0, 5.0, &ctx).pan_offset,
        Size::new(110.0, 55.0)
    );
}

#[test]
fn drag_pan_is_clamped_to_viewport_attachment() {
    let ctx = landscape();
    let model = drag(
        fit_model().zoom_to_scale(1.0, &CanvasZoomContext::default()),
        99999.0,
        99999.0,
        &ctx,
    );
    assert_eq!(model.pan_offset, Size::new(1500.0, 1100.0));
}

#[test]
fn drag_ignores_non_finite_translation() {
    let ctx = landscape();
    let zoomed = fit_model().zoom_to_scale(1.0, &CanvasZoomContext::default());
    let (model, consumed) = zoomed.drag_changed(Size::new(f64::NAN, 0.0), &ctx);
    assert!(!consumed);
    assert_eq!(model, zoomed);
}

#[test]
fn pinch_anchors_against_the_start_captured_scale() {
    let ctx = landscape();
    let centre = Point::new(500.0, 400.0);
    let first = fit_model()
        .pinch_changed(1.0, centre, &ctx)
        .pinch_changed(2.0, centre, &ctx);
    assert_close(first.pixel_scale, 0.5, 1e-9);
    let second = first.pinch_changed(3.0, centre, &ctx);
    assert_close(second.pixel_scale, 0.75, 1e-9);
}

#[test]
fn pinch_clamps_at_max_and_at_half_fit() {
    let ctx = landscape();
    let model = fit_model()
        .pinch_changed(1.0, Point::ZERO, &ctx)
        .pinch_changed(1000.0, Point::ZERO, &ctx);
    assert_close(model.pixel_scale, MAX_PIXEL_SCALE, 1e-9);
    let out = fit_model()
        .pinch_changed(1.0, Point::ZERO, &ctx)
        .pinch_changed(0.01, Point::ZERO, &ctx);
    assert_close(out.pixel_scale, ctx.fit_scale() * 0.5, 1e-9);
}

#[test]
fn pinch_end_within_tolerance_snaps_to_fit() {
    let ctx = landscape();
    let model = fit_model()
        .pinch_changed(1.0, Point::ZERO, &ctx)
        .pinch_changed(1.01, Point::ZERO, &ctx)
        .pinch_ended(1.01, &ctx);
    assert_eq!(model.pixel_scale, 0.0);
    assert_eq!(model.pan_offset, Size::ZERO);
    assert_eq!(model.pinch_start_scale, None);
}

#[test]
fn pinch_end_above_tolerance_keeps_the_scale() {
    let ctx = landscape();
    let model = fit_model()
        .pinch_changed(1.0, Point::ZERO, &ctx)
        .pinch_changed(2.0, Point::ZERO, &ctx)
        .pinch_ended(2.0, &ctx);
    assert_close(model.pixel_scale, 0.5, 1e-9);
    assert_eq!(model.pinch_start_scale, None);
}

#[test]
fn pinch_ignores_non_finite_frames() {
    let ctx = landscape();
    let live = fit_model()
        .pinch_changed(1.0, Point::ZERO, &ctx)
        .pinch_changed(2.0, Point::ZERO, &ctx);
    assert_eq!(live.pinch_changed(f64::NAN, Point::ZERO, &ctx), live);
    assert_eq!(
        live.pinch_changed(3.0, Point::new(f64::INFINITY, 0.0), &ctx),
        live
    );
    let released = live.pinch_ended(f64::NAN, &ctx);
    assert_close(released.pixel_scale, 0.5, 1e-9);
    assert_eq!(released.pinch_start_scale, None);
}

#[test]
fn double_tap_toggles_fit_and_100_in_the_editor() {
    let ctx = landscape();
    let zoomed = fit_model().double_tap(
        Point::new(250.0, 200.0),
        DoubleTapBehavior::ToggleFitAnd100,
        &ctx,
    );
    assert_close(zoomed.pixel_scale, 1.0, 1e-9);
    assert_close(zoomed.pan_offset.width, 750.0, 1e-9);
    assert_close(zoomed.pan_offset.height, 600.0, 1e-9);
    let back = zoomed.double_tap(
        Point::new(500.0, 400.0),
        DoubleTapBehavior::ToggleFitAnd100,
        &ctx,
    );
    assert_eq!(back.pixel_scale, 0.0);
    assert_eq!(back.pan_offset, Size::ZERO);
}

#[test]
fn double_tap_with_a_non_finite_location_anchors_at_the_centre() {
    let ctx = landscape();
    let model = fit_model().double_tap(
        Point::new(f64::NAN, 0.0),
        DoubleTapBehavior::ToggleFitAnd100,
        &ctx,
    );
    assert_eq!(model.pixel_scale, 1.0);
    assert_eq!(model.pan_offset, Size::ZERO);
}

#[test]
fn legacy_double_tap_always_resets_to_fit() {
    let ctx = landscape();
    let tap = Point::new(100.0, 100.0);
    let model = fit_model()
        .zoom_to_scale(4.0, &CanvasZoomContext::default())
        .double_tap(tap, DoubleTapBehavior::ResetToFit, &ctx);
    assert_eq!(model.pixel_scale, 0.0);
    let again = model.double_tap(tap, DoubleTapBehavior::ResetToFit, &ctx);
    assert_eq!(again.pixel_scale, 0.0);
}

#[test]
fn zoom_to_scale_clamps_and_clears_the_pan() {
    let ctx = landscape();
    let panned = drag(
        fit_model().zoom_to_scale(1.0, &CanvasZoomContext::default()),
        100.0,
        100.0,
        &ctx,
    );
    let capped = panned.zoom_to_scale(9.0, &CanvasZoomContext::default());
    assert_eq!(capped.pixel_scale, MAX_PIXEL_SCALE);
    assert_eq!(capped.pan_offset, Size::ZERO);
    assert_eq!(
        capped
            .zoom_to_scale(0.001, &CanvasZoomContext::default())
            .pixel_scale,
        MIN_EXPLICIT_ZOOM
    );
}

#[test]
fn step_zoom_in_from_fit_moves_off_fit() {
    let model = fit_model().step_zoom_in(&landscape());
    assert_close(model.pixel_scale, 0.25 * 1.25, 1e-9);
}

#[test]
fn step_zoom_out_snaps_to_fit_within_tolerance() {
    let model = fit_model()
        .zoom_to_scale(0.3, &CanvasZoomContext::default())
        .step_zoom_out(&landscape());
    assert_eq!(model.pixel_scale, 0.0);
    assert_eq!(model.pan_offset, Size::ZERO);
}

#[test]
fn step_zoom_out_above_tolerance_steps() {
    let model = fit_model()
        .zoom_to_scale(1.0, &CanvasZoomContext::default())
        .step_zoom_out(&landscape());
    assert_close(model.pixel_scale, 0.8, 1e-9);
}

#[test]
fn step_zoom_rescales_the_pan_about_the_centre() {
    let ctx = landscape();
    let panned = drag(
        fit_model().zoom_to_scale(1.0, &CanvasZoomContext::default()),
        100.0,
        -40.0,
        &ctx,
    )
    .drag_ended()
    .0;
    let stepped = panned.step_zoom_in(&ctx);
    assert_close(stepped.pan_offset.width, 125.0, 1e-9);
    assert_close(stepped.pan_offset.height, -50.0, 1e-9);
    assert_eq!(stepped.base_pan, stepped.pan_offset);
}

#[test]
fn wheel_zoom_in_from_fit_zooms_anchored() {
    let model = fit_model().wheel_zoom(100.0, Point::new(250.0, 200.0), &landscape());
    let expected = (0.25 * (100.0 * WHEEL_ZOOM_SENSITIVITY).exp2()).min(8.0);
    assert_close(model.pixel_scale, expected, 1e-9);
    assert!(model.is_zoomed_in());
}

#[test]
fn wheel_zoom_out_snaps_to_fit_at_the_threshold() {
    let model = fit_model()
        .zoom_to_scale(0.26, &CanvasZoomContext::default())
        .wheel_zoom(-1000.0, Point::new(500.0, 400.0), &landscape());
    assert_eq!(model.pixel_scale, 0.0);
    assert_eq!(model.pan_offset, Size::ZERO);
}

#[test]
fn wheel_pan_only_acts_when_zoomed() {
    let ctx = landscape();
    let at_fit = fit_model().wheel_pan(Size::new(40.0, 40.0), &ctx);
    assert_eq!(at_fit.pan_offset, Size::ZERO);
    let zoomed = fit_model()
        .zoom_to_scale(1.0, &CanvasZoomContext::default())
        .wheel_pan(Size::new(40.0, -20.0), &ctx);
    assert_eq!(zoomed.pan_offset, Size::new(40.0, -20.0));
}

#[test]
fn reclamp_pulls_the_pan_inside_new_geometry() {
    let ctx = landscape();
    let (model, _) = drag(
        fit_model().zoom_to_scale(1.0, &CanvasZoomContext::default()),
        1500.0,
        1100.0,
        &ctx,
    )
    .drag_ended();
    let bigger = context((3000.0, 2400.0), (8000.0, 6000.0));
    assert_eq!(
        model.reclamp_pan(&bigger).pan_offset,
        Size::new(500.0, 300.0)
    );
}

#[test]
fn transitions_are_safe_without_a_native_size() {
    let empty = context((1000.0, 800.0), (0.0, 0.0));
    let model = drag(
        fit_model()
            .pinch_changed(1.0, Point::ZERO, &empty)
            .pinch_changed(2.0, Point::ZERO, &empty)
            .pinch_ended(2.0, &empty),
        50.0,
        50.0,
        &empty,
    );
    assert_eq!(model.pan_offset, Size::ZERO);
    assert_eq!(empty.display_frame_in_points(model.pixel_scale), None);
}

#[test]
fn drag_ended_while_a_pinch_is_active_does_not_commit() {
    let model = fit_model()
        .pinch_changed(1.0, Point::new(500.0, 400.0), &landscape())
        .pinch_changed(2.0, Point::new(500.0, 400.0), &landscape());
    assert!(!model.drag_ended().1);
}

#[test]
fn drag_resuming_after_a_pinch_does_not_jump_by_the_pinch_travel() {
    let ctx = landscape();
    let pinching = fit_model()
        .pinch_changed(1.0, Point::new(500.0, 400.0), &ctx)
        .pinch_changed(2.0, Point::new(500.0, 400.0), &ctx);
    let (suppressed, consumed) = pinching.drag_changed(Size::new(100.0, 0.0), &ctx);
    assert!(
        !consumed,
        "drag must not pan while a pinch owns the gesture"
    );
    let after_pinch = suppressed.pinch_ended(2.0, &ctx);
    let resumed = drag(after_pinch, 110.0, 0.0, &ctx);
    assert_close(
        resumed.pan_offset.width - after_pinch.pan_offset.width,
        10.0,
        1e-6,
    );
    assert_close(
        resumed.pan_offset.height - after_pinch.pan_offset.height,
        0.0,
        1e-6,
    );
}

#[test]
fn rebase_drag_baseline_absorbs_the_translation() {
    let ctx = landscape();
    let rebased = fit_model()
        .zoom_to_scale(1.0, &CanvasZoomContext::default())
        .rebase_drag_baseline(Size::new(30.0, 0.0));
    assert_eq!(
        drag(rebased, 40.0, 0.0, &ctx).pan_offset,
        Size::new(10.0, 0.0)
    );
}

#[path = "zoom_stops_tests.rs"]
mod stops;
