use super::*;
use crate::{
    color::hsm::HsmTable,
    image::{ColorSpace, Image},
    math::Matrix3,
    types::WbScaleVersion,
};
use raw_gpu::{ChainRunner, GpuContext, GpuImage};

fn calibration() -> GpuCameraColorimetry {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/batch-transfer/source.dng");
    let raw = crate::decode::decode(&path).unwrap();
    GpuCameraColorimetry::resolve(&raw).unwrap()
}

fn pixels() -> Image {
    let values = [-0.05, 0., 0.0001, 0.005, 0.18, 0.5, 1., 4.];
    let pixels = values
        .into_iter()
        .flat_map(|r| {
            values
                .into_iter()
                .flat_map(move |g| values.into_iter().map(move |b| [r, g, b]))
        })
        .collect::<Vec<_>>();
    Image {
        width: pixels.len() as u32,
        height: 1,
        pixels,
        space: ColorSpace::CameraNativeLinearRgb,
        whites_anchor_ev: None,
        nr_sampling_scale: 1.,
    }
}

fn table(encoding: HsmEncoding) -> HsmTable {
    let data = (0..7)
        .flat_map(|h| {
            (0..4).flat_map(move |s| {
                (0..5).flat_map(move |v| {
                    [
                        (h as f32 - 3.) * 8. + (s * v) as f32,
                        0.8 + (h * s) as f32 * 0.015,
                        0.9 + (s * v) as f32 * 0.02,
                    ]
                })
            })
        })
        .collect();
    HsmTable::new([7, 4, 5], data, encoding).unwrap()
}

fn models() -> Vec<AdjustmentModel> {
    let mut models = vec![AdjustmentModel::default()];
    for version in [WbScaleVersion::V1, WbScaleVersion::V5] {
        for (temperature, tint) in [(2000., -150.), (6500., 0.), (8500., 150.), (50000., -150.)] {
            for (temperature_seen, tint_seen) in [(true, true), (true, false), (false, true)] {
                models.push(AdjustmentModel {
                    temperature,
                    tint,
                    temperature_seen,
                    tint_seen,
                    wb_scale_version: version,
                    ..Default::default()
                });
            }
        }
    }
    models
}

fn check(
    ctx: &GpuContext,
    cached: &GpuCameraColorimetry,
    model: &AdjustmentModel,
    label: &str,
) -> f32 {
    let input = pixels();
    let mut camera = input.clone();
    let profile = match &cached.frame {
        Some(frame) => {
            let (temperature, tint) = wb_camera::resolve_target_versioned(
                model,
                frame,
                &cached.profile,
                cached.as_shot_neutral,
            );
            wb_camera::apply(
                &mut camera,
                frame,
                cached.as_shot_neutral,
                temperature,
                tint,
            );
            wb_camera::retargeted_render_profile(frame, cached.profile.clone(), temperature, tint)
        }
        None => cached.profile.clone(),
    };
    let expected = dcp::apply_colorimetry(&camera, &profile).unwrap();
    let rgba = input
        .pixels
        .iter()
        .enumerate()
        .flat_map(|(i, p)| [p[0], p[1], p[2], (i % 17) as f32 / 16.])
        .collect::<Vec<_>>();
    let image = GpuImage::upload(ctx, &rgba, input.width, input.height);
    let runner = ChainRunner::new(ctx, &image);
    let pass = cached.pass(model).unwrap();
    if let Some(hsm) = &pass.hsm {
        let resident = if pass.hsm_blend.is_some() {
            &cached.profile.hsm_endpoints.as_ref().unwrap().0
        } else {
            cached.profile.hsm.as_ref().unwrap()
        };
        assert_eq!(
            hsm.data.as_ptr(),
            resident.data.as_ptr(),
            "per-tick table must be borrowed"
        );
    }
    let output = runner.run_blocking(&[&pass]);
    assert_eq!(runner.last_readback_count(), 1);
    let mut maximum = 0_f32;
    for (i, (actual, expected)) in output.chunks_exact(4).zip(&expected.pixels).enumerate() {
        assert_eq!(actual[3].to_bits(), rgba[i * 4 + 3].to_bits());
        // At extreme camera gains this synthetic lattice reaches tens of
        // scene-linear units. Bound f32/transcendental rounding in that range
        // as well as absolute error around display white; never clip HDR to
        // satisfy an absolute tolerance. Physical calibrations additionally
        // retain the absolute 1e-4 stage gate below.
        let scale = expected.iter().copied().map(f32::abs).fold(1., f32::max);
        let tolerance = 1e-4_f32.max(32. * f32::EPSILON * scale);
        for c in 0..3 {
            let error = (actual[c] - expected[c]).abs();
            assert!(error < tolerance, "{label}, {}/{}, flags {}/{}, {:?}, pixel {i}/{c}: CPU {expected:?} GPU {actual:?}, error {error:e}, tolerance {tolerance:e}",
                model.temperature, model.tint, model.temperature_seen, model.tint_seen, model.wb_scale_version);
            maximum = maximum.max(error);
        }
    }
    eprintln!(
        "DCP {label}: {}/{} {:?}, max {maximum:e}",
        model.temperature, model.tint, model.wb_scale_version
    );
    maximum
}

