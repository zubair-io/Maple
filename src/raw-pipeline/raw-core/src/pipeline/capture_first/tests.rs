//! Capture-first develop (#5213 S1): white-balance independence of the
//! capture result, the as-shot exposure anchor, the basis round trip, and the
//! per-tick chain sharing the creative stage.

use super::*;
use crate::color::illuminant::Illuminant;
use crate::image::{CfaPattern, RawImage};
use crate::pipeline::{
    apply_scene_linear_chain_f32, develop_scene_linear_from_raw_with_quality_with_gain,
    develop_scene_linear_sized_from_raw_with_quality_with_gain, ChainOptions, RenderQuality,
};
use crate::stages::wb_camera;

const CM: Matrix3 = Matrix3([
    [0.6722, -0.0635, -0.0963],
    [-0.4287, 1.2460, 0.2028],
    [-0.0908, 0.2162, 0.5668],
]);
const AS_SHOT_NEUTRAL: [f32; 3] = [0.5, 1.0, 0.7];
const PATCHES: [[f32; 3]; 6] = [
    [0.30, 0.30, 0.30],
    [0.45, 0.12, 0.05],
    [0.04, 0.35, 0.06],
    [0.03, 0.10, 0.60],
    [0.95, 0.70, 0.20],
    [0.02, 0.02, 0.02],
];

/// A 96×96 RGGB chart of saturated, near-clipping and near-black patches with
/// a ripple, under an embedded ColorMatrix, so the calibrated camera-WB path,
/// soft floor and highlight handling all see real work.
fn chart_raw() -> RawImage {
    const SIDE: u32 = 96;
    const WHITE: u32 = 65535;
    let raw_data = (0..SIDE)
        .flat_map(|y| (0..SIDE).map(move |x| (x, y)))
        .map(|(x, y)| {
            let patch = PATCHES[((x / 32) + 3 * (y / 48)) as usize % PATCHES.len()];
            let ripple = 1.0 + 0.08 * ((x as f32) * 0.7).sin() * ((y as f32) * 0.45).cos();
            let channel = CfaPattern::Rggb.color_at(x, y) as usize;
            let value = patch[channel] * AS_SHOT_NEUTRAL[channel] * ripple;
            (value * WHITE as f32).round().clamp(0.0, WHITE as f32) as u16
        })
        .collect();
    RawImage {
        width: SIDE,
        height: SIDE,
        cfa: CfaPattern::Rggb,
        black_level: [0; 4],
        white_level: WHITE,
        raw_data,
        as_shot_neutral: AS_SHOT_NEUTRAL,
        as_shot_cct: None,
        camera_make: "Test".into(),
        camera_model: "Test".into(),
        unique_camera_model: None,
        color_matrices: [(Illuminant::D65, CM)].into_iter().collect(),
        forward_matrices: std::collections::HashMap::new(),
        orientation: crate::image::ExifOrientation::Normal,
        baseline_exposure: 0.0,
        hsm_data: std::collections::HashMap::new(),
        plt: None,
        profile_tone_curve: None,
        profile_gain_table_map: None,
        crop_rect: None,
        iso: 100,
        noise_profile: None,
        sensor_gain_maps: None,
        opcode_list3: None,
        opcode_skips: Vec::new(),
        aperture: None,
        focal_length: None,
        lens_metadata: Default::default(),
    }
}

fn develop(raw: &RawImage, model: &AdjustmentModel) -> (Image, f32) {
    develop_scene_linear_from_raw_with_quality_with_gain(raw, model, RenderQuality::Full).unwrap()
}

fn warm_white_balance() -> AdjustmentModel {
    AdjustmentModel {
        temperature: 3600.0,
        tint: 18.0,
        temperature_seen: true,
        tint_seen: true,
        ..AdjustmentModel::default()
    }
}

fn engaged_capture() -> AdjustmentModel {
    AdjustmentModel {
        chroma_prefilter: 60.0,
        capture_sharpening_amount: 80.0,
        ..AdjustmentModel::default()
    }
}

fn max_relative_difference(a: &Image, b: &Image) -> f32 {
    a.pixels
        .iter()
        .zip(&b.pixels)
        .flat_map(|(p, q)| (0..3).map(move |c| (p[c] - q[c]).abs() / q[c].abs().max(1e-3)))
        .fold(0.0, f32::max)
}

#[test]
fn moving_white_balance_keeps_the_as_shot_exposure_anchor() {
    let raw = chart_raw();
    let (_, as_shot_gain) = develop(&raw, &AdjustmentModel::default());
    let (_, warm_gain) = develop(&raw, &warm_white_balance());
    assert_eq!(warm_gain.to_bits(), as_shot_gain.to_bits());
    let sized = |model: &AdjustmentModel| {
        develop_scene_linear_sized_from_raw_with_quality_with_gain(
            &raw,
            model,
            RenderQuality::Full,
            48,
        )
        .unwrap()
        .1
    };
    assert_eq!(
        sized(&warm_white_balance()).to_bits(),
        sized(&AdjustmentModel::default()).to_bits()
    );
}

