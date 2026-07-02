use crate::cancel::CancelToken;
use crate::image::{CfaPattern, ColorSpace, Image};
use rayon::prelude::*;

/// Bilinear demosaic per spec § 3.3.1. Input must be `CameraNativeMosaic`.
/// Output is `CameraNativeLinearRgb` with all three channels populated.
///
/// Non-cancellable wrapper — forwards to [`bilinear_cancellable`] with a
/// never-cancel token, so its output is bit-identical to the pre-#951 kernel.
#[inline]
pub fn bilinear(mosaic: &Image, cfa: CfaPattern) -> Image {
    bilinear_cancellable(mosaic, cfa, CancelToken::never())
}

/// Cancellable variant of [`bilinear`]. Identical math; additionally checks
/// `cancel` at the top of each parallel row closure and skips that row's
/// fill when cancellation is requested (a rayon parallel iterator can't
/// `break`, so already-scheduled rows return immediately and the rest are
/// skipped). The resulting partially-filled buffer is discarded by the
/// develop chain, which returns `Err(Cancelled)` right after demosaic. With
/// a never-cancel token the per-row load is a no-op branch and the output is
/// bit-identical to [`bilinear`].
pub fn bilinear_cancellable(mosaic: &Image, cfa: CfaPattern, cancel: CancelToken<'_>) -> Image {
    mosaic.assert_space(ColorSpace::CameraNativeMosaic);
    let w = mosaic.width as i32;
    let h = mosaic.height as i32;
    let w_usize = mosaic.width as usize;
    let mut out = Image::new(
        mosaic.width,
        mosaic.height,
        ColorSpace::CameraNativeLinearRgb,
    );

    // Zero-dim input: return the empty image rather than reaching
    // `par_chunks_mut(0)`, which panics ("chunk_size must not be zero").
    // Unreachable via `decode_bytes` — it rejects sub-2×2 sensors (#1087)
    // — so this is defense in depth for direct callers.
    if mosaic.width == 0 || mosaic.height == 0 {
        return out;
    }

    let sample = |x: i32, y: i32, channel: usize| -> f32 {
        // Mirror-reflect borders.
        let mx = if x < 0 {
            -x
        } else if x >= w {
            2 * (w - 1) - x
        } else {
            x
        };
        let my = if y < 0 {
            -y
        } else if y >= h {
            2 * (h - 1) - y
        } else {
            y
        };
        mosaic.pixels[(my as usize) * w_usize + (mx as usize)][channel]
    };

    out.pixels
        .par_chunks_mut(w_usize)
        .enumerate()
        .for_each(|(y_idx, row)| {
            // Per-row cancel check. Skipping the fill leaves this row at its
            // zero-init value; the develop chain discards the whole buffer.
            if cancel.is_cancelled() {
                return;
            }
            let y = y_idx as i32;
            for (x_idx, px) in row.iter_mut().enumerate() {
                let x = x_idx as i32;
                let color = cfa.color_at(x as u32, y as u32) as usize;
                let mut rgb = [0.0f32; 3];
                // Center-channel is whatever was sampled.
                rgb[color] = sample(x, y, color);

                match color {
                    0 | 2 => {
                        // R or B known; interpolate G as 4-neighbor average and
                        // the opposite chroma as 4-diagonal average.
                        rgb[1] = (sample(x - 1, y, 1)
                            + sample(x + 1, y, 1)
                            + sample(x, y - 1, 1)
                            + sample(x, y + 1, 1))
                            * 0.25;
                        let other = if color == 0 { 2 } else { 0 };
                        rgb[other] = (sample(x - 1, y - 1, other)
                            + sample(x + 1, y - 1, other)
                            + sample(x - 1, y + 1, other)
                            + sample(x + 1, y + 1, other))
                            * 0.25;
                    }
                    1 => {
                        // G known; determine horizontal vs vertical neighbors for R and B.
                        // In any Bayer pattern, at a G position one axis is R and the other is B.
                        let horiz = cfa.color_at(x as u32 + 1, y as u32) as usize;
                        let vert = cfa.color_at(x as u32, y as u32 + 1) as usize;
                        // horiz channel is average of horizontal neighbors; vert channel
                        // is average of vertical neighbors.
                        rgb[horiz] = (sample(x - 1, y, horiz) + sample(x + 1, y, horiz)) * 0.5;
                        rgb[vert] = (sample(x, y - 1, vert) + sample(x, y + 1, vert)) * 0.5;
                    }
                    _ => unreachable!(),
                }
                *px = rgb;
            }
        });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a 4×4 RGGB mosaic with constant channel values.
    fn constant_mosaic(r: f32, g: f32, b: f32) -> Image {
        let mut img = Image::new(4, 4, ColorSpace::CameraNativeMosaic);
        let cfa = CfaPattern::Rggb;
        for y in 0..4u32 {
            for x in 0..4u32 {
                let c = cfa.color_at(x, y) as usize;
                let v = match c {
                    0 => r,
                    1 => g,
                    2 => b,
                    _ => 0.0,
                };
                img.pixels[(y * 4 + x) as usize][c] = v;
            }
        }
        img
    }

    /// Regression test for #1087 — a zero-width mosaic must return an
    /// empty image, not panic in `par_chunks_mut(0)` ("chunk_size must
    /// not be zero"). `decode_bytes` rejects sub-2×2 sensors, so this
    /// pins the defense-in-depth guard for direct callers.
    #[test]
    fn zero_width_mosaic_returns_empty_image_without_panicking() {
        let mosaic = Image::new(0, 4, ColorSpace::CameraNativeMosaic);
        let out = bilinear(&mosaic, CfaPattern::Rggb);
        assert_eq!((out.width, out.height), (0, 4));
        assert!(out.pixels.is_empty());
    }

    #[test]
    fn constant_mosaic_produces_constant_rgb() {
        let mosaic = constant_mosaic(0.4, 0.5, 0.6);
        let out = bilinear(&mosaic, CfaPattern::Rggb);
        for p in &out.pixels {
            assert!((p[0] - 0.4).abs() < 1e-5, "R was {}", p[0]);
            assert!((p[1] - 0.5).abs() < 1e-5, "G was {}", p[1]);
            assert!((p[2] - 0.6).abs() < 1e-5, "B was {}", p[2]);
        }
    }

    #[test]
    fn output_space_is_camera_native_rgb() {
        let mosaic = constant_mosaic(0.1, 0.1, 0.1);
        let out = bilinear(&mosaic, CfaPattern::Rggb);
        assert_eq!(out.space, ColorSpace::CameraNativeLinearRgb);
    }

    #[test]
    fn bggr_pattern_also_works() {
        let mut mosaic = Image::new(4, 4, ColorSpace::CameraNativeMosaic);
        let cfa = CfaPattern::Bggr;
        for y in 0..4u32 {
            for x in 0..4u32 {
                let c = cfa.color_at(x, y) as usize;
                let v = match c {
                    0 => 0.7,
                    1 => 0.5,
                    2 => 0.3,
                    _ => 0.0,
                };
                mosaic.pixels[(y * 4 + x) as usize][c] = v;
            }
        }
        let out = bilinear(&mosaic, CfaPattern::Bggr);
        for p in &out.pixels {
            assert!((p[0] - 0.7).abs() < 1e-5);
            assert!((p[1] - 0.5).abs() < 1e-5);
            assert!((p[2] - 0.3).abs() < 1e-5);
        }
    }

    #[test]
    fn border_pixel_has_plausible_values() {
        // A single-pixel bright spot in an otherwise-dark frame — the
        // interpolated neighbors must exist (mirror borders) rather than panic.
        let mut mosaic = Image::new(4, 4, ColorSpace::CameraNativeMosaic);
        // top-left position (0,0) on RGGB is R; set it high.
        mosaic.pixels[0][0] = 1.0;
        let out = bilinear(&mosaic, CfaPattern::Rggb);
        assert!(out.pixels[0][0] > 0.9); // R survived
        assert!(out.pixels[0][1].is_finite()); // no NaN
        assert!(out.pixels[0][2].is_finite());
    }
}
