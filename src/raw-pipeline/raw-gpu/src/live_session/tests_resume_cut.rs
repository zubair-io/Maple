use super::tests::{aggressive_case, mild_case};
use super::*;
use crate::full_chain::oracle::{random_film_lut, scene_linear_rgba};
use crate::live_chain::{PrefixKey, VIEW_TAIL_FIELDS};
use crate::{CancelToken, GpuContext};
use raw_core::types::{LocalAdjustment, PartialAdjustments, Point2};

pub(super) const W: u32 = 96;
pub(super) const H: u32 = 64;

pub(super) type Edit = fn(&mut FullChainInputs<'static>);

pub(super) fn image() -> Vec<f32> {
    scene_linear_rgba(W as usize, H as usize)
}

pub(super) fn engaged_model(case: &mut crate::full_chain::oracle::Case) {
    case.model.local_adjustments = vec![LocalAdjustment::radial(
        Point2::new(0.5, 0.5),
        Point2::new(0.3, 0.35),
        PartialAdjustments {
            exposure: Some(0.4),
            dehaze: Some(30.0),
            ..Default::default()
        },
    )];
    case.model.nr_luminance = case.model.nr_luminance.max(25.0);
    case.model.clarity = case.model.clarity.max(20.0);
    case.model.texture = case.model.texture.max(15.0);
    case.model.vignette_amount = -20.0;
    case.model.grain_amount = 30.0;
    case.model.split_tone_shadow_hue = 220.0;
    case.model.split_tone_shadow_saturation = 30.0;
    case.model.split_tone_highlight_hue = 40.0;
    case.model.split_tone_highlight_saturation = 25.0;
    case.model.color_grade_midtone_hue = 120.0;
    case.model.color_grade_midtone_saturation = 20.0;
    case.model.color_grade_global_hue = 300.0;
    case.model.color_grade_global_saturation = 10.0;
    case.model.display_tone_curve_luma =
        raw_core::types::ToneCurve::new(vec![(0.0, 0.0), (0.5, 0.56), (1.0, 1.0)]);
    case.film_lut = Some(random_film_lut(5, 7));
    case.film_strength = 40.0;
}

pub(super) fn engaged(mut case: crate::full_chain::oracle::Case) -> FullChainInputs<'static> {
    engaged_model(&mut case);
    case.gpu_inputs_for(&image())
}

pub(super) fn render(
    session: &LiveSession,
    ctx: &GpuContext,
    inputs: &FullChainInputs<'_>,
) -> Vec<u8> {
    session
        .render_to_buffer(ctx, inputs, &CancelToken::new())
        .expect("render ok")
        .expect("not cancelled")
}

pub(super) fn fresh(ctx: &GpuContext, inputs: &FullChainInputs<'_>) -> Vec<u8> {
    let session = LiveSession::new(ctx, &image(), W, H).expect("session");
    render(&session, ctx, inputs)
}

