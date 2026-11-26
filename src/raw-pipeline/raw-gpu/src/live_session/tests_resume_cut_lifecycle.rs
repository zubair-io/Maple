use super::tests::aggressive_case;
use super::tests_resume_cut::{
    assert_late_ticks_resume_and_match_fresh, assert_same, clone_inputs, edited, engaged, fresh,
    image, open, render, H, W,
};
use super::*;
use crate::{CancelToken, GpuContext, GpuMaskRaster, ScopeRequest};
use raw_core::types::{LocalAdjustment, Mask, PartialAdjustments};

#[test]
fn the_second_identical_render_stores_and_the_third_resumes() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let base = engaged(aggressive_case());
    let reference = fresh(&ctx, &base);
    let mut session = open(&ctx);
    for expected in [(0, 0), (1, 0), (1, 1)] {
        assert_same(&render(&session, &ctx, &base), &reference, "a redraw");
        assert_eq!(
            (session.cut.stored(), session.cut.resumed()),
            expected,
            "(stored, resumed) after a redraw"
        );
    }
    session.update_image(&ctx, &image());
    assert!(
        session.resume_cut_reserved(),
        "a new source keeps the reserved plane"
    );
    for expected in [(1, 1), (2, 1), (2, 2)] {
        assert_same(&render(&session, &ctx, &base), &reference, "a new source");
        assert_eq!(
            (session.cut.stored(), session.cut.resumed()),
            expected,
            "(stored, resumed): a new source forgets the stored image and stores again"
        );
    }
}

#[test]
fn reserving_allocates_one_plane_once() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let session = LiveSession::new(&ctx, &image(), W, H).expect("session");
    let unreserved = session.pool_alloc_count(&ctx);
    assert!(!session.resume_cut_reserved());
    session.reserve_resume_cut(&ctx);
    assert!(session.resume_cut_reserved());
    assert_eq!(session.pool_alloc_count(&ctx), unreserved + 1);
    session.reserve_resume_cut(&ctx);
    assert_eq!(
        session.pool_alloc_count(&ctx),
        unreserved + 1,
        "a second reservation keeps the plane it has"
    );
}

fn contrast_drag(base: &FullChainInputs<'static>) -> Vec<FullChainInputs<'static>> {
    [-30.0f32, 12.0, 45.0, -8.0, 27.0]
        .into_iter()
        .map(|contrast| FullChainInputs {
            contrast,
            ..clone_inputs(base)
        })
        .collect()
}

#[test]
fn no_tick_of_a_late_drag_allocates_once_reserved() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let base = engaged(aggressive_case());
    let session = open(&ctx);
    render(&session, &ctx, &base);
    let steps = [(1, 0), (1, 1), (1, 2), (1, 3), (1, 4)];
    for (tick, expected) in contrast_drag(&base).iter().zip(steps) {
        let allocations = session.pool_alloc_count(&ctx);
        let out = render(&session, &ctx, tick);
        assert_eq!(
            session.pool_alloc_count(&ctx),
            allocations,
            "(stored, resumed) = {expected:?}: a tick must not allocate"
        );
        assert_eq!((session.cut.stored(), session.cut.resumed()), expected);
        assert_same(&out, &fresh(&ctx, tick), "a late tick");
    }
}

#[test]
fn a_session_that_never_reserved_runs_every_tick_in_full() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let base = engaged(aggressive_case());
    let session = LiveSession::new(&ctx, &image(), W, H).expect("session");
    assert_same(&render(&session, &ctx, &base), &fresh(&ctx, &base), "warm");
    assert_same(
        &render(&session, &ctx, &base),
        &fresh(&ctx, &base),
        "redraw",
    );
    for tick in contrast_drag(&base) {
        let allocations = session.pool_alloc_count(&ctx);
        let out = render(&session, &ctx, &tick);
        assert_eq!(session.pool_alloc_count(&ctx), allocations);
        assert_same(&out, &fresh(&ctx, &tick), "an unreserved late tick");
    }
    assert_eq!(
        (session.cut.stored(), session.cut.resumed()),
        (0, 0),
        "without a reserved plane nothing is stored or resumed"
    );
}

