//! The develop-path contract: automatic matching, explicit picks, and the
//! precedence of embedded corrections and the master toggle.

use crate::{
    image::{CfaPattern, ColorSpace, ExifOrientation},
    lens_profile::{
        apply_for_raw, auto_match, evidence_for, resolve_auto, resolve_for_raw, LensMetadata,
        Source,
    },
    pipeline::pano::opcodes::{ActiveAreaRect, OpcodeList3},
    types::adjustment::LensProfileEnable,
    AdjustmentModel, RawImage,
};

const W: u32 = 64;
const H: u32 = 48;

/// A Sony ILCE-7RM4 + FE 24-70 F4 frame with a gradient so a warp moves
/// pixels; every field the resolver reads is set.
fn sony() -> RawImage {
    let pixels = (0..W * H * 3)
        .map(|i| 4000 + (i % 977) as u16 * 40)
        .collect::<Vec<u16>>();
    RawImage {
        width: W,
        height: H,
        cfa: CfaPattern::LinearRgb,
        black_level: [0; 4],
        white_level: 65535,
        raw_data: pixels,
        as_shot_neutral: [1.0; 3],
        as_shot_cct: None,
        camera_make: "SONY".into(),
        camera_model: "ILCE-7RM4".into(),
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
        aperture: Some(5.6),
        focal_length: Some(35.0),
        lens_metadata: LensMetadata {
            camera_make: Some("SONY".into()),
            camera_model: Some("ILCE-7RM4".into()),
            lens_model: Some("FE 24-70mm F4 ZA OSS".into()),
            focus_m: Some(5.0),
            active_area: Some(ActiveAreaRect::full(W, H)),
        },
    }
}

fn image() -> crate::Image {
    crate::Image::new(W, H, ColorSpace::CameraNativeLinearRgb)
}

#[test]
fn the_exif_identity_matches_automatically_and_resolves_every_bundled_family() {
    let raw = sony();
    let m = auto_match(&raw).expect("match");
    assert_eq!(m.slug, "sony/fe24-70mmf4zaoss@sonye");
    let res = resolve_auto(&raw).unwrap().expect("resolution");
    assert!(matches!(res.source, Source::Lensfun { .. }));
    assert!(res.calibration.distortion.is_some() && res.calibration.ca.is_some());
    let evidence = evidence_for(&raw, &AdjustmentModel::default())
        .unwrap()
        .expect("evidence");
    assert_eq!(evidence["source"], "lensfun");
    assert_eq!(evidence["lens"], "Sony FE 24-70mm f/4 ZA OSS");
    assert_eq!(evidence["dbVersion"], "12f5976 (2026-09-11)");
}

#[test]
fn a_manual_pick_resolves_by_slug_and_a_wrong_one_is_an_error() {
    let raw = sony();
    let res = resolve_for_raw(&raw, "lensfun1:sony/fe24-70mmf4zaoss@sonye")
        .unwrap()
        .expect("resolution");
    assert!(matches!(res.source, Source::Lensfun { .. }));
    assert!(resolve_for_raw(&raw, "lensfun1:sony/nosuchlens@sonye").is_err());
    assert!(resolve_for_raw(&raw, "lensfun2:x/y@z").is_err());
    let mut other = sony();
    other.lens_metadata.camera_model = Some("Unknown body".into());
    other.camera_model = "Unknown body".into();
    assert!(resolve_for_raw(&other, "lensfun1:sony/fe24-70mmf4zaoss@sonye").is_err());
}

#[test]
fn embedded_corrections_and_the_master_toggle_win() {
    let mut raw = sony();
    raw.opcode_list3 = Some((
        OpcodeList3 {
            opcodes: vec![],
            skipped_unknown: 0,
        },
        ActiveAreaRect::full(W, H),
    ));
    assert!(resolve_auto(&raw).unwrap().is_none());
    assert!(
        resolve_for_raw(&raw, "lensfun1:sony/fe24-70mmf4zaoss@sonye")
            .unwrap()
            .is_none()
    );
    let raw = sony();
    let mut off = AdjustmentModel::default();
    off.lens_profile_enable = LensProfileEnable::Off;
    let mut img = image();
    let before = img.pixels.clone();
    apply_for_raw(&raw, &off, &mut img, 1.0).unwrap();
    assert_eq!(before, img.pixels, "master off applies nothing");
}

#[test]
fn an_out_of_range_shot_still_applies_automatically() {
    let mut raw = sony();
    raw.focal_length = Some(300.0);
    let res = resolve_auto(&raw).unwrap().expect("resolution");
    assert!(!res.approximations.is_empty());
    let mut img = image();
    for (i, px) in img.pixels.iter_mut().enumerate() {
        *px = [i as f32 * 0.001, 0.5, 0.25];
    }
    let before = img.pixels.clone();
    apply_for_raw(&raw, &AdjustmentModel::default(), &mut img, 1.0).unwrap();
    assert_ne!(
        before, img.pixels,
        "the bundled match is applied without an acknowledgement"
    );
}

#[test]
fn no_match_means_no_correction_and_no_error() {
    let mut raw = sony();
    raw.lens_metadata.lens_model = Some("24-70mm".into());
    assert!(auto_match(&raw).is_none());
    assert!(evidence_for(&raw, &AdjustmentModel::default())
        .unwrap()
        .is_none());
    let mut img = image();
    let before = img.pixels.clone();
    apply_for_raw(&raw, &AdjustmentModel::default(), &mut img, 1.0).unwrap();
    assert_eq!(before, img.pixels);
}
