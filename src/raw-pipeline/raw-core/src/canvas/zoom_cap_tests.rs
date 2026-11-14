//! The zoom-in cap on images that already fit above `MAX_PIXEL_SCALE` (#5714):
//! zooming in never shrinks the image, fit and fill stay reachable, and
//! normal images keep the 800% cap.

use super::*;
use crate::canvas::zoom_rules::max_zoom;
use crate::canvas::ZoomStop;

/// 1000×800pt @2× over 64×64: fit 25, fill 31.25 — already above 800%.
fn tiny() -> CanvasZoomContext {
    context((1000.0, 800.0), (64.0, 64.0))
}

const TINY_FIT: f64 = 25.0;
const TINY_FILL: f64 = 31.25;

/// A 100×150 crop of a large frame: the context sees the cropped extent, so
/// fit 10.667 and fill 20 both exceed 800%.
fn tiny_crop() -> CanvasZoomContext {
    context((1000.0, 800.0), (100.0, 150.0))
}

/// 300×100: fit 6.667 sits under 800% but fill 16 is above it.
fn wide_small() -> CanvasZoomContext {
    context((1000.0, 800.0), (300.0, 100.0))
}

fn every_zoom_in(model: CanvasZoomModel, ctx: &CanvasZoomContext) -> [CanvasZoomModel; 4] {
    let centre = Point::new(500.0, 400.0);
    [
        model.step_zoom_in(ctx),
        model.wheel_zoom(200.0, centre, ctx),
        model
            .pinch_changed(1.0, centre, ctx)
            .pinch_changed(3.0, centre, ctx)
            .pinch_ended(3.0, ctx),
        model.double_tap(centre, DoubleTapBehavior::ToggleFitAnd100, ctx),
    ]
}

#[test]
fn the_cap_rises_to_fit_or_fill_only_when_they_exceed_800_percent() {
    assert_eq!(max_zoom(0.25, 0.3), MAX_PIXEL_SCALE);
    assert_eq!(max_zoom(25.0, 31.25), 31.25);
    assert_eq!(max_zoom(12.0, 12.0), 12.0);
    assert_eq!(max_zoom(f64::NAN, f64::NAN), MAX_PIXEL_SCALE);
    assert_eq!(square().max_scale(), MAX_PIXEL_SCALE);
    assert_eq!(landscape().max_scale(), MAX_PIXEL_SCALE);
    for ctx in [square(), landscape(), tiny(), tiny_crop(), wide_small()] {
        assert!(ctx.min_scale() <= ctx.fit_scale());
        assert!(ctx.fit_scale() <= ctx.max_scale());
        assert!(ctx.fill_scale() <= ctx.max_scale());
    }
}

#[test]
fn a_tiny_image_keeps_a_fill_that_covers_the_viewport() {
    let ctx = tiny();
    assert_close(ctx.fit_scale(), TINY_FIT, 1e-9);
    assert_close(ctx.fill_scale(), TINY_FILL, 1e-9);
    assert_close(ctx.max_scale(), TINY_FILL, 1e-9);
    let frame = ctx
        .display_frame_in_points(ctx.fill_scale())
        .expect("sized");
    assert!(frame.width >= 1000.0 - 1e-9 && frame.height >= 800.0 - 1e-9);
}

#[test]
fn zooming_in_on_a_tiny_image_never_shrinks_it() {
    let ctx = tiny();
    for zoomed in every_zoom_in(fit_model(), &ctx) {
        let scale = ctx.effective_scale(zoomed.pixel_scale);
        assert!(
            scale >= TINY_FIT,
            "zoom in shrank fit {TINY_FIT} to {scale}"
        );
        assert!(scale <= ctx.max_scale() + 1e-9);
    }
    let stepped = fit_model().step_zoom_in(&ctx);
    assert_close(stepped.pixel_scale, TINY_FILL, 1e-9);
    assert!(
        !stepped.fills_viewport,
        "a step that reaches fill's scale is a free scale, not the fill stop"
    );
    assert_eq!(
        stepped.step_zoom_in(&ctx),
        stepped,
        "a step at the cap is a no-op"
    );
}

