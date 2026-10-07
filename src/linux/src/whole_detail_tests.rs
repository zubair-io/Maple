use super::*;
use std::sync::atomic::AtomicBool;

#[test]
fn raw_whole_refinement_matches_shared_renderer_and_rejects_stale_results() {
    let bytes = std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test-fixtures/batch-transfer/source.dng"),
    )
    .unwrap();
    let raw = Arc::new(raw_core::decode::decode_bytes(&bytes, "dng").unwrap());
    let source = DetailSource {
        id: 1,
        raw: Some(raw.clone()),
        bytes: Arc::new(bytes),
        ext: "dng".into(),
    };
    let (w, h) = pipeline::native_render_dims(&raw);
    let rect = pipeline::TileRect {
        src_x: 0,
        src_y: 0,
        src_w: w,
        src_h: h,
        out_w: w / 2,
        out_h: h / 2,
    };
    let model = AdjustmentModel {
        exposure: 0.7,
        ..Default::default()
    };
    let actual = render(&source, &model, rect, CancelToken::never(), || false)
        .unwrap()
        .unwrap();
    let (w, h, rgb, _) = pipeline::render_detail_base(
        &raw,
        &model,
        pipeline::RawInput::Bytes {
            bytes: &source.bytes,
            ext: "dng",
        },
        pipeline::DetailRenderOptions {
            quality: pipeline::RenderQuality::Auto,
            max_long_edge: rect.out_w.max(rect.out_h),
            film_lut: None,
        },
    )
    .unwrap();
    assert_eq!(
        actual.patch,
        egui::ColorImage::from_rgb([w as usize, h as usize], &rgb)
    );
    assert!(render(&source, &model, rect, CancelToken::never(), || true)
        .unwrap()
        .is_none());
    let flag = AtomicBool::new(true);
    assert!(
        render(&source, &model, rect, CancelToken::new(&flag), || false)
            .unwrap()
            .is_none()
    );
}

#[test]
fn cropped_raster_refinement_preserves_display_resolution_and_matches_export() {
    let bytes = raw_core::png::encode(80, 60, &[90; 80 * 60 * 3]).unwrap();
    let source = DetailSource {
        id: 2,
        raw: None,
        bytes: Arc::new(bytes),
        ext: "png".into(),
    };
    let mut model = AdjustmentModel {
        exposure: 0.5,
        ..Default::default()
    };
    model.crop.left = 0.25;
    model.crop.right = 0.75;
    let (w, h) = raw_core::stages::crop::CropPresentation::new(&model.crop, 80, 60).dims;
    let rect = pipeline::TileRect {
        src_x: 0,
        src_y: 0,
        src_w: w,
        src_h: h,
        out_w: w / 2,
        out_h: h / 2,
    };
    let actual = render(&source, &model, rect, CancelToken::never(), || false)
        .unwrap()
        .unwrap();
    let (w, h, pixels) = pipeline::render_export_raster(
        &source.bytes,
        &model,
        Some(40),
        raw_core::view::encode::TargetPrimaries::Srgb,
        pipeline::ExportDepth::Eight,
        None,
    )
    .unwrap();
    let pipeline::ExportPixels::Eight(rgb) = pixels else {
        panic!("eight-bit")
    };
    assert_eq!(
        actual.patch,
        egui::ColorImage::from_rgb([w as usize, h as usize], &rgb)
    );
    assert_eq!(
        actual.patch.size,
        [rect.out_w as usize, rect.out_h as usize]
    );
    assert!(render(
        &source,
        &model,
        pipeline::TileRect {
            src_w: 10000,
            out_w: 9000,
            ..rect
        },
        CancelToken::never(),
        || false
    )
    .is_err());
}

