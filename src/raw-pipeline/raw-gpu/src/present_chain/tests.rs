//! Chain-output PRESENT parity gate (epic #925, P4b-apple / #1028). The
//! offscreen present (`present_chain_to_offscreen` — the same fullscreen-triangle
//! dither/quantize FS the `CAMetalLayer` path runs, rendered to a `Bgra8Unorm`
//! texture and read back) matches the CPU reference `develop`+`render`+
//! `dither_and_quantize` within ≤ 1 LSB.
//!
//! ## Why this is the autonomous A1 number (and the surface path is device-checkpointed)
//!
//! The present pixel math (quantize + Bayer dither, layered on the gated chain)
//! is fully exercisable on the macOS host WITHOUT a `CAMetalLayer`: render the FS
//! to an owned offscreen texture, read it back, diff vs the CPU oracle. That is
//! the parity number P4b-apple owes. The real `CAMetalLayer` surface present
//! (`present_chain_to_surface`) runs the IDENTICAL pipeline pointed at a drawable
//! instead of the offscreen target, so its color correctness is covered here; only
//! the surface plumbing + the layer's sRGB colorspace tag are the device checkpoint.
//!
//! ## The ≤ 1 LSB tolerance (not byte-exact)
//!
//! Unlike `live_session/tests.rs`'s byte-EXACT gate (which compares the GPU
//! present path against a GPU reference — same `c`), this compares the GPU present
//! against the CPU `cpu_oracle`. The chain f32 output agrees CPU↔GPU only within
//! the epic's `1e-4`, so a pixel sitting on a quantize boundary
//! (`c*255 + off + 0.5` straddling an integer) can round to adjacent bytes on the
//! two sides. That is a ±1 LSB boundary flip, exactly the tolerance the dehaze
//! interior gate already sanctions — NOT a present-shader bug. `max_delta` is the
//! signal; the mismatch fraction is kept loose (boundary pixels scale with count).

use super::*;
use crate::dither::dither_and_quantize;
use crate::full_chain::oracle::{
    cpu_oracle, nonidentity_curve, nonidentity_lut, scene_linear_rgba, Case,
};
use crate::{CancelToken, GpuContext, LiveSession};

use raw_core::types::adjustment::AutoExposureMode;
use raw_core::types::{ToneCurve, ToneCurveMode, WbMethod};
use raw_core::xmp::AdjustmentModel;

/// ≤ 1 LSB: the only divergence permitted is a quantize-boundary flip from the
/// CPU↔GPU chain f32 delta (bounded `< 1e-4` by C1). A larger delta is a real
/// present-shader bug (wrong index recovery, wrong Bayer cell, double OETF).
const MAX_BYTE_DELTA: u32 = 1;
/// A loose mismatch-fraction ceiling: boundary pixels scale with the image, so a
/// few percent differing by exactly 1 LSB is expected; only `max_delta` is the
/// hard signal (mirrors the dehaze interior gate's `< 0.05`).
const MAX_MISMATCH_FRACTION: f32 = 0.05;

/// All-no-op model (every gateable slider zeroed) — the chain is the view tail
/// only. Mirrors `live_session/tests.rs::noop_model`.
fn noop_model() -> AdjustmentModel {
    AdjustmentModel {
        sharpen_amount: 0.0,
        nr_color: 0.0,
        auto_exposure: AutoExposureMode::Off,
        ..AdjustmentModel::default()
    }
}

fn neutral_case() -> Case {
    Case {
        model: noop_model(),
        capture: None,
        curve: nonidentity_curve(),
        lut: nonidentity_lut(9),
        wb_method: WbMethod::Cat16,
    }
}

/// A mild case (several stages just past threshold) + a non-identity curve/LUT.
/// Dehaze stays OFF here so the no-dehaze single-submit present path is exercised.
fn mild_case() -> Case {
    let model = AdjustmentModel {
        temperature: 6000.0,
        tint: 3.0,
        exposure: 0.1,
        contrast: 8.0,
        highlights: -5.0,
        shadows: 5.0,
        vibrance: 6.0,
        saturation: 5.0,
        sharpen_amount: 50.0,
        sharpen_radius: 1.0,
        sharpen_detail: 25.0,
        nr_color: 15.0,
        auto_exposure: AutoExposureMode::Off,
        ..AdjustmentModel::default()
    };
    Case {
        model,
        capture: None,
        curve: nonidentity_curve(),
        lut: nonidentity_lut(9),
        wb_method: WbMethod::Cat16,
    }
}

