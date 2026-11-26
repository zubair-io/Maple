//! Warm live-chain slider ticks (#6021) for the default model, an engaged
//! detail model, and that model over the capture decode with the creative
//! stage (what shipping hosts run). Also times the first late tick after an
//! exposure change and the bare resident-plane copy. Waits for GPU completion
//! every tick; no readback.
//! Usage: cargo run --release -p raw-gpu --example detail-live-timing -- <RAW> [edge] [ticks]
use raw_core::pipeline::{self, CreativePlan, PlanTable, RenderQuality};
use raw_core::types::adjustment::{AutoExposureMode, Profile};
use raw_core::xmp::AdjustmentModel;
use raw_gpu::{CancelToken, CurveMode, FullChainInputs, GpuContext, InputShape, LiveSession};
use raw_gpu::{CreativeInputs, CreativeTable, DefringeInputs, ScopeRequest, ToneCurveInputs};
use std::{path::Path, time::Instant};

type Drag = (
    &'static str,
    fn(&mut FullChainInputs<'static>, f32),
    [f32; 2],
);

const DRAGS: [Drag; 5] = [
    ("exposure", |i, v| i.tone[0] = v, [-1.0, 1.0]),
    ("contrast", |i, v| i.contrast = v, [-60.0, 60.0]),
    ("whites", |i, v| i.tone[4] = v, [-60.0, 60.0]),
    (
        "grade_midtone_saturation",
        |i, v| {
            i.color_grade_midtone_hue = 40.0;
            i.color_grade_midtone_saturation = v;
        },
        [5.0, 60.0],
    ),
    ("grain_amount", |i, v| i.grain_amount = v, [5.0, 60.0]),
];

fn inputs(
    m: &AdjustmentModel,
    anchor: f32,
    sampling_scale: f32,
    noise_profile: Vec<f32>,
    iso: u32,
) -> FullChainInputs<'static> {
    FullChainInputs {
        wb_matrix: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        wb_temperature: 6500.0,
        wb_tint: 0.0,
        tone: [
            m.exposure,
            m.brightness,
            m.highlights,
            m.shadows,
            m.whites,
            m.blacks,
        ],
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
        vibrance: m.vibrance,
        saturation: m.saturation,
        clarity: m.clarity,
        texture: m.texture,
        dehaze: m.dehaze,
        local_adjustments: Vec::new(),
        mask_rasters: Vec::new(),
        scope: ScopeRequest::default(),
        mask_orientation: 1,
        defringe: DefringeInputs::default(),
        vignette_amount: m.vignette_amount,
        vignette_feather: m.vignette_feather,
        grain_amount: m.grain_amount,
        grain_size: m.grain_size,
        grain_roughness: m.grain_roughness,
        split_tone_shadow_hue: m.split_tone_shadow_hue,
        split_tone_shadow_saturation: m.split_tone_shadow_saturation,
        split_tone_highlight_hue: m.split_tone_highlight_hue,
        split_tone_highlight_saturation: m.split_tone_highlight_saturation,
        split_tone_balance: m.split_tone_balance,
        color_grade_shadow_luminance: m.color_grade_shadow_luminance,
        color_grade_midtone_hue: m.color_grade_midtone_hue,
        color_grade_midtone_saturation: m.color_grade_midtone_saturation,
        color_grade_midtone_luminance: m.color_grade_midtone_luminance,
        color_grade_highlight_luminance: m.color_grade_highlight_luminance,
        color_grade_global_hue: m.color_grade_global_hue,
        color_grade_global_saturation: m.color_grade_global_saturation,
        color_grade_global_luminance: m.color_grade_global_luminance,
        color_grade_blending: m.color_grade_blending,
        color_grade_shadow_edge: m.color_grade_shadow_edge,
        color_grade_highlight_edge: m.color_grade_highlight_edge,
        hsl_hue: [0.0; 8],
        hsl_sat: [0.0; 8],
        hsl_lum: [0.0; 8],
        bw_mix: [0.0; 8],
        bw_active: false,
        sharpen_amount: m.sharpen_amount,
        sharpen_radius: m.sharpen_radius,
        sharpen_detail: m.sharpen_detail,
        sharpen_masking: m.sharpen_masking,
        nr_luminance: m.nr_luminance,
        nr_color: m.nr_color,
        nr_sampling_scale: sampling_scale,
        contrast: m.contrast,
        capture_sharpening: None,
        profile_curve_flat: Vec::new().into(),
        residual_lut_size: 0,
        residual_lut_data: Vec::new().into(),
        target_primaries: 0,
        input_shape: InputShape::PostDcpRec2020Fp16,
        noise_profile,
        iso,
        film_strength: 0.0,
        film_lut_size: 0,
        film_lut_key: 0,
        film_lut_data: Vec::new().into(),
        display_tone_curves: raw_gpu::DisplayToneCurveInputs::default(),
        color_curves: raw_gpu::ColorCurveInputs::default(),
        creative: None,
    }
}

