//! Separable blur utilities for clarity/texture stages.
//!
//! `gaussian_blur_rgb` approximates a 2D Gaussian by three successive 1D box
//! blurs per axis (Wells 1986, "Efficient synthesis of Gaussian filters"). At
//! the slice-3 radii (3 and 40), the approximation is visually indistinguishable
//! from a true Gaussian and runs in O(n) per pixel independent of radius.

use crate::image::{ColorSpace, Image};

/// Separable box blur of a single channel plane.
/// `buf` is row-major w×h. Returns a new blurred buffer.
fn box_blur_channel(buf: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    if r == 0 { return buf.to_vec(); }

    let mut tmp = vec![0.0f32; buf.len()];
    // Horizontal.
    for y in 0..h {
        let row = &buf[y * w..(y + 1) * w];
        let mut out_row = vec![0.0f32; w];
        let right0 = r.min(w - 1);
        let mut acc: f32 = row[0..=right0].iter().sum();
        let mut count = right0 + 1;
        out_row[0] = acc / count as f32;
        for x in 1..w {
            if x + r < w { acc += row[x + r]; count += 1; }
            if x > r     { acc -= row[x - r - 1]; count -= 1; }
            out_row[x] = acc / count as f32;
        }
        tmp[y * w..(y + 1) * w].copy_from_slice(&out_row);
    }
    // Vertical.
    let mut out = vec![0.0f32; buf.len()];
    for x in 0..w {
        let mut out_col = vec![0.0f32; h];
        let bot0 = r.min(h - 1);
        let mut acc: f32 = (0..=bot0).map(|i| tmp[i * w + x]).sum();
        let mut count = bot0 + 1;
        out_col[0] = acc / count as f32;
        for y in 1..h {
            if y + r < h { acc += tmp[(y + r) * w + x]; count += 1; }
            if y > r     { acc -= tmp[(y - r - 1) * w + x]; count -= 1; }
            out_col[y] = acc / count as f32;
        }
        for y in 0..h { out[y * w + x] = out_col[y]; }
    }
    out
}

/// Gaussian-ish blur of an RGB image via 3 successive box-blur passes per axis
/// (approximation per Wells 1986). `radius` is the effective Gaussian radius;
/// internally uses 3 box passes of `radius / 3`.
///
/// A radius of 0 returns a clone of the input unchanged.
pub fn gaussian_blur_rgb(img: &Image, radius: usize) -> Image {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if radius == 0 {
        return img.clone();
    }
    let w = img.width as usize;
    let h = img.height as usize;
    let r_box = (radius / 3).max(1);

    // Split into three channel planes.
    let mut r_plane: Vec<f32> = img.pixels.iter().map(|p| p[0]).collect();
    let mut g_plane: Vec<f32> = img.pixels.iter().map(|p| p[1]).collect();
    let mut b_plane: Vec<f32> = img.pixels.iter().map(|p| p[2]).collect();

    for _ in 0..3 {
        r_plane = box_blur_channel(&r_plane, w, h, r_box);
        g_plane = box_blur_channel(&g_plane, w, h, r_box);
        b_plane = box_blur_channel(&b_plane, w, h, r_box);
    }

    let mut out = Image::new(img.width, img.height, ColorSpace::SceneLinearRec2020);
    for i in 0..img.pixels.len() {
        out.pixels[i] = [r_plane[i], g_plane[i], b_plane[i]];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blur_of_constant_is_constant() {
        let mut img = Image::new(20, 20, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.3, 0.5, 0.7]; }
        let blurred = gaussian_blur_rgb(&img, 5);
        for p in &blurred.pixels {
            assert!((p[0] - 0.3).abs() < 1e-5);
            assert!((p[1] - 0.5).abs() < 1e-5);
            assert!((p[2] - 0.7).abs() < 1e-5);
        }
    }

    #[test]
    fn blur_smooths_a_delta() {
        // Single bright pixel should diffuse across the blur radius.
        let mut img = Image::new(21, 21, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = [0.0; 3]; }
        img.pixels[10 * 21 + 10] = [1.0, 1.0, 1.0];
        let blurred = gaussian_blur_rgb(&img, 3);
        // Center should be much less than 1 (energy spread out).
        let center = blurred.pixels[10 * 21 + 10][0];
        assert!(center < 0.5, "center still bright: {}", center);
        // Neighbor should have non-zero value (energy diffused).
        let neighbor = blurred.pixels[10 * 21 + 12][0];
        assert!(neighbor > 0.0);
    }

    #[test]
    fn radius_zero_is_identity() {
        let mut img = Image::new(3, 3, ColorSpace::SceneLinearRec2020);
        for (i, p) in img.pixels.iter_mut().enumerate() {
            *p = [i as f32, i as f32 * 2.0, i as f32 * 3.0];
        }
        let before = img.pixels.clone();
        let after = gaussian_blur_rgb(&img, 0);
        for (a, b) in after.pixels.iter().zip(before.iter()) {
            assert_eq!(a, b);
        }
    }
}
