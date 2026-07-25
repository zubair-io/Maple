//! Bilinear inverse-warp for off-axis straighten angles.
//!
//! Strategy: for each destination pixel `(xp, yp)` in the rect of size
//! `(rect_w × rect_h)`, compute the corresponding source position by
//! inverse-rotating the rect-origin-relative coordinate around the centre
//! of the original `w × h` buffer (display coords), then bilinear-sample.
//! Out-of-bounds source reads return the channel-zero "empty corner"
//! value the spec acknowledges large rotations may expose.

use crate::types::Crop;

use super::rect_in_pixels;
use super::sample::Sample;

pub(super) fn rotate_and_slice_f32_rgba(
    rgba: &[f32],
    w: u32,
    h: u32,
    crop: &Crop,
) -> (u32, u32, Vec<f32>) {
    let (rect_x, rect_y, rect_w, rect_h) = rect_in_pixels(crop, w, h);
    let sw = w as f32;
    let sh = h as f32;
    // Inverse rotation: source = R(-θ) · (dest - centre) + centre.
    let theta = crop.angle.to_radians();
    let params = RotationParams {
        cx: sw / 2.0,
        cy: sh / 2.0,
        cos_t: (-theta).cos(),
        sin_t: (-theta).sin(),
    };
    let dw = rect_w as usize;
    let dh = rect_h as usize;
    let mut out = vec![0.0f32; dw * dh * 4];
    for yp in 0..dh {
        for xp in 0..dw {
            // Position in display coords of this destination pixel: rect
            // origin + offset, sample at pixel centre (`+ 0.5`).
            let dx = (rect_x as f32) + (xp as f32) + 0.5;
            let dy = (rect_y as f32) + (yp as f32) + 0.5;
            let (sx, sy) = inverse_rotate(dx, dy, &params);
            // Subtract the half-pixel offset before sampling — the bilinear
            // sampler indexes into the centre of pixels.
            let sample = sample_rgba(rgba, w, h, sx - 0.5, sy - 0.5);
            let di = (yp * dw + xp) * 4;
            out[di] = sample[0];
            out[di + 1] = sample[1];
            out[di + 2] = sample[2];
            out[di + 3] = sample[3];
        }
    }
    (rect_w, rect_h, out)
}

/// Bilinear inverse-warp for interleaved integer RGB at either display depth
/// (#943). The interpolation itself runs in f32 for both, so the only
/// depth-specific step is the narrowing round in [`Sample::from_f32_rounded`].
pub(super) fn rotate_and_slice_rgb<T: Sample>(
    rgb: &[T],
    w: u32,
    h: u32,
    crop: &Crop,
) -> (u32, u32, Vec<T>) {
    let (rect_x, rect_y, rect_w, rect_h) = rect_in_pixels(crop, w, h);
    let sw = w as f32;
    let sh = h as f32;
    let theta = crop.angle.to_radians();
    let params = RotationParams {
        cx: sw / 2.0,
        cy: sh / 2.0,
        cos_t: (-theta).cos(),
        sin_t: (-theta).sin(),
    };
    let dw = rect_w as usize;
    let dh = rect_h as usize;
    let mut out = vec![T::default(); dw * dh * 3];
    for yp in 0..dh {
        for xp in 0..dw {
            let dx = (rect_x as f32) + (xp as f32) + 0.5;
            let dy = (rect_y as f32) + (yp as f32) + 0.5;
            let (sx, sy) = inverse_rotate(dx, dy, &params);
            let sample = sample_rgb(rgb, w, h, sx - 0.5, sy - 0.5);
            let di = (yp * dw + xp) * 3;
            out[di] = sample[0];
            out[di + 1] = sample[1];
            out[di + 2] = sample[2];
        }
    }
    (rect_w, rect_h, out)
}

struct RotationParams {
    cx: f32,
    cy: f32,
    cos_t: f32,
    sin_t: f32,
}

