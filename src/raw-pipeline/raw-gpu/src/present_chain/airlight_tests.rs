//! #3602 — the present parity gate's shared-airlight contract, in its own file
//! (600-LOC budget; `tests.rs` holds the gate itself). Native test builds only.

use super::tests::{
    aggressive_case, byte_diff, cpu_reference_u8, gpu_present_u8, gpu_present_u8_with_airlight,
    MAX_BYTE_DELTA,
};
use crate::full_chain::oracle::{cpu_oracle_pre_dehaze, scene_linear_rgba, shared_airlight};
use crate::GpuContext;

/// #3602 REGRESSION GATE — the shared airlight is load-bearing, not incidental.
///
/// Dehaze measures A from whatever buffer it is handed, and the GPU's pre-dehaze
/// buffer agrees with the CPU oracle's only to the chains' float tolerance
/// (~5e-6 absolute, measured on Metal at this size). On a photograph that is
/// invisible — the dark channel has structure, its top-0.1% cut sits 4–9% below
/// its maximum, and A moves by <2e-7 relative. On THIS fixture the dark channel
/// is flat: saturated primaries every 11 px pin every 15×15 window's min, so
/// after the aggressive chain the whole top of the distribution spans 4.2e-5
/// relative — an order of magnitude BELOW that tolerance. `atmospheric_light`'s
/// exact top-0.1% rank cut then ranks pure float noise; the two sides select
/// different pixels from a ~631-member tied pool containing the fixture's 1-in-11
/// HDR seed at (5.0, 3.0, 1.5), A moves ~6%, and the recovery divide turns that
/// into ~60/255. Which side of that a run landed on came down to the exact GPU,
/// which is what made the Metal CI job flake.
///
/// So: present the same chain twice, once with the shared A and once with an A
/// re-measured from a buffer drifted by `GPU_PRE_DEHAZE_DRIFT`. Deterministic and
/// hardware-independent — the drift is a fixed CPU-side constant, not something a
/// particular GPU has to produce.
#[test]
fn present_gate_shared_airlight_is_load_bearing() {
    /// Max |GPU − CPU| over the pre-dehaze buffer, measured at 300×200 on this
    /// project's reference Mac (Metal): 4.6e-6 for the aggressive case.
    const GPU_PRE_DEHAZE_DRIFT: f32 = 5e-6;

    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (300u32, 200u32);
    let input = scene_linear_rgba(w as usize, h as usize);
    let case = aggressive_case();
    let want = cpu_reference_u8(&input, w, h, &case);

    // 1. The gate as it now stands: ONE airlight, both sides. Within budget.
    let shared = shared_airlight(&input, w, h, &case);
    let (shared_delta, _) = byte_diff(&gpu_present_u8(&ctx, &input, w, h, &case), &want);
    assert!(
        shared_delta <= MAX_BYTE_DELTA,
        "sharing the airlight must keep the present within {MAX_BYTE_DELTA} LSB, got \
         {shared_delta}"
    );

    // 2. What measuring A per side costs. The drifted buffer is numerically the
    //    same image; only the last few ULPs differ.
    let drifted: Vec<f32> = cpu_oracle_pre_dehaze(&input, w, h, &case)
        .iter()
        .enumerate()
        .map(|(i, v)| {
            // Per PIXEL, alternating sign — a uniform shift reorders nothing.
            let d = GPU_PRE_DEHAZE_DRIFT;
            v + if (i / 4) % 2 == 0 { d } else { -d }
        })
        .collect();
    let drifted_airlight = crate::compute_airlight(&drifted, w as usize, h as usize);
    let airlight_shift = (0..3)
        .map(|i| (drifted_airlight[i] - shared[i]).abs())
        .fold(0.0f32, f32::max);
    let (drifted_delta, _) = byte_diff(
        &gpu_present_u8_with_airlight(
            &ctx,
            &input,
            w,
            h,
            &case,
            crate::PresentGeometry::IDENTITY,
            drifted_airlight,
        ),
        &want,
    );
    eprintln!(
        "AIRLIGHT SHARING [#3602, aggressive, {w}x{h}]: shared A = {shared:?} → max byte delta \
         {shared_delta}; A re-measured from a buffer drifted by {GPU_PRE_DEHAZE_DRIFT:e} = \
         {drifted_airlight:?} (shift {airlight_shift:.4}) → max byte delta {drifted_delta}"
    );
    assert!(
        drifted_delta > MAX_BYTE_DELTA,
        "this gate is vacuous unless a per-side airlight actually breaks it: a {GPU_PRE_DEHAZE_DRIFT:e} \
         drift moved A by {airlight_shift:.4} yet the present only moved {drifted_delta} LSB. If the \
         fixture's dark channel gained real structure, drop this test and let both sides measure A."
    );
}
