//! Below-fit pinch anchoring, continuity across fit, the release settle and
//! the visible-area insets.

use crate::canvas::{CanvasZoomContext, CanvasZoomModel, Insets, Point, Size};

/// 1000×800pt @2× over 6000×6000: fit 0.2667 (an 800pt square, letterboxed
/// horizontally), fill 0.3333.
fn square() -> CanvasZoomContext {
    CanvasZoomContext::new(Size::new(1000.0, 800.0), Size::new(6000.0, 6000.0), 2.0)
}

/// `square()` with a 100pt header and a 300pt trailing inspector: the visible
/// area is 700×700 at (0, 100), so fit is 700pt and home is (−150, +50).
fn square_with_chrome() -> CanvasZoomContext {
    square().with_insets(Insets::new(100.0, 0.0, 0.0, 300.0))
}

fn assert_close(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() <= tolerance,
        "expected {expected}, got {actual}"
    );
}

fn assert_point_close(actual: Point, expected: Point, tolerance: f64) {
    assert_close(actual.x, expected.x, tolerance);
    assert_close(actual.y, expected.y, tolerance);
}

/// Points per image pixel on screen.
fn points_per_pixel(model: &CanvasZoomModel, context: &CanvasZoomContext) -> f64 {
    context.effective_scale(model.pixel_scale) / context.display_scale()
}

/// The image pixel drawn under viewport point `q`.
fn image_point_under(model: &CanvasZoomModel, context: &CanvasZoomContext, q: Point) -> Point {
    let viewport = context.viewport_points();
    let scale = points_per_pixel(model, context);
    let native = context.native_image_size();
    Point::new(
        native.width / 2.0 + (q.x - viewport.width / 2.0 - model.pan_offset.width) / scale,
        native.height / 2.0 + (q.y - viewport.height / 2.0 - model.pan_offset.height) / scale,
    )
}

/// The image's on-screen rect: (min x, min y, max x, max y) in points.
fn image_rect(model: &CanvasZoomModel, context: &CanvasZoomContext) -> (f64, f64, f64, f64) {
    let viewport = context.viewport_points();
    let frame = context
        .display_frame_in_points(model.pixel_scale)
        .expect("image size is known");
    let centre_x = viewport.width / 2.0 + model.pan_offset.width;
    let centre_y = viewport.height / 2.0 + model.pan_offset.height;
    (
        centre_x - frame.width / 2.0,
        centre_y - frame.height / 2.0,
        centre_x + frame.width / 2.0,
        centre_y + frame.height / 2.0,
    )
}

fn at_fit(context: &CanvasZoomContext) -> CanvasZoomModel {
    CanvasZoomModel::default().reset_to_fit(context)
}

#[test]
fn pinch_out_below_fit_keeps_the_point_under_the_fingers() {
    let ctx = square();
    let fingers = Point::new(850.0, 150.0);
    let before = image_point_under(&at_fit(&ctx), &ctx, fingers);
    let pinched = at_fit(&ctx)
        .pinch_changed(1.0, fingers, &ctx)
        .pinch_changed(0.6, fingers, &ctx);
    assert_close(pinched.pixel_scale, ctx.fit_scale() * 0.6, 1e-12);
    assert_point_close(image_point_under(&pinched, &ctx, fingers), before, 1e-6);
    let (min_x, min_y, max_x, max_y) = image_rect(&pinched, &ctx);
    assert_close(min_x, 400.0, 1e-6);
    assert_close(min_y, 60.0, 1e-6);
    assert_close(max_x, 880.0, 1e-6);
    assert_close(max_y, 540.0, 1e-6);
}

#[test]
fn pinch_out_below_fit_keeps_the_anchor_with_insets_too() {
    let ctx = square_with_chrome();
    let fingers = Point::new(600.0, 200.0);
    let before = image_point_under(&at_fit(&ctx), &ctx, fingers);
    let pinched = at_fit(&ctx)
        .pinch_changed(1.0, fingers, &ctx)
        .pinch_changed(0.5, fingers, &ctx);
    assert_point_close(image_point_under(&pinched, &ctx, fingers), before, 1e-6);
}