#[inline]
fn inverse_rotate(dx: f32, dy: f32, p: &RotationParams) -> (f32, f32) {
    let rx = dx - p.cx;
    let ry = dy - p.cy;
    let sx = rx * p.cos_t - ry * p.sin_t + p.cx;
    let sy = rx * p.sin_t + ry * p.cos_t + p.cy;
    (sx, sy)
}

/// Bilinear sample into a packed RGBA f32 buffer at fractional `(sx, sy)`
/// pixel coordinates (origin = pixel-centre of pixel (0, 0)). Out-of-bounds
/// reads return `[0.0, 0.0, 0.0, 1.0]` — the alpha stays 1.0 so downstream
/// view transforms don't see a premultiplied-alpha discontinuity.
#[inline]
fn sample_rgba(rgba: &[f32], w: u32, h: u32, sx: f32, sy: f32) -> [f32; 4] {
    let wi = w as i32;
    let hi = h as i32;
    let x0 = sx.floor() as i32;
    let y0 = sy.floor() as i32;
    let x1 = x0 + 1;
    let y1 = y0 + 1;
    if x1 < 0 || y1 < 0 || x0 >= wi || y0 >= hi {
        return [0.0, 0.0, 0.0, 1.0];
    }
    let fx = sx - (x0 as f32);
    let fy = sy - (y0 as f32);
    let sample = |xi: i32, yi: i32| -> [f32; 4] {
        let xi = xi.clamp(0, wi - 1) as usize;
        let yi = yi.clamp(0, hi - 1) as usize;
        let idx = (yi * (w as usize) + xi) * 4;
        [rgba[idx], rgba[idx + 1], rgba[idx + 2], rgba[idx + 3]]
    };
    let p00 = sample(x0, y0);
    let p10 = sample(x1, y0);
    let p01 = sample(x0, y1);
    let p11 = sample(x1, y1);
    let w00 = (1.0 - fx) * (1.0 - fy);
    let w10 = fx * (1.0 - fy);
    let w01 = (1.0 - fx) * fy;
    let w11 = fx * fy;
    let mut out = [0.0f32; 4];
    for c in 0..4 {
        out[c] = p00[c] * w00 + p10[c] * w10 + p01[c] * w01 + p11[c] * w11;
    }
    out
}

/// Bilinear sample into a packed integer RGB buffer at fractional `(sx, sy)`
/// pixel coordinates. Out-of-bounds reads return the "empty corner" black the
/// spec acknowledges large rotations may expose.
#[inline]
fn sample_rgb<T: Sample>(rgb: &[T], w: u32, h: u32, sx: f32, sy: f32) -> [T; 3] {
    let wi = w as i32;
    let hi = h as i32;
    let x0 = sx.floor() as i32;
    let y0 = sy.floor() as i32;
    let x1 = x0 + 1;
    let y1 = y0 + 1;
    if x1 < 0 || y1 < 0 || x0 >= wi || y0 >= hi {
        return [T::default(); 3];
    }
    let fx = sx - (x0 as f32);
    let fy = sy - (y0 as f32);
    let sample = |xi: i32, yi: i32| -> [f32; 3] {
        let xi = xi.clamp(0, wi - 1) as usize;
        let yi = yi.clamp(0, hi - 1) as usize;
        let idx = (yi * (w as usize) + xi) * 3;
        [
            rgb[idx].to_f32(),
            rgb[idx + 1].to_f32(),
            rgb[idx + 2].to_f32(),
        ]
    };
    let p00 = sample(x0, y0);
    let p10 = sample(x1, y0);
    let p01 = sample(x0, y1);
    let p11 = sample(x1, y1);
    let w00 = (1.0 - fx) * (1.0 - fy);
    let w10 = fx * (1.0 - fy);
    let w01 = (1.0 - fx) * fy;
    let w11 = fx * fy;
    let mut out = [T::default(); 3];
    for c in 0..3 {
        let v = p00[c] * w00 + p10[c] * w10 + p01[c] * w01 + p11[c] * w11;
        out[c] = T::from_f32_rounded(v);
    }
    out
}
