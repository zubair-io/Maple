//! The resident haze map (#3287): a dehaze-slider tick reuses the map its
//! unchanged prefix produced, and anything upstream of dehaze re-measures it.
use super::tests::{aggressive_case, noop_model};
use super::*;
use crate::full_chain::oracle::scene_linear_rgba;
use crate::{CancelToken, GpuContext};

fn render(
    session: &LiveSession,
    ctx: &GpuContext,
    model: &raw_core::xmp::AdjustmentModel,
) -> Vec<u8> {
    let input = scene_linear_rgba(96, 64);
    let mut case = aggressive_case();
    case.model = model.clone();
    session
        .render_to_buffer(ctx, &case.gpu_inputs_for(&input), &CancelToken::new())
        .expect("render ok")
        .expect("not cancelled")
}

#[test]
fn a_dehaze_tick_reuses_the_map_and_an_upstream_edit_remeasures_it() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = scene_linear_rgba(96, 64);
    let session = LiveSession::new(&ctx, &input, 96, 64).expect("session");
    let base = raw_core::xmp::AdjustmentModel {
        exposure: 0.3,
        clarity: 25.0,
        dehaze: 30.0,
        ..noop_model()
    };
    render(&session, &ctx, &base);
    assert_eq!(session.haze.measured(), 1);

    let ticked = raw_core::xmp::AdjustmentModel {
        dehaze: 70.0,
        ..base.clone()
    };
    let before = session.pool_alloc_count(&ctx);
    let reused = render(&session, &ctx, &ticked);
    assert_eq!(
        session.haze.measured(),
        1,
        "a dehaze tick must not re-measure"
    );
    assert_eq!(
        session.pool_alloc_count(&ctx),
        before,
        "a dehaze tick must not allocate"
    );
    let fresh = LiveSession::new(&ctx, &input, 96, 64).expect("session");
    assert_eq!(
        reused,
        render(&fresh, &ctx, &ticked),
        "the reused map must render exactly what a fresh measurement does"
    );

    let upstream = raw_core::xmp::AdjustmentModel {
        exposure: 0.5,
        ..ticked
    };
    render(&session, &ctx, &upstream);
    assert_eq!(
        session.haze.measured(),
        2,
        "an upstream edit must re-measure"
    );

    let mut replaced = session;
    replaced.update_image(
        &ctx,
        &scene_linear_rgba(96, 64)
            .iter()
            .map(|v| v * 0.9)
            .collect::<Vec<_>>(),
    );
    render(&replaced, &ctx, &upstream);
    assert_eq!(replaced.haze.measured(), 3, "a new source must re-measure");
}

#[test]
fn a_local_dehaze_tick_reuses_its_layer_map() {
    use raw_core::types::{LocalAdjustment, PartialAdjustments, Point2};
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = scene_linear_rgba(96, 64);
    let session = LiveSession::new(&ctx, &input, 96, 64).expect("session");
    let layered = |exposure: f32, amount: f32| raw_core::xmp::AdjustmentModel {
        local_adjustments: vec![LocalAdjustment::radial(
            Point2::new(0.5, 0.5),
            Point2::new(0.3, 0.35),
            PartialAdjustments {
                exposure: Some(exposure),
                dehaze: Some(amount),
                ..Default::default()
            },
        )],
        ..noop_model()
    };
    render(&session, &ctx, &layered(0.3, 30.0));
    assert_eq!(session.haze.measured(), 1);
    let before = session.pool_alloc_count(&ctx);
    let reused = render(&session, &ctx, &layered(0.3, 75.0));
    assert_eq!(
        session.haze.measured(),
        1,
        "a local dehaze tick must not re-measure"
    );
    assert_eq!(
        session.pool_alloc_count(&ctx),
        before,
        "a local dehaze tick must not allocate"
    );
    let fresh = LiveSession::new(&ctx, &input, 96, 64).expect("session");
    assert_eq!(reused, render(&fresh, &ctx, &layered(0.3, 75.0)));
    render(&session, &ctx, &layered(0.8, 75.0));
    assert_eq!(
        session.haze.measured(),
        2,
        "the layer's own point edit must re-measure"
    );
}

#[test]
fn a_reused_global_map_keeps_the_layer_map_key() {
    use raw_core::types::{LocalAdjustment, PartialAdjustments, Point2};
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = scene_linear_rgba(96, 64);
    let session = LiveSession::new(&ctx, &input, 96, 64).expect("session");
    let both = |layer: f32, exposure: f32| raw_core::xmp::AdjustmentModel {
        dehaze: 30.0,
        exposure,
        local_adjustments: vec![LocalAdjustment::radial(
            Point2::new(0.5, 0.5),
            Point2::new(0.3, 0.35),
            PartialAdjustments {
                dehaze: Some(layer),
                ..Default::default()
            },
        )],
        ..noop_model()
    };
    render(&session, &ctx, &both(40.0, 0.0));
    render(&session, &ctx, &both(40.0, 0.4));
    assert_eq!(
        session.haze.measured(),
        4,
        "each upstream edit measures both maps"
    );
    render(&session, &ctx, &both(70.0, 0.4));
    render(&session, &ctx, &both(-20.0, 0.4));
    assert_eq!(
        session.haze.measured(),
        4,
        "layer ticks after a re-measure must reuse the layer map, not only the global one"
    );
    let deleted = raw_core::xmp::AdjustmentModel {
        local_adjustments: Vec::new(),
        ..both(-20.0, 0.4)
    };
    render(&session, &ctx, &deleted);
    assert_eq!(
        session.haze.slot_count(),
        1,
        "a deleted layer releases its map"
    );
}