/// An aggressive case: every gated stage engaged, incl. a luma point curve AND
/// dehaze (so the present's dehaze-split chain-to-f32 path is exercised end to end).
fn aggressive_case() -> Case {
    let model = AdjustmentModel {
        temperature: 4800.0,
        tint: 18.0,
        exposure: 0.4,
        contrast: 35.0,
        highlights: -40.0,
        shadows: 30.0,
        whites: 20.0,
        blacks: -15.0,
        parametric_shadows: 20.0,
        parametric_lights: 15.0,
        tone_curve_luma: ToneCurve::new(vec![(0.0, 0.0), (0.25, 0.18), (0.75, 0.82), (1.0, 1.0)]),
        tone_curve_mode: ToneCurveMode::RatioPreserving,
        vibrance: 35.0,
        saturation: 25.0,
        clarity: 40.0,
        texture: 30.0,
        dehaze: 45.0,
        sharpen_amount: 80.0,
        sharpen_radius: 1.5,
        sharpen_detail: 30.0,
        sharpen_masking: 20.0,
        nr_luminance: 30.0,
        nr_color: 40.0,
        auto_exposure: AutoExposureMode::Off,
        ..AdjustmentModel::default()
    };
    Case {
        model,
        capture: None,
        curve: nonidentity_curve(),
        lut: nonidentity_lut(9),
        wb_method: WbMethod::Cat16,
    }
}

/// The CPU reference u8 surface: the chain f32 reference (`cpu_oracle`) put
/// through the SAME `dither_and_quantize` the present FS replicates, yielding the
/// flat `3·w·h` RGB bytes. This is what the on-screen present must match.
fn cpu_reference_u8(input: &[f32], w: u32, h: u32, case: &Case) -> Vec<u8> {
    let f32_out = cpu_oracle(input, w, h, case);
    dither_and_quantize(&f32_out, w as usize, h as usize)
}

/// Run the GPU present path to its offscreen u8 surface: upload the scene-linear
/// fixture into a `LiveSession`, run the gated chain to its final f32 buffer, then
/// present (dither/quantize FS → `Bgra8Unorm` → readback → RGB).
///
/// Uses the CPU-READBACK airlight session (`new_with_airlight_readback`): this is
/// a PRESENT-shader gate vs the CPU `develop`+`render` oracle, so it must share
/// the oracle's `compute_airlight`. The fixture here is `scene_linear_rgba`, whose
/// dark channel is FLAT (saturated primaries every 11 px → every window's min is
/// 0.1) — so "top 0.1%" is an all-tied selection where the on-GPU histogram
/// (whole-image average) and the CPU sort legitimately diverge (~20 LSB after
/// dehaze=45), NEITHER being "the airlight". That degeneracy is a property of this
/// synthetic image, not the present path; the on-GPU airlight's end-to-end dehaze
/// parity is gated on a HAZY fixture in `live_session/tests.rs`. (#1033)
fn gpu_present_u8(
    ctx: &GpuContext,
    input: &[f32],
    w: u32,
    h: u32,
    inputs: &crate::FullChainInputs,
) -> Vec<u8> {
    let session = LiveSession::new_with_airlight_readback(ctx, input, w, h).expect("session");
    let cancel = CancelToken::new();
    let final_idx = session
        .render_chain_to_f32(ctx, inputs, &cancel)
        .expect("chain-to-f32 ok")
        .expect("uncancelled chain-to-f32 returns Some");
    present_chain_to_offscreen(ctx, &session, final_idx).expect("offscreen present ok")
}

