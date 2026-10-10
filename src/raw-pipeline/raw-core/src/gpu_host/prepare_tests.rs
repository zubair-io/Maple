//! Shared RAW preparation regression on a committed real DNG (#4317).
use super::prepare::{develop_prefix_rgba, prefix_model_for};
use crate::types::adjustment::AdjustmentModel;

#[test]
fn hot_controls_reuse_the_exact_prefix_and_source_bytes() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/batch-transfer/source.dng");
    let bytes = std::fs::read(&path).unwrap();
    let raw = crate::decode::decode(&path).unwrap();
    let model = AdjustmentModel::default();
    let first = develop_prefix_rgba(&raw, &bytes, "dng", &model, 32).unwrap();
    assert_eq!(first.3, prefix_model_for(&raw, &bytes, "dng", &model));
    assert!(first.1.max(first.2) <= 32);
    assert_eq!(first.0.len(), (first.1 * first.2 * 4) as usize);
    assert!(first.0.iter().all(|v| v.is_finite()));
    let edited = AdjustmentModel {
        exposure: 2.0,
        temperature: 8500.0,
        temperature_seen: true,
        vibrance: 35.0,
        film_look: "black_white_agfa_apx_100".into(),
        film_strength: 35.0,
        ..model.clone()
    };
    let second = develop_prefix_rgba(&raw, &bytes, "dng", &edited, 32).unwrap();
    assert_eq!(
        first, second,
        "GPU-owned controls must not change the uploaded prefix"
    );
    let upstream = AdjustmentModel {
        capture_sharpening_amount: 65.0,
        ..model
    };
    assert_ne!(first.3, prefix_model_for(&raw, &bytes, "dng", &upstream));
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
}

#[test]
fn refresh_retains_image_artifacts_and_canonical_mapping() {
    use super::model::{build_full_chain_inputs, update_chain_inputs, NoiseProfileInputs};
    let curve = crate::types::ToneCurve {
        points: vec![(0.0, 0.0), (0.5, 0.45), (1.0, 1.0)],
    };
    let model = AdjustmentModel {
        tone_curve_luma: curve.clone(),
        tone_curve_red: curve.clone(),
        tone_curve_green: curve.clone(),
        tone_curve_blue: curve.clone(),
        display_tone_curve_luma: curve.clone(),
        display_tone_curve_red: curve.clone(),
        display_tone_curve_green: curve.clone(),
        display_tone_curve_blue: curve,
        ..Default::default()
    };
    let mut inputs = build_full_chain_inputs(
        &model,
        vec![0.0, 1.0],
        2,
        vec![0.25; 24],
        NoiseProfileInputs {
            profile: vec![0.1, 0.2],
            iso: 800,
        },
        None,
        0,
        -1.0,
        1,
    );
    let identities = (
        inputs.profile_curve_flat.as_ptr(),
        inputs.residual_lut_data.as_ptr(),
        inputs.noise_profile.as_ptr(),
    );
    let curve_ids = [
        inputs.tone_curves.luma.as_ptr(),
        inputs.tone_curves.red.as_ptr(),
        inputs.tone_curves.green.as_ptr(),
        inputs.tone_curves.blue.as_ptr(),
        inputs.display_tone_curves.master.as_ptr(),
        inputs.display_tone_curves.red.as_ptr(),
        inputs.display_tone_curves.green.as_ptr(),
        inputs.display_tone_curves.blue.as_ptr(),
    ];
    inputs.target_primaries = 1;
    inputs.nr_sampling_scale = 0.25;
    let edited = AdjustmentModel {
        exposure: 2.0,
        contrast: 15.0,
        vibrance: 35.0,
        tone_curve_luma: crate::types::ToneCurve {
            points: vec![(0.0, 0.0), (0.5, 0.6), (1.0, 1.0)],
        },
        display_tone_curve_luma: crate::types::ToneCurve {
            points: vec![(0.0, 0.0), (0.5, 0.6), (1.0, 1.0)],
        },
        ..model
    };
    update_chain_inputs(&edited, &mut inputs);
    assert_eq!(
        identities,
        (
            inputs.profile_curve_flat.as_ptr(),
            inputs.residual_lut_data.as_ptr(),
            inputs.noise_profile.as_ptr()
        )
    );
    assert_eq!(
        curve_ids,
        [
            inputs.tone_curves.luma.as_ptr(),
            inputs.tone_curves.red.as_ptr(),
            inputs.tone_curves.green.as_ptr(),
            inputs.tone_curves.blue.as_ptr(),
            inputs.display_tone_curves.master.as_ptr(),
            inputs.display_tone_curves.red.as_ptr(),
            inputs.display_tone_curves.green.as_ptr(),
            inputs.display_tone_curves.blue.as_ptr()
        ]
    );
    assert_eq!(
        inputs.tone_curves.luma,
        vec![(0.0, 0.0), (0.5, 0.6), (1.0, 1.0)]
    );
    assert_eq!(inputs.display_tone_curves.master, inputs.tone_curves.luma);
    assert_eq!(inputs.tone[0], 2.0);
    assert_eq!(inputs.vibrance, 35.0);
    assert_eq!(inputs.residual_lut_size, 2);
    assert_eq!(inputs.iso, 800);
    assert_eq!(inputs.whites_anchor_ev, -1.0);
    assert_eq!(inputs.target_primaries, 1);
    assert_eq!(inputs.nr_sampling_scale, 0.25);
    let expected = build_full_chain_inputs(
        &edited,
        vec![0.0, 1.0],
        2,
        vec![0.25; 24],
        NoiseProfileInputs {
            profile: vec![0.1, 0.2],
            iso: 800,
        },
        None,
        0,
        -1.0,
        1,
    );
    assert_eq!(inputs.tone, expected.tone);
    assert_eq!(inputs.wb_matrix, expected.wb_matrix);
    assert_eq!(inputs.contrast, expected.contrast);
    assert_eq!(inputs.profile_curve_flat, expected.profile_curve_flat);
    assert_eq!(inputs.residual_lut_data, expected.residual_lut_data);
}

