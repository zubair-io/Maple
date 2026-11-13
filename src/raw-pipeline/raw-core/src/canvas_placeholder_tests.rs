use super::*;
use crate::canvas::{CanvasZoomContext, CanvasZoomModel, Point};

const VIEWPORT_PX: Size = Size::new(2752.0, 2064.0);

/// The render's fast-pass surface: the decode fitted into the viewport and
/// floored, never upscaled (`ImageEditPipeline.prescaledExtent` on Apple).
fn render_surface(native: (f64, f64), viewport: Size) -> (u32, u32) {
    let scale = (viewport.width / native.0)
        .min(viewport.height / native.1)
        .min(1.0);
    (
        (native.0 * scale).floor() as u32,
        (native.1 * scale).floor() as u32,
    )
}

#[test]
fn the_surface_fits_the_source_aspect_into_the_viewport() {
    assert_eq!(
        placeholder_surface_dims((512, 341), VIEWPORT_PX),
        Some((2752, 1832))
    );
    assert_eq!(
        placeholder_surface_dims((341, 512), VIEWPORT_PX),
        Some((1374, 2064))
    );
}

#[test]
fn an_unknown_viewport_keeps_the_source_size() {
    assert_eq!(
        placeholder_surface_dims((512, 341), Size::ZERO),
        Some((512, 341))
    );
    assert_eq!(
        placeholder_surface_dims((512, 341), Size::new(f64::NAN, 900.0)),
        Some((512, 341))
    );
}

#[test]
fn an_empty_source_has_no_surface() {
    assert_eq!(placeholder_surface_dims((0, 341), VIEWPORT_PX), None);
}

#[test]
fn the_surface_never_exceeds_the_texture_limit() {
    let (w, h) = placeholder_surface_dims((1000, 10), Size::new(1.0e6, 1.0e6)).unwrap();
    assert!(f64::from(w) <= MAX_TEXTURE_EDGE && f64::from(h) <= MAX_TEXTURE_EDGE);
    assert_eq!(w, MAX_TEXTURE_EDGE as u32);
}

#[test]
fn the_placeholder_surface_matches_the_render_surface_it_hands_over_to() {
    // A 6000×4000 RAW's grid thumbnail rounds its aspect to 512×341.
    let placeholder = placeholder_surface_dims((512, 341), VIEWPORT_PX).unwrap();
    let render = render_surface((6000.0, 4000.0), VIEWPORT_PX);
    assert_eq!(placeholder.0, render.0);
    assert!(
        placeholder.1.abs_diff(render.1) <= 3,
        "{placeholder:?} vs {render:?}"
    );
}

/// The placeholder and the render fill the same surface, which the host
/// lays out at the photo's frame; the frame is the same on both sides of
/// the swap, at fit and mid-zoom, so the swap changes only the pixels. The
/// thumbnail's rounded aspect (512×341 for 3:2) changes only the short side,
/// by that rounding (0.1%).
#[test]
fn the_placeholder_is_drawn_in_the_frame_the_render_lands_in() {
    let viewport = Size::new(1376.0, 1032.0);
    let thumbnail = (512.0, 341.0);
    let nominal = 8192.0 / thumbnail.0;
    let provisional = CanvasZoomContext::new(
        viewport,
        Size::new(thumbnail.0 * nominal, thumbnail.1 * nominal),
        2.0,
    );
    let real = CanvasZoomContext::new(viewport, Size::new(6000.0, 4000.0), 2.0);
    let frame = |model: CanvasZoomModel, context: &CanvasZoomContext| {
        context
            .display_frame_in_points(context.effective_scale(model.pixel_scale))
            .unwrap()
    };
    let at_fit = CanvasZoomModel::default().reset_to_fit(&provisional);
    let zoomed = at_fit
        .pinch_changed(1.0, Point::new(700.0, 500.0), &provisional)
        .pinch_changed(2.5, Point::new(720.0, 510.0), &provisional);
    for shown in [at_fit, zoomed] {
        let before = frame(shown, &provisional);
        let landed = shown.image_extent_resolved(&provisional, &real);
        let after = frame(landed, &real);
        assert!(
            (before.width - after.width).abs() < 1e-6,
            "{before:?} vs {after:?}"
        );
        assert!(
            (before.height / after.height - 1.0).abs() < 0.002,
            "{before:?} vs {after:?}"
        );
        let pan_moved = (landed.pan_offset.width - shown.pan_offset.width)
            .abs()
            .max((landed.pan_offset.height - shown.pan_offset.height).abs());
        assert!(
            pan_moved < 0.1,
            "{:?} vs {:?}",
            landed.pan_offset,
            shown.pan_offset
        );
    }
}

fn rgba(pixels: &[[u8; 3]]) -> Vec<u8> {
    pixels
        .iter()
        .flat_map(|p| [p[0], p[1], p[2], 255])
        .collect()
}

