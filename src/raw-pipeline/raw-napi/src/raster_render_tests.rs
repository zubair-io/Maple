//! Tests for the five raster resize/render/tensor `Task`s (#3509 Task 4).
//! Calls each `Task::compute()` directly, mirroring real cases from
//! `src/maple/test/raster-v2.test.ts` and `src/maple/test/resize-modes.test.ts`
//! (adapted to construct pixels/PNGs in Rust rather than round-tripping
//! through the TS builder, since these exercise the napi bindings directly).
//!
//! Lives under `src/` (not `tests/`) for the same reason `filename_tests.rs`
//! and `raster_probe_tests.rs` do: this crate's `crate-type` is `["cdylib"]`
//! only, so an integration test under `tests/` cannot link `raw_napi` as an
//! external crate.

use napi::Task;
use raw_core::export::{encode_raster, ExportFormat};
use raw_core::raster::{probe_raster_metadata, RasterImage};

use crate::raster_render::{RasterFromRawRenderBufTask, RasterRenderBufTask};
use crate::raster_resize::{
    RasterExtractTensorTask, RasterResizeToBufTask, RasterResizeToFileTask,
};

const FLAG_COVER: u32 = 8;

/// A solid-colour raster, the same shape `raster-v2.test.ts`'s `solid()`
/// helper builds.
fn solid_raw(w: u32, h: u32, rgb: [u8; 3]) -> RasterImage {
    let mut data = Vec::with_capacity((w * h * 3) as usize);
    for _ in 0..(w * h) {
        data.extend_from_slice(&rgb);
    }
    RasterImage::from_raw(w, h, 3, data).unwrap()
}

fn solid_png(w: u32, h: u32, rgb: [u8; 3]) -> Vec<u8> {
    encode_raster(&solid_raw(w, h, rgb), ExportFormat::Png, 0).unwrap()
}

#[test]
fn resize_to_buf_shrinks_inside_a_box() {
    // Tier-1 `fit` bitset: 0 = Inside, no auto-orient, no enlargement.
    let png = solid_png(64, 64, [90, 90, 90]);
    let mut task = RasterResizeToBufTask {
        bytes: png,
        width: 32,
        height: 32,
        fit: 0,
        format: Some("png".to_string()),
        quality: 0,
    };
    let result = task.compute().unwrap();
    assert!(result.ok, "resize failed: {:?}", result.error);
    let buffer = result.buffer.expect("ok result carries a buffer");
    let meta = probe_raster_metadata(&buffer).unwrap();
    assert_eq!((meta.width, meta.height), (32, 32));
}

#[test]
fn resize_to_buf_reports_an_error_for_garbage_input() {
    let mut task = RasterResizeToBufTask {
        bytes: b"not an image".to_vec(),
        width: 10,
        height: 10,
        fit: 0,
        format: None,
        quality: 0,
    };
    let result = task.compute().unwrap();
    assert!(!result.ok);
    assert!(result.buffer.is_none());
    assert!(result.error.is_some());
}

#[test]
fn resize_to_file_writes_the_resized_image() {
    let png = solid_png(20, 10, [1, 2, 3]);
    let in_dir = std::env::temp_dir();
    let in_path = in_dir.join(format!("raw-napi-test-in-{}.png", std::process::id()));
    let out_path = in_dir.join(format!("raw-napi-test-out-{}.png", std::process::id()));
    std::fs::write(&in_path, &png).unwrap();

    let mut task = RasterResizeToFileTask {
        input_path: in_path.to_string_lossy().into_owned(),
        out_path: out_path.to_string_lossy().into_owned(),
        width: 10,
        height: 10,
        fit: 0,
        format: Some("png".to_string()),
        quality: 0,
    };
    let result = task.compute().unwrap();
    assert!(result.ok, "resize-to-file failed: {:?}", result.error);
    let out_bytes = std::fs::read(&out_path).unwrap();
    let meta = probe_raster_metadata(&out_bytes).unwrap();
    // Inside fit on a 20x10 source into a 10x10 box: width-bound, so 10x5.
    assert_eq!((meta.width, meta.height), (10, 5));

    std::fs::remove_file(&in_path).ok();
    std::fs::remove_file(&out_path).ok();
}

#[test]
fn resize_to_file_reports_an_error_for_a_missing_input() {
    let mut task = RasterResizeToFileTask {
        input_path: "/nonexistent/does-not-exist.png".to_string(),
        out_path: std::env::temp_dir()
            .join("raw-napi-test-unreachable.png")
            .to_string_lossy()
            .into_owned(),
        width: 10,
        height: 10,
        fit: 0,
        format: Some("png".to_string()),
        quality: 0,
    };
    let result = task.compute().unwrap();
    assert!(!result.ok);
    assert!(result.error.is_some());
}

