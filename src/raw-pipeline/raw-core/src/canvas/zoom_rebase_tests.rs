use super::*;
use crate::canvas::{Point, Size};

/// 1000×800pt @2× over 6000×6000: fit 0.2667, fill 0.3333; the fill frame
/// overflows vertically only.
fn square() -> CanvasZoomContext {
    CanvasZoomContext::new(Size::new(1000.0, 800.0), Size::new(6000.0, 6000.0), 2.0)
}

fn assert_close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() <= 1e-9,
        "expected {expected}, got {actual}"
    );
}

fn assert_same_view(actual: CanvasZoomModel, expected: CanvasZoomModel, ctx: &CanvasZoomContext) {
    assert_close(
        ctx.effective_scale(actual.pixel_scale),
        ctx.effective_scale(expected.pixel_scale),
    );
    assert_close(actual.pan_offset.width, expected.pan_offset.width);
    assert_close(actual.pan_offset.height, expected.pan_offset.height);
}

const SHOWN_MAGNIFICATION: f64 = 1.6;
const SHOWN_AT: Point = Point { x: 320.0, y: 210.0 };
const LIFTED_AT: Point = Point { x: 420.0, y: 210.0 };

/// Zoomed to 100% and panned, with a pinch captured at (300, 200): the iOS
/// host's model mid-pinch, which sees no frame after the capture.
fn captured(ctx: &CanvasZoomContext) -> CanvasZoomModel {
    CanvasZoomModel::default()
        .zoom_to_scale(1.0, &CanvasZoomContext::default())
        .wheel_pan(Size::new(-120.0, 60.0), ctx)
        .pinch_changed(1.0, Point::new(300.0, 200.0), ctx)
}

/// The frame on screen: the pinch at `SHOWN_MAGNIFICATION` about `SHOWN_AT`.
fn shown(model: CanvasZoomModel, ctx: &CanvasZoomContext) -> CanvasZoomModel {
    model.pinch_changed(SHOWN_MAGNIFICATION, SHOWN_AT, ctx)
}

fn lift(model: CanvasZoomModel, magnification: f64, ctx: &CanvasZoomContext) -> CanvasZoomModel {
    model.pinch_rebased(SHOWN_MAGNIFICATION, SHOWN_AT, magnification, LIFTED_AT, ctx)
}

#[test]
fn a_lifted_finger_without_a_rebase_jumps_the_image() {
    let ctx = square();
    let model = captured(&ctx);
    let one_finger = model.pinch_changed(SHOWN_MAGNIFICATION, LIFTED_AT, &ctx);
    assert_close(
        one_finger.pan_offset.width - shown(model, &ctx).pan_offset.width,
        100.0,
    );
}

#[test]
fn rebasing_a_capture_only_pinch_keeps_the_shown_view() {
    let ctx = square();
    let model = captured(&ctx);
    let next =
        lift(model, SHOWN_MAGNIFICATION, &ctx).pinch_changed(SHOWN_MAGNIFICATION, LIFTED_AT, &ctx);
    assert_same_view(next, shown(model, &ctx), &ctx);
}

#[test]
fn rebasing_a_per_frame_pinch_keeps_the_shown_view() {
    let ctx = square();
    let model = shown(
        captured(&ctx).pinch_changed(1.3, Point::new(310.0, 205.0), &ctx),
        &ctx,
    );
    let next =
        lift(model, SHOWN_MAGNIFICATION, &ctx).pinch_changed(SHOWN_MAGNIFICATION, LIFTED_AT, &ctx);
    assert_same_view(next, model, &ctx);
}

#[test]
fn a_release_after_one_finger_lifts_commits_the_shown_view() {
    let ctx = square();
    let model = captured(&ctx);
    let released = lift(model, SHOWN_MAGNIFICATION, &ctx)
        .pinch_changed(SHOWN_MAGNIFICATION, LIFTED_AT, &ctx)
        .pinch_ended(SHOWN_MAGNIFICATION, &ctx);
    assert_same_view(released, shown(model, &ctx), &ctx);
    assert_eq!(released.base_pan, released.pan_offset);
    assert_eq!(released.pinch_start_scale, None);
}

#[test]
fn rebasing_absorbs_a_magnification_step_at_the_finger_change() {
    let ctx = square();
    let model = captured(&ctx);
    let rebased = lift(model, 1.45, &ctx);
    let next = rebased.pinch_changed(1.45, LIFTED_AT, &ctx);
    assert_same_view(next, shown(model, &ctx), &ctx);
    assert_same_view(next.pinch_ended(1.45, &ctx), shown(model, &ctx), &ctx);
}

#[test]
fn the_remaining_finger_pans_one_to_one_after_a_rebase() {
    let ctx = square();
    let model = captured(&ctx);
    let moved = lift(model, SHOWN_MAGNIFICATION, &ctx).pinch_changed(
        SHOWN_MAGNIFICATION,
        Point::new(400.0, 200.0),
        &ctx,
    );
    let before = shown(model, &ctx).pan_offset;
    assert_close(moved.pan_offset.width - before.width, -20.0);
    assert_close(moved.pan_offset.height - before.height, -10.0);
}

#[test]
fn later_magnification_scales_from_the_rebased_view() {
    let ctx = square();
    let model = captured(&ctx);
    let pinched = lift(model, SHOWN_MAGNIFICATION, &ctx).pinch_changed(
        SHOWN_MAGNIFICATION * 1.25,
        LIFTED_AT,
        &ctx,
    );
    assert_close(
        ctx.effective_scale(pinched.pixel_scale),
        ctx.effective_scale(shown(model, &ctx).pixel_scale) * 1.25,
    );
}