#[test]
fn live_frames_inside_the_fit_band_are_not_snapped() {
    let ctx = square();
    let fingers = Point::new(700.0, 300.0);
    let started = at_fit(&ctx).pinch_changed(1.0, fingers, &ctx);
    for magnification in [0.97, 0.99, 1.01, 1.03] {
        let frame = started.pinch_changed(magnification, fingers, &ctx);
        assert_close(frame.pixel_scale, ctx.fit_scale() * magnification, 1e-12);
    }
}

/// Sweeps the magnification in small steps across fit and checks no frame
/// moves the image by more than the step itself can explain.
fn assert_continuous_sweep(start: CanvasZoomModel, ctx: &CanvasZoomContext, from: f64, to: f64) {
    let fingers = Point::new(780.0, 210.0);
    let captured = start.pinch_changed(1.0, fingers, ctx);
    let steps = 2000;
    let mut previous = captured.pinch_changed(from, fingers, ctx);
    for step in 1..=steps {
        let magnification = from + (to - from) * f64::from(step) / f64::from(steps);
        let frame = captured.pinch_changed(magnification, fingers, ctx);
        let previous_scale = ctx.effective_scale(previous.pixel_scale);
        let scale = ctx.effective_scale(frame.pixel_scale);
        assert!(
            (scale / previous_scale - 1.0).abs() < 0.002,
            "scale jumped {previous_scale} → {scale} at magnification {magnification}"
        );
        let moved = (frame.pan_offset.width - previous.pan_offset.width)
            .abs()
            .max((frame.pan_offset.height - previous.pan_offset.height).abs());
        assert!(
            moved < 2.0,
            "pan jumped {moved}pt at magnification {magnification}"
        );
        previous = frame;
    }
}

#[test]
fn pinching_out_across_fit_is_continuous() {
    let ctx = square();
    let zoomed = at_fit(&ctx).zoom_to_scale(ctx.fit_scale() * 2.0, &ctx);
    assert_continuous_sweep(zoomed, &ctx, 1.0, 0.3);
}

#[test]
fn pinching_in_across_fit_is_continuous() {
    let ctx = square();
    let below = at_fit(&ctx)
        .pinch_changed(1.0, Point::new(850.0, 150.0), &ctx)
        .pinch_changed(0.6, Point::new(850.0, 150.0), &ctx);
    let held = CanvasZoomModel {
        pinch_start_scale: None,
        ..below
    };
    assert_continuous_sweep(held, &ctx, 1.0, 3.0);
}

#[test]
fn pinching_across_fit_with_insets_is_continuous() {
    let ctx = square_with_chrome();
    let zoomed = at_fit(&ctx).zoom_to_scale(ctx.fit_scale() * 1.5, &ctx);
    assert_continuous_sweep(zoomed, &ctx, 1.0, 0.4);
    assert_continuous_sweep(at_fit(&ctx), &ctx, 0.6, 1.6);
}

#[test]
fn a_live_pinch_below_fit_keeps_the_image_inside_the_visible_area() {
    let ctx = square_with_chrome();
    let start = Point::new(350.0, 450.0);
    let dragged_away = Point::new(990.0, 20.0);
    let frame = at_fit(&ctx)
        .pinch_changed(1.0, start, &ctx)
        .pinch_changed(0.5, dragged_away, &ctx);
    let (min_x, min_y, max_x, max_y) = image_rect(&frame, &ctx);
    assert!(min_x >= -1e-9 && max_x <= 700.0 + 1e-9, "x {min_x}…{max_x}");
    assert!(
        min_y >= 100.0 - 1e-9 && max_y <= 800.0 + 1e-9,
        "y {min_y}…{max_y}"
    );
    assert_close(max_x, 700.0, 1e-9);
    assert_close(min_y, 100.0, 1e-9);
}

