use super::*;
use crate::types::{accepted_removal::NativeWindow, removal_mask::RemovalMask};

fn source(width: u32, height: u32) -> SourceAnchor {
    SourceAnchor {
        original: ContentDigest::for_bytes(b"RAW"),
        decode: ContentDigest::for_bytes(b"calibration"),
        width,
        height,
    }
}

fn intent(width: u32, height: u32, x: u32, y: u32, w: u32, h: u32) -> Vec<u8> {
    super::super::removal_mask_to_bytes(&RemovalMask {
        source_width: width,
        source_height: height,
        x,
        y,
        width: w,
        height: h,
        pixels: vec![255; (w * h) as usize],
    })
    .unwrap()
}

fn request(source: &SourceAnchor, masks: &str) -> String {
    serde_json::json!({"schema":1,"source":source,
        "masks":serde_json::from_str::<serde_json::Value>(masks).unwrap(),
        "model":ContentDigest::for_bytes(b"verified model"),"model_version":"fixture"})
    .to_string()
}

#[test]
fn native_plan_contains_expansion_at_edges_and_refuses_large_selections() {
    let source = source(11648, 8736);
    let encoded = serde_json::to_string(&source).unwrap();
    for (x, y) in [(0, 0), (11348, 8436), (5333, 3444)] {
        let mask = intent(source.width, source.height, x, y, 300, 300);
        let plan = super::super::plan_removal_generation(&encoded, &mask, 8, 4.0).unwrap();
        let plan: GenerationMaskRequest = serde_json::from_str(&plan).unwrap();
        assert_eq!([plan.window.width, plan.window.height], [2048, 2048]);
        assert!(plan.window.contains(&NativeWindow {
            x,
            y,
            width: 300,
            height: 300
        }));
        plan.window.validate(source.width, source.height).unwrap();
    }
    let mask = intent(source.width, source.height, 100, 100, 2048, 100);
    assert!(super::super::plan_removal_generation(&encoded, &mask, 8, 4.0).is_err());
    assert!(super::super::plan_removal_generation(&encoded, &mask, 0, 1.0).is_err());
    assert!(
        super::super::plan_removal_generation(&encoded, &intent(16, 8, 0, 0, 1, 1), 0, 0.0)
            .is_err()
    );
}

#[test]
fn native_context_roundtrips_signed_hdr_into_verified_portable_patch() {
    let source = source(64, 64);
    let mask = intent(64, 64, 24, 24, 1, 1);
    let plan = super::super::plan_removal_generation(
        &serde_json::to_string(&source).unwrap(),
        &mask,
        2,
        1.5,
    )
    .unwrap();
    let mut scene: Vec<f32> = (0..64 * 64)
        .flat_map(|i| [i as f32 / 64.0 - 0.5, 0.18, i as f32 * 0.2 + 1.0])
        .collect();
    for pixel in scene.chunks_exact_mut(3) {
        pixel[0] = -0.25;
        pixel[2] = 1.5;
    }
    let prepared =
        PreparedRemovalGeneration::prepare(&request(&source, &plan), "[]", &scene, &mask, &[])
            .unwrap();
    assert_eq!(prepared.rgb().len(), 3 * PLANE);
    assert_eq!(prepared.hole().len(), PLANE);
    assert!(prepared
        .rgb()
        .iter()
        .all(|value| (0.0..=1.0).contains(value)));
    let patch = prepared
        .finish(prepared.rgb(), crate::cancel::CancelToken::never())
        .unwrap();
    let records =
        super::super::prepare_accepted_removal(prepared.request(), "[]", &mask, &patch).unwrap();
    let removals = crate::types::inpaint::decode_removals(&records).unwrap();
    let decoded =
        super::super::resolve_accepted_removal(&removals[0], &source, &mask, &patch).unwrap();
    let selected = 24 * 64 + 24;
    assert_eq!(decoded.coverage[selected], 1.0);
    assert!(decoded.pixels.iter().flatten().any(|value| *value < 0.0));
    assert!(decoded.pixels.iter().flatten().any(|value| *value > 1.0));
    for channel in 0..3 {
        assert!(decoded.pixels[selected][channel].is_finite());
    }
    for (pixel, coverage) in decoded.pixels.iter().zip(&decoded.coverage) {
        if *coverage == 0.0 {
            assert_eq!(*pixel, [0.0; 3]);
        }
    }
    assert_eq!(
        removals[0].accepted.as_ref().unwrap().plate,
        crate::types::accepted_removal::RemovalPlate::LinearCalibrationV1
    );
    let mut bad = prepared.rgb().to_vec();
    bad[PLANE - 1] = f32::NAN;
    assert!(prepared
        .finish(&bad, crate::cancel::CancelToken::never())
        .is_err());
    assert!(prepared
        .finish(&bad[..100], crate::cancel::CancelToken::never())
        .is_err());
}

