use super::tests::aggressive_case;
use super::tests_resume_cut::{
    assert_ignored_fields_leave_the_cut, assert_late_ticks_resume_and_match_fresh, assert_same,
    clone_inputs, edited, engaged, engaged_model, fresh, image, open, render, reserved, Edit, H, W,
};
use super::*;
use crate::live_chain::tests_creative::{creative_inputs, custom};
use crate::{CancelToken, GpuContext};
use raw_core::test_support::creative::{creative_stage, Tables};
use raw_core::types::{LocalAdjustment, PartialAdjustments, Point2, ToneCurve};
use raw_core::xmp::HighlightRecoveryMode;

fn every_stage_case() -> crate::full_chain::oracle::Case {
    let mut case = aggressive_case();
    engaged_model(&mut case);
    case.model.local_adjustments.push(LocalAdjustment::radial(
        Point2::new(0.35, 0.4),
        Point2::new(0.25, 0.3),
        PartialAdjustments {
            clarity: Some(35.0),
            texture: Some(-20.0),
            sharpness: Some(40.0),
            luminance_noise: Some(30.0),
            ..Default::default()
        },
    ));
    case.model.hue_adjustment_red = 20.0;
    case.model.saturation_adjustment_blue = -30.0;
    case.model.luminance_adjustment_orange = 15.0;
    case.model.color_curve_hue_vs_sat =
        ToneCurve::new(vec![(0.0, 0.5), (0.3, 0.7), (0.6, 0.4), (1.0, 0.5)]);
    case.model.color_curve_luma_vs_sat = ToneCurve::new(vec![(0.0, 0.5), (0.5, 0.65), (1.0, 0.5)]);
    case.capture = Some(crate::CaptureSharpeningParams {
        sigma: 0.8,
        iterations: 2,
        highlight_threshold: 0.9,
        strength: 1.0,
        noise_floor: 3e-4,
    });
    case
}

fn captured() -> FullChainInputs<'static> {
    every_stage_case().gpu_inputs_for(&image())
}

fn creative() -> FullChainInputs<'static> {
    let stage = Box::leak(Box::new(creative_stage(Tables::DualHueSatMapAndLook, 1.5)));
    let wire = Box::leak(Box::new(stage.gpu_wire()));
    let model = custom(5200.0, 4.0, HighlightRecoveryMode::OklabChromaReduction);
    let plan = stage.gpu_plan(wire, &model).expect("creative plan");
    FullChainInputs {
        creative: Some(creative_inputs(&plan)),
        ..captured()
    }
}

fn non_raw() -> FullChainInputs<'static> {
    FullChainInputs {
        input_shape: crate::InputShape::LinearRec2020Fp16,
        ..captured()
    }
}

#[test]
fn the_guard_and_the_sweep_hold_with_every_prefix_stage_engaged() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let raw_inert: &[&str] = &["film_lut_key"];
    let non_raw_inert: &[&str] = &[
        "whites_anchor_ev",
        "tone[4]",
        "contrast",
        "profile_curve_flat",
        "residual_lut_data",
        "residual_lut_size residual_lut_data",
        "film_lut_key",
    ];
    for (base, inert) in [
        (captured(), raw_inert),
        (creative(), raw_inert),
        (non_raw(), non_raw_inert),
    ] {
        assert_ignored_fields_leave_the_cut(&ctx, &base, inert);
        assert_late_ticks_resume_and_match_fresh(&ctx, &base);
    }
}

fn f32_out(session: &LiveSession, ctx: &GpuContext, inputs: &FullChainInputs<'_>) -> Vec<u32> {
    let index = session
        .render_chain_to_f32(ctx, inputs, &CancelToken::new())
        .expect("render ok")
        .expect("not cancelled");
    let staging = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("resume-cut-test-f32"),
        size: session.image.byte_len(),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = ctx
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
    let source = session.ping_pong_buffer(index);
    encoder.copy_buffer_to_buffer(source, 0, &staging, 0, source.size());
    ctx.queue.submit(Some(encoder.finish()));
    pollster::block_on(limits::map_f32_readback(ctx, &staging))
        .expect("readback")
        .iter()
        .map(|v| v.to_bits())
        .collect()
}

#[test]
fn the_present_path_resumes_bit_for_bit() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    for base in [engaged(aggressive_case()), creative()] {
        let session = open(&ctx);
        f32_out(&session, &ctx, &base);
        f32_out(&session, &ctx, &base);
        for (n, value) in [-20.0f32, 40.0, 5.0].into_iter().enumerate() {
            let mut late = clone_inputs(&base);
            late.contrast = value;
            late.tone[4] = value;
            let out = f32_out(&session, &ctx, &late);
            assert_eq!(session.cut.resumed(), n as u64 + 1);
            let reference = LiveSession::new(&ctx, &image(), W, H).expect("session");
            assert_same(&out, &f32_out(&reference, &ctx, &late), "present path");
        }
    }
}

