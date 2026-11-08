//! The below-fit floor, the fill stop, the fit/fill pinch detents and the
//! badge's fit → fill → 100% cycle (#5710).

use super::*;

#[test]
fn pinch_below_fit_follows_the_fingers_and_springs_back_to_fit() {
    let ctx = square();
    let live = fit_model()
        .pinch_changed(1.0, Point::new(100.0, 100.0), &ctx)
        .pinch_changed(0.7, Point::new(100.0, 100.0), &ctx);
    assert_close(live.pixel_scale, FIT * 0.7, 1e-9);
    assert_ne!(
        live.pan_offset,
        Size::ZERO,
        "below fit the image stays under the fingers"
    );
    let model = live.pinch_ended(0.7, &ctx);
    assert_eq!(model, fit_model());
    assert_eq!(model.current_stop(), Some(ZoomStop::Fit));
}

#[test]
fn pinch_held_at_the_floor_releases_to_fit() {
    let ctx = square();
    let live = fit_model()
        .pinch_changed(1.0, Point::ZERO, &ctx)
        .pinch_changed(0.1, Point::ZERO, &ctx);
    assert_close(live.pixel_scale, ctx.min_scale(), 1e-9);
    assert_eq!(live.pinch_ended(0.1, &ctx).pixel_scale, 0.0);
}

#[test]
fn below_fit_inputs_belong_to_the_editing_surface() {
    let ctx = square();
    let model = fit_model()
        .pinch_changed(1.0, Point::ZERO, &ctx)
        .pinch_changed(0.6, Point::ZERO, &ctx)
        .pinch_ended(0.6, &ctx);
    assert_eq!(model.drag_intent(&ctx), DragIntent::Editing);
    assert_eq!(model.wheel_intent(false, &ctx), WheelIntent::Editing);
    assert_eq!(model.wheel_intent(true, &ctx), WheelIntent::Zoom);
    let (dragged, consumed) = model.drag_changed(Size::new(300.0, -200.0), &ctx);
    assert!(!consumed);
    assert_eq!(dragged.pan_offset, Size::ZERO);
    assert_eq!(
        model.wheel_pan(Size::new(50.0, 50.0), &ctx).pan_offset,
        Size::ZERO
    );
}

#[test]
fn double_tap_from_below_fit_returns_to_fit() {
    let ctx = square();
    let model = fit_model().step_zoom_out(&ctx).double_tap(
        Point::ZERO,
        DoubleTapBehavior::ToggleFitAnd100,
        &ctx,
    );
    assert_eq!(model.pixel_scale, 0.0);
}

#[test]
fn step_zoom_out_from_fit_goes_below_fit_to_the_floor() {
    let ctx = square();
    let once = fit_model().step_zoom_out(&ctx);
    assert_close(once.pixel_scale, FIT / 1.25, 1e-9);
    let floor = (0..10).fold(once, |model, _| model.step_zoom_out(&ctx));
    assert_close(floor.pixel_scale, ctx.min_scale(), 1e-9);
}

#[test]
fn step_zoom_in_from_below_fit_settles_on_fit() {
    let ctx = square();
    let settled = fit_model().step_zoom_out(&ctx).step_zoom_in(&ctx);
    assert_eq!(settled.pixel_scale, 0.0, "crossing fit lands in fit mode");
    assert_close(settled.step_zoom_in(&ctx).pixel_scale, FIT * 1.25, 1e-9);
}

#[test]
fn step_zoom_in_that_would_jump_past_fit_settles_on_fit() {
    let model = fit_model()
        .zoom_to_scale(FIT * 0.88, &CanvasZoomContext::default())
        .step_zoom_in(&square());
    assert_eq!(model.pixel_scale, 0.0);
}

#[test]
fn step_zoom_out_from_just_above_fit_settles_on_fit() {
    let model = fit_model()
        .zoom_to_scale(FIT * 1.02, &CanvasZoomContext::default())
        .step_zoom_out(&square());
    assert_eq!(model.pixel_scale, 0.0);
}

#[test]
fn wheel_zoom_out_from_fit_reaches_the_floor_and_back_through_fit() {
    let ctx = square();
    let centre = Point::new(500.0, 400.0);
    let floor = fit_model().wheel_zoom(-1000.0, centre, &ctx);
    assert_close(floor.pixel_scale, ctx.min_scale(), 1e-9);
    assert_eq!(floor.pan_offset, Size::ZERO);
    let at_fit = floor.wheel_zoom(1000.0, centre, &ctx);
    assert_eq!(
        at_fit.pixel_scale, 0.0,
        "zooming in across fit stops at fit once"
    );
    assert!(at_fit.wheel_zoom(10.0, centre, &ctx).pixel_scale > FIT);
}

#[test]
fn pinch_release_near_fill_settles_on_fill() {
    let ctx = square();
    let magnification = FILL / FIT * 1.02;
    let live = fit_model()
        .pinch_changed(1.0, Point::new(500.0, 400.0), &ctx)
        .pinch_changed(magnification, Point::new(500.0, 400.0), &ctx);
    assert_close(live.pixel_scale, FIT * magnification, 1e-9);
    let model = live.pinch_ended(magnification, &ctx);
    assert_close(model.pixel_scale, FILL, 1e-9);
    assert!(model.fills_viewport);
    assert_eq!(model.current_stop(), Some(ZoomStop::Fill));
    assert_eq!(model.base_pan, model.pan_offset);
}

