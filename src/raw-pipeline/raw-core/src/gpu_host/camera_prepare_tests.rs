use super::*;
use crate::{
    image::{ColorSpace, Image},
    pipeline::{develop_scene_linear_sized_from_raw_with_quality, RenderQuality},
    types::adjustment::{AutoExposureMode, HighlightRecoveryMode, Profile},
};
use raw_gpu::{ChainRunner, GpuContext, GpuImage};

fn isolated_model() -> AdjustmentModel {
    AdjustmentModel {
        auto_exposure: AutoExposureMode::Off,
        profile: Profile::Neutral,
        highlight_recovery: HighlightRecoveryMode::Off,
        sharpen_amount: 0.,
        nr_color: 0.,
        nr_luminance: 0.,
        ..Default::default()
    }
}

fn assert_same(a: &Image, b: &Image) {
    assert_eq!((a.width, a.height, a.space), (b.width, b.height, b.space));
    assert_eq!(a.pixels, b.pixels);
    assert_eq!(a.whites_anchor_ev, b.whites_anchor_ev);
    assert_eq!(a.nr_sampling_scale, b.nr_sampling_scale);
}

#[test]
fn camera_prefix_is_independent_of_later_controls_and_observes_cancellation() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/batch-transfer");
    for name in ["source.dng", "target.dng"] {
        let raw = crate::decode::decode(&root.join(name)).unwrap();
        let model = isolated_model();
        let (_, camera) =
            GpuCameraColorimetry::prepare(&raw, &model, 32, crate::CancelToken::never()).unwrap();
        assert_eq!(camera.space, ColorSpace::CameraNativeLinearRgb);
        assert!(camera.whites_anchor_ev.unwrap().is_finite());
        assert!(camera.nr_sampling_scale > 0.);
        let changed = AdjustmentModel {
            temperature: 8500.,
            tint: 150.,
            temperature_seen: true,
            tint_seen: true,
            exposure: 2.,
            capture_sharpening_amount: 80.,
            nr_color: 100.,
            hue_adjustment_red: 50.,
            auto_exposure: AutoExposureMode::On,
            ..model
        };
        let (_, repeated) =
            GpuCameraColorimetry::prepare(&raw, &changed, 32, crate::CancelToken::never()).unwrap();
        assert_same(&camera, &repeated);
        let flag = std::sync::atomic::AtomicBool::new(true);
        assert!(matches!(
            GpuCameraColorimetry::prepare(&raw, &changed, 32, crate::CancelToken::new(&flag)),
            Err(crate::Error::Cancelled)
        ));
    }
}

#[test]
#[ignore = "requires physical RAW corpus and GPU adapter"]
fn actual_camera_prefix_and_fused_dcp_match_cpu_photographs() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../test-fixtures/raws");
    for name in [
        "test_0000.DNG",
        "test_0002.dng",
        "test_0006.DNG",
        "test_0007.DNG",
        "test_0013.DNG",
        "test_0005.RAF",
        "test_0012.raf",
        "test_0017.dng",
        "test_0015.dng",
        "test_0018.dng",
        "test_0020.dng",
    ] {
        let raw = crate::decode::decode(&root.join(name)).unwrap();
        let model = AdjustmentModel {
            highlight_recovery: if name == "test_0015.dng" {
                HighlightRecoveryMode::ChromaticAdaptation
            } else {
                HighlightRecoveryMode::Off
            },
            ..isolated_model()
        };
        let (cached, camera) =
            GpuCameraColorimetry::prepare(&raw, &model, 512, crate::CancelToken::never()).unwrap();
        let rgba = camera
            .pixels
            .iter()
            .flat_map(|p| [p[0], p[1], p[2], 1.])
            .collect::<Vec<_>>();
        let image = GpuImage::upload(&ctx, &rgba, camera.width, camera.height);
        let runner = ChainRunner::new(&ctx, &image);
        // Reuse one actual decoded/uploaded image across all these WB ticks.
        for (temperature, tint, temperature_seen, tint_seen) in [
            (6500., 0., false, false),
            (2000., 0., true, true),
            (8500., 150., true, true),
            (8500., -150., true, true),
            (8500., 0., true, false),
            (6500., 150., false, true),
        ] {
            let model = AdjustmentModel {
                temperature,
                tint,
                temperature_seen,
                tint_seen,
                ..model.clone()
            };
            let expected = develop_scene_linear_sized_from_raw_with_quality(
                &raw,
                &model,
                RenderQuality::Amaze,
                512,
            )
            .unwrap();
            assert_eq!(
                (camera.width, camera.height),
                (expected.width, expected.height)
            );
            assert_eq!(camera.whites_anchor_ev, expected.whites_anchor_ev);
            assert_eq!(camera.nr_sampling_scale, expected.nr_sampling_scale);
            let output = runner.run_blocking(&[&cached.pass(&model).unwrap()]);
            let mut maximum = 0_f32;
            for (actual, expected) in output.chunks_exact(4).zip(&expected.pixels) {
                assert_eq!(actual[3], 1.);
                for c in 0..3 {
                    let error = (actual[c] - expected[c]).abs();
                    assert!(error < 1e-4, "{name} {temperature}/{tint}: CPU {expected:?} GPU {actual:?}, error {error:e}");
                    maximum = maximum.max(error);
                }
            }
            eprintln!("Camera prefix {name} {temperature}/{tint} {temperature_seen}/{tint_seen}: max {maximum:e}");
        }
    }
}
