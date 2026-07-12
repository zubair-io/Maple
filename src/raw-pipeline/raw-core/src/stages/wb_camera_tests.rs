//! Unit tests for [`super`] (camera-space white balance, #1726).

use super::*;
use crate::color::illuminant::Illuminant;
use crate::image::{ColorSpace, Image};
use crate::math::Matrix3;

/// A plausible (non-identity) DNG ColorMatrix — Canon EOS 5D Mark III's D65
/// CM2 from the real fixture inspected for this ticket, reused here as a
/// realistic stand-in so the tests exercise real-world-shaped math rather
/// than an identity or diagonal toy matrix.
const CANON_5D3_D65_CM: [[f32; 3]; 3] = [
    [0.6722, -0.0635, -0.0963],
    [-0.4287, 1.2460, 0.2028],
    [-0.0908, 0.2162, 0.5668],
];

/// Build a single-calibration `SliderFrame` fixture — the shape
/// `SliderFrame::resolve` produces for a single embedded CM (or a
/// single-illuminant render profile).
fn test_frame(scene_cct: f32, cm: [[f32; 3]; 3]) -> SliderFrame {
    SliderFrame {
        endpoints: None,
        cm_as_shot: Matrix3(cm),
        scene_cct,
        render_cm: Matrix3([[0.6722,-0.0635,-0.0963],[-0.4287,1.2460,0.2028],[-0.0908,0.2162,0.5668]]),
    }
}

/// Build a `DcpProfile` fixture the way `color::dcp::single_illuminant_profile`
/// does: `scene_white_xyz = normalize_to_y1(inv(cm) · as_shot_neutral)`.
fn test_profile(scene_cct: f32, cm: [[f32; 3]; 3], as_shot_neutral: [f32; 3]) -> DcpProfile {
    let matrix = Matrix3(cm);
    let scene_white_xyz = matrix
        .inverse()
        .map(|inv| normalize_to_y1(inv.mul_vec(as_shot_neutral)))
        .unwrap_or([0.9504, 1.0, 1.0888]);
    DcpProfile {
        illuminant: Illuminant::D65,
        color_matrix: matrix,
        forward_matrix: None,
        scene_cct,
        scene_white_xyz,
        wb_already_baked: true,
        hsm: None,
        look_table: None,
        tone_curve: None,
        cm_endpoints: None,
    }
}

/// Local copy of `color::dcp`'s private `normalize_to_y1` helper, for
/// building test fixtures the same way the real resolver does.
fn normalize_to_y1(xyz: [f32; 3]) -> [f32; 3] {
    if xyz[1].abs() < 1e-8 {
        return crate::color::matrices::XYZ_D65;
    }
    let s = 1.0 / xyz[1];
    [xyz[0] * s, 1.0, xyz[2] * s]
}

#[test]
fn gain_is_approximately_identity_near_the_as_shot_reference_point() {
    // camera_wb_gain is NOT exactly [1,1,1] at (scene_cct, 0) in general —
    // see the module doc: a real as-shot chromaticity generally sits
    // slightly off the pure blackbody locus `cct_to_xy` describes at
    // tint=0 (that's what tint is FOR). But it should be CLOSE when the
    // as-shot neutral truly is near that locus point, and `apply`'s
    // explicit short-circuit is what supplies exactness — this test pins
    // the "close" half of that story.
    let cm = Matrix3(CANON_5D3_D65_CM);
    for scene_cct in [3200.0_f32, 5500.0, 6500.0, 7200.0, 9000.0] {
        // Construct an as-shot neutral that IS exactly on the locus at this
        // CCT, so the approximation gap is zero and gain must be exact.
        let as_shot_neutral = camera_neutral_for(cm, scene_cct, 0.0);
        let frame = test_frame(scene_cct, CANON_5D3_D65_CM);
        let gain = camera_wb_gain(&frame, as_shot_neutral, scene_cct, 0.0);
        assert!(
            (gain[0] - 1.0).abs() < 1e-5,
            "scene_cct {scene_cct}: R gain {} != 1",
            gain[0]
        );
        assert_eq!(gain[1], 1.0, "G gain must be exactly 1 by construction");
        assert!(
            (gain[2] - 1.0).abs() < 1e-5,
            "scene_cct {scene_cct}: B gain {} != 1",
            gain[2]
        );
    }
}

