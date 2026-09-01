//! #2321 continuity gate: camera-space WB near the as-shot point.
//!
//! Sibling of [`super::tests`] (`wb_camera_tests.rs`) split out under the
//! 600-LOC file-size budget — same pattern as `wb_camera_frame_tests.rs`.
//!
//! `apply`'s identity short-circuit forces a bit-exact no-op AT
//! `(frame.scene_cct, 0)` (module doc), but `camera_wb_gain`'s general
//! formula is only APPROXIMATELY identity there once `as_shot_neutral`
//! sits off the pure blackbody locus — which a real scene's as-shot
//! chromaticity generally does (that's the entire reason `tint` exists as
//! a second, perpendicular axis). So a `(temperature, tint)` one kelvin
//! either side of the short-circuit's 0.5K/0.5-tint tolerance should move
//! pixels by O(delta), not jump by the whole off-locus gap. See #2321.

use super::*;
use crate::image::{ColorSpace, Image};
use crate::math::Matrix3;

/// A plausible (non-identity) DNG ColorMatrix — same fixture
/// `wb_camera_tests.rs` uses, reused here for a realistic off-locus gap.
const CM: [[f32; 3]; 3] = [
    [0.6722, -0.0635, -0.0963],
    [-0.4287, 1.2460, 0.2028],
    [-0.0908, 0.2162, 0.5668],
];

fn frame(scene_cct: f32) -> SliderFrame {
    SliderFrame {
        endpoints: None,
        cm_as_shot: Matrix3(CM),
        scene_cct,
        render_cm: Matrix3(CM),
    }
}

/// An as-shot neutral measurably off the `tint=0` locus at `cct` —
/// `camera_neutral_for` at a nonzero tint sits away from the on-locus
/// point at the same CCT, manufacturing the real off-locus gap a camera's
/// as-shot chromaticity generally has.
fn off_locus_as_shot(cct: f32) -> [f32; 3] {
    camera_neutral_for(Matrix3(CM), cct, 40.0)
}

/// Temperature-only row. Currently RED — measured on this exact fixture: a
/// 1K nudge off as-shot moves a channel by an 0.1151 fraction (11.5%), not
/// the O(1K) response the gate expects. See #2321.
#[test]
#[ignore = "#2321: camera-space WB is discontinuous at the as-shot point \
            (measured: a 1K nudge moves a channel by 11.5%, not O(delta)); \
            ignored pending the design question #1746 leaves open"]
fn temperature_only_custom_wb_near_as_shot_moves_by_o_delta_not_a_cliff() {
    let scene_cct = 5500.0_f32;
    let as_shot_neutral = off_locus_as_shot(scene_cct);
    let frame = frame(scene_cct);
    let baseline = [0.4_f32, 0.2, 0.3];

    let mut as_shot = Image::new(1, 1, ColorSpace::CameraNativeLinearRgb);
    as_shot.pixels[0] = baseline;
    apply(&mut as_shot, &frame, as_shot_neutral, scene_cct, 0.0);
    assert_eq!(
        as_shot.pixels[0], baseline,
        "as-shot must remain the exact reference no-op"
    );

    const DELTA_K: f32 = 1.0;
    let model = AdjustmentModel {
        temperature: scene_cct + DELTA_K,
        temperature_seen: true,
        tint_seen: false,
        ..AdjustmentModel::default()
    };
    let (t, tint) = resolve_target(&model, &frame);
    let mut nudged = Image::new(1, 1, ColorSpace::CameraNativeLinearRgb);
    nudged.pixels[0] = baseline;
    apply(&mut nudged, &frame, as_shot_neutral, t, tint);

    let max_frac_move = nudged.pixels[0]
        .iter()
        .zip(baseline.iter())
        .map(|(a, b)| (a - b).abs() / b.max(1e-6))
        .fold(0.0_f32, f32::max);
    assert!(
        max_frac_move < 0.02 * DELTA_K,
        "a {DELTA_K}K nudge off as-shot moved a channel by {max_frac_move:.4} \
         (fraction) — a real O(delta) response stays far below this; got a \
         step consistent with the whole off-locus gap, not a small delta"
    );
}

/// Tint-only mirror row: a tint-only Custom WB must not move the effective
/// temperature off the image's own as-shot CCT. `resolve_target`'s As-Shot
/// branch only fires when NEITHER `_seen` flag is set, so
/// `tint_seen=true, temperature_seen=false` instead passes
/// `model.temperature` — still the literal 6500.0 default — straight
/// through. Currently RED — measured on this exact fixture: resolves to
/// 6500K instead of the image's own 3200K as-shot CCT, a 3300K jump. See
/// #2321.
#[test]
#[ignore = "#2321: a tint-only Custom WB yanks temperature to the model \
            default (measured: resolves to 6500K instead of the image's \
            own 3200K as-shot CCT)"]
fn tint_only_custom_wb_does_not_move_temperature_off_as_shot_cct() {
    let scene_cct = 3200.0_f32; // far from AdjustmentModel::default()'s 6500K
    let frame = frame(scene_cct);
    let model = AdjustmentModel {
        tint: 10.0,
        tint_seen: true,
        temperature_seen: false,
        ..AdjustmentModel::default()
    };
    let (t, _tint) = resolve_target(&model, &frame);
    assert!(
        (t - scene_cct).abs() < 50.0,
        "tint-only Custom WB must resolve near this image's as-shot CCT \
         ({scene_cct}), not the model's literal default temperature — got {t}"
    );
}