fn table(t: &PlanTable) -> CreativeTable {
    CreativeTable {
        dims: t.dims,
        srgb: t.srgb,
        cold_offset: t.cold_offset,
        warm_offset: t.warm_offset,
        warm_weight: t.warm_weight,
    }
}

fn creative_inputs(plan: &CreativePlan<'static>) -> CreativeInputs<'static> {
    CreativeInputs {
        to_pro: plan.to_pro.0,
        from_pro: plan.from_pro.0,
        tables: plan.tables,
        hsm: plan.hsm.as_ref().map(table),
        look: plan.look.as_ref().map(table),
        highlight_recovery: plan.highlight_recovery,
        post: plan.post.0,
    }
}

fn percentile(sorted: &[f64], pct: usize) -> f64 {
    sorted[(sorted.len() * pct / 100).min(sorted.len() - 1)]
}

fn sorted(mut times: Vec<f64>) -> Vec<f64> {
    times.sort_by(f64::total_cmp);
    times
}

struct Subject<'a> {
    label: &'static str,
    session: &'a LiveSession,
    base: FullChainInputs<'static>,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("RAW path");
    let edge: u32 = args.next().map_or(1920, |e| e.parse().expect("edge"));
    let ticks: usize = args.next().map_or(120, |t| t.parse().expect("ticks"));
    let raw = raw_core::decode::decode(Path::new(&path))?;
    let prefix = AdjustmentModel {
        profile: Profile::Neutral,
        auto_exposure: AutoExposureMode::Off,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        ..Default::default()
    };
    let scene = pipeline::develop_scene_linear_sized_from_raw_with_quality(
        &raw,
        &prefix,
        RenderQuality::Preview,
        edge,
    )?;
    let anchor = scene.whites_anchor_ev.expect("decoded RAW scene anchor");
    let rgba: Vec<f32> = scene
        .pixels
        .iter()
        .flat_map(|p| [p[0], p[1], p[2], 1.0])
        .collect();
    let capture = pipeline::render_capture_sized_sensor_framed_f32(
        &raw,
        &prefix,
        RenderQuality::Preview,
        edge,
        raw_core::CancelToken::never(),
    )?;
    let tables = pipeline::intern_creative_tables(capture.tables.floats());
    let ctx = GpuContext::new_blocking()?;
    let session = LiveSession::new(&ctx, &rgba, scene.width, scene.height)?;
    let capture_session = LiveSession::new(&ctx, &capture.rgba, capture.width, capture.height)?;
    let cancel = CancelToken::new();
    let engaged_model = AdjustmentModel {
        nr_luminance: 40.0,
        nr_color: 50.0,
        clarity: 30.0,
        texture: 25.0,
        dehaze: 20.0,
        sharpen_amount: 60.0,
        ..Default::default()
    };
    let noise = raw.noise_profile.clone().unwrap_or_default();
    let scene_inputs = |model: &AdjustmentModel| {
        inputs(
            model,
            anchor,
            scene.nr_sampling_scale,
            noise.clone(),
            raw.iso,
        )
    };
    let plan = capture
        .creative
        .gpu_plan(tables, capture.creative.tick(&engaged_model))?;
    let creative_base = FullChainInputs {
        creative: Some(creative_inputs(&plan)),
        whites_anchor_ev: capture.whites_anchor_ev,
        nr_sampling_scale: capture.nr_sampling_scale,
        ..scene_inputs(&engaged_model)
    };
    let subjects = [
        Subject {
            label: "default",
            session: &session,
            base: scene_inputs(&AdjustmentModel::default()),
        },
        Subject {
            label: "engaged",
            session: &session,
            base: scene_inputs(&engaged_model),
        },
        Subject {
            label: "engaged_creative",
            session: &capture_session,
            base: creative_base,
        },
    ];
    println!(
        "image={}x{} ticks_per_drag={ticks} adapter={:?}",
        scene.width,
        scene.height,
        ctx.adapter.get_info().backend
    );
    let clone = |base: &FullChainInputs<'static>| FullChainInputs {
        tone_curves: base.tone_curves.clone(),
        profile_curve_flat: base.profile_curve_flat.clone(),
        residual_lut_data: base.residual_lut_data.clone(),
        noise_profile: base.noise_profile.clone(),
        film_lut_data: base.film_lut_data.clone(),
        display_tone_curves: base.display_tone_curves.clone(),
        local_adjustments: base.local_adjustments.clone(),
        mask_rasters: Vec::new(),
        color_curves: base.color_curves.clone(),
        ..*base
    };
    let timed = |session: &LiveSession, current: &FullChainInputs<'_>| {
        let start = Instant::now();
        session
            .render_chain_to_f32(&ctx, current, &cancel)
            .expect("render ok")
            .expect("rendered");
        ctx.device.poll(wgpu::Maintain::Wait);
        start.elapsed().as_secs_f64() * 1000.0
    };
    for subject in &subjects {
        for (name, set, [lo, hi]) in DRAGS {
            let tick = |i: usize| {
                let mut current = clone(&subject.base);
                set(&mut current, lo + (hi - lo) * (i % 30) as f32 / 29.0);
                timed(subject.session, &current)
            };
            (0..10).for_each(|i| {
                tick(i);
            });
            let warm = subject.session.pool_alloc_count(&ctx);
            let times = sorted((0..ticks).map(|i| tick(i + 1)).collect());
            println!(
                "model={} drag={name} p50_ms={:.2} p95_ms={:.2} max_ms={:.2} over_16ms={} warm_gpu_pool_allocations={}",
                subject.label,
                percentile(&times, 50),
                percentile(&times, 95),
                times[times.len() - 1],
                times.iter().filter(|t| **t > 16.0).count(),
                subject.session.pool_alloc_count(&ctx) - warm,
            );
        }
        let (exposure, first_late): (Vec<f64>, Vec<f64>) = (0..ticks)
            .map(|i| {
                let mut current = clone(&subject.base);
                current.tone[0] = -1.0 + 2.0 * (i % 30) as f32 / 29.0;
                let exposure = timed(subject.session, &current);
                current.contrast = -60.0 + 120.0 * (i % 30) as f32 / 29.0;
                (exposure, timed(subject.session, &current))
            })
            .unzip();
        let (exposure, first_late) = (sorted(exposure), sorted(first_late));
        println!(
            "model={} sequence=exposure_then_contrast exposure_p50_ms={:.2} first_late_p50_ms={:.2} first_late_p95_ms={:.2}",
            subject.label,
            percentile(&exposure, 50),
            percentile(&first_late, 50),
            percentile(&first_late, 95),
        );
    }
    let plane_bytes = session.ping_pong_buffer(0).size();
    let plane = |label| {
        ctx.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(label),
            size: plane_bytes,
            usage: wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    };
    let (source, resident) = (plane("copy-source"), plane("copy-resident"));
    let submit = |copy: bool| {
        let start = Instant::now();
        let mut encoder = ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        if copy {
            encoder.copy_buffer_to_buffer(&source, 0, &resident, 0, plane_bytes);
        }
        ctx.queue.submit(Some(encoder.finish()));
        ctx.device.poll(wgpu::Maintain::Wait);
        start.elapsed().as_secs_f64() * 1000.0
    };
    let (copies, empties): (Vec<f64>, Vec<f64>) =
        (0..ticks).map(|_| (submit(true), submit(false))).unzip();
    let (copies, empties) = (sorted(copies), sorted(empties));
    println!(
        "copy bytes={plane_bytes} copy_submit_p50_ms={:.3} empty_submit_p50_ms={:.3} net_copy_ms={:.3}",
        percentile(&copies, 50),
        percentile(&empties, 50),
        percentile(&copies, 50) - percentile(&empties, 50),
    );
    Ok(())
}