#[test]
fn a_still_in_the_target_primaries_keeps_its_bytes_exactly() {
    let bytes = rgba(&[[0, 128, 255], [17, 200, 3]]);
    let mut out = [[0.0; 4]; 2];
    encode_placeholder(
        &bytes,
        (2, 1),
        8,
        PlaceholderColorSpace::Srgb,
        TargetPrimaries::Srgb,
        &mut out,
    )
    .unwrap();
    assert_eq!(out[0], [0.0, 128.0 / 255.0, 1.0, 1.0]);
    assert_eq!(out[1], [17.0 / 255.0, 200.0 / 255.0, 3.0 / 255.0, 1.0]);
}

#[test]
fn srgb_white_and_black_stay_put_in_display_p3() {
    let bytes = rgba(&[[255, 255, 255], [0, 0, 0]]);
    let mut out = [[0.0; 4]; 2];
    encode_placeholder(
        &bytes,
        (2, 1),
        8,
        PlaceholderColorSpace::Srgb,
        TargetPrimaries::P3,
        &mut out,
    )
    .unwrap();
    assert!(out[0][..3].iter().all(|c| (c - 1.0).abs() < 1e-4));
    assert!(out[1][..3].iter().all(|c| c.abs() < 1e-6));
}

#[test]
fn srgb_red_is_less_saturated_in_display_p3_and_round_trips() {
    let bytes = rgba(&[[255, 0, 0]]);
    let mut p3 = [[0.0; 4]; 1];
    encode_placeholder(
        &bytes,
        (1, 1),
        4,
        PlaceholderColorSpace::Srgb,
        TargetPrimaries::P3,
        &mut p3,
    )
    .unwrap();
    assert!(p3[0][0] < 1.0 && p3[0][1] > 0.0);
    let p3_bytes: Vec<u8> = p3[0][..3]
        .iter()
        .map(|c| (c * 255.0).round() as u8)
        .chain([255])
        .collect();
    let mut back = [[0.0; 4]; 1];
    encode_placeholder(
        &p3_bytes,
        (1, 1),
        4,
        PlaceholderColorSpace::DisplayP3,
        TargetPrimaries::Srgb,
        &mut back,
    )
    .unwrap();
    assert!((back[0][0] - 1.0).abs() < 0.01, "{back:?}");
    assert!(back[0][1] < 0.02 && back[0][2] < 0.02, "{back:?}");
}

#[test]
fn padded_rows_are_read_by_their_stride() {
    let bytes = [
        10, 20, 30, 255, 99, 99, 99, 99, 40, 50, 60, 255, 99, 99, 99, 99,
    ];
    let mut out = [[0.0; 4]; 2];
    encode_placeholder(
        &bytes,
        (1, 2),
        8,
        PlaceholderColorSpace::Srgb,
        TargetPrimaries::Srgb,
        &mut out,
    )
    .unwrap();
    assert_eq!(out[1][0], 40.0 / 255.0);
}

#[test]
fn malformed_stills_are_refused() {
    let bytes = rgba(&[[1, 2, 3], [4, 5, 6]]);
    let encode = |dims, row_bytes, out: &mut [[f32; 4]]| {
        encode_placeholder(
            &bytes,
            dims,
            row_bytes,
            PlaceholderColorSpace::Srgb,
            TargetPrimaries::Srgb,
            out,
        )
    };
    assert_eq!(
        encode((0, 1), 8, &mut [[0.0; 4]; 0]),
        Err(PlaceholderError::Empty)
    );
    assert_eq!(
        encode((2, 1), 4, &mut [[0.0; 4]; 2]),
        Err(PlaceholderError::RowBytes)
    );
    assert_eq!(
        encode((2, 2), 8, &mut [[0.0; 4]; 4]),
        Err(PlaceholderError::Truncated)
    );
    assert_eq!(
        encode((2, 1), 8, &mut [[0.0; 4]; 3]),
        Err(PlaceholderError::OutputLength)
    );
    assert_eq!(
        encode((PLACEHOLDER_MAX_EDGE + 1, 1), 80_000, &mut [[0.0; 4]; 1]),
        Err(PlaceholderError::TooLarge)
    );
}

#[test]
fn the_reference_present_is_a_plain_quantize_at_one_to_one() {
    let encoded = [[0.0, 0.5, 1.0, 1.0]; 4];
    let bytes = reference_present_rgb8(&encoded, (2, 2), (2, 2));
    assert_eq!(bytes.len(), 12);
    for pixel in bytes.chunks_exact(3) {
        assert_eq!(pixel[0], 0);
        assert!(pixel[1].abs_diff(128) <= 1);
        assert_eq!(pixel[2], 255);
    }
}

#[test]
fn the_reference_present_upscales_without_bleeding_past_the_edges() {
    let encoded = [[0.0, 0.0, 0.0, 1.0], [1.0, 1.0, 1.0, 1.0]];
    let bytes = reference_present_rgb8(&encoded, (2, 1), (8, 2));
    assert_eq!(bytes.len(), 8 * 2 * 3);
    assert_eq!(bytes[0], 0);
    assert_eq!(bytes[7 * 3], 255);
    assert!(bytes[3 * 3] < bytes[4 * 3]);
}