#[test]
fn apply_is_pixel_identical_no_op_at_as_shot_point() {
    let scene_cct = 5500.0_f32;
    let as_shot_neutral = [0.6063_f32, 1.0, 0.4619];
    let frame = test_frame(scene_cct, CANON_5D3_D65_CM);
    let mut img = Image::new(2, 2, ColorSpace::CameraNativeLinearRgb);
    for (i, p) in img.pixels.iter_mut().enumerate() {
        *p = [0.1 * (i as f32 + 1.0), 0.2, 0.3];
    }
    let before = img.pixels.clone();
    apply(&mut img, &frame, as_shot_neutral, scene_cct, 0.0);
    assert_eq!(
        img.pixels, before,
        "as-shot (T, tint) must be a bit-exact no-op regardless of the (approximate) gain formula"
    );
}

#[test]
fn warmer_target_than_as_shot_boosts_red_gain() {
    // Requesting a WARMER target illuminant than the as-shot scene is the
    // "make the image warmer" direction (matches `temp_warmer_makes_r_gt_b`
    // in the grey_adjustments closed-form contract for the post-DCP path) —
    // camera space uses the same sign convention via the shared `cct_to_xy`.
    let scene_cct = 5500.0_f32;
    let as_shot_neutral = [0.6063_f32, 1.0, 0.4619];
    let frame = test_frame(scene_cct, CANON_5D3_D65_CM);
    let gain_warm_target = camera_wb_gain(&frame, as_shot_neutral, scene_cct + 2000.0, 0.0);
    assert!(
        gain_warm_target[0] > 1.0,
        "raising target temperature should boost R gain, got {}",
        gain_warm_target[0]
    );
    assert!(
        gain_warm_target[2] < 1.0,
        "raising target temperature should cut B gain, got {}",
        gain_warm_target[2]
    );
}

#[test]
fn cooler_target_than_as_shot_cuts_red_gain() {
    let scene_cct = 5500.0_f32;
    let as_shot_neutral = [0.6063_f32, 1.0, 0.4619];
    let frame = test_frame(scene_cct, CANON_5D3_D65_CM);
    let gain_cool_target = camera_wb_gain(&frame, as_shot_neutral, scene_cct - 2000.0, 0.0);
    assert!(
        gain_cool_target[0] < 1.0,
        "lowering target temperature should cut R gain, got {}",
        gain_cool_target[0]
    );
    assert!(
        gain_cool_target[2] > 1.0,
        "lowering target temperature should boost B gain, got {}",
        gain_cool_target[2]
    );
}

#[test]
fn tint_sign_matches_shared_convention() {
    let scene_cct = 6500.0_f32;
    let as_shot_neutral = [1.0_f32, 1.0, 1.0];
    let frame = test_frame(scene_cct, CANON_5D3_D65_CM);
    let gain_plus = camera_wb_gain(&frame, as_shot_neutral, scene_cct, 30.0);
    let gain_minus = camera_wb_gain(&frame, as_shot_neutral, scene_cct, -30.0);
    // Positive tint should differ from negative tint on both non-green
    // channels (opposite direction), exercising the same sign convention
    // `cct_to_xy`/`xy_to_xyz` already encode for the post-DCP path.
    assert!(
        (gain_plus[0] - gain_minus[0]).abs() > 1e-4,
        "tint should move R gain: plus {} minus {}",
        gain_plus[0],
        gain_minus[0]
    );
    assert!(
        (gain_plus[2] - gain_minus[2]).abs() > 1e-4,
        "tint should move B gain: plus {} minus {}",
        gain_plus[2],
        gain_minus[2]
    );
}

