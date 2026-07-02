//! Parity tests for the split-tone WGSL kernel (#1111).
//!
//! Split out of `split_tone.rs` (600-LOC budget; mirrors saturation's
//! split). Included via `#[path = "split_tone/tests.rs"] mod tests;`.

use super::*;
use crate::chain::ChainRunner;
use crate::image::GpuImage;

/// A DISPLAY-LINEAR test buffer ([0, 1] post-AgX domain) spanning the
/// luminance axis (the crossover) plus colored pixels (the tint composes
/// with existing chroma) and the Yd-clamp edges.
fn display_buffer() -> Vec<f32> {
    vec![
        // r,   g,    b,    a
        0.00, 0.00, 0.00, 1.0, // black (Yd = 0: pure shadow weight)
        0.03, 0.03, 0.03, 1.0, // deep shadow
        0.18, 0.18, 0.18, 1.0, // mid grey
        0.50, 0.50, 0.50, 0.7, // upper mid
        0.95, 0.95, 0.95, 1.0, // near white
        1.00, 1.00, 1.00, 1.0, // white (Yd = 1: pure highlight weight)
        0.62, 0.30, 0.18, 1.0, // warm colored midtone
        0.10, 0.35, 0.70, 1.0, // cool colored midtone
    ]
}

/// Run `raw_core::stages::split_tone::apply` (the ticket's reference).
fn raw_core_split_tone(buf: &[f32], hs: f32, ss: f32, hh: f32, sh: f32, bal: f32) -> Vec<f32> {
    use raw_core::image::{ColorSpace, Image};
    let count = buf.len() / 4;
    let mut img = Image::new(count as u32, 1, ColorSpace::DisplayLinearRec2020);
    for (i, chunk) in buf.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }
    raw_core::stages::split_tone::apply(&mut img, hs, ss, hh, sh, bal);
    let mut out = Vec::with_capacity(buf.len());
    for (i, p) in img.pixels.iter().enumerate() {
        out.extend_from_slice(&[p[0], p[1], p[2], buf[i * 4 + 3]]);
    }
    out
}

/// THE PARITY GATE: the WGSL split-tone kernel matches
/// `raw_core::stages::split_tone::apply` within 1e-4 across hue /
/// saturation / balance spreads (incl. the balance rails ±100 where the
/// weight exponents hit 2 / 0.5).
#[test]
fn wgsl_split_tone_matches_raw_core_stage_within_1e_4() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = display_buffer();
    let count = (input.len() / 4) as u32;

    for &(hs, ss, hh, sh, bal) in &[
        (30.0_f32, 60.0_f32, 210.0_f32, 40.0_f32, 0.0_f32),
        (30.0, 100.0, 210.0, 100.0, 100.0),
        (300.0, 45.0, 120.0, 80.0, -100.0),
        (0.0, 0.0, 45.0, 70.0, 30.0),   // highlight-only
        (200.0, 70.0, 0.0, 0.0, -40.0), // shadow-only
    ] {
        let reference = raw_core_split_tone(&input, hs, ss, hh, sh, bal);

        let img = GpuImage::upload(&ctx, &input, count, 1);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&SplitTonePass {
            shadow_hue: hs,
            shadow_sat: ss,
            highlight_hue: hh,
            highlight_sat: sh,
            balance: bal,
        }]);

        let max_diff = reference
            .iter()
            .zip(&gpu)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        eprintln!(
            "PARITY vs raw-core split_tone hs={hs} ss={ss} hh={hh} sh={sh} bal={bal}: \
             max abs diff = {max_diff:e}"
        );
        assert!(
            max_diff < 1e-4,
            "split_tone({hs},{ss},{hh},{sh},{bal}): GPU vs raw-core max abs diff \
             {max_diff} exceeds 1e-4"
        );
    }
}

/// Pin the local CPU oracle to raw-core's stage within float noise — the
/// oracle re-derives the inverse Oklab matrices per call (raw-core caches
/// them via OnceLock with the identical cofactor math), so the match is
/// near-exact rather than bit-for-bit.
#[test]
fn local_oracle_matches_raw_core_stage_within_1e_6() {
    let input = display_buffer();
    for &(hs, ss, hh, sh, bal) in &[(30.0_f32, 60.0_f32, 210.0_f32, 40.0_f32, 0.0_f32)] {
        let reference = raw_core_split_tone(&input, hs, ss, hh, sh, bal);
        let mut local = input.clone();
        apply_split_tone(&mut local, hs, ss, hh, sh, bal);
        let max_diff = reference
            .iter()
            .zip(&local)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        assert!(
            max_diff < 1e-6,
            "local oracle vs raw-core stage diff {max_diff} exceeds 1e-6"
        );
    }
}

/// L invariance survives the GPU: the tint moves only (a, b) — display
/// luminance ordering across a grey ramp is preserved and each pixel's
/// Oklab L matches the input's within float noise.
#[test]
fn gpu_split_tone_keeps_l_invariant() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = display_buffer();
    let count = (input.len() / 4) as u32;
    let img = GpuImage::upload(&ctx, &input, count, 1);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&SplitTonePass {
        shadow_hue: 30.0,
        shadow_sat: 80.0,
        highlight_hue: 250.0,
        highlight_sat: 80.0,
        balance: 20.0,
    }]);
    for (i, (before, after)) in input.chunks_exact(4).zip(gpu.chunks_exact(4)).enumerate() {
        let l_before = rec2020_to_oklab([before[0], before[1], before[2]])[0];
        let l_after = rec2020_to_oklab([after[0], after[1], after[2]])[0];
        assert!(
            (l_before - l_after).abs() < 1e-4,
            "pixel {i}: L drifted {l_before} → {l_after}"
        );
        assert_eq!(before[3], after[3], "alpha must pass through");
    }
}