#[test]
fn native_raw_geometry_refinement_uses_export_quality_and_complete_frame() {
    let bytes = std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test-fixtures/batch-transfer/source.dng"),
    )
    .unwrap();
    let raw = Arc::new(raw_core::decode::decode_bytes(&bytes, "dng").unwrap());
    let source = DetailSource {
        id: 3,
        raw: Some(raw.clone()),
        bytes: Arc::new(bytes),
        ext: "dng".into(),
    };
    let native = pipeline::native_render_dims(&raw);
    let mut model = AdjustmentModel {
        exposure: 0.5,
        perspective_vertical: 15.0,
        dehaze: 10.0,
        ..Default::default()
    };
    model.crop.left = 0.1;
    model.crop.right = 0.8;
    model.crop.angle = 7.0;
    assert!(required(&model));
    let dims = raw_core::stages::crop::CropPresentation::new(&model.crop, native.0, native.1).dims;
    let rect = request_rect(native, dims, 1.0);
    assert_eq!((rect.out_w, rect.out_h), dims);
    let frame = render(&source, &model, rect, CancelToken::never(), || false)
        .unwrap()
        .unwrap();
    let (w, h, rgb, _) = pipeline::render_detail_base(
        &raw,
        &model,
        pipeline::RawInput::Bytes {
            bytes: &source.bytes,
            ext: "dng",
        },
        pipeline::DetailRenderOptions {
            quality: pipeline::RenderQuality::Auto,
            max_long_edge: native.0.max(native.1),
            film_lut: None,
        },
    )
    .unwrap();
    assert_eq!(
        (w, h),
        dims,
        "native refinement must not use a half-resolution demosaic"
    );
    assert_eq!(
        frame.patch,
        egui::ColorImage::from_rgb([w as usize, h as usize], &rgb)
    );
}

#[test]
fn large_whole_frame_requests_bound_pre_crop_resolution() {
    let native = (11648, 8736);
    for dims in [native, (2912, 2184), (8736, 11648)] {
        for scale in [0.1, 0.5, 1.0, 8.0] {
            let rect = request_rect(native, dims, scale);
            assert!(rect.out_w > 0 && rect.out_h > 0);
            let fraction =
                (rect.out_w as f64 / dims.0 as f64).max(rect.out_h as f64 / dims.1 as f64);
            let edge = (native.0.max(native.1) as f64 * fraction).ceil() as u64;
            let w = (u64::from(native.0) * edge).div_ceil(u64::from(native.0.max(native.1)));
            let h = (u64::from(native.1) * edge).div_ceil(u64::from(native.0.max(native.1)));
            assert!(
                w * h <= 8_388_608,
                "hidden crop pixels must count toward the cap"
            );
            assert!(rect.out_w <= dims.0 && rect.out_h <= dims.1);
        }
    }
}

#[test]
fn fallback_preserves_requested_viewport_identity_and_rejects_invalid_or_cancelled_work() {
    let bytes = raw_core::png::encode(80, 60, &[90; 80 * 60 * 3]).unwrap();
    let source = DetailSource {
        id: 7,
        raw: None,
        bytes: Arc::new(bytes),
        ext: "png".into(),
    };
    let model = AdjustmentModel::default();
    let request = pipeline::TileRect {
        src_x: 16,
        src_y: 12,
        src_w: 32,
        src_h: 24,
        out_w: 32,
        out_h: 24,
    };
    let frame = fallback(&source, &model, request, CancelToken::never(), || false)
        .unwrap()
        .unwrap();
    assert!(frame.whole_fallback);
    assert_eq!(
        (
            frame.request.src_x,
            frame.request.src_y,
            frame.request.src_w,
            frame.request.src_h
        ),
        (16, 12, 32, 24)
    );
    assert_eq!(
        (
            frame.rect.src_x,
            frame.rect.src_y,
            frame.rect.src_w,
            frame.rect.src_h
        ),
        (0, 0, 80, 60)
    );
    assert_eq!(frame.patch.size, [80, 60]);
    let direct = render(&source, &model, frame.rect, CancelToken::never(), || false)
        .unwrap()
        .unwrap();
    assert_eq!(frame.patch, direct.patch);
    let invalid = pipeline::TileRect {
        src_x: 80,
        ..request
    };
    assert!(fallback(&source, &model, invalid, CancelToken::never(), || false).is_err());
    assert!(
        fallback(&source, &model, request, CancelToken::never(), || true)
            .unwrap()
            .is_none()
    );
    let flag = AtomicBool::new(true);
    assert!(
        fallback(&source, &model, request, CancelToken::new(&flag), || false)
            .unwrap()
            .is_none()
    );
}
