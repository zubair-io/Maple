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

#[cfg(feature = "gpu")]
#[test]
fn saved_gpu_prefix_is_source_bound_and_reuses_hot_slider_base() {
    use crate::gpu_render::{
        develop_prefix_rgba, develop_prefix_rgba_saved, require_prepared_removals,
    };
    let (raw, original, xmp, manifest, bytes) = fixture();
    let model = crate::mask_registry::parse_model(Some(&xmp)).unwrap();
    let stack = prepare(&raw, &original, &xmp, &manifest, &bytes).unwrap();
    assert!(require_no_unresolved_removals(&model).is_err());
    assert!(develop_prefix_rgba(&raw, RAW, "dng", &model, 64).is_err());
    assert!(develop_prefix_rgba_saved(&raw, RAW, "dng", &original, &model, 64, None).is_err());
    let other = ContentDigest::for_bytes(b"another RAW");
    assert!(develop_prefix_rgba_saved(&raw, RAW, "dng", &other, &model, 64, Some(&stack)).is_err());
    let mut changed = model.clone();
    changed.inpaint_removals[0].model_version.push('x');
    assert!(require_prepared_removals(Some(&stack), &changed).is_err());
    assert!(require_prepared_removals(None, &raw_core::xmp::AdjustmentModel::default()).is_ok());

    let ctx = raw_gpu::GpuContext::new_blocking()
        .expect("saved-prefix GPU qualification requires adapter");
    for cap in [4, 64] {
        let (rgba, w, h, prefix, anchor) =
            develop_prefix_rgba_saved(&raw, RAW, "dng", &original, &model, cap, Some(&stack))
                .unwrap();
        let expected = stack
            .develop_with_gain(
                &raw,
                &original,
                &prefix,
                RenderQuality::Amaze,
                Some(cap),
                CancelToken::never(),
            )
            .unwrap()
            .0;
        assert_eq!(
            rgba,
            expected
                .pixels
                .iter()
                .flat_map(|p| [p[0], p[1], p[2], 1.0])
                .collect::<Vec<_>>()
        );
        assert_eq!(Some(anchor), expected.whites_anchor_ev);
        let ordinary = raw_core::xmp::AdjustmentModel {
            inpaint_removals: Vec::new(),
            ..model.clone()
        };
        let unedited = develop_prefix_rgba(&raw, RAW, "dng", &ordinary, cap).unwrap();
        assert_ne!(rgba, unedited.0, "saved edit was ignored by GPU upload");
        let session = raw_gpu::LiveSession::new(&ctx, &rgba, w, h).unwrap();
        for (temperature, ev) in [(6500.0, 0.0), (4300.0, 2.0), (9000.0, -2.0)] {
            let grade = raw_core::xmp::AdjustmentModel {
                temperature,
                temperature_seen: true,
                exposure: ev,
                ..model.clone()
            };
            let (_, _, _, hot_prefix, _) =
                develop_prefix_rgba_saved(&raw, RAW, "dng", &original, &grade, cap, Some(&stack))
                    .unwrap();
            assert_eq!(
                prefix, hot_prefix,
                "WB/exposure must keep the resident base"
            );
            let inputs = crate::gpu_render::chain_inputs_for_model(
                &raw, RAW, "dng", &grade, None, 0, anchor,
            );
            // The first activation of a chain signature may create its normal
            // pool bucket. A second tick must reuse it, as the existing live gate.
            let gpu = session
                .render_to_buffer(&ctx, &inputs, &raw_gpu::CancelToken::new())
                .unwrap()
                .unwrap();
            let before = session.pool_alloc_count(&ctx);
            let repeated = session
                .render_to_buffer(&ctx, &inputs, &raw_gpu::CancelToken::new())
                .unwrap()
                .unwrap();
            assert_eq!(gpu, repeated);
            assert_eq!(
                before,
                session.pool_alloc_count(&ctx),
                "hot saved sliders allocated new GPU resources"
            );
            let (_, _, cpu) = stack
                .render_display(
                    &raw,
                    &original,
                    &grade,
                    RenderQuality::Amaze,
                    Some(RawInput::Bytes {
                        bytes: RAW,
                        ext: "dng",
                    }),
                    Some(cap),
                    None,
                )
                .unwrap();
            let max = gpu
                .iter()
                .zip(&cpu)
                .map(|(a, b)| a.abs_diff(*b))
                .max()
                .unwrap();
            assert!(
                max <= 2,
                "saved CPU/GPU output at {temperature}K/{ev}EV cap{cap}: max {max} LSB"
            );
        }
    }
}