#[test]
fn release_below_fit_settles_to_fit_centred_in_the_visible_area() {
    let ctx = square_with_chrome();
    let fingers = Point::new(600.0, 200.0);
    let released = at_fit(&ctx)
        .pinch_changed(1.0, fingers, &ctx)
        .pinch_changed(0.6, fingers, &ctx)
        .pinch_ended(0.6, &ctx);
    assert_eq!(released.pixel_scale, 0.0);
    assert_eq!(released.pinch_start_scale, None);
    assert_eq!(released.pan_offset, Size::new(-150.0, 50.0));
    assert_eq!(released.base_pan, released.pan_offset);
    let (min_x, min_y, max_x, max_y) = image_rect(&released, &ctx);
    assert_close(min_x, 0.0, 1e-9);
    assert_close(min_y, 100.0, 1e-9);
    assert_close(max_x, 700.0, 1e-9);
    assert_close(max_y, 800.0, 1e-9);
}

#[test]
fn release_inside_the_fit_band_from_above_settles_on_fit() {
    let ctx = square();
    let released = at_fit(&ctx)
        .pinch_changed(1.0, Point::new(700.0, 300.0), &ctx)
        .pinch_changed(1.03, Point::new(700.0, 300.0), &ctx)
        .pinch_ended(1.03, &ctx);
    assert_eq!(released.pixel_scale, 0.0);
    assert_eq!(released.pan_offset, Size::ZERO);
}

#[test]
fn release_above_fit_brings_the_letterbox_axis_back_to_centre() {
    let ctx = square();
    let fingers = Point::new(850.0, 400.0);
    let live = at_fit(&ctx)
        .pinch_changed(1.0, fingers, &ctx)
        .pinch_changed(1.1, fingers, &ctx);
    assert!(
        live.pan_offset.width < 0.0,
        "the live frame follows the fingers"
    );
    let released = live.pinch_ended(1.1, &ctx);
    assert_close(released.pixel_scale, ctx.fit_scale() * 1.1, 1e-12);
    assert_eq!(released.pan_offset.width, 0.0);
    assert_eq!(released.base_pan, released.pan_offset);
}

#[test]
fn fit_fill_and_home_resolve_against_the_visible_area() {
    let ctx = square_with_chrome();
    assert_close(ctx.fit_scale(), 1400.0 / 6000.0, 1e-12);
    assert_close(ctx.fill_scale(), 1400.0 / 6000.0, 1e-12);
    assert_eq!(ctx.visible_points(), Size::new(700.0, 700.0));
    assert_eq!(ctx.visible_centre(), Point::new(350.0, 450.0));
    assert_eq!(ctx.home_pan(), Size::new(-150.0, 50.0));
    let fit = at_fit(&ctx);
    assert_eq!(fit.pan_offset, Size::new(-150.0, 50.0));
    assert_eq!(
        ctx.display_frame_in_points(fit.pixel_scale),
        Some(Size::new(700.0, 700.0))
    );
}

#[test]
fn the_resting_pan_range_is_measured_against_the_visible_area() {
    let ctx = square_with_chrome();
    let scale = ctx.fit_scale() * 2.0;
    assert_eq!(ctx.max_pan_offset(scale), Size::new(350.0, 350.0));
    let far = Size::new(10_000.0, -10_000.0);
    assert_eq!(ctx.clamped_pan(far, scale), Size::new(200.0, -300.0));
    assert_eq!(
        ctx.clamped_pan(Size::new(f64::NAN, 0.0), scale),
        Size::new(-150.0, 0.0)
    );
}

#[test]
fn chrome_appearing_leaves_a_zoomed_image_where_it_is() {
    let bare = square();
    let zoomed = at_fit(&bare)
        .zoom_to_scale(bare.fit_scale() * 3.0, &bare)
        .wheel_pan(Size::new(120.0, -80.0), &bare);
    let with_chrome = bare.with_insets(Insets::new(60.0, 0.0, 0.0, 0.0));
    assert_eq!(zoomed.reclamp_pan(&with_chrome), zoomed);
}

