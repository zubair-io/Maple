//! `rotate` on `RasterImage` (#3501, task B3). Split out of `raster_geometry`
//! to keep that file under budget — same pattern as `raster_orient` being
//! split out of `raster.rs`.

use crate::error::{Error, Result};
use crate::raster::RasterImage;

impl RasterImage {
    /// Rotate clockwise by `degrees`. Multiples of 90 are exact pixel moves;
    /// every other angle resamples bilinearly into the rotated bounding box,
    /// with `background` outside the source. Matches sharp's normalisation:
    /// the angle is reduced to a positive `[0, 360)` rotation first, so -450
    /// is 270.
    pub fn rotate(&self, degrees: f64, background: [u8; 4]) -> Result<Self> {
        if !degrees.is_finite() {
            return Err(Error::Decode {
                path: "<memory>".into(),
                reason: format!("rotate: angle must be finite (got {degrees})"),
            });
        }
        let normalised = degrees.rem_euclid(360.0);
        if (normalised - normalised.round()).abs() < 1e-9 {
            let quadrant = normalised.round() as i64 % 360;
            match quadrant {
                0 => return Ok(self.clone()),
                90 => return Ok(self.transpose().flop()),
                180 => return Ok(self.flip().flop()),
                270 => return Ok(self.transpose().flip()),
                _ => {}
            }
        }
        self.rotate_bilinear(normalised, background)
    }

    /// Reflect across the main diagonal: `(x, y) -> (y, x)`. Combined with a
    /// mirror this gives the exact 90 and 270 turns without resampling.
    fn transpose(&self) -> Self {
        let c = self.channels as usize;
        let (w, h) = (self.width as usize, self.height as usize);
        let data = (0..w)
            .flat_map(|x| {
                (0..h).flat_map(move |y| {
                    let i = (y * w + x) * c;
                    self.data[i..i + c].iter().copied()
                })
            })
            .collect();
        Self {
            width: self.height,
            height: self.width,
            data,
            ..self.clone()
        }
    }

