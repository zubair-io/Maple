//! Physical lossy-DNG camera-transfer and WB parity (#4629).
//! Explicit local qualification: missing RAW or GPU is a failure.
use raw_core::{
    pipeline::{render_sized_from_raw_with_quality_and_source, RawInput, RenderQuality},
    xmp::{AdjustmentModel, AutoExposureMode, HighlightRecoveryMode, Profile},
};

#[test]
#[ignore = "requires physical test_0006.DNG and a GPU adapter"]
fn declared_lossy_transfer_matches_cpu_through_gpu_binding() {
    assert!(super::tests::gpu_available(), "required GPU adapter");
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws/test_0006.DNG");
    let bytes = std::fs::read(&path).expect("required physical fixture");
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").unwrap();
    assert!(raw.linearization_transfer.is_some());
    assert!(!raw.uses_legacy_lossy_linearraw());
    let baseline = AdjustmentModel {
        profile: Profile::Neutral,
        auto_exposure: AutoExposureMode::Off,
        highlight_recovery: HighlightRecoveryMode::Off,
        sharpen_amount: 0.,
        nr_color: 0.,
        ..Default::default()
    };
    for (profile_name, baseline) in [
        ("isolated-neutral", baseline),
        (
            "neutral-defaults",
            AdjustmentModel {
                profile: Profile::Neutral,
                ..Default::default()
            },
        ),
        ("auto-defaults", AdjustmentModel::default()),
    ] {
        for (case_name, model) in [
            ("baseline", baseline.clone()),
            (
                "tint_max",
                AdjustmentModel {
                    tint: 150.,
                    tint_seen: true,
                    ..baseline.clone()
                },
            ),
            (
                "tint_min",
                AdjustmentModel {
                    tint: -150.,
                    tint_seen: true,
                    ..baseline.clone()
                },
            ),
            (
                "temperature",
                AdjustmentModel {
                    temperature: 8500.,
                    temperature_seen: true,
                    ..baseline
                },
            ),
        ] {
            let name = format!("{profile_name}/{case_name}");
            let (cw, ch, cpu) = render_sized_from_raw_with_quality_and_source(
                &raw,
                &model,
                RenderQuality::Amaze,
                Some(RawInput::Bytes {
                    bytes: &bytes,
                    ext: "dng",
                }),
                1024,
            )
            .unwrap();
            let (gw, gh, gpu) = pollster::block_on(super::render_gpu_core(
                &raw,
                &bytes,
                "dng",
                &model,
                Some(1024),
            ))
            .unwrap();
            assert_eq!((cw, ch, cpu.len()), (gw, gh, gpu.len()));
            let maximum = cpu
                .iter()
                .zip(&gpu)
                .map(|(a, b)| a.abs_diff(*b))
                .max()
                .unwrap();
            let mismatches = cpu.iter().zip(&gpu).filter(|(a, b)| a != b).count();
            let fraction = mismatches as f64 / cpu.len() as f64;
            eprintln!("{name}: max byte delta {maximum}, mismatch fraction {fraction}");
            // Same byte tolerances as the existing GPU binding parity gate.
            assert!(maximum <= 2, "{name}: max {maximum} > 2");
            assert!(
                fraction < 0.05,
                "{name}: mismatch fraction {fraction} >= 0.05"
            );
        }
    }
    assert_eq!(std::fs::read(path).unwrap(), bytes, "original RAW changed");
}
