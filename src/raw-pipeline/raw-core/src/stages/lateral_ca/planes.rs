//! The three geometry helpers `lateral_ca` estimates and resamples through:
//! the dense green reference, the per-channel sampler, and the radial frame.
//!
//! Split out of the parent module for the 600-LOC file budget (#1181).
//!
//! ## Why two sampler flavours
//!
//! On a Bayer CFA the sites of one colour form an exact rectangular lattice
//! (origin inside the 2×2 cell, stride 2 both ways), so bilinear
//! interpolation over that lattice reproduces the stored sample *exactly*
//! at every site — the best possible reconstruction, and what RawTherapee's
//! raw CA correction uses. X-Trans scatters red and blue across eight
//! irregular phases of a 6×6 tile, where no rectangular lattice exists; a
//! normalised convolution over the surrounding same-colour sites is the
//! honest substitute. Both are only ever consumed as a *difference* by the
//! parent module, never as a replacement value, which is what keeps the
//! X-Trans approximation from ever standing in for a real sample.

use rayon::prelude::*;

use crate::image::{CfaPattern, Image};

/// X-Trans sampler radius, in pixels — one CFA half-period, so every
/// position sees several same-colour sites.
const SPARSE_RADIUS: i32 = 3;

/// Gaussian sigma for the X-Trans normalised convolution, in pixels.
const SPARSE_SIGMA: f32 = 1.5;

/// Dense per-pixel green, the registration reference.
///
/// Green is available at every site of a Bayer quincunx after one
/// four-neighbour average, and at four or more of the eight neighbours of
/// any X-Trans site, so a single nearest-neighbour average is enough for
/// the derivative estimate the fit needs.
pub(super) struct GreenPlane {
    values: Vec<f32>,
    pub(super) width: usize,
    pub(super) height: usize,
}

impl GreenPlane {
    pub(super) fn build(mosaic: &Image, cfa: CfaPattern) -> Self {
        let (w, h) = (mosaic.width as usize, mosaic.height as usize);
        let values = (0..w * h)
            .into_par_iter()
            .map(|i| {
                let (x, y) = (i % w, i / w);
                if cfa.color_at(x as u32, y as u32) == 1 {
                    return mosaic.pixels[i][1];
                }
                let (mut sum, mut n) = (0.0f32, 0u32);
                for (dx, dy) in [(-1i32, 0i32), (1, 0), (0, -1), (0, 1)] {
                    let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                    if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                        continue;
                    }
                    if cfa.color_at(nx as u32, ny as u32) == 1 {
                        sum += mosaic.pixels[ny as usize * w + nx as usize][1];
                        n += 1;
                    }
                }
                if n == 0 {
                    0.0
                } else {
                    sum / n as f32
                }
            })
            .collect();
        Self {
            values,
            width: w,
            height: h,
        }
    }

    #[inline]
    pub(super) fn at(&self, x: usize, y: usize) -> f32 {
        self.values[y * self.width + x]
    }

    /// Central-difference gradient dotted with the unit vector `(ux, uy)`.
    /// Callers guarantee `1 <= x < width-1` and `1 <= y < height-1`.
    #[inline]
    pub(super) fn directional_derivative(&self, x: usize, y: usize, ux: f32, uy: f32) -> f32 {
        let gx = 0.5 * (self.at(x + 1, y) - self.at(x - 1, y));
        let gy = 0.5 * (self.at(x, y + 1) - self.at(x, y - 1));
        ux * gx + uy * gy
    }
}

/// A read-only snapshot of one CFA channel, samplable at continuous image
/// coordinates. See the module docs for why there are two flavours.
pub(super) enum ChannelSampler {
    /// Bayer: an exact rectangular sub-lattice, bilinearly interpolated.
    Rect {
        origin_x: usize,
        origin_y: usize,
        stride: usize,
        cols: usize,
        rows: usize,
        values: Vec<f32>,
    },
    /// X-Trans: a full-resolution plane carrying the channel's value at its
    /// own sites and `NAN` everywhere else, read back through a Gaussian
    /// normalised convolution.
    Sparse {
        values: Vec<f32>,
        width: usize,
        height: usize,
    },
}

