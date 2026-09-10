use super::*;
use crate::{
    image::{CfaPattern, ColorSpace, ExifOrientation},
    pipeline::pano::opcodes::{ActiveAreaRect, OpcodeList3},
    AdjustmentModel, RawImage,
};

fn xml() -> String {
    format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:p="http://ns.adobe.com/photoshop/1.0/" xmlns:c="{CAMERA_NS}">
      <r:RDF><r:Description><p:CameraProfiles><r:Seq><r:li c:Make="Maple Test" c:Model="Synthetic" c:Lens="Prime"
        c:CameraRawProfile="True" c:SensorFormatFactor="1" c:FocalLength="35" c:ApertureValue="4" c:FocusDistance="4" c:ImageWidth="8" c:ImageLength="8">
        <c:PerspectiveModel c:Version="2" c:RadialDistortParam1="0.1"><c:VignetteModel c:VignetteModelParam1="-0.2"/></c:PerspectiveModel>
      </r:li></r:Seq></p:CameraProfiles></r:Description></r:RDF></x:xmpmeta>"#
    )
}

fn raw() -> RawImage {
    RawImage {
        width: 8,
        height: 8,
        cfa: CfaPattern::LinearRgb,
        black_level: [0; 4],
        white_level: 65535,
        raw_data: vec![12000; 8 * 8 * 3],
        as_shot_neutral: [1.0; 3],
        as_shot_cct: None,
        camera_make: "Maple Test".into(),
        camera_model: "Synthetic".into(),
        unique_camera_model: None,
        color_matrices: Default::default(),
        forward_matrices: Default::default(),
        orientation: ExifOrientation::Normal,
        baseline_exposure: 0.0,
        hsm_data: Default::default(),
        plt: None,
        profile_tone_curve: None,
        profile_gain_table_map: None,
        crop_rect: None,
        iso: 100,
        noise_profile: None,
        opcode_list3: None,
        aperture: Some(4.0),
        focal_length: Some(35.0),
        lens_metadata: LensMetadata {
            lens_model: Some("Prime".into()),
            focus_m: Some(4.0),
            active_area: Some(ActiveAreaRect::full(8, 8)),
            ..Default::default()
        },
    }
}

fn reference() -> String {
    register(&xml()).unwrap()["reference"]
        .as_str()
        .unwrap()
        .into()
}
#[test]
fn content_reference_is_immutable_and_distinguishes_documents() {
    let reference = reference();
    let different = register(&xml().replace("0.1", "0.2")).unwrap()["reference"]
        .as_str()
        .unwrap()
        .to_owned();
    // Content-addressed: a changed coefficient is a different profile, and the
    // same document always registers to the same reference.
    assert_ne!(reference, different);
    assert_eq!(
        reference,
        register(&xml()).unwrap()["reference"].as_str().unwrap()
    );
}

#[test]
fn an_uncached_reference_is_an_error_not_a_silent_different_baseline() {
    let raw = raw();
    // A profile the caller named but that is not in the cache must be reported,
    // never quietly downgraded to "no correction".
    assert!(resolve_for_raw(&raw, &format!("lcp1:{}", "0".repeat(64)))
        .unwrap_err()
        .contains("local cache"));
}

#[test]
fn identity_mismatch_is_rejected_and_acknowledgement_cannot_override_it() {
    let mut raw = raw();
    let reference = reference();
    raw.focal_length = Some(70.0);
    // Out-of-range focal length resolves, but only as an approximation the
    // caller has to acknowledge explicitly.
    let approximated = resolve_for_raw(&raw, &reference).unwrap().unwrap();
    assert!(!approximated.approximations.is_empty());
    // `lcp1-ack:` records that acknowledgement; the digest is unchanged.
    let acked = reference.replacen("lcp1:", "lcp1-ack:", 1);
    assert_eq!(
        profile_id(&acked).unwrap().0,
        profile_id(&reference).unwrap().0
    );
    assert!(profile_id(&acked).unwrap().1);
    // Consent covers approximation, never a different lens.
    raw.lens_metadata.lens_model = Some("Different lens".into());
    assert!(resolve_for_raw(&raw, &acked).is_err());
}

