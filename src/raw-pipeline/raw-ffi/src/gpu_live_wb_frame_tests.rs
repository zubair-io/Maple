//! WB slider-frame gates for the gpu-gated live FFI (#1781) — split out of
//! `gpu_live_tests.rs` per the 600-LOC budget, reusing its `pub(super)`
//! fixture/params helpers.
//!
//! Two layers (a fixture-gated third layer — the live-vs-refine seam
//! measurement on real bodies — lives in the sibling
//! `gpu_live_wb_seam_tests.rs`, split out per the same budget):
//! 1. **Legacy zero-frame equivalence** (marshalling-level, no device):
//!    a zero-filled `wb_frame_*` tail must produce BIT-IDENTICAL
//!    `FullChainInputs` (matrix + gate temp/tint) to the pre-#1781
//!    computation, for both the delta and the 0/0-sentinel absolute
//!    contracts — the append-only ABI promise for stale hosts.
//! 2. **Frame parity gate** (real Metal): a synthetic dual-illuminant
//!    frame at NON-default WB rendered through the GPU live chain must
//!    match the CPU composition of the SAME shared raw-core WB function
//!    (`SliderFrameExport::apply_delta_rec2020`) + view tail + dither —
//!    and at `live == decoded` both paths must be the AgX-only identity.

use super::gpu_live_tests::{make_params, owned_arrays, scene_linear_rgba};
use super::*;
use raw_core::image::{ColorSpace, Image};
use raw_core::stages::wb_camera::SliderFrameExport;
use raw_core::types::WbMethod;
use raw_core::view::auto_profile::curve::ProfileCurve;
use raw_core::view::auto_profile::lut::ColorLut;
use raw_core::xmp::AdjustmentModel;

/// The same plausible dual-illuminant frame the raw-core unit tests use
/// (`wb_frame_delta_tests::synthetic_frame`) — generic wide-gamut sensor
/// calibration pair, well-conditioned, non-identity. Carries NO
/// render-profile detail — the marshalling/legacy-equivalence layers this
/// backs (1/2) exercise the #1904 fixed-C fallback tier deliberately.
fn synthetic_frame() -> SliderFrameExport {
    SliderFrameExport {
        m_cold: raw_core::math::Matrix3([
            [0.8924, -0.1041, 0.0866],
            [-0.4351, 1.2101, 0.2260],
            [-0.0350, 0.1470, 0.7654],
        ]),
        cct_cold: 2856.0,
        m_warm: raw_core::math::Matrix3([
            [0.7534, -0.0682, -0.0512],
            [-0.4351, 1.2101, 0.2260],
            [-0.0996, 0.2327, 0.6567],
        ]),
        cct_warm: 6504.0,
        scene_cct: 5520.0,
        as_shot_tint: -12.0,
        render_cm: raw_core::math::Matrix3([[0.0; 3]; 3]),
        render_forward_matrix: raw_core::math::Matrix3([[0.0; 3]; 3]),
        render_scene_white_xyz: [0.0; 3],
        render_wb_already_baked: 0.0,
        render_cm_cold: raw_core::math::Matrix3([[0.0; 3]; 3]),
        render_cct_cold: 0.0,
        render_cm_warm: raw_core::math::Matrix3([[0.0; 3]; 3]),
        render_cct_warm: 0.0,
        render_fm_cold: raw_core::math::Matrix3([[0.0; 3]; 3]),
        render_fm_warm: raw_core::math::Matrix3([[0.0; 3]; 3]),
    }
}

/// [`synthetic_frame`] plus a plausible dual-illuminant RENDER PROFILE
/// (distinct matrices + a ForwardMatrix pair) — exercises the #1967 exact
/// per-CCT `C(target)`/`C(anchor)` path over REAL Metal hardware in the
/// frame-parity gate below.
fn synthetic_frame_with_render_profile() -> SliderFrameExport {
    let render_cm_cold = raw_core::math::Matrix3([
        [0.7513, -0.0870, 0.1180],
        [-0.4001, 1.1502, 0.2601],
        [-0.0602, 0.1801, 0.8102],
    ]);
    let render_cm_warm = raw_core::math::Matrix3([
        [0.6501, -0.0521, -0.0402],
        [-0.4001, 1.1502, 0.2601],
        [-0.1102, 0.2601, 0.6802],
    ]);
    SliderFrameExport {
        render_cm: render_cm_cold,
        render_forward_matrix: raw_core::math::Matrix3([
            [0.75, 0.18, 0.06],
            [0.28, 0.71, 0.01],
            [-0.01, -0.05, 1.06],
        ]),
        render_scene_white_xyz: [0.9505, 1.0, 1.0888],
        render_wb_already_baked: 1.0,
        render_cm_cold,
        render_cct_cold: 2856.0,
        render_cm_warm,
        render_cct_warm: 6504.0,
        render_fm_cold: raw_core::math::Matrix3([
            [0.79, 0.16, 0.05],
            [0.30, 0.68, 0.02],
            [-0.02, -0.04, 1.05],
        ]),
        render_fm_warm: raw_core::math::Matrix3([
            [0.71, 0.20, 0.07],
            [0.26, 0.73, 0.00],
            [0.00, -0.06, 1.07],
        ]),
        ..synthetic_frame()
    }
}

