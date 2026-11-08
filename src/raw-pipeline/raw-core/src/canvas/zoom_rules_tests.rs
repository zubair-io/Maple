use super::*;

fn assert_close(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() <= tolerance,
        "expected {expected}, got {actual}"
    );
}

const SQUARE_FIT: f64 = 1600.0 / 6000.0;
const SQUARE_FILL: f64 = 2000.0 / 6000.0;

#[test]
fn fit_detent_band_is_two_sided() {
    let (fit, fill) = (0.25, 1.0);
    assert_eq!(detent(fit * 1.039, fit, fill), Some(ZoomStop::Fit));
    assert_eq!(detent(fit * 0.961, fit, fill), Some(ZoomStop::Fit));
    assert_eq!(detent(fit * 1.041, fit, fill), None);
    assert_eq!(detent(fit * 0.95, fit, fill), None);
}

#[test]
fn overlapping_bands_pick_the_nearer_stop_and_fit_wins_a_tie() {
    assert_eq!(detent(0.252, 0.25, 0.26), Some(ZoomStop::Fit));
    assert_eq!(detent(0.259, 0.25, 0.26), Some(ZoomStop::Fill));
    assert_eq!(detent(0.25, 0.25, 0.25), Some(ZoomStop::Fit));
}

#[test]
fn detent_ignores_non_positive_stops_and_nan() {
    assert_eq!(detent(0.0, 0.0, 0.0), None);
    assert_eq!(detent(f64::NAN, 0.25, 0.3), None);
}

#[test]
fn pinch_scale_follows_the_fingers_through_the_fit_and_fill_bands() {
    let (fit, fill, start) = (SQUARE_FIT, SQUARE_FILL, SQUARE_FIT);
    assert_close(pinch_scale(start, 1.03, fit), fit * 1.03, 1e-12);
    assert_close(pinch_scale(start, 0.97, fit), fit * 0.97, 1e-12);
    assert_close(
        pinch_scale(start, fill / fit * 0.97, fit),
        fill * 0.97,
        1e-12,
    );
    assert_close(pinch_scale(start, 1.12, fit), fit * 1.12, 1e-9);
    assert_close(pinch_scale(start, 0.8, fit), fit * 0.8, 1e-9);
}

#[test]
fn pinch_scale_clamps_to_the_floor_and_the_cap() {
    assert_eq!(pinch_scale(0.25, 1000.0, 0.25), MAX_PIXEL_SCALE);
    assert_close(pinch_scale(0.25, 0.01, 0.25), 0.125, 1e-12);
    assert_eq!(pinch_scale(0.25, f64::NAN, 0.25), 0.25);
}

#[test]
fn crosses_fit_only_from_the_far_side() {
    assert!(crosses_fit(0.3, 0.2, 0.25));
    assert!(crosses_fit(0.2, 0.25, 0.25));
    assert!(!crosses_fit(0.25, 0.2, 0.25));
    assert!(!crosses_fit(0.25, 0.3, 0.25));
    assert!(!crosses_fit(0.3, 0.4, 0.25));
    assert!(crosses_fit(0.2, 0.241, 0.25));
    assert!(crosses_fit(0.26, 0.258, 0.25));
    assert!(
        !crosses_fit(0.2525, 0.255, 0.25),
        "a small step away from fit is never pulled back to it"
    );
}

#[test]
fn explicit_zoom_is_clamped() {
    assert_eq!(clamped_explicit_zoom(9.0), MAX_PIXEL_SCALE);
    assert_eq!(clamped_explicit_zoom(0.001), MIN_EXPLICIT_ZOOM);
    assert_eq!(clamped_explicit_zoom(f64::NAN), MIN_EXPLICIT_ZOOM);
    assert_eq!(clamped_explicit_zoom(2.0), 2.0);
}

#[test]
fn zoom_in_target_steps_and_caps() {
    assert_close(zoom_in_target(0.25), 0.3125, 1e-12);
    assert_eq!(zoom_in_target(7.0), MAX_PIXEL_SCALE);
}

#[test]
fn zoom_out_target_floors_at_half_fit() {
    assert_eq!(zoom_out_target(8.0, 0.25), ZoomOutResult::Scale(8.0 / 1.25));
    assert_eq!(zoom_out_target(0.3, 0.25), ZoomOutResult::SnapToFit);
    assert_eq!(
        zoom_out_target(0.25, 0.25),
        ZoomOutResult::Scale(0.2),
        "from fit a step continues below fit"
    );
    assert_eq!(
        zoom_out_target(0.13, 0.25),
        ZoomOutResult::Scale(0.125),
        "the floor is half of fit"
    );
    assert_eq!(zoom_out_target(0.255, 0.25), ZoomOutResult::SnapToFit);
}

