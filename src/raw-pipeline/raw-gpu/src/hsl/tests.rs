//! Parity tests for the HSL WGSL kernel (#1112).
//!
//! Split out of `hsl.rs` (600-LOC budget; mirrors split_tone's pattern).
//! Included via `#[path = "hsl/tests.rs"] mod tests;`.

use super::*;
use crate::chain::ChainRunner;
use crate::image::GpuImage;

/// A SCENE-LINEAR test buffer covering neutrals (various L values, C=0),
/// primary colors, and off-axis mixed colors — the full range the HSL stage
/// can influence. All pixels are in Rec.2020 linear space.
fn scene_buffer() -> Vec<f32> {
    vec![
        // r,    g,    b,    a     — description
        0.18, 0.18, 0.18, 1.0, // neutral mid grey (C=0 → unchanged by any slider)
        0.01, 0.01, 0.01, 1.0, // near-black neutral
        1.00, 1.00, 1.00, 1.0, // white neutral
        // Saturated primaries (Rec.2020 scene linear)
        1.00, 0.00, 0.00, 1.0, // saturated red
        0.00, 1.00, 0.00, 1.0, // saturated green
        0.00, 0.00, 1.00, 1.0, // saturated blue
        // Off-axis colours
        0.80, 0.40, 0.10, 1.0, // warm orange-ish
        0.10, 0.50, 0.80, 1.0, // cool blue-ish
        0.50, 0.80, 0.30, 1.0, // yellow-green
        0.60, 0.10, 0.60, 1.0, // magenta-purple
    ]
}

fn zero_bands() -> [f32; NUM_BANDS] {
    [0.0; NUM_BANDS]
}

/// Run `raw_core::stages::hsl::apply` (the reference implementation).
fn raw_core_hsl(
    buf: &[f32],
    hue: &[f32; NUM_BANDS],
    sat: &[f32; NUM_BANDS],
    lum: &[f32; NUM_BANDS],
) -> Vec<f32> {
    use raw_core::image::{ColorSpace, Image};
    let count = buf.len() / 4;
    let mut img = Image::new(count as u32, 1, ColorSpace::SceneLinearRec2020);
    for (i, chunk) in buf.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }
    raw_core::stages::hsl::apply(&mut img, hue, sat, lum);
    let mut out = Vec::with_capacity(buf.len());
    for (i, p) in img.pixels.iter().enumerate() {
        out.extend_from_slice(&[p[0], p[1], p[2], buf[i * 4 + 3]]);
    }
    out
}

/// THE PARITY GATE: the WGSL HSL kernel matches `raw_core::stages::hsl::apply`
/// within 1e-4 across representative slider combinations.
#[test]
fn wgsl_hsl_matches_raw_core_stage_within_1e_4() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = scene_buffer();
    let count = (input.len() / 4) as u32;

    // Test cases: (hue_band_idx, hue_val, sat_band_idx, sat_val, lum_band_idx, lum_val)
    let cases: Vec<([f32; NUM_BANDS], [f32; NUM_BANDS], [f32; NUM_BANDS])> = vec![
        // Hue rotation on Red band only
        (
            {
                let mut h = zero_bands();
                h[0] = 50.0;
                h
            },
            zero_bands(),
            zero_bands(),
        ),
        // Sat boost on all bands
        (zero_bands(), [100.0; NUM_BANDS], zero_bands()),
        // Sat cut on Orange band
        (
            zero_bands(),
            {
                let mut s = zero_bands();
                s[1] = -50.0;
                s
            },
            zero_bands(),
        ),
        // Lum on Green band
        (zero_bands(), zero_bands(), {
            let mut l = zero_bands();
            l[3] = 40.0;
            l
        }),
        // Combined: hue + sat + lum on different bands
        (
            {
                let mut h = zero_bands();
                h[0] = -50.0;
                h
            },
            {
                let mut s = zero_bands();
                s[4] = 60.0;
                s
            },
            {
                let mut l = zero_bands();
                l[2] = -40.0;
                l
            },
        ),
        // Engaged-sweep evidence cases (spec requirement):
        // orange hue -50
        (
            {
                let mut h = zero_bands();
                h[1] = -50.0;
                h
            },
            zero_bands(),
            zero_bands(),
        ),
        // blue sat +60
        (
            zero_bands(),
            {
                let mut s = zero_bands();
                s[5] = 60.0;
                s
            },
            zero_bands(),
        ),
        // green lum -40
        (zero_bands(), zero_bands(), {
            let mut l = zero_bands();
            l[3] = -40.0;
            l
        }),
    ];

    for (hue, sat, lum) in &cases {
        let reference = raw_core_hsl(&input, hue, sat, lum);

        let img = GpuImage::upload(&ctx, &input, count, 1);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&HslPass {
            hue: *hue,
            sat: *sat,
            lum: *lum,
        }]);

        let max_diff = reference
            .iter()
            .zip(&gpu)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        eprintln!(
            "PARITY vs raw-core hsl (hue[0]={:.0} sat[4]={:.0} lum[2]={:.0}): \
             max abs diff = {max_diff:e}",
            hue[0], sat[4], lum[2],
        );
        assert!(
            max_diff < 1e-4,
            "HSL GPU vs raw-core max abs diff {max_diff} exceeds 1e-4"
        );
    }
}