/// Compare two equal-length u8 RGB buffers; return `(max_byte_delta, mismatch_fraction)`.
fn byte_diff(got: &[u8], want: &[u8]) -> (u32, f32) {
    assert_eq!(
        got.len(),
        want.len(),
        "present vs reference length mismatch"
    );
    let max_delta = got
        .iter()
        .zip(want)
        .map(|(a, b)| (*a as i32 - *b as i32).unsigned_abs())
        .max()
        .unwrap_or(0);
    let mismatches = got.iter().zip(want).filter(|(a, b)| a != b).count();
    (max_delta, mismatches as f32 / want.len().max(1) as f32)
}

/// THE A1 PRESENT GATE: the offscreen chain-output present matches the CPU
/// `render`+`dither_and_quantize` reference within ≤ 1 LSB, across a neutral
/// (view-tail-only, single-submit) / mild (several stages, single-submit) /
/// aggressive (every stage + dehaze → the mid-chain airlight-readback split)
/// adjustment set at a REALISTIC 64×64 size (so the Bayer 8×8 tile repeats, the
/// dehaze top-0.1% average is a real reduction, and the spatial kernels run their
/// interiors — an 8×8 would degenerate them).
#[test]
fn offscreen_present_matches_cpu_render_within_1_lsb() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (64u32, 64u32);
    let input = scene_linear_rgba(w as usize, h as usize);

    for (name, case) in [
        ("neutral", neutral_case()),
        ("mild", mild_case()),
        ("aggressive", aggressive_case()),
    ] {
        let inputs = case.gpu_inputs();
        let got = gpu_present_u8(&ctx, &input, w, h, &inputs);
        let want = cpu_reference_u8(&input, w, h, &case);

        let (max_delta, frac) = byte_diff(&got, &want);
        eprintln!(
            "PRESENT PARITY [A1, {name}, {w}x{h}]: max byte delta = {max_delta}, \
             {:.2}% of bytes differ",
            frac * 100.0
        );

        assert!(
            max_delta <= MAX_BYTE_DELTA,
            "[{name}] offscreen present vs CPU render max byte delta {max_delta} > {MAX_BYTE_DELTA} \
             — beyond a quantize-boundary flip (a present-shader bug: index recovery, Bayer cell, \
             or a double OETF on a non-sRGB surface)"
        );
        assert!(
            frac < MAX_MISMATCH_FRACTION,
            "[{name}] {:.2}% of bytes differ — too many for ≤1 LSB boundary noise (a real divergence)",
            frac * 100.0
        );
    }
}

/// NON-VACUOUS: the present must actually paint the IMAGE, not the clear colour.
/// The render pass clears to mid-grey (0.5) before drawing the fullscreen
/// triangle; if the triangle/bind-group/sample failed, every pixel would read
/// back ~127/127/127. An aggressive case produces a wide spread of values, so the
/// presented surface must NOT be a flat grey field — its byte range must be wide.
#[test]
fn present_paints_the_image_not_the_clear_color() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (64u32, 64u32);
    let input = scene_linear_rgba(w as usize, h as usize);
    let inputs = aggressive_case().gpu_inputs();

    let got = gpu_present_u8(&ctx, &input, w, h, &inputs);
    let min = *got.iter().min().unwrap();
    let max = *got.iter().max().unwrap();
    // The clear colour is a single grey ~127; a real image spans a wide range.
    // Require the spread to comfortably exceed any plausible all-grey clear.
    eprintln!(
        "PRESENT NON-VACUOUS: byte range [{min}, {max}] (spread {})",
        max - min
    );
    assert!(
        max - min > 80,
        "presented surface byte range [{min},{max}] is too narrow — the FS likely failed to \
         sample the chain buffer and the readback is the mid-grey clear colour"
    );
}