#[test]
fn distinct_stops_drop_coinciding_levels() {
    assert_eq!(
        distinct_stops(0.25, 0.4, Some(1.0)).as_slice(),
        [ZoomStop::Fit, ZoomStop::Fill, ZoomStop::ActualSize]
    );
    assert_eq!(
        distinct_stops(1.0, 1.5, Some(1.0)).as_slice(),
        [ZoomStop::Fit, ZoomStop::Fill],
        "a small image that fits at 100% has no separate 100% stop"
    );
    assert_eq!(
        distinct_stops(0.5, 1.01, Some(1.0)).as_slice(),
        [ZoomStop::Fit, ZoomStop::Fill],
        "100% coinciding with fill is the fill stop"
    );
    assert_eq!(
        distinct_stops(1.0, 1.4, None).as_slice(),
        [ZoomStop::Fit, ZoomStop::Fill]
    );
}

#[test]
fn next_stop_wraps_and_falls_back_to_fit() {
    let stops = [ZoomStop::Fit, ZoomStop::Fill, ZoomStop::ActualSize];
    assert_eq!(next_stop(Some(ZoomStop::Fit), &stops), ZoomStop::Fill);
    assert_eq!(next_stop(Some(ZoomStop::ActualSize), &stops), ZoomStop::Fit);
    assert_eq!(next_stop(None, &stops), ZoomStop::Fit);
    assert_eq!(
        next_stop(Some(ZoomStop::Fill), &[ZoomStop::Fit]),
        ZoomStop::Fit
    );
    assert_eq!(next_stop(Some(ZoomStop::Fit), &[]), ZoomStop::Fit);
}

#[test]
fn zoom_stops_from_slice_keeps_at_most_three() {
    let stops = ZoomStops::from_slice(&[
        ZoomStop::Fit,
        ZoomStop::Fill,
        ZoomStop::ActualSize,
        ZoomStop::Fit,
    ]);
    assert_eq!(stops.as_slice().len(), 3);
    assert!(ZoomStops::from_slice(&[]).as_slice().is_empty());
    assert!(!ZoomStops::from_slice(&[ZoomStop::Fit]).contains(ZoomStop::Fill));
}

#[test]
fn anchored_pan_keeps_the_image_point_under_the_anchor() {
    let viewport = Size::new(1000.0, 800.0);
    let pan = anchored_pan(Point::new(250.0, 200.0), viewport, Size::ZERO, 0.25, 1.0);
    assert_close(pan.width, 750.0, 1e-9);
    assert_close(pan.height, 600.0, 1e-9);
    let display_scale = 2.0;
    let image_x = (250.0 - 500.0) * display_scale / 0.25;
    assert_close(500.0 + pan.width + image_x / display_scale, 250.0, 1e-9);
}

#[test]
fn anchored_pan_at_the_viewport_centre_scales_the_existing_pan() {
    let pan = anchored_pan(
        Point::new(500.0, 400.0),
        Size::new(1000.0, 800.0),
        Size::new(100.0, -50.0),
        1.0,
        2.0,
    );
    assert_close(pan.width, 200.0, 1e-9);
    assert_close(pan.height, -100.0, 1e-9);
}

#[test]
fn live_pinch_pan_pure_scale_anchors_at_the_centroid() {
    let centroid = Point::new(50.0, 50.0);
    let pan = live_pinch_pan(
        centroid,
        centroid,
        Size::ZERO,
        1.0,
        2.0,
        Size::new(200.0, 200.0),
    );
    assert_close(pan.width, 50.0, 0.001);
    assert_close(pan.height, 50.0, 0.001);
}

#[test]
fn live_pinch_pan_pure_centroid_drift_pans_by_the_delta() {
    let pan = live_pinch_pan(
        Point::new(130.0, 80.0),
        Point::new(100.0, 100.0),
        Size::new(10.0, 10.0),
        2.0,
        2.0,
        Size::new(200.0, 200.0),
    );
    assert_close(pan.width, 40.0, 0.001);
    assert_close(pan.height, -10.0, 0.001);
}

#[test]
fn pan_derivations_return_the_start_pan_for_a_degenerate_start_scale() {
    let start = Size::new(3.0, 4.0);
    let viewport = Size::new(100.0, 100.0);
    assert_eq!(anchored_pan(Point::ZERO, viewport, start, 0.0, 1.0), start);
    assert_eq!(
        live_pinch_pan(Point::ZERO, Point::ZERO, start, f64::NAN, 1.0, viewport),
        start
    );
}