/// Write `frame` into the flat `wb_frame_*` params fields. `pub(super)` —
/// reused by the fixture-gated seam tests in the sibling
/// `gpu_live_wb_seam_tests.rs`.
pub(super) fn set_frame(p: &mut MapleGpuLiveParams, frame: &SliderFrameExport) {
    let flat = |m: raw_core::math::Matrix3| crate::scene_linear_f32::flatten_matrix(m);
    p.wb_frame_m_cold = flat(frame.m_cold);
    p.wb_frame_cct_cold = frame.cct_cold;
    p.wb_frame_m_warm = flat(frame.m_warm);
    p.wb_frame_cct_warm = frame.cct_warm;
    p.wb_frame_scene_cct = frame.scene_cct;
    p.wb_frame_as_shot_tint = frame.as_shot_tint;
    p.wb_frame_render_cm = flat(frame.render_cm);
    p.wb_frame_render_forward_matrix = flat(frame.render_forward_matrix);
    p.wb_frame_render_scene_white_xyz = frame.render_scene_white_xyz;
    p.wb_frame_render_wb_already_baked = frame.render_wb_already_baked;
    p.wb_frame_render_cm_cold = flat(frame.render_cm_cold);
    p.wb_frame_render_cct_cold = frame.render_cct_cold;
    p.wb_frame_render_cm_warm = flat(frame.render_cm_warm);
    p.wb_frame_render_cct_warm = frame.render_cct_warm;
    p.wb_frame_render_fm_cold = flat(frame.render_fm_cold);
    p.wb_frame_render_fm_warm = flat(frame.render_fm_warm);
}

/// LEGACY EQUIVALENCE: a zero-filled frame tail (what every pre-#1781 host
/// passes) must reproduce the pre-#1781 WB matrix + live-gate values
/// BIT-IDENTICALLY, in both the decoded-anchor delta and the 0/0-sentinel
/// absolute contracts.
#[test]
fn zero_frame_params_reproduce_legacy_wb_matrix() {
    let curve = ProfileCurve::identity();
    let lut = ColorLut::identity(2);
    let model = AdjustmentModel {
        temperature: 4800.0,
        tint: 18.0,
        ..AdjustmentModel::default()
    };
    let arr = owned_arrays(&model, &curve, &lut);

    // (a) Decoded-anchor delta contract.
    let mut p = make_params(&model, WbMethod::Cat16, 2, &arr);
    p.decoded_temperature = 4522.0;
    p.decoded_tint = -43.7;
    let inputs = unsafe { params::inputs_from_params(&p) };
    let legacy = raw_core::stages::white_balance::wb_cat16_matrix(4800.0, 18.0).mul_mat(
        &raw_core::stages::white_balance::wb_cat16_matrix(4522.0, -43.7)
            .inverse()
            .unwrap(),
    );
    assert_eq!(
        inputs.wb_matrix, legacy.0,
        "delta contract must be bit-identical"
    );
    assert_eq!(
        inputs.wb_temperature, 4800.0,
        "gate temp passes through unchanged"
    );
    assert_eq!(inputs.wb_tint, 18.0, "gate tint passes through unchanged");

    // (b) 0/0-sentinel absolute contract.
    let p_abs = make_params(&model, WbMethod::Cat16, 2, &arr);
    let inputs_abs = unsafe { params::inputs_from_params(&p_abs) };
    let legacy_abs = raw_core::stages::white_balance::wb_cat16_matrix(4800.0, 18.0);
    assert_eq!(
        inputs_abs.wb_matrix, legacy_abs.0,
        "absolute contract must be bit-identical"
    );
    assert_eq!(inputs_abs.wb_temperature, 4800.0);
    assert_eq!(inputs_abs.wb_tint, 18.0);
}