#[test]
fn fused_dcp_matches_cpu_order_for_matrices_encodings_and_partial_wb() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    for forward in [false, true] {
        for baked in [false, true] {
            for hsm in [None, Some(HsmEncoding::Linear), Some(HsmEncoding::Srgb)] {
                let mut cached = calibration();
                // Fix single-calibration FM so the synthetic branch coverage
                // cannot be replaced by a target-dependent endpoint lookup.
                cached.profile.cm_endpoints = None;
                cached.profile.forward_matrix = forward.then_some(Matrix3([
                    [0.6, 0.2, 0.15],
                    [0.2, 0.7, 0.1],
                    [0.01, 0.1, 0.7],
                ]));
                cached.profile.wb_already_baked = baked;
                cached.profile.hsm = hsm.map(table);
                for model in models() {
                    check(
                        &ctx,
                        &cached,
                        &model,
                        &format!("FM={forward}/baked={baked}/HSM={hsm:?}"),
                    );
                }
            }
        }
    }
}

#[test]
fn fallback_defers_wb_and_profile_rejects_aesthetic_look_table() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    let mut cached = calibration();
    cached.frame = None;
    for model in models() {
        assert_eq!(cached.pass(&model).unwrap().camera_gain, [1.; 3]);
        check(&ctx, &cached, &model, "fallback WB deferred");
    }
    cached.profile.look_table = Some(table(HsmEncoding::Linear));
    assert!(matches!(
        cached.pass(&AdjustmentModel::default()),
        Err(crate::Error::Dcp(_))
    ));
    cached.profile.look_table = None;
    cached.profile.forward_matrix = None;
    cached.profile.color_matrix = Matrix3([[0.; 3]; 3]);
    assert!(matches!(
        cached.pass(&AdjustmentModel::default()),
        Err(crate::Error::Dcp(_))
    ));
}

#[test]
#[ignore = "requires physical RAW corpus and GPU adapter"]
fn real_camera_calibrations_match_cpu_for_all_wb_intents() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../test-fixtures/raws");
    for fixture in [
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
        let raw = crate::decode::decode(&root.join(fixture)).unwrap();
        let cached = GpuCameraColorimetry::resolve(&raw).unwrap();
        if matches!(fixture, "test_0018.dng" | "test_0020.dng") {
            assert!(cached.profile.forward_matrix.is_none());
            assert!(cached.profile.wb_already_baked);
            assert!(cached.frame.is_some());
        }
        for model in models() {
            let maximum = check(&ctx, &cached, &model, fixture);
            assert!(
                maximum < 1e-4,
                "physical calibration {fixture}: {maximum:e}"
            );
        }
    }
}

#[test]
fn selected_white_blends_resident_hsm_endpoints_before_gpu_lookup() {
    let ctx = GpuContext::new_blocking().expect("required GPU adapter");
    for encoding in [HsmEncoding::Linear, HsmEncoding::Srgb] {
        let mut cached = calibration();
        let cm = cached.profile.color_matrix;
        cached.profile.cm_endpoints = Some(dcp::CmEndpoints {
            m_cold: cm,
            cct_cold: 2856.,
            m_warm: cm,
            cct_warm: 6504.,
            fm_cold: cached.profile.forward_matrix,
            fm_warm: cached.profile.forward_matrix,
        });
        let cold = table(encoding);
        let mut warm = cold.clone();
        for node in warm.data.chunks_exact_mut(3) {
            node[0] += 12.;
            node[1] *= 0.8;
            node[2] *= 1.1;
        }
        cached.profile.hsm_endpoints = Some((cold, warm));
        let (cold, warm, weight) = cached
            .profile
            .hsm_interpolation_for_cct(cached.profile.scene_cct)
            .unwrap();
        cached.profile.hsm = crate::color::hsm::lerp_tables(cold, warm, weight);
        let pointers = {
            let (cold, warm) = cached.profile.hsm_endpoints.as_ref().unwrap();
            (cold.data.as_ptr(), warm.data.as_ptr())
        };
        for model in models() {
            let pass = cached.pass(&model).unwrap();
            if let Some((second, weight)) = pass.hsm_blend {
                assert_eq!(pass.hsm.as_ref().unwrap().data.as_ptr(), pointers.0);
                assert_eq!(second.as_ptr(), pointers.1);
                assert!((0.0..=1.0).contains(&weight));
            }
            check(&ctx, &cached, &model, "dual HSM selected white");
        }
    }
}
