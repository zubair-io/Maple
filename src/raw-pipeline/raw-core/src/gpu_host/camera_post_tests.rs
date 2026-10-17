use super::*;
use crate::{
    pipeline::{develop_scene_linear_sized_from_raw_with_quality, RenderQuality},
    types::adjustment::{AutoExposureMode, HighlightRecoveryMode, Profile},
};
use raw_gpu::{
    AutoExposurePass, CaptureSharpeningPass, ChainRunner, ChromaPrefilterPass, GpuContext,
    GpuImage, OklabHighlightRecoveryPass, Pass,
};

#[test]
#[ignore = "requires physical RAW corpus and GPU adapter"]
fn actual_camera_post_stages_preserve_cpu_order_across_white_balance_changes() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../test-fixtures/raws");
    for name in [
        "test_0006.DNG",
        "test_0005.RAF",
        "test_0017.dng",
        "test_0018.dng",
    ] {
        let path = root.join(name);
        let bytes = std::fs::read(&path).unwrap();
        let extension = path.extension().unwrap().to_str().unwrap();
        let raw = crate::decode::decode_bytes(&bytes, extension).unwrap();
        for recovery in [
            HighlightRecoveryMode::ChromaticAdaptation,
            HighlightRecoveryMode::OklabChromaReduction,
        ] {
            let base = AdjustmentModel {
                highlight_recovery: recovery,
                chroma_prefilter: 100.,
                capture_sharpening_amount: 40.,
                profile: Profile::Neutral,
                sharpen_amount: 0.,
                nr_color: 0.,
                nr_luminance: 0.,
                ..Default::default()
            };
            let (cached, camera) =
                GpuCameraColorimetry::prepare(&raw, &base, 256, crate::CancelToken::never())
                    .unwrap();
            let rgba = camera
                .pixels
                .iter()
                .flat_map(|p| [p[0], p[1], p[2], 1.])
                .collect::<Vec<_>>();
            let image = GpuImage::upload(&ctx, &rgba, camera.width, camera.height);
            let runner = ChainRunner::new(&ctx, &image);
            for (temperature, tint, authored) in [
                (6500., 0., false),
                (8500., 150., true),
                (2000., -150., true),
            ] {
                for auto_exposure in [AutoExposureMode::Off, AutoExposureMode::On] {
                    let model = AdjustmentModel {
                        temperature,
                        tint,
                        temperature_seen: authored,
                        tint_seen: authored,
                        auto_exposure,
                        ..base.clone()
                    };
                    let expected = develop_scene_linear_sized_from_raw_with_quality(
                        &raw,
                        &model,
                        RenderQuality::Amaze,
                        256,
                    )
                    .unwrap();
                    let dcp = cached.pass(&model).unwrap();
                    let chroma = ChromaPrefilterPass {
                        strength: model.chroma_prefilter,
                    };
                    let capture = CaptureSharpeningPass {
                        params: crate::gpu_host::model::capture_sharpening_inputs(&model).unwrap(),
                    };
                    let mut passes: Vec<&dyn Pass> = vec![&dcp];
                    if recovery == HighlightRecoveryMode::OklabChromaReduction {
                        passes.push(&OklabHighlightRecoveryPass);
                    }
                    passes.extend([&chroma as &dyn Pass, &capture]);
                    if auto_exposure == AutoExposureMode::On {
                        passes.push(&AutoExposurePass);
                    }
                    let actual = runner.run_blocking(&passes);
                    assert_eq!(
                        (camera.width, camera.height),
                        (expected.width, expected.height)
                    );
                    assert_eq!(actual.len(), expected.pixels.len() * 4);
                    assert_eq!(runner.last_readback_count(), 1);
                    let mut maximum = 0_f32;
                    for (a, e) in actual.chunks_exact(4).zip(&expected.pixels) {
                        assert_eq!(a[3], 1.);
                        for c in 0..3 {
                            let error = (a[c] - e[c]).abs();
                            assert!(error < 1e-4, "{name} {temperature}/{tint} {recovery:?} AE {auto_exposure:?}: actual {a:?}, expected {e:?}, error {error:e}");
                            maximum = maximum.max(error);
                        }
                    }
                    eprintln!("Post-camera {name} {temperature}/{tint} {recovery:?} AE {auto_exposure:?}: maximum {maximum:e}");
                }
            }
        }
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
}
