use super::*;

fn export_of(bytes: Vec<u8>) -> MapleExport {
    MapleExport {
        width: 4,
        height: 2,
        mime_type: "image/jpeg".to_string(),
        extension: "jpg".to_string(),
        bytes,
    }
}

#[test]
fn display_p3_is_the_only_spelling_that_selects_p3() {
    assert_eq!(target_primaries("display-p3"), TargetPrimaries::P3);
    assert_eq!(target_primaries("srgb"), TargetPrimaries::Srgb);
    assert_eq!(target_primaries("unknown"), TargetPrimaries::Srgb);
    assert_eq!(target_primaries(""), TargetPrimaries::Srgb);
    assert_eq!(target_primaries("Display-P3"), TargetPrimaries::Srgb);
}

/// Draining in chunks must reassemble the original file exactly — this is
/// the contract the JS Blob accumulation depends on.
#[test]
fn chunked_reads_reassemble_the_whole_file() {
    let original: Vec<u8> = (0..1000).map(|i| (i % 251) as u8).collect();
    let export = export_of(original.clone());

    for chunk_size in [1u32, 7, 256, 999, 1000, 4096] {
        let mut rebuilt: Vec<u8> = Vec::new();
        let mut offset = 0u32;
        while offset < export.byte_length() {
            let piece = export.chunk(offset, chunk_size);
            assert!(
                !piece.is_empty(),
                "a chunk inside the file must not be empty"
            );
            rebuilt.extend_from_slice(&piece);
            offset += piece.len() as u32;
        }
        assert_eq!(rebuilt, original, "chunk size {chunk_size} lost data");
    }
}

#[test]
fn a_chunk_past_the_end_is_empty_rather_than_a_panic() {
    let export = export_of(vec![1, 2, 3]);
    assert!(export.chunk(3, 16).is_empty());
    assert!(export.chunk(9999, 16).is_empty());
}

#[test]
fn a_chunk_straddling_the_end_is_truncated() {
    let export = export_of(vec![1, 2, 3, 4, 5]);
    assert_eq!(export.chunk(3, 100), vec![4, 5]);
}

#[test]
fn byte_length_reports_the_encoded_size() {
    assert_eq!(export_of(vec![0; 42]).byte_length(), 42);
    assert_eq!(export_of(Vec::new()).byte_length(), 0);
}

#[test]
fn an_unknown_format_is_rejected() {
    // Reaching decode would need a real RAW; the format check runs first,
    // so an empty buffer is enough to prove the rejection order.
    let result = export_core(&[], "dng", None, "bmp", 92, "srgb", 0);
    let err = match result {
        Err(e) => e,
        Ok(_) => panic!("an unknown format must be rejected"),
    };
    assert!(err.contains("unsupported format"), "got: {err}");
}

#[test]
fn a_jpeg_source_exports_through_the_raster_chain() {
    let image = image::RgbImage::from_pixel(8, 4, image::Rgb([120, 80, 40]));
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 95)
        .encode_image(&image)
        .expect("encode source JPEG");

    for format in ["jpeg", "png", "tiff"] {
        let full = export_core(&jpeg, "jpg", None, format, 92, "srgb", 0)
            .unwrap_or_else(|error| panic!("{format} export failed: {error}"));
        assert_eq!((full.width, full.height), (8, 4), "{format}");
        let decoded = image::load_from_memory(&full.bytes).expect("encoded export decodes");
        assert_eq!((decoded.width(), decoded.height()), (8, 4), "{format}");
    }

    let smaller =
        export_core(&jpeg, "jpg", None, "jpeg", 92, "srgb", 4).expect("resized JPEG export");
    assert_eq!((smaller.width, smaller.height), (4, 2));
    let no_upscale =
        export_core(&jpeg, "jpg", None, "jpeg", 92, "srgb", 16).expect("no-upscale export");
    assert_eq!((no_upscale.width, no_upscale.height), (8, 4));
}

#[test]
fn a_capped_large_jpeg_is_rejected_before_full_resolution_decode() {
    let image = image::RgbImage::from_pixel(8, 4, image::Rgb([120, 80, 40]));
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new(&mut jpeg)
        .encode_image(&image)
        .expect("encode source JPEG");
    let frame = jpeg
        .windows(2)
        .position(|marker| marker == [0xff, 0xc0])
        .expect("baseline JPEG frame header");
    jpeg[frame + 5..frame + 9].copy_from_slice(&[0x3e, 0x80, 0x3e, 0x80]);

    let error = match export_core(&jpeg, "jpg", None, "jpeg", 92, "srgb", 4096) {
        Err(error) => error,
        Ok(_) => panic!("large raster must be rejected before decoding"),
    };
    assert!(error.contains("16000×16000"), "got: {error}");
    assert!(error.contains("decode memory budget"), "got: {error}");
}

/// Repo-root fixture path. Skip-pass when the gitignored RAW is absent,
/// mirroring the raw-core pattern.
fn fixture() -> Option<Vec<u8>> {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0002.dng");
    if !path.exists() {
        eprintln!("fixture missing at {path:?} — skipping");
        return None;
    }
    Some(std::fs::read(&path).expect("read fixture"))
}

