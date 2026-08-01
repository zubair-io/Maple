//! Area-average f32 RGB downsample used by the sized and tile entries.
//!
//! Same algorithm as `api::downsample_to_rgba` but in f32 RGB: integer
//! source-row spans are averaged into each destination pixel. No
//! premultiplied-alpha or gamma considerations because the buffer is
//! straight scene-linear with no alpha channel. A higher-quality Lanczos
//! or Mitchell variant lands as a follow-up (ticket 06 Milestone 3).

use rayon::prelude::*;

/// Area-average downsample an `Image`'s f32 RGB pixel buffer to fit within
/// `max_long_edge` on its long edge while preserving the aspect ratio.
/// **Never upscales** (ticket 06 § Product Requirements 1) — if the source
/// long edge is already <= `max_long_edge`, returns the image unmodified.
///
/// Same algorithm as `api::downsample_to_rgba` but in f32 RGB: integer
/// source-row spans are averaged into each destination pixel, no
/// premultiplied-alpha or gamma considerations because the buffer is
/// straight scene-linear with no alpha channel. A higher-quality Lanczos
/// or Mitchell variant lands as a follow-up (ticket 06 Milestone 3).
///
/// Mutates `image` in place; updates `image.width` and `image.height` to
/// the new dimensions.
pub fn downsample_image_area(image: &mut crate::image::Image, max_long_edge: u32) {
    let (sw, sh) = (image.width, image.height);
    let long_edge = sw.max(sh);
    if long_edge <= max_long_edge {
        return;
    }
    let (dw, dh) = if sw >= sh {
        let scale = max_long_edge as f64 / sw as f64;
        (max_long_edge, ((sh as f64 * scale).round() as u32).max(1))
    } else {
        let scale = max_long_edge as f64 / sh as f64;
        (((sw as f64 * scale).round() as u32).max(1), max_long_edge)
    };

    let sw_u = sw as usize;
    let sh_u = sh as usize;
    let dw_u = dw as usize;
    let dh_u = dh as usize;

    let scale_x = sw as f32 / dw as f32;
    let scale_y = sh as f32 / dh as f32;

    // Helper Mitchell-Netravali filter (B=1/3, C=1/3)
    let mitchell = |x: f32| -> f32 {
        let ax = x.abs();
        let b = 1.0 / 3.0;
        let c = 1.0 / 3.0;
        if ax < 1.0 {
            ((12.0 - 9.0 * b - 6.0 * c) * ax * ax * ax
                + (-18.0 + 12.0 * b + 6.0 * c) * ax * ax
                + (6.0 - 2.0 * b))
                / 6.0
        } else if ax < 2.0 {
            ((-b - 6.0 * c) * ax * ax * ax
                + (6.0 * b + 30.0 * c) * ax * ax
                + (-12.0 * b - 48.0 * c) * ax
                + (8.0 * b + 24.0 * c))
                / 6.0
        } else {
            0.0
        }
    };

    // 1. Horizontal downsample pass: (sw, sh) -> (dw, sh)
    //
    // Row-parallel (#1089 item 4). Destination row `y` reads only source row
    // `y`, so the rows are independent and each destination pixel accumulates
    // its taps in exactly the same order as the serial version did — the
    // output is bit-identical, not merely numerically close. `tests::
    // deterministic_across_thread_counts` pins that: a one-thread rayon pool
    // reproduces the old serial traversal exactly, so equality against an
    // 8-thread run is equality against the pre-#1089 result.
    let mut horiz = vec![[0.0f32; 3]; dw_u * sh_u];
    let radius_x = 2.0 * scale_x;
    let src = &image.pixels;
    horiz
        .par_chunks_mut(dw_u)
        .enumerate()
        .for_each(|(y, row_out)| {
            let row_in = &src[y * sw_u..y * sw_u + sw_u];
            for (x, out_px) in row_out.iter_mut().enumerate() {
                let x_src = (x as f32 + 0.5) * scale_x - 0.5;
                let x0 = (x_src - radius_x).floor() as isize;
                let x1 = (x_src + radius_x).ceil() as isize;
                let mut sum_r = 0.0f32;
                let mut sum_g = 0.0f32;
                let mut sum_b = 0.0f32;
                let mut sum_w = 0.0f32;
                for sx in x0..=x1 {
                    let sx_clamped = sx.clamp(0, (sw_u - 1) as isize) as usize;
                    let weight = mitchell((sx as f32 - x_src) / scale_x);
                    let p = row_in[sx_clamped];
                    sum_r += p[0] * weight;
                    sum_g += p[1] * weight;
                    sum_b += p[2] * weight;
                    sum_w += weight;
                }
                let w_norm = if sum_w.abs() > 1e-6 { sum_w } else { 1.0 };
                *out_px = [sum_r / w_norm, sum_g / w_norm, sum_b / w_norm];
            }
        });

    // 2. Vertical downsample pass: (dw, sh) -> (dw, dh)
    //
    // Also row-parallel: `horiz` is read-only here and each destination row
    // owns its own output slice, so the same bit-identity argument holds.
    let mut out = vec![[0.0f32; 3]; dw_u * dh_u];
    let radius_y = 2.0 * scale_y;
    out.par_chunks_mut(dw_u)
        .enumerate()
        .for_each(|(y, row_out)| {
            let y_src = (y as f32 + 0.5) * scale_y - 0.5;
            let y0 = (y_src - radius_y).floor() as isize;
            let y1 = (y_src + radius_y).ceil() as isize;
            for (x, out_px) in row_out.iter_mut().enumerate() {
                let mut sum_r = 0.0f32;
                let mut sum_g = 0.0f32;
                let mut sum_b = 0.0f32;
                let mut sum_w = 0.0f32;
                for sy in y0..=y1 {
                    let sy_clamped = sy.clamp(0, (sh_u - 1) as isize) as usize;
                    let weight = mitchell((sy as f32 - y_src) / scale_y);
                    let p = horiz[sy_clamped * dw_u + x];
                    sum_r += p[0] * weight;
                    sum_g += p[1] * weight;
                    sum_b += p[2] * weight;
                    sum_w += weight;
                }
                let w_norm = if sum_w.abs() > 1e-6 { sum_w } else { 1.0 };
                *out_px = [sum_r / w_norm, sum_g / w_norm, sum_b / w_norm];
            }
        });

    image.pixels = out;
    image.width = dw;
    image.height = dh;
}