/// Encodes like the live session's own sink, but cancels the render right
/// after the pass that measured a haze map.
struct CancelAfterMeasure<'s> {
    session: &'s LiveSession,
    ctx: &'s GpuContext,
    encoder: &'s mut wgpu::CommandEncoder,
    cancel: CancelToken,
    index: Option<usize>,
}

impl<'i> crate::live_chain::LivePassSink<'i> for CancelAfterMeasure<'_> {
    fn push<T: Pass + 'i>(&mut self, pass: T) {
        if let Some(index) = self.index {
            let before = self.session.haze.measured();
            self.index = self.session.encode_chain(
                self.ctx,
                self.encoder,
                std::iter::once(&pass as &dyn Pass),
                index,
                Some(&self.cancel),
            );
            if self.session.haze.measured() > before {
                self.cancel.cancel();
            }
        }
    }
}

#[test]
fn a_frame_cancelled_after_measuring_leaves_no_resident_map() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = scene_linear_rgba(96, 64);
    let session = LiveSession::new(&ctx, &input, 96, 64).expect("session");
    let model = |exposure: f32, dehaze: f32| raw_core::xmp::AdjustmentModel {
        exposure,
        dehaze,
        sharpen_amount: 60.0,
        ..noop_model()
    };
    render(&session, &ctx, &model(0.0, 40.0));

    let mut case = aggressive_case();
    case.model = model(0.5, 40.0);
    let inputs = case.gpu_inputs_for(&input);
    let sig = chain_signature(&inputs, session.image.dims(), session.session_id);
    ctx.frame_pool
        .borrow_mut()
        .begin_session_frame(sig, &session.pool_owner);
    let mut encoder = ctx
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
    let mut sink = CancelAfterMeasure {
        session: &session,
        ctx: &ctx,
        encoder: &mut encoder,
        cancel: CancelToken::new(),
        index: Some(0),
    };
    crate::live_chain::visit_live_chain(
        &inputs,
        AirlightSource::Resident(std::sync::Arc::clone(&session.haze), 0),
        &mut sink,
    );
    let cancelled = sink.index;
    ctx.frame_pool.borrow_mut().end_frame();
    drop(encoder);
    session.haze.abandoned();
    assert_eq!(cancelled, None, "the render must be cancelled after dehaze");
    assert_eq!(session.haze.measured(), 2);

    let ticked = render(&session, &ctx, &model(0.5, 70.0));
    assert_eq!(
        session.haze.measured(),
        3,
        "a map whose frame was never submitted must be measured again"
    );
    let fresh = LiveSession::new(&ctx, &input, 96, 64).expect("session");
    assert_eq!(ticked, render(&fresh, &ctx, &model(0.5, 70.0)));
}

#[test]
fn a_downstream_gate_change_keeps_the_resident_map() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = scene_linear_rgba(96, 64);
    let session = LiveSession::new(&ctx, &input, 96, 64).expect("session");
    let model = |sharpen: f32| raw_core::xmp::AdjustmentModel {
        exposure: 0.3,
        dehaze: 40.0,
        sharpen_amount: sharpen,
        ..noop_model()
    };
    render(&session, &ctx, &model(0.0));
    let sharpened = render(&session, &ctx, &model(60.0));
    render(&session, &ctx, &model(0.0));
    assert_eq!(
        session.haze.measured(),
        1,
        "crossing a downstream stage's gate must not re-measure"
    );
    let fresh = LiveSession::new(&ctx, &input, 96, 64).expect("session");
    assert_eq!(sharpened, render(&fresh, &ctx, &model(60.0)));
}

#[test]
fn exposure_preparation_never_leaves_an_unwritten_map() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = scene_linear_rgba(96, 64);
    let session = LiveSession::new(&ctx, &input, 96, 64).expect("session");
    let model = |exposure: f32| raw_core::xmp::AdjustmentModel {
        exposure,
        dehaze: 40.0,
        ..noop_model()
    };
    let mut case = aggressive_case();
    case.model = model(0.0);
    let mut inputs = case.gpu_inputs_for(&input);
    inputs.tone = [0.0; 6];
    assert!(session
        .prepare_exposure_activation(&ctx, &mut inputs, &CancelToken::new())
        .unwrap());
    let prepared = session.haze.measured();
    let rendered = render(&session, &ctx, &model(0.01));
    assert_eq!(
        session.haze.measured(),
        prepared + 1,
        "the unsubmitted preparation frame's map must not be reused"
    );
    let fresh = LiveSession::new(&ctx, &input, 96, 64).expect("session");
    assert_eq!(rendered, render(&fresh, &ctx, &model(0.01)));
}

#[test]
fn sessions_of_different_aspect_share_a_context() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let model = raw_core::xmp::AdjustmentModel {
        dehaze: 40.0,
        ..noop_model()
    };
    let shot = |w: u32, h: u32| {
        let input = scene_linear_rgba(w as usize, h as usize);
        let session = LiveSession::new(&ctx, &input, w, h).expect("session");
        let mut case = aggressive_case();
        case.model = model.clone();
        session
            .render_to_buffer(&ctx, &case.gpu_inputs_for(&input), &CancelToken::new())
            .expect("render ok")
            .expect("not cancelled")
    };
    let wide = shot(96, 64);
    shot(96, 72);
    assert_eq!(wide, shot(96, 64));
}
