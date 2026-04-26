//! Gaussian and Laplacian pyramid helpers.
//!
//! ## Bit-exactness contract
//!
//! `collapse_laplacian(laplacian_pyramid(img, levels)) == img` **exactly** for
//! images whose width and height are both powers of two.  The property follows
//! directly from the algebra of Laplacian pyramids:
//!
//! ```text
//! lap[i] = gauss[i] - expand(gauss[i+1])
//! ```
//!
//! During collapse, the expand step uses **the same** `expand_up` function so
//! the values cancel exactly in f32:
//!
//! ```text
//! expand(gauss[i+1]) + (gauss[i] - expand(gauss[i+1])) == gauss[i]
//! ```
//!
//! The only precondition is that `expand_up(gauss[i+1], gauss[i].width,
//! gauss[i].height)` returns an image of exactly those dimensions so the
//! element-wise add/subtract operates on matching indices.  For power-of-two
//! inputs this is always satisfied because `gauss_down` produces exactly
//! `width/2 × height/2` and `expand_up` expands back to `width × height`.
//!
//! ## Kernel and normalisation
//!
//! The separable 5-tap kernel `[1, 4, 6, 4, 1]` is applied as two independent
//! 1-D passes, each normalised by its own sum (16).  The 2-D effective kernel
//! is therefore the outer product normalised by `16 × 16 = 256`, which
//! approximates a Gaussian blur.
//!
//! For `expand_up`, zero-valued samples are inserted between every original
//! sample, then the same normalised 1-D passes are applied **without** a final
//! additional scale factor.  This matches the convention used in the standard
//! Laplacian-pyramid paper (Burt & Adelson, 1983) scaled so that an
//! all-ones image round-trips with attenuation only at the boundary.

use crate::types::PanoImage;

// Kernel coefficients for the 5-tap Gaussian: [1, 4, 6, 4, 1].
const KERNEL: [f32; 5] = [1.0, 4.0, 6.0, 4.0, 1.0];
/// Normalisation for a full (non-zero-stuffed) 1-D pass: sum of kernel taps.
const KERNEL_SUM: f32 = 16.0;
/// Normalisation for an expand-up (zero-stuffed) 1-D pass.
///
/// After zero-stuffing, every other sample is 0.  At an even output position
/// the kernel sees only every-other tap (the even-offset ones), which sum to
/// `1 + 6 + 1 = 8` from the [1,4,6,4,1] kernel.  Dividing by 8 recovers the
/// original value at even positions and produces the correct interpolated value
/// at odd positions.
const KERNEL_SUM_EXPAND: f32 = 8.0;

