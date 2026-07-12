//! Unit tests for [`super`]'s #1727 surface — the [`SliderFrame`]
//! slider-scale anchoring and the [`retargeted_render_profile`]
//! ForwardMatrix retarget. Split from `wb_camera_tests.rs` to keep both
//! files inside the 600-line hard budget (CONTRIBUTING.md § "File-size
//! budget").

use super::*;
use crate::color::illuminant::Illuminant;
use crate::math::Matrix3;

/// Same realistic stand-in calibration `wb_camera_tests.rs` uses (Canon
/// EOS 5D Mark III D65 CM2).
const CANON_5D3_D65_CM: [[f32; 3]; 3] = [
    [0.6722, -0.0635, -0.0963],
    [-0.4287, 1.2460, 0.2028],
    [-0.0908, 0.2162, 0.5668],
];

/// #1727: with a dual-illuminant slider frame, `camera_wb_gain` projects
/// the target chromaticity through the frame's CM re-interpolated at the
/// TARGET's own CCT (the DNG-spec xy→neutral direction), not through a
/// fixed as-shot matrix.
///
/// Verified via `interpolate_cm`'s clamp contract: a 2000 K target sits
/// below the cold endpoint (StdA, 2856 K), so the dual-frame gain must
/// equal one computed against a single-CM frame pinned to the cold
/// endpoint matrix — and must differ measurably from a gain projected
/// through the warm/as-shot matrix, proving the per-target interpolation
/// is live.
#[test]
fn dual_illuminant_gain_uses_target_cct_interpolated_cm() {
    // Plausible non-identity StdA-side calibration, visibly different from
    // the D65-side CANON_5D3_D65_CM so the interpolation has real spread.
    let m_cold = Matrix3([
        [0.7234, 0.0231, -0.0542],
        [-0.3956, 1.1998, 0.2239],
        [-0.0512, 0.1892, 0.5231],
    ]);
    let m_warm = Matrix3(CANON_5D3_D65_CM);
    let as_shot_neutral = [0.55_f32, 1.0, 0.62];
    let scene_cct = 5500.0_f32;
    let dual = SliderFrame {
        endpoints: Some((
            m_cold,
            Illuminant::StdA.cct(),
            m_warm,
            Illuminant::D65.cct(),
        )),
        cm_as_shot: dcp::interpolate_cm(
            m_cold,
            Illuminant::StdA.cct(),
            m_warm,
            Illuminant::D65.cct(),
            scene_cct,
        ),
        scene_cct,
        render_cm: Matrix3([[0.6722,-0.0635,-0.0963],[-0.4287,1.2460,0.2028],[-0.0908,0.2162,0.5668]]),
    };

    // Frame pinned to the cold endpoint CM with no endpoints: at a 2000 K
    // target (clamped below StdA's 2856 K) both must project through
    // exactly m_cold, so the gains must agree bit-for-bit.
    let cold_pinned = SliderFrame {
        endpoints: None,
        cm_as_shot: m_cold,
        scene_cct,
        render_cm: Matrix3([[0.6722,-0.0635,-0.0963],[-0.4287,1.2460,0.2028],[-0.0908,0.2162,0.5668]]),
    };
    let g_dual = camera_wb_gain(&dual, as_shot_neutral, 2000.0, 0.0);
    let g_cold = camera_wb_gain(&cold_pinned, as_shot_neutral, 2000.0, 0.0);
    assert_eq!(
        g_dual, g_cold,
        "2000 K clamps to the cold endpoint: dual-frame gain must match the cold-pinned frame"
    );

    // Frame pinned to the as-shot-interpolated CM (the pre-#1727 fixed-CM
    // projection): the gain must differ.
    let fixed = SliderFrame {
        endpoints: None,
        cm_as_shot: dual.cm_as_shot,
        scene_cct,
        render_cm: Matrix3([[0.6722,-0.0635,-0.0963],[-0.4287,1.2460,0.2028],[-0.0908,0.2162,0.5668]]),
    };
    let g_fixed = camera_wb_gain(&fixed, as_shot_neutral, 2000.0, 0.0);
    assert!(
        (g_dual[0] - g_fixed[0]).abs() > 1e-4 || (g_dual[2] - g_fixed[2]).abs() > 1e-4,
        "per-target CM interpolation must actually move the gain vs the fixed as-shot CM: \
         dual {:?} vs fixed {:?}",
        g_dual,
        g_fixed
    );
}

