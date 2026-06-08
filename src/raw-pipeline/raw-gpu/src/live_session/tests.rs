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
            .render_to_buffer(&ctx, &inputs, airlight, &cancel)
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
    let out = session.render_to_buffer(&ctx, &inputs, airlight, &cancel);
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
    let first = session.render_to_buffer(&ctx, &inputs, airlight, &cancel).unwrap();
    let second = session.render_to_buffer(&ctx, &inputs, airlight, &cancel).unwrap();
    assert_eq!(first, second, "re-render at same dims/inputs must be byte-identical");
}

/// STEP 2b — THE ZERO-ALLOCATION GATE (CLAUDE.md: "allocation inside the render
/// loop … does not ship"). A second render at the SAME dims + inputs (same chain
/// signature) allocates ZERO new GPU buffers / bind groups, AND is bit-identical
/// to the first. Non-vacuous: the FIRST render's allocation count must be > 0
/// (else the hook isn't measuring anything). Run across a neutral (view-tail
/// only), a mild, and an aggressive (every gated stage + dehaze + the spatial
/// DAGs) signature, so the pool is exercised both near-empty and fully loaded.
#[test]
fn second_render_same_signature_allocates_nothing() {
    let ctx = GpuContext::new_blocking();
    let (w, h) = (8u32, 8u32);
    let input = scene_linear_rgba(w as usize, h as usize);
    let airlight = compute_airlight(&input, w as usize, h as usize);
    let cancel = CancelToken::new();

    for (name, case) in [
        ("neutral", neutral_case()),
        ("mild", mild_case()),
        ("aggressive", aggressive_case()),
    ] {
        let inputs = case.gpu_inputs();
        // A fresh session per case (reset() clears the prior case's cache).
        let session = LiveSession::new(&ctx, &input, w, h);

        // First render: fills the pool (allocations expected).
        let before_first = session.pool_alloc_count(&ctx);
        let first = session.render_to_buffer(&ctx, &inputs, airlight, &cancel).unwrap();
        let first_allocs = session.pool_alloc_count(&ctx) - before_first;

        // Second render, identical signature: must reuse everything.
        let second = session.render_to_buffer(&ctx, &inputs, airlight, &cancel).unwrap();
        let second_allocs = session.pool_alloc_count(&ctx) - before_first - first_allocs;

        eprintln!(
            "ZERO-ALLOC [{name}]: first render = {first_allocs} pool allocs, \
             second render = {second_allocs} pool allocs"
        );
        assert!(
            first_allocs > 0,
            "[{name}] first render did 0 pool allocs — the accounting hook is vacuous"
        );
        assert_eq!(
            second_allocs, 0,
            "[{name}] second render at the same signature allocated {second_allocs} GPU \
             resources — the render loop is not zero-alloc"
        );
        assert_eq!(
            first, second,
            "[{name}] the zero-alloc re-render must be byte-identical to the first"
        );
    }
}

