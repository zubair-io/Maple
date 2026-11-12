//! The share of a bundled vignetting gain a preview carries is recovered
//! from a synthetic frame whose preview was rendered with a known share.

use super::*;
use crate::image::CropRect;
use crate::lens_profile::lensfun::tests_auto::{canon_with_bundled_vignetting, sony};
use crate::pipeline::pano::opcodes::OpcodeList3;
use crate::view::auto_profile::preview::JpegColorSpace;

const W: u32 = 1536;
const H: u32 = 1024;
/// Preview pixels per sensor pixel, each axis.
const PREVIEW_STEP: u32 = 4;

/// Scene luminance in 48 px patches whose levels are unrelated to radius, so
/// equal luminances occur at every distance from the centre.
fn scene(x: u32, y: u32) -> f32 {
    let patch = (x / 48).wrapping_mul(73_856_093) ^ (y / 48).wrapping_mul(19_349_663);
    0.02 + 0.5 * (patch % 1000) as f32 / 1000.0
}

/// The `test_0007` identity (a bundled vignetting calibration) recording
/// [`scene`], as demosaiced RGB or as an RGGB mosaic.
pub(crate) fn frame(cfa: CfaPattern) -> RawImage {
    let mut raw = canon_with_bundled_vignetting();
    let planes = if cfa == CfaPattern::LinearRgb { 3 } else { 1 };
    raw.width = W;
    raw.height = H;
    raw.cfa = cfa;
    raw.raw_data = (0..H)
        .flat_map(|y| (0..W).flat_map(move |x| [(scene(x, y) * 65535.0) as u16; 3]))
        .step_by(3 / planes)
        .collect();
    raw.lens_metadata.active_area = Some(ActiveAreaRect::full(W, H));
    raw
}

/// The preview a camera carrying `share` of the bundled gain would embed:
/// the develop frame through one display tone response.
pub(crate) fn preview(raw: &RawImage, share: f32) -> ExtractedPreview {
    let vignette = lens_profile::resolve_auto(raw)
        .unwrap()
        .expect("bundled match")
        .calibration
        .vignette
        .expect("vignetting family");
    let (left, top, w, h) = raw.crop_rect.map_or((0, 0, W, H), |c| (c.x, c.y, c.w, c.h));
    let image = image::RgbImage::from_fn(w / PREVIEW_STEP, h / PREVIEW_STEP, |px, py| {
        let (x, y) = (
            left + px * PREVIEW_STEP + PREVIEW_STEP / 2,
            top + py * PREVIEW_STEP + PREVIEW_STEP / 2,
        );
        let gain = vignette
            .gain(f64::from(W), f64::from(H), [f64::from(x), f64::from(y)])
            .expect("positive illumination") as f32;
        let lit = scene(x, y) * gain.powf(share);
        image::Rgb([(lit.min(1.0).powf(1.0 / 2.2) * 255.0).round() as u8; 3])
    });
    ExtractedPreview {
        image: image::DynamicImage::ImageRgb8(image),
        color_space: JpegColorSpace::SRgb,
    }
}

#[test]
fn the_share_a_preview_carries_is_recovered() {
    for cfa in [CfaPattern::LinearRgb, CfaPattern::Rggb] {
        let raw = frame(cfa);
        for (share, expected) in [(0.0, 0.0), (0.5, 50.0), (1.0, 100.0)] {
            let measured = scale(&raw, &preview(&raw, share));
            assert!(
                (measured - expected).abs() <= 5.0,
                "{cfa:?} share {share}: measured {measured}"
            );
        }
    }
}

/// The gain is evaluated in active-area coordinates and the cells laid over
/// the develop frame, so a `DefaultCrop` inset changes nothing.
#[test]
fn the_develop_frame_follows_the_default_crop() {
    let mut raw = frame(CfaPattern::Rggb);
    raw.crop_rect = Some(CropRect {
        x: 48,
        y: 32,
        w: W - 96,
        h: H - 64,
    });
    for (share, expected) in [(0.0, 0.0), (1.0, 100.0)] {
        let measured = scale(&raw, &preview(&raw, share));
        assert!(
            (measured - expected).abs() <= 5.0,
            "share {share}: measured {measured}"
        );
    }
}

#[test]
fn nothing_external_or_nothing_decisive_keeps_the_authored_scale() {
    let authored = AdjustmentModel::default().lens_correction_vignetting;
    let raw = frame(CfaPattern::LinearRgb);
    let uncorrected = preview(&raw, 0.0);
    assert_eq!(scale(&raw, &uncorrected), 0.0);

    // Embedded corrections are the vendor's and are in the vendor's preview.
    let mut embedded = frame(CfaPattern::LinearRgb);
    embedded.opcode_list3 = Some((
        OpcodeList3 {
            opcodes: vec![],
            skipped: Vec::new(),
        },
        ActiveAreaRect::full(W, H),
    ));
    assert_eq!(scale(&embedded, &uncorrected), authored);

    // A bundled match without a vignetting family has no gain to weigh.
    let mut no_family = frame(CfaPattern::LinearRgb);
    let sony = sony();
    no_family.camera_make = sony.camera_make;
    no_family.camera_model = sony.camera_model;
    no_family.lens_metadata = crate::lens_profile::LensMetadata {
        active_area: Some(ActiveAreaRect::full(W, H)),
        ..sony.lens_metadata
    };
    assert_eq!(scale(&no_family, &uncorrected), authored);

    // A preview that says nothing about tone cannot move the reading.
    let flat = ExtractedPreview {
        image: image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            W / PREVIEW_STEP,
            H / PREVIEW_STEP,
            image::Rgb([128; 3]),
        )),
        color_space: JpegColorSpace::SRgb,
    };
    assert_eq!(scale(&raw, &flat), authored);
}
