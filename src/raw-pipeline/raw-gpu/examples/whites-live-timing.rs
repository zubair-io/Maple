//! Reproducible #3633 warm Whites tick timing. No per-tick image readback.
//! Usage: cargo run --release -p raw-gpu --example whites-live-timing -- <RAW>
use raw_core::pipeline::{self, RenderQuality};
use raw_core::types::adjustment::{AutoExposureMode, Profile};
use raw_core::xmp::AdjustmentModel;
use raw_gpu::InputShape;
use raw_gpu::{CancelToken, FullChainInputs, GpuContext, LiveSession};
use raw_gpu::{CurveMode, ToneCurveInputs};
use std::{path::Path, time::Instant};
fn bench_inputs(anchor: f32) -> FullChainInputs<'static> {
    use raw_core::view::auto_profile;
    FullChainInputs {
        wb_matrix: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        wb_temperature: 6500.0,
        wb_tint: 0.0,
        tone: [0.0; 6],
        whites_anchor_ev: anchor,
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
        target_primaries: 0,
        input_shape: InputShape::PostDcpRec2020Fp16,
        noise_profile: Vec::new(),
        iso: 0,
        film_strength: 0.0,
        film_lut_size: 0,
        film_lut_key: 0,
        film_lut_data: Vec::new().into(),
        display_tone_curves: raw_gpu::DisplayToneCurveInputs::default(),
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).expect("RAW path");
    let raw = raw_core::decode::decode(Path::new(&path))?;
    let model = AdjustmentModel {
        profile: Profile::Neutral,
        auto_exposure: AutoExposureMode::Off,
        ..Default::default()
    };
    let scene = pipeline::develop_scene_linear_sized_from_raw_with_quality(
        &raw,
        &model,
        RenderQuality::Preview,
        1732,
    )?;
    let anchor = scene.whites_anchor_ev.expect("decoded RAW scene anchor");
    let rgba: Vec<f32> = scene
        .pixels
        .iter()
        .flat_map(|p| [p[0], p[1], p[2], 1.0])
        .collect();
    let ctx = GpuContext::new_blocking()?;
    let session = LiveSession::new(&ctx, &rgba, scene.width, scene.height)?;
    let mut inputs = bench_inputs(anchor);
    let cancel = CancelToken::new();
    println!("image={}x{} anchor_ev={anchor}", scene.width, scene.height);
    // Exercise all slider values before timing so lazy pipelines and pooled
    // resources are resident. Wait for GPU completion, without mapping pixels.
    for _ in 0..5 {
        for value in [0.0, 100.0, -100.0] {
            inputs.tone[4] = value;
            session
                .render_chain_to_f32(&ctx, &inputs, &cancel)?
                .expect("rendered");
            ctx.device.poll(wgpu::Maintain::Wait);
        }
    }
    let allocations = session.pool_alloc_count(&ctx);
    let mut times = [[0.0f64; 60]; 3];
    for repetition in 0..60 {
        // Rotate order to spread thermal/load drift over all three settings.
        for offset in 0..3 {
            let index = (repetition + offset) % 3;
            inputs.tone[4] = [0.0, 100.0, -100.0][index];
            let start = Instant::now();
            session
                .render_chain_to_f32(&ctx, &inputs, &cancel)?
                .expect("rendered");
            ctx.device.poll(wgpu::Maintain::Wait);
            times[index][repetition] = start.elapsed().as_secs_f64() * 1000.0;
        }
    }
    for (value, mut samples) in [0, 100, -100].into_iter().zip(times) {
        samples.sort_by(f64::total_cmp);
        println!(
            "whites={value} median_ms={:.6} p95_ms={:.6} min_ms={:.6} max_ms={:.6}",
            (samples[29] + samples[30]) * 0.5,
            samples[56],
            samples[0],
            samples[59]
        );
    }
    println!(
        "warm_gpu_pool_allocations={}",
        session.pool_alloc_count(&ctx) - allocations
    );
    Ok(())
}