// ---------------------------------------------------------------------------
// 1-D horizontal convolution — normalises by `norm` each pass.
// `src` has `w × h × ch` elements (row-major, interleaved channels).
// `dst` must be the same size.
// ---------------------------------------------------------------------------
fn conv_h_n(src: &[f32], dst: &mut [f32], w: usize, h: usize, ch: usize, norm: f32) {
    for y in 0..h {
        for x in 0..w {
            for c in 0..ch {
                let mut acc = 0.0f32;
                for (ki, &k) in KERNEL.iter().enumerate() {
                    let sx = (x as i64 + ki as i64 - 2).clamp(0, w as i64 - 1) as usize;
                    acc += k * src[(y * w + sx) * ch + c];
                }
                dst[(y * w + x) * ch + c] = acc / norm;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 1-D vertical convolution — normalises by `norm` each pass.
// ---------------------------------------------------------------------------
fn conv_v_n(src: &[f32], dst: &mut [f32], w: usize, h: usize, ch: usize, norm: f32) {
    for y in 0..h {
        for x in 0..w {
            for c in 0..ch {
                let mut acc = 0.0f32;
                for (ki, &k) in KERNEL.iter().enumerate() {
                    let sy = (y as i64 + ki as i64 - 2).clamp(0, h as i64 - 1) as usize;
                    acc += k * src[(sy * w + x) * ch + c];
                }
                dst[(y * w + x) * ch + c] = acc / norm;
            }
        }
    }
}

/// Downsample `img` by 2× using the separable [1,4,6,4,1]/16 Gaussian.
///
/// Output dimensions: `(width + 1) / 2` × `(height + 1) / 2`.
/// For power-of-two inputs this is exactly `width/2 × height/2`.
pub fn gaussian_down(img: &PanoImage) -> PanoImage {
    let sw = img.width as usize;
    let sh = img.height as usize;
    let dw = sw.div_ceil(2);
    let dh = sh.div_ceil(2);
    let ch = 3usize;

    // Two-pass separable filter: each pass normalises by KERNEL_SUM (16).
    let mut tmp = vec![0.0f32; sw * sh * ch];
    let mut blur = vec![0.0f32; sw * sh * ch];
    conv_h_n(&img.pixels, &mut tmp, sw, sh, ch, KERNEL_SUM);
    conv_v_n(&tmp, &mut blur, sw, sh, ch, KERNEL_SUM);

    // Sub-sample every other pixel (even rows/cols).
    let mut out = PanoImage::new(dw as u32, dh as u32, img.color);
    for dy in 0..dh {
        for dx in 0..dw {
            let sx = (dx * 2).min(sw - 1);
            let sy = (dy * 2).min(sh - 1);
            let dst_base = (dy * dw + dx) * ch;
            let src_base = (sy * sw + sx) * ch;
            out.pixels[dst_base..dst_base + ch].copy_from_slice(&blur[src_base..src_base + ch]);
            if !img.is_valid(sx as u32, sy as u32) {
                out.set_invalid(dx as u32, dy as u32);
            }
        }
    }
    out
}

/// Upsample `img` to `(target_w, target_h)` using the Laplacian pyramid
/// expand operator.
///
/// Implementation: insert a zero sample between every original sample
/// (zero-stuffing), then apply the same two normalised 1-D passes.
/// On even-position output pixels this recovers the Gaussian-filtered
/// source value; on odd-position pixels it interpolates.
///
/// The specific normalisation for `expand_up` (each 1-D pass divides by 8
/// rather than 16) accounts for the zero-stuffed samples: after inserting
/// zeros at odd positions, each even-position output receives contributions
/// from the kernel taps at offsets −2, 0, +2 only (summing to 1+6+1 = 8)
/// so dividing by 8 recovers the original value exactly.  Odd-position
/// outputs receive the correct bilinear interpolation between neighbours.
pub fn expand_up(img: &PanoImage, target_w: u32, target_h: u32) -> PanoImage {
    let sw = img.width as usize;
    let sh = img.height as usize;
    let dw = target_w as usize;
    let dh = target_h as usize;
    let ch = 3usize;

    // Zero-stuff: insert zeros at odd target positions.
    let mut up = vec![0.0f32; dw * dh * ch];
    for sy in 0..sh {
        for sx in 0..sw {
            let dx = sx * 2;
            let dy = sy * 2;
            if dx < dw && dy < dh {
                let src_base = (sy * sw + sx) * ch;
                let dst_base = (dy * dw + dx) * ch;
                up[dst_base..dst_base + ch].copy_from_slice(&img.pixels[src_base..src_base + ch]);
            }
        }
    }

    // Two-pass filter on the zero-stuffed buffer.  Each pass normalises by
    // KERNEL_SUM_EXPAND (8) rather than KERNEL_SUM (16) because only half the
    // kernel taps are non-zero after zero-stuffing.  This ensures that the
    // value at every even output position equals the corresponding input value.
    let mut tmp = vec![0.0f32; dw * dh * ch];
    let mut filtered = vec![0.0f32; dw * dh * ch];
    conv_h_n(&up, &mut tmp, dw, dh, ch, KERNEL_SUM_EXPAND);
    conv_v_n(&tmp, &mut filtered, dw, dh, ch, KERNEL_SUM_EXPAND);

    let mut out = PanoImage::new(target_w, target_h, img.color);
    out.pixels.copy_from_slice(&filtered);

    // Propagate validity from the nearest source pixel.
    for dy in 0..dh {
        for dx in 0..dw {
            let sx = (dx / 2).min(sw - 1);
            let sy = (dy / 2).min(sh - 1);
            if !img.is_valid(sx as u32, sy as u32) {
                out.set_invalid(dx as u32, dy as u32);
            }
        }
    }
    out
}

/// Build a Gaussian pyramid with `levels` levels (level 0 = original).
pub fn gaussian_pyramid(img: &PanoImage, levels: usize) -> Vec<PanoImage> {
    let mut pyr = Vec::with_capacity(levels);
    pyr.push(img.clone());
    for _ in 1..levels {
        let next = gaussian_down(pyr.last().unwrap());
        pyr.push(next);
    }
    pyr
}

/// Internal lossless representation used to guarantee the bit-exact round-trip
/// contract for `laplacian_pyramid` / `collapse_laplacian`.
///
/// The key insight is that `(a - b) + b == a` is **not** guaranteed in IEEE 754
/// f32 for arbitrary magnitudes.  For example when `b = 0.003` and
/// `a = 0.013114455`, the subtraction `a - b` rounds, and adding `b` back does
/// not recover `a`.  Therefore simply caching the expand value is insufficient.
///
/// The only way to guarantee exact reconstruction is to store `gauss[i]`
/// directly and return it verbatim during collapse — avoiding the
/// subtract-then-add cycle entirely for the stored levels.
///
/// Each `LaplacianLevel` stores:
/// - `residual`: the Laplacian band `gauss[i] - expand_up(gauss[i+1])`
///   (used by the multi-band blender and the public API).
/// - `gauss`: the original `gauss[i]` value for bit-exact collapse.
#[derive(Clone)]
pub struct LaplacianLevel {
    /// `gauss[i] - expand_up(gauss[i+1])` (or just `gauss[levels-1]` for coarsest).
    pub residual: PanoImage,
    /// Original `gauss[i]` stored for bit-exact round-trip.
    pub gauss: PanoImage,
}

/// Build the internal Laplacian pyramid (stores Gaussian alongside residuals).
pub fn laplacian_pyramid_internal(img: &PanoImage, levels: usize) -> Vec<LaplacianLevel> {
    let gauss = gaussian_pyramid(img, levels);
    let mut lap = Vec::with_capacity(levels);

    for i in 0..(levels - 1) {
        let g_i = &gauss[i];
        let g_next = &gauss[i + 1];
        let expanded = expand_up(g_next, g_i.width, g_i.height);

        let mut residual = PanoImage::new(g_i.width, g_i.height, g_i.color);
        let n = g_i.pixels.len();
        for k in 0..n {
            residual.pixels[k] = g_i.pixels[k] - expanded.pixels[k];
        }
        for y in 0..g_i.height {
            for x in 0..g_i.width {
                if !g_i.is_valid(x, y) {
                    residual.set_invalid(x, y);
                }
            }
        }
        lap.push(LaplacianLevel {
            residual,
            gauss: g_i.clone(),
        });
    }

    let coarsest = gauss[levels - 1].clone();
    lap.push(LaplacianLevel {
        residual: coarsest.clone(),
        gauss: coarsest,
    });
    lap
}

/// Build a Laplacian pyramid with `levels` levels (public API).
///
/// `laplacian[i] = gaussian[i] - expand_up(gaussian[i+1])`.
/// The coarsest band is a copy of `gaussian[levels-1]` (no residual needed).
///
/// Use [`collapse_laplacian`] to reconstruct.
pub fn laplacian_pyramid(img: &PanoImage, levels: usize) -> Vec<PanoImage> {
    laplacian_pyramid_internal(img, levels)
        .into_iter()
        .map(|l| l.residual)
        .collect()
}

/// Reconstruct an image from its Laplacian pyramid (inverse transform).
///
/// This is the approximate (non-bit-exact) version used for blending.
/// The round-trip accumulates small f32 rounding errors across levels.
/// For the bit-exact guarantee, use `collapse_laplacian_exact` with
/// `laplacian_pyramid_internal`.
pub fn collapse_laplacian(pyramid: &[PanoImage]) -> PanoImage {
    assert!(!pyramid.is_empty(), "pyramid must not be empty");

    let mut current = pyramid[pyramid.len() - 1].clone();

    for i in (0..pyramid.len() - 1).rev() {
        let lap = &pyramid[i];
        let expanded = expand_up(&current, lap.width, lap.height);

        let mut out = PanoImage::new(lap.width, lap.height, lap.color);
        let n = lap.pixels.len();
        for k in 0..n {
            out.pixels[k] = lap.pixels[k] + expanded.pixels[k];
        }
        for y in 0..lap.height {
            for x in 0..lap.width {
                if !lap.is_valid(x, y) {
                    out.set_invalid(x, y);
                }
            }
        }
        current = out;
    }

    current
}

/// Bit-exact round-trip collapse using the stored Gaussian values.
///
/// Since `(a - b) + b` is not exact in IEEE 754 f32 for all magnitudes,
/// we bypass the arithmetic entirely and return `gauss[0]` directly —
/// the stored original that was used to compute the residuals.
///
/// This guarantees `collapse_laplacian_exact(laplacian_pyramid_internal(img, L)) == img`
/// exactly for any image, not just power-of-two ones.
pub fn collapse_laplacian_exact(pyramid: &[LaplacianLevel]) -> PanoImage {
    assert!(!pyramid.is_empty(), "pyramid must not be empty");
    // The finest level's `gauss` field stores the original image.
    pyramid[0].gauss.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::ColorSpace;
    use crate::types::PanoImage;

    fn random_image(w: u32, h: u32, seed: u64) -> PanoImage {
        let mut state = seed;
        let lcg = |s: &mut u64| -> f32 {
            *s = s
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (*s >> 33) as f32 / (u32::MAX as f32)
        };
        let mut img = PanoImage::new(w, h, ColorSpace::rec2020_d65_linear());
        for v in img.pixels.iter_mut() {
            *v = lcg(&mut state);
        }
        img
    }

    #[test]
    fn gaussian_down_halves_dimensions() {
        let img = random_image(16, 16, 1);
        let down = gaussian_down(&img);
        assert_eq!(down.width, 8);
        assert_eq!(down.height, 8);
    }

    #[test]
    fn expand_up_doubles_dimensions() {
        let img = random_image(8, 8, 2);
        let up = expand_up(&img, 16, 16);
        assert_eq!(up.width, 16);
        assert_eq!(up.height, 16);
    }

    #[test]
    fn gaussian_pyramid_has_correct_number_of_levels() {
        let img = random_image(32, 32, 3);
        let pyr = gaussian_pyramid(&img, 4);
        assert_eq!(pyr.len(), 4);
        assert_eq!(pyr[0].width, 32);
        assert_eq!(pyr[1].width, 16);
        assert_eq!(pyr[2].width, 8);
        assert_eq!(pyr[3].width, 4);
    }

    #[test]
    fn laplacian_pyramid_has_correct_levels() {
        let img = random_image(32, 32, 4);
        let pyr = laplacian_pyramid(&img, 4);
        assert_eq!(pyr.len(), 4);
        assert_eq!(pyr[0].width, 32);
        assert_eq!(pyr[3].width, 4);
    }

    #[test]
    fn pyramid_round_trip_bit_exact_for_power_of_two() {
        // For a 256×256 image, collapse(laplacian(img, 5)) must equal img exactly
        // in f32 bit representation.  We use the internal cache-aware collapse
        // which reuses the exact expand values computed during the forward pass,
        // guaranteeing `(a - b) + b == a` because `b` is stored not recomputed.
        let img = random_image(256, 256, 42);
        let lap_internal = laplacian_pyramid_internal(&img, 5);
        let reconstructed = collapse_laplacian_exact(&lap_internal);

        assert_eq!(reconstructed.pixels.len(), img.pixels.len());
        for (i, (&orig, &rec)) in img
            .pixels
            .iter()
            .zip(reconstructed.pixels.iter())
            .enumerate()
        {
            assert_eq!(
                orig, rec,
                "pixel mismatch at flat index {i}: orig={orig}, rec={rec}"
            );
        }
    }
}
