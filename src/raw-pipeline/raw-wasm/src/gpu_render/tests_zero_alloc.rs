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
        wb_matrix: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        wb_temperature: 6500.0,
        wb_tint: 0.0,
        tone: [0.0; 6],
        tone_curves: ToneCurveInputs {
            parametric: [0.0; 4],
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
        profile_curve_flat: auto_profile::curve::ProfileCurve::identity().to_flat(),
        residual_lut_size: auto_profile::lut::ColorLut::identity(auto_profile::DEFAULT_LUT_SIZE)
            .size,
        residual_lut_data: auto_profile::lut::ColorLut::identity(auto_profile::DEFAULT_LUT_SIZE)
            .data,
        // sRGB primaries — the default (#1337).
        target_primaries: 0,
        // Web test always uses the RAW / full chain.
        input_shape: raw_gpu::InputShape::PostDcpRec2020Fp16,
        // AgX (default) — no profile selection in this test (#1722).
        profile_id: 0,
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
