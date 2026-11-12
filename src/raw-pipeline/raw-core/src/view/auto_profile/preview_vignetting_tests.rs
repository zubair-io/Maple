//! The share of a bundled vignetting gain a preview carries is recovered
//! from a synthetic frame whose preview was rendered with a known share.

use super::*;
use crate::image::{CropRect, ExifOrientation};
use crate::lens_profile::lensfun::tests_auto::{canon_with_bundled_vignetting, sony};
use crate::pipeline::pano::opcodes::OpcodeList3;
use crate::view::auto_profile::preview::JpegColorSpace;

/// A Fujifilm 6×6 X-Trans layout.
const XTRANS: [u8; 36] = [
    1, 1, 0, 1, 1, 2, 1, 1, 2, 1, 1, 0, 2, 0, 1, 0, 2, 1, 1, 1, 2, 1, 1, 0, 1, 1, 0, 1, 1, 2, 0, 2,
    1, 2, 0, 1,
];

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

/// The sensor pixel under preview pixel `(px, py)` of a develop frame whose
/// top-left is `(left, top)`.
fn under(left: u32, top: u32, px: u32, py: u32) -> (u32, u32) {
    (
        left + px * PREVIEW_STEP + PREVIEW_STEP / 2,
        top + py * PREVIEW_STEP + PREVIEW_STEP / 2,
    )
}

/// The display tone response every synthetic preview is encoded with.
fn encode(lit: f32) -> u8 {
    (lit.min(1.0).powf(1.0 / 2.2) * 255.0).round() as u8
}

/// The preview a camera carrying `share` of the bundled gain would embed:
/// the develop frame lit as the develop applies a share,
/// `1 + share·(g − 1)`, through one display tone response. Sensor-oriented,
/// as an embedded JPEG is stored.
pub(crate) fn preview(raw: &RawImage, share: f32) -> ExtractedPreview {
    let vignette = lens_profile::resolve_auto(raw)
        .unwrap()
        .expect("bundled match")
        .calibration
        .vignette
        .expect("vignetting family");
    let (left, top, w, h) = raw.crop_rect.map_or((0, 0, W, H), |c| (c.x, c.y, c.w, c.h));
    let image = image::RgbImage::from_fn(w / PREVIEW_STEP, h / PREVIEW_STEP, |px, py| {
        let (x, y) = under(left, top, px, py);
        let gain = vignette
            .gain(f64::from(W), f64::from(H), [f64::from(x), f64::from(y)])
            .expect("positive illumination") as f32;
        image::Rgb([encode(scene(x, y) * (1.0 + share * (gain - 1.0))); 3])
    });
    ExtractedPreview {
        image: image::DynamicImage::ImageRgb8(image),
        color_space: JpegColorSpace::SRgb,
    }
}

#[test]
fn the_share_a_preview_carries_is_recovered() {
    for cfa in [
        CfaPattern::LinearRgb,
        CfaPattern::Rggb,
        CfaPattern::XTrans(XTRANS),
    ] {
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

/// An embedded preview is stored sensor-oriented and both sides are turned
/// into the display frame before pairing, so a rotated or mirrored body
/// reads the same share.
#[test]
fn the_reading_holds_under_every_orientation() {
    for orientation in [
        ExifOrientation::Rotate90,
        ExifOrientation::Rotate270,
        ExifOrientation::Rotate180,
        ExifOrientation::Transpose,
        ExifOrientation::HorizontalFlip,
    ] {
        let mut raw = frame(CfaPattern::Rggb);
        raw.orientation = orientation;
        for (share, expected) in [(0.0, 0.0), (0.5, 50.0), (1.0, 100.0)] {
            let measured = scale(&raw, &preview(&raw, share));
            assert!(
                (measured - expected).abs() <= 5.0,
                "{orientation:?} share {share}: measured {measured}"
            );
        }
    }
}

/// The develop applies the scale as `1 + scale/100·(g − 1)`
/// ([`lens_profile::apply_for_raw`]), so developing at the measured scale
/// reproduces the preview it was measured on everywhere, the corners
/// outside the measured 80% included, to within one 0.05 reading step of the
/// corner gain (about 5 code values). A share weighed as `g^s` instead reads
/// a step or two high and misses the corners by up to 12.
#[test]
fn developing_at_the_measured_scale_reproduces_the_preview() {
    const ONE_STEP_AT_THE_CORNER: i32 = 5;
    let raw = frame(CfaPattern::LinearRgb);
    for share in [0.1, 0.25, 0.4, 0.6, 0.75] {
        let preview = preview(&raw, share);
        let measured = scale(&raw, &preview);
        let model = AdjustmentModel {
            lens_correction_vignetting: measured,
            lens_correction_distortion: 0.0,
            lens_correction_ca: 0.0,
            ..AdjustmentModel::default()
        };
        let mut developed = linearize::linearraw_to_camera_rgb(&raw).unwrap();
        lens_profile::apply_for_raw(&raw, &model, &mut developed, 1.0).unwrap();
        let worst = preview
            .image
            .to_rgb8()
            .enumerate_pixels()
            .map(|(px, py, pixel)| {
                let (x, y) = under(0, 0, px, py);
                let lit = developed.pixels[(y * W + x) as usize][1];
                (i32::from(encode(lit)) - i32::from(pixel[0])).abs()
            })
            .max()
            .unwrap();
        assert!(
            (measured - 100.0 * share).abs() <= 5.0 && worst <= ONE_STEP_AT_THE_CORNER,
            "share {share}: developed at {measured}, worst code-value error {worst}"
        );
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