#[test]
fn extreme_temperature_gain_stays_finite_and_bounded() {
    // The whole point of #1726: camera-space gains at extreme slider
    // settings (12000K) must stay finite and reasonably bounded — NOT
    // manufacture the unbounded scene-linear excursions the post-DCP CAT16
    // path could produce (the yellow-filter/banding repro).
    let scene_cct = 5500.0_f32;
    let as_shot_neutral = [0.6063_f32, 1.0, 0.4619];
    let frame = test_frame(scene_cct, CANON_5D3_D65_CM);
    let gain = camera_wb_gain(&frame, as_shot_neutral, 12000.0, 17.0);
    for (i, g) in gain.iter().enumerate() {
        assert!(g.is_finite(), "channel {i} gain not finite: {g}");
        assert!(
            *g > 0.05 && *g < 20.0,
            "channel {i} gain {g} outside sane bounds"
        );
    }
}

#[test]
fn singular_matrix_falls_back_to_identity_gain() {
    let frame = test_frame(6500.0, [[0.0; 3]; 3]);
    let gain = camera_wb_gain(&frame, [0.5, 1.0, 0.7], 3000.0, 20.0);
    // A zero matrix projects the target chromaticity to [0, 0, 0] — no
    // usable calibration. The documented contract is an exact identity
    // fallback, NOT merely "finite": without the explicit degenerate check
    // the 1e-6 clamps would yield huge finite gains (asn / 1e-6), not a
    // no-op.
    assert_eq!(
        gain,
        [1.0, 1.0, 1.0],
        "degenerate CM must fall back to the exact identity gain"
    );
}

#[test]
fn apply_asserts_camera_native_color_space() {
    let scene_cct = 5500.0_f32;
    let as_shot_neutral = [0.6063_f32, 1.0, 0.4619];
    let frame = test_frame(scene_cct, CANON_5D3_D65_CM);
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        apply(&mut img, &frame, as_shot_neutral, 3000.0, 10.0);
    }));
    assert!(
        result.is_err(),
        "apply must assert CameraNativeLinearRgb and reject a scene-linear buffer"
    );
}

/// Contract regression test (attempt-2 redesign, #1726): a NEUTRAL
/// camera-native buffer, gained toward a non-as-shot target and run
/// through `dcp::apply_colorimetry` with the UNMODIFIED profile (the
/// current, correct contract — no `retarget_profile` step), must NOT stay
/// neutral. This is the deliberately-inverted twin of attempt 1's
/// `apply_with_retarget_profile_keeps_neutral_scene_neutral` test: that
/// test asserted "stays neutral" as success, which was actually pinning
/// the double-Bradford-cancellation bug (retargeting `scene_white_xyz` at
/// the gained point let DCP's Bradford step adapt the shift away almost
/// entirely). Per the redesign contract, the diagonal gain is the SOLE
/// carrier of the cast — DCP's Bradford step keeps adapting from the TRUE
/// as-shot white regardless of the gain, so a neutral scene rendered at a
/// non-as-shot target must show a real, non-trivial cast in the output,
/// and that cast's direction must match the requested target (warmer
/// target → higher R than B).
#[test]
fn apply_with_unmodified_profile_casts_a_neutral_scene_off_neutral() {
    use crate::color::dcp::apply_colorimetry;

    let scene_cct = 5500.0_f32;
    let as_shot_neutral = [0.6063_f32, 1.0, 0.4619];
    let frame = test_frame(scene_cct, CANON_5D3_D65_CM);
    let profile = test_profile(scene_cct, CANON_5D3_D65_CM, as_shot_neutral);

    // A buffer that is neutral post-pre-gain (i.e. every pixel already
    // reads AsShotNeutral-normalised (1,1,1) — the DNG-spec neutral scene
    // patch).
    let mut img = Image::new(2, 2, ColorSpace::CameraNativeLinearRgb);
    for p in &mut img.pixels {
        *p = [1.0, 1.0, 1.0];
    }

    // Warmer-than-as-shot target: expect a warm (R > B) cast to survive
    // through DCP, not cancel back to neutral.
    let (temperature, tint) = (12000.0_f32, 0.0);
    let mut buf = img.clone();
    apply(&mut buf, &frame, as_shot_neutral, temperature, tint);
    let scene = apply_colorimetry(&buf, &profile).expect("apply_colorimetry");
    for (i, p) in scene.pixels.iter().enumerate() {
        let (r, _g, b) = (p[0], p[1], p[2]);
        assert!(
            (r - b).abs() > 0.02,
            "T={temperature} tint={tint} pixel {i}: expected a real, \
             non-cancelled cast (|R-B| > 0.02) on a neutral input through \
             the unmodified profile, got ({r}, {_g}, {b})"
        );
    }
}

