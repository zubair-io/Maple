//! `LiveSession` correctness gate (epic #925, P4b-core / #1027), STEP 1: the
//! session's `render_to_buffer` output is BIT-IDENTICAL to running the gated
//! `build_live_chain` through a plain `ChainRunner` + the C2 `encode_dither`
//! directly. This ties C3 back to C1 (the gated chain) and C2 (the dither
//! terminal): the session is just those pieces wired into one encoder with a
//! single readback, so a pixel move can only be the session's plumbing —
//! isolated before the pool layers on top.
//!
//! Drives the SHARED `crate::full_chain::oracle` harness (same `Case` + fixture
//! as the C1 gate) across a neutral, a mild, and an aggressive adjustment set, so
//! the session is exercised with the chain both near-empty (view tail only) and
//! fully loaded (every gated stage active + dehaze).

use super::*;
use crate::chain::ChainRunner;
use crate::dehaze::AirlightSource;
use crate::dither::encode_dither;
use crate::full_chain::oracle::{nonidentity_curve, nonidentity_lut, scene_linear_rgba, Case};
use crate::image::GpuImage;
use crate::live_chain::build_live_chain;
use crate::{compute_airlight, CancelToken, GpuContext, Pass};

use raw_core::types::adjustment::AutoExposureMode;
use raw_core::types::{ToneCurve, ToneCurveMode, WbMethod};
use raw_core::xmp::AdjustmentModel;

/// Reference path: the "direct" composition the session must match bit-for-bit —
/// the gated `build_live_chain` through a plain `ChainRunner` to the final f32
/// buffer, then the C2 `encode_dither` standalone → the `3·w·h` u8 RGB surface.
///
/// AIRLIGHT (C5a): when dehaze is engaged the session measures A from the
/// POST-PREFIX buffer (not the input), so the reference does too — run the
/// `build_live_split` prefix through a ChainRunner, `compute_airlight` on that
/// read-back buffer, then build the full chain with the SAME A. When dehaze is
/// off, A is unused.
pub(super) fn reference_u8(
    ctx: &GpuContext,
    input: &[f32],
    w: u32,
    h: u32,
    inputs: &crate::FullChainInputs,
) -> Vec<u8> {
    let airlight = if crate::dehaze_is_active(inputs) {
        // Run the pre-dehaze prefix, read it back, measure A from it — exactly the
        // buffer dehaze sees, matching the session.
        let (prefix, _) = crate::build_live_split(inputs, AirlightSource::Cpu([0.0; 3]));
        let prefix_refs: Vec<&dyn Pass> = prefix.iter().map(|p| p.as_ref()).collect();
        let pimg = GpuImage::upload(ctx, input, w, h);
        let prunner = ChainRunner::new(ctx, &pimg);
        let pre_dehaze = prunner.run_blocking(&prefix_refs);
        compute_airlight(&pre_dehaze, w as usize, h as usize)
    } else {
        [0.0; 3]
    };
    let passes = build_live_chain(inputs, AirlightSource::Cpu(airlight));
    let pass_refs: Vec<&dyn Pass> = passes.iter().map(|p| p.as_ref()).collect();

    // Chain → final f32 (one readback).
    let img = GpuImage::upload(ctx, input, w, h);
    let runner = ChainRunner::new(ctx, &img);
    let f32_out = runner.run_blocking(&pass_refs);

    // Dither the f32 result standalone (re-upload + a fresh encoder).
    let f32_img = GpuImage::upload(ctx, &f32_out, w, h);
    let dst = crate::dither::alloc_packed_rgb(ctx, w, h, "ref-dither-dst");
    let mut encoder = ctx
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("ref-dither-encoder"),
        });
    encode_dither(ctx, &mut encoder, &f32_img.buffer, &dst, (w, h));
    let packed_byte_len = (w as u64) * (h as u64) * std::mem::size_of::<u32>() as u64;
    let readback = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("ref-dither-readback"),
        size: packed_byte_len,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    encoder.copy_buffer_to_buffer(&dst, 0, &readback, 0, packed_byte_len);
    ctx.queue.submit(Some(encoder.finish()));

    let slice = readback.slice(..);
    let (tx, rx) = futures_channel::oneshot::channel();
    slice.map_async(wgpu::MapMode::Read, move |res| {
        let _ = tx.send(res);
    });
    ctx.device.poll(wgpu::Maintain::Wait);
    pollster::block_on(rx).unwrap().unwrap();
    let data = slice.get_mapped_range();
    let packed: Vec<u32> = bytemuck::cast_slice(&data).to_vec();
    drop(data);
    readback.unmap();
    crate::dither::unpack_rgb_u8(&packed)
}

/// All-no-op model (every gateable slider zeroed) — the chain is the view tail
/// only. Mirrors `live_chain/tests.rs::noop_model`. `pub(super)` so the sibling
/// `tests_pool` module reuses it.
pub(super) fn noop_model() -> AdjustmentModel {
    AdjustmentModel {
        sharpen_amount: 0.0,
        nr_color: 0.0,
        auto_exposure: AutoExposureMode::Off,
        ..AdjustmentModel::default()
    }
}

