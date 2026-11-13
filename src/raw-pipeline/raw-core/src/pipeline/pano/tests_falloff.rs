//! #4516: lens falloff precedence in `decode_for_pano` — the OpcodeList3
//! gain opcodes stay authoritative, the bundled profile's vignette fills in
//! when the list has none, and `PanoIngest::falloff_correction` records
//! which one ran.
//!
//! No committed pano fixture pairs a bundled-profile body with an
//! opcode-free DNG (every DJI set carries OpcodeList3 and no DJI lens is in
//! the bundle), so the flattening gate runs a synthetic flat field through
//! the same `develop_scene_linear_for_pano` stage list, with a real bundled
//! lens identity and that lens's own falloff baked into the mosaic. The
//! fixture-gated test repeats it on test_0006 (EOS 5D Mark III + EF
//! 70-200mm f/2.8L IS II at f/2.8).

use super::opcodes::{
    ActiveAreaRect, OpcodeList3, PanoOpcode, WarpPlaneParams, WarpRectilinearOpcode,
};
use super::*;
use crate::test_support::synth_dng::{fix_vignette_radial_opcode_list3, SyntheticGreyDng};

const MAKE: &str = "Canon";
const BODY: &str = "EOS 5D Mark III";
const LENS: &str = "EF70-200mm f/2.8L IS II USM";

fn matched_synthetic(opcode_list3: Option<Vec<u8>>) -> RawImage {
    let bytes = SyntheticGreyDng {
        linear_value: 0.3,
        width: 96,
        height: 64,
        opcode_list3,
        ..SyntheticGreyDng::default()
    }
    .write_to_bytes();
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode synthetic DNG");
    with_lens(raw, Some(LENS))
}

fn with_lens(raw: RawImage, lens: Option<&str>) -> RawImage {
    RawImage {
        camera_make: MAKE.into(),
        camera_model: BODY.into(),
        focal_length: Some(70.0),
        aperture: Some(2.8),
        lens_metadata: crate::lens_profile::LensMetadata {
            camera_make: None,
            camera_model: None,
            lens_model: lens.map(str::to_owned),
            ..raw.lens_metadata.clone()
        },
        ..raw
    }
}

fn bake_bundled_falloff(raw: RawImage) -> RawImage {
    let vignette = crate::lens_profile::resolve_bundled(&raw)
        .expect("resolve")
        .expect("bundled match")
        .calibration
        .vignette
        .expect("bundled vignette model");
    let (w, h) = (raw.width as usize, raw.height as usize);
    let raw_data = raw
        .raw_data
        .iter()
        .enumerate()
        .map(|(i, &code)| {
            let (x, y) = (i % w, i / w);
            let black = f64::from(raw.black_level[(y % 2) * 2 + x % 2]);
            let gain = vignette
                .gain(w as f64, h as f64, [x as f64, y as f64])
                .expect("positive illumination");
            (black + (f64::from(code) - black) / gain).round() as u16
        })
        .collect();
    RawImage { raw_data, ..raw }
}

fn window_luma(image: &Image, x0: u32, y0: u32, side: u32) -> f64 {
    let pixels: Vec<f64> = (y0..y0 + side)
        .flat_map(|y| (x0..x0 + side).map(move |x| (x, y)))
        .map(|(x, y)| {
            let p = image.pixels[(y * image.width + x) as usize];
            f64::from(p[0] + p[1] + p[2]) / 3.0
        })
        .collect();
    pixels.iter().sum::<f64>() / pixels.len() as f64
}

fn corner_to_centre(image: &Image) -> f64 {
    let side = (image.width.min(image.height) / 16).max(4);
    let centre = window_luma(
        image,
        (image.width - side) / 2,
        (image.height - side) / 2,
        side,
    );
    let corner = window_luma(image, 2, 2, side);
    corner / centre
}

fn develop(raw: &RawImage) -> (Image, Vec<String>, FalloffCorrection) {
    develop_scene_linear_for_pano(raw, raw.opcode_list3.as_ref()).expect("pano develop")
}

