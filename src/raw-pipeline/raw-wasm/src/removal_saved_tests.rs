use super::*;
use raw_core::{
    cancel::CancelToken,
    pipeline::{patch_to_bytes, prepare_accepted_removal, removal_mask_to_bytes},
    types::{accepted_removal::NativeWindow, removal_mask::RemovalMask, InpaintPatch},
};

const RAW: &[u8] = include_bytes!("../../../../test-fixtures/removal/basic/source.dng");

fn fixture() -> (RawImage, ContentDigest, String, String, Vec<u8>) {
    let raw = raw_core::decode_raw(RAW, "dng").unwrap();
    let original = ContentDigest::for_bytes(RAW);
    let source = raw_core::pipeline::removal_calibration_source_anchor(&raw, &original).unwrap();
    let plate =
        raw_core::pipeline::render_removal_calibration_plate(&raw, CancelToken::never()).unwrap();
    let mask = removal_mask_to_bytes(&RemovalMask {
        source_width: plate.width,
        source_height: plate.height,
        x: 3,
        y: 2,
        width: 1,
        height: 1,
        pixels: vec![255],
    })
    .unwrap();
    let index = (2 * plate.width + 3) as usize;
    let mut coverage = vec![0.0; plate.pixels.len()];
    coverage[index] = 1.0;
    let patch = patch_to_bytes(&InpaintPatch {
        width: plate.width,
        height: plate.height,
        origin: [0.0; 2],
        extent: [1.0; 2],
        pixels: plate.pixels.iter().map(|p| p.map(|v| v * 0.5)).collect(),
        coverage,
    })
    .unwrap();
    let window = NativeWindow {
        x: 0,
        y: 0,
        width: plate.width,
        height: plate.height,
    };
    let request = serde_json::json!({
        "plate":"linear-calibration-v1", "source":source,
        "patch_window":window, "context_window":window,
        "model":ContentDigest::for_bytes(b"fixed weights"),
        "recipe":ContentDigest::for_bytes(b"fixed photographic recipe"),
        "model_version":"saved host fixture", "bake":{"temp":6500,"tint":0,"ev":0},
    });
    let records = prepare_accepted_removal(&request.to_string(), "[]", &mask, &patch).unwrap();
    let xmp = format!(
        r#"<rdf:Description xmlns:rdf="x" xmlns:papp="http://ns.justmaple.app/photo/1.0/" papp:InpaintRemovals="{}"/>"#,
        records.replace('"', "&quot;")
    );
    let manifest = serde_json::json!([
        {"name":format!("{}.mask", ContentDigest::for_bytes(&mask).hex()),"length":mask.len()},
        {"name":format!("{}.f16", ContentDigest::for_bytes(&patch).hex()),"length":patch.len()},
    ])
    .to_string();
    let bytes = [mask, patch].concat();
    (raw, original, xmp, manifest, bytes)
}

#[test]
fn retained_saved_preview_and_lossless_exports_use_verified_companions_without_inference() {
    let (raw, original, xmp, manifest, bytes) = fixture();
    let mut session = crate::native_detail::NativeDetailSession::new(RAW, "dng").unwrap();
    assert_eq!(
        session
            .prepare_saved_removals(&xmp, &manifest, &bytes)
            .unwrap(),
        "[]"
    );
    let stack = prepare(&raw, &original, &xmp, &manifest, &bytes).unwrap();
    for cap in [0, 4, 64] {
        let mut display = session.render_saved_removals(&xmp, cap, &[]).unwrap();
        let pixels = display.take_rgb();
        let expected = render(Some(&stack), &raw, &original, RAW, "dng", &xmp, cap, &[]).unwrap();
        assert_eq!(
            (display.width(), display.height()),
            (expected.width(), expected.height())
        );
        for format in ["png", "tiff"] {
            let options = serde_json::json!({"format":format,"quality":100,"color_space":"srgb","max_long_edge":cap}).to_string();
            let result = session.export_saved_removals(&xmp, &options, &[]).unwrap();
            let encoded = result.chunk(0, result.byte_length());
            let decoded = image::load_from_memory(&encoded).unwrap();
            assert_eq!(
                (result.width(), result.height()),
                (display.width(), display.height())
            );
            if format == "png" {
                assert_eq!(decoded.to_rgb8().as_raw(), &pixels);
            } else {
                let rgb16 = decoded.to_rgb16();
                assert!(rgb16.as_raw().iter().any(|v| v % 257 != 0));
                for (a, b) in pixels.iter().zip(rgb16.as_raw()) {
                    assert!((*a as f32 / 255.0 - *b as f32 / 65535.0).abs() <= 1.0 / 255.0);
                }
            }
        }
    }
}

#[test]
fn manifest_cannot_supply_paths_duplicates_truncation_or_unlisted_bytes() {
    let (raw, original, xmp, manifest, bytes) = fixture();
    let entries: serde_json::Value = serde_json::from_str(&manifest).unwrap();
    let mut unsafe_entries = entries.clone();
    unsafe_entries[0]["name"] = "../photo.dng".into();
    assert!(prepare(&raw, &original, &xmp, &unsafe_entries.to_string(), &bytes).is_err());
    let duplicate = serde_json::json!([entries[0], entries[0]]);
    assert!(prepare(&raw, &original, &xmp, &duplicate.to_string(), &bytes).is_err());
    assert!(prepare(&raw, &original, &xmp, &manifest, &bytes[..bytes.len() - 1]).is_err());
    let mut trailing = bytes.clone();
    trailing.push(0);
    assert!(prepare(&raw, &original, &xmp, &manifest, &trailing).is_err());
    let mut corrupt = bytes;
    corrupt[0] ^= 1;
    assert!(prepare(&raw, &original, &xmp, &manifest, &corrupt).is_err());
}

#[test]
fn unprepared_or_changed_records_block_render_and_export() {
    let (raw, original, xmp, manifest, bytes) = fixture();
    assert!(render(None, &raw, &original, RAW, "dng", &xmp, 4, &[]).is_err());
    let stack = prepare(&raw, &original, &xmp, &manifest, &bytes).unwrap();
    let changed = r#"<rdf:Description xmlns:rdf="x" xmlns:papp="http://ns.justmaple.app/photo/1.0/" papp:InpaintRemovals="[]"/>"#;
    assert!(render(Some(&stack), &raw, &original, RAW, "dng", changed, 4, &[]).is_err());
    let options = r#"{"format":"png","quality":100,"color_space":"srgb","max_long_edge":4}"#;
    assert!(export(
        Some(&stack),
        &raw,
        &original,
        RAW,
        "dng",
        changed,
        options,
        &[]
    )
    .is_err());
}
