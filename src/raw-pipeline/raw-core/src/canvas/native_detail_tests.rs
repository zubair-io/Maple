use super::*;

fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect::new(x, y, width, height)
}

fn size(width: f64, height: f64) -> Size {
    Size::new(width, height)
}

fn offset(r: Rect, dx: f64, dy: f64) -> Rect {
    Rect::new(r.x + dx, r.y + dy, r.width, r.height)
}

#[test]
fn native_detail_starts_at_one_to_one_only() {
    let visible = rect(100.0, 200.0, 1200.0, 800.0);
    assert!(!native_detail_should_render(0.999, visible, Size::ZERO));
    assert!(native_detail_should_render(1.0, visible, Size::ZERO));
    assert!(native_detail_should_render(2.0, visible, Size::ZERO));
    assert!(!native_detail_should_render(1.0, Rect::ZERO, Size::ZERO));
}

#[test]
fn native_detail_skips_when_visible_rect_covers_entire_image() {
    let image = size(64.0, 64.0);
    assert!(!native_detail_should_render(
        20.0,
        rect(0.0, 0.0, 64.0, 64.0),
        image
    ));
    assert!(native_detail_should_render(
        20.0,
        rect(10.0, 10.0, 30.0, 30.0),
        image
    ));
}

#[test]
fn should_render_rejects_non_finite_input() {
    let visible = rect(0.0, 0.0, 100.0, 100.0);
    assert!(!native_detail_should_render(f64::NAN, visible, Size::ZERO));
    assert!(!native_detail_should_render(
        1.0,
        rect(f64::NAN, 0.0, 10.0, 10.0),
        Size::ZERO
    ));
    assert!(native_detail_should_render(
        1.0,
        rect(100.0, 100.0, -50.0, -50.0),
        Size::ZERO
    ));
}

#[test]
fn detail_rect_rounds_outward_and_clamps_to_sensor() {
    let detail = detail_rect(rect(-0.4, 50.2, 1000.8, 799.3), size(13000.0, 8000.0));
    assert_eq!(detail, rect(0.0, 50.0, 1001.0, 800.0));
}

#[test]
fn detail_rect_is_zero_for_unknown_image_or_disjoint_region() {
    assert_eq!(
        detail_rect(rect(0.0, 0.0, 10.0, 10.0), Size::ZERO),
        Rect::ZERO
    );
    assert_eq!(
        detail_rect(rect(5000.0, 0.0, 10.0, 10.0), size(4000.0, 3000.0)),
        Rect::ZERO
    );
    assert_eq!(
        detail_rect(rect(0.0, 0.0, 10.0, 10.0), size(f64::INFINITY, 10.0)),
        Rect::ZERO
    );
}

#[test]
fn decode_rect_adds_only_bounded_halo_on_hundred_megapixel_source() {
    let decoded = decode_rect(
        rect(6000.0, 3500.0, 1200.0, 900.0),
        size(13000.0, 8000.0),
        NATIVE_DETAIL_FILTER_HALO,
    );
    assert_eq!(decoded, rect(5904.0, 3404.0, 1392.0, 1092.0));
    assert!(decoded.width * decoded.height < 1_600_000.0);
}

#[test]
fn decode_rect_rejects_patches_whose_halo_exceeds_max_texture_edge() {
    let detail = rect(0.0, 0.0, 16300.0, 9000.0);
    for halo in [NATIVE_DETAIL_FILTER_HALO, 552.0] {
        assert_eq!(
            decode_rect(detail, size(20000.0, 12000.0), halo),
            Rect::ZERO
        );
    }
}

#[test]
fn decode_rect_preserves_both_sides_when_the_required_halo_fits() {
    assert_eq!(
        decode_rect(
            rect(600.0, 600.0, 15000.0, 9000.0),
            size(20000.0, 12000.0),
            552.0
        ),
        rect(48.0, 48.0, 16104.0, 10104.0)
    );
}

#[test]
fn decode_rect_clamps_halo_at_image_edges() {
    assert_eq!(
        decode_rect(
            rect(0.0, 0.0, 1000.0, 800.0),
            size(4000.0, 3000.0),
            NATIVE_DETAIL_FILTER_HALO
        ),
        rect(0.0, 0.0, 1096.0, 896.0)
    );
}

