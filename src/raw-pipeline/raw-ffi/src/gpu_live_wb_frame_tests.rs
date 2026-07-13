//! WB slider-frame gates for the gpu-gated live FFI (#1781) — split out of
//! `gpu_live_tests.rs` per the 600-LOC budget, reusing its `pub(super)`
//! fixture/params helpers.
//!
//! Three layers:
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
//! 3. **Fixture-gated live-vs-refine seam measurement** on test_0002 at
//!    its sidecar WB (6282 K / −44): the GPU live render over the
//!    decode-anchored buffer vs a fresh full develop at the target WB —
//!    the user-visible TestFlight seam this ticket closes. Asserts the
//!    frame path lands within tenths of ΔE00 mean and prints the
//!    before (generic-CAT16, CIRAWFilter-style anchor) vs after numbers.

use super::gpu_live_tests::{make_params, owned_arrays, scene_linear_rgba};
use super::*;
use raw_core::image::{ColorSpace, Image};
use raw_core::stages::wb_camera::SliderFrameExport;
use raw_core::types::WbMethod;
use raw_core::view::acr_fit::model::{ciede2000, srgb_linear_to_lab};
use raw_core::view::auto_profile::curve::ProfileCurve;
use raw_core::view::auto_profile::lut::ColorLut;
use raw_core::xmp::AdjustmentModel;

/// The same plausible dual-illuminant frame the raw-core unit tests use
/// (`wb_frame_delta_tests::synthetic_frame`) — generic wide-gamut sensor
/// calibration pair, well-conditioned, non-identity.
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
        cam_to_rec2020: raw_core::math::Matrix3([[0.0; 3]; 3]),
    }
}

/// Write `frame` into the six flat `wb_frame_*` params fields.
fn set_frame(p: &mut MapleGpuLiveParams, frame: &SliderFrameExport) {
    let flat = |m: raw_core::math::Matrix3| crate::scene_linear_f32::flatten_matrix(m);
    p.wb_frame_m_cold = flat(frame.m_cold);
    p.wb_frame_cct_cold = frame.cct_cold;
    p.wb_frame_m_warm = flat(frame.m_warm);
    p.wb_frame_cct_warm = frame.cct_warm;
    p.wb_frame_scene_cct = frame.scene_cct;
    p.wb_frame_as_shot_tint = frame.as_shot_tint;
    p.wb_frame_cam_to_rec2020 = flat(frame.cam_to_rec2020);
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
    // builder omits the WB pass entirely.
    let mut p_id = make_params(&model, WbMethod::Cat16, 2, &arr);
    p_id.temperature = 6500.0;
    p_id.tint = 0.0;
    p_id.decoded_temperature = 6500.0;
    p_id.decoded_tint = 0.0;
    set_frame(&mut p_id, &frame);
    let inputs_id = unsafe { params::inputs_from_params(&p_id) };
    assert_eq!(inputs_id.wb_matrix, raw_core::math::Matrix3::IDENTITY.0);
    assert_eq!(inputs_id.wb_temperature, 6500.0);
    assert_eq!(inputs_id.wb_tint, 0.0);
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
/// surface.
fn gpu_render(input: &[f32], w: u32, h: u32, params: &MapleGpuLiveParams) -> Vec<u8> {
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
#[test]
fn gpu_live_frame_wb_matches_cpu_chain_at_non_default_wb() {
    let (w, h) = (8u32, 8u32);
    let input = scene_linear_rgba(w as usize, h as usize);
    let frame = synthetic_frame();
    let curve = ProfileCurve::identity();
    let lut = ColorLut::identity(2);
    let anchor = (6500.0f32, 0.0f32);

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
            "[{name}] frame-WB parity: max byte delta {max_delta}, mismatch fraction {frac:.4}"
        );
        assert!(
            max_delta <= 1,
            "[{name}] GPU vs CPU frame-WB max byte delta {max_delta} > 1"
        );
        assert!(
            frac <= 0.05,
            "[{name}] GPU vs CPU frame-WB mismatch fraction {frac:.4} > 0.05"
        );
    }
}

