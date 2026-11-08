use super::*;

fn math(viewport: (f64, f64), native: (f64, f64), pixel_scale: f64) -> CanvasMath {
    math_with(viewport, native, pixel_scale, Size::ZERO, 1.0)
}

fn math_with(
    viewport: (f64, f64),
    native: (f64, f64),
    pixel_scale: f64,
    pan: Size,
    display_scale: f64,
) -> CanvasMath {
    CanvasMath::new(
        Size::new(viewport.0, viewport.1),
        Size::new(native.0, native.1),
        pixel_scale,
        pan,
        display_scale,
    )
}

fn assert_close(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() <= tolerance,
        "expected {expected}, got {actual}"
    );
}

#[test]
fn image_extent_is_none_until_native_is_known() {
    let canvas = math_with((1000.0, 800.0), (0.0, 0.0), 0.0, Size::ZERO, 2.0);
    assert_eq!(canvas.image_extent(), None);
    assert_eq!(canvas.display_frame_in_points(), None);
}

#[test]
fn image_extent_returns_native_once_seeded() {
    let canvas = math((1000.0, 800.0), (4000.0, 3000.0), 0.0);
    assert_eq!(canvas.image_extent(), Some(Size::new(4000.0, 3000.0)));
}

#[test]
fn fit_pixel_scale_is_bound_by_the_tighter_axis() {
    assert_close(
        math((1000.0, 800.0), (4000.0, 3000.0), 0.0).fit_pixel_scale(),
        0.25,
        1e-6,
    );
    assert_close(
        math((2000.0, 1200.0), (4000.0, 3000.0), 0.0).fit_pixel_scale(),
        0.40,
        1e-6,
    );
}

#[test]
fn fit_pixel_scale_is_one_when_degenerate() {
    assert_eq!(
        math((0.0, 0.0), (4000.0, 3000.0), 0.0).fit_pixel_scale(),
        1.0
    );
    assert_eq!(
        math((1000.0, 800.0), (0.0, 0.0), 0.0).fit_pixel_scale(),
        1.0
    );
}

#[test]
fn effective_pixel_scale_resolves_fit_mode() {
    assert_close(
        math((1000.0, 800.0), (4000.0, 3000.0), 0.0).effective_pixel_scale(),
        0.25,
        1e-6,
    );
    assert_close(
        math((1000.0, 800.0), (4000.0, 3000.0), 1.5).effective_pixel_scale(),
        1.5,
        1e-6,
    );
}

#[test]
fn display_frame_in_points_divides_by_display_scale() {
    let at_fit = math_with((1000.0, 800.0), (4000.0, 3000.0), 0.0, Size::ZERO, 2.0)
        .display_frame_in_points()
        .expect("native size is known");
    assert_close(at_fit.width, 500.0, 1e-6);
    assert_close(at_fit.height, 375.0, 1e-6);
    let at_100 = math_with((1000.0, 800.0), (4000.0, 3000.0), 1.0, Size::ZERO, 2.0)
        .display_frame_in_points()
        .expect("native size is known");
    assert_close(at_100.width, 2000.0, 1e-6);
    assert_close(at_100.height, 1500.0, 1e-6);
}

#[test]
fn fast_target_is_the_viewport() {
    assert_eq!(
        math((1000.0, 800.0), (4000.0, 3000.0), 0.0).fast_target_size(),
        Some(Size::new(1000.0, 800.0))
    );
    assert_eq!(
        math((0.0, 0.0), (4000.0, 3000.0), 0.0).fast_target_size(),
        None
    );
}

#[test]
fn refined_target_in_fit_mode_is_the_fast_target() {
    assert_eq!(
        math((1000.0, 800.0), (4000.0, 3000.0), 0.0).refined_target_size(),
        Some(Size::new(1000.0, 800.0))
    );
}

#[test]
fn refined_target_below_fit_stays_at_the_fast_target() {
    let fit = math((1000.0, 800.0), (4000.0, 3000.0), 0.0);
    let half_fit = math(
        (1000.0, 800.0),
        (4000.0, 3000.0),
        fit.fit_pixel_scale() * 0.5,
    );
    assert_eq!(half_fit.refined_target_size(), half_fit.fast_target_size());
    assert_eq!(half_fit.refined_target_size(), fit.refined_target_size());
}

#[test]
fn fill_scale_and_refined_target_at_fill() {
    let canvas = math((1000.0, 800.0), (3000.0, 3000.0), 0.0);
    assert_close(canvas.fill_pixel_scale(), 1000.0 / 3000.0, 1e-9);
    let target = math((1000.0, 800.0), (3000.0, 3000.0), canvas.fill_pixel_scale())
        .refined_target_size()
        .expect("viewport is set");
    assert_close(target.width, 1000.0, 1e-6);
    assert_close(target.height, 1000.0, 1e-6);
}