/// `resolve_target` must pass an explicit Custom WB (both `crs:Temperature`
/// and `crs:Tint` authored, both `_seen` flags set — see `xmp::set_field`)
/// straight through unchanged.
#[test]
fn resolve_target_passes_through_explicit_custom_wb() {
    let frame = test_frame(5500.0, CANON_5D3_D65_CM);
    let model = crate::xmp::AdjustmentModel {
        temperature: 3200.0,
        tint: -15.0,
        temperature_seen: true,
        tint_seen: true,
        ..crate::xmp::AdjustmentModel::default()
    };
    let (t, tint) = resolve_target(&model, &frame);
    assert_eq!(t, 3200.0);
    assert_eq!(tint, -15.0);
}

/// `resolve_target` must pass a named WB preset's resolved `(temperature,
/// tint)` through unchanged, even though `xmp::wb_preset` never sets the
/// `_seen` flags (presets resolve to a pair at parse time rather than being
/// authored as explicit numeric fields) — matching `white_balance::
/// resolve_wb`'s neither-seen row. Uses Tungsten's real resolved value
/// (2850 K, 0 tint) from `xmp::wb_preset`'s table.
#[test]
fn resolve_target_passes_through_named_preset() {
    let frame = test_frame(5500.0, CANON_5D3_D65_CM);
    let model = crate::xmp::AdjustmentModel {
        temperature: 2850.0,
        tint: 0.0,
        temperature_seen: false,
        tint_seen: false,
        ..crate::xmp::AdjustmentModel::default()
    };
    let (t, tint) = resolve_target(&model, &frame);
    assert_eq!(
        t, 2850.0,
        "named preset's resolved temperature must pass through"
    );
    assert_eq!(tint, 0.0);
}

/// `resolve_target` must zero tint for a temperature-only Custom WB
/// (`temperature_seen` set, `tint_seen` NOT set) — ACR's "absent tint"
/// convention, matching `white_balance::resolve_wb`'s row for the same
/// shape.
#[test]
fn resolve_target_zeroes_tint_for_temperature_only_custom_wb() {
    let frame = test_frame(5500.0, CANON_5D3_D65_CM);
    let model = crate::xmp::AdjustmentModel {
        temperature: 3200.0,
        tint: 42.0, // must be ignored: tint_seen is false
        temperature_seen: true,
        tint_seen: false,
        ..crate::xmp::AdjustmentModel::default()
    };
    let (t, tint) = resolve_target(&model, &frame);
    assert_eq!(t, 3200.0);
    assert_eq!(
        tint, 0.0,
        "tint must zero when temperature_seen && !tint_seen"
    );
}

