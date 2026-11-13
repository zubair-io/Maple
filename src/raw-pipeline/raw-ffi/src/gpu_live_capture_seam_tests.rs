//! The S3 live-vs-refine gate of the capture-first live chain (#5213,
//! #5377), on real bodies (fixture-gated, real GPU): the GPU chain over a
//! capture decode, driven through `MapleGpuLiveParams::creative_ptr`, against
//! a fresh sized develop of the same model, within one 8-bit step on every
//! channel, at the as-shot white balance, ±800 K, 2000 K and 50000 K, across
//! deep denoise, chroma prefilter, retouch, capture sharpening, Oklab
//! recovery and auto exposure.
//!
//! The white-balance tick latency is `raw-gpu`'s `creative-live-timing`
//! example.

use super::gpu_live_capture_tests::{max_step, neutral_tail, no_auto_profile, view_u8};
use super::gpu_live_tests::{make_params, owned_arrays};
use super::gpu_live_wb_frame_tests::gpu_render;
use crate::capture_creative::MapleCaptureCreative;
use raw_core::image::{ColorSpace, Image};
use raw_core::pipeline::{CaptureRender, RenderQuality};
use raw_core::types::adjustment::AutoExposureMode;
use raw_core::types::local_adjustment::Point2;
use raw_core::types::{RetouchKind, RetouchSpot, WbMethod};
use raw_core::view::auto_profile::curve::ProfileCurve;
use raw_core::view::auto_profile::lut::ColorLut;
use raw_core::xmp::{AdjustmentModel, HighlightRecoveryMode};
use raw_core::CancelToken;

const EDGE: u32 = 512;

fn decode(name: &str) -> raw_core::RawImage {
    let path = raw_core::test_support::fixtures::require_raw(name);
    let bytes = std::fs::read(&path).expect("read fixture");
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("dng");
    raw_core::decode::decode_bytes(&bytes, ext).expect("decode fixture")
}

/// The capture-stage and decode-level combinations the gate covers. White
/// balance stays unauthored: the capture never sees it.
fn combinations() -> Vec<(&'static str, AdjustmentModel)> {
    let base = AdjustmentModel {
        temperature_seen: false,
        tint_seen: false,
        ..neutral_tail(6500.0, 0.0)
    };
    let spot = RetouchSpot {
        kind: RetouchKind::Heal,
        center: Point2::new(0.42, 0.4),
        source: Point2::new(0.62, 0.58),
        radius: 0.06,
        feather: 0.4,
        opacity: 1.0,
    };
    let every_stage = AdjustmentModel {
        chroma_prefilter: 60.0,
        deep_denoise: 50.0,
        retouch_spots: vec![spot],
        capture_sharpening_amount: 80.0,
        highlight_recovery: HighlightRecoveryMode::OklabChromaReduction,
        ..base.clone()
    };
    vec![
        ("plain", base.clone()),
        (
            "chroma",
            AdjustmentModel {
                chroma_prefilter: 60.0,
                ..base.clone()
            },
        ),
        (
            "denoise",
            AdjustmentModel {
                deep_denoise: 50.0,
                ..base.clone()
            },
        ),
        (
            "retouch",
            AdjustmentModel {
                retouch_spots: vec![spot],
                ..base.clone()
            },
        ),
        (
            "sharpening",
            AdjustmentModel {
                capture_sharpening_amount: 80.0,
                ..base.clone()
            },
        ),
        (
            "oklab-recovery",
            AdjustmentModel {
                highlight_recovery: HighlightRecoveryMode::OklabChromaReduction,
                ..base.clone()
            },
        ),
        (
            "ae-off",
            AdjustmentModel {
                auto_exposure: AutoExposureMode::Off,
                ..base.clone()
            },
        ),
        ("every-stage", every_stage.clone()),
        (
            "every-stage-ae-off",
            AdjustmentModel {
                auto_exposure: AutoExposureMode::Off,
                ..every_stage
            },
        ),
    ]
}