#[test]
fn chrome_changing_at_fit_recentres_fit_in_the_new_visible_area() {
    let bare = square();
    let with_chrome = square_with_chrome();
    let fit = at_fit(&bare).reclamp_pan(&with_chrome);
    assert_eq!(fit.pixel_scale, 0.0);
    assert_eq!(fit.pan_offset, with_chrome.home_pan());
    assert_eq!(fit.base_pan, with_chrome.home_pan());
    assert_eq!(fit.reclamp_pan(&bare).pan_offset, Size::ZERO);
}

#[test]
fn zoom_steps_and_explicit_scales_centre_on_the_visible_area() {
    let ctx = square_with_chrome();
    let center = ctx.visible_centre();
    let fit = at_fit(&ctx);
    let before = image_point_under(&fit, &ctx, center);
    let stepped = fit.step_zoom_in(&ctx);
    assert_point_close(image_point_under(&stepped, &ctx, center), before, 1e-6);
    assert_eq!(fit.zoom_to_scale(1.0, &ctx).pan_offset, ctx.home_pan());
    assert_eq!(fit.zoom_to_fill(&ctx).pan_offset, ctx.home_pan());
}

#[test]
fn insets_that_leave_no_room_are_ignored_on_that_axis() {
    let ctx = square().with_insets(Insets::new(500.0, f64::NAN, 400.0, -20.0));
    assert_eq!(ctx.insets(), Insets::ZERO);
    let half = square().with_insets(Insets::new(f64::INFINITY, 900.0, 10.0, 99.0));
    assert_eq!(half.insets(), Insets::new(0.0, 900.0, 10.0, 99.0));
    assert_eq!(half.visible_points(), Size::new(1.0, 790.0));
}

#[test]
fn holding_a_shown_frame_keeps_it_exactly() {
    let ctx = square_with_chrome();
    let pan = Size::new(-100.0, 20.0);
    let held = CanvasZoomModel::default()
        .zoom_to_fill(&ctx)
        .hold_shown(0.18, pan, &ctx);
    assert_eq!(held.pixel_scale, 0.18);
    assert_eq!(held.pan_offset, pan);
    assert_eq!(held.base_pan, pan);
    assert!(!held.fills_viewport);
}

#[test]
fn holding_keeps_the_scale_in_the_zoom_range_and_the_pan_exactly() {
    let ctx = square_with_chrome();
    let floor = ctx.min_scale();
    let pan = Size::new(5000.0, 0.0);
    let held = CanvasZoomModel::default().hold_shown(floor * 0.5, pan, &ctx);
    assert_close(held.pixel_scale, floor, 1e-12);
    assert_eq!(held.pan_offset, pan);
}

#[test]
fn holding_ignores_undrawable_frames_an_unknown_image_and_a_live_pinch() {
    let ctx = square_with_chrome();
    let rest = CanvasZoomModel::default().reset_to_fit(&ctx);
    for (scale, pan) in [
        (f64::NAN, Size::ZERO),
        (0.0, Size::ZERO),
        (-1.0, Size::ZERO),
        (0.2, Size::new(f64::INFINITY, 0.0)),
    ] {
        assert_eq!(rest.hold_shown(scale, pan, &ctx), rest);
    }
    let unknown = CanvasZoomContext::new(Size::new(1000.0, 800.0), Size::ZERO, 2.0);
    assert_eq!(rest.hold_shown(1.0, Size::ZERO, &unknown), rest);
    let pinching = rest.pinch_changed(1.0, Point::new(300.0, 300.0), &ctx);
    assert_eq!(pinching.hold_shown(0.2, Size::ZERO, &ctx), pinching);
}