#[test]
fn decode_rect_halo_never_drops_below_the_floor() {
    let detail = rect(1000.0, 1000.0, 100.0, 100.0);
    let image = size(4000.0, 3000.0);
    let floor = rect(904.0, 904.0, 292.0, 292.0);
    assert_eq!(decode_rect(detail, image, 0.0), floor);
    assert_eq!(decode_rect(detail, image, -500.0), floor);
    assert_eq!(decode_rect(detail, image, f64::NAN), floor);
    assert_eq!(decode_rect(detail, image, f64::INFINITY), Rect::ZERO);
    assert_eq!(decode_rect(Rect::ZERO, image, 96.0), Rect::ZERO);
}

#[test]
fn bottom_up_rect_flips_top_down_source_y() {
    assert_eq!(
        detail_rect_in_decode_bottom_up(
            rect(1000.0, 2000.0, 800.0, 600.0),
            rect(900.0, 1800.0, 1200.0, 1000.0)
        ),
        rect(100.0, 200.0, 800.0, 600.0)
    );
    assert_eq!(
        detail_rect_in_decode_bottom_up(Rect::ZERO, rect(0.0, 0.0, 10.0, 10.0)),
        Rect::ZERO
    );
}

#[test]
fn pan_margin_is_quarter_of_larger_dimension_when_unclamped() {
    assert_eq!(pan_margin(rect(0.0, 0.0, 1600.0, 1000.0)), 400.0);
}

#[test]
fn pan_margin_clamps_to_ceiling_on_large_viewport() {
    assert_eq!(pan_margin(rect(0.0, 0.0, 4000.0, 2600.0)), 512.0);
}

#[test]
fn pan_margin_is_zero_for_empty_or_non_finite_rect() {
    assert_eq!(pan_margin(Rect::ZERO), 0.0);
    assert_eq!(pan_margin(rect(f64::INFINITY, 0.0, 10.0, 10.0)), 0.0);
}

#[test]
fn patch_rect_grows_detail_rect_by_half_margin_per_edge() {
    let visible = rect(2000.0, 2000.0, 1600.0, 1000.0);
    let image = size(13000.0, 8000.0);
    let base = detail_rect(visible, image);
    assert_eq!(patch_rect(visible, image), base.inset(-200.0, -200.0));
}

#[test]
fn patch_rect_area_growth_on_square_viewport_matches_quoted_multiplier() {
    let visible = rect(2000.0, 2000.0, 1200.0, 1200.0);
    let image = size(13000.0, 8000.0);
    let base = detail_rect(visible, image);
    let patch = patch_rect(visible, image);
    let ratio = (patch.width * patch.height) / (base.width * base.height);
    assert!((ratio - 1.5625).abs() < 0.001, "ratio {ratio}");
}

#[test]
fn patch_rect_clamps_to_image_origin_at_top_left_edge() {
    let patch = patch_rect(rect(0.0, 0.0, 1000.0, 800.0), size(4000.0, 3000.0));
    assert_eq!(patch, rect(0.0, 0.0, 1125.0, 925.0));
}

#[test]
fn patch_rect_clamps_at_bottom_right_edge() {
    let patch = patch_rect(rect(3200.0, 2400.0, 800.0, 600.0), size(4000.0, 3000.0));
    assert_eq!(patch.max_x(), 4000.0);
    assert_eq!(patch.max_y(), 3000.0);
}

#[test]
fn patch_rect_is_empty_for_empty_visible_rect() {
    assert!(patch_rect(Rect::ZERO, size(4000.0, 3000.0)).is_empty());
}

#[test]
fn patch_rect_always_contains_unmargined_detail_rect() {
    let image = size(13000.0, 8000.0);
    let visible = rect(5000.0, 3000.0, 1800.0, 1200.0);
    assert!(patch_rect(visible, image).contains_rect(detail_rect(visible, image)));
}

#[test]
fn small_pan_detail_rect_is_contained_in_published_patch() {
    let image = size(13000.0, 8000.0);
    let first = rect(2000.0, 2000.0, 1600.0, 1000.0);
    let published = patch_rect(first, image);
    let panned = detail_rect(offset(first, 30.0, 20.0), image);
    assert!(published_patch_covers(Some(published), panned));
}

