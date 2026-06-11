//! Equirectangular source image: loading, procedural generation, and
//! bilinear sampling in the crate's longitude/latitude convention.
//!
//! # Pixel mapping (binding)
//!
//! A full-sphere equirect of width `W`, height `H` (`W = 2H`) covers
//! longitude `λ ∈ [−π, π)` and latitude `φ ∈ [−π/2, π/2]`:
//!
//! ```text
//! u_px = (λ/2π + 0.5) · W          v_px = (0.5 − φ/π) · H
//! ```
//!
//! Continuous pixel coordinates; texel `(ix, iy)` stores the value at its
//! center `(ix + 0.5, iy + 0.5)`. Row 0 is the **zenith** (φ = +π/2, "up" =
//! world −Y); `u` increases eastward (toward +X). Bilinear sampling wraps
//! horizontally (longitude is periodic) and clamps vertically (the poles).
//!
//! # Linearity
//!
//! Pixel values are treated as **linear light** end to end. PNG inputs are
//! normalized to `[0, 1]` with **no transfer-function decode** — a 16-bit
//! PNG fed to the renderer is interpreted as linear regardless of any gAMA
//! /sRGB chunk it may carry.

use std::path::Path;

use crate::error::PanoError;
use crate::math::Vec3;
use crate::project::dir_to_lonlat;

/// An equirectangular linear RGB image (row-major `[r, g, b]` texels).
pub struct EquirectSource {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<[f32; 3]>,
}

impl EquirectSource {
    /// Procedural test scene — see [`crate::synthetic`].
    pub fn synthetic(width: u32, height: u32, seed: u64) -> Result<Self, PanoError> {
        check_aspect(width, height)?;
        Ok(Self {
            width,
            height,
            pixels: crate::synthetic::generate(width, height, seed),
        })
    }

    /// Load a PNG (8- or 16-bit; gray/RGB/RGBA) as a linear equirect.
    ///
    /// Values are normalized to `[0, 1]` without any transfer-function
    /// decode (the file is **treated as linear**; see module docs).
    pub fn from_png(path: &Path) -> Result<Self, PanoError> {
        let img = image::open(path).map_err(|source| PanoError::ImageDecode {
            path: path.to_path_buf(),
            source,
        })?;
        // `to_rgb32f` is a pure bit-depth normalization — exactly the
        // "input is linear" contract (it does NOT apply sRGB decode).
        let rgb = img.to_rgb32f();
        let (width, height) = (rgb.width(), rgb.height());
        check_aspect(width, height)?;
        let pixels = rgb.pixels().map(|p| [p.0[0], p.0[1], p.0[2]]).collect();
        Ok(Self {
            width,
            height,
            pixels,
        })
    }

    /// Sample the scene in a world direction (bilinear, wrap-X / clamp-Y).
    ///
    /// Returns `None` only for a zero-length direction.
    pub fn sample_dir(&self, dir: Vec3) -> Option<[f64; 3]> {
        let (lambda, phi) = dir_to_lonlat(dir)?;
        let u = (lambda / std::f64::consts::TAU + 0.5) * self.width as f64;
        let v = (0.5 - phi / std::f64::consts::PI) * self.height as f64;
        Some(self.sample_bilinear(u, v))
    }

