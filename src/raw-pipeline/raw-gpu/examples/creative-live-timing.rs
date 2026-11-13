//! The capture-first white-balance tick (#5377): a capture decode resident on
//! the GPU, then a drag across the temperature slider, each tick deriving the
//! creative plan on the CPU and running the chain the default model engages
//! (capture-first creative stage, sharpening, colour NR, AgX). No readback.
//! Usage: cargo run --release -p raw-gpu --example creative-live-timing -- <RAW> [edge]
use raw_core::pipeline::{self, CreativeTick, PlanTable, RenderQuality};
use raw_core::types::WbMethod;
use raw_core::xmp::AdjustmentModel;
use raw_gpu::{CancelToken, CurveMode, FullChainInputs, GpuContext, InputShape, LiveSession};
use raw_gpu::{CreativeInputs, CreativeTable, ToneCurveInputs};
use std::{path::Path, time::Instant};

fn table(t: &PlanTable) -> CreativeTable {
    CreativeTable {
        dims: t.dims,
        srgb: t.srgb,
        cold_offset: t.cold_offset,
        warm_offset: t.warm_offset,
        warm_weight: t.warm_weight,
    }
}

fn tick_inputs<'a>(
    model: &AdjustmentModel,
    creative: CreativeInputs<'a>,
    anchor: f32,
    sampling_scale: f32,
) -> FullChainInputs<'a> {
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
        sharpen_amount: model.sharpen_amount,
        sharpen_radius: model.sharpen_radius,
        sharpen_detail: model.sharpen_detail,
        sharpen_masking: model.sharpen_masking,
        nr_luminance: model.nr_luminance,
        nr_color: model.nr_color,
        nr_sampling_scale: sampling_scale,
        contrast: 0.0,
        capture_sharpening: None,
        profile_curve_flat: Vec::new().into(),
        residual_lut_size: 0,
        residual_lut_data: Vec::new().into(),
        target_primaries: 0,
        input_shape: InputShape::PostDcpRec2020Fp16,
        noise_profile: Vec::new(),
        iso: 0,
        film_strength: 0.0,
        film_lut_size: 0,
        film_lut_key: 0,
        film_lut_data: Vec::new().into(),
        display_tone_curves: raw_gpu::DisplayToneCurveInputs::default(),
        color_curves: raw_gpu::ColorCurveInputs::default(),
        creative: Some(creative),
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).expect("RAW path");
    let edge = std::env::args()
        .nth(2)
        .map_or(2560, |e| e.parse().expect("edge"));
    let raw = raw_core::decode::decode(Path::new(&path))?;
    let model = AdjustmentModel::default();
    let capture = pipeline::render_capture_sized_from_raw_f32(
        &raw,
        &model,
        RenderQuality::Full,
        edge,
        raw_core::CancelToken::never(),
    )?;
    let frame = capture.creative.frame.expect("a calibrated body");
    let ctx = GpuContext::new_blocking()?;
    let session = LiveSession::new(&ctx, &capture.rgba, capture.width, capture.height)?;
    let cancel = CancelToken::new();
    let temperatures: Vec<f32> = (0..90)
        .map(|i| frame.scene_cct - 1500.0 + 3000.0 * (i as f32 / 89.0))
        .collect();
    let tick = |temperature: f32| -> Result<f64, Box<dyn std::error::Error>> {
        let start = Instant::now();
        let plan = capture.creative.gpu_plan(
            capture.tables.floats(),
            CreativeTick {
                temperature,
                tint: frame.scene_tint,
                wb_method: WbMethod::Cat16,
            },
        )?;
        let creative = CreativeInputs {
            to_pro: plan.to_pro.0,
            from_pro: plan.from_pro.0,
            tables: plan.tables,
            hsm: plan.hsm.as_ref().map(table),
            look: plan.look.as_ref().map(table),
            highlight_recovery: plan.highlight_recovery,
            post: plan.post.0,
        };
        let inputs = tick_inputs(
            &model,
            creative,
            capture.whites_anchor_ev,
            capture.nr_sampling_scale,
        );
        session
            .render_chain_to_f32(&ctx, &inputs, &cancel)?
            .expect("rendered");
        ctx.device.poll(wgpu::Maintain::Wait);
        Ok(start.elapsed().as_secs_f64() * 1000.0)
    };
    // Warm every pipeline and pooled resource before timing.
    for &t in temperatures.iter().step_by(3) {
        tick(t)?;
    }
    let warm = session.pool_alloc_count(&ctx);
    let mut times = temperatures
        .iter()
        .map(|&t| tick(t))
        .collect::<Result<Vec<_>, _>>()?;
    let allocations = session.pool_alloc_count(&ctx) - warm;
    times.sort_by(f64::total_cmp);
    println!(
        "image={}x{} ticks={} median_ms={:.3} p95_ms={:.3} max_ms={:.3} warm_gpu_pool_allocations={allocations}",
        capture.width,
        capture.height,
        times.len(),
        times[times.len() / 2],
        times[times.len() * 95 / 100],
        times[times.len() - 1],
    );
    Ok(())
}
