//! Headless parity tests for the texture SPATIAL stage (epic #925 P2 wave 3b /
//! #990). Contract gate: GPU vs the REAL `raw_core::stages::texture::apply` (via
//! the test-only `raw-core` dev-dep) `< 1e-4`. Same non-vacuous edge-coverage
//! discipline as clarity, at the fine-detail radius (2) — so the border region
//! is just 2 px, and the test image varies inside it.

use super::*;
use crate::chain::ChainRunner;
use crate::image::GpuImage;

/// A 48×48 RGBA f32 image whose content varies near the borders (so the
/// shrinking-window box-blur edge handling is exercised at radius 2) and whose
/// interior gets full windows. High-frequency checkerboard ripple on a gradient
/// — texture's fine-detail scale (radius 2) responds to exactly this band — with
/// a 2-px-thick bright frame so the truncated-window border path differs from the
/// interior, plus a per-channel skew so the luma-only scale moves chroma-bearing
/// pixels.
fn border_varying_image(w: usize, h: usize) -> Vec<f32> {
    let mut v = vec![0.0f32; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let gx = x as f32 / (w - 1) as f32;
            let gy = y as f32 / (h - 1) as f32;
            // Gradient base + a high-frequency ripple (the fine-detail band).
            let ripple = 0.10 * (((x + y) % 2) as f32 - 0.5);
            let mut luma = 0.20 + 0.45 * (gx + gy) * 0.5 + ripple;
            // 2-px bright frame hugging every edge (the truncated-window region).
            if x < 2 || y < 2 || x >= w - 2 || y >= h - 2 {
                luma += 0.25;
            }
            let i = (y * w + x) * 4;
            v[i] = luma * 1.05;
            v[i + 1] = luma * 0.95;
            v[i + 2] = luma * 0.85;
            v[i + 3] = 1.0;
        }
    }
    v
}

/// Run `raw_core::stages::texture::apply` on a flat interleaved RGBA f32 buffer,
/// returning a new buffer (alpha carried through untouched). The ticket's actual
/// reference: the Rust stage itself.
fn raw_core_texture(buf: &[f32], w: u32, h: u32, texture: f32) -> Vec<f32> {
    use raw_core::image::{ColorSpace, Image};
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (i, chunk) in buf.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }
    raw_core::stages::texture::apply(&mut img, texture);
    let mut out = Vec::with_capacity(buf.len());
    for (i, p) in img.pixels.iter().enumerate() {
        out.extend_from_slice(&[p[0], p[1], p[2], buf[i * 4 + 3]]);
    }
    out
}

/// Max abs diff between two flat RGBA buffers + the worst index (reveals row/col).
fn max_diff_at(a: &[f32], b: &[f32]) -> (f32, usize) {
    let mut worst = 0.0f32;
    let mut worst_i = 0usize;
    for (i, (x, y)) in a.iter().zip(b.iter()).enumerate() {
        let d = (x - y).abs();
        if d > worst {
            worst = d;
            worst_i = i;
        }
    }
    (worst, worst_i)
}

/// THE PARITY GATE: the WGSL texture pipeline matches
/// `raw_core::stages::texture::apply` within 1e-4 across a spread of slider
/// values, on a 48×48 image whose borders carry real content. Border + interior
/// pixels are BOTH in the diff; the worst-index report confirms which region
/// drives the max.
#[test]
fn wgsl_texture_matches_raw_core_stage_within_1e_4() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (48usize, 48usize);
    let input = border_varying_image(w, h);

    for &texture in &[-100.0_f32, -50.0, 30.0, 100.0] {
        let reference = raw_core_texture(&input, w as u32, h as u32, texture);

        let img = GpuImage::upload(&ctx, &input, w as u32, h as u32);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&TexturePass { texture }]);

        let (max_diff, worst_i) = max_diff_at(&reference, &gpu);
        let px = worst_i / 4;
        let (wx, wy) = (px % w, px / w);
        eprintln!(
            "PARITY vs raw-core texture={texture}: max abs diff = {max_diff:e} \
             at pixel ({wx},{wy}) [border={}]",
            wx < 2 || wy < 2 || wx >= w - 2 || wy >= h - 2
        );
        assert!(
            max_diff < 1e-4,
            "texture={texture}: GPU vs raw-core stage max abs diff {max_diff} exceeds 1e-4 \
             (worst at pixel ({wx},{wy}))"
        );
    }
}