#[test]
fn bundled_vignette_flattens_a_profile_matched_flat_field() {
    let vignetted = bake_bundled_falloff(matched_synthetic(None));
    let (corrected, opcodes, source) = develop(&vignetted);
    let (raw_falloff, _, unmatched_source) = develop(&with_lens(vignetted.clone(), None));

    let before = corner_to_centre(&raw_falloff);
    let after = corner_to_centre(&corrected);
    eprintln!("corner/centre before {before:.4} after {after:.4}");
    assert_eq!(source, FalloffCorrection::BundledProfile);
    assert_eq!(unmatched_source, FalloffCorrection::None);
    assert!(opcodes.is_empty());
    assert!(before < 0.9, "baked falloff must be visible, got {before}");
    assert!(
        (after - 1.0).abs() < 0.02,
        "bundled vignette must flatten the field, got {after}"
    );
}

#[test]
fn opcode_gain_stays_authoritative_over_a_bundled_match() {
    let list = fix_vignette_radial_opcode_list3([-0.3, 0.0, 0.0, 0.0, 0.0], 0.5, 0.5);
    let matched = matched_synthetic(Some(list));
    let (with_profile, opcodes, source) = develop(&matched);
    let (without_profile, _, _) = develop(&with_lens(matched.clone(), None));

    assert_eq!(source, FalloffCorrection::Opcode);
    assert_eq!(opcodes, vec!["FixVignetteRadial".to_string()]);
    assert_eq!(
        with_profile.pixels, without_profile.pixels,
        "a bundled match must never compound an opcode gain"
    );
}

#[test]
fn warp_only_list_takes_the_bundled_vignette() {
    let identity_warp = PanoOpcode::WarpRectilinear(WarpRectilinearOpcode {
        planes: vec![WarpPlaneParams {
            kr: [1.0, 0.0, 0.0, 0.0],
            kt: [0.0, 0.0],
        }],
        center_x: 0.5,
        center_y: 0.5,
    });
    let raw = matched_synthetic(None);
    let list = (
        OpcodeList3 {
            opcodes: vec![identity_warp],
            skipped: Vec::new(),
        },
        ActiveAreaRect::full(raw.width, raw.height),
    );
    let (_, opcodes, source) =
        develop_scene_linear_for_pano(&raw, Some(&list)).expect("pano develop");
    assert_eq!(source, FalloffCorrection::BundledProfile);
    assert_eq!(opcodes, vec!["WarpRectilinear(1 planes)".to_string()]);
}

#[test]
fn unmatched_source_reports_no_falloff_correction() {
    let bytes = SyntheticGreyDng::default().write_to_bytes();
    let ingest = decode_for_pano(&bytes, "dng").expect("decode_for_pano");
    assert_eq!(ingest.falloff_correction, FalloffCorrection::None);
}

#[test]
#[cfg_attr(
    not(feature = "fixtures"),
    ignore = "needs test-fixtures/raws (fixtures feature)"
)]
fn bundled_vignette_flattens_test_0006_corners() {
    let bytes = std::fs::read(crate::test_support::fixtures::require_raw("test_0006.DNG"))
        .expect("read test_0006.DNG");
    let ingest = decode_for_pano(&bytes, "dng").expect("decode_for_pano");
    assert_eq!(ingest.falloff_correction, FalloffCorrection::BundledProfile);

    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode");
    let unmatched = RawImage {
        lens_metadata: crate::lens_profile::LensMetadata {
            lens_model: None,
            ..raw.lens_metadata.clone()
        },
        ..raw
    };
    let (uncorrected, _, source) = develop(&unmatched);
    assert_eq!(source, FalloffCorrection::None);
    let uncorrected = orient_scene_linear(uncorrected, unmatched.orientation);
    let before = corner_to_centre(&uncorrected);
    let after = corner_to_centre(&ingest.image);
    eprintln!("test_0006 corner/centre before {before:.4} after {after:.4}");
    assert!((after - 1.0).abs() < (before - 1.0).abs());
}

#[test]
#[cfg_attr(
    not(feature = "fixtures"),
    ignore = "needs test-fixtures/raws (fixtures feature)"
)]
fn dji_fixtures_record_their_falloff_source() {
    let read = |name: &str| {
        let bytes = std::fs::read(crate::test_support::fixtures::require_raw(name)).expect("read");
        decode_for_pano(&bytes, "dng")
            .expect("decode_for_pano")
            .falloff_correction
    };
    assert_eq!(read("pano_01/PANO0001.DNG"), FalloffCorrection::Opcode);
    assert_eq!(read("pano_00/0000.DNG"), FalloffCorrection::None);
}