/// A mild case (several stages just past threshold) + a non-identity curve/LUT.
pub(super) fn mild_case() -> Case {
    let model = AdjustmentModel {
        temperature: 6000.0,
        tint: 3.0,
        exposure: 0.1,
        contrast: 8.0,
        highlights: -5.0,
        shadows: 5.0,
        vibrance: 6.0,
        saturation: 5.0,
        dehaze: 10.0,
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

/// An aggressive case: every gated stage engaged, incl. a luma point curve.
pub(super) fn aggressive_case() -> Case {
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

pub(super) fn neutral_case() -> Case {
    Case {
        model: noop_model(),
        capture: None,
        curve: nonidentity_curve(),
        lut: nonidentity_lut(9),
        wb_method: WbMethod::Cat16,
    }
}

/// STEP 1 GATE: `LiveSession::render_to_buffer` is BIT-IDENTICAL to the direct
/// `build_live_chain` + `ChainRunner` + `encode_dither` composition, across a
/// neutral / mild / aggressive adjustment set. (Byte-exact: both run the same
/// math; the session just fuses chain→dither into one encoder.)
///
/// This is a PLUMBING gate — it isolates the session's chain→dither fusion +
/// single readback, NOT the airlight method. So it runs against the CPU-readback
/// session (`new_with_airlight_readback`), which shares the EXACT `compute_airlight`
/// the `reference_u8` composition uses, keeping the byte-exact contract meaningful.
/// The DEFAULT on-GPU airlight (#1033) intentionally diverges from the CPU sort at
/// the degenerate 8×8 `top_n = 1` argmax; its end-to-end dehaze parity is gated
/// (with a tolerance, on a realistic fixture) by
/// `on_gpu_dehaze_matches_cpu_reference_on_hazy_fixture`.
#[test]
fn session_render_matches_direct_chain_plus_dither_byte_exact() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (8u32, 8u32);
    let input = scene_linear_rgba(w as usize, h as usize);

    for (name, case) in [
        ("neutral", neutral_case()),
        ("mild", mild_case()),
        ("aggressive", aggressive_case()),
    ] {
        let inputs = case.gpu_inputs();

        let session = LiveSession::new_with_airlight_readback(&ctx, &input, w, h).expect("session");
        let cancel = CancelToken::new();
        let got = session
            .render_to_buffer(&ctx, &inputs, &cancel)
            .expect("render ok")
            .expect("uncancelled render returns Some");

        let want = reference_u8(&ctx, &input, w, h, &inputs);

        assert_eq!(
            got.len(),
            want.len(),
            "[{name}] session vs direct output length mismatch"
        );
        let mismatches = got.iter().zip(&want).filter(|(a, b)| a != b).count();
        eprintln!(
            "LIVE-SESSION STEP1 [{name}]: {mismatches} / {} bytes differ",
            want.len()
        );
        assert_eq!(
            mismatches, 0,
            "[{name}] session render not byte-identical to direct chain+dither: \
             {mismatches} mismatches"
        );
    }
}

/// A pre-cancelled token must abandon the render before encoding (return `None`),
/// mirroring `ChainRunner`'s cancellation contract (the refine pass dropped by a
/// newer edit).
#[test]
fn pre_cancelled_render_returns_none() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (8u32, 8u32);
    let input = scene_linear_rgba(w as usize, h as usize);
    let case = aggressive_case();
    let inputs = case.gpu_inputs();

    let session = LiveSession::new(&ctx, &input, w, h).expect("session");
    let cancel = CancelToken::new();
    cancel.cancel(); // pre-cancelled
    let out = session
        .render_to_buffer(&ctx, &inputs, &cancel)
        .expect("render ok");
    assert!(out.is_none(), "pre-cancelled render must return None");
}

/// The session is upload-once: re-rendering the SAME image + inputs yields the
/// same bytes (the image buffer survives a render unchanged — the P1a invariant,
/// now through the full chain+dither path).
#[test]
fn rerender_same_inputs_is_byte_identical() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (8u32, 8u32);
    let input = scene_linear_rgba(w as usize, h as usize);
    let case = aggressive_case();
    let inputs = case.gpu_inputs();

    let session = LiveSession::new(&ctx, &input, w, h).expect("session");
    let cancel = CancelToken::new();
    let first = session
        .render_to_buffer(&ctx, &inputs, &cancel)
        .expect("render ok")
        .unwrap();
    let second = session
        .render_to_buffer(&ctx, &inputs, &cancel)
        .expect("render ok")
        .unwrap();
    assert_eq!(
        first, second,
        "re-render at same dims/inputs must be byte-identical"
    );
}

/// DIM VALIDATION (#1079): opening a session with dims whose whole-image f32
/// buffer can't fit the device's storage-binding / buffer-size limits returns a
/// descriptive `Err` — BEFORE any GPU buffer is allocated (so this is cheap; an
/// empty pixel slice never gets far enough to matter). 20000×20000 RGBA f32 is
/// 6.4 GB, past the 4 GiB-1 ceiling `max_storage_buffer_binding_size: u32` can
/// even express, so this rejects on EVERY adapter. Without the validation, the
/// first render would hit wgpu's fatal validation panic instead — which unwinds
/// through the `extern "C"` FFI on Apple and aborts the app.
#[test]
fn session_open_rejects_dims_beyond_device_limits() {
    let ctx = GpuContext::new_blocking().expect("gpu context");

    let err = LiveSession::new(&ctx, &[], 20_000, 20_000)
        .err()
        .expect("a 20000x20000 session must be rejected (6.4 GB binding)");
    assert!(
        err.contains("max_storage_buffer_binding_size") || err.contains("max_buffer_size"),
        "error must name the violated device limit, got: {err}"
    );

    // Zero dims and mismatched pixel lengths are clean Errs too (not panics).
    assert!(
        LiveSession::new(&ctx, &[], 0, 8).is_err(),
        "zero width must be Err"
    );
    assert!(
        LiveSession::new(&ctx, &[0.0; 4], 8, 8).is_err(),
        "pixel-len mismatch must be Err"
    );

    // And a valid size still opens (the validation isn't over-eager).
    let input = scene_linear_rgba(8, 8);
    assert!(
        LiveSession::new(&ctx, &input, 8, 8).is_ok(),
        "8x8 must still open"
    );
}
