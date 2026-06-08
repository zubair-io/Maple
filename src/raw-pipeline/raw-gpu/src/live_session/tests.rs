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
use crate::dither::encode_dither;
use crate::full_chain::oracle::{nonidentity_curve, nonidentity_lut, scene_linear_rgba, Case};
use crate::image::GpuImage;
use crate::live_chain::build_live_chain;
use crate::{compute_airlight, CancelToken, GpuContext, Pass};

use raw_core::types::adjustment::AutoExposureMode;
use raw_core::types::{ToneCurve, ToneCurveMode, WbMethod};
use raw_core::xmp::AdjustmentModel;

/// Reference path: run the gated `build_live_chain` through a plain `ChainRunner`
/// (the C1 entry) to the final f32 buffer, then re-upload that buffer and run the
/// C2 `encode_dither` standalone → the unpacked `3·w·h` u8 RGB surface. This is
/// the "direct" composition the session must match bit-for-bit.
fn reference_u8(ctx: &GpuContext, input: &[f32], w: u32, h: u32, inputs: &crate::FullChainInputs) -> Vec<u8> {
    let airlight = compute_airlight(input, w as usize, h as usize);
    let passes = build_live_chain(inputs, airlight);
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
/// only. Mirrors `live_chain/tests.rs::noop_model`.
fn noop_model() -> AdjustmentModel {
    AdjustmentModel {
        sharpen_amount: 0.0,
        nr_color: 0.0,
        auto_exposure: AutoExposureMode::Off,
        ..AdjustmentModel::default()
    }
}

/// A mild case (several stages just past threshold) + a non-identity curve/LUT.
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

fn neutral_case() -> Case {
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
#[test]
fn session_render_matches_direct_chain_plus_dither_byte_exact() {
    let ctx = GpuContext::new_blocking();
    let (w, h) = (8u32, 8u32);
    let input = scene_linear_rgba(w as usize, h as usize);

    for (name, case) in [
        ("neutral", neutral_case()),
        ("mild", mild_case()),
        ("aggressive", aggressive_case()),
    ] {
        let inputs = case.gpu_inputs();
        let airlight = compute_airlight(&input, w as usize, h as usize);

        let session = LiveSession::new(&ctx, &input, w, h);
        let cancel = CancelToken::new();
        let got = session
            .render_to_buffer(&inputs, airlight, &cancel)
            .expect("uncancelled render returns Some");

        let want = reference_u8(&ctx, &input, w, h, &inputs);

        assert_eq!(
            got.len(),
            want.len(),
            "[{name}] session vs direct output length mismatch"
        );
        let mismatches = got.iter().zip(&want).filter(|(a, b)| a != b).count();
        eprintln!("LIVE-SESSION STEP1 [{name}]: {mismatches} / {} bytes differ", want.len());
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
    let ctx = GpuContext::new_blocking();
    let (w, h) = (8u32, 8u32);
    let input = scene_linear_rgba(w as usize, h as usize);
    let case = aggressive_case();
    let inputs = case.gpu_inputs();
    let airlight = compute_airlight(&input, w as usize, h as usize);

    let session = LiveSession::new(&ctx, &input, w, h);
    let cancel = CancelToken::new();
    cancel.cancel(); // pre-cancelled
    let out = session.render_to_buffer(&inputs, airlight, &cancel);
    assert!(out.is_none(), "pre-cancelled render must return None");
}

/// The session is upload-once: re-rendering the SAME image + inputs yields the
/// same bytes (the image buffer survives a render unchanged — the P1a invariant,
/// now through the full chain+dither path).
#[test]
fn rerender_same_inputs_is_byte_identical() {
    let ctx = GpuContext::new_blocking();
    let (w, h) = (8u32, 8u32);
    let input = scene_linear_rgba(w as usize, h as usize);
    let case = aggressive_case();
    let inputs = case.gpu_inputs();
    let airlight = compute_airlight(&input, w as usize, h as usize);

    let session = LiveSession::new(&ctx, &input, w, h);
    let cancel = CancelToken::new();
    let first = session.render_to_buffer(&inputs, airlight, &cancel).unwrap();
    let second = session.render_to_buffer(&inputs, airlight, &cancel).unwrap();
    assert_eq!(first, second, "re-render at same dims/inputs must be byte-identical");
}
