//! Headless parity tests for the scene-tone-controls DAG (#925 / #990 /
//! #1103) — GPU vs `raw_core::stages::scene_tone_controls::apply` (the REAL
//! stage via the dev-dep), plus oracle pins. Split out of the host module
//! for the 600-LOC budget (mirrors clarity's `tests.rs`).

use super::*;
use crate::chain::ChainRunner;
use crate::image::GpuImage;
use raw_core::AdjustmentModel;

/// The 1-D strip from the pre-#1103 tests — still exercises every point
/// branch: deep shadow, midtone, upper-mid, near-white, HDR headroom,
/// colored shadow, tiny-negative channel, saturated warm midtone.
fn tone_buffer() -> Vec<f32> {
    vec![
        // r,    g,    b,    a
        0.01, 0.01, 0.01, 1.0, // deep shadow → shadows lift + blacks toe
        0.18, 0.18, 0.18, 0.7, // midtone (whites/blacks weight ~0)
        0.50, 0.50, 0.50, 1.0, // upper-mid (whites smoothstep ramps in)
        0.95, 0.95, 0.95, 1.0, // near diffuse white
        3.00, 2.00, 1.20, 1.0, // HDR headroom → highlights above-knee branch
        0.04, 0.30, 0.50, 0.5, // colored shadow (luma-coupled scale, hue test)
        -0.01, 0.06, 0.02, 1.0, // tiny-negative channel
        0.70, 0.20, 0.10, 1.0, // saturated warm midtone
    ]
}

/// A 16×8 2-D image for the #1103 masked S/H steps: a horizontal luma
/// gradient, a hard dark/bright step edge, an HDR strip, and a checkerboard
/// texture patch — so the blurred-luma plane (and therefore the regional/
/// per-pixel mix and the shrinking-window blur borders) is exercised
/// non-vacuously in BOTH axes.
fn tone_image_2d() -> (Vec<f32>, u32, u32) {
    let (w, h) = (16u32, 8u32);
    let mut buf = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            let v = match y {
                0 | 1 => 0.02 + 0.96 * (x as f32) / 15.0, // gradient rows
                2 | 3 => {
                    if x < 8 {
                        0.015
                    } else {
                        0.85
                    }
                } // hard step edge
                4 => 0.6 + 0.2 * (x as f32) / 15.0 + 1.6 * ((x >= 12) as u32 as f32), // HDR strip
                5 => {
                    if (x + y) % 2 == 0 {
                        0.05
                    } else {
                        0.09
                    }
                } // shadow texture patch
                _ => 0.18 + 0.04 * ((x + y) % 3) as f32,  // midtone wobble
            };
            // A couple of colored pixels so hue handling rides along.
            if y == 6 && x == 3 {
                buf.extend_from_slice(&[0.30, 0.10, 0.05, 1.0]);
            } else if y == 7 && x == 12 {
                buf.extend_from_slice(&[1.8, 1.2, 0.4, 1.0]);
            } else {
                buf.extend_from_slice(&[v, v, v, 1.0]);
            }
        }
    }
    (buf, w, h)
}

/// Run `raw_core::stages::scene_tone_controls::apply` on a flat interleaved
/// RGBA f32 buffer with the given slider values, returning a new buffer
/// (alpha carried through). The ticket's actual reference — the Rust stage.
fn raw_core_tone(buf: &[f32], width: u32, height: u32, options: SceneToneOptions) -> Vec<f32> {
    let SceneToneOptions {
        exposure,
        brightness,
        highlights,
        shadows,
        whites,
        blacks,
    } = options;
    use raw_core::image::{ColorSpace, Image};
    let mut img = Image::new(width, height, ColorSpace::SceneLinearRec2020);
    for (i, chunk) in buf.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }
    // Only the six tone fields are set; everything else stays at default.
    let model = AdjustmentModel {
        exposure,
        brightness,
        highlights,
        shadows,
        whites,
        blacks,
        ..Default::default()
    };
    raw_core::stages::scene_tone_controls::apply(&mut img, &model);
    let mut out = Vec::with_capacity(buf.len());
    for (i, p) in img.pixels.iter().enumerate() {
        out.extend_from_slice(&[p[0], p[1], p[2], buf[i * 4 + 3]]);
    }
    out
}