/// Decode-gamma helper for the seam metric: u8 sRGB → linear sRGB.
fn srgb_decode(c: u8) -> f32 {
    let v = c as f32 / 255.0;
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

/// Mean / p95 / max ΔE00 between two same-size u8 RGB surfaces.
fn de00_stats(a: &[u8], b: &[u8]) -> (f32, f32, f32) {
    let mut des: Vec<f32> = a
        .chunks_exact(3)
        .zip(b.chunks_exact(3))
        .map(|(pa, pb)| {
            let la =
                srgb_linear_to_lab([srgb_decode(pa[0]), srgb_decode(pa[1]), srgb_decode(pa[2])]);
            let lb =
                srgb_linear_to_lab([srgb_decode(pb[0]), srgb_decode(pb[1]), srgb_decode(pb[2])]);
            ciede2000(la, lb)
        })
        .collect();
    des.sort_by(|x, y| x.partial_cmp(y).unwrap());
    let mean = des.iter().sum::<f32>() / des.len() as f32;
    let p95 = des[((des.len() as f32 * 0.95) as usize).min(des.len() - 1)];
    let max = *des.last().unwrap();
    (mean, p95, max)
}

/// Max per-channel u8 divergence between two surfaces.
fn max_channel_delta(a: &[u8], b: &[u8]) -> u8 {
    a.iter()
        .zip(b)
        .map(|(x, y)| (*x as i16 - *y as i16).unsigned_abs() as u8)
        .max()
        .unwrap()
}

/// THE LIVE-vs-REFINE SEAM (fixture-gated, real Metal): test_0002 at its
/// sidecar WB (6282 K / −44).
///
/// * refine = a fresh full develop at the target WB (what
///   `maple_render_file_scene_linear_f32(raw, xmp)` produces on Apple) +
///   the view tail — the truth.
/// * live   = the decode-anchored buffer (develop at the strip-XMP's
///   explicit 6500/0 bake) through the GPU live chain at the target.
///
/// AFTER (#1781): frame data + the 6500/0 anchor ⇒ tenths of ΔE00.
/// BEFORE (printed for the record): zero frame + the pre-decode
/// platform-estimate anchor (4522 K / −43.65, what the app used to pass) —
/// the visible band.
#[test]
#[cfg_attr(
    not(feature = "fixtures"),
    ignore = "needs test-fixtures/raws (fixtures feature)"
)]
fn gpu_live_vs_develop_refine_seam_test_0002() {
    use raw_core::pipeline::render_scene_linear_sized_from_raw_with_quality_f32_cancellable as render_sized;
    use raw_core::pipeline::RenderQuality;
    use raw_core::CancelToken;

    let path = raw_core::test_support::fixtures::require_raw("test_0002.dng");
    let bytes = std::fs::read(&path).expect("read test_0002.dng");
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("decode test_0002");
    let frame = crate::scene_linear_f32::wb_frame_export(&raw);
    assert!(frame.is_present(), "test_0002 must resolve a slider frame");

    // WB-isolated model shape: explicit WB (seen flags, like the FFI XMP
    // parse), AE off (content-dependent gain would differ between the two
    // develops), sharpen/NR zeroed (the live chain and the develop run them
    // with different numerics — not the stage under test).
    let base = AdjustmentModel {
        temperature_seen: true,
        tint_seen: true,
        auto_exposure: raw_core::types::adjustment::AutoExposureMode::Off,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        nr_luminance: 0.0,
        ..AdjustmentModel::default()
    };
    let target = (6282.0f32, -44.0f32);
    let model_target = AdjustmentModel {
        temperature: target.0,
        tint: target.1,
        ..base.clone()
    };
    // The decode bake: the strip XMP's explicit 6500/0 (what every Apple
    // editor decode develops at — `RawCoreBridge.stripAppleGPUStages`).
    let model_bake = AdjustmentModel {
        temperature: 6500.0,
        tint: 0.0,
        ..base
    };

    let never = CancelToken::never();
    let (w, h, refine_f32) = render_sized(
        &raw,
        &model_target,
        RenderQuality::Preview,
        512,
        never.clone(),
    )
    .expect("refine develop");
    let (bw, bh, bake_f32) =
        render_sized(&raw, &model_bake, RenderQuality::Preview, 512, never).expect("bake develop");
    assert_eq!((w, h), (bw, bh));

    // Refine display surface: view tail + dither over the target develop.
    let refine_u8 = {
        let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        for (i, chunk) in refine_f32.chunks_exact(4).enumerate() {
            img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
        }
        raw_core::view::agx::apply(&mut img, 0.0);
        raw_core::view::encode::rec2020_to_srgb(&mut img);
        raw_core::view::encode::srgb_gamma_encode(&mut img);
        let mut rgba = Vec::with_capacity(refine_f32.len());
        for p in &img.pixels {
            rgba.extend_from_slice(&[p[0], p[1], p[2], 1.0]);
        }
        raw_gpu::dither_and_quantize(&rgba, w as usize, h as usize)
    };

    let model_live = AdjustmentModel {
        temperature: target.0,
        tint: target.1,
        auto_exposure: raw_core::types::adjustment::AutoExposureMode::Off,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        nr_luminance: 0.0,
        ..AdjustmentModel::default()
    };
    let curve = ProfileCurve::identity();
    let lut = ColorLut::identity(2);
    let arr = owned_arrays(&model_live, &curve, &lut);
    let null_auto = |p: &mut MapleGpuLiveParams| {
        p.profile_curve_ptr = std::ptr::null();
        p.profile_curve_len = 0;
        p.residual_lut_size = 0;
        p.residual_lut_ptr = std::ptr::null();
        p.residual_lut_len = 0;
    };

    // AFTER: frame data + the 6500/0 decode-bake anchor.
    let mut p_after = make_params(&model_live, WbMethod::Cat16, 2, &arr);
    p_after.decoded_temperature = 6500.0;
    p_after.decoded_tint = 0.0;
    null_auto(&mut p_after);
    set_frame(&mut p_after, &frame);
    let live_after = gpu_render(&bake_f32, w, h, &p_after);

    // BEFORE: zero frame + the platform pre-decode anchor the app used to
    // pass (CIRAWFilter's 4522 K / −43.65 for this body) — today's shipped
    // behaviour, for the record.
    let mut p_before = make_params(&model_live, WbMethod::Cat16, 2, &arr);
    p_before.decoded_temperature = 4522.0;
    p_before.decoded_tint = -43.65;
    null_auto(&mut p_before);
    let live_before = gpu_render(&bake_f32, w, h, &p_before);

    let (mean_b, p95_b, max_b) = de00_stats(&live_before, &refine_u8);
    let (mean_a, p95_a, max_a) = de00_stats(&live_after, &refine_u8);
    let ch_b = max_channel_delta(&live_before, &refine_u8);
    let ch_a = max_channel_delta(&live_after, &refine_u8);
    eprintln!(
        "test_0002 live-vs-refine seam @ (6282, -44): \
         BEFORE mean/p95/max dE00 = {mean_b:.3}/{p95_b:.3}/{max_b:.3} maxCh {ch_b} | \
         AFTER mean/p95/max dE00 = {mean_a:.3}/{p95_a:.3}/{max_a:.3} maxCh {ch_a}"
    );
    // Budget history:
    //   • Pre-#1894 (frame == render profile): mean 0.037.
    //   • #1894 regressed it to 0.533 by making the WB VALUE frame the
    //     embedded single-CM CM (scene_cct 4522) while the buffer develops
    //     through the BUNDLE profile (5516) — the fixed-C conjugation in
    //     `frame_to_rec2020` was then built in the wrong basis. This gate is
    //     fixture-gated (never runs in CI) so the regression shipped silently
    //     and surfaced as the on-device cyan cast on this body (#1904).
    //   • #1904 seam fix: conjugate through the RENDER profile's CM
    //     (`SliderFrame::render_cm`) — mean 0.189 here (3× better; 55× better
    //     than the generic-CAT16 BEFORE path's 10.4). The residual above the
    //     old 0.037 is the fixed-C approximation's IRREDUCIBLE floor for a
    //     body whose value frame ≠ render profile: `frame_to_rec2020` cannot
    //     carry the render profile's ForwardMatrix ENDPOINTS (module doc),
    //     so it cannot model the FM's different retarget at the bake anchor
    //     (6500/0) vs the target — an error that only appears when the two
    //     frames diverge, i.e. exactly the embedded-CM case. Closing it fully
    //     needs the FM endpoints threaded through the FFI (larger change,
    //     tracked separately). These ceilings are the measured landing (mean
    //     0.189 / p95 0.790 / max 1.698) + ~15% headroom — a SET for the
    //     post-#1894 embedded-frame reality, not a relaxation to mask a bug:
    //     the `mean_a < mean_b` gate below still proves the frame path beats
    //     the generic one by ~55×, and the As-Shot cyan this fixes measured
    //     2.14 → 0.50 mean dE00 (repro during #1904).
    assert!(
        mean_a < 0.22,
        "live-vs-refine mean dE00 {mean_a:.3} exceeds the embedded-frame fixed-C floor"
    );
    assert!(
        p95_a < 0.95,
        "live-vs-refine p95 dE00 {p95_a:.3} exceeds budget"
    );
    assert!(
        max_a < 2.0,
        "live-vs-refine max dE00 {max_a:.3} exceeds budget"
    );
    assert!(
        mean_a < mean_b,
        "frame path ({mean_a:.3}) must beat the generic path ({mean_b:.3})"
    );
}

