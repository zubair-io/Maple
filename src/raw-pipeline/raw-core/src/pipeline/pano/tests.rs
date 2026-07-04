//! Tests for the pano ingest entry point.
//!
//! The anti-drift contract is the headline: `decode_for_pano`'s stage glue
//! is a mirror of the canonical develop chain, and
//! [`matches_develop_with_display_stages_zeroed`] pins the two together
//! bit-for-bit on a synthetic DNG — if either side's stage list changes,
//! this fails before any fixture-level harness can.

use super::*;
use crate::image::ColorSpace;
use crate::test_support::synth_dng::SyntheticGreyDng;
use crate::types::adjustment::AutoExposureMode;
use crate::AdjustmentModel;

/// The canonical develop chain with every stage that `decode_for_pano`
/// excludes turned into its documented bit-identical no-op: auto-exposure
/// Off, and the three non-zero display defaults (sharpen 40, nr_color 25)
/// zeroed. Everything else in `AdjustmentModel::default()` already
/// short-circuits at its default value — including white balance, on
/// whichever of `develop`'s two WB stages this fixture actually takes:
///
/// This fixture's real (non-identity) Hasselblad `ColorMatrix1`/
/// `ColorMatrix2` resolves to a calibrated `ProfileSource` tier, so
/// `develop` runs the camera-space stage (#1726, pre-DCP,
/// `stages::wb_camera::apply`) here — unlike the identity-CM1 default
/// fixture elsewhere in this file, which stays on `RawlerFallback` and
/// takes the post-DCP CAT16 stage (#1729/#1725, `white_balance::
/// resolve_wb` + `apply`) instead. `camera_wb_applied` gates the two
/// mutually exclusively, so only one runs on any given fixture.
///
/// Both stages resolve "as-shot" the same way: neither `temperature_seen`
/// nor `tint_seen` is set (the struct's default, left alone here — NOT
/// forced `true`), which is what both `wb_camera::resolve_target` and
/// `white_balance::resolve_wb` treat as "no explicit WB was authored".
/// `wb_camera::resolve_target` then seeds from THIS image's own
/// `profile.scene_cct` (5500 K, off the 6500 K numeric default) before
/// `apply`'s identity check runs, so the camera-space stage is a no-op
/// here regardless of that gap. (Had the flags been forced `true`, as an
/// earlier version of this fixture did to satisfy the OTHER tier's
/// `resolve_wb` contract, `wb_camera::resolve_target` would read that as
/// an explicit — not As-Shot — target of the literal `6500.0`/`0.0`
/// pair, and the camera-space gain would render a real, non-identity warm
/// cast: exactly the regression this comment now heads off.)
/// `decode_for_pano` never calls `wb_camera::apply` at all, but since the
/// stage is a pixel no-op on this fixture, that's an inert architectural
/// difference, not a pixel divergence.
fn display_stages_zeroed() -> AdjustmentModel {
    AdjustmentModel {
        auto_exposure: AutoExposureMode::Off,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        ..AdjustmentModel::default()
    }
}

/// Bit-for-bit lock between `decode_for_pano` and the canonical develop
/// chain (with display stages zeroed) on a synthetic Bayer DNG carrying the
/// real Hasselblad dual-illuminant DCP. This is what makes the glue mirror
/// in `develop_scene_linear_for_pano` safe: any reordering, added stage, or
/// changed constant on either side breaks exact equality here.
#[test]
fn matches_develop_with_display_stages_zeroed() {
    let dng = SyntheticGreyDng {
        linear_value: 0.30,
        width: 32,
        height: 24,
        ..SyntheticGreyDng::default()
    }
    .with_hasselblad_dcp();
    let bytes = dng.write_to_bytes();
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode synthetic DNG");

    let pano = decode_for_pano(&bytes, "dng").expect("decode_for_pano");
    let develop = crate::pipeline::develop_scene_linear_from_raw_with_quality(
        &raw,
        &display_stages_zeroed(),
        RenderQuality::Full,
    )
    .expect("develop");

    assert_eq!(pano.image.space, ColorSpace::SceneLinearRec2020);
    assert_eq!(
        (pano.image.width, pano.image.height),
        (develop.width, develop.height),
        "truncated chain must produce the same dims as develop"
    );
    for (i, (p, d)) in pano
        .image
        .pixels
        .iter()
        .zip(develop.pixels.iter())
        .enumerate()
    {
        assert_eq!(
            p, d,
            "pixel {} diverged: pano {:?} vs develop {:?} — the decode_for_pano \
             stage mirror has drifted from pipeline::develop",
            i, p, d
        );
    }
}

