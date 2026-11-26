use super::tests::aggressive_case;
use super::tests_resume_cut::{
    assert_late_ticks_resume_and_match_fresh, assert_same, clone_inputs, edited, engaged, fresh,
    image, render, H, W,
};
use super::*;
use crate::{CancelToken, GpuContext, GpuMaskRaster, ScopeRequest};
use raw_core::types::{LocalAdjustment, Mask, PartialAdjustments};

#[test]
fn the_second_identical_render_allocates_the_plane_and_the_third_resumes() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let base = engaged(aggressive_case());
    let reference = fresh(&ctx, &base);
    let mut session = LiveSession::new(&ctx, &image(), W, H).expect("session");
    for expected in [(0, 0), (1, 0), (1, 1)] {
        assert_same(&render(&session, &ctx, &base), &reference, "a redraw");
        assert_eq!(
            (session.cut.allocated(), session.cut.resumed()),
            expected,
            "(allocated, resumed) after a redraw"
        );
    }
    session.update_image(&ctx, &image());
    for expected in [(1, 1), (1, 1), (1, 2)] {
        assert_same(&render(&session, &ctx, &base), &reference, "a new source");
        assert_eq!(
            (session.cut.allocated(), session.cut.resumed()),
            expected,
            "(allocated, resumed): a new source keeps the plane and stores into it again"
        );
    }
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
    let session = LiveSession::new(&ctx, &image(), W, H).expect("session");
    render(&session, &ctx, &activated);
    assert_eq!(prepare(&session), Ok(true));
    assert_eq!(
        session.cut.allocated(),
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
    let session = LiveSession::new(&ctx, &image(), W, H).expect("session");
    render(&session, &ctx, &base);
    let cancelled = CancelToken::new();
    cancelled.cancel();
    let none = session
        .render_to_buffer(&ctx, &base, &cancelled)
        .expect("render ok");
    assert!(none.is_none(), "a cancelled token abandons the frame");
    assert_eq!(
        session.cut.allocated(),
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
    let session = LiveSession::new(&ctx, &image(), W, H).expect("session");
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

    let session = LiveSession::new(&ctx, &image(), W, H).expect("session");
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
