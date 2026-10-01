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
        assert_eq!([plan.window.width, plan.window.height], [1024, 1024]);
        assert!(plan.window.contains(&NativeWindow {
            x,
            y,
            width: 300,
            height: 300
        }));
        plan.window.validate(source.width, source.height).unwrap();
    }
    let mask = intent(source.width, source.height, 100, 100, 1024, 100);
    assert!(super::super::plan_removal_generation(&encoded, &mask, 8, 4.0).is_err());
    assert!(super::super::plan_removal_generation(&encoded, &mask, 0, 1.0).is_err());
    assert!(
        super::super::plan_removal_generation(&encoded, &intent(16, 8, 0, 0, 1, 1), 0, 0.0)
            .is_err()
    );
}

#[test]
fn short_native_context_roundtrips_signed_hdr_into_verified_portable_patch() {
    let source = source(7, 5);
    let mask = intent(7, 5, 2, 2, 1, 1);
    let plan = super::super::plan_removal_generation(
        &serde_json::to_string(&source).unwrap(),
        &mask,
        2,
        1.5,
    )
    .unwrap();
    let scene: Vec<f32> = (0..35)
        .flat_map(|i| [i as f32 / 64.0 - 0.5, 0.18, i as f32 * 0.2 + 1.0])
        .collect();
    let prepared =
        PreparedRemovalGeneration::prepare(&request(&source, &plan), "[]", &scene, &mask, &[])
            .unwrap();
    assert_eq!(prepared.rgb().len(), 3 * PLANE);
    assert_eq!(prepared.hole().len(), PLANE);
    // Reflect-101: x=7 samples source x=5; y=5 samples source y=3.
    for c in 0..3 {
        assert_eq!(prepared.rgb()[c * PLANE + 7], prepared.rgb()[c * PLANE + 5]);
        assert_eq!(
            prepared.rgb()[c * PLANE + 5 * SIDE],
            prepared.rgb()[c * PLANE + 3 * SIDE]
        );
    }
    let patch = prepared.finish(prepared.rgb()).unwrap();
    let records =
        super::super::prepare_accepted_removal(prepared.request(), "[]", &mask, &patch).unwrap();
    let removals = crate::types::inpaint::decode_removals(&records).unwrap();
    let decoded =
        super::super::resolve_accepted_removal(&removals[0], &source, &mask, &patch).unwrap();
    assert_eq!(decoded.coverage[16], 1.0);
    assert!(decoded.pixels[16][0] < 0.0);
    assert!(decoded.pixels[16][2] > 1.0);
    for channel in 0..3 {
        assert!((decoded.pixels[16][channel] - scene[16 * 3 + channel]).abs() < 0.003);
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
    assert!(prepared.finish(&bad).is_err());
    assert!(prepared.finish(&bad[..100]).is_err());
}

#[test]
fn protection_and_context_mismatch_fail_before_inference() {
    let source = source(9, 7);
    let mask = intent(9, 7, 3, 3, 1, 1);
    let plan = super::super::plan_removal_generation(
        &serde_json::to_string(&source).unwrap(),
        &mask,
        2,
        1.0,
    )
    .unwrap();
    let request = request(&source, &plan);
    let scene = vec![0.18; 9 * 7 * 3];
    assert!(PreparedRemovalGeneration::prepare(&request, "[]", &scene, &mask, &mask).is_err());
    assert!(PreparedRemovalGeneration::prepare(&request, "[]", &scene[..3], &mask, &[]).is_err());
    assert!(PreparedRemovalGeneration::prepare(&request, "{}", &scene, &mask, &[]).is_err());
    let legacy = include_str!("../../../../../test-fixtures/removal/basic/records.txt");
    assert!(PreparedRemovalGeneration::prepare(&request, legacy, &scene, &mask, &[]).is_err());
    let protected = intent(9, 7, 4, 3, 1, 1);
    let prepared =
        PreparedRemovalGeneration::prepare(&request, "[]", &scene, &mask, &protected).unwrap();
    assert_eq!(prepared.hole()[3 * SIDE + 4], 0.0);
    let patch = super::super::patch_from_bytes(&prepared.finish(prepared.rgb()).unwrap()).unwrap();
    assert_eq!(patch.coverage[3 * 9 + 4], 0.0);
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