/// The slider combinations under test — each deliberately drives a different
/// mix of branches (and at least one field non-zero so the stage doesn't
/// whole-image short-circuit).
/// `(exposure, brightness, highlights, shadows, whites, blacks)`.
const CASES: &[(f32, f32, f32, f32, f32, f32)] = &[
    (1.0, 0.0, 0.0, 0.0, 0.0, 0.0),           // exposure only
    (0.0, 70.0, 0.0, 0.0, 0.0, 0.0),          // brightness lift only (#1102)
    (0.0, -85.0, 0.0, 0.0, 0.0, 0.0),         // brightness darken only (#1102)
    (0.0, 0.0, 60.0, 0.0, 0.0, 0.0),          // highlights recovery only (#1103 mask)
    (0.0, 0.0, -50.0, 0.0, 0.0, 0.0),         // highlights gain at the old #1081 pole
    (0.0, 0.0, -100.0, 0.0, 0.0, 0.0),        // highlights gain at full negative
    (0.0, 0.0, 0.0, 80.0, 0.0, 0.0),          // shadows lift only (#1103 mask)
    (0.0, 0.0, 0.0, -60.0, 0.0, 0.0),         // shadows crush only (#1103 mask)
    (0.0, 0.0, 0.0, 0.0, 75.0, 0.0),          // whites gain only
    (0.0, 0.0, 0.0, 0.0, 0.0, 50.0),          // blacks lift (positive → additive)
    (0.0, 0.0, 0.0, 0.0, 0.0, -70.0),         // blacks crush (negative → multiplicative)
    (0.5, 35.0, 40.0, 30.0, 20.0, -25.0),     // everything together
    (-1.0, -45.0, -50.0, -40.0, -60.0, 90.0), // negative exposure + mixed signs
];

fn assert_parity(input: &[f32], width: u32, height: u32, ctx: &GpuContext) {
    for &(e, br, h, s, w, b) in CASES {
        let options = SceneToneOptions {
            exposure: e,
            brightness: br,
            highlights: h,
            shadows: s,
            whites: w,
            blacks: b,
        };
        let reference = raw_core_tone(input, width, height, options);

        let img = GpuImage::upload(ctx, input, width, height);
        let runner = ChainRunner::new(ctx, &img);
        let gpu = runner.run_blocking(&[&SceneToneControlsPass {
            exposure: e,
            brightness: br,
            highlights: h,
            shadows: s,
            whites: w,
            blacks: b,
        }]);

        let max_diff = reference
            .iter()
            .zip(&gpu)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        eprintln!(
            "PARITY vs raw-core scene_tone_controls {width}x{height} \
             (e={e} br={br} h={h} s={s} w={w} b={b}): max abs diff = {max_diff:e}"
        );
        assert!(
            max_diff < 1e-4,
            "{width}x{height} (e={e} br={br} h={h} s={s} w={w} b={b}): GPU vs raw-core stage \
             max abs diff {max_diff} exceeds 1e-4"
        );
    }
}

/// THE PARITY GATE (the ticket's contract): the WGSL scene-tone DAG matches
/// `raw_core::stages::scene_tone_controls::apply` within 1e-4 across slider
/// combinations exercising each step's branches — on the 1-D strip.
#[test]
fn wgsl_scene_tone_controls_matches_raw_core_stage_within_1e_4() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = tone_buffer();
    let count = (input.len() / 4) as u32;
    assert_parity(&input, count, 1, &ctx);
}

/// Same gate on a true 2-D image, where the masked S/H blur runs both axes,
/// hits shrinking-window borders, and the halo mix sees real edges and
/// texture (#1103).
#[test]
fn wgsl_scene_tone_dag_matches_raw_core_on_2d_image() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = tone_image_2d();
    assert_parity(&input, w, h, &ctx);
}

