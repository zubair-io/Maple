//! Masks land where they were authored on an EXIF-rotated RAW (#4426).
//!
//! Every mask kind is authored over the upright frame. The same scene is
//! rendered twice through the export tail (develop → orientation → crop):
//! once as a sensor-framed RAW carrying an orientation tag, once with the
//! pixels already upright and a `Normal` tag. The chain is otherwise
//! pointwise on this synthetic LinearRaw, so the two renders differ only by
//! the dither, which is anchored to sensor pixels — anything past that is a
//! mask evaluated in the wrong frame.

use super::*;
use crate::image::{apply_orientation, CfaPattern, ExifOrientation};
use crate::test_support::synth_dng::SyntheticGreyDng;
use crate::types::{
    BitmapRecipe, BrushDab, Crop, LocalAdjustment, Mask, MaskRaster, PartialAdjustments, Point2,
};
use crate::view::encode::TargetPrimaries;
use crate::xmp::{AutoExposureMode, HighlightRecoveryMode};
use std::sync::Arc;

const SENSOR_W: u32 = 36;
const SENSOR_H: u32 = 20;
const DIGEST: &str = "0123456789abcdef";

fn sensor_raw(orientation: ExifOrientation) -> RawImage {
    let bytes = SyntheticGreyDng {
        width: SENSOR_W,
        height: SENSOR_H,
        as_shot_neutral_override: Some([1.0; 3]),
        color_matrix_1_override: Some(crate::color::matrices::M_XYZ_D65_TO_REC2020.0),
        ..Default::default()
    }
    .write_to_bytes();
    let mut raw = crate::decode::decode_bytes(&bytes, "dng").unwrap();
    raw.cfa = CfaPattern::LinearRgb;
    raw.white_level = 10_000;
    raw.black_level = [0; 4];
    raw.baseline_exposure = 0.0;
    raw.crop_rect = None;
    raw.orientation = orientation;
    raw.raw_data = (0..SENSOR_W * SENSOR_H)
        .flat_map(|i| {
            let (x, y) = ((i % SENSOR_W) as u16, (i / SENSOR_W) as u16);
            [600 + 40 * x, 700 + 50 * y, 900 + 15 * (x + y)]
        })
        .collect();
    raw
}

fn upright_twin(raw: &RawImage) -> RawImage {
    let (width, height, raw_data) =
        apply_orientation(&raw.raw_data, raw.width, raw.height, raw.orientation);
    RawImage {
        width,
        height,
        raw_data,
        orientation: ExifOrientation::Normal,
        ..raw.clone()
    }
}

fn layer(mask: Mask) -> LocalAdjustment {
    LocalAdjustment {
        mask,
        range: None,
        adjustments: PartialAdjustments {
            exposure: Some(2.0),
            ..Default::default()
        },
    }
}

fn asymmetric_raster() -> MaskRaster {
    let (w, h) = (8u32, 6u32);
    let bytes: Vec<u8> = (0..w * h)
        .map(|i| if i % w < 3 && i / w < 4 { 255 } else { 0 })
        .collect();
    MaskRaster::from_u8(1, DIGEST, w, h, &bytes)
}

