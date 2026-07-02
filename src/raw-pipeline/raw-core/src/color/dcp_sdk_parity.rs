//! SDK-parity test for the DCP stage — `dcp::apply_colorimetry`.
//!
//! Pins the **ForwardMatrix composition** invariant from Adobe's DNG SDK
//! reference implementation, mirroring the math `dng_color_spec.cpp` /
//! `dng_render.cpp` implement.
//!
//! Per `dng_camera_profile.h` (the field comment on `fForwardMatrix1` /
//! `fForwardMatrix2`):
//!
//!     "These matrices map white balanced camera values to XYZ
//!      chromatically adapted to D50."
//!
//! And `dng_color_spec.cpp:444-446` (the `SetWhiteXY` → `fCameraToPCS`
//! build path) shows the SDK's full transform from raw camera RGB to
//! Profile Connection Space (D50 XYZ):
//!
//!     fCameraToPCS = forwardMatrix
//!                  * Invert(refCameraWhite.AsDiagonal())
//!                  * individualToReference;
//!
//! `refCameraWhite` is `CM × XYtoXYZ(whiteXY)` normalised to max=1
//! (`dng_color_spec.cpp:413`). With `AnalogBalance = Identity` and
//! `CameraCalibration = Identity` (the typical case, including all of
//! Maple's fixtures), `individualToReference = Identity` and the chain
//! collapses to `forwardMatrix * Diag(refCameraWhite)⁻¹`.
//!
//! Maple's pipeline (`pipeline::develop`) pre-gains camera RGB by
//! `AsShotNeutral` BEFORE DCP runs, so by the time DCP sees the buffer
//! the white-balance division is already done — meaning FM's *input*
//! is exactly the white-balanced camera RGB the SDK specifies, and
//! FM's *output* is XYZ-D50. Composing FM with `inv(CM)` (the pre-#354
//! code) instead double-applies the camera→reference rotation and
//! bakes a colour cast into every bundled-FM body. This test pins the
//! correct math: a neutral patch going into a body with FM must come
//! out neutral.
//!
//! Originally this module also pinned the HSM → PLT → PTC ordering
//! (`ptc_plt_order_matches_sdk`). That test was removed in #425 once
//! PLT and PTC were dropped from the DCP path — Maple no longer
//! consumes the Adobe aesthetic layers, so there is no ordering to
//! pin.

use crate::{
    color::{
        dcp::{self, DcpProfile},
        illuminant::Illuminant,
        matrices::XYZ_D50,
    },
    image::{ColorSpace, Image},
    math::Matrix3,
};

/// Build a `DcpProfile` matching the SDK contract for the FM path.
///
/// `cm` is the camera-XYZ matrix at the scene illuminant (XYZ → camera).
/// `fm` is the forward matrix (white-balanced camera RGB → XYZ-D50).
/// Pre-gain has already run, so the test feeds (1,1,1) directly and sets
/// `wb_already_baked = true` — same as the Bayer fast path post-#354.
fn fm_test_profile(cm: Matrix3, fm: Matrix3) -> DcpProfile {
    // scene_white_xyz is unused on the FM path but profile_for fills it
    // in via inv(CM) · (1,1,1) when wb_already_baked, so mirror that.
    let inv = cm.inverse().expect("CM invertible in this test");
    let xyz = inv.mul_vec([1.0, 1.0, 1.0]);
    let s = if xyz[1].abs() > 1e-8 {
        1.0 / xyz[1]
    } else {
        1.0
    };
    DcpProfile {
        illuminant: Illuminant::D65,
        color_matrix: cm,
        forward_matrix: Some(fm),
        scene_cct: Illuminant::D65.cct(),
        scene_white_xyz: [xyz[0] * s, 1.0, xyz[2] * s],
        wb_already_baked: true,
        hsm: None,
        look_table: None,
        tone_curve: None,
    }
}