#[test]
fn double_tap_on_an_image_that_fits_above_100_percent_zooms_to_the_cap() {
    let ctx = tiny();
    let tapped = fit_model().double_tap(
        Point::new(500.0, 400.0),
        DoubleTapBehavior::ToggleFitAnd100,
        &ctx,
    );
    assert_close(tapped.pixel_scale, TINY_FILL, 1e-9);
    assert!(!tapped.fills_viewport);
    assert_eq!(
        tapped
            .double_tap(Point::ZERO, DoubleTapBehavior::ToggleFitAnd100, &ctx)
            .pixel_scale,
        0.0
    );
    let square_tiny = context((1000.0, 1000.0), (50.0, 50.0));
    assert_eq!(
        fit_model().double_tap(
            Point::ZERO,
            DoubleTapBehavior::ToggleFitAnd100,
            &square_tiny
        ),
        fit_model(),
        "with nothing larger than fit, a double-tap stays at fit"
    );
    let cap_inside_fit_band = context((1000.0, 800.0), (64.0, 52.0));
    assert!(cap_inside_fit_band.max_scale() < cap_inside_fit_band.fit_scale() * 1.04);
    assert_eq!(
        fit_model().double_tap(
            Point::ZERO,
            DoubleTapBehavior::ToggleFitAnd100,
            &cap_inside_fit_band
        ),
        fit_model(),
        "a cap inside fit's detent band is no zoom at all"
    );
}

#[test]
fn double_tap_on_an_image_that_fits_at_200_percent_zooms_to_800_percent() {
    let ctx = context((1000.0, 800.0), (1000.0, 800.0));
    assert_close(ctx.fit_scale(), 2.0, 1e-12);
    let tapped = fit_model().double_tap(Point::ZERO, DoubleTapBehavior::ToggleFitAnd100, &ctx);
    assert_eq!(tapped.pixel_scale, MAX_PIXEL_SCALE);
}

#[test]
fn a_pinch_on_a_tiny_image_reaches_fill_and_settles_there() {
    let ctx = tiny();
    let model = pinch(fit_model(), 10.0, &ctx);
    assert_close(model.pixel_scale, TINY_FILL, 1e-9);
    assert_eq!(model.current_stop(), Some(ZoomStop::Fill));
}

#[test]
fn the_badge_on_a_tiny_image_cycles_fit_fill_then_true_pixels() {
    let ctx = tiny();
    assert_eq!(
        CanvasZoomModel::badge_stops(&ctx).as_slice(),
        [ZoomStop::Fit, ZoomStop::Fill, ZoomStop::ActualSize]
    );
    let fill = fit_model().advance_stop(&ctx);
    assert_close(fill.pixel_scale, TINY_FILL, 1e-9);
    let actual = fill.advance_stop(&ctx);
    assert_eq!(actual.pixel_scale, 1.0);
    assert_eq!(actual.advance_stop(&ctx).pixel_scale, 0.0);
}

#[test]
fn zooming_out_from_100_percent_below_the_floor_never_grows_the_image() {
    let ctx = tiny();
    let centre = Point::new(500.0, 400.0);
    let actual = fit_model().zoom_to_scale(1.0, &ctx);
    assert!(1.0 < ctx.min_scale());
    assert_eq!(actual.step_zoom_out(&ctx), actual);
    assert_eq!(actual.wheel_zoom(-200.0, centre, &ctx), actual);
    assert_close(actual.step_zoom_in(&ctx).pixel_scale, 1.25, 1e-12);
}

#[test]
fn a_pinch_out_from_100_percent_below_the_floor_holds_then_releases_to_fit() {
    let ctx = tiny();
    let centre = Point::new(500.0, 400.0);
    let live = fit_model()
        .zoom_to_scale(1.0, &ctx)
        .pinch_changed(1.0, centre, &ctx)
        .pinch_changed(0.5, centre, &ctx);
    assert_eq!(live.pixel_scale, 1.0);
    assert_eq!(live.pinch_ended(0.5, &ctx).pixel_scale, 0.0);
}

#[test]
fn a_tiny_crop_zooms_in_from_fit_and_reaches_fill() {
    let ctx = tiny_crop();
    let fit = 1600.0 / 150.0;
    assert_close(ctx.fit_scale(), fit, 1e-9);
    assert_close(ctx.fill_scale(), 20.0, 1e-9);
    for zoomed in every_zoom_in(fit_model(), &ctx) {
        assert!(ctx.effective_scale(zoomed.pixel_scale) >= fit);
    }
    assert_close(
        fit_model().step_zoom_in(&ctx).pixel_scale,
        fit * ZOOM_STEP,
        1e-9,
    );
    assert_close(fit_model().zoom_to_fill(&ctx).pixel_scale, 20.0, 1e-9);
    let floor = (0..10).fold(fit_model(), |model, _| model.step_zoom_out(&ctx));
    assert_close(floor.pixel_scale, ctx.min_scale(), 1e-9);
}

