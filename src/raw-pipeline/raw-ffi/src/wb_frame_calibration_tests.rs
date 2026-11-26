//! #5093: a decode's unit calibration reaches the per-tick chain through each C struct unchanged.

use crate::buffers::{maple_free_scene_linear_buffer_f32, MapleSceneLinearBufferF32};
use crate::scene_linear_chain::{chain_inputs_from_params, MapleAdjustmentParams};
use crate::scene_linear_chain_tests::default_params;
use crate::scene_linear_f32::flatten_matrix;
use crate::scene_linear_f32_buffer::write_scene_linear_buf_f32;
use crate::wb_frame_flat::{wb_frame_from_flat, WbFrameFlat};
use raw_core::math::Matrix3;
use raw_core::stages::wb_camera::SliderFrameExport;
use raw_core::test_support::creative::{frame_export, largest_gap, Tables};

const UNITS: [Tables; 2] = [Tables::DualUnitCalibration, Tables::SingleUnitCalibration];

fn calibrated_export(tables: Tables) -> SliderFrameExport {
    let export = frame_export(tables);
    let cold = export.render_individual_cold.0.as_flattened();
    let other = match tables {
        Tables::SingleUnitCalibration => Matrix3::IDENTITY,
        _ => export.render_individual_warm,
    };
    assert!(
        largest_gap(cold, other.0.as_flattened()) > 1e-3,
        "{tables:?}: a swap must be visible"
    );
    export
}

fn read_decoded_buffer<T>(
    export: &SliderFrameExport,
    read: impl FnOnce(&MapleSceneLinearBufferF32) -> T,
) -> T {
    let mut buffer = MapleSceneLinearBufferF32::empty();
    write_scene_linear_buf_f32(
        &mut buffer as *mut MapleSceneLinearBufferF32 as usize,
        1,
        1,
        vec![0.0; 4],
        None,
        100,
        export,
        1.0,
        f32::NAN,
        1.0,
        false,
        true,
        true,
        None,
    );
    let value = read(&buffer);
    unsafe { maple_free_scene_linear_buffer_f32(&mut buffer) };
    value
}

fn frame_of(buffer: &MapleSceneLinearBufferF32) -> SliderFrameExport {
    wb_frame_from_flat(&WbFrameFlat {
        m_cold: &buffer.wb_frame_m_cold,
        cct_cold: buffer.wb_frame_cct_cold,
        m_warm: &buffer.wb_frame_m_warm,
        cct_warm: buffer.wb_frame_cct_warm,
        scene_cct: buffer.wb_frame_scene_cct,
        as_shot_tint: buffer.wb_frame_as_shot_tint,
        render_cm: &buffer.wb_frame_render_cm,
        render_forward_matrix: &buffer.wb_frame_render_forward_matrix,
        render_scene_white_xyz: &buffer.wb_frame_render_scene_white_xyz,
        render_cm_cold: &buffer.wb_frame_render_cm_cold,
        render_cct_cold: buffer.wb_frame_render_cct_cold,
        render_cm_warm: &buffer.wb_frame_render_cm_warm,
        render_cct_warm: buffer.wb_frame_render_cct_warm,
        render_fm_cold: &buffer.wb_frame_render_fm_cold,
        render_fm_warm: &buffer.wb_frame_render_fm_warm,
        render_individual_cold: &buffer.wb_frame_render_individual_cold,
        render_individual_warm: &buffer.wb_frame_render_individual_warm,
    })
}

fn params_of(export: &SliderFrameExport) -> MapleAdjustmentParams {
    MapleAdjustmentParams {
        wb_frame_m_cold: flatten_matrix(export.m_cold),
        wb_frame_cct_cold: export.cct_cold,
        wb_frame_m_warm: flatten_matrix(export.m_warm),
        wb_frame_cct_warm: export.cct_warm,
        wb_frame_scene_cct: export.scene_cct,
        wb_frame_as_shot_tint: export.as_shot_tint,
        wb_frame_render_cm: flatten_matrix(export.render_cm),
        wb_frame_render_forward_matrix: flatten_matrix(export.render_forward_matrix),
        wb_frame_render_scene_white_xyz: export.render_scene_white_xyz,
        wb_frame_render_cm_cold: flatten_matrix(export.render_cm_cold),
        wb_frame_render_cct_cold: export.render_cct_cold,
        wb_frame_render_cm_warm: flatten_matrix(export.render_cm_warm),
        wb_frame_render_cct_warm: export.render_cct_warm,
        wb_frame_render_fm_cold: flatten_matrix(export.render_fm_cold),
        wb_frame_render_fm_warm: flatten_matrix(export.render_fm_warm),
        wb_frame_render_individual_cold: flatten_matrix(export.render_individual_cold),
        wb_frame_render_individual_warm: flatten_matrix(export.render_individual_warm),
        ..default_params()
    }
}

#[test]
fn a_decoded_buffer_carries_the_calibrated_frame_unchanged() {
    for tables in UNITS {
        let export = calibrated_export(tables);
        assert_eq!(read_decoded_buffer(&export, frame_of), export, "{tables:?}");
    }
}

#[test]
fn the_chain_rebuilds_the_calibrated_frame_from_its_params() {
    for tables in UNITS {
        let export = calibrated_export(tables);
        let params = params_of(&export);
        let inputs = unsafe { chain_inputs_from_params(&params) }.expect("chain inputs");
        assert_eq!(inputs.wb_frame, export, "{tables:?}");
    }
}
