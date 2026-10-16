use super::{camera_neutral_for, is_as_shot_target, SliderFrame};
use crate::{
    color::dcp::{self, DcpProfile},
    math::Matrix3,
};

pub fn retargeted_render_profile(
    frame: &SliderFrame,
    profile: DcpProfile,
    temperature: f32,
    tint: f32,
) -> DcpProfile {
    let forward_matrix = resolved_camera_to_xyz_d50(frame, &profile, temperature, tint);
    DcpProfile {
        forward_matrix,
        ..profile
    }
}

pub(crate) fn resolved_camera_to_xyz_d50(
    frame: &SliderFrame,
    profile: &DcpProfile,
    temperature: f32,
    tint: f32,
) -> Option<Matrix3> {
    if is_as_shot_target(frame, temperature, tint) {
        return profile.forward_matrix;
    }
    let supplied_forward = profile.forward_matrix.is_some();
    if (supplied_forward || !profile.wb_already_baked) && profile.cm_endpoints.is_none() {
        return profile.forward_matrix;
    }
    let neutral = camera_neutral_for(frame.cm_for_cct(temperature), temperature, tint);
    let render_cct = match profile.cm_endpoints {
        Some(e) => dcp::compute_as_shot_cct(neutral, e.m_cold, e.cct_cold, e.m_warm, e.cct_warm),
        None => profile.scene_cct,
    };
    if supplied_forward || !profile.wb_already_baked {
        return profile.forward_matrix_for_cct(render_cct);
    }
    dcp::balanced_camera_to_xyz_d50(profile.color_matrix_for_cct(render_cct), neutral)
}

#[cfg(test)]
#[path = "wb_camera_colorimetry_tests.rs"]
mod tests;