#[test]
fn a_cut_stored_in_one_shape_resumes_in_another() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let base = engaged(aggressive_case());
    let no_grain = edited(&base, |i| i.grain_amount = 0.0);
    let session = open(&ctx);
    render(&session, &ctx, &base);
    render(&session, &ctx, &base);
    render(&session, &ctx, &no_grain);
    let allocations = session.pool_alloc_count(&ctx);
    let resumed = session.cut.resumed();
    let ticks: Vec<FullChainInputs<'static>> = (0..7)
        .map(|n| {
            let mut tick = clone_inputs(if n % 2 == 0 { &base } else { &no_grain });
            tick.contrast = 3.0 * n as f32 + 11.0;
            tick
        })
        .collect();
    let outputs: Vec<Vec<u8>> = ticks
        .iter()
        .map(|tick| render(&session, &ctx, tick))
        .collect();
    assert_eq!(
        session.cut.resumed(),
        resumed + 7,
        "every tick resumes, whichever shape stored the cut"
    );
    assert_eq!(session.pool_alloc_count(&ctx), allocations);
    for (out, tick) in outputs.iter().zip(&ticks) {
        assert_same(out, &fresh(&ctx, tick), "alternating shapes");
    }
}

#[test]
fn only_a_repeated_prefix_stores() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let base = engaged(aggressive_case());

    let one_shot = open(&ctx);
    render(&one_shot, &ctx, &base);
    one_shot
        .render_chain_to_f32(
            &ctx,
            &edited(&base, |i| i.tone[0] = 0.7),
            &CancelToken::new(),
        )
        .expect("render ok");
    assert_eq!(one_shot.cut.stored(), 0, "a one-shot render never stores");

    let exposure_drag = open(&ctx);
    for n in 0..10 {
        let mut tick = clone_inputs(&base);
        tick.tone[0] = 0.1 * n as f32;
        assert_same(
            &render(&exposure_drag, &ctx, &tick),
            &fresh(&ctx, &tick),
            "drag",
        );
    }
    assert_eq!(exposure_drag.cut.stored(), 0, "a prefix drag never stores");
    assert_eq!(exposure_drag.cut.resumed(), 0);

    let session = open(&ctx);
    let steps: [(Edit, u64, u64); 6] = [
        (|_| {}, 0, 0),
        (|i| i.contrast = 10.0, 1, 0),
        (|i| i.contrast = 20.0, 1, 1),
        (|i| i.tone[0] = 0.8, 1, 1),
        (|i| i.contrast = 30.0, 2, 1),
        (|i| i.contrast = 40.0, 2, 2),
    ];
    let mut current = clone_inputs(&base);
    for (step, (edit, stored, resumed)) in steps.into_iter().enumerate() {
        edit(&mut current);
        let out = render(&session, &ctx, &current);
        assert_same(&out, &fresh(&ctx, &current), "step");
        assert_eq!(session.cut.stored(), stored, "step {step}: stored");
        assert_eq!(session.cut.resumed(), resumed, "step {step}: resumed");
    }
}

#[test]
fn a_plane_over_the_bound_is_never_reserved() {
    assert!(
        resume_cut::ResumeCut::covers(6016 * 3384 * 16),
        "6K full screen"
    );
    assert!(resume_cut::ResumeCut::covers(3456 * 2304 * 16));
    assert!(
        !resume_cut::ResumeCut::covers(11_648 * 8_736 * 16),
        "100 MP"
    );
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let base = engaged(aggressive_case());
    let session = LiveSession::new(&ctx, &image(), W, H).expect("session");
    session.cut.set_max_bytes(session.image.byte_len() - 1);
    let unreserved = session.pool_alloc_count(&ctx);
    session.reserve_resume_cut(&ctx);
    assert_eq!(
        session.pool_alloc_count(&ctx),
        unreserved,
        "a plane over the bound is not created"
    );
    assert!(!session.resume_cut_reserved());
    for contrast in [0.0f32, 0.0, 10.0, 20.0, 30.0] {
        let tick = FullChainInputs {
            contrast,
            ..clone_inputs(&base)
        };
        assert_same(
            &render(&session, &ctx, &tick),
            &fresh(&ctx, &tick),
            "capped",
        );
    }
    assert_eq!(session.cut.stored(), 0);
    assert_eq!(session.cut.resumed(), 0);
}

#[test]
fn only_the_frame_that_stored_can_validate_its_cut() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let clear = edited(&engaged(aggressive_case()), |i| i.dehaze = 0.0);
    let session = reserved(
        &ctx,
        LiveSession::new_with_airlight_readback(&ctx, &image(), W, H).expect("session"),
    );
    render(&session, &ctx, &clear);
    render(&session, &ctx, &clear);
    let moved = edited(&clear, |i| i.tone[0] = 1.1);
    render(&session, &ctx, &moved);

    let signature = chain_signature(&moved, session.image.dims(), session.session_id);
    ctx.frame_pool
        .borrow_mut()
        .begin_session_frame(signature, &session.pool_owner);
    let mut encoder = ctx
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
    let (_, index) = session.encode_live_chain(&ctx, &mut encoder, &moved, None);
    ctx.frame_pool.borrow_mut().end_frame();
    assert!(index.is_some());
    drop(encoder);

    render(&session, &ctx, &edited(&moved, |i| i.dehaze = 25.0));
    let late = edited(&moved, |i| i.contrast = -15.0);
    let resumed = session.cut.resumed();
    let out = render(&session, &ctx, &late);
    assert_eq!(
        session.cut.resumed(),
        resumed,
        "a never-submitted store is dropped"
    );
    let reference = LiveSession::new_with_airlight_readback(&ctx, &image(), W, H).expect("session");
    assert_same(
        &out,
        &render(&reference, &ctx, &late),
        "after a dropped frame",
    );
}