/// `resolve_target` must substitute the profile's own as-shot reference
/// point when neither `_seen` flag is set AND the model sits at the
/// literal `AdjustmentModel::default()` numeric values — the state parsing
/// leaves a no-sidecar image, or an explicit `crs:WhiteBalance="As Shot"`/
/// absent attribute, in. See the module doc's "As-Shot seeding" section
/// for the full rationale.
#[test]
fn resolve_target_seeds_as_shot_from_profile_scene_cct() {
    let frame = test_frame(5508.0, CANON_5D3_D65_CM);
    let model = crate::xmp::AdjustmentModel::default();
    assert_eq!(model.temperature, 6500.0, "precondition: literal default");
    assert_eq!(model.tint, 0.0, "precondition: literal default");
    assert!(!model.temperature_seen, "precondition: flag unset");
    assert!(!model.tint_seen, "precondition: flag unset");
    let (t, tint) = resolve_target(&model, &frame);
    assert_eq!(
        t, 5508.0,
        "As-Shot model must resolve to the profile's own scene_cct, not 6500K"
    );
    assert_eq!(tint, 0.0);
}

/// An explicit Custom WB dialed to exactly `(6500.0, 0.0)` — both `_seen`
/// flags set — must NOT be re-seeded from `profile.scene_cct`: this is a
/// real, deliberate user choice of D65/no-tint, not "As Shot", and the
/// `_seen` flags (unlike the old numeric-only heuristic) can tell the two
/// apart.
#[test]
fn resolve_target_does_not_reseed_explicit_6500k_custom_wb() {
    let frame = test_frame(5508.0, CANON_5D3_D65_CM);
    let model = crate::xmp::AdjustmentModel {
        temperature: 6500.0,
        tint: 0.0,
        temperature_seen: true,
        tint_seen: true,
        ..crate::xmp::AdjustmentModel::default()
    };
    let (t, tint) = resolve_target(&model, &frame);
    assert_eq!(
        t, 6500.0,
        "explicit Custom WB at 6500K must pass through, not resolve to scene_cct 5508"
    );
    assert_eq!(tint, 0.0);
}

/// End-to-end: an As-Shot model (the literal numeric default) resolved
/// through `resolve_target` and fed to `apply` must be a bit-exact no-op,
/// even when the profile's as-shot CCT is far from 6500K — this is the
/// production bug attempt 1 shipped (13 new baseline breaches): the
/// identity check compared the model's raw, unresolved temperature against
/// `profile.scene_cct` and almost never matched for a real camera.
#[test]
fn resolve_target_then_apply_is_a_no_op_for_as_shot_model_far_from_6500k() {
    let scene_cct = 3200.0_f32; // far from the 6500K numeric default
    let as_shot_neutral = camera_neutral_for(Matrix3(CANON_5D3_D65_CM), scene_cct, 0.0);
    let frame = test_frame(scene_cct, CANON_5D3_D65_CM);
    let model = crate::xmp::AdjustmentModel::default();

    let (target_temperature, target_tint) = resolve_target(&model, &frame);
    let mut img = Image::new(2, 2, ColorSpace::CameraNativeLinearRgb);
    for (i, p) in img.pixels.iter_mut().enumerate() {
        *p = [0.1 * (i as f32 + 1.0), 0.2, 0.3];
    }
    let before = img.pixels.clone();
    apply(
        &mut img,
        &frame,
        as_shot_neutral,
        target_temperature,
        target_tint,
    );
    assert_eq!(
        img.pixels, before,
        "As-Shot model (numeric default) must be a bit-exact no-op via resolve_target, \
         even at a scene_cct far from 6500K"
    );
}

// ---- apply_delta tests (tile-refine delta anchor) ----

