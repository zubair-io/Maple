//! The S3 live-vs-refine gate on the Android session (#5380), on real bodies
//! (fixture-gated, real GPU): the resident capture decode rendered through the
//! creative stage at every white balance of a drag, against a fresh sized
//! develop of the same model, within one 8-bit step on every channel. The
//! drag never re-decodes and allocates no GPU buffer after its first tick.
use super::*;
use raw_core::pipeline::{render_sized_from_raw_with_quality_and_source, RawInput, RenderQuality};
use raw_core::test_support::capture_seam::{
    at, combinations, max_step, targets, EDGE, FIXTURES, NEUTRAL_XMP,
};

fn shown(session: &mut Session) -> Vec<u8> {
    let token = CancelToken::new();
    session.update_gpu(&token).unwrap().unwrap();
    let (live, inputs) = session.frame_parts();
    let rgb = live
        .render_to_buffer(&session.ctx, inputs, &token)
        .unwrap()
        .unwrap();
    let (w, h) = live.dims();
    raw_core::image::apply_orientation(&rgb, w, h, session.orientation()).2
}

fn refined(session: &Session) -> Vec<u8> {
    render_sized_from_raw_with_quality_and_source(
        session.raw.as_ref().unwrap(),
        &session.model,
        RenderQuality::Amaze,
        Some(RawInput::Bytes {
            bytes: &session.bytes,
            ext: &session.ext,
        }),
        EDGE,
    )
    .unwrap()
    .2
}

fn gate(name: &str) {
    let path = raw_core::test_support::fixtures::require_raw(name);
    let mut session = Session::open(path.to_str().unwrap(), NEUTRAL_XMP, EDGE).unwrap();
    let mut worst = 0u8;
    for (combination, decode_model) in combinations() {
        session.model = decode_model.clone();
        session.update().unwrap();
        let prefix = session.prefix.clone();
        let header = session.creative.as_ref().unwrap().header;
        let mut allocations = None;
        for (target, white_balance) in targets(&header) {
            session.model = at(&decode_model, white_balance);
            assert!(!session.needs_preparation(), "a drag must not re-decode");
            let (live, refine) = (shown(&mut session), refined(&session));
            let step = max_step(&live, &refine);
            let moved = live.iter().zip(&refine).filter(|(a, b)| a != b).count();
            eprintln!(
                "android {name} [{combination} @ {target}] live vs refine: max step {step}, \
                 {moved}/{} channels differ",
                live.len()
            );
            worst = worst.max(step);
            assert!(step <= 1, "{name} [{combination} @ {target}]: {step} steps");
            assert_eq!(session.white_balance_values(), white_balance);
            let count = session.live.pool_alloc_count(&session.ctx);
            assert_eq!(*allocations.get_or_insert(count), count, "{target}");
        }
        assert_eq!(session.prefix, prefix);
    }
    eprintln!("android {name}: worst live-vs-refine step {worst}");
}

#[test]
#[cfg_attr(
    not(feature = "fixtures"),
    ignore = "needs test-fixtures/raws (fixtures feature)"
)]
fn live_matches_refine_within_one_step_on_test_0005() {
    gate(FIXTURES[0]);
}

#[test]
#[cfg_attr(
    not(feature = "fixtures"),
    ignore = "needs test-fixtures/raws (fixtures feature)"
)]
fn live_matches_refine_within_one_step_on_test_0007() {
    gate(FIXTURES[1]);
}
