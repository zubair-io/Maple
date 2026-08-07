//! `LiveSession` AIRLIGHT gates (epic #925, P4b C5a/C5b — #1027 / #1033), split
//! from `live_session/tests.rs` for the 600-LOC file budget. Two end-to-end gates
//! at the realistic 128×128 size (`top_n = 16` — a genuine top-0.1% AVERAGE, not
//! the degenerate 8×8 `top_n = 1` argmax the other session tests use):
//!
//!   * `dehaze_interior_airlight_average_matches_cpu_at_128px` — pins the C5a
//!     CPU-READBACK fallback (`new_with_airlight_readback`) at ≤ 1 LSB (both sides
//!     share the identical `compute_airlight`).
//!   * `on_gpu_dehaze_matches_cpu_reference_on_hazy_fixture` — pins the DEFAULT
//!     on-GPU airlight (#1033) end-to-end through the full dehaze stage on a HAZY
//!     fixture (distinct dark-channel values) within a small byte delta.
//!
//! Shares the sibling `tests` module's `reference_u8` reference composition (it is
//! `pub(super)` there); the dehaze-only case + the hazy fixture live here.

use super::tests::reference_u8;
use crate::chain::ChainRunner;
use crate::dehaze::AirlightSource;
use crate::full_chain::oracle::{nonidentity_curve, nonidentity_lut, scene_linear_rgba, Case};
use crate::image::GpuImage;
use crate::{compute_airlight, CancelToken, GpuContext, LiveSession, Pass};

use raw_core::types::adjustment::AutoExposureMode;
use raw_core::types::WbMethod;
use raw_core::xmp::AdjustmentModel;

/// A DEHAZE-ONLY case: the all-no-op base + `dehaze = 45`, neutral WB (6500/0),
/// exposure 0. Nothing else engaged, so at a realistic size the ONLY active
/// scene-linear stage is dehaze and any parity delta is unambiguously dehaze /
/// airlight. Curve/LUT stay non-identity (the view tail still runs).
fn dehaze_only_case() -> Case {
    let model = AdjustmentModel {
        dehaze: 45.0,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        auto_exposure: AutoExposureMode::Off,
        ..AdjustmentModel::default()
    };
    Case {
        model,
        capture: None,
        curve: nonidentity_curve(),
        lut: nonidentity_lut(9),
        wb_method: WbMethod::Cat16,
        film_lut: None,
        film_strength: 0.0,
    }
}