#[test]
fn retained_mask_carriers_refresh_without_reallocating_same_shape() {
    use super::model::{build_full_chain_inputs, update_chain_inputs, NoiseProfileInputs};
    use crate::types::{LocalAdjustment, MaskRaster, PartialAdjustments, Point2};
    let layer = LocalAdjustment::linear(
        Point2::new(0.0, 0.0),
        Point2::new(1.0, 0.0),
        PartialAdjustments {
            exposure: Some(1.0),
            ..Default::default()
        },
    );
    let raster = |value| {
        std::sync::Arc::new(MaskRaster {
            id: 7,
            digest: String::new(),
            width: 2,
            height: 1,
            data: vec![value, 0.5],
        })
    };
    let model = AdjustmentModel {
        local_adjustments: vec![layer],
        mask_rasters: vec![raster(0.25)],
        ..Default::default()
    };
    let mut inputs = build_full_chain_inputs(
        &model,
        Vec::new(),
        0,
        Vec::new(),
        NoiseProfileInputs {
            profile: Vec::new(),
            iso: 0,
        },
        None,
        0,
        0.0,
        1,
    );
    let identities = (
        inputs.local_adjustments.as_ptr(),
        inputs.mask_rasters.as_ptr(),
        inputs.mask_rasters[0].data.as_ptr(),
    );
    let edited = AdjustmentModel {
        mask_rasters: vec![raster(0.75)],
        ..model
    };
    update_chain_inputs(&edited, &mut inputs);
    assert_eq!(
        identities,
        (
            inputs.local_adjustments.as_ptr(),
            inputs.mask_rasters.as_ptr(),
            inputs.mask_rasters[0].data.as_ptr()
        )
    );
    assert_eq!(
        inputs.local_adjustments,
        crate::types::layers_to_flat(&edited.local_adjustments)
    );
    assert_eq!(inputs.mask_rasters[0].data, vec![0.75, 0.5]);
    update_chain_inputs(&AdjustmentModel::default(), &mut inputs);
    assert!(inputs.local_adjustments.is_empty());
    assert!(inputs.mask_rasters.is_empty());
}

