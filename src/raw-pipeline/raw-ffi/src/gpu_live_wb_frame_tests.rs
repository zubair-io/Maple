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
//! 3. **Fixture-gated live-vs-refine seam measurement** on test_0002: the
//!    GPU live render over the ACTUAL editor decode bake (an As-Shot
//!    develop — the strip XMP omits WB, #1883/#1976), anchored at the
//!    frame's as-shot pair, vs a fresh full develop — at the untouched
//!    open, the authored sidecar WB, and large warm/cool slider drags.

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
        render_cm: raw_core::math::Matrix3([[0.0; 3]; 3]),
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
    p.wb_frame_render_cm = flat(frame.render_cm);
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

/// THE LIVE-vs-REFINE SEAM (fixture-gated, real Metal): test_0002 through
/// the GPU live chain over the ACTUAL editor decode bake, vs a fresh full
/// develop at the same target — the truth.
///
/// The bake models the strip-XMP decode faithfully (#1976): the strip
/// OMITS the WB fields (`omitWhiteBalance`, #1883), so raw-core resolves
/// the develop at the image's As-Shot WB — NOT at an explicit 6500/0.
/// Pre-#1894 those were the same develop (6500/0 was the slider identity
/// encoding); post-#1894 the identity moved to the frame's as-shot pair
/// and the explicit-6500/0 bake model became a ~2000 K-warm fiction on
/// this body. Anchoring the delta at that fiction "cooled" the neutral
/// as-shot buffer into the shipped cyan overcool — and the old version of
/// this test (bake at explicit 6500/0, single target 6282 ≈ anchor) baked
/// the same false assumption into the gate, so it stayed green. The delta
/// anchor here is the frame's as-shot pair, matching
/// `EditSession.wbDeltaAnchor`.
///
/// Cases:
///   * as-shot-open — the untouched editor open. The delta short-circuits
///     to exact identity AND the refine develops at the explicit as-shot
///     slider values, so this also gates the estimator/reconstruction
///     round trip (#1870): a saved untouched sidecar must develop to the
///     same pixels the open showed.
///   * sidecar — this fixture's real authored WB (6282 K / −44).
///   * warm-drag / cool-drag — large slider excursions in both
///     directions, the regime the old single-target gate never exercised.
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
    let anchor = (frame.scene_cct, frame.as_shot_tint);

    // The editor decode bake: WB UNSEEN (the strip XMP omits the fields),
    // AE off + sharpen/NR zeroed — WB is the stage under test; the live
    // chain and the develop run the others with different numerics.
    let model_bake = AdjustmentModel {
        auto_exposure: raw_core::types::adjustment::AutoExposureMode::Off,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        nr_luminance: 0.0,
        ..AdjustmentModel::default()
    };
    let never = CancelToken::never();
    let (w, h, bake_f32) = render_sized(
        &raw,
        &model_bake,
        RenderQuality::Preview,
        512,
        never.clone(),
    )
    .expect("bake develop");

    let curve = ProfileCurve::identity();
    let lut = ColorLut::identity(2);
    let null_auto = |p: &mut MapleGpuLiveParams| {
        p.profile_curve_ptr = std::ptr::null();
        p.profile_curve_len = 0;
        p.residual_lut_size = 0;
        p.residual_lut_ptr = std::ptr::null();
        p.residual_lut_len = 0;
    };

    // Measured landings (2026-07-12, #1976) + ~15% headroom:
    //   as-shot-open 0.045/0.504/1.573 maxCh 1 (dither-level — the fix)
    //   sidecar      0.439/1.001/1.690 maxCh 2 (Δ ≈ 1760 K off anchor)
    //   warm-drag    0.474/0.876/1.461 maxCh 4 (Δ ≈ 3000 K)
    //   cool-drag    0.700/0.992/1.757 maxCh 4 (Δ ≈ 1000 K)
    // The non-open budgets absorb the fixed-C conjugation approximation
    // (`frame_to_rec2020` cannot carry the render profile's FM endpoints
    // — #1967 shrinks them); the as-shot-open case must be dither-level.
    let cases: [(&str, (f32, f32), (f32, f32, f32)); 4] = [
        ("as-shot-open", anchor, (0.06, 0.6, 1.8)),
        ("sidecar", (6282.0, -44.0), (0.55, 1.2, 2.0)),
        ("warm-drag", (7500.0, 20.0), (0.55, 1.05, 1.7)),
        ("cool-drag", (3500.0, -20.0), (0.85, 1.2, 2.1)),
    ];

    for (name, target, (b_mean, b_p95, b_max)) in cases {
        // Truth: a fresh full develop at the explicit target + view tail.
        let model_target = AdjustmentModel {
            temperature: target.0,
            tint: target.1,
            temperature_seen: true,
            tint_seen: true,
            ..model_bake.clone()
        };
        let (tw, th, refine_f32) = render_sized(
            &raw,
            &model_target,
            RenderQuality::Preview,
            512,
            never.clone(),
        )
        .expect("refine develop");
        assert_eq!((w, h), (tw, th));
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

        // Live: the GPU chain over the as-shot bake, anchored at the
        // frame's as-shot pair (`wbDeltaAnchor`).
        let arr = owned_arrays(&model_target, &curve, &lut);
        let mut p = make_params(&model_target, WbMethod::Cat16, 2, &arr);
        p.decoded_temperature = anchor.0;
        p.decoded_tint = anchor.1;
        null_auto(&mut p);
        set_frame(&mut p, &frame);
        let live = gpu_render(&bake_f32, w, h, &p);

        let (mean, p95, max) = de00_stats(&live, &refine_u8);
        let ch = max_channel_delta(&live, &refine_u8);
        eprintln!(
            "test_0002 live-vs-refine seam [{name}] @ ({:.1}, {:.1}): \
             mean/p95/max dE00 = {mean:.3}/{p95:.3}/{max:.3} maxCh {ch}",
            target.0, target.1
        );
        assert!(
            mean < b_mean,
            "[{name}] live-vs-refine mean dE00 {mean:.3} exceeds budget {b_mean}"
        );
        assert!(
            p95 < b_p95,
            "[{name}] live-vs-refine p95 dE00 {p95:.3} exceeds budget {b_p95}"
        );
        assert!(
            max < b_max,
            "[{name}] live-vs-refine max dE00 {max:.3} exceeds budget {b_max}"
        );
        if name == "as-shot-open" {
            // The untouched open is delta-identity + gate-skip: the ONLY
            // residual is the explicit-vs-unseen as-shot develop round
            // trip (#1870) landing under dither — never more than 1 u8
            // step on any channel.
            assert!(
                ch <= 1,
                "[{name}] untouched open must be dither-level (maxCh {ch} > 1)"
            );
        }
    }
}