#[test]
fn pinch_away_from_fill_clears_the_fill_stop() {
    let ctx = square();
    let model = pinch(fit_model().zoom_to_fill(&ctx), 2.0, &ctx);
    assert!(!model.fills_viewport);
    assert_close(model.pixel_scale, FILL * 2.0, 1e-9);
}

#[test]
fn pinch_just_below_fit_settles_on_fit_on_release_only() {
    let ctx = square();
    let live = fit_model()
        .pinch_changed(1.0, Point::new(300.0, 200.0), &ctx)
        .pinch_changed(0.97, Point::new(300.0, 200.0), &ctx);
    assert_close(live.pixel_scale, FIT * 0.97, 1e-12);
    let released = live.pinch_ended(0.97, &ctx);
    assert_eq!(released.pixel_scale, 0.0);
    assert_eq!(released.pan_offset, Size::ZERO);
}

#[test]
fn pinch_release_without_a_change_frame_near_fill_settles_on_fill() {
    let ctx = square();
    let model = fit_model()
        .zoom_to_scale(FILL * 1.01, &CanvasZoomContext::default())
        .pinch_ended(1.0, &ctx);
    assert_close(model.pixel_scale, FILL, 1e-12);
    assert_eq!(model.current_stop(), Some(ZoomStop::Fill));
    assert_eq!(model.pan_offset, ctx.clamped_pan(model.pan_offset, FILL));
}

#[test]
fn pinch_release_without_a_change_frame_still_honours_the_fit_detent() {
    let model = fit_model()
        .zoom_to_scale(FIT * 1.01, &CanvasZoomContext::default())
        .pinch_ended(1.0, &square());
    assert_eq!(model.pixel_scale, 0.0);
}

/// Codex on #5711: 8000×5000 in 1000×800pt @2× (fit 0.25, fill 0.32). A zoom
/// step lands on 0.3125, inside fill's band; the capture frame must not snap
/// the frozen frame to 0.32, or a 2× pinch shows 0.64 and commits 0.625.
#[test]
fn pinch_capture_inside_a_detent_band_shows_what_it_commits() {
    let wide = context((1000.0, 800.0), (8000.0, 5000.0));
    assert_close(wide.fit_scale(), 0.25, 1e-12);
    assert_close(wide.fill_scale(), 0.32, 1e-12);
    let centroid = Point::new(400.0, 300.0);
    let captured = fit_model()
        .zoom_to_scale(0.3125, &CanvasZoomContext::default())
        .pinch_changed(1.0, centroid, &wide);
    assert_close(captured.pixel_scale, 0.3125, 1e-12);
    let start = captured
        .pinch_start_scale
        .expect("the capture frame records the start");
    let frozen = wide.effective_scale(captured.pixel_scale);
    let shown = frozen * pinch_scale(start, 2.0, wide.fit_scale(), wide.fill_scale()) / start;
    let committed = captured
        .pinch_changed(2.0, centroid, &wide)
        .pinch_ended(2.0, &wide);
    assert_close(shown, 0.625, 1e-12);
    assert_close(committed.pixel_scale, shown, 1e-12);
}

#[test]
fn pinch_capture_inside_a_detent_band_still_snaps_on_release() {
    let ctx = square();
    let captured = fit_model()
        .zoom_to_scale(FILL * 0.98, &CanvasZoomContext::default())
        .pinch_changed(1.0, Point::new(500.0, 400.0), &ctx);
    assert_close(captured.pixel_scale, FILL * 0.98, 1e-12);
    let released = captured.pinch_ended(1.0, &ctx);
    assert_close(released.pixel_scale, FILL, 1e-12);
    assert_eq!(released.current_stop(), Some(ZoomStop::Fill));
}

#[test]
fn zoom_to_fill_centres_and_pans_only_the_overflowing_axis() {
    let ctx = square();
    let model = fit_model().zoom_to_fill(&ctx);
    assert_close(model.pixel_scale, FILL, 1e-9);
    assert_eq!(model.pan_offset, Size::ZERO);
    let limit = ctx.max_pan_offset(model.pixel_scale);
    assert_close(limit.width, 0.0, 1e-9);
    assert_close(limit.height, 100.0, 1e-9);
    let panned = drag(model, 400.0, 400.0, &ctx);
    assert_close(panned.pan_offset.width, 0.0, 1e-9);
    assert_close(panned.pan_offset.height, 100.0, 1e-9);
}

#[test]
fn fill_follows_a_viewport_rotation() {
    let ctx = square();
    let (model, _) = drag(fit_model().zoom_to_fill(&ctx), 0.0, 100.0, &ctx).drag_ended();
    assert_eq!(model.pan_offset, Size::new(0.0, 100.0));
    let portrait = context((800.0, 1000.0), (6000.0, 6000.0));
    let rotated = model.reclamp_pan(&portrait);
    assert_close(rotated.pixel_scale, portrait.fill_scale(), 1e-9);
    assert!(rotated.fills_viewport);
    assert_eq!(rotated.pan_offset, Size::ZERO);
    assert_eq!(rotated.base_pan, Size::ZERO);
}

