//! The GPU zero-alloc gate on the f32 / present path, split from
//! `gpu_render/tests.rs` for the 600-LOC budget (same `#[path]` split as
//! `tests_sizing.rs`). Test contents were moved verbatim.

use super::tests::gpu_available;
use raw_core::view::auto_profile;

/// GPU ZERO-ALLOC on the f32 / PRESENT path (`render_chain_to_f32`), which the
/// persistent `WebLiveSession` drives every tick — the surface present samples the
/// resident f32 buffer this leaves, so it never reads back. `live_session/tests.rs`
/// gates this on `render_to_buffer` (the u8 readback path); this fills the gap for
/// the f32 path #1038 actually uses: a 2nd render at the SAME chain signature must
/// allocate ZERO new pooled GPU resources (the CLAUDE.md render-loop invariant).
///
/// "No pipeline RECOMPILE" is structural, not counted here: `GpuContext` (its ~35
/// `OnceCell` compute pipelines) and `WebPresentSurface` (the present pipeline) are
/// each built ONCE in `WebLiveSession::open` and reused — `pool_alloc_count` tracks
/// pooled bind-groups/uniforms/scratch, not the compile-once `OnceCell`s.
///
/// Soft-passes without a GPU adapter. Uses a hand-built scene-linear buffer (no RAW
/// fixture needed) — the zero-alloc property is about GPU resource reuse, not pixel
/// values, so a synthetic upload exercises it fully.
#[test]
fn render_chain_to_f32_second_render_is_zero_alloc() {
    use raw_gpu::{
        CancelToken, CurveMode, FullChainInputs, GpuContext, LiveSession, ToneCurveInputs,
    };
    if !gpu_available() {
        eprintln!("render_chain_to_f32 zero-alloc: no GPU adapter — skipping (soft pass)");
        return;
    }

    let (w, h) = (16u32, 12u32);
    let mut rgba = Vec::with_capacity((w * h) as usize * 4);
    for i in 0..(w * h) as usize {
        let t = i as f32 / ((w * h) as f32 - 1.0);
        rgba.extend_from_slice(&[t * 0.8, t * 0.5 + 0.1, t * 0.3 + 0.2, 1.0]);
    }

    let ctx = GpuContext::new_blocking().expect("gpu context");
    let session = LiveSession::new(&ctx, &rgba, w, h).expect("session");
    // A neutral-ish chain (dehaze inactive → the single-submit f32 path the present
    // uses). Default inputs keep the signature stable across the two renders.
    let inputs = FullChainInputs {
        nr_sampling_scale: 1.0,
        whites_anchor_ev: 0.0, // Synthetic buffer; no RAW prefix is involved.
        wb_matrix: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        wb_temperature: 6500.0,
        wb_tint: 0.0,
        tone: [0.0; 6],
        tone_curves: ToneCurveInputs {
            parametric: [0.0; 4],
            parametric_split: [25.0, 50.0, 75.0],
            luma: vec![],
            red: vec![],
            green: vec![],
            blue: vec![],
            mode: CurveMode::PerChannel,
        },
        vibrance: 0.0,
        saturation: 0.0,
        clarity: 0.0,
        texture: 0.0,
        dehaze: 0.0,
        local_adjustments: Vec::new(),
        mask_rasters: Vec::new(),
        scope: raw_gpu::ScopeRequest::default(),
        mask_orientation: 1,
        defringe: raw_gpu::DefringeInputs::default(),
        vignette_amount: 0.0,
        vignette_feather: 50.0,
        grain_amount: 0.0,
        grain_size: 25.0,
        grain_roughness: 50.0,
        split_tone_shadow_hue: 0.0,
        split_tone_shadow_saturation: 0.0,
        split_tone_highlight_hue: 0.0,
        split_tone_highlight_saturation: 0.0,
        split_tone_balance: 0.0,
        color_grade_shadow_luminance: 0.0,
        color_grade_midtone_hue: 0.0,
        color_grade_midtone_saturation: 0.0,
        color_grade_midtone_luminance: 0.0,
        color_grade_highlight_luminance: 0.0,
        color_grade_global_hue: 0.0,
        color_grade_global_saturation: 0.0,
        color_grade_global_luminance: 0.0,
        color_grade_blending: 100.0,
        color_grade_shadow_edge: 0.564622,
        color_grade_highlight_edge: 0.564622,
        hsl_hue: [0.0; 8],
        hsl_sat: [0.0; 8],
        hsl_lum: [0.0; 8],
        bw_mix: [0.0; 8],
        bw_active: false,
        sharpen_amount: 0.0,
        sharpen_radius: 1.0,
        sharpen_detail: 25.0,
        sharpen_masking: 0.0,
        nr_luminance: 0.0,
        nr_color: 0.0,
        contrast: 0.0,
        capture_sharpening: None,
        profile_curve_flat: auto_profile::curve::ProfileCurve::identity()
            .to_flat()
            .into(),
        residual_lut_size: auto_profile::lut::ColorLut::identity(auto_profile::DEFAULT_LUT_SIZE)
            .size,
        residual_lut_data: auto_profile::lut::ColorLut::identity(auto_profile::DEFAULT_LUT_SIZE)
            .data
            .into(),
        // sRGB primaries — the default (#1337).
        target_primaries: 0,
        // Web test always uses the RAW / full chain.
        input_shape: raw_gpu::InputShape::PostDcpRec2020Fp16,
        // AgX (default) — no profile selection in this test (#1722).
        // No DNG NoiseProfile in this fixture — the flat NLM filter (#1714).
        noise_profile: Vec::new(),
        iso: 0,
        // No film look loaded — the FilmLutPass skip gate (epic #2683, Task 9).
        film_strength: 0.0,
        film_lut_size: 0,
        film_lut_key: 0,
        film_lut_data: Vec::new().into(),
        display_tone_curves: raw_gpu::DisplayToneCurveInputs::default(),
    };
    let cancel = CancelToken::new();

    let before_first = session.pool_alloc_count(&ctx);
    let idx1 = session
        .render_chain_to_f32(&ctx, &inputs, &cancel)
        .expect("first chain-to-f32 render ok")
        .expect("first chain-to-f32 render");
    let first_allocs = session.pool_alloc_count(&ctx) - before_first;

    let idx2 = session
        .render_chain_to_f32(&ctx, &inputs, &cancel)
        .expect("second chain-to-f32 render ok")
        .expect("second chain-to-f32 render");
    let second_allocs = session.pool_alloc_count(&ctx) - before_first - first_allocs;

    eprintln!(
        "render_chain_to_f32 zero-alloc: first render allocated {first_allocs} pooled resources, \
         second allocated {second_allocs} (final idx {idx1} then {idx2})"
    );
    assert_eq!(
        second_allocs, 0,
        "a 2nd same-signature render_chain_to_f32 allocated {second_allocs} pooled GPU resources \
         — the present path's render loop is not zero-alloc"
    );
}

