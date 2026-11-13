//! A provisional extent resolving to the real one keeps the photo's rect on
//! screen (#5736). The repro: a cloud photo whose RAW has not downloaded,
//! shown from its seed thumbnail in a 1376×1032pt view at 2× under a 64pt
//! top bar, a 294pt sources column and a 153pt inspector.

use super::*;
use crate::canvas::{DoubleTapBehavior, Insets, Point, Size};

fn repro(image: (f64, f64)) -> CanvasZoomContext {
    CanvasZoomContext::new(Size::new(1376.0, 1032.0), Size::new(image.0, image.1), 2.0).with_insets(
        Insets {
            top: 64.0,
            left: 294.0,
            bottom: 0.0,
            right: 153.0,
        },
    )
}

/// The seed thumbnail's aspect at a nominal size.
fn provisional() -> CanvasZoomContext {
    repro((1500.0, 1000.0))
}

fn real() -> CanvasZoomContext {
    repro((6000.0, 4000.0))
}

fn unknown() -> CanvasZoomContext {
    repro((0.0, 0.0))
}

/// The photo's rect on screen: displayed size and centre offset. The insets
/// do not change, so equal pans are equal positions.
fn rect(model: CanvasZoomModel, context: &CanvasZoomContext) -> (Size, Size) {
    let size = context
        .display_frame_in_points(context.effective_scale(model.pixel_scale))
        .unwrap();
    (size, model.pan_offset)
}

fn assert_same_rect(actual: (Size, Size), expected: (Size, Size)) {
    let close = |a: f64, b: f64| (a - b).abs() <= 1e-6;
    assert!(
        close(actual.0.width, expected.0.width)
            && close(actual.0.height, expected.0.height)
            && close(actual.1.width, expected.1.width)
            && close(actual.1.height, expected.1.height),
        "expected {expected:?}, got {actual:?}"
    );
}

const FIRST: Point = Point { x: 900.0, y: 500.0 };
const SECOND: Point = Point { x: 950.0, y: 500.0 };
const LAST: Point = Point {
    x: 1000.0,
    y: 500.0,
};

#[test]
fn a_pinch_spanning_the_landing_does_not_jump() {
    let (seed, native) = (provisional(), real());
    let pinching = resting(&seed)
        .pinch_changed(1.0, FIRST, &seed)
        .pinch_changed(0.7, SECOND, &seed);

    let landed = pinching.image_extent_resolved(&seed, &native);
    assert_same_rect(
        rect(landed.pinch_changed(0.7, SECOND, &native), &native),
        rect(pinching, &seed),
    );
    assert_same_rect(
        rect(landed.pinch_changed(0.39, LAST, &native), &native),
        rect(pinching.pinch_changed(0.39, LAST, &seed), &seed),
    );

    let released = landed
        .pinch_changed(0.39, LAST, &native)
        .pinch_ended(0.39, &native);
    assert_eq!(released, CanvasZoomModel::default().reset_to_fit(&native));
}

#[test]
fn a_frame_freezing_host_pinching_across_the_landing_does_not_jump() {
    let (seed, native) = (provisional(), real());
    let captured = resting(&seed).pinch_changed(1.0, FIRST, &seed);
    let tracked = captured.pinch_tracked(0.7, SECOND);
    let landed = tracked.image_extent_resolved(&seed, &native);
    assert_same_rect(rect(landed, &native), rect(captured, &seed));
    assert_same_rect(
        rect(landed.pinch_changed(0.7, SECOND, &native), &native),
        rect(captured.pinch_changed(0.7, SECOND, &seed), &seed),
    );
}

#[test]
fn a_double_tap_on_the_seed_keeps_its_rect_when_the_size_lands() {
    let (seed, native) = (provisional(), real());
    let tapped = resting(&seed).double_tap(FIRST, DoubleTapBehavior::ToggleFitAnd100, &seed);
    assert!(tapped.is_zoomed_in());
    let landed = tapped.image_extent_resolved(&seed, &native);
    assert_same_rect(rect(landed, &native), rect(tapped, &seed));
    assert_eq!(landed.base_pan, landed.pan_offset);
}

#[test]
fn a_zoom_in_pinch_on_the_seed_keeps_its_rect_when_the_size_lands() {
    let (seed, native) = (provisional(), real());
    let zoomed = resting(&seed)
        .pinch_changed(1.0, FIRST, &seed)
        .pinch_changed(1.5, SECOND, &seed)
        .pinch_ended(1.5, &seed);
    assert!(zoomed.is_zoomed_in());
    let landed = zoomed.image_extent_resolved(&seed, &native);
    assert_same_rect(rect(landed, &native), rect(zoomed, &seed));
}

#[test]
fn fit_on_the_seed_stays_fit() {
    let landed = resting(&provisional()).image_extent_resolved(&provisional(), &real());
    assert_eq!(landed, CanvasZoomModel::default().reset_to_fit(&real()));
}

#[test]
fn a_drag_spanning_the_landing_moves_by_new_motion_only() {
    let (seed, native) = (provisional(), real());
    let dragging = resting(&seed)
        .zoom_to_scale(4.0, &seed)
        .drag_changed(Size::new(50.0, 0.0), &seed)
        .0;
    let landed = dragging.image_extent_resolved(&seed, &native);
    let next = landed.drag_changed(Size::new(51.0, 0.0), &native).0;
    assert!((next.pan_offset.width - (dragging.pan_offset.width + 1.0)).abs() <= 1e-9);
}

/// Without a provisional extent the zoom held a stand-in fit of 1: the real
/// size opens at fit and a release is measured from there, never committing
/// the stand-in scale as a real one.
#[test]
fn without_a_provisional_extent_the_landing_opens_at_fit() {
    let (none, native) = (unknown(), real());
    let pinching = CanvasZoomModel::default()
        .pinch_changed(1.0, FIRST, &none)
        .pinch_changed(0.7, SECOND, &none);
    let landed = pinching.geometry_changed(&none, &native);
    let released = landed
        .pinch_changed(0.39, LAST, &native)
        .pinch_ended(0.39, &native);
    assert_eq!(released, CanvasZoomModel::default().reset_to_fit(&native));

    let tapped =
        CanvasZoomModel::default().double_tap(FIRST, DoubleTapBehavior::ToggleFitAnd100, &none);
    assert_eq!(
        tapped.image_extent_resolved(&none, &native),
        CanvasZoomModel::default().reset_to_fit(&native)
    );
}

/// A crop is a different extent, not a resolution: 100% stays 1:1.
#[test]
fn a_crop_keeps_the_pixel_scale_and_the_pan() {
    let full = ctx_1x((4000.0, 2000.0));
    let cropped = ctx_1x((2000.0, 1000.0));
    let panned = CanvasZoomModel::default()
        .zoom_to_scale(1.0, &full)
        .wheel_pan(Size::new(200.0, 0.0), &full);
    let carried = panned.geometry_changed(&full, &cropped);
    assert_eq!(carried.pixel_scale, 1.0);
    assert!((carried.pan_offset.width - 200.0).abs() <= 1e-9);
}

fn ctx_1x(image: (f64, f64)) -> CanvasZoomContext {
    CanvasZoomContext::new(Size::new(1000.0, 800.0), Size::new(image.0, image.1), 1.0)
}

/// The seed at rest at fit, as a host shows it.
fn resting(context: &CanvasZoomContext) -> CanvasZoomModel {
    CanvasZoomModel::default().reset_to_fit(context)
}