#[test]
fn a_fill_above_800_percent_is_a_real_fill_on_an_image_that_fits_below_it() {
    let ctx = wide_small();
    assert!(ctx.fit_scale() < MAX_PIXEL_SCALE);
    assert_close(ctx.fill_scale(), 16.0, 1e-9);
    assert_close(ctx.max_scale(), 16.0, 1e-9);
    let fill = fit_model().zoom_to_fill(&ctx);
    let frame = ctx
        .display_frame_in_points(fill.pixel_scale)
        .expect("sized");
    assert!(frame.width >= 1000.0 - 1e-9 && frame.height >= 800.0 - 1e-9);
    let past_800 = fit_model()
        .zoom_to_scale(MAX_PIXEL_SCALE, &ctx)
        .step_zoom_in(&ctx);
    assert_close(past_800.pixel_scale, 10.0, 1e-9);
    let pinched = pinch(fit_model(), 100.0, &ctx);
    assert_close(pinched.pixel_scale, 16.0, 1e-9);
    assert_eq!(pinched.current_stop(), Some(ZoomStop::Fill));
}

#[test]
fn a_free_scale_above_a_lowered_cap_keeps_its_size_across_a_resize() {
    let free = fit_model()
        .zoom_to_scale(MAX_PIXEL_SCALE, &tiny())
        .step_zoom_in(&tiny());
    assert_close(free.pixel_scale, 10.0, 1e-9);
    assert!(!free.fills_viewport);
    let larger_image = context((1000.0, 800.0), (256.0, 256.0));
    assert_eq!(larger_image.max_scale(), MAX_PIXEL_SCALE);
    for resized in [
        free.reclamp_pan(&larger_image),
        free.geometry_changed(&tiny(), &larger_image),
    ] {
        assert_close(resized.pixel_scale, 10.0, 1e-9);
        assert_eq!(
            resized.step_zoom_in(&larger_image).pixel_scale,
            resized.pixel_scale,
            "above the cap a zoom-in step is a no-op"
        );
        assert_close(resized.step_zoom_out(&larger_image).pixel_scale, 8.0, 1e-9);
    }
}

#[test]
fn a_wheel_zoom_that_reaches_fills_scale_is_a_free_scale() {
    let ctx = tiny();
    let wheeled = fit_model().wheel_zoom(200.0, Point::new(500.0, 400.0), &ctx);
    assert_close(wheeled.pixel_scale, TINY_FILL, 1e-9);
    assert!(!wheeled.fills_viewport);
}

#[test]
fn double_tap_on_an_image_that_fits_just_under_100_percent_zooms_to_100_percent() {
    let ctx = context((1000.0, 800.0), (2050.0, 1640.0));
    assert!(ctx.fit_scale() < 1.0 && ctx.fit_scale() > 0.97);
    let tapped = fit_model().double_tap(Point::ZERO, DoubleTapBehavior::ToggleFitAnd100, &ctx);
    assert_eq!(tapped.pixel_scale, 1.0);
}

#[test]
fn a_normal_image_keeps_the_800_percent_cap() {
    let ctx = square();
    let capped = (0..40).fold(fit_model(), |model, _| model.step_zoom_in(&ctx));
    assert_eq!(capped.pixel_scale, MAX_PIXEL_SCALE);
    assert_eq!(
        pinch(fit_model(), 1000.0, &ctx).pixel_scale,
        MAX_PIXEL_SCALE
    );
    assert_eq!(
        fit_model()
            .double_tap(Point::ZERO, DoubleTapBehavior::ToggleFitAnd100, &ctx)
            .pixel_scale,
        1.0
    );
    let sliver = context((1000.0, 800.0), (20000.0, 100.0));
    assert_eq!(sliver.fill_scale(), MAX_PIXEL_SCALE);
    assert_eq!(sliver.max_scale(), MAX_PIXEL_SCALE);
}

#[test]
fn a_pinch_begun_below_the_floor_keeps_its_frame_when_re_captured() {
    let ctx = tiny();
    let centre = Point::new(500.0, 400.0);
    let live = fit_model()
        .zoom_to_scale(1.0, &ctx)
        .pinch_changed(1.0, centre, &ctx)
        .pinch_changed(1.3, centre, &ctx);
    assert_close(live.pixel_scale, 1.3, 1e-12);
    let rebased = live
        .pinch_rebased(1.3, centre, 1.3, centre, &ctx)
        .pinch_changed(1.3, centre, &ctx);
    assert_close(rebased.pixel_scale, 1.3, 1e-12);
    let stepped = live.step_zoom_in(&ctx).pinch_changed(1.3, centre, &ctx);
    assert_close(stepped.pixel_scale, 1.3 * 1.25, 1e-12);
}