#[test]
fn a_below_fit_pinch_rebased_with_chrome_still_releases_to_the_visible_centre() {
    let ctx = square_with_chrome();
    let fingers = Point::new(500.0, 300.0);
    let below = CanvasZoomModel::default()
        .reset_to_fit(&ctx)
        .pinch_changed(1.0, fingers, &ctx)
        .pinch_changed(0.6, fingers, &ctx);
    let lifted = Point::new(560.0, 340.0);
    let rebased = below.pinch_rebased(0.6, fingers, 0.6, lifted, &ctx);
    let moved = rebased.pinch_changed(0.6, Point::new(600.0, 360.0), &ctx);
    assert_close(moved.pixel_scale, below.pixel_scale, 1e-12);
    let released = moved.pinch_ended(0.6, &ctx);
    assert_eq!(released.pixel_scale, 0.0);
    assert_eq!(released.pan_offset, ctx.home_pan());
}

#[test]
fn fill_re_resolves_against_the_new_visible_area_when_chrome_changes() {
    let bare = square();
    let chrome = square().with_insets(Insets::new(100.0, 0.0, 0.0, 0.0));
    let fill = CanvasZoomModel::default().zoom_to_fill(&bare);
    let refilled = fill.reclamp_pan(&chrome);
    assert!(refilled.fills_viewport);
    let frame = chrome
        .display_frame_in_points(chrome.effective_scale(refilled.pixel_scale))
        .unwrap();
    assert!(frame.width >= chrome.visible_points().width - 1e-9);
    assert!(frame.height >= chrome.visible_points().height - 1e-9);
}

/// Codex on #5754: a chrome change from none to top 100 / right 300 settles
/// from the old fit to the new one; halfway, the frame drawn lies outside the
/// new context's pinch range. Interrupting there must not move the photo.
fn half_settled_chrome_frame() -> (f64, Size) {
    let before = square().fit_scale();
    let after = square_with_chrome().fit_scale();
    ((before * after).sqrt(), Size::new(-75.0, 25.0))
}

#[test]
fn a_pinch_interrupting_a_chrome_settle_starts_exactly_where_the_photo_is() {
    let ctx = square_with_chrome();
    let (scale, pan) = half_settled_chrome_frame();
    assert_close(scale, 0.24944, 1e-5);
    let held = CanvasZoomModel::default()
        .reset_to_fit(&ctx)
        .hold_shown(scale, pan, &ctx);
    assert_eq!(held.pixel_scale, scale);
    assert_eq!(held.pan_offset, pan);

    let fingers = Point::new(400.0, 300.0);
    let captured = held.pinch_changed(1.0, fingers, &ctx);
    let still = captured.pinch_changed(1.0, fingers, &ctx);
    assert_eq!(still.pan_offset, pan, "still fingers never move the photo");
    let nudged = captured.pinch_changed(1.001, fingers, &ctx);
    assert!((nudged.pan_offset.width - pan.width).abs() < 0.5);
    assert!((nudged.pan_offset.height - pan.height).abs() < 0.5);

    let released = still.pinch_ended(1.0, &ctx);
    assert_eq!(released.pixel_scale, scale);
    assert_eq!(
        released.pan_offset,
        ctx.clamped_pan(pan, scale),
        "the release settles into the resting range"
    );
}

#[test]
fn a_pan_interrupting_a_settle_starts_exactly_where_the_photo_is() {
    let ctx = square_with_chrome();
    let held = CanvasZoomModel::default()
        .zoom_to_scale(1.0, &ctx)
        .hold_shown(1.0, Size::new(2500.0, 25.0), &ctx);
    assert_eq!(held.pan_offset, Size::new(2500.0, 25.0));
    let (still, _) = held.drag_changed(Size::ZERO, &ctx);
    assert_eq!(still.pan_offset, held.pan_offset);
    let (inward, _) = held.drag_changed(Size::new(-10.0, 0.0), &ctx);
    assert_eq!(inward.pan_offset.width, 2490.0, "moving it back in is 1:1");
    let (outward, _) = held.drag_changed(Size::new(10.0, 0.0), &ctx);
    assert_eq!(outward.pan_offset.width, 2500.0, "but never further out");
}