#[test]
fn apply_delta_is_identity_when_target_equals_anchor() {
    let scene_cct = 5500.0_f32;
    let as_shot_neutral = [0.6063_f32, 1.0, 0.4619];
    let frame = test_frame(scene_cct, CANON_5D3_D65_CM);
    let mut img = Image::new(2, 2, ColorSpace::CameraNativeLinearRgb);
    for (i, p) in img.pixels.iter_mut().enumerate() {
        *p = [0.1 * (i as f32 + 1.0), 0.2, 0.3];
    }
    let before = img.pixels.clone();
    // Anchor far from profile.scene_cct AND with a large tint — the exact
    // shape that defeats `apply`'s single fixed identity point (a real
    // camera's as-shot chromaticity can sit beyond the tint slider's ±100
    // range from the locus at its own CCT).
    apply_delta(
        &mut img,
        &frame,
        as_shot_neutral,
        (3000.0, 90.0),
        (3000.0, 90.0),
    );
    assert_eq!(
        img.pixels, before,
        "target == anchor must be a bit-exact no-op regardless of how far \
         the shared point sits from profile.scene_cct"
    );
}

#[test]
fn apply_delta_reaches_identity_beyond_apply_single_reference_point() {
    // The regression this function exists to fix: an anchor whose tint is
    // far enough from 0 that `apply`'s hardcoded `tint.abs() < 0.5` check
    // would never short-circuit, even though target == anchor should be a
    // no-op. Uses a large tint (90) at a CCT away from scene_cct (5500) to
    // simulate a real camera's clamped-at-the-rail as-shot tint (measured:
    // +144, clamped to +100, on a real Hasselblad H2D-39 bundle profile).
    let scene_cct = 5500.0_f32;
    let as_shot_neutral = [0.6063_f32, 1.0, 0.4619];
    let frame = test_frame(scene_cct, CANON_5D3_D65_CM);
    let anchor_temperature = 7200.0_f32;
    let anchor_tint = 90.0_f32;

    // Confirm `apply` (absolute) at this exact point is NOT a no-op —
    // establishing that its identity check genuinely can't reach this
    // point, so `apply_delta`'s own contract is doing real work.
    let mut img_absolute = Image::new(1, 1, ColorSpace::CameraNativeLinearRgb);
    img_absolute.pixels[0] = [0.5, 0.5, 0.5];
    let before_absolute = img_absolute.pixels.clone();
    apply(
        &mut img_absolute,
        &frame,
        as_shot_neutral,
        anchor_temperature,
        anchor_tint,
    );
    assert_ne!(
        img_absolute.pixels, before_absolute,
        "precondition: apply's fixed identity point must NOT cover this anchor"
    );

    // apply_delta at the SAME (temperature, tint) as the anchor must be a
    // bit-exact no-op.
    let mut img_delta = Image::new(1, 1, ColorSpace::CameraNativeLinearRgb);
    img_delta.pixels[0] = [0.5, 0.5, 0.5];
    let before_delta = img_delta.pixels.clone();
    apply_delta(
        &mut img_delta,
        &frame,
        as_shot_neutral,
        (anchor_temperature, anchor_tint),
        (anchor_temperature, anchor_tint),
    );
    assert_eq!(
        img_delta.pixels, before_delta,
        "apply_delta must reach identity at target == anchor even where apply cannot"
    );
}

#[test]
fn apply_delta_moves_in_the_correct_direction_off_anchor() {
    let scene_cct = 5500.0_f32;
    let as_shot_neutral = [0.6063_f32, 1.0, 0.4619];
    let frame = test_frame(scene_cct, CANON_5D3_D65_CM);
    let anchor = (7200.0_f32, 20.0_f32);

    let mut img = Image::new(1, 1, ColorSpace::CameraNativeLinearRgb);
    img.pixels[0] = [1.0, 1.0, 1.0];
    // Warmer than the anchor: expect R > B after the delta, matching the
    // same "warmer target -> higher R" direction `apply`'s own
    // `warmer_target_than_as_shot_boosts_red_gain` test pins.
    apply_delta(
        &mut img,
        &frame,
        as_shot_neutral,
        (anchor.0 + 3000.0, anchor.1),
        anchor,
    );
    let p = img.pixels[0];
    assert!(
        p[0] > p[2],
        "warmer-than-anchor target should give R > B, got {:?}",
        p
    );
}