/// GH #1737-adjacent regression (the "half-render seam" report): a present at a
/// width whose `Bgra8Unorm` row-bytes are NOT 256-byte-aligned — the exact class
/// of width the operator's cold-open canvas used (3000 px; `3000*4 = 12000`,
/// `12000 / 256 = 46.875`, not a whole `COPY_BYTES_PER_ROW_ALIGNMENT` multiple).
/// `present_chain_to_offscreen` unpads each row from the padded readback buffer
/// itself (`present_chain.rs`'s `copy_texture_to_buffer` requires the 256-aligned
/// `padded_bpr`), so THIS test is the direct proof that unpadding is correct for
/// every row, not just a size that happens to divide evenly. Uses 300×200 (same
/// 3:2 aspect as the operator's 3000×2000 viewport, scaled down for test speed);
/// its row-bytes (`300*4 = 1200`) are likewise misaligned (`1200/256 = 4.6875`).
///
/// Asserts EVERY ROW independently against the CPU oracle (not just a global max
/// delta) — a misaligned-stride bug would corrupt PROGRESSIVELY from a fixed row
/// onward (each subsequent row reads from the wrong offset by an accumulating
/// pad), producing a clean-top / wrong-bottom split; a per-row check catches that
/// shape precisely, where a whole-buffer `byte_diff` could still pass if the
/// corruption happened to average out.
#[test]
fn offscreen_present_row_alignment_misaligned_width() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (300u32, 200u32);
    assert_ne!(
        (w * 4) % wgpu::COPY_BYTES_PER_ROW_ALIGNMENT,
        0,
        "test fixture must use a 256-byte-misaligned row stride"
    );
    let input = scene_linear_rgba(w as usize, h as usize);

    for (name, case) in [
        ("neutral", neutral_case()),
        ("mild", mild_case()),
        ("aggressive", aggressive_case()),
    ] {
        let inputs = case.gpu_inputs();
        let got = gpu_present_u8(&ctx, &input, w, h, &inputs);
        let want = cpu_reference_u8(&input, w, h, &case);
        assert_eq!(got.len(), want.len(), "[{name}] length mismatch");

        // NOTE: the GPU-side Bgra8Unorm texture rows are w*4 bytes (that
        // misalignment is what this test exercises), but gpu_present_u8 /
        // cpu_reference_u8 both return PACKED RGB — 3 bytes per pixel —
        // so buffer indexing here strides at w*3, covering every byte.
        let row_bytes = w as usize * 3;
        let mut first_bad_row: Option<usize> = None;
        let mut worst_row_delta = 0u32;
        for y in 0..h as usize {
            let g_row = &got[y * row_bytes..(y + 1) * row_bytes];
            let w_row = &want[y * row_bytes..(y + 1) * row_bytes];
            let (row_max_delta, _) = byte_diff(g_row, w_row);
            worst_row_delta = worst_row_delta.max(row_max_delta);
            if row_max_delta > MAX_BYTE_DELTA && first_bad_row.is_none() {
                first_bad_row = Some(y);
            }
        }
        eprintln!(
            "ROW-ALIGNMENT [{name}, {w}x{h}]: worst per-row max byte delta = {worst_row_delta}, \
             first bad row = {first_bad_row:?}"
        );
        assert!(
            first_bad_row.is_none(),
            "[{name}] row {} onward diverges from the CPU oracle by more than {MAX_BYTE_DELTA} LSB \
             at a 256-byte-misaligned width ({w}px, row-bytes {}) — a row-stride/padding bug in the \
             texture→buffer readback, matching the reported clean-top/corrupted-bottom seam",
            first_bad_row.unwrap_or(0),
            w * 4
        );
    }
}

/// A pre-cancelled token abandons the chain-to-f32 render before encoding
/// (returns `None`) — the present path's cancellation contract, mirroring
/// `render_to_buffer`. (The host's per-render cancel flag flips this when a newer
/// edit supersedes the in-flight present.)
#[test]
fn pre_cancelled_chain_to_f32_returns_none() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (16u32, 16u32);
    let input = scene_linear_rgba(w as usize, h as usize);
    let inputs = aggressive_case().gpu_inputs();

    let session = LiveSession::new(&ctx, &input, w, h).expect("session");
    let cancel = CancelToken::new();
    cancel.cancel(); // pre-cancelled
    let out = session
        .render_chain_to_f32(&ctx, &inputs, &cancel)
        .expect("chain-to-f32 ok");
    assert!(out.is_none(), "pre-cancelled chain-to-f32 must return None");
}