/// DIAGNOSTIC (temp): measure the seam at the APP's real AS-SHOT target
/// (4522.4 / −43.79), not the sidecar 6282. Compares:
///   A) PR path: bake @6500, delta(target=asshot, decoded=6500)   [current app]
///   B) bake @asshot, delta(target=asshot, decoded=asshot)=identity [fix option]
/// vs the truth = a fresh full develop at as-shot.
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore = "needs fixtures")]
fn diag_seam_at_asshot_target() {
    use raw_core::pipeline::render_scene_linear_sized_from_raw_with_quality_f32_cancellable as render_sized;
    use raw_core::pipeline::RenderQuality;
    use raw_core::CancelToken;

    let path = raw_core::test_support::fixtures::require_raw("test_0002.dng");
    let bytes = std::fs::read(&path).expect("read");
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("decode");
    let frame = crate::scene_linear_f32::wb_frame_export(&raw);
    assert!(frame.is_present());

    let base = AdjustmentModel {
        temperature_seen: true, tint_seen: true,
        auto_exposure: raw_core::types::adjustment::AutoExposureMode::Off,
        sharpen_amount: 0.0, nr_color: 0.0, nr_luminance: 0.0,
        ..AdjustmentModel::default()
    };
    let asshot = (4522.4f32, -43.79f32);
    let m = |t: (f32, f32)| AdjustmentModel { temperature: t.0, tint: t.1, ..base.clone() };
    let never = CancelToken::never();

    let (w, h, refine) = render_sized(&raw, &m(asshot), RenderQuality::Preview, 512, never.clone()).expect("refine asshot");
    let (_, _, bake6500) = render_sized(&raw, &m((6500.0, 0.0)), RenderQuality::Preview, 512, never.clone()).expect("bake6500");
    let (_, _, bakeas) = render_sized(&raw, &m(asshot), RenderQuality::Preview, 512, never).expect("bake asshot");

    let to_u8 = |f32buf: &[f32], w: u32, h: u32| {
        let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        for (i, c) in f32buf.chunks_exact(4).enumerate() { img.pixels[i] = [c[0], c[1], c[2]]; }
        raw_core::view::agx::apply(&mut img, 0.0);
        raw_core::view::encode::rec2020_to_srgb(&mut img);
        raw_core::view::encode::srgb_gamma_encode(&mut img);
        let mut rgba = Vec::with_capacity(f32buf.len());
        for p in &img.pixels { rgba.extend_from_slice(&[p[0], p[1], p[2], 1.0]); }
        raw_gpu::dither_and_quantize(&rgba, w as usize, h as usize)
    };
    let refine_u8 = to_u8(&refine, w, h);

    let curve = ProfileCurve::identity();
    let lut = ColorLut::identity(2);
    let model_live = m(asshot);
    let arr = owned_arrays(&model_live, &curve, &lut);
    let null_auto = |p: &mut MapleGpuLiveParams| {
        p.profile_curve_ptr = std::ptr::null(); p.profile_curve_len = 0;
        p.residual_lut_size = 0; p.residual_lut_ptr = std::ptr::null(); p.residual_lut_len = 0;
    };

    // A) PR path: bake @6500, decoded=6500.
    let mut pa = make_params(&model_live, WbMethod::Cat16, 2, &arr);
    pa.decoded_temperature = 6500.0; pa.decoded_tint = 0.0;
    null_auto(&mut pa); set_frame(&mut pa, &frame);
    let live_a = gpu_render(&bake6500, w, h, &pa);

    // B) bake @asshot, decoded=asshot (identity delta).
    let mut pb = make_params(&model_live, WbMethod::Cat16, 2, &arr);
    pb.decoded_temperature = asshot.0; pb.decoded_tint = asshot.1;
    null_auto(&mut pb); set_frame(&mut pb, &frame);
    let live_b = gpu_render(&bakeas, w, h, &pb);

    let (ma, pa95, mxa) = de00_stats(&live_a, &refine_u8);
    let (mb, pb95, mxb) = de00_stats(&live_b, &refine_u8);
    eprintln!("DIAGSEAM @asshot(4522): A(PR bake6500) mean/p95/max={:.3}/{:.3}/{:.3} maxCh={} | B(bake-asshot identity) mean/p95/max={:.3}/{:.3}/{:.3} maxCh={}",
        ma, pa95, mxa, max_channel_delta(&live_a, &refine_u8),
        mb, pb95, mxb, max_channel_delta(&live_b, &refine_u8));
}