/// FRAME MARSHALLING: a present frame + decoded anchor must derive the WB
/// matrix through `SliderFrameExport::rec2020_delta_matrix` (bit-identical
/// to calling it directly) and synthesize delta-consistent gate values —
/// `6500 + (live − decoded)` / `live − decoded` — so the live builder's
/// `wb_is_noop` skips EXACTLY when the delta is identity.
#[test]
fn frame_params_derive_frame_delta_matrix_and_gate() {
    let frame = synthetic_frame();
    let curve = ProfileCurve::identity();
    let lut = ColorLut::identity(2);
    let model = AdjustmentModel {
        temperature: 6282.0,
        tint: -44.0,
        ..AdjustmentModel::default()
    };
    let arr = owned_arrays(&model, &curve, &lut);
    let mut p = make_params(&model, WbMethod::Cat16, 2, &arr);
    p.decoded_temperature = 6500.0;
    p.decoded_tint = 0.0;
    set_frame(&mut p, &frame);
    let inputs = unsafe { params::inputs_from_params(&p) };
    let expected = frame.rec2020_delta_matrix((6282.0, -44.0), (6500.0, 0.0));
    assert_eq!(
        inputs.wb_matrix, expected.0,
        "frame delta must be bit-identical"
    );
    assert_eq!(inputs.wb_temperature, 6500.0 + (6282.0 - 6500.0));
    assert_eq!(inputs.wb_tint, -44.0);

    // At live == decoded the matrix is exact identity AND the gate values
    // land inside `wb_is_noop`'s (6500 ± 0.5, ±0.5) band, so the live
    // builder omits the WB pass entirely — for ANY equal pair, not just
    // 6500/0: the untouched editor open anchors at the frame's as-shot
    // pair (#1976), so the far-off-D65 case is the one that matters.
    for pair in [(6500.0f32, 0.0f32), (4522.4, -43.79)] {
        let mut p_id = make_params(&model, WbMethod::Cat16, 2, &arr);
        p_id.temperature = pair.0;
        p_id.tint = pair.1;
        p_id.decoded_temperature = pair.0;
        p_id.decoded_tint = pair.1;
        set_frame(&mut p_id, &frame);
        let inputs_id = unsafe { params::inputs_from_params(&p_id) };
        assert_eq!(inputs_id.wb_matrix, raw_core::math::Matrix3::IDENTITY.0);
        assert_eq!(inputs_id.wb_temperature, 6500.0);
        assert_eq!(inputs_id.wb_tint, 0.0);
    }
}

/// The CPU reference for the WB-only live chain: the SAME shared raw-core
/// frame-delta WB (`apply_delta_rec2020`) + the always-on view tail
/// (identity Auto artifacts collapse it to plain AgX → sRGB encode) +
/// `dither_and_quantize` — the u8 surface `maple_gpu_live_render` must
/// reproduce.
fn cpu_reference_frame_wb(
    input: &[f32],
    w: u32,
    h: u32,
    frame: &SliderFrameExport,
    target: (f32, f32),
    decoded: (f32, f32),
) -> Vec<u8> {
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (i, chunk) in input.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }
    frame.apply_delta_rec2020(&mut img, target, decoded);
    raw_core::view::agx::apply(&mut img, 0.0);
    raw_core::view::encode::rec2020_to_srgb(&mut img);
    raw_core::view::encode::srgb_gamma_encode(&mut img);
    let mut rgb: Vec<f32> = Vec::with_capacity(img.pixels.len() * 3);
    for p in &img.pixels {
        rgb.extend_from_slice(&[p[0], p[1], p[2]]);
    }
    // The live view tail ALWAYS runs the Auto Profile curve + residual-LUT
    // passes; these tests wire the identity artifacts on the GPU side, so
    // the CPU reference applies the same ones (the established
    // `cpu_reference` shape from `gpu_live_tests`).
    raw_core::view::auto_profile::apply::apply_curve(&mut rgb, &ProfileCurve::identity());
    ColorLut::identity(2).apply(&mut rgb);
    let mut rgba = Vec::with_capacity(input.len());
    for px in rgb.chunks_exact(3) {
        rgba.extend_from_slice(&[px[0], px[1], px[2], 1.0]);
    }
    raw_gpu::dither_and_quantize(&rgba, w as usize, h as usize)
}

