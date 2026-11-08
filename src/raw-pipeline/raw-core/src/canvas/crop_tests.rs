use super::*;
use crate::canvas::CanvasMath;

fn close(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() <= tolerance,
        "expected {expected}, got {actual}"
    );
}

fn crop(top: f64, left: f64, bottom: f64, right: f64) -> CropEdges {
    CropEdges {
        top,
        left,
        bottom,
        right,
        angle: 0.0,
    }
}

fn free(image: Size) -> CropResizeOptions {
    CropResizeOptions {
        aspect: None,
        image,
    }
}

#[test]
fn fit_footprint_centers_wide_viewport() {
    let footprint = fit_footprint(Size::new(1000.0, 400.0), Size::new(600.0, 400.0));
    assert_eq!(footprint, Rect::new(200.0, 0.0, 600.0, 400.0));
}

#[test]
fn fit_footprint_upscales_a_small_image_like_the_canvas_fit() {
    let wrap = Size::new(4000.0, 4000.0);
    let image = Size::new(600.0, 400.0);
    let footprint = fit_footprint(wrap, image);
    close(footprint.x, 0.0, 1e-9);
    close(footprint.y, 2000.0 / 3.0, 1e-9);
    close(footprint.width, 4000.0, 1e-9);
    close(footprint.height, 8000.0 / 3.0, 1e-9);
    let canvas_fit = CanvasMath::new(wrap, image, 0.0, Size::ZERO, 1.0)
        .display_frame_in_points()
        .unwrap();
    close(footprint.width, canvas_fit.width, 1e-9);
    close(footprint.height, canvas_fit.height, 1e-9);
}

#[test]
fn fit_footprint_reads_a_missing_image_as_one_pixel() {
    let footprint = fit_footprint(Size::new(100.0, 100.0), Size::ZERO);
    assert_eq!(footprint, Rect::new(0.0, 0.0, 100.0, 100.0));
}

#[test]
fn crop_rect_round_trips_through_the_footprint() {
    let footprint = fit_footprint(Size::new(1000.0, 400.0), Size::new(600.0, 400.0));
    let edges = crop(0.1, 0.25, 0.9, 0.75);
    let rect = crop_rect_in_view(edges, footprint);
    close(rect.x, footprint.x + 0.25 * footprint.width, 1e-9);
    close(rect.width, 0.5 * footprint.width, 1e-9);
    let top_left = view_point_to_normalized(Point::new(rect.x, rect.y), footprint);
    close(top_left.x, 0.25, 1e-9);
    close(top_left.y, 0.1, 1e-9);
}

#[test]
fn view_point_to_normalized_clamps_outside() {
    let footprint = fit_footprint(Size::new(1000.0, 400.0), Size::new(600.0, 400.0));
    let point = view_point_to_normalized(Point::new(-50.0, 99999.0), footprint);
    assert_eq!((point.x, point.y), (0.0, 1.0));
    let degenerate = view_point_to_normalized(Point::new(5.0, 5.0), Rect::ZERO);
    assert_eq!((degenerate.x, degenerate.y), (0.0, 0.0));
}

#[test]
fn hit_test_finds_corners() {
    let rect = Rect::new(100.0, 100.0, 200.0, 200.0);
    let hit = |x, y| hit_test_handle(Point::new(x, y), rect, 12.0);
    assert_eq!(hit(100.0, 100.0), Some(CropHandle::TopLeft));
    assert_eq!(hit(300.0, 100.0), Some(CropHandle::TopRight));
    assert_eq!(hit(100.0, 300.0), Some(CropHandle::BottomLeft));
    assert_eq!(hit(300.0, 300.0), Some(CropHandle::BottomRight));
}

