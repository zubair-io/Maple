//! A synthetic dual-illuminant camera and the [`CreativeStage`]s built on it,
//! shared by the CPU plan tests and the GPU creative-stage parity gates
//! (#5376). Profiles come through `dcp::profile_for` from an embedded
//! calibration, so the stage sees the same endpoint structure a real DNG has.

use crate::{
    color::{
        dcp::{self, DcpProfile},
        hsm::{HsmEncoding, HsmTable},
        illuminant::Illuminant,
    },
    image::{CfaPattern, ExifOrientation, RawImage},
    math::Matrix3,
    pipeline::{CreativeAnchors, CreativeStage},
    stages::wb_camera::SliderFrame,
};
use std::collections::HashMap;

const AS_SHOT_NEUTRAL: [f32; 3] = [0.5, 1.0, 0.7];
const COLOR_MATRIX_STD_A: Matrix3 = Matrix3([
    [0.6722, -0.0635, -0.0963],
    [-0.4287, 1.2460, 0.2028],
    [-0.0908, 0.2162, 0.5668],
]);
const COLOR_MATRIX_D65: Matrix3 = Matrix3([
    [0.7501, -0.1234, -0.0712],
    [-0.3801, 1.2001, 0.1899],
    [-0.0488, 0.1801, 0.6011],
]);

/// Which tables the synthetic profile carries.
#[derive(Clone, Copy, Debug)]
pub enum Tables {
    /// ForwardMatrix only.
    None,
    /// One HueSatMap (a single-illuminant profile).
    SingleHueSatMap,
    /// Both illuminants' HueSatMaps, so a white balance retarget blends them.
    DualHueSatMap { srgb: bool },
    /// Dual HueSatMaps plus a LookTable.
    DualHueSatMapAndLook,
}

/// A smooth table whose hue deltas cross +-180 degrees between neighbouring
/// cells at the seam, with saturation and value scales that vary over the
/// lattice, so every interpolation axis and the hue unwrap carry weight. The
/// seam step is large enough that the unwrap happens at every saturation and
/// value: a step near 180 degrees would flip the unwrap across `s == 1`,
/// where a pixel with a zero channel sits within one rounding of either side.
pub fn table(dims: [u32; 3], encoding: HsmEncoding, phase: f32, hue_amp: f32) -> HsmTable {
    let [hue_divs, sat_divs, val_divs] = dims;
    let data = (0..hue_divs)
        .flat_map(|h| (0..sat_divs).flat_map(move |s| (0..val_divs).map(move |v| (h, s, v))))
        .flat_map(|(h, s, v)| {
            let angle = h as f32 / hue_divs as f32 * std::f32::consts::TAU + phase;
            let sat = s as f32 / (sat_divs - 1).max(1) as f32;
            let val = v as f32 / (val_divs - 1).max(1) as f32;
            let seam = if h == 0 { 200.0 } else { 0.0 };
            [
                hue_amp * angle.sin() * sat * (1.0 + val) + seam,
                1.0 + 0.12 * angle.cos() * sat * (1.0 - 0.5 * val),
                1.0 - 0.04 * angle.sin() * sat + 0.03 * val,
            ]
        })
        .collect();
    HsmTable::new(dims, data, encoding).expect("lattice sized to its dims")
}

fn raw(tables: Tables) -> RawImage {
    let encoding = match tables {
        Tables::DualHueSatMap { srgb: true } | Tables::DualHueSatMapAndLook => HsmEncoding::Srgb,
        _ => HsmEncoding::Linear,
    };
    let dims = [8, 4, 5];
    let hue_sat_maps = match tables {
        Tables::None => HashMap::new(),
        Tables::SingleHueSatMap => {
            HashMap::from([(Illuminant::D65, table(dims, encoding, 0.4, 7.0))])
        }
        Tables::DualHueSatMap { .. } | Tables::DualHueSatMapAndLook => HashMap::from([
            (Illuminant::StdA, table(dims, encoding, 0.0, 9.0)),
            (Illuminant::D65, table(dims, encoding, 1.1, -7.0)),
        ]),
    };
    let forward = |m: Matrix3| m.inverse().expect("calibration inverts");
    RawImage {
        width: 1,
        height: 1,
        cfa: CfaPattern::Rggb,
        black_level: [0; 4],
        white_level: 65535,
        raw_data: vec![0],
        as_shot_neutral: AS_SHOT_NEUTRAL,
        as_shot_cct: None,
        camera_make: "Test".into(),
        camera_model: "Creative".into(),
        unique_camera_model: None,
        color_matrices: HashMap::from([
            (Illuminant::StdA, COLOR_MATRIX_STD_A),
            (Illuminant::D65, COLOR_MATRIX_D65),
        ]),
        forward_matrices: HashMap::from([
            (Illuminant::StdA, forward(COLOR_MATRIX_STD_A)),
            (Illuminant::D65, forward(COLOR_MATRIX_D65)),
        ]),
        orientation: ExifOrientation::Normal,
        baseline_exposure: 0.0,
        hsm_data: hue_sat_maps,
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

fn profile(raw: &RawImage, tables: Tables) -> DcpProfile {
    let profile = dcp::profile_for(raw).expect("embedded calibration resolves");
    match tables {
        Tables::DualHueSatMapAndLook => DcpProfile {
            look_table: Some(table([6, 3, 4], HsmEncoding::Srgb, 0.7, 5.0)),
            ..profile
        },
        _ => profile,
    }
}

/// A calibrated creative stage on the synthetic camera, with a given
/// exposure gain and an absolute white balance.
pub fn creative_stage(tables: Tables, ae_gain: f32) -> CreativeStage {
    let raw = raw(tables);
    let profile = profile(&raw, tables);
    CreativeStage {
        frame: Some(SliderFrame::resolve(&raw, &profile)),
        profile,
        as_shot_neutral: raw.as_shot_neutral,
        anchors: CreativeAnchors::Given {
            ae_gain,
            decoded_wb: None,
        },
    }
}

/// The same camera taken through the uncalibrated tiers: no slider frame, so
/// white balance is the post-DCP matrix.
pub fn fallback_stage(tables: Tables, ae_gain: f32) -> CreativeStage {
    CreativeStage {
        frame: None,
        ..creative_stage(tables, ae_gain)
    }
}