/// THE LIVE-EDIT GATE: a slider drag WITHIN one signature (same active set,
/// changed VALUE) must (a) produce the correct NEW pixels — matching a reference
/// render of the new value — and (b) still allocate ZERO new GPU resources. This
/// is the actual hot path P4b serves, and the one the same-inputs re-render tests
/// can't see: with identical inputs, a stale uniform / stale data buffer would go
/// green. Two value-change paths:
///   - exposure 0.3 → 0.4: the UNIFORM-on-hit path (`encode_simple` rewrites the
///     pooled uniform every call).
///   - parametric_lights 15 → 40: the DATA-BUFFER-on-hit path (`pool_data_storage`
///     must rewrite the pooled tone-curve storage every call — without that, the
///     edit would bind the first render's stale curve and the preview would freeze).
#[test]
fn same_signature_value_change_is_correct_and_zero_alloc() {
    let ctx = GpuContext::new_blocking();
    let (w, h) = (8u32, 8u32);
    let input = scene_linear_rgba(w as usize, h as usize);
    let airlight = compute_airlight(&input, w as usize, h as usize);
    let cancel = CancelToken::new();

    // Build two cases that share an active-stage SET but differ in a VALUE.
    let make_case = |mutate: &dyn Fn(&mut AdjustmentModel)| -> Case {
        let mut model = noop_model();
        // Engage scene-tone (exposure) AND tone-curves (parametric) on BOTH so the
        // active mask — and thus the signature — is identical across the value
        // change; the mutation only shifts magnitudes.
        model.exposure = 0.3;
        model.parametric_lights = 15.0;
        mutate(&mut model);
        Case {
            model,
            capture: None,
            curve: nonidentity_curve(),
            lut: nonidentity_lut(9),
            wb_method: WbMethod::Cat16,
        }
    };

    let base_case = make_case(&|_| {});
    let edited_case = make_case(&|m| {
        m.exposure = 0.4; // uniform-path change
        m.parametric_lights = 40.0; // data-buffer-path change
    });
    let base = base_case.gpu_inputs();
    let edited = edited_case.gpu_inputs();

    // Same signature (only values differ)?
    assert_eq!(
        crate::chain_signature(&base, (w, h)),
        crate::chain_signature(&edited, (w, h)),
        "test setup: the two cases must share a chain signature (same active set)"
    );

    let session = LiveSession::new(&ctx, &input, w, h);

    // Render base (fills the cache for this signature).
    let _ = session.render_to_buffer(&ctx, &base, airlight, &cancel).unwrap();

    // Now the EDIT: same signature, changed values. Snapshot allocs around it.
    let pre_edit = session.pool_alloc_count(&ctx);
    let got = session.render_to_buffer(&ctx, &edited, airlight, &cancel).unwrap();
    let edit_allocs = session.pool_alloc_count(&ctx) - pre_edit;

    // (a) Correct NEW pixels: matches a reference render of the EDITED inputs
    //     (direct chain+dither, no pool). If the uniform / data buffer weren't
    //     rewritten on the hit, `got` would still be the BASE output → mismatch.
    let want = reference_u8(&ctx, &input, w, h, &edited);
    let mismatches = got.iter().zip(&want).filter(|(a, b)| a != b).count();
    eprintln!(
        "LIVE-EDIT: edit render = {edit_allocs} pool allocs, {mismatches} / {} bytes differ vs reference",
        want.len()
    );
    assert_eq!(
        mismatches, 0,
        "same-signature value change produced STALE pixels ({mismatches} bytes differ from the \
         reference render of the edited inputs) — a pooled uniform/data buffer wasn't rewritten"
    );

    // (b) Zero-alloc: the edit reused the cached resources.
    assert_eq!(
        edit_allocs, 0,
        "a same-signature value-change render allocated {edit_allocs} GPU resources — not zero-alloc"
    );

    // And the edited output must actually DIFFER from the base (else the test is
    // vacuous — a no-op edit can't prove freshness).
    let base_out = reference_u8(&ctx, &input, w, h, &base);
    assert_ne!(
        got, base_out,
        "the edit produced the BASE pixels — the value change had no effect (vacuous)"
    );
}

/// A slider crossing a GATING threshold (e.g. dehaze 0→engaged) changes the chain
/// signature → a fresh pool bucket (allocations expected the first time that
/// shape is seen), but a re-render of the NEW shape is again zero-alloc. This pins
/// the signature-keyed cache: a new shape never reuses (binds) the old shape's
/// resources, and each shape converges to zero-alloc independently.
#[test]
fn signature_change_allocates_once_then_zero() {
    let ctx = GpuContext::new_blocking();
    let (w, h) = (8u32, 8u32);
    let input = scene_linear_rgba(w as usize, h as usize);
    let airlight = compute_airlight(&input, w as usize, h as usize);
    let cancel = CancelToken::new();
    let session = LiveSession::new(&ctx, &input, w, h);

    // Shape A: neutral (view tail only).
    let a = neutral_case().gpu_inputs();
    let base = session.pool_alloc_count(&ctx);
    session.render_to_buffer(&ctx, &a, airlight, &cancel).unwrap();
    let a1 = session.pool_alloc_count(&ctx) - base;
    session.render_to_buffer(&ctx, &a, airlight, &cancel).unwrap();
    let a2 = session.pool_alloc_count(&ctx) - base - a1;
    assert!(a1 > 0, "shape A first render must allocate");
    assert_eq!(a2, 0, "shape A re-render must be zero-alloc");

    // Shape B: dehaze engaged — a DIFFERENT signature → its own bucket allocates.
    let mut b_case = neutral_case();
    b_case.model.dehaze = 40.0;
    let b = b_case.gpu_inputs();
    let pre_b = session.pool_alloc_count(&ctx);
    session.render_to_buffer(&ctx, &b, airlight, &cancel).unwrap();
    let b1 = session.pool_alloc_count(&ctx) - pre_b;
    session.render_to_buffer(&ctx, &b, airlight, &cancel).unwrap();
    let b2 = session.pool_alloc_count(&ctx) - pre_b - b1;
    eprintln!("SIGNATURE-CHANGE: shape A allocs={a1}, shape B allocs={b1} (B re-render={b2})");
    assert!(
        b1 > 0,
        "shape B (dehaze on) is a new signature — its first render must allocate"
    );
    assert_eq!(b2, 0, "shape B re-render must be zero-alloc");

    // Returning to shape A is zero-alloc (its bucket is still cached).
    let pre_a3 = session.pool_alloc_count(&ctx);
    session.render_to_buffer(&ctx, &a, airlight, &cancel).unwrap();
    let a3 = session.pool_alloc_count(&ctx) - pre_a3;
    assert_eq!(a3, 0, "returning to shape A must reuse its cached bucket (zero-alloc)");
}