pub(super) fn edited(base: &FullChainInputs<'static>, edit: Edit) -> FullChainInputs<'static> {
    let mut inputs = clone_inputs(base);
    edit(&mut inputs);
    inputs
}

pub(super) fn clone_inputs(base: &FullChainInputs<'static>) -> FullChainInputs<'static> {
    FullChainInputs {
        tone_curves: base.tone_curves.clone(),
        local_adjustments: base.local_adjustments.clone(),
        profile_curve_flat: base.profile_curve_flat.clone(),
        residual_lut_data: base.residual_lut_data.clone(),
        noise_profile: base.noise_profile.clone(),
        film_lut_data: base.film_lut_data.clone(),
        display_tone_curves: base.display_tone_curves.clone(),
        mask_rasters: Vec::new(),
        color_curves: base.color_curves.clone(),
        ..*base
    }
}

pub(super) fn assert_same<T: PartialEq>(a: &[T], b: &[T], what: &str) {
    let differing = a.iter().zip(b).filter(|(x, y)| x != y).count();
    assert!(
        a.len() == b.len() && differing == 0,
        "{what}: {differing} of {} values differ",
        a.len()
    );
}

fn read_cut(session: &LiveSession, ctx: &GpuContext) -> Vec<u32> {
    let staging = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("resume-cut-test-readback"),
        size: session.image.byte_len(),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = ctx
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
    session.cut.encode_read(&mut encoder, &staging);
    ctx.queue.submit(Some(encoder.finish()));
    pollster::block_on(limits::map_f32_readback(ctx, &staging))
        .expect("readback")
        .iter()
        .map(|v| v.to_bits())
        .collect()
}

const LATE_EDITS: [(&str, Edit); 7] = [
    ("contrast", |i| i.contrast = -25.0),
    ("whites", |i| i.tone[4] = -45.0),
    ("grain", |i| i.grain_amount = 70.0),
    ("grade", |i| i.color_grade_midtone_saturation = 55.0),
    ("split tone", |i| i.split_tone_balance = 35.0),
    ("film", |i| i.film_strength = 80.0),
    ("contrast again", |i| i.contrast = 60.0),
];

pub(super) fn assert_late_ticks_resume_and_match_fresh(
    ctx: &GpuContext,
    base: &FullChainInputs<'static>,
) {
    let session = LiveSession::new(ctx, &image(), W, H).expect("session");
    assert_same(&render(&session, ctx, base), &fresh(ctx, base), "base");
    assert_same(&render(&session, ctx, base), &fresh(ctx, base), "stored");
    let mut current = clone_inputs(base);
    for (name, edit) in LATE_EDITS {
        edit(&mut current);
        let resumed = session.cut.resumed();
        let out = render(&session, ctx, &current);
        assert_eq!(
            session.cut.resumed(),
            resumed + 1,
            "{name}: a late edit must resume"
        );
        assert_same(&out, &fresh(ctx, &current), name);
    }
    let crossing = edited(&current, |i| i.grain_amount = 0.0);
    assert_same(
        &render(&session, ctx, &crossing),
        &fresh(ctx, &crossing),
        "a late gate crossing",
    );
    let ticked = edited(&crossing, |i| i.contrast = 10.0);
    let resumed = session.cut.resumed();
    assert_same(
        &render(&session, ctx, &ticked),
        &fresh(ctx, &ticked),
        "ticked",
    );
    assert_eq!(
        session.cut.resumed(),
        resumed + 1,
        "the new shape resumes once it has run"
    );
}

#[test]
fn late_slider_ticks_resume_and_match_a_fresh_render() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    for base in [engaged(aggressive_case()), engaged(mild_case())] {
        assert_late_ticks_resume_and_match_fresh(&ctx, &base);
    }
}

#[test]
fn an_upstream_edit_reruns_the_chain() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let base = engaged(aggressive_case());
    let upstream: [(&str, Edit); 8] = [
        ("exposure", |i| i.tone[0] = 0.9),
        ("white balance", |i| {
            i.wb_temperature = 5600.0;
            i.wb_matrix[0][0] *= 1.05;
        }),
        ("luminance NR", |i| i.nr_luminance = 60.0),
        ("colour NR", |i| i.nr_color = 70.0),
        ("clarity", |i| i.clarity = 70.0),
        ("sharpening", |i| i.sharpen_amount = 120.0),
        ("mask", |i| {
            i.local_adjustments = raw_core::types::layers_to_flat(&[LocalAdjustment::radial(
                Point2::new(0.4, 0.55),
                Point2::new(0.3, 0.35),
                PartialAdjustments {
                    exposure: Some(0.4),
                    dehaze: Some(30.0),
                    ..Default::default()
                },
            )]);
        }),
        ("sampling scale", |i| i.nr_sampling_scale = 0.5),
    ];
    for (name, edit) in upstream {
        let session = LiveSession::new(&ctx, &image(), W, H).expect("session");
        render(&session, &ctx, &base);
        render(&session, &ctx, &base);
        render(&session, &ctx, &edited(&base, |i| i.contrast = 5.0));
        assert_eq!(session.cut.resumed(), 1, "{name}: warmed");
        let changed = edited(&edited(&base, |i| i.contrast = 5.0), edit);
        assert_same(
            &render(&session, &ctx, &changed),
            &fresh(&ctx, &changed),
            name,
        );
        assert_eq!(session.cut.resumed(), 1, "{name}: must not resume");
        let late = edited(&changed, |i| i.contrast = 30.0);
        assert_same(&render(&session, &ctx, &late), &fresh(&ctx, &late), name);
        assert_eq!(
            session.cut.resumed(),
            1,
            "{name}: the first late tick stores"
        );
        let later = edited(&changed, |i| i.contrast = -30.0);
        assert_same(&render(&session, &ctx, &later), &fresh(&ctx, &later), name);
        assert_eq!(session.cut.resumed(), 2, "{name}: resumes from the new cut");
    }
}