    /// Bilinear tap at continuous pixel coordinates `(u, v)` — texel
    /// centers at half-integers, horizontal wrap, vertical clamp.
    pub fn sample_bilinear(&self, u: f64, v: f64) -> [f64; 3] {
        let w = self.width as i64;
        let h = self.height as i64;
        let x = u - 0.5;
        let y = v - 0.5;
        let x0 = x.floor();
        let y0 = y.floor();
        let fx = x - x0;
        let fy = y - y0;
        let ix0 = (x0 as i64).rem_euclid(w);
        let ix1 = (x0 as i64 + 1).rem_euclid(w);
        let iy0 = (y0 as i64).clamp(0, h - 1);
        let iy1 = (y0 as i64 + 1).clamp(0, h - 1);
        let at = |ix: i64, iy: i64| -> &[f32; 3] { &self.pixels[(iy * w + ix) as usize] };
        let (p00, p10) = (at(ix0, iy0), at(ix1, iy0));
        let (p01, p11) = (at(ix0, iy1), at(ix1, iy1));
        let mut out = [0.0_f64; 3];
        for c in 0..3 {
            let top = p00[c] as f64 * (1.0 - fx) + p10[c] as f64 * fx;
            let bot = p01[c] as f64 * (1.0 - fx) + p11[c] as f64 * fx;
            out[c] = top * (1.0 - fy) + bot * fy;
        }
        out
    }
}

fn check_aspect(width: u32, height: u32) -> Result<(), PanoError> {
    if width < 4 || height < 2 || width != height * 2 {
        return Err(PanoError::BadSourceAspect { width, height });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn constant_source(value: f32) -> EquirectSource {
        EquirectSource {
            width: 16,
            height: 8,
            pixels: vec![[value; 3]; 16 * 8],
        }
    }

    #[test]
    fn rejects_non_two_to_one_aspect() {
        assert!(matches!(
            EquirectSource::synthetic(100, 60, 0),
            Err(PanoError::BadSourceAspect { .. })
        ));
    }

    #[test]
    fn bilinear_of_constant_image_is_constant_everywhere() {
        let src = constant_source(0.25);
        for &(u, v) in &[
            (0.0, 0.0),
            (8.0, 4.0),
            (15.99, 7.99),
            (-3.0, 2.5),
            (31.7, 0.01),
        ] {
            let s = src.sample_bilinear(u, v);
            for c in s {
                assert!((c - 0.25).abs() < 1e-9, "({u},{v}) → {c}");
            }
        }
    }

    #[test]
    fn texel_centers_return_exact_texel_values() {
        let mut src = constant_source(0.0);
        src.pixels[(3 * 16 + 5) as usize] = [0.75, 0.5, 0.25];
        let s = src.sample_bilinear(5.5, 3.5);
        assert!((s[0] - 0.75).abs() < 1e-9);
        assert!((s[1] - 0.5).abs() < 1e-9);
        assert!((s[2] - 0.25).abs() < 1e-9);
    }

    #[test]
    fn horizontal_sampling_wraps_around_the_seam() {
        let mut src = constant_source(0.0);
        // Last texel of a row bright; sampling just past the right edge
        // must blend it with the first texel of the row (wrap), not clamp.
        src.pixels[(2 * 16 + 15) as usize] = [1.0; 3];
        let s = src.sample_bilinear(16.0, 2.5); // halfway texel 15 ↔ texel 0
        assert!((s[0] - 0.5).abs() < 1e-9, "wrap blend got {}", s[0]);
    }

    #[test]
    fn vertical_sampling_clamps_at_poles() {
        let mut src = constant_source(0.0);
        for ix in 0..16 {
            src.pixels[ix as usize] = [0.8; 3]; // top row
        }
        let s = src.sample_bilinear(4.5, 0.0); // above the top texel center
        assert!((s[0] - 0.8).abs() < 1e-6, "clamp got {}", s[0]);
    }

    #[test]
    fn sample_dir_hits_the_expected_equirect_texel() {
        let mut src = constant_source(0.0);
        // λ = 0, φ = 0 → u = W/2 = 8, v = H/2 = 4: straddles texels 7|8
        // horizontally and rows 3|4 vertically. Make that 2×2 block bright.
        for (ix, iy) in [(7, 3), (8, 3), (7, 4), (8, 4)] {
            src.pixels[(iy * 16 + ix) as usize] = [0.6; 3];
        }
        let s = src.sample_dir(Vec3::new(0.0, 0.0, 1.0)).unwrap();
        assert!((s[0] - 0.6).abs() < 1e-6, "+Z sampled {}", s[0]);
    }
}