/// Auto-exposure exclusion, observable: a dim synthetic scene (0.05
/// scene-linear) must come out of `decode_for_pano` still dim — the
/// develop chain's default AE would pull its mid-grey toward 0.18.
#[test]
fn excludes_auto_exposure_anchoring() {
    let dng = SyntheticGreyDng {
        linear_value: 0.05,
        width: 32,
        height: 24,
        ..SyntheticGreyDng::default()
    }
    .with_hasselblad_dcp();
    let bytes = dng.write_to_bytes();

    let pano = decode_for_pano(&bytes, "dng").expect("decode_for_pano");
    let mean_luma: f64 = pano
        .image
        .pixels
        .iter()
        .map(|p| (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) as f64)
        .sum::<f64>()
        / pano.image.pixel_count() as f64;
    // The neutral synthetic decodes to ~its scene-linear value. With AE the
    // mean would sit near 0.18 (gain ≈ 3.6×); without, near 0.05. Split the
    // difference generously — the point is "not anchored," not a colorimetry
    // budget.
    assert!(
        mean_luma < 0.10,
        "mean luma {:.4} looks auto-exposure-anchored (expected ≈ 0.05)",
        mean_luma
    );
    // And neutrality survives the pipeline: R ≈ G ≈ B per pixel.
    for p in pano.image.pixels.iter().take(16) {
        let max = p[0].max(p[1]).max(p[2]);
        let min = p[0].min(p[1]).min(p[2]);
        assert!(
            max - min < 0.005,
            "neutral input must stay neutral, got {:?}",
            p
        );
    }
}

/// Pin `orient_scene_linear`'s per-orientation source mapping to the
/// canonical u8 implementation (`crate::image::apply_orientation`) over an
/// asymmetric 3×2 pattern, for all 8 EXIF orientations.
#[test]
fn orient_matches_u8_reference_for_all_orientations() {
    use crate::image::apply_orientation;
    let (w, h) = (3u32, 2u32);
    // Six distinguishable pixels; channel values chosen u8-exact so the
    // u8 reference and the f32 path can be compared losslessly.
    let values: Vec<[f32; 3]> = (0..6)
        .map(|i| {
            let v = (i as f32 + 1.0) * 10.0;
            [v, v + 1.0, v + 2.0]
        })
        .collect();
    let rgb_u8: Vec<u8> = values
        .iter()
        .flat_map(|p| p.iter().map(|&c| c as u8))
        .collect();

    for orient in [
        ExifOrientation::Normal,
        ExifOrientation::HorizontalFlip,
        ExifOrientation::Rotate180,
        ExifOrientation::VerticalFlip,
        ExifOrientation::Transpose,
        ExifOrientation::Rotate90,
        ExifOrientation::Transverse,
        ExifOrientation::Rotate270,
    ] {
        let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        img.pixels.copy_from_slice(&values);
        let oriented = orient_scene_linear(img, orient);
        let (rw, rh, ref_bytes) = apply_orientation(&rgb_u8, w, h, orient);
        assert_eq!(
            (oriented.width, oriented.height),
            (rw, rh),
            "{:?}: dims diverged from u8 reference",
            orient
        );
        let got: Vec<u8> = oriented
            .pixels
            .iter()
            .flat_map(|p| p.iter().map(|&c| c as u8))
            .collect();
        assert_eq!(got, ref_bytes, "{:?}: pixel mapping diverged", orient);
    }
}

