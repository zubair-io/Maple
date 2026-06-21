//! Phase-0 de-risk gate (#1473): end-to-end synthetic-raw round-trip.
//!
//! Proves the central architectural claim (design doc §5/§6): a patch baked at
//! one grade, inverted to pre-user-grade scene-linear, and composited like
//! sensor data **re-grades coherently** with real sensor pixels under exposure
//! and white-balance pushes — i.e. the inverse view-transform + grade is
//! accurate enough that the patch doesn't band/shift relative to its neighbours.
//!
//! Self-contained: no ML model, no RAW fixture, no Python. The "model output"
//! is the identity (its input), so the test measures pure round-trip fidelity
//! of the inverse, propagated through re-grading.
//!
//! Metric: per-channel error in display-encoded 8-bit levels, stratified by the
//! patch's scene-linear tonal zone (shadow / midtone / highlight). The full
//! CIEDE2000 harness via `compare_images.py` is Phase-1 polish; for the gate,
//! per-channel display-level error is an honest, conservative proxy and matches
//! the "report ΔE2000 or per-channel RMSE" bar.

use crate::image::{ColorSpace, Image};
use crate::stages::white_balance;
use crate::types::WbMethod;
use crate::view::{agx, agx_inverse, encode, grade_inverse};

const W: usize = 64;
const H: usize = 64;

/// Rec.2020 luma (Y') weights for zone classification.
fn luma(p: [f32; 3]) -> f32 {
    0.2627 * p[0] + 0.6780 * p[1] + 0.0593 * p[2]
}

/// Procedural pre-grade scene-linear patch: a log luma ramp across X
/// (deep shadow → bright highlight) crossed with color bands across Y
/// (neutral / warm / cool / foliage). Stands in for "real sensor" data.
fn synthetic_patch() -> Vec<[f32; 3]> {
    let mut px = Vec::with_capacity(W * H);
    for y in 0..H {
        let band = y * 4 / H;
        let base = match band {
            0 => [1.0f32, 1.0, 1.0],
            1 => [1.3, 0.9, 0.6],
            2 => [0.7, 0.95, 1.3],
            _ => [0.8, 1.2, 0.7],
        };
        for x in 0..W {
            let t = x as f32 / (W as f32 - 1.0);
            // log ramp from deep shadow (0.005) to bright highlight (4.0).
            let l = 0.005 * (4.0f32 / 0.005).powf(t);
            px.push([l * base[0], l * base[1], l * base[2]]);
        }
    }
    px
}

/// Forward bake-preview / live path: WB → exposure → AgX → rec2020→sRGB →
/// gamma, returning display-encoded f32 in [0, 1] (creative/spatial stages off
/// by construction). `slope`/contrast fixed at 0 (slope 1.0).
fn forward_display(
    pre: &[[f32; 3]],
    t: f32,
    tint: f32,
    ev: f32,
    method: WbMethod,
) -> Vec<[f32; 3]> {
    let mut img = Image {
        width: W as u32,
        height: H as u32,
        pixels: pre.to_vec(),
        space: ColorSpace::SceneLinearRec2020,
    };
    white_balance::apply(&mut img, t, tint, method);
    let g = ev.exp2();
    for p in &mut img.pixels {
        p[0] *= g;
        p[1] *= g;
        p[2] *= g;
    }
    agx::apply(&mut img, 0.0);
    encode::rec2020_to_srgb(&mut img);
    encode::srgb_gamma_encode(&mut img);
    img.pixels
}

fn quantize(disp: &[[f32; 3]]) -> Vec<[u8; 3]> {
    disp.iter()
        .map(|p| {
            [
                (p[0] * 255.0 + 0.5).clamp(0.0, 255.0) as u8,
                (p[1] * 255.0 + 0.5).clamp(0.0, 255.0) as u8,
                (p[2] * 255.0 + 0.5).clamp(0.0, 255.0) as u8,
            ]
        })
        .collect()
}