#[test]
fn large_pan_detail_rect_escapes_published_patch() {
    let image = size(13000.0, 8000.0);
    let first = rect(2000.0, 2000.0, 1600.0, 1000.0);
    let published = patch_rect(first, image);
    let panned = detail_rect(offset(first, 900.0, 0.0), image);
    assert!(!published_patch_covers(Some(published), panned));
    assert!(!published_patch_covers(None, panned));
    assert!(!published_patch_covers(Some(published), Rect::ZERO));
}

fn update(viewport: Rect, zoom: f64, published: Option<Rect>) -> VisibleRegionUpdate {
    VisibleRegionUpdate {
        previous_viewport: rect(2000.0, 2000.0, 1600.0, 1000.0),
        viewport,
        previous_zoom: 1.0,
        zoom,
        published_patch: published,
        image_size: size(13000.0, 8000.0),
    }
}

#[test]
fn small_pan_inside_published_patch_keeps_it_and_schedules_nothing() {
    let first = rect(2000.0, 2000.0, 1600.0, 1000.0);
    let published = patch_rect(first, size(13000.0, 8000.0));
    let change = visible_region_change(update(offset(first, 30.0, 20.0), 1.0, Some(published)));
    assert_eq!(change, VisibleRegionChange::default());
}

#[test]
fn pan_beyond_published_patch_clears_and_schedules_refine() {
    let first = rect(2000.0, 2000.0, 1600.0, 1000.0);
    let published = patch_rect(first, size(13000.0, 8000.0));
    let change = visible_region_change(update(offset(first, 900.0, 0.0), 1.0, Some(published)));
    assert_eq!(
        change,
        VisibleRegionChange {
            zoom_changed: false,
            clears_patch: true,
            schedules_refine: true,
        }
    );
}

#[test]
fn pan_without_a_published_patch_schedules_refine() {
    let first = rect(2000.0, 2000.0, 1600.0, 1000.0);
    let change = visible_region_change(update(offset(first, 30.0, 0.0), 1.0, None));
    assert!(change.clears_patch && change.schedules_refine);
}

#[test]
fn zoom_change_clears_patch_but_leaves_the_refine_to_the_zoom() {
    let first = rect(2000.0, 2000.0, 1600.0, 1000.0);
    let published = patch_rect(first, size(13000.0, 8000.0));
    let change = visible_region_change(update(
        rect(2200.0, 2100.0, 800.0, 500.0),
        2.0,
        Some(published),
    ));
    assert_eq!(
        change,
        VisibleRegionChange {
            zoom_changed: true,
            clears_patch: true,
            schedules_refine: false,
        }
    );
}

#[test]
fn sub_epsilon_zoom_jitter_with_an_unchanged_rect_does_nothing() {
    let first = rect(2000.0, 2000.0, 1600.0, 1000.0);
    assert_eq!(
        visible_region_change(update(first, 1.005, None)),
        VisibleRegionChange::default()
    );
    assert!(visible_region_change(update(first, 1.02, None)).zoom_changed);
}

#[test]
fn rect_helpers_follow_core_graphics_semantics() {
    assert_eq!(
        rect(10.0, 10.0, -4.0, -6.0).standardized(),
        rect(6.0, 4.0, 4.0, 6.0)
    );
    assert_eq!(
        rect(0.5, 1.5, 2.0, 2.0).integral(),
        rect(0.0, 1.0, 3.0, 3.0)
    );
    assert_eq!(
        rect(0.0, 0.0, 10.0, 10.0).intersection(rect(20.0, 0.0, 5.0, 5.0)),
        None
    );
    assert!(rect(0.0, 0.0, 10.0, 10.0)
        .intersection(rect(10.0, 0.0, 5.0, 5.0))
        .is_some_and(Rect::is_empty));
    assert!(rect(0.0, 0.0, 10.0, 10.0).contains_rect(rect(0.0, 0.0, 10.0, 10.0)));
    assert!(!rect(0.0, 0.0, 10.0, 10.0).contains_rect(rect(-1.0, 0.0, 10.0, 10.0)));
}