/// Pin the local CPU oracle to raw-core's stage too, so the convenience
/// oracle this crate exports can't silently drift. (The GPU gate above
/// doesn't depend on the local oracle.)
#[test]
fn local_oracle_matches_raw_core_stage_within_1e_4() {
    for (input, w, h) in [
        {
            let b = tone_buffer();
            let n = (b.len() / 4) as u32;
            (b, n, 1)
        },
        tone_image_2d(),
    ] {
        for &(e, br, hl, s, wh, b) in CASES {
            let options = SceneToneOptions {
                exposure: e,
                brightness: br,
                highlights: hl,
                shadows: s,
                whites: wh,
                blacks: b,
            };
            let reference = raw_core_tone(&input, w, h, options);
            let mut local = input.clone();
            apply_scene_tone_controls(
                &mut local,
                w as usize,
                h as usize,
                SceneToneOptions {
                    exposure: e,
                    brightness: br,
                    highlights: hl,
                    shadows: s,
                    whites: wh,
                    blacks: b,
                },
            );
            let max_diff = reference
                .iter()
                .zip(&local)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0_f32, f32::max);
            assert!(
                max_diff < 1e-4,
                "{w}x{h} (e={e} br={br} h={hl} s={s} w={wh} b={b}): local oracle vs raw-core \
                 stage diff {max_diff} exceeds 1e-4"
            );
        }
    }
}

/// Sub-threshold sliders are a bit-exact passthrough on the GPU (the
/// per-field activation guard). Pins that values below the |·| ≥ 1e-3 (or
/// 1e-6 for exposure) thresholds don't perturb pixels — the per-field
/// analogue of the Rust stage's identity short-circuit.
#[test]
fn subthreshold_sliders_are_passthrough_on_gpu() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = tone_buffer();
    let count = (input.len() / 4) as u32;
    let img = GpuImage::upload(&ctx, &input, count, 1);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&SceneToneControlsPass {
        exposure: 1e-7,
        brightness: 1e-4,
        highlights: 1e-4,
        shadows: -1e-4,
        whites: 1e-4,
        blacks: -1e-4,
    }]);
    let max_diff = input
        .iter()
        .zip(&gpu)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0_f32, f32::max);
    assert_eq!(
        max_diff, 0.0,
        "sub-threshold tone sliders must be a bit-exact passthrough"
    );
}

/// Oracle sanity, independent of the GPU: positive shadows LIFT a deep-
/// shadow pixel (the defining shadows property) while leaving a bright
/// pixel essentially untouched (the #1103 weight dies at Y ≥ 0.25).
#[test]
fn oracle_shadows_lift_deep_not_bright() {
    let mut buf = vec![0.02_f32, 0.02, 0.02, 1.0, 0.9, 0.9, 0.9, 1.0];
    apply_scene_tone_controls(
        &mut buf,
        2,
        1,
        SceneToneOptions {
            exposure: 0.0,
            brightness: 0.0,
            highlights: 0.0,
            shadows: 80.0,
            whites: 0.0,
            blacks: 0.0,
        },
    );
    assert!(buf[0] > 0.02, "deep shadow should lift, got {}", buf[0]);
    assert!(
        (buf[4] - 0.9).abs() < 1e-3,
        "bright pixel should be ~untouched by shadows, got {}",
        buf[4]
    );
}

/// Oracle sanity for brightness (#1102): positive brightness LIFTS a
/// midtone pixel while leaving a deep shadow (Y ≤ 0.05) and a
/// scene-ref-max pixel (Y ≥ 4.0) BIT-EXACTLY untouched — the band
/// weight is exactly 0 at both ends.
#[test]
fn oracle_brightness_lifts_midtone_pins_ends() {
    let mut buf = vec![
        0.03_f32, 0.03, 0.03, 1.0, // deep shadow — pinned
        0.18, 0.18, 0.18, 1.0, // midtone — lifted
        5.0, 5.0, 5.0, 1.0, // scene-ref-max — pinned
    ];
    apply_scene_tone_controls(
        &mut buf,
        3,
        1,
        SceneToneOptions {
            exposure: 0.0,
            brightness: 100.0,
            highlights: 0.0,
            shadows: 0.0,
            whites: 0.0,
            blacks: 0.0,
        },
    );
    assert_eq!(
        buf[0], 0.03,
        "deep shadow must be bit-exact, got {}",
        buf[0]
    );
    assert!(buf[4] > 0.18, "midtone should lift, got {}", buf[4]);
    assert_eq!(
        buf[8], 5.0,
        "scene-ref-max must be bit-exact, got {}",
        buf[8]
    );
}
