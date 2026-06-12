//! Dehaze / on-GPU-airlight host parity for the LIVE-session FFI (#1098), split
//! from `gpu_live_tests.rs` (the 600-LOC file budget — the same split raw-gpu
//! makes with `live_session/airlight_tests.rs`, for the same subject).
//!
//! `maple_gpu_live_open` always builds the DEFAULT `LiveSession::new`, whose
//! dehaze airlight A is the on-GPU histogram reduction (#1033) — close to, but
//! deliberately NOT bit-exact vs, raw-core's CPU sort (tolerance documented in
//! `raw-gpu/src/airlight/tests.rs`). On `gpu_live_tests.rs`'s
//! `scene_linear_rgba` fixture the dark channel is DEGENERATE (a saturated
//! primary every 11 px puts the same min in every 15×15 window), so "top 0.1%"
//! is an all-tied selection where the two methods legitimately diverge and
//! NEITHER value is "the airlight" — the failure mode of #1098 (machine-
//! dependent 1-LSB dither flips over ~18% of bytes at dehaze 10; ~20 LSB at
//! dehaze 45 per `present_chain/tests.rs`). `raw-gpu` keeps airlight-sensitive
//! comparisons off that fixture, and `present_chain/tests.rs` pins its GPU side
//! to the CPU-readback session instead — the FFI can't, the C ABI exposes only
//! the default session. So dehaze is host-gated HERE, on the 128×128 HAZY
//! fixture (distinct dark-channel values, a genuine `top_n = 16` average), with
//! the airlight-aware budget of
//! `live_session/airlight_tests.rs::on_gpu_dehaze_matches_cpu_reference_on_hazy_fixture`.

use super::gpu_live_tests::{
    cpu_reference, direct_raw_gpu, make_params, nonidentity_curve, nonidentity_lut, owned_arrays,
};
use super::*;
use raw_core::types::WbMethod;
use raw_core::xmp::AdjustmentModel;

/// A DEHAZE-ONLY model: dehaze engaged, every other gateable stage off (incl.
/// the non-zero `sharpen_amount` / `nr_color` defaults). Mirrors `raw-gpu`'s
/// `live_session/airlight_tests.rs::dehaze_only_case`, so any host-parity delta
/// here is unambiguously the on-GPU-vs-CPU airlight difference — not a
/// confounded spatial stage.
fn dehaze_model() -> AdjustmentModel {
    AdjustmentModel {
        dehaze: 45.0,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        auto_exposure: raw_core::types::adjustment::AutoExposureMode::Off,
        ..AdjustmentModel::default()
    }
}

/// The 128×128 hazy fixture with DISTINCT dark-channel values, so the top-0.1%
/// airlight selection (`top_n = 16`) is a genuine average with an unambiguous
/// cut — the fixture every airlight-sensitive gate in `raw-gpu` uses. A local
/// copy of `hazy_image` (test-private to `raw-gpu`'s `dehaze` / `airlight` /
/// `live_session` test modules): a hazy diagonal-gradient base, a darker
/// low-transmission block, border features, and a small bright specular patch.
fn hazy_image(w: usize, h: usize) -> Vec<f32> {
    let mut v = vec![0.0f32; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let gx = x as f32 / (w - 1) as f32;
            let gy = y as f32 / (h - 1) as f32;
            let mut luma = 0.45 + 0.20 * (gx + gy) * 0.5;
            if (24..56).contains(&x) && (72..104).contains(&y) {
                luma *= 0.35;
            }
            if x < 3 || y < 3 {
                luma += 0.15;
            }
            if x >= w - 4 && y >= h - 4 {
                luma *= 0.4;
            }
            let i = (y * w + x) * 4;
            v[i] = (luma * 1.04).min(1.0);
            v[i + 1] = (luma * 0.98).min(1.0);
            v[i + 2] = (luma * 0.90).min(1.0);
            v[i + 3] = 1.0;
        }
    }
    for y in 8..20 {
        for x in (w - 20)..(w - 8) {
            let i = (y * w + x) * 4;
            v[i] = 0.97;
            v[i + 1] = 0.965;
            v[i + 2] = 0.96;
        }
    }
    v
}