fn camera_buffer(raw: &RawImage) -> (Image, DcpProfile) {
    let (profile, _) = dcp::profile_for_with_source(raw).unwrap();
    let mut camera = Image::new(64, 48, ColorSpace::CameraNativeLinearRgb);
    for (i, p) in camera.pixels.iter_mut().enumerate() {
        let patch = PATCHES[(i / 7) % PATCHES.len()];
        let ripple = 1.0 + 0.1 * ((i as f32) * 0.37).sin();
        *p = patch.map(|v| v * ripple);
    }
    (camera, profile)
}

#[test]
fn the_capture_result_never_sees_the_white_balance() {
    let raw = chart_raw();
    let (camera, profile) = camera_buffer(&raw);
    let as_shot = engaged_capture();
    let warm = AdjustmentModel {
        temperature: 3000.0,
        tint: -25.0,
        temperature_seen: true,
        tint_seen: true,
        ..engaged_capture()
    };
    let capture = |model: &AdjustmentModel| {
        super::capture(
            camera.clone(),
            &profile,
            model,
            Site::Frame,
            Chain::Full,
            CancelToken::never(),
        )
        .unwrap()
    };
    let (a, a_space) = capture(&as_shot);
    let (b, _) = capture(&warm);
    assert!(a_space == CaptureSpace::Basis);
    assert_eq!(a.pixels, b.pixels);
}

#[test]
fn a_capture_without_an_engaged_stage_passes_the_camera_buffer_through() {
    let raw = chart_raw();
    let (camera, profile) = camera_buffer(&raw);
    let (out, space) = super::capture(
        camera.clone(),
        &profile,
        &AdjustmentModel::default(),
        Site::Frame,
        Chain::Full,
        CancelToken::never(),
    )
    .unwrap();
    assert!(space == CaptureSpace::Camera);
    assert_eq!(out.pixels, camera.pixels);
}

fn creative(raw: &RawImage, profile: DcpProfile, anchors: CreativeAnchors) -> CreativeStage {
    let frame = wb_camera::SliderFrame::resolve(raw, &profile);
    CreativeStage {
        profile,
        frame: Some(frame),
        as_shot_neutral: raw.as_shot_neutral,
        anchors,
    }
}

#[test]
fn the_basis_round_trip_is_transparent_to_the_creative_stage() {
    let raw = chart_raw();
    let (camera, profile) = camera_buffer(&raw);
    let model = warm_white_balance();
    let stage = creative(&raw, profile.clone(), CreativeAnchors::Measure);
    let basis = dcp::camera_to_rec2020_matrix(&profile).unwrap();
    let mut in_basis = camera.clone();
    transform(&mut in_basis, &basis);
    in_basis.space = ColorSpace::SceneLinearRec2020;
    let (direct, direct_gain) = stage
        .render(camera, CaptureSpace::Camera, &model, Chain::Full)
        .unwrap();
    let (round_trip, round_trip_gain) = stage
        .render(in_basis, CaptureSpace::Basis, &model, Chain::Full)
        .unwrap();
    assert!((direct_gain - round_trip_gain).abs() <= 1e-5 * direct_gain);
    let worst = max_relative_difference(&round_trip, &direct);
    assert!(worst < 1e-4, "basis round trip moved a pixel by {worst}");
}

#[test]
fn the_per_tick_chain_runs_the_same_creative_stage() {
    let raw = chart_raw();
    let (camera, profile) = camera_buffer(&raw);
    let (capture, _) = super::capture(
        camera,
        &profile,
        &engaged_capture(),
        Site::Frame,
        Chain::Full,
        CancelToken::never(),
    )
    .unwrap();
    let model = AdjustmentModel {
        sharpen_amount: 0.0,
        nr_color: 0.0,
        ..warm_white_balance()
    };
    let stage = creative(
        &raw,
        profile,
        CreativeAnchors::Given {
            ae_gain: 1.7,
            decoded_wb: None,
        },
    );
    let (expected, _) = stage
        .render(capture.clone(), CaptureSpace::Basis, &model, Chain::Full)
        .unwrap();
    let rgba: Vec<f32> = capture
        .pixels
        .iter()
        .flat_map(|p| [p[0], p[1], p[2], 1.0])
        .collect();
    let options = ChainOptions {
        skip_agx: true,
        creative: Some(&stage),
        ..ChainOptions::default()
    };
    let out = apply_scene_linear_chain_f32(&rgba, capture.width, capture.height, &model, &options)
        .unwrap();
    for (i, p) in expected.pixels.iter().enumerate() {
        assert_eq!(&out[i * 4..i * 4 + 3], p, "pixel {i}");
    }
}
