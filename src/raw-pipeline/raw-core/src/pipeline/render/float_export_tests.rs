//! The f32 export terminal is the quantized export terminals minus their
//! quantizer: same colour, same orientation, same geometry, same crop.
use super::*;
use crate::{
    pipeline::{render_export_from_raw, ExportDepth, ExportPixels},
    test_support::synth_chart::SyntheticColorChart,
    types::{Crop, Profile},
};

fn chart() -> RawImage {
    let bytes = SyntheticColorChart::default().write_to_bytes();
    crate::decode::decode_bytes(&bytes, "dng").unwrap()
}

#[test]
fn float_terminal_matches_both_depths_through_orientation_geometry_and_crop() {
    let mut raw = chart();
    for orientation in [
        ExifOrientation::Normal,
        ExifOrientation::Rotate90,
        ExifOrientation::HorizontalFlip,
    ] {
        raw.orientation = orientation;
        for angle in [0.0, 2.0] {
            for geometry in [0.0, 10.0] {
                let model = AdjustmentModel {
                    profile: Profile::Neutral,
                    perspective_vertical: geometry,
                    crop: Crop {
                        top: 0.25,
                        left: 0.25,
                        bottom: 0.75,
                        right: 0.75,
                        angle,
                    },
                    ..AdjustmentModel::default()
                };
                for target in [TargetPrimaries::Srgb, TargetPrimaries::P3] {
                    let (w, h, floats) =
                        render_export_f32(&raw, &model, RenderQuality::Full, None, target, None)
                            .unwrap();
                    assert_eq!(floats.len(), (w * h * 4) as usize);
                    assert!(floats.iter().all(|v| v.is_finite()));
                    // Bilinear weights only sum to one up to f32 rounding, so a
                    // resampled alpha lane is 1.0 within an ulp or two.
                    assert!(floats.chunks_exact(4).all(|px| (px[3] - 1.0).abs() < 1e-5));
                    let rgb: Vec<f32> = floats
                        .chunks_exact(4)
                        .flat_map(|px| px[..3].iter().copied())
                        .collect();
                    for depth in [ExportDepth::Eight, ExportDepth::Sixteen] {
                        let (rw, rh, pixels) = render_export_from_raw(
                            &raw,
                            &model,
                            RenderQuality::Full,
                            None,
                            None,
                            target,
                            depth,
                        )
                        .unwrap();
                        assert_eq!((w, h), (rw, rh));
                        let (scale, reference): (f32, Vec<f32>) = match pixels {
                            ExportPixels::Eight(v) => {
                                (255.0, v.into_iter().map(f32::from).collect())
                            }
                            ExportPixels::Sixteen(v) => {
                                (65535.0, v.into_iter().map(f32::from).collect())
                            }
                        };
                        assert_eq!(rgb.len(), reference.len());
                        // The quantized terminals dither (±0.5 LSB) and truncate,
                        // so each integer sample sits within 1 LSB of the float
                        // value; the warp and the tilted crop then each resample
                        // those integers and round once more (+0.5 LSB apiece).
                        // 2 LSB is the hard bound of that chain, and the only
                        // difference between the two paths.
                        for (value, reference) in rgb.iter().zip(reference) {
                            assert!(
                                (value.clamp(0.0, 1.0) * scale - reference).abs() <= 2.0,
                                "orientation={orientation:?} crop={angle} geometry={geometry} \
                                 target={target:?} depth={depth:?}: {value} vs {reference}"
                            );
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn identity_framing_returns_the_developed_size_without_touching_colour() {
    let raw = chart();
    let model = AdjustmentModel {
        profile: Profile::Neutral,
        ..AdjustmentModel::default()
    };
    let (w, h, floats) = render_export_f32(
        &raw,
        &model,
        RenderQuality::Full,
        None,
        TargetPrimaries::Srgb,
        None,
    )
    .unwrap();
    let scene = render_display_scene(
        &raw,
        &model,
        RenderQuality::Full,
        None,
        None,
        TargetPrimaries::Srgb,
        None,
    )
    .unwrap();
    assert_eq!((w, h), (scene.width, scene.height));
    for (px, expected) in floats.chunks_exact(4).zip(&scene.pixels) {
        assert_eq!(&px[..3], expected);
        assert_eq!(px[3], 1.0);
    }
}