/// SDK contract: with pre-gained camera RGB (the pipeline's actual input
/// to DCP), FM × buffer must produce XYZ-D50. Pre-fix Maple composed
/// `FM × inv(CM)`, which double-applies the camera→reference rotation
/// and breaks neutrality of a neutral scene patch.
///
/// Construction: pick a non-diagonal CM and an FM whose column sums equal
/// the D50 XYZ white point. Then `FM × (1,1,1) = D50_white`, and
/// `inv(M_PRO_TO_XYZ_D50) × D50_white = (1, 1, 1)` (ProPhoto white = D50),
/// which `m_pro_to_rec2020` carries to Rec.2020 white = (1, 1, 1). So
/// the SDK-correct output is exactly neutral.
///
/// The pre-fix code computes `FM × inv(CM) × (1,1,1)`. `inv(CM) · (1,1,1)`
/// is not on the neutral axis for a non-diagonal CM, so the result drifts
/// away from neutrality — typically by tens of % per channel — making the
/// test trip with R/G/B mismatches >> 1e-4.
#[test]
fn fm_path_maps_neutral_to_neutral() {
    // Non-diagonal, plausibly-shaped CM (XYZ → camera). Picked to be
    // well-conditioned and decidedly non-diagonal so `inv(CM) · (1,1,1)`
    // lands far enough off the neutral axis to surface the bug clearly.
    let cm = Matrix3([
        [0.6722, -0.0635, -0.0963],
        [-0.4287, 1.2460, 0.2028],
        [-0.0908, 0.2162, 0.5668],
    ]);
    // FM whose column sums equal D50 XYZ. Equivalently:
    // FM · (1, 1, 1) == XYZ_D50.
    let d = XYZ_D50;
    let fm = Matrix3([
        [d[0] / 3.0 + 0.05, d[0] / 3.0, d[0] / 3.0 - 0.05],
        [d[1] / 3.0, d[1] / 3.0 + 0.04, d[1] / 3.0 - 0.04],
        [d[2] / 3.0 - 0.03, d[2] / 3.0, d[2] / 3.0 + 0.03],
    ]);
    // Sanity: confirm FM column sums == D50 within float epsilon.
    let probe = fm.mul_vec([1.0, 1.0, 1.0]);
    assert!((probe[0] - d[0]).abs() < 1e-5, "FM col-sum R");
    assert!((probe[1] - d[1]).abs() < 1e-5, "FM col-sum G");
    assert!((probe[2] - d[2]).abs() < 1e-5, "FM col-sum B");

    let profile = fm_test_profile(cm, fm);
    // Pre-gain has run upstream; DCP sees (1, 1, 1) for a neutral scene.
    let mut img = Image::new(1, 1, ColorSpace::CameraNativeLinearRgb);
    img.pixels[0] = [1.0, 1.0, 1.0];
    let out = dcp::apply(&img, &profile).expect("DCP apply");
    let p = out.pixels[0];

    // Output in Rec.2020 D65 — a neutral D50 XYZ adapts to Rec.2020 white
    // = (1, 1, 1) modulo Bradford rounding. Tolerance picked at 5e-4 to
    // absorb the ~3e-4 residual from the composed
    // ProPhoto→XYZ_D50→Bradford(D50→D65)→Rec.2020 exit matrix at single
    // precision — well below the ~0.27 pre-fix drift the bug produced.
    let rg = (p[0] - p[1]).abs();
    let bg = (p[2] - p[1]).abs();
    assert!(
        rg < 5e-4 && bg < 5e-4,
        "FM-path neutral patch not neutral in Rec.2020: \
         RGB = ({:.6}, {:.6}, {:.6}), |R-G|={:.6}, |B-G|={:.6}. \
         Pre-fix bug composes FM × inv(CM), which double-rotates the \
         already-white-balanced buffer. SDK contract: FM input is \
         white-balanced camera RGB, output is XYZ-D50 (dng_color_spec.cpp:444-446).",
        p[0],
        p[1],
        p[2],
        rg,
        bg
    );
}

// `ptc_plt_order_matches_sdk` lived here pre-#425. Deleted with the PTC/PLT
// removal — there is no ordering to pin once both stages are gone.