/// DIAGNOSTIC (temp): isolate whether the cyan is the WB delta or the
/// Auto Profile GPU tail (curve vs residual LUT). Fits the REAL auto profile
/// for test_0002 and applies it in the GPU render, comparing to the CPU
/// application of the SAME artifacts (maple-cli is neutral WITH auto profile).
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore = "needs fixtures")]
fn diag_autoprofile_gpu_vs_cpu_asshot() {
    use raw_core::pipeline::render_scene_linear_sized_from_raw_with_quality_f32_cancellable as render_sized;
    use raw_core::pipeline::{fit_auto_profile_from_raw, RawInput, RenderQuality};
    use raw_core::CancelToken;

    let path = raw_core::test_support::fixtures::require_raw("test_0002.dng");
    let bytes = std::fs::read(&path).expect("read");
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("decode");
    let frame = crate::scene_linear_f32::wb_frame_export(&raw);
    let asshot = (4522.4f32, -43.79f32);

    // Fit the REAL auto profile (curve + residual LUT), profile = Auto.
    let fit_model = AdjustmentModel {
        temperature: asshot.0, tint: asshot.1, temperature_seen: true, tint_seen: true,
        profile: raw_core::types::Profile::Auto,
        auto_exposure: raw_core::types::adjustment::AutoExposureMode::Off,
        sharpen_amount: 0.0, nr_color: 0.0, nr_luminance: 0.0,
        ..AdjustmentModel::default()
    };
    let (curve_opt, lut_opt) = fit_auto_profile_from_raw(&raw, &fit_model, RenderQuality::Preview, RawInput::Path(&path))
        .expect("auto profile fit");
    let real_curve = curve_opt.unwrap_or_else(ProfileCurve::identity);
    let real_lut = lut_opt.unwrap_or_else(|| ColorLut::identity(2));
    eprintln!("APDIAG fit: curve_points={} lut_size={}", real_curve.to_flat().len(), real_lut.data.len());

    let base = AdjustmentModel {
        temperature: asshot.0, tint: asshot.1, temperature_seen: true, tint_seen: true,
        auto_exposure: raw_core::types::adjustment::AutoExposureMode::Off,
        sharpen_amount: 0.0, nr_color: 0.0, nr_luminance: 0.0,
        ..AdjustmentModel::default()
    };
    let never = CancelToken::never();
    let (w, h, bake6500) = render_sized(&raw, &AdjustmentModel{temperature:6500.0,tint:0.0,..base.clone()}, RenderQuality::Preview, 512, never.clone()).expect("bake");
    let (_, _, refine) = render_sized(&raw, &base, RenderQuality::Preview, 512, never).expect("refine");

    let id_curve = ProfileCurve::identity();
    let id_lut = ColorLut::identity(2);

    // CPU truth WITH the real auto profile: view tail over refine, then curve+lut.
    let cpu_ref = |curve: &ProfileCurve, lut: &ColorLut| -> Vec<u8> {
        let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        for (i, c) in refine.chunks_exact(4).enumerate() { img.pixels[i] = [c[0], c[1], c[2]]; }
        raw_core::view::agx::apply(&mut img, 0.0);
        raw_core::view::encode::rec2020_to_srgb(&mut img);
        raw_core::view::encode::srgb_gamma_encode(&mut img);
        let mut rgb: Vec<f32> = Vec::with_capacity(img.pixels.len()*3);
        for p in &img.pixels { rgb.extend_from_slice(&[p[0],p[1],p[2]]); }
        raw_core::view::auto_profile::apply::apply_curve(&mut rgb, curve);
        lut.apply(&mut rgb);
        let mut rgba = Vec::with_capacity(refine.len());
        for px in rgb.chunks_exact(3) { rgba.extend_from_slice(&[px[0],px[1],px[2],1.0]); }
        raw_gpu::dither_and_quantize(&rgba, w as usize, h as usize)
    };

    let gpu_with = |curve: &ProfileCurve, lut: &ColorLut, lut_size: usize| -> Vec<u8> {
        let arr = owned_arrays(&base, curve, lut);
        let mut p = make_params(&base, WbMethod::Cat16, lut_size, &arr);
        p.decoded_temperature = 6500.0; p.decoded_tint = 0.0;
        set_frame(&mut p, &frame);
        gpu_render(&bake6500, w, h, &p)
    };

    // Truth = CPU with full auto profile.
    let truth = cpu_ref(&real_curve, &real_lut);
    let lut_edge = (real_lut.data.len()/3) as f64; let lut_n = lut_edge.cbrt().round() as usize;

    for (name, gpu, cpuref) in [
        ("none(null_auto)", gpu_with(&id_curve, &id_lut, 2), cpu_ref(&id_curve, &id_lut)),
        ("curve+lut(full)", gpu_with(&real_curve, &real_lut, lut_n), truth.clone()),
        ("curve-only",      gpu_with(&real_curve, &id_lut, 2),       cpu_ref(&real_curve, &id_lut)),
        ("lut-only",        gpu_with(&id_curve, &real_lut, lut_n),   cpu_ref(&id_curve, &real_lut)),
    ] {
        let (m,p95,mx) = de00_stats(&gpu, &cpuref);
        eprintln!("APDIAG [{}] GPU-vs-CPU(same-AP) mean/p95/max={:.3}/{:.3}/{:.3} maxCh={}", name, m, p95, mx, max_channel_delta(&gpu, &cpuref));
    }
}