/// #1727 frame mapping: `retargeted_render_profile` at the slider frame's
/// as-shot point must return a bit-identical clone of the render profile
/// (unedited renders unchanged); an off-as-shot target must re-interpolate
/// the ForwardMatrix at the render frame's own CCT reading of the target —
/// and ONLY the ForwardMatrix: the non-FM Bradford inputs (`color_matrix`,
/// `scene_white_xyz`) stay at as-shot so the camera-space gain remains the
/// sole carrier of the cast (measured rationale in
/// `retargeted_render_profile`'s doc).
#[test]
fn retargeted_render_profile_is_identity_at_frame_as_shot() {
    use crate::color::dcp::interpolated_profile;

    let m_cold = Matrix3([
        [0.7234, 0.0231, -0.0542],
        [-0.3956, 1.1998, 0.2239],
        [-0.0512, 0.1892, 0.5231],
    ]);
    let m_warm = Matrix3(CANON_5D3_D65_CM);
    // Distinct FM endpoints so the target-tracking lerp has real spread.
    let fm_cold = Matrix3([
        [0.9500, 0.0200, -0.0100],
        [0.0300, 0.9800, 0.0100],
        [-0.0200, 0.0400, 0.8100],
    ]);
    let fm_warm = Matrix3([
        [0.8100, 0.0900, 0.0600],
        [0.1000, 0.8600, 0.0400],
        [0.0100, 0.1200, 0.6900],
    ]);
    let as_shot_neutral = [0.55_f32, 1.0, 0.62];
    let profile = interpolated_profile(
        m_cold,
        Illuminant::StdA,
        m_warm,
        Illuminant::D65,
        as_shot_neutral,
        /* wb_already_baked */ true,
        None,
        None,
        Some(fm_cold),
        Some(fm_warm),
        None,
        None,
    );
    // A slider frame in a DIFFERENT calibration reading, as an
    // embedded-vs-bundle stand-in.
    let frame = SliderFrame {
        endpoints: None,
        cm_as_shot: m_warm,
        scene_cct: 4800.0,
        render_cm: m_warm,
    };

    // As-shot target (frame's own scene_cct, tint 0): bit-identical
    // pass-through.
    let retargeted = retargeted_render_profile(&frame, profile.clone(), frame.scene_cct, 0.0);
    assert_eq!(retargeted.color_matrix.0, profile.color_matrix.0);
    assert_eq!(
        retargeted.forward_matrix.map(|m| m.0),
        profile.forward_matrix.map(|m| m.0)
    );
    assert_eq!(retargeted.scene_white_xyz, profile.scene_white_xyz);

    // Off-as-shot target: ONLY the ForwardMatrix moves.
    let retargeted_warm = retargeted_render_profile(&frame, profile.clone(), 2000.0, 0.0);
    assert_ne!(
        retargeted_warm.forward_matrix.map(|m| m.0),
        profile.forward_matrix.map(|m| m.0),
        "off-as-shot target must re-interpolate the FM at the render-frame CCT"
    );
    assert_eq!(
        retargeted_warm.color_matrix.0, profile.color_matrix.0,
        "the Bradford-path CM must stay at as-shot"
    );
    assert_eq!(
        retargeted_warm.scene_white_xyz, profile.scene_white_xyz,
        "the Bradford source must stay at as-shot (gain is the sole cast carrier)"
    );
}
