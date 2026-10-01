//! Native source-window parity for already-demosaiced and 6×6 RAWs (#3955).
use super::tests::source;
use super::*;
use crate::{image::CropRect, types::accepted_removal::NativeWindow, CfaPattern};

fn textured(cfa: CfaPattern, white_level: u32) -> RawImage {
    let mut raw = source();
    raw.width = 319;
    raw.height = 257;
    raw.crop_rect = Some(CropRect {
        x: 3,
        y: 5,
        w: 307,
        h: 247,
    });
    raw.lens_metadata.active_area = Some(crate::pipeline::pano::opcodes::ActiveAreaRect {
        top: 8,
        left: 8,
        height: 240,
        width: 300,
    });
    raw.cfa = cfa;
    raw.white_level = white_level;
    raw.black_level = if white_level <= 255 {
        [3, 5, 7, 11]
    } else {
        [64, 65, 66, 67]
    };
    raw.as_shot_neutral = [0.41, 1.0, 0.62];
    raw.baseline_exposure = 1.25;
    let components = if cfa == CfaPattern::LinearRgb { 3 } else { 1 };
    raw.raw_data = (0..raw.width * raw.height * components)
        .map(|i| ((i * 977 + i % 137 * 61) % (u32::from(white_level) + 1)) as u16)
        .collect();
    raw
}

fn verify(raw: &RawImage) {
    let original = raw.raw_data.clone();
    let plate = render_removal_calibration_plate(raw, CancelToken::never()).unwrap();
    let windows = [
        NativeWindow {
            x: 0,
            y: 0,
            width: 29,
            height: 31,
        },
        NativeWindow {
            x: 81,
            y: 97,
            width: 87,
            height: 61,
        },
        NativeWindow {
            x: 238,
            y: 186,
            width: 69,
            height: 61,
        },
        NativeWindow {
            x: 306,
            y: 246,
            width: 1,
            height: 1,
        },
    ];
    for orientation in 1..=8 {
        let mut oriented = raw.clone();
        oriented.orientation = crate::image::ExifOrientation::from_u16(orientation);
        for window in windows {
            let context =
                render_removal_calibration_context(&oriented, window, CancelToken::never())
                    .unwrap();
            assert_eq!(
                (context.width, context.height),
                (window.width, window.height)
            );
            for y in 0..window.height {
                for x in 0..window.width {
                    assert_eq!(
                        context.pixels[(y * window.width + x) as usize].map(f32::to_bits),
                        plate.pixels[((y + window.y) * plate.width + x + window.x) as usize]
                            .map(f32::to_bits),
                        "{:?}: global ({}, {})",
                        raw.cfa,
                        window.x + x,
                        window.y + y
                    );
                }
            }
        }
    }
    assert_eq!(raw.raw_data, original);
}

#[test]
fn bounded_linearraw_matches_whole_with_baked_and_unbaked_wb() {
    for white_level in [255, 4095] {
        verify(&textured(CfaPattern::LinearRgb, white_level));
    }
}

#[test]
fn bounded_xtrans_matches_whole_with_six_pixel_phase_and_clips() {
    let pattern = [
        1, 1, 0, 1, 1, 2, 1, 1, 2, 1, 1, 0, 2, 0, 1, 0, 2, 1, 1, 1, 2, 1, 1, 0, 1, 1, 0, 1, 1, 2,
        0, 2, 1, 2, 0, 1,
    ];
    verify(&textured(CfaPattern::XTrans(pattern), 4095));
}

#[test]
fn bounded_linearraw_region_checks_bounds_before_allocation() {
    let raw = textured(CfaPattern::LinearRgb, 255);
    for (x, y, width, height) in [(319, 0, 1, 1), (0, 257, 1, 1), (u32::MAX, 0, 1, 1)] {
        assert!(
            crate::linearize::linearraw_to_camera_rgb_region(&raw, x, y, width, height).is_err()
        );
    }
    let flag = std::sync::atomic::AtomicBool::new(true);
    assert!(matches!(
        render_removal_calibration_context(
            &raw,
            NativeWindow {
                x: 0,
                y: 0,
                width: 1,
                height: 1
            },
            CancelToken::new(&flag)
        ),
        Err(Error::Cancelled)
    ));
}