impl ChannelSampler {
    /// Snapshot every site of `color`. `None` when the channel has too few
    /// sites for interpolation (a degenerate CFA or a tiny image).
    pub(super) fn build(mosaic: &Image, cfa: CfaPattern, color: u8) -> Option<Self> {
        let (w, h) = (mosaic.width as usize, mosaic.height as usize);
        let c = color as usize;
        if cfa.is_xtrans() {
            let values = (0..w * h)
                .into_par_iter()
                .map(|i| {
                    let (x, y) = (i % w, i / w);
                    if cfa.color_at(x as u32, y as u32) == color {
                        mosaic.pixels[i][c]
                    } else {
                        f32::NAN
                    }
                })
                .collect();
            return Some(Self::Sparse {
                values,
                width: w,
                height: h,
            });
        }
        let (ox, oy) = (0..4).find_map(|i| {
            let (x, y) = (i % 2, i / 2);
            (cfa.color_at(x as u32, y as u32) == color).then_some((x, y))
        })?;
        if ox >= w || oy >= h {
            return None;
        }
        let cols = (w - ox).div_ceil(2);
        let rows = (h - oy).div_ceil(2);
        if cols < 2 || rows < 2 {
            return None;
        }
        let values = (0..cols * rows)
            .into_par_iter()
            .map(|i| {
                let (cx, cy) = (i % cols, i / cols);
                mosaic.pixels[(oy + cy * 2) * w + (ox + cx * 2)][c]
            })
            .collect();
        Some(Self::Rect {
            origin_x: ox,
            origin_y: oy,
            stride: 2,
            cols,
            rows,
            values,
        })
    }

    /// Sample at a continuous image-space position, clamped at the edges.
    #[inline]
    pub(super) fn sample(&self, fx: f32, fy: f32) -> f32 {
        match self {
            Self::Rect {
                origin_x,
                origin_y,
                stride,
                cols,
                rows,
                values,
            } => {
                let u = ((fx - *origin_x as f32) / *stride as f32).clamp(0.0, (cols - 1) as f32);
                let v = ((fy - *origin_y as f32) / *stride as f32).clamp(0.0, (rows - 1) as f32);
                let u0 = u.floor() as usize;
                let v0 = v.floor() as usize;
                let u1 = (u0 + 1).min(cols - 1);
                let v1 = (v0 + 1).min(rows - 1);
                let (tu, tv) = (u - u0 as f32, v - v0 as f32);
                let top =
                    values[v0 * cols + u0] + (values[v0 * cols + u1] - values[v0 * cols + u0]) * tu;
                let bot =
                    values[v1 * cols + u0] + (values[v1 * cols + u1] - values[v1 * cols + u0]) * tu;
                top + (bot - top) * tv
            }
            Self::Sparse {
                values,
                width,
                height,
            } => {
                let cx = fx.clamp(0.0, (*width - 1) as f32);
                let cy = fy.clamp(0.0, (*height - 1) as f32);
                let (ix, iy) = (cx.round() as i32, cy.round() as i32);
                let inv_two_sigma_sq = 1.0 / (2.0 * SPARSE_SIGMA * SPARSE_SIGMA);
                let (mut acc, mut wsum) = (0.0f32, 0.0f32);
                for dy in -SPARSE_RADIUS..=SPARSE_RADIUS {
                    let ny = iy + dy;
                    if ny < 0 || ny >= *height as i32 {
                        continue;
                    }
                    for dx in -SPARSE_RADIUS..=SPARSE_RADIUS {
                        let nx = ix + dx;
                        if nx < 0 || nx >= *width as i32 {
                            continue;
                        }
                        let v = values[ny as usize * width + nx as usize];
                        if v.is_nan() {
                            continue;
                        }
                        let ex = nx as f32 - cx;
                        let ey = ny as f32 - cy;
                        let wt = (-(ex * ex + ey * ey) * inv_two_sigma_sq).exp();
                        acc += wt * v;
                        wsum += wt;
                    }
                }
                if wsum > 0.0 {
                    acc / wsum
                } else {
                    0.0
                }
            }
        }
    }
}

/// Frame geometry shared by the estimate and the resample: the centre the
/// radial field is measured from, and the corner distance normalising it.
#[derive(Clone, Copy)]
pub(super) struct RadialFrame {
    cx: f32,
    cy: f32,
    inv_corner: f32,
}

impl RadialFrame {
    pub(super) fn new(width: usize, height: usize) -> Self {
        let cx = width as f32 * 0.5;
        let cy = height as f32 * 0.5;
        let corner = (cx * cx + cy * cy).sqrt().max(1.0);
        Self {
            cx,
            cy,
            inv_corner: 1.0 / corner,
        }
    }

    /// Outward radial unit vector and normalised radius at a pixel. `None`
    /// within a pixel of the centre, where the direction is undefined.
    #[inline]
    pub(super) fn at(self, x: f32, y: f32) -> Option<(f32, f32, f32)> {
        let dx = x - self.cx;
        let dy = y - self.cy;
        let r = (dx * dx + dy * dy).sqrt();
        (r > 1.0).then(|| (dx / r, dy / r, r * self.inv_corner))
    }
}