#[cfg(test)]
mod tests {
    use super::downsample_image_area;
    use crate::image::{ColorSpace, Image};

    /// Deterministic scene-linear content with real high-frequency detail, so
    /// every arm of the Mitchell kernel is exercised and no tap short-circuits
    /// on a flat field.
    fn detailed(width: u32, height: u32) -> Image {
        let w = width as usize;
        let pixels = (0..w * height as usize)
            .map(|i| {
                let x = (i % w) as f32;
                let y = (i / w) as f32;
                let n = ((i.wrapping_mul(2_654_435_761)) >> 8 & 0xffff) as f32 / 65535.0;
                [
                    0.18 * (1.0 + 0.5 * (x * 0.31).sin()) + 0.05 * n,
                    0.18 * (1.0 + 0.5 * (y * 0.27).cos()) + 0.05 * n,
                    0.18 * (1.0 + 0.5 * ((x + y) * 0.19).sin()) + 0.05 * n,
                ]
            })
            .collect();
        Image {
            width,
            height,
            pixels,
            // Matches the production call site: `develop_sized` downsamples
            // the post-demosaic camera-native buffer.
            space: ColorSpace::CameraNativeLinearRgb,
        }
    }

    /// The row-parallel passes (#1089 item 4) must be *bit*-identical to the
    /// serial traversal they replaced, not merely close: this runs the same
    /// input through a one-thread rayon pool — which reproduces the old serial
    /// row order exactly — and through an eight-thread pool, and demands byte
    /// equality. Any accidental cross-row reduction or order-dependent
    /// accumulation would break this.
    #[test]
    fn deterministic_across_thread_counts() {
        for &(w, h, cap) in &[(129u32, 97u32, 64u32), (256, 64, 40), (64, 256, 40)] {
            let base = detailed(w, h);
            let run = |threads: usize| -> (u32, u32, Vec<[f32; 3]>) {
                let pool = rayon::ThreadPoolBuilder::new()
                    .num_threads(threads)
                    .build()
                    .expect("build pool");
                let mut img = base.clone();
                pool.install(|| downsample_image_area(&mut img, cap));
                (img.width, img.height, img.pixels)
            };
            let one = run(1);
            let many = run(8);
            assert_eq!(
                one, many,
                "{w}x{h} -> cap {cap} must be byte-identical across thread counts"
            );
        }
    }

    /// The long-edge cap never upscales, and the aspect ratio survives.
    #[test]
    fn respects_cap_and_never_upscales() {
        let mut wide = detailed(200, 100);
        downsample_image_area(&mut wide, 50);
        assert_eq!((wide.width, wide.height), (50, 25));
        assert_eq!(wide.pixels.len(), 50 * 25);

        let mut small = detailed(30, 20);
        let before = small.pixels.clone();
        downsample_image_area(&mut small, 50);
        assert_eq!((small.width, small.height), (30, 20));
        assert_eq!(small.pixels, before, "must be an exact no-op under the cap");
    }
}
