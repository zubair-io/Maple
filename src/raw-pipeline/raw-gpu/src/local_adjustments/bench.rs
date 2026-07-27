//! Slider-tick timing for the local-adjustments kernel (#1698).
//!
//! Not a CI gate — a measurement tool, and `#[ignore]`d for that reason: wall
//! times are machine-dependent, and a red timing test on somebody's laptop
//! would be noise rather than signal. Run it deliberately:
//!
//! ```text
//! cargo test -p raw-gpu --lib local_adjustments::bench -- --ignored --nocapture
//! ```
//!
//! What it measures is the LIVE TICK: a whole gated chain through
//! [`crate::LiveSession::render_chain_to_f32`], the same call the Apple and web
//! present paths make on every slider movement, at three sizes and with the
//! local-adjustment stack empty vs. loaded. Reporting the pair is the point —
//! the marginal number is what the stage costs, and it is what the 16 ms target
//! and the 50 ms hard limit apply to.
//!
//! The first two sizes are what a tick on a 100 MP frame actually renders: the
//! live path draws the VIEWPORT, not the sensor, so a 100 MP RAW fitted to a
//! 4K display ticks at ~8 MP and a smaller preview at ~2 MP. The third size is
//! the full sensor, which belongs to the refine and export paths rather than
//! the tick budget; it is included so the stage's cost at that resolution is on
//! the record too.

use super::*;
use crate::full_chain::{FullChainInputs, InputShape};
use crate::tone_curves::{CurveMode, ToneCurveInputs};
use crate::{CancelToken, GpuContext, LiveSession};
use raw_core::types::{layers_to_flat, LocalAdjustment, Mask, PartialAdjustments, Point2};
use std::time::Instant;

/// A neutral-ish chain carrying only the stage under test, so the marginal
/// number is not buried under clarity or NLM.
fn bench_inputs(layers_flat: Vec<f32>) -> FullChainInputs {
    use raw_core::view::auto_profile;
    FullChainInputs {
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
        local_adjustments: layers_flat,
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
        target_primaries: 0,
        input_shape: InputShape::PostDcpRec2020Fp16,
        // #1714's per-pixel NR modulation inputs. Empty + ISO 0 is the flat
        // filter, which is what this bench wants — it measures the local-
        // adjustments stage, not noise reduction.
        noise_profile: Vec::new(),
        iso: 0,
    }
}

/// One layer carrying every wired control, including the temperature and tint
/// that force the per-pixel CAT16 derivation — the worst case, not the cheap
/// exposure-only one.
fn worst_case_layer() -> Vec<LocalAdjustment> {
    vec![LocalAdjustment {
        mask: Mask::Linear {
            start: Point2::new(0.1, 0.15),
            end: Point2::new(0.9, 0.85),
            feather: 0.6,
        },
        adjustments: PartialAdjustments {
            exposure: Some(0.6),
            contrast: Some(25.0),
            highlights: Some(-40.0),
            shadows: Some(30.0),
            whites: Some(15.0),
            blacks: Some(-20.0),
            saturation: Some(35.0),
            vibrance: Some(25.0),
            temperature: Some(1200.0),
            tint: Some(8.0),
        },
    }]
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

/// Median wall time of `runs` ticks at `(w, h)` with the given layer stack.
fn tick_ms(ctx: &GpuContext, w: u32, h: u32, layers: &[LocalAdjustment], runs: usize) -> f64 {
    let mut rgba = Vec::with_capacity((w * h) as usize * 4);
    for i in 0..(w * h) as usize {
        let t = i as f32 / ((w * h) as f32 - 1.0);
        rgba.extend_from_slice(&[t * 1.4, t * 0.9 + 0.1, t * 0.5 + 0.2, 1.0]);
    }
    let session = LiveSession::new(ctx, &rgba, w, h).expect("session");
    let inputs = bench_inputs(layers_to_flat(layers));
    let cancel = CancelToken::new();

    // Warm up: first tick compiles the pipeline and populates the frame pool.
    session
        .render_chain_to_f32(ctx, &inputs, &cancel)
        .expect("warm-up tick");
    ctx.device.poll(wgpu::Maintain::Wait);

    // `render_chain_to_f32` leaves the result resident and does NOT read back —
    // that is the whole point of the present path — so it returns as soon as the
    // command buffer is SUBMITTED. Timing it alone measures encode cost and
    // reports sub-millisecond nonsense (including negative marginals). Block on
    // the device after each tick so the number is the GPU's execution time.
    let times: Vec<f64> = (0..runs)
        .map(|_| {
            let t0 = Instant::now();
            session
                .render_chain_to_f32(ctx, &inputs, &cancel)
                .expect("tick");
            ctx.device.poll(wgpu::Maintain::Wait);
            t0.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    median(times)
}

#[test]
#[ignore = "timing measurement, not a gate — machine-dependent wall times"]
fn slider_tick_timing() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let layers = worst_case_layer();
    let runs = 25;

    for &(label, w, h) in &[
        ("2 MP viewport", 1732u32, 1155u32),
        ("8.3 MP fit-zoom (4K)", 3840, 2160),
        ("100 MP full sensor", 12248, 8165),
    ] {
        let empty = tick_ms(&ctx, w, h, &[], runs);
        let loaded = tick_ms(&ctx, w, h, &layers, runs);
        println!(
            "TICK [{label}] {w}x{h}: chain without local adjustments {empty:.3} ms, \
             with one all-controls layer {loaded:.3} ms, marginal {:.3} ms",
            loaded - empty
        );
    }
}
