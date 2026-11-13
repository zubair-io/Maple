//! Display/export share the saved stack, current grade and terminal geometry.
use super::*;
use crate::{
    pipeline::{ExportDepth, ExportPixels, RawInput, RenderQuality},
    view::encode::TargetPrimaries,
};

#[test]
fn accepted_preview_and_both_export_depths_share_pixels_and_geometry() {
    let (raw, original, model, assets) = super::tests::fixture();
    let stack =
        ResolvedCalibrationRemovals::prepare(&raw, &original, &model.inpaint_removals, &assets)
            .unwrap();
    let source = Some(RawInput::Bytes {
        bytes: super::tests::RAW,
        ext: "dng",
    });
    for cap in [None, Some(4), Some(64)] {
        for exposure in [-2.0, 1.0] {
            let grade = AdjustmentModel {
                exposure,
                ..model.clone()
            };
            let display = stack
                .render_display(
                    &raw,
                    &original,
                    &grade,
                    RenderQuality::Amaze,
                    source,
                    cap,
                    None,
                )
                .unwrap();
            let (w, h, export) = stack
                .render_export(
                    &raw,
                    &original,
                    &grade,
                    RenderQuality::Amaze,
                    source,
                    cap,
                    TargetPrimaries::Srgb,
                    ExportDepth::Eight,
                    None,
                )
                .unwrap();
            let ExportPixels::Eight(bytes) = export else {
                panic!("wrong depth")
            };
            assert_eq!(display, (w, h, bytes.clone()));
            let (w16, h16, export16) = stack
                .render_export(
                    &raw,
                    &original,
                    &grade,
                    RenderQuality::Amaze,
                    source,
                    cap,
                    TargetPrimaries::Srgb,
                    ExportDepth::Sixteen,
                    None,
                )
                .unwrap();
            let ExportPixels::Sixteen(samples) = export16 else {
                panic!("wrong depth")
            };
            assert_eq!((w16, h16), (w, h));
            assert_eq!(samples.len(), bytes.len());
            for (a, b) in bytes.iter().zip(samples) {
                assert!((*a as f32 / 255.0 - b as f32 / 65535.0).abs() <= 1.0 / 255.0);
            }
        }
    }
}

#[test]
fn empty_stack_is_identical_to_ordinary_render_and_export_at_each_depth() {
    let (raw, original, mut model, _) = super::tests::fixture();
    model.inpaint_removals.clear();
    let stack =
        ResolvedCalibrationRemovals::prepare(&raw, &original, &[], &BTreeMap::new()).unwrap();
    for cap in [None, Some(4), Some(64)] {
        for target in [TargetPrimaries::Srgb, TargetPrimaries::P3] {
            for depth in [ExportDepth::Eight, ExportDepth::Sixteen] {
                let actual = stack
                    .render_export(
                        &raw,
                        &original,
                        &model,
                        RenderQuality::Amaze,
                        None,
                        cap,
                        target,
                        depth,
                        None,
                    )
                    .unwrap();
                let expected = crate::pipeline::render_export_from_raw(
                    &raw,
                    &model,
                    RenderQuality::Amaze,
                    None,
                    cap,
                    target,
                    depth,
                )
                .unwrap();
                assert_eq!((actual.0, actual.1), (expected.0, expected.1));
                match (actual.2, expected.2) {
                    (ExportPixels::Eight(a), ExportPixels::Eight(b)) => assert_eq!(a, b),
                    (ExportPixels::Sixteen(a), ExportPixels::Sixteen(b)) => assert_eq!(a, b),
                    _ => panic!("depth changed"),
                }
            }
        }
    }
}

#[test]
fn stale_preparation_blocks_display_and_export() {
    let (raw, original, mut model, assets) = super::tests::fixture();
    let stack =
        ResolvedCalibrationRemovals::prepare(&raw, &original, &model.inpaint_removals, &assets)
            .unwrap();
    model.inpaint_removals.reverse();
    assert!(stack
        .render_display(
            &raw,
            &original,
            &model,
            RenderQuality::Amaze,
            None,
            Some(4),
            None
        )
        .is_err());
    assert!(stack
        .render_export(
            &raw,
            &original,
            &model,
            RenderQuality::Amaze,
            None,
            None,
            TargetPrimaries::Srgb,
            ExportDepth::Sixteen,
            None
        )
        .is_err());
}