/// Pin the local CPU oracle to raw-core's stage within float noise.
#[test]
fn local_oracle_matches_raw_core_stage_within_1e_6() {
    let input = scene_buffer();
    let mut sat = zero_bands();
    sat[0] = 100.0;
    sat[4] = -50.0;
    let mut hue = zero_bands();
    hue[1] = 30.0;
    let mut lum = zero_bands();
    lum[3] = -40.0;

    let reference = raw_core_hsl(&input, &hue, &sat, &lum);
    let mut local = input.clone();
    apply_hsl(&mut local, &hue, &sat, &lum);

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

/// Neutral pixels must pass through unchanged even with aggressive sliders.
#[test]
fn gpu_hsl_neutral_is_bit_exact() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    // All-neutral buffer
    let input: Vec<f32> = vec![
        0.18, 0.18, 0.18, 1.0, 0.01, 0.01, 0.01, 1.0, 0.50, 0.50, 0.50, 1.0,
    ];
    let count = (input.len() / 4) as u32;
    let img = GpuImage::upload(&ctx, &input, count, 1);
    let runner = ChainRunner::new(&ctx, &img);
    // All-sat-100 + all-hue-100 on all bands — most aggressive possible
    let gpu = runner.run_blocking(&[&HslPass {
        hue: [100.0; NUM_BANDS],
        sat: [100.0; NUM_BANDS],
        lum: [100.0; NUM_BANDS],
    }]);
    for (i, (before, after)) in input.chunks_exact(4).zip(gpu.chunks_exact(4)).enumerate() {
        for c in 0..3 {
            // Neutral pixels take the `c < c0` branch in the WGSL and return the
            // input rgba unchanged — the output must be bit-identical, not merely close.
            assert_eq!(
                before[c], after[c],
                "neutral pixel {i} channel {c}: {:.6} → {:.6}",
                before[c], after[c],
            );
        }
        assert_eq!(before[3], after[3], "alpha must pass through");
    }
}

/// All-default sliders pass through bit-exactly (the is_noop early return).
#[test]
fn all_defaults_passes_through() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = scene_buffer();
    let count = (input.len() / 4) as u32;
    let img = GpuImage::upload(&ctx, &input, count, 1);
    let runner = ChainRunner::new(&ctx, &img);
    // NOTE: HslPass::is_noop() → true, but the chain always calls encode()
    // since the live chain gates pass inclusion. Encoding with all-zero params
    // should leave the buffer unchanged within float precision.
    let gpu = runner.run_blocking(&[&HslPass {
        hue: zero_bands(),
        sat: zero_bands(),
        lum: zero_bands(),
    }]);
    // The WGSL returns rgb unchanged for C < C0 (neutrals), and applies zero
    // deltas for chromatic pixels → output should match input within float noise.
    for (i, (a, b)) in input.iter().zip(&gpu).enumerate() {
        assert!(
            (a - b).abs() < 1e-5,
            "all-defaults pixel {i}: {a:.6} → {b:.6}"
        );
    }
}
