//! Slider-tick timing for Auto on a Display-P3 target (#4741). A measurement,
//! not a gate (machine-dependent wall times), so it is `#[ignore]`d:
//!
//! ```text
//! cargo test --release -p raw-gpu --lib p3_auto_slider_tick_timing -- --ignored --nocapture
//! ```
//!
//! Each tick is the whole live chain through `render_chain_to_f32`, the call
//! the Apple and web present paths make per slider movement, with an exposure
//! change per tick, blocked on the device, so the number is GPU execution plus
//! the f32 readback. The case is `mild_case` (WB, tone, vibrance, dehaze,
//! sharpen, colour NR) with a full-size 33³ (`DEFAULT_LUT_SIZE`) Auto lattice.
//! The present pass is not included.

use super::tests::mild_case;
use super::*;
use crate::full_chain::oracle::{nonidentity_lut, scene_linear_rgba};
use crate::CancelToken;
use std::time::Instant;

fn percentile(sorted: &[f64], p: usize) -> f64 {
    sorted[(sorted.len() * p / 100).min(sorted.len() - 1)]
}

fn ticks(ctx: &GpuContext, session: &LiveSession, input: &[f32], mode: &str) -> Vec<f64> {
    let cancel = CancelToken::new();
    let mut case = mild_case();
    case.lut = nonidentity_lut(raw_core::view::auto_profile::DEFAULT_LUT_SIZE);
    let mut samples: Vec<f64> = (0..32)
        .map(|tick| {
            case.model.exposure = 0.1 + 0.02 * (tick % 8) as f32;
            let mut inputs = case.gpu_inputs_for(input);
            inputs.target_primaries = u32::from(mode != "sRGB Auto");
            if mode == "P3 Neutral" {
                inputs.profile_curve_flat = Vec::new().into();
                inputs.residual_lut_size = 0;
                inputs.residual_lut_data = Vec::new().into();
            }
            assert_eq!(
                crate::p3_auto::p3_auto_is_active(&inputs),
                mode == "P3 Auto"
            );
            let started = Instant::now();
            session
                .render_chain_to_f32(ctx, &inputs, &cancel)
                .expect("tick")
                .expect("not cancelled");
            ctx.device.poll(wgpu::Maintain::Wait);
            started.elapsed().as_secs_f64() * 1e3
        })
        .skip(4)
        .collect();
    samples.sort_by(f64::total_cmp);
    samples
}

#[test]
#[ignore = "timing measurement, not a gate — machine-dependent wall times"]
fn p3_auto_slider_tick_timing() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    for (w, h) in [(1920u32, 1080u32), (3840, 2160), (4000, 3000)] {
        let input = scene_linear_rgba(w as usize, h as usize);
        let session = LiveSession::new(&ctx, &input, w, h).expect("session");
        for mode in ["sRGB Auto", "P3 Neutral", "P3 Auto"] {
            let samples = ticks(&ctx, &session, &input, mode);
            eprintln!(
                "{w}x{h} {mode:<10} tick ms p50 {:.2} p95 {:.2} max {:.2}",
                percentile(&samples, 50),
                percentile(&samples, 95),
                samples[samples.len() - 1],
            );
        }
    }
}
