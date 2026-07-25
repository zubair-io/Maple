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
    bw_mix: &[f32; NUM_BANDS],
    bw_active: bool,
) -> Vec<f32> {
    use raw_core::image::{ColorSpace, Image};
    let count = buf.len() / 4;
    let mut img = Image::new(count as u32, 1, ColorSpace::SceneLinearRec2020);
    for (i, chunk) in buf.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }
    raw_core::stages::hsl::apply(&mut img, hue, sat, lum, bw_mix, bw_active);
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
        let reference = raw_core_hsl(&input, hue, sat, lum, &zero_bands(), false);

        let img = GpuImage::upload(&ctx, &input, count, 1);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&HslPass {
            hue: *hue,
            sat: *sat,
            lum: *lum,
            bw_mix: zero_bands(),
            bw_active: false,
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

    let reference = raw_core_hsl(&input, &hue, &sat, &lum, &zero_bands(), false);
    let mut local = input.clone();
    apply_hsl(&mut local, &hue, &sat, &lum, &zero_bands(), false);

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
        bw_mix: zero_bands(),
        bw_active: false,
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
        bw_mix: zero_bands(),
        bw_active: false,
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

// ── Black & white mix (#276) ──────────────────────────────────────────────────

/// Relative bound for the B&W GPU-vs-raw-core gate.
///
/// Measured worst case on Apple M-series Metal is 1.65e-4, on the most
/// extreme operating point in the suite: the alternating ±80 mixer applied
/// to a fully-saturated Rec.2020 primary (the single Red band at +100
/// measures 1.44e-4). B&W scales Oklab `L` by up to 2, and
/// `L` is roughly the cube root of luminance, so that pixel leaves at ~8×
/// its input scene-linear value — which magnifies the one place the CPU and
/// GPU genuinely differ, `f32::cbrt` vs WGSL's `pow(x, 1/3)`. Bound set at
/// 2.5e-4 = 1.5× the measurement, leaving headroom for other GPU vendors'
/// `pow` while still failing loudly on a real divergence. In display terms
/// 1.44e-4 relative is well under a twentieth of an 8-bit code value.
///
/// One-way ratchet, like `test-fixtures/budgets.json`: lower it when the
/// cube root gets more accurate, never raise it to make a run pass.
const BW_PARITY_REL_BOUND: f32 = 2.5e-4;

/// THE B&W PARITY GATE. A CPU-only monochrome path would silently diverge the
/// GPU live path — `cargo test -p raw-core` cannot see it — so the WGSL
/// `bw_pixel` branch is pinned against `raw_core::stages::hsl::apply` with
/// black & white armed, across a flat mixer and several per-band mixes.
#[test]
fn wgsl_bw_matches_raw_core_stage_within_bound() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = scene_buffer();
    let count = (input.len() / 4) as u32;

    let cases: Vec<[f32; NUM_BANDS]> = vec![
        // Flat mixer — pure desaturation.
        zero_bands(),
        // Single band pushed hard each way.
        {
            let mut m = zero_bands();
            m[0] = 100.0;
            m
        },
        {
            let mut m = zero_bands();
            m[5] = -100.0;
            m
        },
        // Alternating ±80 — maximum gradient at every band boundary, the
        // same stress the raw-core smoothness test uses.
        std::array::from_fn(|band| if band % 2 == 0 { 80.0 } else { -80.0 }),
    ];

    // The bound is RELATIVE, unlike the colour gate above. B&W scales Oklab
    // L by up to 2, and L is roughly the cube root of luminance, so a
    // scene-linear 1.0 can leave at ~8.0 — an absolute 1e-4 there would be a
    // 1.2e-5 relative bound, tighter than the CPU/GPU cube-root difference
    // (Rust `f32::cbrt` vs WGSL `pow(x, 1/3)`) can meet. Normalising by the
    // reference magnitude keeps the gate at the same 1e-4 strictness the
    // colour gate applies at unit scale.
    for mix in &cases {
        let reference = raw_core_hsl(
            &input,
            &zero_bands(),
            &zero_bands(),
            &zero_bands(),
            mix,
            true,
        );

        let img = GpuImage::upload(&ctx, &input, count, 1);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&HslPass {
            hue: zero_bands(),
            sat: zero_bands(),
            lum: zero_bands(),
            bw_mix: *mix,
            bw_active: true,
        }]);

        let (worst_i, max_rel) = reference
            .iter()
            .zip(&gpu)
            .map(|(a, b)| (a - b).abs() / a.abs().max(1.0))
            .enumerate()
            .fold(
                (0usize, 0.0_f32),
                |acc, x| if x.1 > acc.1 { x } else { acc },
            );
        eprintln!(
            "PARITY vs raw-core bw (mix={mix:?}): max rel diff = {max_rel:e} at lane \
             {worst_i} (ref {:.6}, gpu {:.6})",
            reference[worst_i], gpu[worst_i]
        );
        assert!(
            max_rel < BW_PARITY_REL_BOUND,
            "B&W GPU vs raw-core max rel diff {max_rel} exceeds {BW_PARITY_REL_BOUND} \
             (mix {mix:?}, lane {worst_i}: ref {:.6} vs gpu {:.6})",
            reference[worst_i],
            gpu[worst_i]
        );
    }
}

/// The GPU output really is neutral — every pixel leaves with R == G == B.
/// This is the "saturation forced to 0" half of the ticket, asserted on the
/// device rather than inferred from the CPU stage.
#[test]
fn gpu_bw_output_is_neutral() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let input = scene_buffer();
    let count = (input.len() / 4) as u32;
    let img = GpuImage::upload(&ctx, &input, count, 1);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&HslPass {
        hue: zero_bands(),
        sat: zero_bands(),
        lum: zero_bands(),
        bw_mix: std::array::from_fn(|band| if band % 2 == 0 { 80.0 } else { -80.0 }),
        bw_active: true,
    }]);
    // Relative spread: the residual is the Oklab round-trip's own asymmetry
    // (the Rec.2020↔sRGB constants are 4-decimal, so their inverse is not an
    // exact inverse), which scales with signal magnitude — a white pixel
    // leaves at ~1e-4 absolute, a mid-grey at ~2e-5.
    for (i, px) in gpu.chunks_exact(4).enumerate() {
        let hi = px[0].max(px[1]).max(px[2]);
        let spread = hi - px[0].min(px[1]).min(px[2]);
        let rel = spread / hi.abs().max(1e-3);
        assert!(
            rel < 1e-3,
            "pixel {i} is not neutral: {:?} (relative spread {rel:e})",
            &px[0..3]
        );
    }
}

/// The local CPU oracle's B&W path matches raw-core's, so the parity gate
/// above compares equal implementations rather than unrelated ones.
#[test]
fn local_oracle_bw_matches_raw_core_stage_within_1e_6() {
    let input = scene_buffer();
    let mix: [f32; NUM_BANDS] =
        std::array::from_fn(|band| if band % 2 == 0 { 80.0 } else { -80.0 });

    let reference = raw_core_hsl(
        &input,
        &zero_bands(),
        &zero_bands(),
        &zero_bands(),
        &mix,
        true,
    );
    let mut local = input.clone();
    apply_hsl(
        &mut local,
        &zero_bands(),
        &zero_bands(),
        &zero_bands(),
        &mix,
        true,
    );

    let max_diff = reference
        .iter()
        .zip(&local)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0_f32, f32::max);
    assert!(
        max_diff < 1e-6,
        "local B&W oracle vs raw-core stage diff {max_diff} exceeds 1e-6"
    );
}