const IGNORED: [(&str, Edit); 30] = [
    ("whites_anchor_ev", |i| i.whites_anchor_ev = 1.0),
    ("tone[4]", |i| i.tone[4] = -60.0),
    ("contrast", |i| i.contrast = -50.0),
    ("grain_amount", |i| i.grain_amount = 80.0),
    ("grain_size", |i| i.grain_size = 70.0),
    ("grain_roughness", |i| i.grain_roughness = 10.0),
    ("split_tone_shadow_hue", |i| i.split_tone_shadow_hue = 20.0),
    ("split_tone_shadow_saturation", |i| {
        i.split_tone_shadow_saturation = 80.0
    }),
    ("split_tone_highlight_hue", |i| {
        i.split_tone_highlight_hue = 200.0
    }),
    ("split_tone_highlight_saturation", |i| {
        i.split_tone_highlight_saturation = 80.0
    }),
    ("split_tone_balance", |i| i.split_tone_balance = -60.0),
    ("color_grade_shadow_luminance", |i| {
        i.color_grade_shadow_luminance = 40.0
    }),
    ("color_grade_midtone_hue", |i| {
        i.color_grade_midtone_hue = 300.0
    }),
    ("color_grade_midtone_saturation", |i| {
        i.color_grade_midtone_saturation = 70.0
    }),
    ("color_grade_midtone_luminance", |i| {
        i.color_grade_midtone_luminance = -40.0
    }),
    ("color_grade_highlight_luminance", |i| {
        i.color_grade_highlight_luminance = -40.0
    }),
    ("color_grade_global_hue", |i| {
        i.color_grade_global_hue = 90.0
    }),
    ("color_grade_global_saturation", |i| {
        i.color_grade_global_saturation = 60.0
    }),
    ("color_grade_global_luminance", |i| {
        i.color_grade_global_luminance = 30.0
    }),
    ("color_grade_blending", |i| i.color_grade_blending = 20.0),
    ("color_grade_shadow_edge", |i| {
        i.color_grade_shadow_edge = 0.3
    }),
    ("color_grade_highlight_edge", |i| {
        i.color_grade_highlight_edge = 0.8
    }),
    ("profile_curve_flat", |i| {
        i.profile_curve_flat = Vec::new().into()
    }),
    ("residual_lut_data", |i| {
        i.residual_lut_data = i
            .residual_lut_data
            .iter()
            .map(|v| v * 0.9)
            .collect::<Vec<_>>()
            .into();
    }),
    ("residual_lut_size residual_lut_data", |i| {
        i.residual_lut_size = 0;
        i.residual_lut_data = Vec::new().into();
    }),
    ("target_primaries", |i| i.target_primaries = 1),
    ("film_strength", |i| i.film_strength = 90.0),
    ("film_lut_size film_lut_data", |i| {
        let lut = random_film_lut(4, 11);
        i.film_lut_size = lut.size as u32;
        i.film_lut_data = lut.data.into();
    }),
    ("film_lut_key", |i| i.film_lut_key = 9),
    ("display_tone_curves", |i| {
        i.display_tone_curves.master = vec![(0.0, 0.05), (0.5, 0.4), (1.0, 1.0)];
    }),
];

fn render_and_read_cut(ctx: &GpuContext, inputs: &FullChainInputs<'_>) -> (Vec<u8>, Vec<u32>) {
    let session = LiveSession::new(ctx, &image(), W, H).expect("session");
    render(&session, ctx, inputs);
    let out = render(&session, ctx, inputs);
    assert_eq!(session.cut.allocated(), 1, "a repeated prefix stores");
    (out, read_cut(&session, ctx))
}

pub(super) fn assert_ignored_fields_leave_the_cut(
    ctx: &GpuContext,
    base: &FullChainInputs<'static>,
    inert: &[&str],
) {
    let covered: std::collections::BTreeSet<&str> = IGNORED
        .iter()
        .flat_map(|(fields, _)| fields.split(' '))
        .collect();
    let listed: std::collections::BTreeSet<&str> = VIEW_TAIL_FIELDS
        .iter()
        .copied()
        .chain(["tone[4]"])
        .collect();
    assert_eq!(covered, listed, "every ignored field needs a rendered edit");
    let (base_out, base_cut) = render_and_read_cut(ctx, base);
    let mut unchanged = Vec::new();
    for (name, edit) in IGNORED {
        let inputs = edited(base, edit);
        let mut key = PrefixKey::default();
        key.update(base);
        assert!(key.update(&inputs), "{name}: must not change the key");
        let (out, cut) = render_and_read_cut(ctx, &inputs);
        assert_same(
            &cut,
            &base_cut,
            &format!("{name}: a pass before the cut reads it, so it must stay keyed"),
        );
        if out == base_out {
            unchanged.push(name);
        }
    }
    assert_eq!(unchanged, inert, "every other edit must reach the output");
}