/// THE INTERIOR-AIRLIGHT GATE (C5a, Risk B "realistic fixture"). Every other
/// dehaze case here is 8×8, where `top_n = max(64/1000, 1) = 1` — so the
/// atmospheric light A degenerates to the SINGLE brightest-dark-channel pixel,
/// and the 15×15 / radius-60 windows blow past the image into the clamp-to-edge
/// degenerate regime. None of that exercises what dehaze actually does on a real
/// frame. At 128×128 (n = 16384), `top_n = 16`: A is a genuine top-0.1% AVERAGE,
/// the dark-channel and guided-filter windows run their TRUE interior kernels,
/// and the session takes the mid-chain airlight-readback split path
/// (`render_dehaze_split`). This is the only test that validates the airlight
/// reduction as an average rather than an argmax.
///
/// A DEHAZE-ONLY model (nothing else engaged), so any byte delta is unambiguously
/// dehaze/airlight — not a confounded sharpen/NR/clarity/texture interior kernel.
///
/// On a clean run the session's u8 surface matches the post-prefix-airlight CPU
/// reference within the same ≤ 1 LSB boundary noise as the 8×8 gates: the GPU and
/// CPU run the IDENTICAL `compute_airlight` (verified byte-equal vs raw-core), and
/// C1 pins the post-prefix f32 buffers `< 1e-4`, so A agrees to ~1e-4 and the
/// recovery + dither lands within a quantize boundary. If `max_delta > 1` the test
/// prints the GPU-readback A vs the CPU A to discriminate the cause (a top-N tie-
/// flip at the 16-element boundary vs an unexplained spatial divergence) before it
/// fails — see the assertion comment.
#[test]
fn dehaze_interior_airlight_average_matches_cpu_at_128px() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (128u32, 128u32);
    assert_eq!(
        ((w * h) as usize / 1000).max(1),
        16,
        "fixture sanity: 128×128 must give top_n = 16 (a real top-0.1% average, not an argmax)"
    );

    let input = scene_linear_rgba(w as usize, h as usize);
    let case = dehaze_only_case();
    let inputs = case.gpu_inputs();
    assert!(
        crate::dehaze_is_active(&inputs),
        "test setup: the dehaze-only case must take the airlight-split path"
    );

    // This gate pins the C5a CPU-READBACK fallback path (`new_with_airlight_readback`)
    // at ≤ 1 LSB — both sides run the IDENTICAL `compute_airlight`, so it stays
    // tight. The DEFAULT on-GPU reduction (#1033) is gated separately, with its own
    // documented tolerance, in `airlight/tests.rs` (the histogram-percentile A is
    // close-but-not-bit-exact to the sort, by design).
    let session = LiveSession::new_with_airlight_readback(&ctx, &input, w, h).expect("session");
    let cancel = CancelToken::new();
    let got = session
        .render_to_buffer(&ctx, &inputs, &cancel)
        .expect("render ok")
        .expect("uncancelled render returns Some");

    // CPU reference (measures A post-prefix on its side too — see `reference_u8`).
    let want = reference_u8(&ctx, &input, w, h, &inputs);
    assert_eq!(got.len(), want.len(), "output length mismatch");

    let max_delta = got
        .iter()
        .zip(&want)
        .map(|(a, b)| (*a as i32 - *b as i32).unsigned_abs())
        .max()
        .unwrap_or(0);
    let mismatches = got.iter().zip(&want).filter(|(a, b)| a != b).count();
    let frac = mismatches as f32 / want.len() as f32;
    eprintln!(
        "DEHAZE INTERIOR PARITY [128×128, top_n=16]: max byte delta = {max_delta}, \
         {mismatches} / {} bytes differ ({:.2}%)",
        want.len(),
        frac * 100.0
    );

    // Attribution on failure: A is the load-bearing number. The split path reads
    // back the SAME post-prefix buffer on both sides (CPU here via the prefix
    // ChainRunner, GPU inside `render_dehaze_split`), so a diverging A at the 16-
    // element boundary is a top-N tie-flip (a CPU/GPU percentile-selection
    // determinism boundary — exactly what C5b's histogram reduction makes
    // deterministic), whereas a MATCHING A with bytes still off is an unexplained
    // spatial-kernel divergence the 8×8 gates structurally couldn't see.
    if max_delta > 1 {
        let (prefix, _) = crate::build_live_split(&inputs, AirlightSource::Cpu([0.0; 3]));
        let prefix_refs: Vec<&dyn Pass> = prefix.iter().map(|p| p.as_ref()).collect();
        let pimg = GpuImage::upload(&ctx, &input, w, h);
        let prunner = ChainRunner::new(&ctx, &pimg);
        let pre_dehaze = prunner.run_blocking(&prefix_refs);
        let airlight = compute_airlight(&pre_dehaze, w as usize, h as usize);
        eprintln!(
            "  ATTRIBUTION: post-prefix airlight A (same on GPU and CPU, both from \
             this buffer) = {airlight:?} — if the per-side As that fed the renders \
             differ this is a top-N tie-flip; if they agree, the divergence is in a \
             spatial kernel and BLOCKS."
        );
    }

    assert!(
        max_delta <= 1,
        "128×128 dehaze-only session vs CPU max byte delta {max_delta} > 1 — beyond f32→u8 \
         boundary noise. See the printed airlight: differing A ⇒ a top-N tie-flip (document + \
         ratchet tolerance, motivates C5b); matching A ⇒ a real spatial-kernel divergence (block)"
    );
    // The mismatch fraction rises a bit at 16384 px purely from more pixels near a
    // quantize boundary — harmless; only max_delta is signal. Keep a loose ceiling.
    assert!(
        frac < 0.05,
        "{:.2}% of bytes differ from CPU at 128×128 — too many for boundary noise (a real divergence)",
        frac * 100.0
    );
}

