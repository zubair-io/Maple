use super::*;

fn input(crop: CropEdges, active: Option<CropHandle>) -> CropOverlayInput {
    CropOverlayInput {
        crop,
        viewport: Size::new(400.0, 300.0),
        image: Size::new(6000.0, 4000.0),
        pixel_scale: 2.0,
        active,
    }
}

fn inset_crop() -> CropEdges {
    CropEdges {
        top: 0.1,
        left: 0.2,
        bottom: 0.83,
        right: 0.71,
        angle: 3.0,
    }
}

fn reference_bytes(overlay: &CanvasOverlay, width: u32, height: u32) -> Vec<u8> {
    (0..height)
        .flat_map(|y| (0..width).map(move |x| (x, y)))
        .flat_map(|(x, y)| overlay_pixel(overlay, x, y).map(unorm8))
        .collect()
}

#[test]
fn crop_overlay_has_mask_frame_grid_and_corner_dots() {
    let overlay = crop_overlay(input(inset_crop(), None));
    let kinds: Vec<u32> = overlay.active().iter().map(|p| p.kind).collect();
    let expected: Vec<u32> = [OVERLAY_KIND_FILL_OUTSIDE]
        .into_iter()
        .chain([OVERLAY_KIND_FILL; 8])
        .chain([OVERLAY_KIND_DISC; 4])
        .collect();
    assert_eq!(kinds, expected);
}

#[test]
fn mask_is_bounded_to_the_footprint_in_surface_pixels() {
    let overlay = crop_overlay(input(CropEdges::default(), None));
    let mask = overlay.active()[0];
    // 6000×4000 into 400×300 points fits at 400×266.67, centred, ×2 px/pt.
    let expected_height = 4000.0 * (400.0 / 6000.0) * 2.0;
    let margin = CROP_OVERLAY_OVERSCAN * 2.0;
    let expected_top = margin + (600.0 - expected_height) / 2.0;
    assert_eq!(f64::from(mask.clip[0]), margin);
    assert_eq!(f64::from(mask.clip[2]), margin + 800.0);
    assert!((mask.clip[1] - expected_top as f32).abs() < 1e-3);
    assert!((mask.clip[3] - (expected_top + expected_height) as f32).abs() < 1e-3);
    assert_eq!(mask.rect, mask.clip, "a full-frame crop dims nothing");
}

#[test]
fn corner_dots_are_twelve_points_wide_at_the_crop_corners() {
    let overlay = crop_overlay(input(inset_crop(), None));
    let dots: Vec<_> = overlay.active()[9..13].to_vec();
    let mask = overlay.active()[0];
    let corners = [
        (mask.rect[0], mask.rect[1]),
        (mask.rect[2], mask.rect[1]),
        (mask.rect[0], mask.rect[3]),
        (mask.rect[2], mask.rect[3]),
    ];
    for (dot, (x, y)) in dots.iter().zip(corners) {
        assert_eq!((dot.rect[0], dot.rect[1]), (x, y));
        assert_eq!(dot.rect[2], 12.0, "6 pt radius at 2 px/pt");
        assert_eq!(dot.color, [1.0; 4]);
    }
}

#[test]
fn dragged_corner_emphasises_its_two_edges_only() {
    let idle = crop_overlay(input(inset_crop(), None));
    let dragged = crop_overlay(input(inset_crop(), Some(CropHandle::TopLeft)));
    let height = |p: &OverlayPrimitive| p.rect[3] - p.rect[1];
    let width = |p: &OverlayPrimitive| p.rect[2] - p.rect[0];
    let (top, bottom, left, right) = (1, 2, 3, 4);
    assert_eq!(height(&idle.active()[top]), 2.0);
    assert_eq!(height(&dragged.active()[top]), 4.0);
    assert_eq!(width(&dragged.active()[left]), 4.0);
    assert_eq!(dragged.active()[top].color, [1.0; 4]);
    assert_eq!(dragged.active()[bottom], idle.active()[bottom]);
    assert_eq!(
        width(&dragged.active()[right]),
        width(&idle.active()[right])
    );
}

#[test]
fn move_handle_emphasises_nothing() {
    assert_eq!(
        crop_overlay(input(inset_crop(), Some(CropHandle::Move))),
        crop_overlay(input(inset_crop(), None))
    );
}

#[test]
fn degenerate_pixel_scale_reads_as_one() {
    let base = CropOverlayInput {
        pixel_scale: 1.0,
        ..input(inset_crop(), None)
    };
    for scale in [0.0, -2.0, f64::NAN, f64::INFINITY] {
        let overlay = crop_overlay(CropOverlayInput {
            pixel_scale: scale,
            ..base
        });
        assert_eq!(overlay, crop_overlay(base));
    }
}

#[test]
fn handle_centers_sit_on_the_crop_rect_in_points() {
    let centers = crop_handle_centers(input(inset_crop(), None));
    let rect = crop_rect_in_view(
        inset_crop(),
        fit_footprint(Size::new(400.0, 300.0), Size::new(6000.0, 4000.0)),
    );
    assert_eq!(
        centers[0],
        (CropHandle::TopLeft, Point::new(rect.x, rect.y))
    );
    assert_eq!(
        centers[3],
        (
            CropHandle::BottomRight,
            Point::new(rect.max_x(), rect.max_y())
        )
    );
    assert_eq!(
        centers[6],
        (
            CropHandle::Left,
            Point::new(rect.x, (rect.y + rect.max_y()) / 2.0)
        )
    );
}

