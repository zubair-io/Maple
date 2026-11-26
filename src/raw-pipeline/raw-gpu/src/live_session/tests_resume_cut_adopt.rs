use super::tests::aggressive_case;
use super::tests_resume_cut::{assert_same, edited, engaged, fresh, image, open, render, H, W};
use super::*;
use crate::full_chain::oracle::scene_linear_rgba;
use crate::GpuContext;

fn bare(ctx: &GpuContext, pixels: &[f32]) -> LiveSession {
    LiveSession::new(ctx, pixels, W, H).expect("session")
}

fn darker() -> Vec<f32> {
    image().iter().map(|v| v * 0.8).collect()
}

#[test]
fn an_adopted_plane_never_resumes_the_image_it_held() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let base = engaged(aggressive_case());
    let late = edited(&base, |i| i.contrast = 12.0);
    let later = edited(&base, |i| i.contrast = -20.0);
    let donor = open(&ctx);
    render(&donor, &ctx, &base);
    render(&donor, &ctx, &base);
    render(&donor, &ctx, &late);
    assert_eq!(donor.cut.resumed(), 1, "the donor's plane holds its image");

    let heir = bare(&ctx, &darker());
    let allocations = heir.pool_alloc_count(&ctx);
    assert!(heir.adopt_resume_cut(&donor));
    assert_eq!(
        heir.pool_alloc_count(&ctx),
        allocations,
        "a hand-over creates no plane"
    );
    assert_eq!(
        (heir.resume_cut_reserved(), donor.resume_cut_reserved()),
        (true, false)
    );
    let steps = [(&late, (0, 0)), (&late, (1, 0)), (&later, (1, 1))];
    for (tick, expected) in steps {
        assert_same(
            &render(&heir, &ctx, tick),
            &render(&bare(&ctx, &darker()), &ctx, tick),
            "the heir renders its own image, not the one the plane held",
        );
        assert_eq!((heir.cut.stored(), heir.cut.resumed()), expected);
    }
    assert_same(
        &render(&donor, &ctx, &later),
        &fresh(&ctx, &later),
        "the donor runs in full once its plane is gone",
    );
    assert_eq!((donor.cut.stored(), donor.cut.resumed()), (1, 1));
}

#[test]
fn a_plane_is_adopted_only_when_it_exists_and_fits() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let donor = open(&ctx);
    let other_size = LiveSession::new(&ctx, &scene_linear_rgba(64, 48), 64, 48).expect("session");
    assert!(!other_size.adopt_resume_cut(&donor), "another size");
    assert!(!open(&ctx).adopt_resume_cut(&donor), "already reserved");
    assert!(
        donor.resume_cut_reserved(),
        "a declined hand-over leaves the donor its plane"
    );
    let heir = bare(&ctx, &image());
    assert!(!heir.adopt_resume_cut(&bare(&ctx, &image())), "no plane");
    assert!(!heir.resume_cut_reserved());
    heir.reserve_resume_cut(&ctx);
    assert!(
        heir.resume_cut_reserved(),
        "a declined hand-over leaves the fresh reservation open"
    );
}

#[test]
fn replacements_share_one_plane_and_late_ticks_allocate_nothing() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let base = engaged(aggressive_case());
    let first = open(&ctx);
    let allocations = first.pool_alloc_count(&ctx);
    let last = (0..4).fold(first, |replaced, _| {
        let replacement = bare(&ctx, &image());
        assert!(replacement.adopt_resume_cut(&replaced));
        replacement
    });
    assert_eq!(
        last.pool_alloc_count(&ctx),
        allocations,
        "four replacements create no plane"
    );
    render(&last, &ctx, &base);
    let steps = [(-30.0f32, (1, 0)), (12.0, (1, 1)), (45.0, (1, 2))];
    for (contrast, expected) in steps {
        let tick = FullChainInputs {
            contrast,
            ..edited(&base, |_| {})
        };
        let warm = last.pool_alloc_count(&ctx);
        let out = render(&last, &ctx, &tick);
        assert_eq!(last.pool_alloc_count(&ctx), warm, "{contrast}: a late tick");
        assert_eq!((last.cut.stored(), last.cut.resumed()), expected);
        assert_same(&out, &fresh(&ctx, &tick), "a late tick on an adopted plane");
    }
}