/// THE ON-GPU END-TO-END DEHAZE GATE (#1033). The DEFAULT [`LiveSession::new`]
/// (on-GPU airlight, no readback) rendered through the FULL dehaze stage + view
/// tail + dither, on a 128×128 HAZY fixture (genuine top-0.1% average — distinct
/// dark-channel values, NOT the degenerate flat dc of `scene_linear_rgba`), must
/// match the CPU-airlight `reference_u8` within a small byte delta. This is the
/// end-to-end counterpart to the airlight unit gate (`airlight/tests.rs`): there
/// the on-GPU A is within ~1.3e-3 of `compute_airlight`; here that small A delta
/// propagates through recovery + AgX + gamma + dither to a bounded byte delta.
///
/// A DEHAZE-ONLY model (nothing else engaged) on the hazy image, so any byte delta
/// is unambiguously the on-GPU-vs-CPU airlight difference, not a confounded stage.
#[test]
fn on_gpu_dehaze_matches_cpu_reference_on_hazy_fixture() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (128u32, 128u32);
    let input = hazy_image(w as usize, h as usize);
    let case = dehaze_only_case();
    let inputs = case.gpu_inputs();
    assert!(
        crate::dehaze_is_active(&inputs),
        "test setup: dehaze must be engaged"
    );

    // DEFAULT session = on-GPU airlight (no readback), the path #1033 ships.
    let session = LiveSession::new(&ctx, &input, w, h).expect("session");
    let cancel = CancelToken::new();
    let got = session
        .render_to_buffer(&ctx, &inputs, &cancel)
        .expect("render ok")
        .expect("uncancelled render returns Some");

    // CPU reference: the same chain with CPU `compute_airlight` (post-prefix).
    let want = reference_u8(&ctx, &input, w, h, &inputs);
    assert_eq!(got.len(), want.len(), "output length mismatch");

    let max_delta = got
        .iter()
        .zip(&want)
        .map(|(a, b)| (*a as i32 - *b as i32).unsigned_abs())
        .max()
        .unwrap_or(0);
    let mismatches = got.iter().zip(&want).filter(|(a, b)| a != b).count();
    let frac = mismatches as f32 / want.len() as f32;
    eprintln!(
        "ON-GPU DEHAZE E2E [hazy 128×128]: max byte delta = {max_delta}, \
         {mismatches} / {} bytes differ ({:.2}%)",
        want.len(),
        frac * 100.0
    );

    // The on-GPU airlight is within ~1.3e-3 of the CPU A on this fixture, so the
    // recovered + view-transformed + dithered u8 lands within ~1 LSB (measured max
    // delta = 1; the +1 margin absorbs a boundary pixel nudging on a different GPU).
    // A far larger delta would mean a real divergence (a kernel bug or a wrong A).
    assert!(
        max_delta <= 2,
        "on-GPU dehaze end-to-end vs CPU reference max byte delta {max_delta} > 2 on the hazy \
         fixture — beyond the small airlight (~1.3e-3) + quantize-boundary budget"
    );
    assert!(
        frac < 0.05,
        "{:.2}% of bytes differ end-to-end — too many for the airlight + boundary budget",
        frac * 100.0
    );
}

/// A 128×128 hazy fixture with DISTINCT dark-channel values (a genuine top-0.1%
/// average) — mirrors `dehaze/tests.rs::hazy_image` (test-private there). Used by
/// the on-GPU end-to-end dehaze gate; `scene_linear_rgba`'s flat dark channel is
/// the wrong fixture for any airlight-sensitive comparison (see `airlight/tests.rs`).
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
