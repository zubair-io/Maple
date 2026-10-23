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
