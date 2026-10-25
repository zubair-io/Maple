//! The creative stage on a physical scene (#5376): test_0007's own profile
//! (dual-illuminant ForwardMatrix and HueSatMap) and slider frame, over its
//! scene-linear render as the capture-basis pixels.

use super::tests_creative::{custom, image_of, run_creative};
use crate::context::GpuContext;
use raw_core::{
    color::dcp,
    pipeline::{
        render_scene_linear_sized_from_raw_with_quality_f32_cancellable, CreativeAnchors,
        CreativeStage, RenderQuality,
    },
    stages::wb_camera::SliderFrame,
    types::adjustment::AutoExposureMode,
    xmp::{AdjustmentModel, HighlightRecoveryMode},
    CancelToken,
};

fn percentile(sorted: &[f32], per_mille: usize) -> f32 {
    sorted[sorted.len() * per_mille / 1000]
}

#[test]
#[ignore = "physical RAW, explicitly provision test-fixtures/raws/test_0007.DNG"]
fn creative_stage_matches_the_cpu_oracle_on_test_0007() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0007.DNG");
    let raw = raw_core::decode::decode(&path).expect("physical test_0007.DNG required");
    let profile = dcp::profile_for(&raw).unwrap();
    let stage = CreativeStage {
        frame: Some(SliderFrame::resolve(&raw, &profile)),
        profile,
        as_shot_neutral: raw.as_shot_neutral,
        anchors: CreativeAnchors::Given {
            ae_gain: 1.3,
            decoded_wb: None,
        },
    };
    let scene = AdjustmentModel {
        auto_exposure: AutoExposureMode::Off,
        nr_color: 0.0,
        sharpen_amount: 0.0,
        ..Default::default()
    };
    let (w, h, rgba) = render_scene_linear_sized_from_raw_with_quality_f32_cancellable(
        &raw,
        &scene,
        RenderQuality::Preview,
        1536,
        CancelToken::never(),
    )
    .unwrap();
    let ctx = GpuContext::new_blocking().expect("GPU required");
    for (temperature, tint, recovery) in [
        (2850.0, 0.0, HighlightRecoveryMode::Off),
        (4300.0, 15.0, HighlightRecoveryMode::Off),
        (7800.0, -10.0, HighlightRecoveryMode::Off),
        (12000.0, 25.0, HighlightRecoveryMode::Off),
        (4300.0, 15.0, HighlightRecoveryMode::OklabChromaReduction),
    ] {
        let model = custom(temperature, tint, recovery);
        let (cpu, _) = stage.render_basis(image_of(&rgba, w), &model).unwrap();
        let gpu = run_creative(&ctx, &stage, &model, &rgba, w);
        let mut errors: Vec<f32> = gpu
            .chunks_exact(4)
            .zip(&cpu.pixels)
            .flat_map(|(g, c)| (0..3).map(move |k| (g[k] - c[k]).abs() / c[k].abs().max(1.0)))
            .collect();
        errors.sort_unstable_by(f32::total_cmp);
        let mean = errors.iter().map(|e| f64::from(*e)).sum::<f64>() / errors.len() as f64;
        let (p999, max) = (percentile(&errors, 999), errors[errors.len() - 1]);
        eprintln!(
            "CREATIVE physical test_0007 {w}x{h} T={temperature} tint={tint} {recovery:?}: \
             mean {mean:e} p99.9 {p999:e} max {max:e}"
        );
        assert!(mean <= 1e-6, "mean relative error {mean}");
        assert!(max < 1e-4, "max relative error {max}");
    }
}