#[test]
fn hit_test_finds_edges_and_interior() {
    let rect = Rect::new(100.0, 100.0, 200.0, 200.0);
    let hit = |x, y| hit_test_handle(Point::new(x, y), rect, 12.0);
    assert_eq!(hit(200.0, 100.0), Some(CropHandle::Top));
    assert_eq!(hit(200.0, 300.0), Some(CropHandle::Bottom));
    assert_eq!(hit(100.0, 200.0), Some(CropHandle::Left));
    assert_eq!(hit(300.0, 200.0), Some(CropHandle::Right));
    assert_eq!(hit(200.0, 200.0), Some(CropHandle::Move));
}

#[test]
fn hit_test_outside_returns_none() {
    let rect = Rect::new(100.0, 100.0, 200.0, 200.0);
    assert_eq!(hit_test_handle(Point::new(10.0, 10.0), rect, 12.0), None);
    assert_eq!(
        hit_test_handle(Point::new(f64::NAN, 150.0), rect, 12.0),
        None
    );
}

#[test]
fn resize_top_left_does_not_invert() {
    let out = resize_crop(
        CropEdges::default(),
        CropHandle::TopLeft,
        Point::new(0.3, 0.2),
        free(Size::new(600.0, 400.0)),
    );
    close(out.left, 0.3, 1e-9);
    close(out.top, 0.2, 1e-9);
    assert_eq!((out.right, out.bottom), (1.0, 1.0));
}

#[test]
fn resize_enforces_the_minimum_extent() {
    let out = resize_crop(
        CropEdges::default(),
        CropHandle::Right,
        Point::new(0.0, 0.5),
        free(Size::new(600.0, 400.0)),
    );
    close(out.right, MIN_CROP_FRACTION, 1e-9);
}

#[test]
fn resize_clamps_the_dragged_edge_to_the_image() {
    let out = resize_crop(
        crop(0.2, 0.2, 0.8, 0.8),
        CropHandle::BottomRight,
        Point::new(1.4, -3.0),
        free(Size::new(600.0, 400.0)),
    );
    assert_eq!(out.right, 1.0);
    close(out.bottom, 0.2 + MIN_CROP_FRACTION, 1e-9);
}

#[test]
fn resize_locks_square_aspect_on_corner() {
    let out = resize_crop(
        CropEdges::default(),
        CropHandle::BottomRight,
        Point::new(0.5, 0.9),
        CropResizeOptions {
            aspect: Some(1.0),
            image: Size::new(400.0, 400.0),
        },
    );
    close(
        (out.right - out.left) * 400.0,
        (out.bottom - out.top) * 400.0,
        1e-4,
    );
}

#[test]
fn resize_locks_aspect_on_edges_about_the_opposite_edge() {
    let image = Size::new(600.0, 400.0);
    let locked = CropResizeOptions {
        aspect: Some(1.5),
        image,
    };
    let start = crop(0.1, 0.1, 0.6, 0.6);
    let from_top = resize_crop(start, CropHandle::Top, Point::new(0.5, 0.2), locked);
    close(from_top.bottom, 0.6, 1e-9);
    close(from_top.left, 0.1, 1e-9);
    close(
        (from_top.right - from_top.left) * image.width
            / ((from_top.bottom - from_top.top) * image.height),
        1.5,
        1e-9,
    );
    let from_left = resize_crop(start, CropHandle::Left, Point::new(0.3, 0.5), locked);
    close(from_left.right, 0.6, 1e-9);
    close(from_left.top, 0.1, 1e-9);
    close(from_left.bottom - from_left.top, 0.3, 1e-9);
}

#[test]
fn resize_scales_an_aspect_push_back_inside_the_image() {
    let out = resize_crop(
        crop(0.5, 0.0, 0.6, 0.2),
        CropHandle::Right,
        Point::new(1.0, 0.5),
        CropResizeOptions {
            aspect: Some(1.0),
            image: Size::new(400.0, 400.0),
        },
    );
    close(out.top, 0.5, 1e-9);
    close(out.bottom, 1.0, 1e-9);
    close(out.right - out.left, out.bottom - out.top, 1e-9);
}

