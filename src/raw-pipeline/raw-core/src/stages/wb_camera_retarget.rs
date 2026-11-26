//! What a develop re-resolves in the render profile for a white-balance
//! slider target: a dual-calibration profile's CCT and ForwardMatrix there
//! (#4633), and any profile's ForwardMatrix at the target's own white
//! (#5093).

use crate::{
    color::dcp::{self, DcpProfile},
    math::{Matrix3, Vec3},
};

use super::{camera_neutral_raw, g_normalize, is_as_shot_target, SliderFrame};

/// The target's G-normalised camera neutral, or `None` when degenerate (the as-shot white stays).
pub(super) fn target_camera_neutral(
    frame: &SliderFrame,
    temperature: f32,
    tint: f32,
) -> Option<Vec3> {
    // The target xy projects through the frame's CM re-interpolated at the target's own CCT (#1727), not the as-shot CM.
    let cm = frame.cm_for_cct(temperature);
    // A non-finite or non-positive component means the CM carries no usable calibration; the gain ratios would explode.
    let raw_neutral = camera_neutral_raw(cm, temperature, tint);
    raw_neutral
        .iter()
        .all(|c| c.is_finite() && *c > 1e-6)
        .then(|| g_normalize(raw_neutral))
}

/// What a white-balance retarget re-resolves in the render profile.
pub(crate) struct RenderRetarget {
    /// The illuminant the dual calibration reads the target's camera neutral
    /// as (`retargeted_render_profile` doc); a single-illuminant profile has
    /// nothing to interpolate and keeps its `scene_cct`.
    pub cct: f32,
    /// The target's camera neutral: the white the retargeted buffer is
    /// divided by.
    pub camera_white: Vec3,
    /// The ForwardMatrix at `cct`, resolved for `camera_white`.
    pub forward_matrix: Option<Matrix3>,
}

/// `None` where the render profile passes through untouched: at the as-shot
/// target, at a degenerate target white ([`target_camera_neutral`]), and for
/// a profile with neither calibration endpoints nor a single-illuminant
/// [`dcp::ForwardReference`] (nothing depends on the white).
pub(crate) fn render_retarget(
    frame: &SliderFrame,
    profile: &DcpProfile,
    temperature: f32,
    tint: f32,
) -> Option<RenderRetarget> {
    if profile.cm_endpoints.is_none() && profile.forward_reference.is_none() {
        return None;
    }
    if is_as_shot_target(frame, temperature, tint) {
        return None;
    }
    let camera_white = target_camera_neutral(frame, temperature, tint)?;
    let cct = profile.cm_endpoints.map_or(profile.scene_cct, |e| {
        dcp::compute_as_shot_cct(camera_white, e.m_cold, e.cct_cold, e.m_warm, e.cct_warm)
    });
    Some(RenderRetarget {
        cct,
        camera_white,
        forward_matrix: profile.forward_matrix_at(cct, camera_white),
    })
}