#[test]
fn borrowed_prefix_match_agrees_with_owned_policy_for_hot_and_upstream_edits() {
    use super::prefix::{prefix_matches, stripped_prefix_model};
    use crate::types::{
        adjustment::AutoExposureMode, LocalAdjustment, PartialAdjustments, Point2, Profile,
        ToneCurve,
    };
    let base = AdjustmentModel::default();
    let layer = LocalAdjustment::linear(
        Point2::new(0.0, 0.0),
        Point2::new(1.0, 0.0),
        PartialAdjustments {
            exposure: Some(1.0),
            ..Default::default()
        },
    );
    let candidates = [
        base.clone(),
        AdjustmentModel {
            exposure: 2.0,
            temperature: 8500.0,
            ..base.clone()
        },
        AdjustmentModel {
            tone_curve_luma: ToneCurve {
                points: vec![(0.0, 0.0), (0.5, 0.7), (1.0, 1.0)],
            },
            local_adjustments: vec![layer],
            ..base.clone()
        },
        AdjustmentModel {
            capture_sharpening_amount: 65.0,
            ..base.clone()
        },
        AdjustmentModel {
            profile: Profile::Neutral,
            ..base.clone()
        },
        AdjustmentModel {
            lens_profile: "lcp1:changed".into(),
            ..base.clone()
        },
        AdjustmentModel {
            perspective_rotate: 2.0,
            ..base.clone()
        },
        AdjustmentModel {
            parametric_shadow_split: 10.0,
            ..base.clone()
        },
        AdjustmentModel {
            defringe_purple_amount: 10.0,
            ..base.clone()
        },
    ];
    for anchor in &candidates {
        for old_ae in [AutoExposureMode::Off, base.auto_exposure] {
            let cached = stripped_prefix_model(anchor, old_ae);
            for model in &candidates {
                for new_ae in [AutoExposureMode::Off, base.auto_exposure] {
                    assert_eq!(
                        prefix_matches(model, &cached, new_ae),
                        stripped_prefix_model(model, new_ae) == cached
                    );
                }
            }
        }
    }
}

#[test]
fn cancellable_prefix_matches_wrapper_and_observes_host_flag() {
    use super::prepare::develop_prefix_rgba_cancellable;
    use std::sync::atomic::{AtomicBool, Ordering};
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/batch-transfer/source.dng");
    let bytes = std::fs::read(&path).unwrap();
    let raw = crate::decode::decode(&path).unwrap();
    let model = AdjustmentModel::default();
    let flag = AtomicBool::new(false);
    let expected = develop_prefix_rgba(&raw, &bytes, "dng", &model, 32).unwrap();
    let actual = develop_prefix_rgba_cancellable(
        &raw,
        &bytes,
        "dng",
        &model,
        32,
        crate::CancelToken::new(&flag),
    )
    .unwrap();
    assert_eq!(actual, expected);
    flag.store(true, Ordering::Relaxed);
    assert_eq!(
        develop_prefix_rgba_cancellable(
            &raw,
            &bytes,
            "dng",
            &model,
            32,
            crate::CancelToken::new(&flag)
        )
        .unwrap_err(),
        crate::Error::Cancelled.to_string()
    );
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[test]
fn neutral_and_unavailable_auto_emit_absent_artifacts_with_truthful_status() {
    use super::prepare::flatten_profile_artifacts;
    use crate::types::adjustment::Profile;
    for (profile, status) in [(Profile::Neutral, None), (Profile::Auto, Some(false))] {
        let (curve, size, lut, achieved) = flatten_profile_artifacts(None, None, profile);
        assert!(curve.is_empty());
        assert_eq!(achieved, status);
        assert_eq!(size, 0);
        assert!(lut.is_empty());
    }
}

#[test]
fn residual_only_is_active_without_inventing_a_curve() {
    use super::prepare::flatten_profile_artifacts;
    use crate::types::adjustment::Profile;
    use crate::view::auto_profile;
    let residual = auto_profile::lut::ColorLut::identity(9);
    let expected = residual.data.clone();
    let (curve, size, lut, achieved) =
        flatten_profile_artifacts(None, Some(residual), Profile::Auto);
    assert!(curve.is_empty());
    assert_eq!(size, 9);
    assert_eq!(lut, expected);
    assert_eq!(achieved, Some(true));
}

#[test]
fn fitted_identity_curve_remains_present() {
    use super::prepare::flatten_profile_artifacts;
    use crate::types::adjustment::Profile;
    use crate::view::auto_profile;
    let identity = auto_profile::curve::ProfileCurve::identity();
    let expected = identity.to_flat();
    let (curve, _, _, achieved) = flatten_profile_artifacts(Some(identity), None, Profile::Auto);
    assert_eq!(curve, expected);
    assert_eq!(achieved, Some(true));
}