#[test]
fn resize_ignores_a_non_positive_aspect_and_a_non_finite_pointer() {
    let start = crop(0.1, 0.1, 0.9, 0.9);
    let options = CropResizeOptions {
        aspect: Some(0.0),
        image: Size::new(600.0, 400.0),
    };
    let out = resize_crop(start, CropHandle::Right, Point::new(0.5, 0.5), options);
    assert_eq!(out, crop(0.1, 0.1, 0.9, 0.5));
    assert_eq!(
        resize_crop(start, CropHandle::Right, Point::new(f64::NAN, 0.5), options),
        start
    );
}

#[test]
fn resize_keeps_the_straighten_angle() {
    let start = CropEdges {
        angle: 7.5,
        ..CropEdges::default()
    };
    let out = resize_crop(
        start,
        CropHandle::BottomRight,
        Point::new(0.5, 0.5),
        CropResizeOptions {
            aspect: Some(1.0),
            image: Size::new(600.0, 400.0),
        },
    );
    assert_eq!(out.angle, 7.5);
}

#[test]
fn move_crop_clamps_at_edge() {
    let moved = move_crop(crop(0.1, 0.1, 0.5, 0.5), Size::new(0.7, 0.0));
    close(moved.right, 1.0, 1e-9);
    close(moved.left, 0.6, 1e-9);
    close(moved.bottom - moved.top, 0.4, 1e-9);
    let start = crop(0.1, 0.1, 0.5, 0.5);
    assert_eq!(move_crop(start, Size::new(f64::INFINITY, 0.0)), start);
}

#[test]
fn centered_crop_panoramic_spans_full_width() {
    let edges = centered_crop_for_aspect(2.0, Size::new(600.0, 400.0), 0.0);
    assert_eq!((edges.left, edges.right), (0.0, 1.0));
    assert!(edges.top > 0.0);
    close(
        (edges.right - edges.left) * 600.0 / ((edges.bottom - edges.top) * 400.0),
        2.0,
        1e-9,
    );
}

#[test]
fn centered_crop_tall_spans_full_height() {
    let edges = centered_crop_for_aspect(0.5, Size::new(600.0, 400.0), 0.0);
    assert_eq!((edges.top, edges.bottom), (0.0, 1.0));
    close(
        (edges.right - edges.left) * 600.0 / ((edges.bottom - edges.top) * 400.0),
        0.5,
        1e-9,
    );
}

#[test]
fn centered_crop_preserves_angle_and_falls_back_to_the_full_frame() {
    assert_eq!(
        centered_crop_for_aspect(1.0, Size::new(600.0, 400.0), 7.5).angle,
        7.5
    );
    assert_eq!(
        centered_crop_for_aspect(0.0, Size::new(600.0, 400.0), 3.0),
        CropEdges::full_frame(3.0)
    );
    assert_eq!(
        centered_crop_for_aspect(f64::NAN, Size::new(600.0, 400.0), 0.0),
        CropEdges::default()
    );
    assert_eq!(
        centered_crop_for_aspect(1.0, Size::ZERO, 0.0),
        CropEdges::default()
    );
}

#[test]
fn resize_falls_back_to_free_when_the_lock_cannot_resolve() {
    let start = crop(0.1, 0.1, 0.9, 0.9);
    let target = Point::new(0.5, 0.6);
    let free_result = resize_crop(start, CropHandle::BottomRight, target, free(Size::ZERO));
    assert_eq!(free_result, crop(0.1, 0.1, 0.6, 0.5));
    for (aspect, image) in [
        (1.0, Size::ZERO),
        (1.0, Size::new(600.0, 0.0)),
        (1.0, Size::new(f64::INFINITY, 400.0)),
        (f64::INFINITY, Size::new(600.0, 400.0)),
        (f64::NAN, Size::new(600.0, 400.0)),
    ] {
        let options = CropResizeOptions {
            aspect: Some(aspect),
            image,
        };
        assert_eq!(
            resize_crop(start, CropHandle::BottomRight, target, options),
            free_result,
            "{aspect} {image:?}"
        );
    }
}