#[test]
fn a_finger_landing_again_rebases_without_a_jump() {
    let ctx = square();
    let model = captured(&ctx);
    let one_finger = lift(model, SHOWN_MAGNIFICATION, &ctx);
    let landed = Point::new(330.0, 215.0);
    let two_fingers = one_finger.pinch_rebased(SHOWN_MAGNIFICATION, LIFTED_AT, 1.0, landed, &ctx);
    assert_same_view(
        two_fingers.pinch_changed(1.0, landed, &ctx),
        shown(model, &ctx),
        &ctx,
    );
}

#[test]
fn a_pan_clamped_at_the_edge_stays_put_and_then_moves_from_the_edge() {
    let ctx = square();
    let at_edge = CanvasZoomModel::default()
        .zoom_to_scale(1.0, &CanvasZoomContext::default())
        .wheel_pan(Size::new(5000.0, 0.0), &ctx);
    let limit = ctx.max_pan_offset(1.0).width;
    assert_close(at_edge.pan_offset.width, limit);
    let model = at_edge.pinch_changed(1.0, Point::new(500.0, 400.0), &ctx);
    let shown_at = Point::new(700.0, 400.0);
    let shown = model.pinch_changed(1.0, shown_at, &ctx);
    assert_close(shown.pan_offset.width, limit);
    let lifted = Point::new(800.0, 400.0);
    let rebased = model.pinch_rebased(1.0, shown_at, 1.0, lifted, &ctx);
    assert_same_view(rebased.pinch_changed(1.0, lifted, &ctx), shown, &ctx);
    let back = rebased.pinch_changed(1.0, Point::new(780.0, 400.0), &ctx);
    assert_close(back.pan_offset.width, limit - 20.0);
}

#[test]
fn rebasing_a_pinch_held_on_the_floor_keeps_the_floor_then_springs_to_fit() {
    let ctx = square();
    let floor = ctx.min_scale();
    let centre = Point::new(500.0, 400.0);
    let model = CanvasZoomModel::default().pinch_changed(1.0, centre, &ctx);
    let shown = model.pinch_changed(0.1, centre, &ctx);
    assert_close(shown.pixel_scale, floor);
    let lifted = Point::new(600.0, 400.0);
    let next = model
        .pinch_rebased(0.1, centre, 0.1, lifted, &ctx)
        .pinch_changed(0.1, lifted, &ctx);
    assert_same_view(next, shown, &ctx);
    assert_eq!(next.pinch_ended(0.1, &ctx).pixel_scale, 0.0);
}

#[test]
fn rebasing_a_pinch_in_the_fit_band_releases_at_fit() {
    let ctx = square();
    let centre = Point::new(500.0, 400.0);
    let into_fit_band = ctx.fit_scale() / 0.5 * 1.02;
    let model = CanvasZoomModel::default()
        .zoom_to_scale(0.5, &CanvasZoomContext::default())
        .pinch_changed(1.0, centre, &ctx);
    assert_close(
        model.pinch_changed(into_fit_band, centre, &ctx).pixel_scale,
        ctx.fit_scale() * 1.02,
    );
    let lifted = Point::new(600.0, 400.0);
    let released = model
        .pinch_rebased(into_fit_band, centre, 1.0, lifted, &ctx)
        .pinch_changed(1.0, lifted, &ctx)
        .pinch_ended(1.0, &ctx);
    assert_eq!(released, CanvasZoomModel::default());
}

#[test]
fn the_rebase_keeps_the_frozen_frame_and_restarts_at_the_shown_scale() {
    let ctx = square();
    let model = captured(&ctx);
    let rebased = lift(model, 1.45, &ctx);
    assert_eq!(rebased.pixel_scale, model.pixel_scale);
    assert_eq!(rebased.pan_offset, model.pan_offset);
    assert_eq!(rebased.pinch_last_centroid, LIFTED_AT);
    assert_close(
        rebased.pinch_start_scale.unwrap_or(0.0),
        shown(model, &ctx).pixel_scale,
    );
    assert_close(rebased.pinch_start_magnification, 1.45);
}

#[test]
fn rebasing_outside_a_pinch_or_with_bad_input_changes_nothing() {
    let ctx = square();
    let idle = CanvasZoomModel::default().zoom_to_scale(1.0, &CanvasZoomContext::default());
    assert_eq!(
        idle.pinch_rebased(1.0, SHOWN_AT, 1.0, LIFTED_AT, &ctx),
        idle
    );
    let live = captured(&ctx);
    for (shown_magnification, magnification) in [
        (f64::NAN, 1.0),
        (1.0, 0.0),
        (-1.0, 1.0),
        (1.0, f64::INFINITY),
    ] {
        assert_eq!(
            live.pinch_rebased(
                shown_magnification,
                SHOWN_AT,
                magnification,
                LIFTED_AT,
                &ctx
            ),
            live
        );
    }
    let nan = Point::new(f64::NAN, 1.0);
    assert_eq!(live.pinch_rebased(1.6, nan, 1.6, LIFTED_AT, &ctx), live);
    assert_eq!(live.pinch_rebased(1.6, SHOWN_AT, 1.6, nan, &ctx), live);
}
