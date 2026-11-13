//! The capture base (#5381): a decode with its base renders the capture
//! decode's pixels, a refine of the base from new refinable-stage values
//! equals a fresh decode at those values, and anything else is refused.

use super::super::tests::{chart_raw, engaged_capture};
use super::*;
use crate::image::{ExifOrientation, RawImage};
use crate::pipeline::{
    finish_capture_refine, render_capture_sized_from_raw_f32,
    render_capture_with_base_from_raw_f32, CaptureRender, RenderQuality,
};
use crate::types::{Point2, RetouchKind, RetouchSpot};

fn decode(raw: &RawImage, model: &AdjustmentModel) -> CaptureRender {
    render_capture_sized_from_raw_f32(raw, model, RenderQuality::Full, 64, CancelToken::never())
        .unwrap()
}

fn with_base(raw: &RawImage, model: &AdjustmentModel) -> (CaptureRender, CaptureBase) {
    render_capture_with_base_from_raw_f32(
        raw,
        (model, model),
        RenderQuality::Full,
        Some(64),
        CancelToken::never(),
    )
    .unwrap()
}

fn assert_same(got: &CaptureRender, want: &CaptureRender) {
    assert_eq!((got.width, got.height), (want.width, want.height));
    assert_eq!(got.rgba, want.rgba);
    assert_eq!(
        got.whites_anchor_ev.to_bits(),
        want.whites_anchor_ev.to_bits()
    );
    let (a, b) = (got.creative.ae_gain, want.creative.ae_gain);
    assert!((a - b).abs() <= 1e-6 * b.abs(), "ae gain {a} vs {b}");
}

fn denoised() -> AdjustmentModel {
    AdjustmentModel {
        deep_denoise: 35.0,
        ..engaged_capture()
    }
}

fn rotated() -> RawImage {
    RawImage {
        orientation: ExifOrientation::Rotate90,
        ..chart_raw()
    }
}

#[test]
fn a_decode_with_its_base_is_the_capture_decode() {
    for raw in [chart_raw(), rotated()] {
        for model in [AdjustmentModel::default(), engaged_capture(), denoised()] {
            let (render, _) = with_base(&raw, &model);
            assert_same(&render, &decode(&raw, &model));
        }
    }
}

#[test]
fn a_refine_from_the_base_is_a_fresh_decode() {
    for raw in [chart_raw(), rotated()] {
        let (_, base) = with_base(&raw, &AdjustmentModel::default());
        for target in [engaged_capture(), denoised(), AdjustmentModel::default()] {
            let model = base.refine_model(&target).expect("refinable");
            let refined = base
                .refine_cpu(&model, Chain::Sized, CancelToken::never())
                .unwrap();
            let rgba: Vec<f32> = refined
                .pixels
                .iter()
                .flat_map(|p| [p[0], p[1], p[2], 1.0])
                .collect();
            let render = finish_capture_refine(&base, &rgba, &model).unwrap();
            assert_same(&render, &decode(&raw, &target));
        }
    }
}

#[test]
fn only_the_refinable_stages_may_change() {
    let (_, base) = with_base(&chart_raw(), &engaged_capture());
    assert_eq!(base.dims(), (64, 64));
    assert_eq!(base.rgba().len(), 64 * 64 * 4);
    let refusals = [
        AdjustmentModel {
            retouch_spots: vec![RetouchSpot::new(
                RetouchKind::Heal,
                Point2::new(0.3, 0.3),
                Point2::new(0.6, 0.6),
                0.1,
            )],
            ..engaged_capture()
        },
        AdjustmentModel {
            highlight_recovery: crate::xmp::HighlightRecoveryMode::OklabChromaReduction,
            ..engaged_capture()
        },
        AdjustmentModel {
            auto_exposure: crate::xmp::AutoExposureMode::Off,
            ..engaged_capture()
        },
    ];
    for model in refusals {
        assert!(base.refine_model(&model).is_none());
    }
    #[allow(deprecated)]
    let sharper = AdjustmentModel {
        capture_sharpening_sigma: 1.6,
        capture_sharpening_radius: 1.6,
        chroma_prefilter: 0.0,
        deep_denoise: 80.0,
        ..engaged_capture()
    };
    let model = base.refine_model(&sharper).expect("refinable");
    assert_eq!(model, sharper);
    let stages = CaptureRefineStages::of(&model);
    assert_eq!((stages.chroma_prefilter, stages.deep_denoise), (0.0, 80.0));
    assert_eq!(stages.sharpening.map(|p| p.sigma), Some(1.6));
    assert!(finish_capture_refine(&base, &[0.0; 4], &model).is_err());
}