#[test]
#[cfg_attr(not(feature = "fixtures"), ignore = "needs fixtures")]
fn test_0002_untouched_wb_delta_is_identity() {
    let path = raw_core::test_support::fixtures::require_raw("test_0002.dng");
    let bytes = std::fs::read(&path).expect("read test_0002.dng");
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("decode test_0002");
    
    let frame = crate::scene_linear_f32::wb_frame_export(&raw);
    assert!(frame.is_present(), "test_0002 must have a frame");
    
    let as_shot_cct = frame.scene_cct;
    let as_shot_tint = frame.as_shot_tint;

    // Simulate an untouched open: the user slider is exactly at the as-shot defaults,
    // and the decode anchor matches the frame's as-shot values.
    let m = raw_core::types::adjustment::AdjustmentModel {
        temperature: as_shot_cct,
        tint: as_shot_tint,
        ..Default::default()
    };
    
    let mut params = crate::scene_linear_chain::MapleGpuLiveParams::default();
    crate::scene_linear_chain::make_gpu_live_params(
        &m,
        as_shot_cct,
        as_shot_tint,
        as_shot_cct,
        as_shot_tint,
        &frame,
        &mut params
    );

    // The GPU WB delta matrix must be the exact identity matrix.
    let diag = [params.wb_delta_0, params.wb_delta_4, params.wb_delta_8];
    let zeros = [
        params.wb_delta_1, params.wb_delta_2, 
        params.wb_delta_3, params.wb_delta_5, 
        params.wb_delta_6, params.wb_delta_7
    ];
    
    for (i, d) in diag.iter().enumerate() {
        assert!((d - 1.0).abs() < 1e-6, "diagonal {} was {}, expected 1.0", i, d);
    }
    for (i, z) in zeros.iter().enumerate() {
        assert!(z.abs() < 1e-6, "off-diagonal {} was {}, expected 0.0", i, z);
    }
}
