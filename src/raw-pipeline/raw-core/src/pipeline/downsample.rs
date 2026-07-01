//! Area-average f32 RGB downsample used by the sized and tile entries.
//!
//! Same algorithm as `api::downsample_to_rgba` but in f32 RGB: integer
//! source-row spans are averaged into each destination pixel. No
//! premultiplied-alpha or gamma considerations because the buffer is
//! straight scene-linear with no alpha channel. A higher-quality Lanczos
//! or Mitchell variant lands as a follow-up (ticket 06 Milestone 3).

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
    if long_edge <= max_long_edge { return; }
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
                + (6.0 - 2.0 * b)) / 6.0
        } else if ax < 2.0 {
            ((-b - 6.0 * c) * ax * ax * ax
                + (6.0 * b + 30.0 * c) * ax * ax
                + (-12.0 * b - 48.0 * c) * ax
                + (8.0 * b + 24.0 * c)) / 6.0
        } else {
            0.0
        }
    };

    // 1. Horizontal downsample pass: (sw, sh) -> (dw, sh)
    let mut horiz = vec![[0.0f32; 3]; dw_u * sh_u];
    let radius_x = 2.0 * scale_x;
    for y in 0..sh_u {
        for x in 0..dw_u {
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
                let p = image.pixels[y * sw_u + sx_clamped];
                sum_r += p[0] * weight;
                sum_g += p[1] * weight;
                sum_b += p[2] * weight;
                sum_w += weight;
            }
            let w_norm = if sum_w.abs() > 1e-6 { sum_w } else { 1.0 };
            horiz[y * dw_u + x] = [sum_r / w_norm, sum_g / w_norm, sum_b / w_norm];
        }
    }

    // 2. Vertical downsample pass: (dw, sh) -> (dw, dh)
    let mut out = vec![[0.0f32; 3]; dw_u * dh_u];
    let radius_y = 2.0 * scale_y;
    for y in 0..dh_u {
        let y_src = (y as f32 + 0.5) * scale_y - 0.5;
        let y0 = (y_src - radius_y).floor() as isize;
        let y1 = (y_src + radius_y).ceil() as isize;
        for x in 0..dw_u {
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
            out[y * dw_u + x] = [sum_r / w_norm, sum_g / w_norm, sum_b / w_norm];
        }
    }

    image.pixels = out;
    image.width = dw;
    image.height = dh;
}