#[test]
fn synthetic_raw_roundtrip_regrades_within_budget() {
    let orig = synthetic_patch();
    let method = WbMethod::Cat16;

    // --- Bake at G0, quantize to 8-bit (the "model input"). ---
    let (t0, tint0, ev0) = (5500.0f32, 0.0f32, 0.0f32);
    let disp0 = forward_display(&orig, t0, tint0, ev0, method);
    let u8s = quantize(&disp0);

    // --- Invert: u8 → pre-grade scene-linear (full inverse chain). ---
    let slope0 = 1.0; // contrast 0
    let mut recov = Image {
        width: W as u32,
        height: H as u32,
        pixels: u8s
            .iter()
            .map(|c| agx_inverse::display_u8_to_scene_linear(*c, slope0))
            .collect(),
        space: ColorSpace::SceneLinearRec2020,
    };
    grade_inverse::inverse_exposure(&mut recov, ev0);
    grade_inverse::inverse_white_balance(&mut recov, t0, tint0, method);
    let recovered = recov.pixels;

    // --- Push matrix: re-render recovered (candidate) vs orig (truth). ---
    let evs = [-2.0f32, 0.0, 2.0];
    let temps = [4500.0f32, 5500.0, 6500.0];

    // Per-zone accumulators: 0=shadow, 1=midtone, 2=highlight.
    let mut sum = [0.0f64; 3];
    let mut cnt = [0usize; 3];
    let mut maxe = [0.0f32; 3];
    let mut mid_errs: Vec<f32> = Vec::new();
    let mut all_finite = true;

    for &ev in &evs {
        for &t in &temps {
            let cand = forward_display(&recovered, t, tint0, ev, method);
            let truth = forward_display(&orig, t, tint0, ev, method);
            for i in 0..(W * H) {
                let zone = {
                    let l = luma(orig[i]);
                    if l < 0.05 {
                        0
                    } else if l > 1.0 {
                        2
                    } else {
                        1
                    }
                };
                for c in 0..3 {
                    let e = (cand[i][c] - truth[i][c]).abs() * 255.0;
                    if !e.is_finite() {
                        all_finite = false;
                    }
                    sum[zone] += e as f64;
                    cnt[zone] += 1;
                    maxe[zone] = maxe[zone].max(e);
                    if zone == 1 {
                        mid_errs.push(e);
                    }
                }
            }
        }
    }

    let mean = |z: usize| {
        if cnt[z] > 0 {
            sum[z] / cnt[z] as f64
        } else {
            0.0
        }
    };
    mid_errs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p95 = if mid_errs.is_empty() {
        0.0
    } else {
        mid_errs[((mid_errs.len() as f32 * 0.95) as usize).min(mid_errs.len() - 1)]
    };

    eprintln!(
        "[inpaint phase0 gate] per-channel display error in u8 levels, across 9 (EV,temp) pushes:\n  \
         shadow:    mean={:.3} max={:.2}  (n={})\n  \
         midtone:   mean={:.3} p95={:.3} max={:.2}  (n={})\n  \
         highlight: mean={:.3} max={:.2}  (n={})",
        mean(0), maxe[0], cnt[0],
        mean(1), p95, maxe[1], cnt[1],
        mean(2), maxe[2], cnt[2],
    );

    // Gate: everything finite (no banding-to-NaN); midtone tight; shadows/
    // highlights bounded (finite + not absurd) — the design's "graceful
    // degradation at the extremes" bar.
    assert!(
        all_finite,
        "non-finite re-grade error — inverse produced NaN/Inf"
    );
    assert!(
        mean(1) < 3.0,
        "midtone mean re-grade error {:.3} u8 exceeds budget 3.0",
        mean(1)
    );
    assert!(
        p95 < 6.0,
        "midtone p95 re-grade error {:.3} u8 exceeds budget 6.0",
        p95
    );
    assert!(
        maxe[2] < 64.0,
        "highlight error {:.2} u8 not bounded — shoulder inverse diverging",
        maxe[2]
    );
}
