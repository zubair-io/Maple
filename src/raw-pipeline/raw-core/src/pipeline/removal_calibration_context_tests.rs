use super::tests::source;
use super::*;
use crate::image::ExifOrientation;
use std::sync::atomic::AtomicBool;

#[test]
fn bounded_context_matches_whole_plate_at_crop_offsets_and_exif() {
    use crate::types::accepted_removal::NativeWindow;
    let mut raw = source();
    let plate = render_removal_calibration_plate(&raw, CancelToken::never()).unwrap();
    for window in [
        NativeWindow {
            x: 0,
            y: 0,
            width: 12,
            height: 6,
        },
        NativeWindow {
            x: 3,
            y: 1,
            width: 6,
            height: 3,
        },
        NativeWindow {
            x: 11,
            y: 5,
            width: 1,
            height: 1,
        },
    ] {
        for orientation in 1..=8 {
            raw.orientation = ExifOrientation::from_u16(orientation);
            let context =
                render_removal_calibration_context(&raw, window, CancelToken::never()).unwrap();
            assert_eq!(
                (context.width, context.height),
                (window.width, window.height)
            );
            for y in 0..window.height {
                for x in 0..window.width {
                    assert_eq!(
                        context.pixels[(y * window.width + x) as usize],
                        plate.pixels[((y + window.y) * plate.width + x + window.x) as usize]
                    );
                }
            }
        }
    }
}

#[test]
fn bounded_context_refuses_invalid_windows_and_inconsistent_linear_data() {
    use crate::types::accepted_removal::NativeWindow;
    let mut raw = source();
    let valid = NativeWindow {
        x: 0,
        y: 0,
        width: 6,
        height: 3,
    };
    assert!(render_removal_calibration_context(
        &raw,
        NativeWindow {
            x: 11,
            y: 5,
            width: 2,
            height: 1
        },
        CancelToken::never()
    )
    .is_err());
    let flag = AtomicBool::new(true);
    assert!(matches!(
        render_removal_calibration_context(&raw, valid, CancelToken::new(&flag)),
        Err(Error::Cancelled)
    ));
    let mut large = source();
    large.width = 2048;
    large.height = 2048;
    large.crop_rect = None;
    assert!(render_removal_calibration_context(
        &large,
        NativeWindow {
            x: 0,
            y: 0,
            width: 1025,
            height: 1024
        },
        CancelToken::never()
    )
    .unwrap_err()
    .to_string()
    .contains("probe budget"));
    assert!(render_removal_calibration_context(
        &large,
        NativeWindow {
            x: 0,
            y: 0,
            width: 1025,
            height: 1
        },
        CancelToken::never()
    )
    .unwrap_err()
    .to_string()
    .contains("probe budget"));
    raw.cfa = crate::CfaPattern::LinearRgb;
    assert!(
        render_removal_calibration_context(&raw, valid, CancelToken::never())
            .unwrap_err()
            .to_string()
            .contains("LinearRaw")
    );
}

#[test]
fn bounded_amaze_context_uses_the_full_sensor_tile_grid() {
    let mut raw = source();
    raw.width = 512;
    raw.height = 384;
    raw.crop_rect = Some(crate::image::CropRect {
        x: 2,
        y: 2,
        w: 500,
        h: 370,
    });
    raw.lens_metadata.active_area = None;
    raw.raw_data = (0..raw.width * raw.height)
        .map(|i| {
            let x = i % raw.width;
            let y = i / raw.width;
            (1000 + (x * 977 + y * 61 + x * y * 13) % 5000) as u16
        })
        .collect();
    let plate = render_removal_calibration_plate(&raw, CancelToken::never()).unwrap();
    for window in [
        crate::types::accepted_removal::NativeWindow {
            x: 17,
            y: 83,
            width: 213,
            height: 171,
        },
        crate::types::accepted_removal::NativeWindow {
            x: 277,
            y: 201,
            width: 223,
            height: 169,
        },
    ] {
        let context =
            render_removal_calibration_context(&raw, window, CancelToken::never()).unwrap();
        for y in 0..window.height {
            for x in 0..window.width {
                assert_eq!(
                    context.pixels[(y * window.width + x) as usize],
                    plate.pixels[((y + window.y) * plate.width + x + window.x) as usize],
                    "global ({}, {})",
                    window.x + x,
                    window.y + y
                );
            }
        }
    }
}