/// The full-resolution display develop `render_bytes` runs for sensors
/// inside the wasm32 memory budget — the export parity reference. Called
/// on raw-core directly because `render_bytes` itself memory-clamps
/// sensors over [`crate::cpu_budget::FULL_DEVELOP_MAX_SENSOR_PX`]
/// (#2661) and the test fixture is one of them; these tests run natively
/// (64-bit heap), where a full-res reference render is affordable.
fn full_res_canvas_render(raw: &[u8]) -> (u32, u32, Vec<u8>) {
    let raw_img = raw_core::decode::decode_bytes(raw, "dng").expect("decode");
    raw_core::pipeline::render_from_raw_with_quality_and_source(
        &raw_img,
        &raw_core::xmp::AdjustmentModel::default(),
        raw_core::pipeline::RenderQuality::Amaze,
        Some(raw_core::pipeline::RawInput::Bytes {
            bytes: raw,
            ext: "dng",
        }),
    )
    .expect("full-res canvas render")
}

/// **The parity gate.** A lossless sRGB 8-bit export must be BYTE-IDENTICAL
/// to what the display develop — the chain that paints the canvas —
/// produces at the export's full native resolution.
///
/// PNG is lossless, so decoding the exported file back to RGB recovers the
/// exact samples the pipeline emitted. Any divergence between the export
/// chain and the display chain shows up here as a non-zero pixel delta,
/// with no compression noise to hide behind.
#[test]
#[ignore = "renders at native resolution (~2 min); run with --ignored"]
fn a_lossless_export_is_byte_identical_to_the_canvas_render() {
    let Some(raw) = fixture() else { return };

    let (canvas_w, canvas_h, canvas_rgb) = full_res_canvas_render(&raw);

    let exported = export_core(&raw, "dng", None, "png", 100, "srgb", 0).expect("export");
    assert_eq!(
        (exported.width(), exported.height()),
        (canvas_w, canvas_h),
        "export dimensions must match the canvas render"
    );

    let decoded = image::load_from_memory(&exported.bytes)
        .expect("exported PNG must decode")
        .to_rgb8();
    assert_eq!(decoded.as_raw().len(), canvas_rgb.len());

    let max_delta = decoded
        .as_raw()
        .iter()
        .zip(canvas_rgb.iter())
        .map(|(a, b)| (*a as i32 - *b as i32).unsigned_abs())
        .max()
        .unwrap_or(0);
    assert_eq!(
        max_delta, 0,
        "export diverged from the canvas render by up to {max_delta}/255"
    );
}

/// A high-quality JPEG export must match the canvas to within JPEG's own
/// compression noise — nothing systematic on top of it.
#[test]
#[ignore = "renders at native resolution (~2 min); run with --ignored"]
fn a_jpeg_export_matches_the_canvas_within_compression_noise() {
    let Some(raw) = fixture() else { return };

    let (_, _, canvas_rgb) = full_res_canvas_render(&raw);

    let exported = export_core(&raw, "dng", None, "jpeg", 95, "srgb", 0).expect("export");
    let decoded = image::load_from_memory(&exported.bytes)
        .expect("exported JPEG must decode")
        .to_rgb8();
    assert_eq!(decoded.as_raw().len(), canvas_rgb.len());

    let squared_error: f64 = decoded
        .as_raw()
        .iter()
        .zip(canvas_rgb.iter())
        .map(|(a, b)| {
            let d = *a as f64 - *b as f64;
            d * d
        })
        .sum();
    let rmse = (squared_error / canvas_rgb.len() as f64).sqrt();
    // Quality-95 4:4:4 JPEG on photographic content sits near 1 LSB RMSE;
    // a pipeline divergence would be far larger.
    assert!(
        rmse < 3.0,
        "JPEG export RMSE vs canvas was {rmse:.3}/255 — larger than compression noise"
    );
}

/// The resize control must actually bound the long edge, and never upscale.
#[test]
#[ignore = "renders at native resolution (~4 min); run with --ignored"]
fn max_long_edge_caps_the_output_and_never_upscales() {
    let Some(raw) = fixture() else { return };

    let capped = export_core(&raw, "dng", None, "png", 100, "srgb", 512).expect("export");
    assert_eq!(
        capped.width().max(capped.height()),
        512,
        "long edge should have been capped to 512"
    );

    let native = export_core(&raw, "dng", None, "png", 100, "srgb", 0).expect("export");
    let huge = export_core(&raw, "dng", None, "png", 100, "srgb", 1_000_000).expect("export");
    assert_eq!(
        (huge.width(), huge.height()),
        (native.width(), native.height()),
        "a cap above the native long edge must not upscale"
    );
}

/// The 16-bit TIFF must carry real 16-bit data, not the 8-bit buffer
/// widened by ×257 — the distinction the whole depth split exists for.
#[test]
fn the_tiff_export_carries_genuine_sixteen_bit_samples() {
    let Some(raw) = fixture() else { return };

    let exported = export_core(&raw, "dng", None, "tiff", 100, "srgb", 512).expect("export");
    let decoded = image::load_from_memory(&exported.bytes).expect("exported TIFF must decode");
    let samples = decoded.to_rgb16();
    assert!(
        samples.as_raw().iter().any(|v| v % 257 != 0),
        "every TIFF sample was a multiple of 257 — this is 8-bit data in a 16-bit box"
    );
}

/// The two colour-space options must produce genuinely different files.
#[test]
fn the_colour_space_option_changes_the_exported_file() {
    let Some(raw) = fixture() else { return };

    let srgb = export_core(&raw, "dng", None, "png", 100, "srgb", 256).expect("export");
    let p3 = export_core(&raw, "dng", None, "png", 100, "display-p3", 256).expect("export");
    assert_ne!(
        srgb.bytes, p3.bytes,
        "sRGB and Display P3 exports must not be identical files"
    );
}