#[test]
fn a_reservation_refused_with_a_validation_error_stays_unreserved_for_good() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let base = engaged(aggressive_case());
    let session = LiveSession::new(&ctx, &image(), W, H).expect("session");
    let over_the_device_limit = ctx.device.limits().max_buffer_size.saturating_add(16);
    session.cut.set_request_bytes(over_the_device_limit);
    session.reserve_resume_cut(&ctx);
    assert!(
        !session.resume_cut_reserved(),
        "a plane the device refused as invalid is not kept"
    );
    let refused = session.pool_alloc_count(&ctx);
    session.reserve_resume_cut(&ctx);
    assert_eq!(
        (
            session.resume_cut_reserved(),
            session.pool_alloc_count(&ctx)
        ),
        (false, refused),
        "a refusal is permanent: a second call does not try again"
    );
    render(&session, &ctx, &base);
    for tick in contrast_drag(&base) {
        assert_same(
            &render(&session, &ctx, &tick),
            &fresh(&ctx, &tick),
            "a late tick after a refused reservation",
        );
    }
    assert_eq!((session.cut.stored(), session.cut.resumed()), (0, 0));
}

#[test]
fn a_dropped_preparation_frame_never_leaves_a_resumable_store() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let neutral = edited(&engaged(aggressive_case()), |i| {
        i.tone = [0.0, 0.0, 0.0, 0.0, i.tone[4], 0.0]
    });
    let activated = edited(&neutral, |i| i.tone[0] = 0.01);
    let prepare = |session: &LiveSession| {
        session.prepare_exposure_activation(&ctx, &mut clone_inputs(&neutral), &CancelToken::new())
    };
    let session = open(&ctx);
    render(&session, &ctx, &activated);
    assert_eq!(prepare(&session), Ok(true));
    assert_eq!(
        session.cut.stored(),
        1,
        "the preparation frame repeated the prefix, so it encoded a store"
    );
    let late = edited(&activated, |i| i.contrast = 12.0);
    assert_same(
        &render(&session, &ctx, &late),
        &fresh(&ctx, &late),
        "after a dropped store",
    );
    assert_eq!(
        session.cut.resumed(),
        0,
        "a store whose frame never ran is not resumed"
    );
    let later = edited(&activated, |i| i.contrast = -9.0);
    assert_same(
        &render(&session, &ctx, &later),
        &fresh(&ctx, &later),
        "the submitted store",
    );
    assert_eq!(session.cut.resumed(), 1, "the submitted store resumes");

    assert_eq!(prepare(&session), Ok(true));
    assert_eq!(
        session.cut.resumed(),
        2,
        "the preparation frame planned a resume"
    );
    let last = edited(&activated, |i| i.contrast = 21.0);
    assert_same(
        &render(&session, &ctx, &last),
        &fresh(&ctx, &last),
        "after a dropped resume",
    );
    assert_eq!(
        session.cut.resumed(),
        3,
        "a dropped resume keeps the submitted store"
    );
}

#[test]
fn a_cancelled_repeat_of_the_prefix_encodes_no_store() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let base = engaged(aggressive_case());
    let session = open(&ctx);
    render(&session, &ctx, &base);
    let cancelled = CancelToken::new();
    cancelled.cancel();
    let none = session
        .render_to_buffer(&ctx, &base, &cancelled)
        .expect("render ok");
    assert!(none.is_none(), "a cancelled token abandons the frame");
    assert_eq!(
        session.cut.stored(),
        0,
        "a frame cancelled before its first pass encodes no store"
    );
    let late = edited(&base, |i| i.contrast = 12.0);
    assert_same(
        &render(&session, &ctx, &late),
        &fresh(&ctx, &late),
        "after a cancel",
    );
}