fn mask_cases() -> Vec<(&'static str, AdjustmentModel)> {
    let base = AdjustmentModel {
        profile: Profile::Neutral,
        auto_exposure: AutoExposureMode::Off,
        highlight_recovery: HighlightRecoveryMode::Off,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        crop: Crop {
            left: 0.1,
            top: 0.05,
            right: 0.85,
            bottom: 0.9,
            angle: 0.0,
        },
        ..Default::default()
    };
    let with = |mask: Mask, rasters: Vec<Arc<MaskRaster>>| AdjustmentModel {
        local_adjustments: vec![layer(mask)],
        mask_rasters: rasters,
        ..base.clone()
    };
    vec![
        (
            "linear",
            with(
                Mask::Linear {
                    start: Point2::new(0.1, 0.2),
                    end: Point2::new(0.6, 0.5),
                    feather: 0.4,
                },
                Vec::new(),
            ),
        ),
        (
            "radial",
            with(
                Mask::Radial {
                    center: Point2::new(0.3, 0.25),
                    radii: Point2::new(0.3, 0.15),
                    angle: 0.4,
                    feather: 0.5,
                    invert: false,
                },
                Vec::new(),
            ),
        ),
        (
            "bitmap",
            with(
                Mask::Bitmap {
                    recipe: BitmapRecipe {
                        digest: DIGEST.into(),
                        ..Default::default()
                    },
                    raster_id: 1,
                },
                vec![Arc::new(asymmetric_raster())],
            ),
        ),
        (
            "brush",
            with(
                Mask::Brush {
                    dabs: vec![
                        BrushDab::new(Point2::new(0.2, 0.2), 0.12, 0.3, 1.0, false),
                        BrushDab::new(Point2::new(0.35, 0.3), 0.12, 0.3, 1.0, false),
                    ],
                    digest: String::new(),
                    raster_id: 0,
                },
                Vec::new(),
            ),
        ),
    ]
}

fn export(
    raw: &RawImage,
    model: &AdjustmentModel,
    max_long_edge: Option<u32>,
) -> (u32, u32, Vec<u8>) {
    let (w, h, pixels) = render_export_from_raw(
        raw,
        model,
        RenderQuality::Full,
        None,
        max_long_edge,
        TargetPrimaries::Srgb,
        ExportDepth::Eight,
    )
    .unwrap();
    let ExportPixels::Eight(rgb) = pixels else {
        panic!("eight-bit export requested");
    };
    (w, h, rgb)
}

fn max_code_delta(a: &[u8], b: &[u8]) -> u8 {
    a.iter()
        .zip(b)
        .map(|(x, y)| x.abs_diff(*y))
        .max()
        .unwrap_or(0)
}

fn assert_mask_follows_orientation(wanted: &str) {
    let (kind, model) = mask_cases()
        .into_iter()
        .find(|(kind, _)| *kind == wanted)
        .expect("known mask kind");
    let unmasked = AdjustmentModel {
        local_adjustments: Vec::new(),
        mask_rasters: Vec::new(),
        ..model.clone()
    };
    for orientation in [
        ExifOrientation::Rotate90,
        ExifOrientation::Rotate270,
        ExifOrientation::Rotate180,
        ExifOrientation::Transverse,
        ExifOrientation::HorizontalFlip,
        ExifOrientation::VerticalFlip,
        ExifOrientation::Transpose,
    ] {
        let rotated = sensor_raw(orientation);
        let upright = upright_twin(&rotated);
        for max_long_edge in [None, Some(24)] {
            let (w, h, expected) = export(&upright, &model, max_long_edge);
            let (rw, rh, actual) = export(&rotated, &model, max_long_edge);
            assert_eq!((rw, rh), (w, h), "{kind} {orientation:?} dims");
            let (_, _, plain) = export(&upright, &unmasked, max_long_edge);
            assert!(
                max_code_delta(&expected, &plain) > 40,
                "{kind}: the mask must visibly engage for this test to mean anything"
            );
            let delta = max_code_delta(&expected, &actual);
            assert!(
                delta <= 2,
                "{kind} {orientation:?} long edge {max_long_edge:?}: rotated RAW differs \
                 from its upright twin by {delta} codes"
            );
        }
    }
}

#[test]
fn linear_mask_lands_in_the_upright_frame_on_a_rotated_cropped_raw() {
    assert_mask_follows_orientation("linear");
}

#[test]
fn radial_mask_lands_in_the_upright_frame_on_a_rotated_cropped_raw() {
    assert_mask_follows_orientation("radial");
}

#[test]
fn bitmap_mask_lands_in_the_upright_frame_on_a_rotated_cropped_raw() {
    assert_mask_follows_orientation("bitmap");
}

#[test]
fn brush_mask_lands_in_the_upright_frame_on_a_rotated_cropped_raw() {
    assert_mask_follows_orientation("brush");
}