    /// Bilinear-resamples into the rotated bounding box. On a 4-channel
    /// source every sample is done in premultiplied space — each of the
    /// four bilinear corners has its colour scaled by its own alpha (an
    /// out-of-source corner uses `background`'s colour and alpha) before
    /// the weighted sum, and the result is unpremultiplied afterwards.
    /// Blending straight (unpremultiplied) colour would let a fully
    /// transparent neighbour's colour leak into a partially-covered edge
    /// pixel — visible as the neighbour's hue bleeding in, or the pixel
    /// darkening toward the background, even though that neighbour
    /// contributes nothing visible on its own. Matches libvips, which
    /// premultiplies before `vips_affine`/`vips_rotate` and unpremultiplies
    /// after. A 3-channel source has no alpha to weight by, so it stays a
    /// plain per-channel bilinear blend against `background`.
    fn rotate_bilinear(&self, degrees: f64, background: [u8; 4]) -> Result<Self> {
        let src = if background[3] == 255 {
            self.clone()
        } else {
            self.ensure_alpha(255)
        };
        let c = src.channels as usize;
        let theta = degrees.to_radians();
        let (sin, cos) = theta.sin_cos();
        let (sw, sh) = (src.width as f64, src.height as f64);
        // `.ceil()`, not `.round()`: the bounding box must fully contain the
        // rotated rectangle, so a fractional pixel of overhang (e.g. 10x10 at
        // 45° needs 14.14px and must round up to 15, not down to 14) rounds
        // up rather than to the nearest integer.
        let out_w = (sw * cos.abs() + sh * sin.abs()).ceil().max(1.0);
        let out_h = (sw * sin.abs() + sh * cos.abs()).ceil().max(1.0);
        if out_w > u32::MAX as f64 || out_h > u32::MAX as f64 {
            return Err(Error::Decode {
                path: "<memory>".into(),
                reason: format!("rotation by {degrees}° overflows the output dimensions"),
            });
        }
        let (cx_src, cy_src) = (sw / 2.0, sh / 2.0);
        let (cx_dst, cy_dst) = (out_w / 2.0, out_h / 2.0);
        let width = out_w as u32;
        let height = out_h as u32;
        // The four bilinear corners around source-space point (x, y), as
        // (corner_x, corner_y, weight).
        let corner_weights = |x: f64, y: f64| -> [(f64, f64, f64); 4] {
            let x0 = x.floor();
            let y0 = y.floor();
            let fx = x - x0;
            let fy = y - y0;
            [
                (x0, y0, (1.0 - fx) * (1.0 - fy)),
                (x0 + 1.0, y0, fx * (1.0 - fy)),
                (x0, y0 + 1.0, (1.0 - fx) * fy),
                (x0 + 1.0, y0 + 1.0, fx * fy),
            ]
        };
        // A source sample, or `None` off the edge of the source (the caller
        // substitutes `background` there).
        let at = |xi: f64, yi: f64, ch: usize| -> Option<f64> {
            if xi < 0.0 || yi < 0.0 || xi >= sw || yi >= sh {
                None
            } else {
                let idx = ((yi as usize) * src.width as usize + xi as usize) * c + ch;
                Some(src.data[idx] as f64)
            }
        };
        let has_alpha = c == 4;
        let alpha_ch = c - 1;
        let data = (0..height)
            .flat_map(|dy| {
                (0..width).flat_map(move |dx| {
                    // Inverse-map the destination centre back into the source.
                    let rx = dx as f64 + 0.5 - cx_dst;
                    let ry = dy as f64 + 0.5 - cy_dst;
                    let sx = rx * cos + ry * sin + cx_src - 0.5;
                    let sy = -rx * sin + ry * cos + cy_src - 0.5;
                    let outside = sx < -0.5 || sy < -0.5 || sx > sw - 0.5 || sy > sh - 0.5;
                    let pixel: Vec<u8> = if outside {
                        background[..c].to_vec()
                    } else if has_alpha {
                        let corners = corner_weights(sx, sy);
                        let alphas: Vec<f64> = corners
                            .iter()
                            .map(|&(xi, yi, _)| {
                                at(xi, yi, alpha_ch).unwrap_or(background[3] as f64)
                            })
                            .collect();
                        let alpha_sum: f64 = corners
                            .iter()
                            .zip(&alphas)
                            .map(|(&(_, _, w), &a)| w * a)
                            .sum();
                        let mut px = Vec::with_capacity(c);
                        for ch in 0..alpha_ch {
                            let premultiplied: f64 = corners
                                .iter()
                                .zip(&alphas)
                                .map(|(&(xi, yi, w), &a)| {
                                    let v = at(xi, yi, ch).unwrap_or(background[ch] as f64);
                                    w * v * a / 255.0
                                })
                                .sum();
                            let value = if alpha_sum <= 0.0 {
                                0.0
                            } else {
                                premultiplied * 255.0 / alpha_sum
                            };
                            px.push(value.round().clamp(0.0, 255.0) as u8);
                        }
                        px.push(alpha_sum.round().clamp(0.0, 255.0) as u8);
                        px
                    } else {
                        let corners = corner_weights(sx, sy);
                        (0..c)
                            .map(|ch| {
                                let v: f64 = corners
                                    .iter()
                                    .map(|&(xi, yi, w)| {
                                        w * at(xi, yi, ch).unwrap_or(background[ch] as f64)
                                    })
                                    .sum();
                                v.round().clamp(0.0, 255.0) as u8
                            })
                            .collect()
                    };
                    pixel.into_iter()
                })
            })
            .collect();
        Ok(Self {
            width,
            height,
            channels: src.channels,
            data,
            orientation: src.orientation,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 3x2 RGB with a distinct value per pixel, so a transform that swaps
    /// rows or columns is visible in the bytes. Duplicated from
    /// `raster_geometry::tests` — small enough that sharing it across the
    /// two test modules isn't worth a `pub(crate)` test-support export.
    fn ramp_rgb() -> RasterImage {
        RasterImage::new_rgb(
            3,
            2,
            vec![
                1, 1, 1, 2, 2, 2, 3, 3, 3, // row 0
                4, 4, 4, 5, 5, 5, 6, 6, 6, // row 1
            ],
        )
    }

    fn firsts(img: &RasterImage) -> Vec<u8> {
        img.data
            .chunks_exact(img.channels as usize)
            .map(|p| p[0])
            .collect()
    }

    #[test]
    fn rotate_90_transposes_and_swaps_the_dimensions() {
        // 3x2 ramp rotated 90° clockwise is 2x3:
        //   4 1 / 5 2 / 6 3
        let out = ramp_rgb().rotate(90.0, [0, 0, 0, 255]).unwrap();
        assert_eq!((out.width, out.height), (2, 3));
        assert_eq!(firsts(&out), vec![4, 1, 5, 2, 6, 3]);
    }

    #[test]
    fn rotate_180_reverses_the_pixel_order() {
        let out = ramp_rgb().rotate(180.0, [0, 0, 0, 255]).unwrap();
        assert_eq!((out.width, out.height), (3, 2));
        assert_eq!(firsts(&out), vec![6, 5, 4, 3, 2, 1]);
    }

    #[test]
    fn rotate_270_is_the_inverse_of_90() {
        let src = ramp_rgb();
        let there_and_back = src
            .rotate(90.0, [0, 0, 0, 255])
            .unwrap()
            .rotate(270.0, [0, 0, 0, 255])
            .unwrap();
        assert_eq!((there_and_back.width, there_and_back.height), (3, 2));
        assert_eq!(there_and_back.data, src.data);
    }

    #[test]
    fn a_negative_angle_normalises_the_same_way_sharp_documents() {
        // sharp: "-450 will produce a 270 degree rotation".
        let a = ramp_rgb().rotate(-450.0, [0, 0, 0, 255]).unwrap();
        let b = ramp_rgb().rotate(270.0, [0, 0, 0, 255]).unwrap();
        assert_eq!(a.data, b.data);
    }

    #[test]
    fn rotate_0_is_identity() {
        let src = ramp_rgb();
        assert_eq!(src.rotate(0.0, [0, 0, 0, 255]).unwrap().data, src.data);
    }

    #[test]
    fn an_arbitrary_angle_grows_the_bounding_box_and_fills_with_background() {
        let src = RasterImage::new_rgb(10, 10, vec![200; 10 * 10 * 3]);
        let out = src.rotate(45.0, [7, 8, 9, 255]).unwrap();
        // A 10x10 square rotated 45° needs a 15x15 box (10·√2 ≈ 14.14 → 15).
        assert_eq!((out.width, out.height), (15, 15));
        // The top-left corner is outside the rotated square: background.
        assert_eq!(&out.data[..3], &[7, 8, 9]);
        // The centre is inside it: the source value.
        let centre = ((7 * 15 + 7) * 3) as usize;
        assert_eq!(&out.data[centre..centre + 3], &[200, 200, 200]);
    }

    #[test]
    fn an_arbitrary_angle_with_a_transparent_background_produces_rgba() {
        let src = RasterImage::new_rgb(4, 4, vec![100; 4 * 4 * 3]);
        let out = src.rotate(30.0, [0, 0, 0, 0]).unwrap();
        assert_eq!(out.channels, 4);
        assert_eq!(
            out.data[3], 0,
            "the corner outside the rotated square is transparent"
        );
    }

    #[test]
    fn rotate_preserves_alpha_on_a_quadrant_turn() {
        let rgba = RasterImage::new_rgba(2, 1, vec![1, 1, 1, 10, 2, 2, 2, 20]);
        let out = rgba.rotate(90.0, [0, 0, 0, 255]).unwrap();
        assert_eq!((out.width, out.height, out.channels), (1, 2, 4));
        assert_eq!(out.data, vec![1, 1, 1, 10, 2, 2, 2, 20]);
    }

    #[test]
    fn rotate_rejects_a_nan_angle() {
        assert!(ramp_rgb().rotate(f64::NAN, [0, 0, 0, 255]).is_err());
    }

    #[test]
    fn rotate_rejects_positive_infinity() {
        assert!(ramp_rgb().rotate(f64::INFINITY, [0, 0, 0, 255]).is_err());
    }

    #[test]
    fn rotate_rejects_negative_infinity() {
        assert!(ramp_rgb()
            .rotate(f64::NEG_INFINITY, [0, 0, 0, 255])
            .is_err());
    }

    #[test]
    fn arbitrary_angle_resamples_premultiplied_so_transparency_does_not_bleed_colour() {
        // Left column opaque red, right column fully transparent green. A
        // straight (unpremultiplied) blend would pull red edge pixels
        // toward green or toward black (the background) as the transparent
        // column's neighbour is mixed in; a premultiplied blend only ever
        // dilutes red's opacity, never its hue or brightness.
        let src = RasterImage::new_rgba(
            2,
            2,
            vec![
                255, 0, 0, 255, 0, 255, 0, 0, // row 0: opaque red | transparent green
                255, 0, 0, 255, 0, 255, 0, 0, // row 1: opaque red | transparent green
            ],
        );
        let out = src.rotate(1.0, [0, 0, 0, 0]).unwrap();
        for px in out.data.chunks_exact(4) {
            let (r, g, a) = (px[0], px[1], px[3]);
            if a > 0 {
                assert!(
                    r >= 254,
                    "red channel darkened toward the background: {px:?}"
                );
                assert!(
                    g <= 1,
                    "green bled in from the transparent neighbour: {px:?}"
                );
            }
        }
    }
}