/// THE DEHAZE HOST-PARITY GATE (#1098): the FFI live-render entry, dehaze
/// engaged on the DEFAULT on-GPU-airlight session, vs the CPU pipeline, on the
/// hazy fixture. Budgets are the airlight-aware ones, derived from the sibling
/// raw-gpu gates rather than re-measured here:
///
///   * `max_delta ≤ 2`: the on-GPU A matches the CPU sort within the documented
///     `airlight/tests.rs` tolerance (5e-3; ~1.3e-3 measured on this fixture),
///     which propagates through recovery + view tail + dither to ≤ 2 LSB —
///     `live_session/airlight_tests.rs` measured 1 and budgets 2 for the same
///     comparison shape.
///   * `frac < 0.10`: the A delta flips its own share of quantize-boundary
///     bytes ON TOP of the C1 `< 1e-4` chain noise; each source is individually
///     sanctioned a 5% mismatch ceiling by the sibling gates, so this stacked
///     gate gets their sum. `max_delta` is the hard signal, as everywhere.
#[test]
fn gpu_live_dehaze_matches_cpu_on_hazy_fixture() {
    let (w, h) = (128u32, 128u32);
    let input = hazy_image(w as usize, h as usize);
    let lut_size = 9usize;
    let curve = nonidentity_curve();
    let lut = nonidentity_lut(lut_size);
    let wb_method = WbMethod::Cat16;
    let model = dehaze_model();

    let arr = owned_arrays(&model, &curve, &lut);
    let params = make_params(&model, wb_method, lut_size, &arr);

    // Open → render → close, exactly as the host drives it.
    let mut handle = MapleGpuLiveSession {
        inner: std::ptr::null_mut(),
    };
    let rc = unsafe { maple_gpu_live_open(input.as_ptr(), w, h, &mut handle) };
    assert_eq!(rc, 0, "[dehaze] gpu_live_open rc {rc}");
    let mut out = vec![0u8; (w * h * 3) as usize];
    let rc = unsafe { maple_gpu_live_render(&handle, &params, out.as_mut_ptr()) };
    assert_eq!(rc, 0, "[dehaze] gpu_live_render rc {rc}");
    unsafe { maple_gpu_live_close(&mut handle) };

    // (1) MARSHALING gate (byte-exact), as in `gpu_live_tests.rs` — and still
    //     byte-exact with dehaze engaged: the on-GPU airlight reduction is
    //     deterministic (atomic u32 histogram + a single-workgroup threshold
    //     scan and tree reduction), so two sessions at the same inputs agree.
    let direct = direct_raw_gpu(&input, w, h, &model, wb_method, &curve, &lut);
    let marshal_mismatches = out.iter().zip(&direct).filter(|(a, b)| a != b).count();
    assert_eq!(
        marshal_mismatches, 0,
        "[dehaze] FFI output differs from a direct raw_gpu::LiveSession render in \
         {marshal_mismatches} bytes — the C-ABI marshaling diverges"
    );

    // (2) HOST-PARITY gate (vs the CPU pipeline), airlight-aware budgets — see
    //     the test doc above for the derivation.
    let want = cpu_reference(&input, w, h, &model, wb_method, &curve, &lut);
    assert_eq!(out.len(), want.len(), "[dehaze] length mismatch");
    let max_delta = out
        .iter()
        .zip(&want)
        .map(|(a, b)| (*a as i32 - *b as i32).unsigned_abs())
        .max()
        .unwrap_or(0);
    let mismatches = out.iter().zip(&want).filter(|(a, b)| a != b).count();
    let frac = mismatches as f32 / want.len() as f32;
    eprintln!(
        "FFI LIVE PARITY [dehaze, hazy 128×128]: vs-direct = {marshal_mismatches} bytes; vs-CPU \
         max byte delta = {max_delta} (cap 2), {mismatches} / {} bytes differ ({:.1}% vs cap 10%)",
        want.len(),
        frac * 100.0
    );
    assert!(
        max_delta <= 2,
        "[dehaze] FFI vs CPU max byte delta {max_delta} > 2 — beyond the documented on-GPU \
         airlight tolerance propagated through recovery + dither (a real divergence)"
    );
    assert!(
        frac < 0.10,
        "[dehaze] {:.1}% of bytes differ from CPU — too many for the stacked airlight + \
         quantize-boundary budget (a real divergence)",
        frac * 100.0
    );
}