fn capture_of(
    raw: &raw_core::RawImage,
    model: &AdjustmentModel,
) -> (CaptureRender, MapleCaptureCreative) {
    let capture = raw_core::pipeline::render_capture_sized_from_raw_f32(
        raw,
        model,
        RenderQuality::Preview,
        EDGE,
        CancelToken::never(),
    )
    .expect("capture decode");
    let tables = crate::wb_frame_flat::intern_table_wire(capture.tables.floats());
    let creative = MapleCaptureCreative::new(&capture.creative, tables);
    (capture, creative)
}

fn targets(capture: &CaptureRender) -> Vec<(&'static str, (f32, f32))> {
    let frame = capture.creative.frame.expect("a calibrated body");
    let (cct, tint) = (frame.scene_cct, frame.scene_tint);
    vec![
        ("as-shot", (cct, tint)),
        ("+800K", (cct + 800.0, tint)),
        ("-800K", (cct - 800.0, tint)),
        ("2000K", (2000.0, tint)),
        ("50000K", (50000.0, tint)),
    ]
}

fn refine(raw: &raw_core::RawImage, model: &AdjustmentModel) -> Vec<u8> {
    let (w, h, rgba) =
        raw_core::pipeline::render_scene_linear_sized_from_raw_with_quality_f32_cancellable(
            raw,
            model,
            RenderQuality::Preview,
            EDGE,
            CancelToken::never(),
        )
        .expect("refine develop");
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (p, px) in img.pixels.iter_mut().zip(rgba.chunks_exact(4)) {
        *p = [px[0], px[1], px[2]];
    }
    view_u8(img)
}

fn live(
    capture: &CaptureRender,
    creative: &MapleCaptureCreative,
    model: &AdjustmentModel,
) -> Vec<u8> {
    let (curve, lut) = (ProfileCurve::identity(), ColorLut::identity(2));
    let arr = owned_arrays(model, &curve, &lut);
    let mut p = make_params(&capture.rgba, model, WbMethod::Cat16, 2, &arr);
    no_auto_profile(&mut p);
    p.whites_anchor_ev = capture.whites_anchor_ev;
    p.creative_ptr = creative;
    gpu_render(&capture.rgba, capture.width, capture.height, &p)
}

fn gate(name: &str) {
    let raw = decode(name);
    let mut worst = 0u8;
    for (combination, decode_model) in combinations() {
        let (capture, creative) = capture_of(&raw, &decode_model);
        for (target, (temperature, tint)) in targets(&capture) {
            let model = AdjustmentModel {
                temperature,
                tint,
                temperature_seen: true,
                tint_seen: true,
                ..decode_model.clone()
            };
            let (refined, shown) = (refine(&raw, &model), live(&capture, &creative, &model));
            assert_eq!(refined.len(), shown.len());
            let step = max_step(&shown, &refined);
            let moved = shown.iter().zip(&refined).filter(|(a, b)| a != b).count();
            eprintln!(
                "{name} [{combination} @ {target}] live vs refine: max step {step}, \
                 {moved}/{} channels differ, ae_gain {:.4}",
                shown.len(),
                capture.creative.ae_gain
            );
            worst = worst.max(step);
            assert!(step <= 1, "{name} [{combination} @ {target}]: {step} steps");
        }
    }
    eprintln!("{name}: worst live-vs-refine step {worst}");
}

#[test]
#[cfg_attr(
    not(feature = "fixtures"),
    ignore = "needs test-fixtures/raws (fixtures feature)"
)]
fn live_matches_refine_within_one_step_on_test_0005() {
    gate("test_0005.RAF");
}

#[test]
#[cfg_attr(
    not(feature = "fixtures"),
    ignore = "needs test-fixtures/raws (fixtures feature)"
)]
fn live_matches_refine_within_one_step_on_test_0007() {
    gate("test_0007.DNG");
}
