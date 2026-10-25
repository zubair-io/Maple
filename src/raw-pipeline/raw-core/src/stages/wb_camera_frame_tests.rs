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
        scene_tint: 0.0,
        render_cm: Matrix3([
            [0.6722, -0.0635, -0.0963],
            [-0.4287, 1.2460, 0.2028],
            [-0.0908, 0.2162, 0.5668],
        ]),
    };

    // Frame pinned to the cold endpoint CM with no endpoints: at a 2000 K
    // target (clamped below StdA's 2856 K) both must project through
    // exactly m_cold, so the gains must agree bit-for-bit.
    let cold_pinned = SliderFrame {
        endpoints: None,
        cm_as_shot: m_cold,
        scene_cct,
        scene_tint: 0.0,
        render_cm: Matrix3([
            [0.6722, -0.0635, -0.0963],
            [-0.4287, 1.2460, 0.2028],
            [-0.0908, 0.2162, 0.5668],
        ]),
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
        scene_tint: 0.0,
        render_cm: Matrix3([
            [0.6722, -0.0635, -0.0963],
            [-0.4287, 1.2460, 0.2028],
            [-0.0908, 0.2162, 0.5668],
        ]),
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
        scene_tint: 0.0,
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

/// #4633: a retarget resolves the dual-illuminant HueSatMap at the same
/// render-frame CCT as the ForwardMatrix, with the reciprocal-CCT weight;
/// as-shot and single-table profiles keep their table.
#[test]
fn retargeted_render_profile_resolves_the_hue_sat_map_at_the_target() {
    use crate::color::dcp::{compute_as_shot_cct, interpolated_profile};
    use crate::color::hsm::{HsmEncoding, HsmTable};

    let table = |hue: f32, sat: f32, val: f32| {
        HsmTable::new([2, 2, 1], [hue, sat, val].repeat(4), HsmEncoding::Linear).unwrap()
    };
    let (cold, warm) = (table(0., 1., 1.), table(10., 1.2, 0.9));
    let m_cold = Matrix3([
        [0.7234, 0.0231, -0.0542],
        [-0.3956, 1.1998, 0.2239],
        [-0.0512, 0.1892, 0.5231],
    ]);
    let m_warm = Matrix3(CANON_5D3_D65_CM);
    let fm = Matrix3::IDENTITY;
    let dual = |hsm_warm: Option<&HsmTable>| {
        interpolated_profile(
            m_cold,
            Illuminant::StdA,
            m_warm,
            Illuminant::D65,
            [0.55, 1.0, 0.62],
            false,
            Some(&cold),
            hsm_warm,
            Some(fm),
            Some(fm),
            None,
            None,
        )
    };
    let profile = dual(Some(&warm));
    let frame = SliderFrame {
        endpoints: Some((
            m_cold,
            Illuminant::StdA.cct(),
            m_warm,
            Illuminant::D65.cct(),
        )),
        cm_as_shot: profile.color_matrix,
        scene_cct: profile.scene_cct,
        scene_tint: 0.0,
        render_cm: profile.color_matrix,
    };
    let hsm_at = |p: &DcpProfile, temperature: f32| {
        retargeted_render_profile(&frame, p.clone(), temperature, 0.)
            .hsm
            .unwrap()
            .data
    };

    assert_eq!(
        hsm_at(&profile, frame.scene_cct),
        profile.hsm.clone().unwrap().data
    );
    assert_eq!(
        hsm_at(&profile, 2000.),
        cold.data,
        "below StdA clamps to cold"
    );
    assert_eq!(
        hsm_at(&profile, 12000.),
        warm.data,
        "above D65 clamps to warm"
    );

    let temperature = 4000.;
    let neutral = camera_neutral_for(frame.cm_for_cct(temperature), temperature, 0.);
    let (cct_cold, cct_warm) = (Illuminant::StdA.cct(), Illuminant::D65.cct());
    let render_cct = compute_as_shot_cct(neutral, m_cold, cct_cold, m_warm, cct_warm);
    let t = (1. / render_cct - 1. / cct_cold) / (1. / cct_warm - 1. / cct_cold);
    assert!(t > 0.05 && t < 0.95, "{t}");
    let interior = hsm_at(&profile, temperature);
    let expected = [10. * t, 1. + 0.2 * t, 1. - 0.1 * t];
    for (got, want) in interior.iter().zip(expected.iter().cycle()) {
        assert!((got - want).abs() < 1e-4, "{got} vs {want}");
    }
    assert_ne!(interior, profile.hsm.clone().unwrap().data);

    let single = dual(None);
    assert!(single.hsm_endpoints.is_none());
    assert_eq!(hsm_at(&single, 2000.), cold.data);

    let bradford = DcpProfile {
        forward_matrix: None,
        cm_endpoints: profile
            .cm_endpoints
            .map(|e| crate::color::dcp::CmEndpoints {
                fm_cold: None,
                fm_warm: None,
                ..e
            }),
        ..profile.clone()
    };
    assert_eq!(
        hsm_at(&bradford, 2000.),
        profile.hsm.clone().unwrap().data,
        "the non-FM Bradford path keeps its as-shot HueSatMap"
    );
}

/// #4633: the re-lerp works cell by cell, including a hue delta that wraps
/// across 360°, so a mis-ordered or table-wide shortcut would fail.
#[test]
fn retargeted_hue_sat_map_lerps_each_cell_on_the_shorter_arc() {
    use crate::color::dcp::interpolated_profile;
    use crate::color::hsm::{HsmEncoding, HsmTable};

    let cold = HsmTable::new(
        [2, 1, 1],
        vec![350., 1.0, 1.0, 20., 0.8, 1.0],
        HsmEncoding::Linear,
    )
    .unwrap();
    let warm = HsmTable::new(
        [2, 1, 1],
        vec![10., 1.0, 1.0, 40., 1.2, 1.0],
        HsmEncoding::Linear,
    )
    .unwrap();
    let m_warm = Matrix3(CANON_5D3_D65_CM);
    let profile = interpolated_profile(
        m_warm,
        Illuminant::StdA,
        m_warm,
        Illuminant::D65,
        [0.55, 1.0, 0.62],
        false,
        Some(&cold),
        Some(&warm),
        Some(Matrix3::IDENTITY),
        Some(Matrix3::IDENTITY),
        None,
        None,
    );
    let e = profile.cm_endpoints.unwrap();
    let t = 0.25f32;
    let target_cct = 1. / (1. / e.cct_cold + t * (1. / e.cct_warm - 1. / e.cct_cold));
    let lerped = crate::color::dcp::lerp_hsm_for_cct(
        profile.hsm_endpoints.as_ref().map(|h| &h.cold),
        profile.hsm_endpoints.as_ref().map(|h| &h.warm),
        e.cct_cold,
        e.cct_warm,
        target_cct,
    )
    .unwrap()
    .data;
    let expected = [355., 1.0, 1.0, 25., 0.9, 1.0];
    for (got, want) in lerped.iter().zip(expected) {
        assert!((got - want).abs() < 1e-3, "{lerped:?}");
    }
}
