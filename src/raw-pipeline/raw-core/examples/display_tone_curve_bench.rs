//! Slider-tick cost measurement for `stages::display_tone_curve` (#2232) —
//! the CLAUDE.md 16ms-tick / 50ms-hard-limit budget this ticket's PR body
//! must report a before/after number against.
//!
//! Measures `apply_scene_linear_chain_f32` (the per-tick CPU chain that now
//! carries the new stage) at the live-tick VIEWPORT size the codebase's own
//! `tick-tail-bench` example uses, three ways:
//!   1. identity model (no display curve authored) — the "before" case:
//!      the stage's own `is_identity` gate means this should cost the same
//!      as the pre-#2232 chain, within noise.
//!   2. one non-identity `display_tone_curve_luma` curve authored — the
//!      typical single-curve edit.
//!   3. all four display curves authored (master + R + G + B) — the
//!      worst-case four-curve-composition cost.
//!
//! Usage:
//!   cargo run --release -p raw-core --example display_tone_curve_bench

use raw_core::pipeline::{apply_scene_linear_chain_f32, ChainOptions};
use raw_core::types::adjustment::ToneCurve;
use raw_core::types::AdjustmentModel;
use std::time::Instant;

/// The live tick's actual buffer size — matches `tick-tail-bench`'s
/// `VIEWPORT` const and the chain module's own docs (roughly 2 MP: an
/// 100 MP sensor fitted to a 4K viewport).
const VIEWPORT: (u32, u32) = (1728, 1152);
const RUNS: usize = 25;

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn time_ms(runs: usize, mut f: impl FnMut()) -> f64 {
    median(
        (0..runs)
            .map(|_| {
                let t = Instant::now();
                f();
                t.elapsed().as_secs_f64() * 1000.0
            })
            .collect(),
    )
}

/// Deterministic scene-linear f32 RGBA with real detail (not degenerate flat
/// input) so no stage short-circuits on a trivial buffer.
fn f32_input(w: u32, h: u32) -> Vec<f32> {
    let n = (w as usize) * (h as usize);
    (0..n)
        .flat_map(|i| {
            let x = (i % w as usize) as f32;
            let y = (i / w as usize) as f32;
            let r = 0.05 + 0.3 * (x * 0.01).sin().abs();
            let g = 0.05 + 0.3 * (y * 0.013).cos().abs();
            let b = 0.05 + 0.3 * ((x + y) * 0.007).sin().abs();
            [r, g, b, 1.0]
        })
        .collect()
}

fn s_curve() -> ToneCurve {
    ToneCurve::new(vec![
        (0.0, 0.0),
        (0.25, 0.18),
        (0.5, 0.5),
        (0.75, 0.82),
        (1.0, 1.0),
    ])
}

fn main() {
    let (w, h) = VIEWPORT;
    let input = f32_input(w, h);
    let opts = ChainOptions::default();

    let identity_model = AdjustmentModel::default();
    let one_curve_model = AdjustmentModel {
        display_tone_curve_luma: s_curve(),
        ..Default::default()
    };
    let four_curve_model = AdjustmentModel {
        display_tone_curve_luma: s_curve(),
        display_tone_curve_red: s_curve(),
        display_tone_curve_green: s_curve(),
        display_tone_curve_blue: s_curve(),
        ..Default::default()
    };

    let run = |model: &AdjustmentModel| {
        time_ms(RUNS, || {
            let out = apply_scene_linear_chain_f32(&input, w, h, model, &opts)
                .expect("chain should not error on a well-formed buffer");
            std::hint::black_box(&out);
        })
    };

    let identity_ms = run(&identity_model);
    let one_curve_ms = run(&one_curve_model);
    let four_curve_ms = run(&four_curve_model);

    println!("display_tone_curve tick-cost bench — VIEWPORT {w}x{h}, median of {RUNS} runs");
    println!("  identity (no display curve, pre-#2232 baseline shape): {identity_ms:.3} ms");
    println!("  one curve authored (display_tone_curve_luma):         {one_curve_ms:.3} ms");
    println!("  four curves authored (master + R + G + B):            {four_curve_ms:.3} ms");
    println!(
        "  added cost, one curve:  {:+.3} ms",
        one_curve_ms - identity_ms
    );
    println!(
        "  added cost, four curves: {:+.3} ms",
        four_curve_ms - identity_ms
    );
}