/// Explicitly assert the BORDER ring (the 2-px truncated-window frame) is covered
/// non-vacuously — diff only that frame and confirm parity there too.
#[test]
fn wgsl_texture_border_ring_matches_raw_core() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (48usize, 48usize);
    let input = border_varying_image(w, h);
    let texture = 100.0f32;
    let reference = raw_core_texture(&input, w as u32, h as u32, texture);

    let img = GpuImage::upload(&ctx, &input, w as u32, h as u32);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&TexturePass { texture }]);

    let mut worst = 0.0f32;
    let mut counted = 0usize;
    for y in 0..h {
        for x in 0..w {
            let is_border = x < 2 || y < 2 || x >= w - 2 || y >= h - 2;
            if !is_border {
                continue;
            }
            counted += 1;
            let i = (y * w + x) * 4;
            for c in 0..3 {
                worst = worst.max((reference[i + c] - gpu[i + c]).abs());
            }
        }
    }
    eprintln!("BORDER parity: {counted} border pixels, max abs diff = {worst:e}");
    assert!(counted > 0, "border ring was empty — test is vacuous");
    assert!(
        worst < 1e-4,
        "texture border-ring GPU vs raw-core max abs diff {worst} exceeds 1e-4"
    );
}

/// `texture = 0` is identity: the GPU reproduces the input bit-for-bit (the Pass
/// copies src → dst). Mirrors raw-core's `|texture| < 1e-3` early return.
#[test]
fn wgsl_texture_zero_is_identity() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (16usize, 16usize);
    let input = border_varying_image(w, h);
    let img = GpuImage::upload(&ctx, &input, w as u32, h as u32);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&TexturePass { texture: 0.0 }]);
    assert_eq!(
        gpu, input,
        "texture=0 must pass the image through unchanged"
    );
}

/// A flat neutral field has no detail, so texture is a no-op at any amount.
#[test]
fn wgsl_texture_flat_stays_flat() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (32usize, 32usize);
    let input: Vec<f32> = (0..w * h).flat_map(|_| [0.5f32, 0.5, 0.5, 1.0]).collect();
    let img = GpuImage::upload(&ctx, &input, w as u32, h as u32);
    let runner = ChainRunner::new(&ctx, &img);
    for &texture in &[-100.0_f32, 50.0, 100.0] {
        let gpu = runner.run_blocking(&[&TexturePass { texture }]);
        let (max_diff, _) = max_diff_at(&input, &gpu);
        assert!(
            max_diff < 1e-4,
            "texture={texture}: flat field drifted by {max_diff}"
        );
    }
}

/// Pin the local CPU oracle (`apply_texture`) to raw-core's stage too.
#[test]
fn local_oracle_matches_raw_core_stage_within_1e_4() {
    let (w, h) = (48usize, 48usize);
    let input = border_varying_image(w, h);
    for &texture in &[-100.0_f32, -50.0, 30.0, 100.0] {
        let reference = raw_core_texture(&input, w as u32, h as u32, texture);
        let mut local = input.clone();
        apply_texture(&mut local, w, h, texture);
        let (max_diff, _) = max_diff_at(&reference, &local);
        assert!(
            max_diff < 1e-4,
            "texture={texture}: local oracle vs raw-core stage diff {max_diff} exceeds 1e-4"
        );
    }
}

/// texture and clarity must differ on a fine-detail-bearing image (radius 2 vs
/// 20 picks out a different frequency band). Guards against a wiring slip that
/// would make TexturePass secretly run at clarity's radius.
#[test]
fn texture_differs_from_clarity_on_fine_detail() {
    use crate::clarity::ClarityPass;
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (48usize, 48usize);
    let input = border_varying_image(w, h);
    let img = GpuImage::upload(&ctx, &input, w as u32, h as u32);
    let runner = ChainRunner::new(&ctx, &img);
    let tex = runner.run_blocking(&[&TexturePass { texture: 100.0 }]);
    let clar = runner.run_blocking(&[&ClarityPass { clarity: 100.0 }]);
    let (diff, _) = max_diff_at(&tex, &clar);
    assert!(
        diff > 1e-3,
        "texture (r=2) and clarity (r=20) produced near-identical output ({diff}) — \
         radius wiring is likely wrong"
    );
}