/// Synthetic sources carry no EXIF focal tags and no XMP packet — the
/// metadata pass must degrade those fields to `None`, keep the camera
/// identity, and report `output_dims` equal to the actual decoded image.
#[test]
fn metadata_degrades_gracefully_without_exif_or_xmp() {
    let dng = SyntheticGreyDng::default().with_hasselblad_dcp();
    let bytes = dng.write_to_bytes();
    let pano = decode_for_pano(&bytes, "dng").expect("decode_for_pano");
    assert_eq!(pano.metadata.focal_mm, None);
    assert_eq!(pano.metadata.focal_35mm_equiv, None);
    assert!(pano.metadata.xmp_packet.is_none());
    assert_eq!(
        pano.metadata.output_dims,
        (pano.image.width, pano.image.height),
        "output_dims must match the developed image"
    );
    // read_pano_metadata (the metadata-only entry) must agree.
    let md = read_pano_metadata(&bytes, "dng").expect("read_pano_metadata");
    assert_eq!(md.output_dims, pano.metadata.output_dims);
}

/// Fixture-gated: the DJI Mavic 3 Cine pano frame must surface the real
/// EXIF focal pair and the drone-dji XMP packet. Metadata-only (no
/// develop) so this stays fast in debug test runs; full-pixel coverage
/// lives in maple-pano's fixture gates and the `pano-ingest-probe` binary.
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn read_pano_metadata_pano01_fixture() {
    let path = crate::test_support::fixtures::require_raw("pano_01/PANO0001.DNG");
    let bytes = std::fs::read(&path).expect("read PANO0001.DNG");
    let md = read_pano_metadata(&bytes, "dng").expect("read_pano_metadata");

    assert_eq!(md.camera_make, "Hasselblad");
    assert_eq!(md.camera_model, "L2D-20c");
    let focal = md.focal_mm.expect("EXIF FocalLength present");
    assert!(
        (focal - 12.3).abs() < 0.05,
        "FocalLength ≈ 12.3 mm, got {}",
        focal
    );
    let f35 = md
        .focal_35mm_equiv
        .expect("FocalLengthIn35mmFormat present");
    assert!((f35 - 24.0).abs() < 0.5, "35mm-equiv ≈ 24 mm, got {}", f35);
    assert_eq!(md.orientation, ExifOrientation::Normal);
    // DefaultCrop 5272×3948 out of the 5376×3956 sensor, orientation Normal.
    assert_eq!(md.output_dims, (5272, 3948));
    let xmp = md.xmp_packet.as_ref().expect("XMP packet present");
    let xmp_str = String::from_utf8_lossy(xmp);
    assert!(
        xmp_str.contains("drone-dji:GimbalYawDegree"),
        "XMP packet must carry the DJI gimbal attributes"
    );
}

/// #1159: the stage-2a opcode application actually runs on the real DJI
/// fixtures — both corrections on the L2D-20c (pano_01), warp-only on
/// the L3D-100c (pano_00). Guards the wiring (the parser/appliers have
/// their own unit tests; this one fails if `decode_for_pano` ever stops
/// invoking them).
#[test]
#[cfg_attr(
    not(feature = "fixtures"),
    ignore = "needs test-fixtures/raws (fixtures feature)"
)]
fn applies_opcode_list3_on_dji_fixtures() {
    let p01 = std::fs::read(crate::test_support::fixtures::require_raw(
        "pano_01/PANO0001.DNG",
    ))
    .expect("read PANO0001.DNG");
    let ingest = decode_for_pano(&p01, "dng").expect("decode pano_01 frame");
    assert!(
        ingest
            .applied_opcodes
            .iter()
            .any(|l| l.starts_with("GainMap"))
            && ingest
                .applied_opcodes
                .iter()
                .any(|l| l.starts_with("WarpRectilinear")),
        "L2D-20c must apply GainMap + WarpRectilinear, got {:?}",
        ingest.applied_opcodes
    );

    let p00 = std::fs::read(crate::test_support::fixtures::require_raw(
        "pano_00/0000.DNG",
    ))
    .expect("read 0000.DNG");
    let ingest = decode_for_pano(&p00, "dng").expect("decode pano_00 frame");
    assert!(
        ingest
            .applied_opcodes
            .iter()
            .any(|l| l.starts_with("WarpRectilinear")),
        "L3D-100c must apply WarpRectilinear, got {:?}",
        ingest.applied_opcodes
    );
}
