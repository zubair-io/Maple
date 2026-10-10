use super::*;

fn source() -> RawImage {
    let mut raw = crate::decode_raw(
        include_bytes!("../../../../../test-fixtures/removal/basic/source.dng"),
        "dng",
    )
    .unwrap();
    // Real decoded DNG with a non-uniform mosaic makes every rotation,
    // crop offset and channel-position error observable.
    for (index, value) in raw.raw_data.iter_mut().enumerate() {
        *value = (1000 + index * 17) as u16;
    }
    raw.crop_rect = Some(CropRect {
        x: 2,
        y: 2,
        w: 12,
        h: 6,
    });
    raw
}

#[test]
fn native_default_crop_context_is_independent_of_all_exif_orientations() {
    let mut raw = source();
    let window = NativeWindow {
        x: 3,
        y: 1,
        width: 6,
        height: 3,
    };
    let reference = render_removal_context(&raw, window).unwrap();
    assert_eq!((reference.width, reference.height), (6, 3));
    for value in 1..=8 {
        raw.orientation = ExifOrientation::from_u16(value);
        let context = render_removal_context(&raw, window).unwrap();
        assert_eq!(context.pixels, reference.pixels, "EXIF {value}");
    }
}

#[test]
fn native_context_matches_ungraded_full_frame_crop() {
    let raw = source();
    let window = NativeWindow {
        x: 1,
        y: 0,
        width: 7,
        height: 5,
    };
    let context = render_removal_context(&raw, window).unwrap();
    let full = super::super::develop_scene_linear_from_raw_with_quality(
        &raw,
        &anchor_model(),
        RenderQuality::Amaze,
    )
    .unwrap();
    assert_eq!((full.width, full.height), (12, 6));
    for y in 0..window.height {
        for x in 0..window.width {
            assert_eq!(
                context.pixels[(y * window.width + x) as usize],
                full.pixels[((window.y + y) * full.width + window.x + x) as usize],
            );
        }
    }
}

#[test]
fn invalid_native_window_and_unsupported_source_are_explicit_errors() {
    let mut raw = source();
    let window = NativeWindow {
        x: 11,
        y: 0,
        width: 2,
        height: 2,
    };
    assert!(render_removal_context(&raw, window).is_err());
    raw.cfa = crate::CfaPattern::LinearRgb;
    assert!(render_removal_context(
        &raw,
        NativeWindow {
            x: 0,
            y: 0,
            width: 2,
            height: 2
        }
    )
    .unwrap_err()
    .to_string()
    .contains("LinearRaw"));
}

#[test]
fn dormant_non_identity_lens_opcodes_do_not_change_fixed_source_context() {
    use crate::pipeline::pano::opcodes::{
        ActiveAreaRect, OpcodeList3, PanoOpcode, WarpPlaneParams, WarpRectilinearOpcode,
    };
    let mut raw = source();
    let window = NativeWindow {
        x: 1,
        y: 0,
        width: 7,
        height: 5,
    };
    let reference = render_removal_context(&raw, window).unwrap();
    raw.opcode_list3 = Some((
        OpcodeList3 {
            opcodes: vec![PanoOpcode::WarpRectilinear(WarpRectilinearOpcode {
                planes: vec![WarpPlaneParams {
                    kr: [0.94, 0.08, 0.0, 0.0],
                    kt: [0.001, -0.002],
                }],
                center_x: 0.45,
                center_y: 0.55,
            })],
            skipped_unknown: 0,
        },
        ActiveAreaRect::full(raw.width, raw.height),
    ));
    assert_eq!(
        render_removal_context(&raw, window).unwrap().pixels,
        reference.pixels
    );
    let full = super::super::develop_scene_linear_from_raw_with_quality(
        &raw,
        &anchor_model(),
        RenderQuality::Amaze,
    )
    .unwrap();
    for y in 0..window.height {
        for x in 0..window.width {
            assert_eq!(
                reference.pixels[(y * window.width + x) as usize],
                full.pixels[((window.y + y) * full.width + window.x + x) as usize]
            );
        }
    }
}