#[test]
fn protection_and_context_mismatch_fail_before_inference() {
    let source = source(64, 64);
    let mask = intent(64, 64, 30, 30, 1, 1);
    let plan = super::super::plan_removal_generation(
        &serde_json::to_string(&source).unwrap(),
        &mask,
        2,
        1.0,
    )
    .unwrap();
    let request = request(&source, &plan);
    let scene = vec![0.18; 64 * 64 * 3];
    assert!(PreparedRemovalGeneration::prepare(&request, "[]", &scene, &mask, &mask).is_err());
    assert!(PreparedRemovalGeneration::prepare(&request, "[]", &scene[..3], &mask, &[]).is_err());
    assert!(PreparedRemovalGeneration::prepare(&request, "{}", &scene, &mask, &[]).is_err());
    let legacy = include_str!("../../../../../test-fixtures/removal/basic/records.txt");
    assert!(PreparedRemovalGeneration::prepare(&request, legacy, &scene, &mask, &[]).is_err());
    let protected = intent(64, 64, 31, 30, 1, 1);
    let prepared =
        PreparedRemovalGeneration::prepare(&request, "[]", &scene, &mask, &protected).unwrap();
    assert_eq!(prepared.hole()[30 * SIDE + 31], 0.0);
    let patch = super::super::patch_from_bytes(
        &prepared
            .finish(prepared.rgb(), crate::cancel::CancelToken::never())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(patch.coverage[30 * 64 + 31], 0.0);
}

#[test]
fn expanded_native_context_downscales_for_model_then_bakes_native_patch() {
    let source = source(4096, 4096);
    let mask = intent(4096, 4096, 2047, 2047, 1, 1);
    let plan = super::super::plan_removal_generation(
        &serde_json::to_string(&source).unwrap(),
        &mask,
        8,
        4.0,
    )
    .unwrap();
    let request = request(&source, &plan);
    let scene = vec![0.18; 2048 * 2048 * 3];
    let prepared = PreparedRemovalGeneration::prepare(&request, "[]", &scene, &mask, &[]).unwrap();

    assert_eq!(prepared.rgb().len(), 3 * 512 * 512);
    assert_eq!(prepared.hole().len(), 512 * 512);
    let coarse_hole_pixels = prepared.hole().iter().filter(|value| **value > 0.0).count();
    assert!((1..100).contains(&coarse_hole_pixels));
    let patch = super::super::patch_from_bytes(
        &prepared
            .finish(prepared.rgb(), crate::cancel::CancelToken::never())
            .unwrap(),
    )
    .unwrap();
    assert_eq!([patch.width, patch.height], [2048, 2048]);
    assert_eq!(patch.coverage[1024 * 2048 + 1024], 1.0);
}

#[test]
fn a_fully_selected_context_has_no_reconstruction_evidence() {
    let source = source(1, 3);
    let mask = intent(1, 3, 0, 0, 1, 3);
    let plan = super::super::plan_removal_generation(
        &serde_json::to_string(&source).unwrap(),
        &mask,
        0,
        0.0,
    )
    .unwrap();
    assert!(PreparedRemovalGeneration::prepare(
        &request(&source, &plan),
        "[]",
        &vec![0.18; 9],
        &mask,
        &[]
    )
    .is_err());
}