const RASTER_ID: u32 = 7;
const RASTER_WIDTH: u32 = 8;
const RASTER_HEIGHT: u32 = 6;

fn bitmap_masked(
    base: &FullChainInputs<'static>,
    weights: &[f32],
    contrast: f32,
) -> FullChainInputs<'static> {
    FullChainInputs {
        contrast,
        local_adjustments: raw_core::types::layers_to_flat(&[LocalAdjustment {
            mask: Mask::Bitmap {
                recipe: Default::default(),
                raster_id: RASTER_ID,
            },
            range: None,
            adjustments: PartialAdjustments {
                exposure: Some(0.8),
                ..Default::default()
            },
        }]),
        mask_rasters: vec![GpuMaskRaster {
            id: RASTER_ID,
            width: RASTER_WIDTH,
            height: RASTER_HEIGHT,
            data: weights.to_vec(),
        }],
        ..clone_inputs(base)
    }
}

#[test]
fn a_repainted_bitmap_mask_reruns_the_chain() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let base = engaged(aggressive_case());
    let texels = RASTER_WIDTH * RASTER_HEIGHT;
    let ramp: Vec<f32> = (0..texels)
        .map(|texel| texel as f32 / (texels - 1) as f32)
        .collect();
    let repainted: Vec<f32> = ramp.iter().map(|weight| 1.0 - weight).collect();
    let session = open(&ctx);
    let warm = bitmap_masked(&base, &ramp, base.contrast);
    render(&session, &ctx, &warm);
    render(&session, &ctx, &warm);
    let late = bitmap_masked(&base, &ramp, 14.0);
    let resumed = render(&session, &ctx, &late);
    assert_eq!(
        session.cut.resumed(),
        1,
        "a late tick over the same raster resumes"
    );
    assert_same(&resumed, &fresh(&ctx, &late), "the same raster");
    let repaint = bitmap_masked(&base, &repainted, 14.0);
    let rerun = render(&session, &ctx, &repaint);
    assert_same(&rerun, &fresh(&ctx, &repaint), "a repainted raster");
    assert_eq!(
        session.cut.resumed(),
        1,
        "a repainted raster must not resume"
    );
    assert_ne!(rerun, resumed, "the raster reaches the output");
}

fn scoped(layer: i32, contrast: f32) -> FullChainInputs<'static> {
    FullChainInputs {
        contrast,
        scope: ScopeRequest {
            layer,
            enabled: true,
        },
        ..engaged(aggressive_case())
    }
}

fn scope_bytes(session: &LiveSession, ctx: &GpuContext, inputs: &FullChainInputs<'_>) -> Vec<u8> {
    session
        .inspect_scope(ctx, inputs, (0, 0, W, H))
        .expect("scope inspection")
        .2
}

#[test]
fn a_resumed_frame_gives_the_scope_what_a_fresh_one_does() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    assert_late_ticks_resume_and_match_fresh(&ctx, &scoped(0, 35.0));

    let session = open(&ctx);
    scope_bytes(&session, &ctx, &scoped(-1, 35.0));
    scope_bytes(&session, &ctx, &scoped(-1, 35.0));
    let steps = [
        (-1, 18.0, 1, "a late tick resumes with the scope on"),
        (0, 18.0, 1, "a new scope layer must not resume"),
        (0, -22.0, 1, "the first late tick on the new layer stores"),
        (0, 9.0, 2, "a late tick resumes on the new scope layer"),
    ];
    for (layer, contrast, resumed, what) in steps {
        let tick = scoped(layer, contrast);
        let reference = LiveSession::new(&ctx, &image(), W, H).expect("session");
        assert_same(
            &scope_bytes(&session, &ctx, &tick),
            &scope_bytes(&reference, &ctx, &tick),
            what,
        );
        assert_eq!(session.cut.resumed(), resumed, "{what}");
    }
}