/// Mirrors `raster-v2.test.ts`'s "cover fit produces the exact box".
#[test]
fn render_buf_cover_fit_produces_the_exact_box() {
    let png = solid_png(40, 20, [1, 2, 3]);
    let mut task = RasterRenderBufTask {
        bytes: png,
        width: 10,
        height: 10,
        flags: FLAG_COVER,
        filter: 0,
        format: Some("png".to_string()),
        quality: 0,
        effort: 0,
    };
    let result = task.compute().unwrap();
    assert!(result.ok, "render failed: {:?}", result.error);
    let buffer = result.buffer.expect("ok result carries a buffer");
    let meta = probe_raster_metadata(&buffer).unwrap();
    assert_eq!((meta.width, meta.height), (10, 10));
}

#[test]
fn render_buf_reports_an_error_for_an_unrecognized_format() {
    let png = solid_png(4, 4, [0, 0, 0]);
    let mut task = RasterRenderBufTask {
        bytes: png,
        width: 0,
        height: 0,
        flags: 0,
        filter: 0,
        format: Some("not-a-format".to_string()),
        quality: 0,
        effort: 0,
    };
    let result = task.compute().unwrap();
    assert!(!result.ok);
    assert!(result.buffer.is_none());
    assert!(result
        .error
        .as_deref()
        .unwrap()
        .contains("unrecognized export format"));
}

/// Mirrors `raster-v2.test.ts`'s "accepts raw pixel input and encodes it".
#[test]
fn from_raw_render_buf_accepts_raw_pixels_and_encodes_them() {
    let raster = solid_raw(8, 4, [10, 20, 30]);
    let mut task = RasterFromRawRenderBufTask {
        pixels: raster.data.clone(),
        src_width: raster.width,
        src_height: raster.height,
        channels: raster.channels as u32,
        width: 0,
        height: 0,
        flags: 0,
        filter: 0,
        format: Some("png".to_string()),
        quality: 0,
        effort: 0,
    };
    let result = task.compute().unwrap();
    assert!(result.ok, "render failed: {:?}", result.error);
    let buffer = result.buffer.expect("ok result carries a buffer");
    let meta = probe_raster_metadata(&buffer).unwrap();
    assert_eq!(
        (meta.width, meta.height, meta.format.as_str()),
        (8, 4, "png")
    );
}

#[test]
fn from_raw_render_buf_reports_an_error_for_invalid_pixel_dimensions() {
    let mut task = RasterFromRawRenderBufTask {
        // 3 bytes cannot be a 4x4x3 raster.
        pixels: vec![0u8; 3],
        src_width: 4,
        src_height: 4,
        channels: 3,
        width: 0,
        height: 0,
        flags: 0,
        filter: 0,
        format: None,
        quality: 0,
        effort: 0,
    };
    let result = task.compute().unwrap();
    assert!(!result.ok);
    assert!(result.buffer.is_none());
    assert!(result.error.is_some());
}

/// Mirrors `raster-v2.test.ts`'s "toRaw returns native-size RGB8", adapted
/// to the tensor extraction path: a solid grey image normalises to a
/// constant tensor of the expected length.
#[test]
fn extract_tensor_produces_the_expected_length_and_values() {
    let png = solid_png(6, 5, [90, 90, 90]);
    let mut task = RasterExtractTensorTask {
        bytes: png,
        target_size: 0,
        layout: 0,
        normalize: 0,
    };
    let result = task.compute().unwrap();
    assert!(result.ok, "tensor extraction failed: {:?}", result.error);
    let tensor = result.tensor.expect("ok result carries a tensor");
    assert_eq!(tensor.len(), 3 * 6 * 5);
    assert!(tensor.iter().all(|&v| (v - 90.0).abs() < 0.001));
}

#[test]
fn extract_tensor_zero_to_one_normalises_into_unit_range() {
    let png = solid_png(4, 4, [255, 0, 0]);
    let mut task = RasterExtractTensorTask {
        bytes: png,
        target_size: 0,
        layout: 1,    // HWC
        normalize: 2, // ZeroToOne
    };
    let result = task.compute().unwrap();
    assert!(result.ok, "tensor extraction failed: {:?}", result.error);
    let tensor = result.tensor.expect("ok result carries a tensor");
    // HWC: first pixel's R,G,B are the first three floats.
    assert!((tensor[0] - 1.0).abs() < 0.001);
    assert!((tensor[1] - 0.0).abs() < 0.001);
    assert!((tensor[2] - 0.0).abs() < 0.001);
}

#[test]
fn extract_tensor_reports_an_error_for_garbage_input() {
    let mut task = RasterExtractTensorTask {
        bytes: b"not an image".to_vec(),
        target_size: 0,
        layout: 0,
        normalize: 0,
    };
    let result = task.compute().unwrap();
    assert!(!result.ok);
    assert!(result.tensor.is_none());
    assert!(result.error.is_some());
}