#[path = "allocation_counter.rs"]
mod allocations;

#[test]
fn auto_scalar_ticks_retain_the_fitted_curve_allocation() {
    let ctx = gpu_available().then(|| raw_gpu::GpuContext::new_blocking().expect("GPU context"));
    exercise_auto_ticks(ctx.as_ref());
}

#[test]
fn auto_host_ticks_need_no_adapter() {
    exercise_auto_ticks(None);
}

fn exercise_auto_ticks(ctx: Option<&raw_gpu::GpuContext>) {
    use raw_core::{
        gpu_host::{
            live_profile::LiveProfile, model::prefix_matches, prepare::develop_prefix_rgba,
        },
        pipeline::RenderQuality,
        test_support::synth_dng::SyntheticGreyDng,
        xmp::{AdjustmentModel, Profile},
    };
    if ctx.is_none() {
        eprintln!(
            "Auto host allocation/artifact checks run without a GPU; GPU assertions not exercised"
        );
    }
    let cancel = raw_gpu::CancelToken::new();
    // Exercise all three actual cache states, including the ambiguous curve-only
    // entry which previously re-entered fitting on every tick.
    for state in 0..3 {
        let bytes = SyntheticGreyDng {
            width: 64,
            height: 64,
            linear_value: 0.16 + state as f32 * 0.01,
            ..Default::default()
        }
        .write_to_bytes();
        let raw = raw_core::decode::decode_bytes(&bytes, "dng").unwrap();
        let key = auto_profile::cache::CacheKey::from_bytes(&bytes, RenderQuality::Amaze);
        if state > 0 {
            auto_profile::cache::insert(key.clone(), auto_profile::curve::ProfileCurve::identity());
        }
        if state == 2 {
            auto_profile::cache::insert_lut(key, auto_profile::lut::ColorLut::identity(3));
        }
        let mut model = AdjustmentModel::default();
        let (rgba, w, h, prefix, anchor, _) =
            develop_prefix_rgba(&raw, &bytes, "dng", &model, 64).unwrap();
        let gpu = ctx.map(|ctx| (ctx, raw_gpu::LiveSession::new(ctx, &rgba, w, h).unwrap()));
        let mut cached = LiveProfile::new(&raw, &bytes, "dng", &model, None, 0, anchor);
        // A curve-only entry is Auto 2's cache marker: nothing is applied, so
        // the achieved outcome is unfitted (#5000).
        assert_eq!(cached.auto_fit, Some(state == 2));
        let curve = cached.inputs.profile_curve_flat.as_ptr();
        let lut = cached.inputs.residual_lut_data.as_ptr();
        model.exposure = 0.5;
        cached.update(&model);
        let before = gpu.as_ref().map(|(ctx, session)| {
            session
                .render_chain_to_f32(ctx, &cached.inputs, &cancel)
                .unwrap()
                .unwrap();
            session.pool_alloc_count(ctx)
        });
        for exposure in [1.0, -1.0, 0.5] {
            model.exposure = exposure;
            let count = allocations::count(|| {
                assert!(prefix_matches(&model, &prefix, cached.effective_ae(&model)));
                cached.set_film(None, 0);
                cached.update(&model);
            });
            assert_eq!(count, 0, "Auto state {state} allocated on scalar tick");
            assert_eq!(curve, cached.inputs.profile_curve_flat.as_ptr());
            assert_eq!(lut, cached.inputs.residual_lut_data.as_ptr());
            if let Some((ctx, session)) = &gpu {
                session
                    .render_chain_to_f32(ctx, &cached.inputs, &cancel)
                    .unwrap()
                    .unwrap();
            }
        }
        if let Some((ctx, session)) = &gpu {
            assert_eq!(session.pool_alloc_count(ctx), before.unwrap());
        }
        let (oracle, status) =
            super::chain_inputs_with_status(&raw, &bytes, "dng", &model, None, 0, anchor);
        assert_eq!(cached.auto_fit, status);
        assert_eq!(cached.inputs.profile_curve_flat, oracle.profile_curve_flat);
        assert_eq!(cached.inputs.residual_lut_data, oracle.residual_lut_data);
        if let Some((ctx, session)) = &gpu {
            assert_eq!(
                session
                    .render_to_buffer(ctx, &cached.inputs, &cancel)
                    .unwrap(),
                session.render_to_buffer(ctx, &oracle, &cancel).unwrap(),
                "cached and one-shot pixels differ for Auto state {state}"
            );
        }
        // Film transitions refresh their own grid without re-fitting Auto.
        let film = raw_core::film::FilmLut {
            size: 3,
            data: auto_profile::lut::ColorLut::identity(3)
                .data
                .into_iter()
                .map(|v| v * 0.8)
                .collect(),
        };
        cached.set_film(Some(&film), 17);
        cached.update(&model);
        assert_eq!(cached.inputs.film_lut_data.as_ref(), film.data.as_slice());
        let (film_oracle, _) =
            super::chain_inputs_with_status(&raw, &bytes, "dng", &model, Some(&film), 17, anchor);
        if let Some((ctx, session)) = &gpu {
            assert_eq!(
                session
                    .render_to_buffer(ctx, &cached.inputs, &cancel)
                    .unwrap(),
                session
                    .render_to_buffer(ctx, &film_oracle, &cancel)
                    .unwrap()
            );
            assert_ne!(
                session
                    .render_to_buffer(ctx, &cached.inputs, &cancel)
                    .unwrap(),
                session.render_to_buffer(ctx, &oracle, &cancel).unwrap()
            );
        }
        let film_ptr = cached.inputs.film_lut_data.as_ptr();
        assert_eq!(
            allocations::count(|| {
                cached.set_film(Some(&film), 17);
                cached.update(&model);
            }),
            0
        );
        assert_eq!(film_ptr, cached.inputs.film_lut_data.as_ptr());
        cached.set_film(None, 0);
        assert!(cached.inputs.film_lut_data.is_empty());
        assert_eq!(cached.inputs.film_lut_key, 0);
        if let Some((ctx, session)) = &gpu {
            assert_eq!(
                session
                    .render_to_buffer(ctx, &cached.inputs, &cancel)
                    .unwrap(),
                session.render_to_buffer(ctx, &oracle, &cancel).unwrap()
            );
        }
        assert_eq!(curve, cached.inputs.profile_curve_flat.as_ptr());
        for changed in [
            AdjustmentModel {
                profile: Profile::Neutral,
                ..model.clone()
            },
            AdjustmentModel {
                highlight_recovery: raw_core::types::adjustment::HighlightRecoveryMode::Off,
                ..model.clone()
            },
        ] {
            assert!(!prefix_matches(
                &changed,
                &prefix,
                cached.effective_ae(&changed)
            ));
            let rebuilt = LiveProfile::new(&raw, &bytes, "dng", &changed, None, 0, anchor);
            assert_eq!(
                rebuilt.auto_fit,
                (changed.profile == Profile::Auto).then_some(state == 2)
            );
        }
    }
}