#[test]
fn every_ignored_field_leaves_the_prefix_output_unchanged() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    assert_ignored_fields_leave_the_cut(&ctx, &engaged(aggressive_case()), &["film_lut_key"]);
}

#[test]
fn a_new_source_or_a_cancelled_frame_never_resumes_a_stale_cut() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let base = engaged(aggressive_case());
    let mut session = LiveSession::new(&ctx, &image(), W, H).expect("session");
    render(&session, &ctx, &base);
    render(&session, &ctx, &base);
    let darker: Vec<f32> = image().iter().map(|v| v * 0.8).collect();
    session.update_image(&ctx, &darker);
    let late = edited(&base, |i| i.contrast = 12.0);
    let out = render(&session, &ctx, &late);
    assert_eq!(session.cut.resumed(), 0, "a new source must re-run");
    let reference = LiveSession::new(&ctx, &darker, W, H).expect("session");
    assert_same(&out, &render(&reference, &ctx, &late), "new source");

    let cancelled = CancelToken::new();
    cancelled.cancel();
    let upstream = edited(&late, |i| i.tone[0] = 1.2);
    let none = session
        .render_to_buffer(&ctx, &upstream, &cancelled)
        .expect("render ok");
    assert!(none.is_none());
    let after = render(&session, &ctx, &late);
    assert_eq!(session.cut.resumed(), 0, "a cancelled frame stores nothing");
    assert_same(&after, &render(&reference, &ctx, &late), "after a cancel");

    let other = LiveSession::new(&ctx, &scene_linear_rgba(64, 48), 64, 48).expect("session");
    let small = scene_linear_rgba(64, 48);
    let small_inputs = FullChainInputs {
        whites_anchor_ev: crate::full_chain::oracle::frame_whites_anchor(&small),
        ..clone_inputs(&late)
    };
    render(&other, &ctx, &small_inputs);
    render(&other, &ctx, &small_inputs);
    let small_late = edited(&small_inputs, |i| i.contrast = 40.0);
    let resumed = render(&other, &ctx, &small_late);
    assert_eq!(other.cut.resumed(), 1);
    let small_fresh = LiveSession::new(&ctx, &small, 64, 48).expect("session");
    assert_same(
        &resumed,
        &render(&small_fresh, &ctx, &small_late),
        "other dims",
    );
}

#[test]
fn alternating_upstream_and_late_ticks_allocate_nothing_once_warm() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let base = engaged(aggressive_case());
    let session = LiveSession::new(&ctx, &image(), W, H).expect("session");
    let tick = |n: usize| {
        let mut inputs = clone_inputs(&base);
        inputs.tone[0] = 0.2 + 0.1 * (n / 3) as f32;
        inputs.contrast = 5.0 * n as f32;
        inputs
    };
    (0..6).for_each(|n| {
        render(&session, &ctx, &tick(n));
    });
    assert_eq!(session.cut.allocated(), 1);
    let allocations = session.pool_alloc_count(&ctx);
    let resumed = session.cut.resumed();
    for n in 6..15 {
        render(&session, &ctx, &tick(n));
    }
    assert_eq!(session.pool_alloc_count(&ctx), allocations);
    assert_eq!(session.cut.allocated(), 1, "the resident image is reused");
    assert_eq!(
        session.cut.resumed(),
        resumed + 3,
        "the third tick of each prefix resumes"
    );
}

#[test]
fn the_readback_airlight_fallback_never_resumes_with_dehaze() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let base = engaged(aggressive_case());
    let session = LiveSession::new_with_airlight_readback(&ctx, &image(), W, H).expect("session");
    render(&session, &ctx, &base);
    render(&session, &ctx, &base);
    render(&session, &ctx, &edited(&base, |i| i.contrast = 3.0));
    assert_eq!(session.cut.resumed(), 0);
    assert_eq!(session.cut.allocated(), 0);
}

#[test]
fn the_key_is_exact_as_inputs_grow_and_shrink() {
    let base = engaged(aggressive_case());
    let mut key = PrefixKey::default();
    assert!(!key.update(&base), "the first key is new");
    assert!(key.update(&base));
    let longer = edited(&base, |i| {
        i.noise_profile = vec![1.0e-5, 2.0e-6, 1.0e-5, 2.0e-6]
    });
    assert!(!key.update(&longer));
    assert!(key.update(&longer));
    assert!(!key.update(&base), "a shorter key is a change");
    assert!(key.update(&base));
    assert!(!key.update(&edited(&base, |i| i.tone[0] += 0.25)));
    assert!(!key.update(&base));
    assert!(key.update(&edited(&base, |i| {
        i.tone[4] += 30.0;
        i.contrast -= 10.0;
    })));
}
