//! CPU↔WGSL parity for the gamut-preserving Auto P3 pair (#4741): the GPU
//! `split → srgb_gamma → residual LUT → restore` chain against
//! `raw_core::view::encode::rec2020_to_p3_auto_encoded` with the same lattice.

use super::*;
use crate::chain::ChainRunner;
use crate::image::GpuImage;
use crate::residual_lut::ResidualLutPass;
use crate::srgb_gamma::SrgbGammaPass;
use raw_core::image::{ColorSpace, Image};
use raw_core::view::auto_profile::{apply::prepared_tail, lut::ColorLut};

const TOLERANCE: f32 = 1e-4;

fn scene() -> Vec<f32> {
    let mut buf = vec![
        0.18, 0.18, 0.18, 1.0, 0.40, 0.30, 0.20, 0.7, 0.05, 0.05, 0.05, 1.0, 0.70, 0.12, 0.12, 1.0,
        0.12, 0.55, 0.18, 1.0, 0.20, 0.20, 0.62, 0.9, 1.00, 0.00, 0.00, 1.0, 0.00, 1.00, 0.00, 1.0,
        0.00, 0.00, 1.00, 0.5, 0.90, 0.05, 0.85, 1.0, 2.00, 1.50, 0.50, 1.0,
    ];
    for hue in (0..360).step_by(20) {
        let (sin_h, cos_h) = (hue as f32).to_radians().sin_cos();
        for l in [0.3, 0.5, 0.7, 0.85] {
            for step in 0..24 {
                let c = 0.012 * step as f32;
                let rgb = raw_core::color::oklab::oklab_to_rec2020([l, c * cos_h, c * sin_h]);
                if rgb.iter().all(|v| *v >= 0.0) {
                    buf.extend_from_slice(&[rgb[0], rgb[1], rgb[2], 1.0]);
                }
            }
        }
    }
    buf
}

fn tinted_lut() -> ColorLut {
    let mut lut = ColorLut::identity(9);
    for (i, lane) in lut.data.iter_mut().enumerate() {
        let wobble = [0.04, -0.03, 0.02][i % 3] * (1.0 + ((i / 3) % 5) as f32 * 0.2);
        *lane = (*lane + wobble).clamp(0.0, 1.0);
    }
    lut
}

fn cpu_reference(input: &[f32], lut: &ColorLut) -> Vec<f32> {
    let mut img = Image::new(
        (input.len() / 4) as u32,
        1,
        ColorSpace::DisplayLinearRec2020,
    );
    for (p, chunk) in img.pixels.iter_mut().zip(input.chunks_exact(4)) {
        *p = [chunk[0], chunk[1], chunk[2]];
    }
    let tail = prepared_tail(None, Some((lut.size, &lut.data)), 1.0);
    raw_core::view::encode::rec2020_to_p3_auto_encoded(&mut img, tail);
    img.pixels
        .iter()
        .zip(input.chunks_exact(4))
        .flat_map(|(p, src)| [p[0], p[1], p[2], src[3]])
        .collect()
}

fn gpu_chain(input: &[f32], lut: &ColorLut) -> Vec<f32> {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let img = GpuImage::upload(&ctx, input, (input.len() / 4) as u32, 1);
    let (split, restore) = p3_auto_passes(HeadroomPlane::default());
    let lut_pass = ResidualLutPass {
        size: lut.size,
        data: lut.data.as_slice().into(),
    };
    ChainRunner::new(&ctx, &img).run_blocking(&[&split, &SrgbGammaPass, &lut_pass, &restore])
}

fn max_diff(a: &[f32], b: &[f32]) -> f32 {
    a.iter()
        .zip(b)
        .map(|(x, y)| (x - y).abs())
        .fold(0.0, f32::max)
}

#[test]
fn p3_auto_chain_matches_the_cpu_reference_and_keeps_alpha() {
    let input = scene();
    let lut = tinted_lut();
    let gpu = gpu_chain(&input, &lut);
    let cpu = cpu_reference(&input, &lut);
    let diff = max_diff(&gpu, &cpu);
    eprintln!("PARITY p3 auto: max abs diff = {diff:e}");
    assert!(diff < TOLERANCE, "GPU vs CPU max abs diff {diff}");
    for (g, src) in gpu.chunks_exact(4).zip(input.chunks_exact(4)) {
        assert_eq!(g[3].to_bits(), src[3].to_bits(), "alpha must pass through");
    }
}