/// THE TILE-BAKE PARITY GATE (fixture-gated; #1976 follow-on): the
/// native-detail tile render with NO decoded-WB anchor must reproduce the
/// whole-image strip develop (an As-Shot bake) — the invariant that makes
/// the 100% native-detail overlay agree with the fit view, since both then
/// feed the SAME per-tick chain with the SAME `wbDeltaAnchor`.
///
/// Also documents WHY the anchor must be absent: the stripped handle model
/// carries the (6500, 0) parse DEFAULTS (WB omitted, #1883), so an anchored
/// tile computes `wb(6500-default)/wb(anchor)` in camera space — identity
/// only when the anchor is 6500/0 (the pre-#1976 accidental cancellation),
/// and a visible warm cast for any truthful anchor (measured on-device as
/// the pink 100% view).
#[test]
#[cfg_attr(
    not(feature = "fixtures"),
    ignore = "needs test-fixtures/raws (fixtures feature)"
)]
fn native_detail_tile_bake_matches_whole_image_strip_develop() {
    use raw_core::pipeline::render_scene_linear_sized_from_raw_with_quality_f32_cancellable as render_sized;
    use raw_core::pipeline::render_scene_linear_tile_from_raw_with_quality_and_wb_anchor_f32 as render_tile;
    use raw_core::pipeline::{RenderQuality, TileRect};
    use raw_core::CancelToken;

    let path = raw_core::test_support::fixtures::require_raw("test_0002.dng");
    let bytes = std::fs::read(&path).expect("read test_0002.dng");
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("decode test_0002");

    // The stripped handle model: WB omitted (unseen, parse defaults). AE
    // explicitly off — the tile path omits AE by design (#1167, a uniform
    // luminance factor, not color), so turning it off in the whole develop
    // isolates the COLOR parity this gate is about.
    let model_strip = AdjustmentModel {
        auto_exposure: raw_core::types::adjustment::AutoExposureMode::Off,
        ..AdjustmentModel::default()
    };

    // Whole-image strip develop at native resolution (long edge = sensor).
    let never = CancelToken::never();
    let native_long = raw.width.max(raw.height);
    let (ww, _wh, whole) =
        render_sized(&raw, &model_strip, RenderQuality::Full, native_long, never)
            .expect("whole-image strip develop");

    // A background rect well inside the frame (top-left quadrant is the
    // white studio backdrop on this fixture).
    let rect = TileRect {
        src_x: 256,
        src_y: 256,
        src_w: 512,
        src_h: 512,
        out_w: 512,
        out_h: 512,
    };

    let mean_rgb = |buf: &[f32], w: u32, x0: u32, y0: u32, n: u32| -> [f64; 3] {
        let mut acc = [0.0f64; 3];
        for yy in y0..y0 + n {
            for xx in x0..x0 + n {
                let i = ((yy * w + xx) * 4) as usize;
                acc[0] += buf[i] as f64;
                acc[1] += buf[i + 1] as f64;
                acc[2] += buf[i + 2] as f64;
            }
        }
        let cnt = (n * n) as f64;
        [acc[0] / cnt, acc[1] / cnt, acc[2] / cnt]
    };

    // Fixed fix: NO anchor — must match the whole develop.
    let (tw, th, tile_none) = render_tile(&raw, &model_strip, rect, RenderQuality::Full, None)
        .expect("tile render (no anchor)");
    assert_eq!((tw, th), (512, 512));
    // Pre-#1976 shape: a truthful as-shot anchor — documents the warm cast.
    let (_, _, tile_anchored) = render_tile(
        &raw,
        &model_strip,
        rect,
        RenderQuality::Full,
        Some((4522.4, -43.79)),
    )
    .expect("tile render (anchored)");

    let whole_mean = mean_rgb(&whole, ww, rect.src_x + 64, rect.src_y + 64, 384);
    let none_mean = mean_rgb(&tile_none, 512, 64, 64, 384);
    let anch_mean = mean_rgb(&tile_anchored, 512, 64, 64, 384);
    let ratio = |a: [f64; 3], b: [f64; 3]| [a[0] / b[0], a[1] / b[1], a[2] / b[2]];
    let r_none = ratio(none_mean, whole_mean);
    let r_anch = ratio(anch_mean, whole_mean);
    eprintln!(
        "TILEBAKE whole={whole_mean:.5?} tile(none)={none_mean:.5?} ratio={r_none:.4?} | \
         tile(anchored 4522)={anch_mean:.5?} ratio={r_anch:.4?}"
    );
    for (c, r) in r_none.iter().enumerate() {
        assert!(
            (r - 1.0).abs() < 0.005,
            "no-anchor tile channel {c} diverges from the whole-image strip develop: ratio {r:.4}"
        );
    }
    // The anchored tile's R/B ratio vs the develop demonstrates the warm
    // cast the anchor injects (R up, B down) — the regression this test
    // pins. If this ever reads ~1.0 the anchor semantics changed and the
    // NativeDetail contract should be revisited.
    assert!(
        r_anch[0] > 1.01 && r_anch[2] < 0.99,
        "expected the truthful-anchor tile to show the documented warm cast; got {r_anch:.4?}"
    );
}
