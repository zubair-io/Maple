use super::*;
use crate::{
    pipeline::{develop_scene_linear_sized_from_raw_with_quality, RenderQuality},
    types::{
        adjustment::{AutoExposureMode, HighlightRecoveryMode, Profile},
        local_adjustment::Point2,
        retouch::{RetouchKind, RetouchSpot},
    },
};
use raw_gpu::{
    AutoExposurePass, CaptureSharpeningPass, ChainRunner, ChromaPrefilterPass, GpuContext,
    GpuImage, OklabHighlightRecoveryPass, Pass, RetouchPass,
};

#[test]
#[ignore = "requires physical RAW corpus and GPU adapter"]
fn actual_camera_retouch_preserves_order_and_white_balance_response() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../test-fixtures/raws");
    let first = RetouchSpot::new(
        RetouchKind::Clone,
        Point2 { x: 0.25, y: 0.3 },
        Point2 { x: 0.75, y: 0.8 },
        0.12,
    );
    let second = RetouchSpot::new(
        RetouchKind::Heal,
        Point2 { x: 0.65, y: 0.6 },
        first.center,
        0.1,
    );
    let base = AdjustmentModel {
        retouch_spots: vec![first, second],
        highlight_recovery: HighlightRecoveryMode::OklabChromaReduction,
        chroma_prefilter: 100.,
        capture_sharpening_amount: 40.,
        profile: Profile::Neutral,
        sharpen_amount: 0.,
        nr_color: 0.,
        nr_luminance: 0.,
        ..Default::default()
    };
    for name in ["test_0006.DNG", "test_0005.RAF"] {
        let path = root.join(name);
        let bytes = std::fs::read(&path).unwrap();
        let raw = crate::decode::decode_bytes(&bytes, path.extension().unwrap().to_str().unwrap())
            .unwrap();
        let (cached, camera) =
            GpuCameraColorimetry::prepare(&raw, &base, 256, crate::CancelToken::never()).unwrap();
        let spots = crate::stages::retouch::prepare_gpu_spots(
            &base.retouch_spots,
            (camera.width, camera.height),
        );
        assert_eq!(spots.len(), 2);
        let retouch = RetouchPass { spots: &spots };
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
                let chroma = ChromaPrefilterPass { strength: 100. };
                let capture = CaptureSharpeningPass {
                    params: crate::gpu_host::model::capture_sharpening_inputs(&model).unwrap(),
                };
                let mut passes: Vec<&dyn Pass> = vec![
                    &dcp,
                    &OklabHighlightRecoveryPass,
                    &retouch,
                    &chroma,
                    &capture,
                ];
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
                        assert!(error < 1e-4, "{name} {temperature}/{tint} AE {auto_exposure:?}: actual {a:?}, expected {e:?}, error {error:e}");
                        maximum = maximum.max(error);
                    }
                }
                eprintln!("Retouch camera {name} {temperature}/{tint} AE {auto_exposure:?}: maximum {maximum:e}");
            }
        }
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
}