#[test]
fn identity_lattice_stays_on_neutral_p3() {
    let input = scene();
    let gpu = gpu_chain(&input, &ColorLut::identity(9));
    let ctx_free_neutral: Vec<f32> = {
        let mut img = Image::new(
            (input.len() / 4) as u32,
            1,
            ColorSpace::DisplayLinearRec2020,
        );
        for (p, chunk) in img.pixels.iter_mut().zip(input.chunks_exact(4)) {
            *p = [chunk[0], chunk[1], chunk[2]];
        }
        raw_core::view::encode::rec2020_to_display(
            &mut img,
            raw_core::view::encode::TargetPrimaries::P3,
        );
        raw_core::view::encode::srgb_gamma_encode(&mut img);
        img.pixels
            .iter()
            .zip(input.chunks_exact(4))
            .flat_map(|(p, src)| [p[0], p[1], p[2], src[3]])
            .collect()
    };
    let diff = max_diff(&gpu, &ctx_free_neutral);
    eprintln!("identity lattice vs Neutral P3: max abs diff = {diff:e}");
    assert!(
        diff < 5e-3,
        "identity lattice drifted from Neutral P3 by {diff}"
    );
}

/// Slider-tick cost of the P3 Auto pair (#4741): the GPU time of the whole view
/// tail on a 12 MP frame, P3 Auto against the sRGB tail it replaces. Ignored by
/// default (timing); run with `--ignored --nocapture`.
#[test]
#[ignore = "timing probe; run on demand"]
fn p3_auto_tail_cost_against_the_srgb_tail() {
    use crate::display_encode::DisplayEncodePass;
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (4000u32, 3000u32);
    let pixels: Vec<f32> = (0..(w * h) as usize)
        .flat_map(|i| {
            let t = (i % 4000) as f32 / 4000.0;
            [
                t * 0.9,
                (1.0 - t) * 0.6,
                0.1 + 0.4 * ((i / 4000) % 7) as f32 / 7.0,
                1.0,
            ]
        })
        .collect();
    let img = GpuImage::upload(&ctx, &pixels, w, h);
    let make = |label: &str| {
        ctx.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(label),
            size: img.byte_len(),
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_SRC
                | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    };
    let (ping, pong) = (make("ping"), make("pong"));
    let lut = tinted_lut();
    let lut_pass = ResidualLutPass {
        size: lut.size,
        data: lut.data.as_slice().into(),
    };
    let median_ms = |passes: &[&dyn Pass]| {
        let mut samples: Vec<f64> = (0..15)
            .map(|_| {
                let mut encoder = ctx.device.create_command_encoder(&Default::default());
                encoder.copy_buffer_to_buffer(&img.buffer, 0, &ping, 0, img.byte_len());
                for (i, pass) in passes.iter().enumerate() {
                    let (src, dst) = if i % 2 == 0 {
                        (&ping, &pong)
                    } else {
                        (&pong, &ping)
                    };
                    pass.encode(&ctx, &mut encoder, src, dst, (w, h));
                }
                let start = std::time::Instant::now();
                ctx.queue.submit([encoder.finish()]);
                ctx.device.poll(wgpu::Maintain::Wait);
                start.elapsed().as_secs_f64() * 1e3
            })
            .collect();
        samples.sort_by(f64::total_cmp);
        samples[samples.len() / 2]
    };
    let (split, restore) = p3_auto_passes(HeadroomPlane::default());
    let srgb = median_ms(&[
        &DisplayEncodePass {
            target_primaries: 0,
        },
        &SrgbGammaPass,
        &lut_pass,
    ]);
    let p3_plain = median_ms(&[
        &DisplayEncodePass {
            target_primaries: 1,
        },
        &SrgbGammaPass,
        &lut_pass,
    ]);
    let p3_auto = median_ms(&[&split, &SrgbGammaPass, &lut_pass, &restore]);
    eprintln!(
        "12MP view tail GPU ms: sRGB {srgb:.2}  P3 plain {p3_plain:.2}  P3 Auto {p3_auto:.2}"
    );
}