#[test]
fn fill_pixel_scale_is_one_when_degenerate() {
    assert_eq!(
        math((1000.0, 800.0), (0.0, 0.0), 0.0).fill_pixel_scale(),
        1.0
    );
}

#[test]
fn refined_target_at_100_is_native() {
    assert_eq!(
        math((2500.0, 2000.0), (4000.0, 3000.0), 1.0).refined_target_size(),
        Some(Size::new(4000.0, 3000.0))
    );
}

#[test]
fn refined_target_does_not_exceed_native_beyond_100() {
    assert_eq!(
        math((2500.0, 2000.0), (4000.0, 3000.0), 2.5).refined_target_size(),
        Some(Size::new(4000.0, 3000.0))
    );
}

#[test]
fn refined_target_caps_at_twice_the_viewport_long_edge() {
    assert_eq!(
        math((1000.0, 800.0), (4000.0, 3000.0), 1.0).refined_target_size(),
        Some(Size::new(2000.0, 2000.0))
    );
}

#[test]
fn refined_target_before_decode_scales_the_fast_target() {
    assert_eq!(
        math((1000.0, 800.0), (0.0, 0.0), 1.5).refined_target_size(),
        Some(Size::new(1500.0, 1200.0))
    );
}

#[test]
fn refined_target_clamps_to_the_max_texture_edge() {
    assert_eq!(
        math((9000.0, 2000.0), (20000.0, 3000.0), 1.0).refined_target_size(),
        Some(Size::new(MAX_TEXTURE_EDGE, 3000.0))
    );
    assert_eq!(
        math((9000.0, 9000.0), (0.0, 0.0), 3.0).refined_target_size(),
        Some(Size::new(MAX_TEXTURE_EDGE, MAX_TEXTURE_EDGE))
    );
}

#[test]
fn visible_source_rect_at_100_is_centred() {
    let rect = math((1000.0, 800.0), (4000.0, 3000.0), 1.0).visible_source_rect();
    assert_close(rect.x, 1500.0, 1e-6);
    assert_close(rect.y, 1100.0, 1e-6);
    assert_close(rect.width, 1000.0, 1e-6);
    assert_close(rect.height, 800.0, 1e-6);
}

#[test]
fn visible_source_rect_at_200_halves_the_extent() {
    let rect = math((1000.0, 800.0), (4000.0, 3000.0), 2.0).visible_source_rect();
    assert_close(rect.width, 500.0, 1e-6);
    assert_close(rect.height, 400.0, 1e-6);
}

#[test]
fn visible_source_rect_at_fit_covers_the_image() {
    let rect = math((1000.0, 800.0), (4000.0, 3000.0), 0.0).visible_source_rect();
    assert_close(rect.width, 4000.0, 1e-6);
    assert_close(rect.height, 3000.0, 1e-6);
}

#[test]
fn visible_source_rect_is_zero_without_an_image() {
    assert_eq!(
        math((1000.0, 800.0), (0.0, 0.0), 1.0).visible_source_rect(),
        Rect::ZERO
    );
}

#[test]
fn visible_source_rect_shifts_opposite_the_pan_and_clamps() {
    let right = math_with(
        (1000.0, 800.0),
        (4000.0, 3000.0),
        1.0,
        Size::new(100.0, 0.0),
        2.0,
    )
    .visible_source_rect();
    assert_close(right.x, 1300.0, 1e-9);
    let far = math_with(
        (1000.0, 800.0),
        (4000.0, 3000.0),
        1.0,
        Size::new(1e9, -1e9),
        2.0,
    )
    .visible_source_rect();
    assert_close(far.x, 0.0, 1e-9);
    assert_close(far.y, 2200.0, 1e-9);
}

#[test]
fn equal_inputs_compare_equal() {
    let pan = Size::new(10.0, 20.0);
    assert_eq!(
        math_with((1000.0, 800.0), (4000.0, 3000.0), 1.0, pan, 2.0),
        math_with((1000.0, 800.0), (4000.0, 3000.0), 1.0, pan, 2.0)
    );
}

#[test]
fn non_finite_inputs_degrade_instead_of_propagating() {
    let canvas = math_with(
        (f64::NAN, 800.0),
        (4000.0, f64::INFINITY),
        f64::NAN,
        Size::new(f64::NAN, f64::INFINITY),
        f64::NAN,
    );
    assert_eq!(canvas.image_extent(), None);
    assert_eq!(canvas.fit_pixel_scale(), 1.0);
    assert_eq!(canvas.fast_target_size(), None);
    assert_eq!(canvas.refined_target_size(), None);
    assert_eq!(canvas.display_frame_in_points(), None);
    assert_eq!(canvas.visible_source_rect(), Rect::ZERO);

    let negative = math((1000.0, 800.0), (-4000.0, 3000.0), -2.0);
    assert_eq!(negative.image_extent(), None);
    assert_eq!(negative.effective_pixel_scale(), 1.0);
}
