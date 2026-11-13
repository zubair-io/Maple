//! The render profile's own CCT for a white-balance slider target, at which a
//! develop re-interpolates a dual-calibration profile (#4633).

use crate::{
    color::dcp::{self, DcpProfile},
    math::Matrix3,
};

use super::{camera_neutral_for, is_as_shot_target, SliderFrame};

/// The illuminant a dual calibration reads the target's camera neutral as
/// (`retargeted_render_profile` doc). `None` at the as-shot target, where
/// the render profile passes through untouched.
fn retarget_render_cct(
    frame: &SliderFrame,
    e: &dcp::CmEndpoints,
    temperature: f32,
    tint: f32,
) -> Option<f32> {
    if is_as_shot_target(frame, temperature, tint) {
        return None;
    }
    let target_neutral = camera_neutral_for(frame.cm_for_cct(temperature), temperature, tint);
    Some(dcp::compute_as_shot_cct(
        target_neutral,
        e.m_cold,
        e.cct_cold,
        e.m_warm,
        e.cct_warm,
    ))
}

/// What a white-balance retarget re-interpolates in a dual-calibration render
/// profile: its endpoints, the CCT it reads the target at and the
/// ForwardMatrix there.
pub(crate) struct RenderRetarget {
    pub endpoints: dcp::CmEndpoints,
    pub cct: f32,
    pub forward_matrix: Option<Matrix3>,
}

pub(crate) fn render_retarget(
    frame: &SliderFrame,
    profile: &DcpProfile,
    temperature: f32,
    tint: f32,
) -> Option<RenderRetarget> {
    let endpoints = profile.cm_endpoints?;
    let cct = retarget_render_cct(frame, &endpoints, temperature, tint)?;
    Some(RenderRetarget {
        endpoints,
        cct,
        forward_matrix: profile.forward_matrix_for_cct(cct),
    })
}