#[test]
fn a_geometry_change_mid_pinch_holds_the_capture_to_the_new_cap() {
    let ctx = tiny();
    let centre = Point::new(500.0, 400.0);
    let live = fit_model()
        .pinch_changed(1.0, centre, &ctx)
        .pinch_changed(0.9, centre, &ctx);
    assert_close(live.pixel_scale, 22.5, 1e-9);
    let uncropped = context((1000.0, 800.0), (4000.0, 3000.0));
    assert_eq!(uncropped.max_scale(), MAX_PIXEL_SCALE);
    for carried in [
        live.geometry_changed(&ctx, &uncropped),
        live.reclamp_pan(&uncropped),
    ] {
        let next = carried.pinch_changed(0.9, centre, &uncropped);
        assert!(
            uncropped.effective_scale(next.pixel_scale) <= MAX_PIXEL_SCALE,
            "the frame after the change exceeds the new cap: {}",
            next.pixel_scale
        );
    }
}

#[test]
fn a_resize_that_lowers_the_cap_mid_pinch_carries_the_live_pan_with_the_held_scale() {
    let ctx = wide_small();
    let off_centre = Point::new(300.0, 400.0);
    let live = fit_model()
        .pinch_changed(1.0, off_centre, &ctx)
        .pinch_changed(2.1, off_centre, &ctx);
    let (scale, pan) = live.shown_frame(&ctx);
    assert_close(scale, 14.0, 1e-9);
    assert!(pan.width.abs() > 1.0);
    let smaller = context((500.0, 400.0), (300.0, 100.0));
    assert_eq!(smaller.max_scale(), MAX_PIXEL_SCALE);
    let (held_scale, held_pan) = live.geometry_changed(&ctx, &smaller).shown_frame(&smaller);
    assert_close(held_scale, MAX_PIXEL_SCALE, 1e-9);
    assert_close(held_pan.width, pan.width * MAX_PIXEL_SCALE / scale, 1e-9);
}

#[test]
fn a_crop_that_raises_the_floor_mid_pinch_keeps_the_live_pan() {
    let ctx = context((1000.0, 800.0), (4000.0, 3000.0));
    let off_centre = Point::new(300.0, 400.0);
    let live = fit_model()
        .pinch_changed(1.0, off_centre, &ctx)
        .pinch_changed(0.6, off_centre, &ctx);
    let (_, pan) = live.shown_frame(&ctx);
    assert!(pan.width.abs() > 1.0);
    let cropped = tiny();
    let (held_scale, held_pan) = live.geometry_changed(&ctx, &cropped).shown_frame(&cropped);
    assert_close(held_scale, cropped.min_scale(), 1e-9);
    assert_close(held_pan.width, pan.width, 1e-9);
}

#[test]
fn a_geometry_change_mid_pinch_holds_the_capture_to_the_new_floor() {
    let ctx = context((1000.0, 800.0), (4000.0, 3000.0));
    let centre = Point::new(500.0, 400.0);
    let live = fit_model()
        .pinch_changed(1.0, centre, &ctx)
        .pinch_changed(0.6, centre, &ctx);
    let shown = ctx.effective_scale(live.pixel_scale);
    let cropped = context((1000.0, 800.0), (64.0, 64.0));
    assert!(shown < cropped.min_scale());
    let next = live
        .geometry_changed(&ctx, &cropped)
        .pinch_changed(0.6, centre, &cropped);
    assert!(cropped.effective_scale(next.pixel_scale) >= cropped.min_scale() - 1e-9);
}

#[test]
fn unchanged_geometry_reported_mid_pinch_keeps_a_pinch_begun_below_the_floor() {
    let ctx = tiny();
    let centre = Point::new(500.0, 400.0);
    let live = fit_model()
        .zoom_to_scale(1.0, &ctx)
        .pinch_changed(1.0, centre, &ctx)
        .pinch_changed(1.05, centre, &ctx);
    let synced = live.geometry_changed(&ctx, &ctx);
    assert_close(synced.pixel_scale, 1.05, 1e-12);
    assert_close(
        synced.pinch_changed(1.05, centre, &ctx).pixel_scale,
        1.05,
        1e-12,
    );
}

#[test]
fn a_step_mid_pinch_from_an_inexact_start_below_the_floor_keeps_its_frame() {
    let ctx = tiny();
    let centre = Point::new(500.0, 400.0);
    let stepped = fit_model()
        .zoom_to_scale(3.3, &ctx)
        .pinch_changed(1.0, centre, &ctx)
        .pinch_changed(1.6, centre, &ctx)
        .step_zoom_in(&ctx);
    let shown = stepped.pixel_scale;
    assert!(shown < ctx.min_scale());
    assert_close(
        stepped.pinch_changed(1.6, centre, &ctx).pixel_scale,
        shown,
        1e-9,
    );
}

#[test]
fn double_tap_before_the_image_size_is_known_zooms_to_100_percent() {
    let unknown = context((1000.0, 800.0), (0.0, 0.0));
    let tapped = fit_model().double_tap(Point::ZERO, DoubleTapBehavior::ToggleFitAnd100, &unknown);
    assert_eq!(tapped.pixel_scale, 1.0);
}