#[test]
fn rasterizer_matches_the_per_pixel_reference_exactly() {
    for active in [None, Some(CropHandle::BottomRight), Some(CropHandle::Left)] {
        let overlay = crop_overlay(input(inset_crop(), active));
        let (width, height) = (800, 600);
        let mut out = vec![0_u8; width as usize * height as usize * 4];
        rasterize_overlay(&overlay, width, height, width as usize * 4, &mut out).unwrap();
        assert!(out == reference_bytes(&overlay, width, height));
    }
}

#[test]
fn rasterizer_matches_the_reference_at_fractional_scale_and_odd_viewport() {
    let overlay = crop_overlay(CropOverlayInput {
        viewport: Size::new(257.0, 311.0),
        pixel_scale: 1.5,
        ..input(inset_crop(), Some(CropHandle::TopLeft))
    });
    let (width, height) = (386, 467);
    let mut out = vec![0_u8; width as usize * height as usize * 4];
    rasterize_overlay(&overlay, width, height, width as usize * 4, &mut out).unwrap();
    assert!(out == reference_bytes(&overlay, width, height));
}

#[test]
fn rasterizer_respects_stride_and_leaves_padding_untouched() {
    let overlay = crop_overlay(input(inset_crop(), None));
    let (width, height, stride) = (800_u32, 600_u32, 3216_usize);
    let mut out = vec![7_u8; stride * height as usize];
    rasterize_overlay(&overlay, width, height, stride, &mut out).unwrap();
    let reference = reference_bytes(&overlay, width, height);
    for y in 0..height as usize {
        let row = &out[y * stride..(y + 1) * stride];
        assert_eq!(&row[..3200], &reference[y * 3200..(y + 1) * 3200]);
        assert!(row[3200..].iter().all(|&b| b == 7));
    }
}

#[test]
fn rasterizer_rejects_short_buffers() {
    let overlay = crop_overlay(input(inset_crop(), None));
    let mut small = vec![0_u8; 10];
    assert_eq!(
        rasterize_overlay(&overlay, 4, 4, 15, &mut small),
        Err(RasterizeError::StrideTooSmall)
    );
    assert_eq!(
        rasterize_overlay(&overlay, 4, 4, 16, &mut small),
        Err(RasterizeError::BufferTooSmall)
    );
}

#[test]
fn pixels_read_as_dim_frame_and_clear() {
    let overlay = crop_overlay(input(inset_crop(), None));
    let mask = overlay.active()[0];
    let outside_crop = overlay_pixel(
        &overlay,
        (mask.clip[0] + 2.0) as u32,
        (mask.clip[1] + 4.0) as u32,
    );
    assert_eq!(outside_crop.map(unorm8), [0, 0, 0, unorm8(CROP_MASK_ALPHA)]);
    let inside = overlay_pixel(
        &overlay,
        (mask.rect[0] + 20.0) as u32,
        (mask.rect[1] + 20.0) as u32,
    );
    assert_eq!(inside, [0.0; 4]);
    let letterbox = overlay_pixel(&overlay, 400, 0);
    assert_eq!(letterbox, [0.0; 4], "letterbox bars are canvas, not photo");
}

#[test]
fn full_overlay_drops_extra_primitives() {
    let full = (0..OVERLAY_CAPACITY + 3).fold(CanvasOverlay::EMPTY, |acc, i| {
        acc.with(fill([i as f32, 0.0, i as f32 + 1.0, 1.0], [1.0; 4]))
    });
    assert_eq!(full.count, OVERLAY_CAPACITY);
    assert_eq!(full.active().last().unwrap().rect[0], 15.0);
}

#[test]
fn non_finite_geometry_rasterizes_without_panicking() {
    let overlay = crop_overlay(CropOverlayInput {
        viewport: Size::new(f64::NAN, 300.0),
        ..input(inset_crop(), None)
    });
    let mut out = vec![0_u8; 64 * 64 * 4];
    rasterize_overlay(&overlay, 64, 64, 256, &mut out).unwrap();
    assert!(out == reference_bytes(&overlay, 64, 64));
}

#[test]
fn full_frame_fit_draws_every_dot_and_stroke_inside_the_surface() {
    let scale = 2.0;
    let overlay = crop_overlay(input(CropEdges::default(), None));
    let width = ((400.0 + 2.0 * CROP_OVERLAY_OVERSCAN) * scale).round() as u32;
    let height = ((300.0 + 2.0 * CROP_OVERLAY_OVERSCAN) * scale).round() as u32;
    let margin = (CROP_OVERLAY_OVERSCAN * scale) as f32;
    let dots: Vec<_> = overlay
        .active()
        .iter()
        .filter(|p| p.kind == OVERLAY_KIND_DISC)
        .collect();
    assert_eq!(dots.len(), 4);
    assert!(
        dots.iter()
            .all(|d| d.rect[0] == margin || d.rect[0] == width as f32 - margin),
        "the fitted image fills the viewport's width, so the dots sit on its edges"
    );
    for dot in &dots {
        let reach = dot.rect[2] + 0.5;
        assert!(dot.rect[0] - reach >= 0.0 && dot.rect[0] + reach <= width as f32);
        assert!(dot.rect[1] - reach >= 0.0 && dot.rect[1] + reach <= height as f32);
    }
    let bytes = reference_bytes(&overlay, width, height);
    let alpha = |x: u32, y: u32| bytes[((y * width + x) * 4 + 3) as usize];
    let border = (0..width)
        .flat_map(|x| [(x, 0), (x, height - 1)])
        .chain((0..height).flat_map(|y| [(0, y), (width - 1, y)]));
    assert!(border.into_iter().all(|(x, y)| alpha(x, y) == 0));
}