#[test]
fn fill_that_comes_to_match_fit_on_resize_becomes_fit() {
    let matching = context((900.0, 900.0), (6000.0, 6000.0));
    let model = fit_model().zoom_to_fill(&square()).reclamp_pan(&matching);
    assert_eq!(model.pixel_scale, 0.0);
    assert_eq!(model.current_stop(), Some(ZoomStop::Fit));
    assert_eq!(
        model.advance_stop(&matching).current_stop(),
        Some(ZoomStop::ActualSize)
    );
}

#[test]
fn fill_chosen_before_the_image_size_is_known_resolves_once_it_lands() {
    let no_size_yet = context((1000.0, 800.0), (0.0, 0.0));
    let model = fit_model().zoom_to_fill(&no_size_yet);
    assert_eq!(model.pixel_scale, 1.0);
    let resolved = model.reclamp_pan(&square());
    assert_close(resolved.pixel_scale, FILL, 1e-9);
    assert!(resolved.fills_viewport);
}

#[test]
fn a_scale_relative_to_fill_is_not_re_resolved_on_resize() {
    let ctx = square();
    let model = pinch(fit_model().zoom_to_fill(&ctx), 2.0, &ctx).reclamp_pan(&landscape());
    assert_close(model.pixel_scale, FILL * 2.0, 1e-9);
}

#[test]
fn a_free_scale_is_not_re_resolved_on_resize() {
    let model = fit_model()
        .zoom_to_scale(0.5, &CanvasZoomContext::default())
        .reclamp_pan(&landscape());
    assert_eq!(model.pixel_scale, 0.5);
    assert!(!model.fills_viewport);
}

#[test]
fn every_other_transition_clears_the_fill_stop() {
    let ctx = square();
    let transitions: [fn(CanvasZoomModel, &CanvasZoomContext) -> CanvasZoomModel; 6] = [
        |model, _| model.reset_to_fit(&CanvasZoomContext::default()),
        |model, _| model.zoom_to_scale(1.0, &CanvasZoomContext::default()),
        |model, ctx| model.step_zoom_in(ctx),
        |model, ctx| model.step_zoom_out(ctx),
        |model, ctx| model.wheel_zoom(50.0, Point::ZERO, ctx),
        |model, ctx| model.double_tap(Point::ZERO, DoubleTapBehavior::ToggleFitAnd100, ctx),
    ];
    for transition in transitions {
        assert!(!transition(fit_model().zoom_to_fill(&ctx), &ctx).fills_viewport);
    }
}

#[test]
fn badge_cycles_fit_fill_actual_size() {
    let ctx = square();
    let model = fit_model();
    assert_eq!(model.current_stop(), Some(ZoomStop::Fit));
    let fill = model.advance_stop(&ctx);
    assert_eq!(fill.current_stop(), Some(ZoomStop::Fill));
    assert_close(fill.pixel_scale, FILL, 1e-9);
    let actual = fill.advance_stop(&ctx);
    assert_eq!(actual.current_stop(), Some(ZoomStop::ActualSize));
    assert_eq!(actual.pixel_scale, 1.0);
    assert_eq!(actual.pan_offset, Size::ZERO);
    let back = actual.advance_stop(&ctx);
    assert_eq!(back.current_stop(), Some(ZoomStop::Fit));
    assert_eq!(back.pixel_scale, 0.0);
}

#[test]
fn badge_from_a_free_scale_returns_to_fit() {
    let ctx = square();
    let below = fit_model().step_zoom_out(&ctx).advance_stop(&ctx);
    assert_eq!(below.pixel_scale, 0.0);
    let zoomed = fit_model()
        .zoom_to_scale(3.0, &CanvasZoomContext::default())
        .advance_stop(&ctx);
    assert_eq!(zoomed.pixel_scale, 0.0);
}

#[test]
fn badge_skips_a_fill_that_coincides_with_fit() {
    let matching = context((1000.0, 800.0), (5000.0, 4000.0));
    assert_eq!(
        CanvasZoomModel::badge_stops(&matching).as_slice(),
        [ZoomStop::Fit, ZoomStop::ActualSize]
    );
    assert_eq!(
        fit_model().advance_stop(&matching).current_stop(),
        Some(ZoomStop::ActualSize)
    );
}

#[test]
fn badge_on_a_small_image_keeps_the_true_100_percent_stop() {
    let small = context((1000.0, 800.0), (400.0, 300.0));
    assert_eq!(
        CanvasZoomModel::badge_stops(&small).as_slice(),
        [ZoomStop::Fit, ZoomStop::Fill, ZoomStop::ActualSize]
    );
    let actual = fit_model().advance_stop(&small).advance_stop(&small);
    assert_eq!(
        actual.pixel_scale, 1.0,
        "100% shows true pixels even when that is smaller than the pinch floor"
    );
    assert_eq!(actual.advance_stop(&small).pixel_scale, 0.0);
}