/// Render `params` through the live FFI over `input`, returning the u8 RGB
/// surface. `pub(super)` — reused by the fixture-gated seam tests in the
/// sibling `gpu_live_wb_seam_tests.rs`.
pub(super) fn gpu_render(input: &[f32], w: u32, h: u32, params: &MapleGpuLiveParams) -> Vec<u8> {
    let mut handle = MapleGpuLiveSession {
        inner: std::ptr::null_mut(),
    };
    let rc = unsafe { maple_gpu_live_open(input.as_ptr(), w, h, &mut handle) };
    assert_eq!(rc, 0, "gpu_live_open rc {rc}");
    let mut out = vec![0u8; (w * h * 3) as usize];
    let rc = unsafe { maple_gpu_live_render(&handle, params, out.as_mut_ptr()) };
    unsafe { maple_gpu_live_close(&mut handle) };
    assert_eq!(rc, 0, "gpu_live_render rc {rc}");
    out
}

/// THE PARITY GATE (#1781, the #1732-style live-vs-CPU gate at NON-default
/// WB): the GPU live chain with a present frame at `frame as-shot + 700 K /
/// −40 tint` (anchored at the 6500/0 decode bake) must match the CPU
/// composition of the same shared frame-delta WB + view tail + dither
/// within ≤ 1 u8 LSB — and at `live == decoded` both paths must agree the
/// same way with WB fully omitted.
///
/// Runs against BOTH `synthetic_frame` (no render-profile detail — the
/// #1904 fixed-C tier) and `synthetic_frame_with_render_profile` (#1967's
/// exact per-CCT `C(target)`/`C(anchor)` tier, via `SliderFrameExport::c_at`
/// — `frame.apply_delta_rec2020` used by the CPU reference calls the
/// SAME production code the GPU delta matrix comes from). This is the
/// ONLY non-fixture-gated (CI-running) coverage of the exact-C tier over
/// REAL Metal hardware — the fixture-gated seam measurements on real
/// bodies live in `gpu_live_wb_seam_tests.rs`.
#[test]
fn gpu_live_frame_wb_matches_cpu_chain_at_non_default_wb() {
    let (w, h) = (8u32, 8u32);
    let input = scene_linear_rgba(w as usize, h as usize);
    let curve = ProfileCurve::identity();
    let lut = ColorLut::identity(2);
    let anchor = (6500.0f32, 0.0f32);

    for (frame_name, frame) in [
        ("fixed-C", synthetic_frame()),
        ("exact-C", synthetic_frame_with_render_profile()),
    ] {
        for (name, target) in [
            (
                "non-default",
                (frame.scene_cct + 700.0, frame.as_shot_tint - 40.0),
            ),
            ("default (live == decoded)", anchor),
        ] {
            // WB-isolated model: zero the stages whose MODEL DEFAULTS are
            // non-noop (sharpen 40 / nr_color 25) so the chain runs exactly
            // WB + the always-on view tail — the stage under test.
            let model = AdjustmentModel {
                temperature: target.0,
                tint: target.1,
                sharpen_amount: 0.0,
                nr_color: 0.0,
                nr_luminance: 0.0,
                auto_exposure: raw_core::types::adjustment::AutoExposureMode::Off,
                ..AdjustmentModel::default()
            };
            let arr = owned_arrays(&model, &curve, &lut);
            let mut p = make_params(&model, WbMethod::Cat16, 2, &arr);
            p.decoded_temperature = anchor.0;
            p.decoded_tint = anchor.1;
            set_frame(&mut p, &frame);

            let gpu = gpu_render(&input, w, h, &p);
            let cpu = cpu_reference_frame_wb(&input, w, h, &frame, target, anchor);

            let max_delta = gpu
                .iter()
                .zip(&cpu)
                .map(|(a, b)| (*a as i16 - *b as i16).unsigned_abs())
                .max()
                .unwrap();
            let mismatches = gpu.iter().zip(&cpu).filter(|(a, b)| a != b).count();
            let frac = mismatches as f64 / gpu.len() as f64;
            eprintln!(
                "[{frame_name}/{name}] frame-WB parity: max byte delta {max_delta}, mismatch fraction {frac:.4}"
            );
            assert!(
                max_delta <= 1,
                "[{frame_name}/{name}] GPU vs CPU frame-WB max byte delta {max_delta} > 1"
            );
            assert!(
                frac <= 0.05,
                "[{frame_name}/{name}] GPU vs CPU frame-WB mismatch fraction {frac:.4} > 0.05"
            );
        }
    }
}
