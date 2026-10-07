use super::*;
use std::cell::Cell;

#[test]
fn obsolete_detail_stops_before_base_before_tile_and_before_pixel_publication() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test-fixtures/batch-transfer/source.dng");
    let bytes = std::fs::read(&path).unwrap();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").unwrap();
    let model = AdjustmentModel::default();
    let (width, height) = pipeline::native_render_dims(&raw);
    let valid = TileRect {
        src_x: 0,
        src_y: 0,
        src_w: width / 2,
        src_h: height / 2,
        out_w: width / 2,
        out_h: height / 2,
    };
    // Invalid coordinates would be rejected by the tile kernel if reached.
    let invalid = TileRect {
        src_x: width + 1,
        ..valid
    };
    let mut renderer = DetailRenderer::default();
    assert!(renderer
        .render_cancellable(&raw, &bytes, "dng", &model, invalid, || true)
        .unwrap()
        .is_none());
    assert!(renderer.reference.is_none());

    let checks = Cell::new(0);
    let cancelled = || {
        checks.set(checks.get() + 1);
        checks.get() >= 2
    };
    assert!(renderer
        .render_cancellable(&raw, &bytes, "dng", &model, invalid, cancelled)
        .unwrap()
        .is_none());
    assert_eq!(checks.get(), 2);
    assert!(
        renderer.reference.is_none(),
        "obsolete base pixels must not be retained"
    );

    let expected = renderer.render(&raw, &bytes, "dng", &model, valid).unwrap();
    checks.set(0);
    assert!(renderer
        .render_cancellable(&raw, &bytes, "dng", &model, invalid, || {
            checks.set(checks.get() + 1);
            checks.get() >= 2
        })
        .unwrap()
        .is_none());
    assert_eq!(
        checks.get(),
        2,
        "cached base must still check before entering tile"
    );

    checks.set(0);
    assert!(renderer
        .render_cancellable(&raw, &bytes, "dng", &model, valid, || {
            checks.set(checks.get() + 1);
            checks.get() >= 3
        })
        .unwrap()
        .is_none());
    assert_eq!(
        checks.get(),
        3,
        "completed obsolete tile cannot create published UI pixels"
    );
    let resumed = renderer.render(&raw, &bytes, "dng", &model, valid).unwrap();
    assert_eq!(resumed.patch.pixels, expected.patch.pixels);
    assert!(std::sync::Arc::ptr_eq(&resumed.base, &expected.base));
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[test]
fn tile_kernel_cancel_preserves_anchors_and_never_cancel_pixels() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test-fixtures/batch-transfer/source.dng");
    let bytes = std::fs::read(&path).unwrap();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").unwrap();
    let model = AdjustmentModel {
        sharpen_amount: 60.0,
        nr_luminance: 35.0,
        nr_color: 35.0,
        ..Default::default()
    };
    let (w, h) = pipeline::native_render_dims(&raw);
    let rect = TileRect {
        src_x: 0,
        src_y: 0,
        src_w: w / 2,
        src_h: h / 2,
        out_w: w / 2,
        out_h: h / 2,
    };
    let mut renderer = DetailRenderer::default();
    let expected = renderer.render(&raw, &bytes, "dng", &model, rect).unwrap();
    let flag = AtomicBool::new(true);
    assert!(renderer
        .render_with_token(
            &raw,
            &bytes,
            "dng",
            &model,
            rect,
            raw_core::CancelToken::new(&flag),
            || false
        )
        .unwrap()
        .is_none());
    flag.store(false, Ordering::Release);
    let resumed = renderer
        .render_with_token(
            &raw,
            &bytes,
            "dng",
            &model,
            rect,
            raw_core::CancelToken::new(&flag),
            || false,
        )
        .unwrap()
        .unwrap();
    assert_eq!(expected.patch.pixels, resumed.patch.pixels);
    assert!(std::sync::Arc::ptr_eq(&expected.base, &resumed.base));
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
}

#[test]
fn cancelled_base_is_not_retained_and_resumption_matches_reference() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test-fixtures/batch-transfer/source.dng");
    let bytes = std::fs::read(&path).unwrap();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").unwrap();
    let model = AdjustmentModel {
        exposure: 0.4,
        nr_luminance: 25.0,
        nr_color: 25.0,
        ..Default::default()
    };
    let (w, h) = pipeline::native_render_dims(&raw);
    let rect = TileRect {
        src_x: 0,
        src_y: 0,
        src_w: w / 2,
        src_h: h / 2,
        out_w: w / 2,
        out_h: h / 2,
    };
    let mut renderer = DetailRenderer::default();
    let flag = AtomicBool::new(true);
    assert!(renderer
        .render_with_token(
            &raw,
            &bytes,
            "dng",
            &model,
            rect,
            raw_core::CancelToken::new(&flag),
            || false
        )
        .unwrap()
        .is_none());
    assert!(renderer.reference.is_none());
    flag.store(false, Ordering::Release);
    let resumed = renderer
        .render_with_token(
            &raw,
            &bytes,
            "dng",
            &model,
            rect,
            raw_core::CancelToken::new(&flag),
            || false,
        )
        .unwrap()
        .unwrap();
    let (bw, bh, rgb, _) = pipeline::render_detail_base(
        &raw,
        &model,
        RawInput::Bytes {
            bytes: &bytes,
            ext: "dng",
        },
        DetailRenderOptions {
            quality: RenderQuality::Preview,
            max_long_edge: 1600,
            film_lut: None,
        },
    )
    .unwrap();
    let expected = egui::ColorImage::from_rgb([bw as usize, bh as usize], &rgb);
    assert_eq!(resumed.base.pixels, expected.pixels);
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}