#[test]
fn an_embedded_opcode_list_takes_priority_over_any_external_profile() {
    let mut raw = raw();
    raw.opcode_list3 = Some((
        OpcodeList3 {
            opcodes: vec![],
            skipped_unknown: 0,
        },
        ActiveAreaRect::full(8, 8),
    ));
    // Embedded wins even when the external reference is not cached at all —
    // the RAW's own model is authoritative, so no cache lookup is needed.
    assert!(resolve_for_raw(&raw, &format!("lcp1:{}", "0".repeat(64)))
        .unwrap()
        .is_none());
}

#[test]
fn selected_reference_survives_real_sidecar_io() {
    let reference = reference();
    for value in [
        reference.clone(),
        reference.replacen("lcp1:", "lcp1-ack:", 1),
    ] {
        let model = AdjustmentModel {
            lens_profile: value.clone(),
            ..Default::default()
        };
        let path = tempfile::tempdir().unwrap();
        let sidecar = path.path().join("synthetic.xmp");
        std::fs::write(
            &sidecar,
            format!(
                "<x><rdf:Description xmlns:rdf=\"x\" xmlns:papp=\"x\" {}/></x>",
                crate::xmp::serialize(&model)
            ),
        )
        .unwrap();
        let reread = crate::xmp::parse(&std::fs::read_to_string(sidecar).unwrap()).unwrap();
        assert_eq!(reread.lens_profile, value);
    }
}

#[test]
fn selected_profile_failure_does_not_silently_render_a_different_baseline() {
    let mut raw = raw();
    let mut image = crate::Image::new(8, 8, ColorSpace::CameraNativeLinearRgb);
    let mut model = AdjustmentModel {
        lens_profile: format!("lcp1:{}", "0".repeat(64)),
        ..Default::default()
    };
    assert!(apply_for_raw(&raw, &model, &mut image, 1.0)
        .unwrap_err()
        .to_string()
        .contains("local cache"));
    model.lens_profile = reference();
    raw.focal_length = Some(70.0);
    assert!(apply_for_raw(&raw, &model, &mut image, 1.0)
        .unwrap_err()
        .to_string()
        .contains("acknowledgement"));
    model.lens_profile = model.lens_profile.replacen("lcp1:", "lcp1-ack:", 1);
    apply_for_raw(&raw, &model, &mut image, 1.0).unwrap();
    // Consent covers approximation, never a different lens.
    raw.lens_metadata.lens_model = Some("Different lens".into());
    assert!(apply_for_raw(&raw, &model, &mut image, 1.0).is_err());
}

#[test]
fn master_off_needs_no_external_cache() {
    let raw = raw();
    let mut model = AdjustmentModel {
        lens_profile: format!("lcp1:{}", "0".repeat(64)),
        ..Default::default()
    };
    model.lens_profile_enable = crate::types::adjustment::LensProfileEnable::Off;
    // With the master toggle off there is nothing to apply, so a reference
    // that is not cached must not be looked up at all.
    apply_for_raw(
        &raw,
        &model,
        &mut crate::Image::new(8, 8, ColorSpace::CameraNativeLinearRgb),
        1.0,
    )
    .unwrap();
}

#[test]
fn actual_develop_entry_consumes_selected_profile_and_preserves_default_pixels() {
    let raw = raw();
    let mut model = AdjustmentModel::default();
    let baseline = crate::pipeline::develop_scene_linear_from_raw_with_quality(
        &raw,
        &model,
        crate::pipeline::RenderQuality::Full,
    )
    .unwrap();
    model.lens_profile = reference();
    let corrected = crate::pipeline::develop_scene_linear_from_raw_with_quality(
        &raw,
        &model,
        crate::pipeline::RenderQuality::Full,
    )
    .unwrap();
    assert_ne!(baseline.pixels, corrected.pixels);
    model.lens_profile_enable = crate::types::adjustment::LensProfileEnable::Off;
    let disabled = crate::pipeline::develop_scene_linear_from_raw_with_quality(
        &raw,
        &model,
        crate::pipeline::RenderQuality::Full,
    )
    .unwrap();
    assert_eq!(baseline.pixels, disabled.pixels);
}
