//! Multi-band Laplacian blending (spec §5.8), CPU reference path
//! (eng design D6 — this implementation later gates the WGSL port).
//!
//! Same Burt–Adelson construction as the superseded PR #17 reference
//! (`pano-core/src/blend/{pyramid,multi_band}.rs`), re-derived for the
//! planar [`PlanarImage`] layout rather than transliterated:
//!
//! - Gaussian pyramid with the separable binomial kernel `[1,4,6,4,1]`,
//!   **validity-weighted**: taps renormalize over the valid support, so
//!   masked-out regions never bleed value into the blend and validity
//!   propagates through every level (spec: "validity masks propagate
//!   through the pyramid").
//! - Laplacian levels `L_k = G_k − expand(G_{k+1})`, base = coarsest
//!   Gaussian.
//! - Per-frame weights are blurred through the same pyramid, and each
//!   Laplacian level accumulates `Σ wᵢ·Lᵢ / Σ wᵢ` before the collapse.
//!
//! Band count policy (spec §5.8): `log2(min overlap width)` capped at
//! [`MAX_LEVELS`] — computed by the caller from seam-mask overlap
//! statistics ([`levels_for_overlap_width`]).
//!
//! Determinism: pure sequential per-plane arithmetic in row-major
//! order; identical inputs produce identical bytes on a given platform
//! + toolchain.

use std::ops::Range;

use crate::ingest::{PlanarImage, ValidityMask};

/// Spec cap on pyramid depth.
pub const MAX_LEVELS: usize = 7;

/// Spec §5.8 band-count rule: `log2(min overlap width)`, clamped to
/// `[1, MAX_LEVELS]`.
pub fn levels_for_overlap_width(min_overlap_px: usize) -> usize {
    if min_overlap_px <= 2 {
        return 1;
    }
    (((min_overlap_px as f64).log2()).floor() as usize).clamp(1, MAX_LEVELS)
}

/// One mono plane + weight (validity carried as a 0/1 weight plane so
/// pyramid arithmetic is uniform).
#[derive(Clone)]
struct WeightedPlane {
    w: usize,
    h: usize,
    v: Vec<f32>,
    /// Valid-support weight in `[0, 1]` per pixel.
    a: Vec<f32>,
}

const KERNEL: [f32; 5] = [1.0, 4.0, 6.0, 4.0, 1.0];

impl WeightedPlane {
    fn down(&self) -> WeightedPlane {
        let (dw, dh) = (self.w.div_ceil(2), self.h.div_ceil(2));
        // Horizontal then vertical, sampling even coordinates.
        let mut hv = vec![0.0_f32; dw * self.h];
        let mut ha = vec![0.0_f32; dw * self.h];
        for y in 0..self.h {
            for dx in 0..dw {
                let cx = (dx * 2) as isize;
                let (mut sv, mut sa) = (0.0_f32, 0.0_f32);
                for (k, &kw) in KERNEL.iter().enumerate() {
                    let x = cx + k as isize - 2;
                    if x < 0 || x >= self.w as isize {
                        continue;
                    }
                    let i = y * self.w + x as usize;
                    sv += kw * self.a[i] * self.v[i];
                    sa += kw * self.a[i];
                }
                let o = y * dw + dx;
                if sa > 0.0 {
                    hv[o] = sv / sa;
                    ha[o] = sa / 16.0; // kernel sum
                }
            }
        }
        let mut ov = vec![0.0_f32; dw * dh];
        let mut oa = vec![0.0_f32; dw * dh];
        for dy in 0..dh {
            let cy = (dy * 2) as isize;
            for x in 0..dw {
                let (mut sv, mut sa) = (0.0_f32, 0.0_f32);
                for (k, &kw) in KERNEL.iter().enumerate() {
                    let y = cy + k as isize - 2;
                    if y < 0 || y >= self.h as isize {
                        continue;
                    }
                    let i = y as usize * dw + x;
                    sv += kw * ha[i] * hv[i];
                    sa += kw * ha[i];
                }
                let o = dy * dw + x;
                if sa > 0.0 {
                    ov[o] = sv / sa;
                    oa[o] = (sa / 16.0).min(1.0);
                }
            }
        }
        WeightedPlane {
            w: dw,
            h: dh,
            v: ov,
            a: oa,
        }
    }

    /// Bilinear expand to `(tw, th)` (the inverse of the even-coordinate
    /// down-sampling grid), weight-aware.
    fn up(&self, tw: usize, th: usize) -> WeightedPlane {
        let mut ov = vec![0.0_f32; tw * th];
        let mut oa = vec![0.0_f32; tw * th];
        for ty in 0..th {
            let fy = ty as f32 * 0.5;
            let y0 = fy.floor() as usize;
            let y1 = (y0 + 1).min(self.h - 1);
            let wy = fy - y0 as f32;
            for tx in 0..tw {
                let fx = tx as f32 * 0.5;
                let x0 = fx.floor() as usize;
                let x1 = (x0 + 1).min(self.w - 1);
                let wx = fx - x0 as f32;
                let idx = [
                    (y0 * self.w + x0, (1.0 - wy) * (1.0 - wx)),
                    (y0 * self.w + x1, (1.0 - wy) * wx),
                    (y1 * self.w + x0, wy * (1.0 - wx)),
                    (y1 * self.w + x1, wy * wx),
                ];
                let (mut sv, mut sa) = (0.0_f32, 0.0_f32);
                for (i, kw) in idx {
                    sv += kw * self.a[i] * self.v[i];
                    sa += kw * self.a[i];
                }
                let o = ty * tw + tx;
                if sa > 0.0 {
                    ov[o] = sv / sa;
                    oa[o] = sa.min(1.0);
                }
            }
        }
        WeightedPlane {
            w: tw,
            h: th,
            v: ov,
            a: oa,
        }
    }
}

/// Streaming form of the per-level `Σ wᵢ·Lᵢ / Σ wᵢ` accumulation: each
/// layer's pyramid is built, folded in and dropped, so peak memory is the
/// accumulator plus one layer's pyramid rather than every layer's at once.
pub(crate) struct BandAccumulator {
    dims: Vec<(usize, usize)>,
    num: Vec<[Vec<f32>; 3]>,
    den: Vec<Vec<f32>>,
}

impl BandAccumulator {
    pub(crate) fn new(w: usize, h: usize, levels: usize) -> Self {
        let dims: Vec<(usize, usize)> = (0..levels.clamp(1, MAX_LEVELS))
            .scan((w, h), |d, _| {
                let level = *d;
                *d = (d.0.div_ceil(2), d.1.div_ceil(2));
                Some(level)
            })
            .collect();
        let num = dims
            .iter()
            .map(|&(lw, lh)| std::array::from_fn(|_| vec![0.0_f32; lw * lh]))
            .collect();
        let den = dims
            .iter()
            .map(|&(lw, lh)| vec![0.0_f32; lw * lh])
            .collect();
        BandAccumulator { dims, num, den }
    }

    pub(crate) fn levels(&self) -> usize {
        self.dims.len()
    }

    /// Fold `layer` (accumulator-shaped) in over the column band `cols`.
    ///
    /// Exact against a full-width add only when `cols.start` sits on the
    /// coarsest level's sample grid and the layer's weight is zero within a
    /// pyramid support of either band edge — callers widen the band to
    /// guarantee both.
    pub(crate) fn add(&mut self, layer: &PlanarImage, weight: &[f32], cols: Range<usize>) {
        let (w, h) = (self.dims[0].0, self.dims[0].1);
        assert_eq!((layer.width() as usize, layer.height() as usize), (w, h));
        assert_eq!(weight.len(), w * h, "weight plane length");
        let levels = self.levels();
        let x0 = cols.start;
        assert_eq!(
            x0 % (1 << (levels - 1)),
            0,
            "band start off the coarse grid"
        );
        let bw = cols.len();
        let n = bw * h;
        let src = |i: usize| (i / bw) * w + x0 + i % bw;
        let valid01: Vec<f32> = (0..n)
            .map(|i| {
                let j = src(i);
                if layer.validity.get((j % w) as u32, (j / w) as u32) {
                    1.0
                } else {
                    0.0
                }
            })
            .collect();
        let weight0: Vec<f32> = (0..n)
            .map(|i| (weight[src(i)] * valid01[i]).max(0.0))
            .collect();
        let wg = pyramid(
            WeightedPlane {
                w: bw,
                h,
                v: weight0,
                a: vec![1.0; n],
            },
            levels,
        );

        for (c, plane) in [&layer.r, &layer.g, &layer.b].into_iter().enumerate() {
            let gauss = pyramid(
                WeightedPlane {
                    w: bw,
                    h,
                    v: (0..n).map(|i| plane[src(i)]).collect(),
                    a: valid01.clone(),
                },
                levels,
            );
            for k in 0..levels {
                let g = &gauss[k];
                let coarse = (k + 1 < levels).then(|| gauss[k + 1].up(g.w, g.h));
                let (aw, xk) = (self.dims[k].0, x0 >> k);
                for y in 0..g.h {
                    for x in 0..g.w {
                        let i = y * g.w + x;
                        // Detail is defined only where the level itself is
                        // defined; the upsampled coarse is weight-renormalized.
                        let lap = coarse.as_ref().map_or(g.v[i], |up| g.v[i] - up.v[i]);
                        let wv = wg[k].v[i] * g.a[i];
                        let o = y * aw + xk + x;
                        self.num[k][c][o] += wv * lap;
                        if c == 0 {
                            self.den[k][o] += wv;
                        }
                    }
                }
            }
        }
    }

    /// Normalize every level and collapse base → fine into r, g, b planes.
    pub(crate) fn collapse(self) -> [Vec<f32>; 3] {
        let BandAccumulator { dims, num, den } = self;
        let mut num = num;
        std::array::from_fn(|c| {
            let mut acc: Option<WeightedPlane> = None;
            for k in (0..dims.len()).rev() {
                let (lw, lh) = dims[k];
                let num_k = std::mem::take(&mut num[k][c]);
                let (v, a): (Vec<f32>, Vec<f32>) = num_k
                    .iter()
                    .zip(&den[k])
                    .map(|(&nv, &d)| if d > 0.0 { (nv / d, 1.0) } else { (0.0, 0.0) })
                    .unzip();
                let level = WeightedPlane { w: lw, h: lh, v, a };
                acc = Some(match acc {
                    None => level,
                    Some(coarse) => {
                        let up = coarse.up(lw, lh);
                        let mut out = level;
                        for i in 0..out.v.len() {
                            if out.a[i] > 0.0 {
                                out.v[i] += up.v[i];
                            }
                        }
                        out
                    }
                });
            }
            acc.expect("levels >= 1").v
        })
    }
}

fn pyramid(base: WeightedPlane, levels: usize) -> Vec<WeightedPlane> {
    let mut out = vec![base];
    for _ in 1..levels {
        let next = out.last().expect("non-empty").down();
        out.push(next);
    }
    out
}

/// Multi-band blend of `layers` (full-canvas frames from
/// [`crate::warp::warp_to_canvas`]) under per-frame seam weights
/// (`weights[i]`, length = canvas pixels, ≥ 0; typically the hard
/// ownership masks from the seam stage). Pixels where no frame has
/// weight *and* validity end up invalid.
///
/// Panics when shapes disagree; `layers` must be non-empty.
pub fn blend_multiband(layers: &[PlanarImage], weights: &[Vec<f32>], levels: usize) -> PlanarImage {
    assert!(!layers.is_empty(), "blend needs at least one layer");
    assert_eq!(layers.len(), weights.len(), "one weight plane per layer");
    let (w, h) = (layers[0].width(), layers[0].height());
    let n = (w as usize) * (h as usize);
    for (l, wt) in layers.iter().zip(weights) {
        assert_eq!((l.width(), l.height()), (w, h), "layer shape");
        assert_eq!(wt.len(), n, "weight plane length");
    }

    let mut acc = BandAccumulator::new(w as usize, h as usize, levels);
    for (layer, wt) in layers.iter().zip(weights) {
        acc.add(layer, wt, 0..w as usize);
    }
    let mut planes_out = acc.collapse();

    // Output validity: any layer valid with positive weight at the pixel.
    let mut validity = ValidityMask::new_filled(w, h, false);
    for i in 0..n {
        let (x, y) = ((i % w as usize) as u32, (i / w as usize) as u32);
        let covered = layers
            .iter()
            .zip(weights)
            .any(|(l, wt)| l.validity.get(x, y) && wt[i] > 0.0);
        if covered {
            validity.set(x, y, true);
        }
    }
    // Invalid pixels carry zeroed values for determinism.
    for plane in &mut planes_out {
        for i in 0..n {
            let (x, y) = ((i % w as usize) as u32, (i / w as usize) as u32);
            if !validity.get(x, y) {
                plane[i] = 0.0;
            }
        }
    }
    let [r, g, b] = planes_out;
    PlanarImage::from_planes(w, h, r, g, b, validity)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(w: u32, h: u32, value: f32) -> PlanarImage {
        let n = (w as usize) * (h as usize);
        PlanarImage::from_planes(
            w,
            h,
            vec![value; n],
            vec![value * 0.5; n],
            vec![value * 0.25; n],
            ValidityMask::new_filled(w, h, true),
        )
    }

    #[test]
    fn levels_rule_matches_spec() {
        assert_eq!(levels_for_overlap_width(0), 1);
        assert_eq!(levels_for_overlap_width(8), 3);
        assert_eq!(levels_for_overlap_width(300), 7); // log2 = 8.2 → cap
    }

    /// Blending two identical flat layers reproduces the value exactly
    /// everywhere — no pyramid energy loss.
    #[test]
    fn flat_layers_are_reproduced() {
        let (w, h) = (64, 32);
        let a = flat(w, h, 0.6);
        let b = flat(w, h, 0.6);
        let n = (w * h) as usize;
        let half = |left: bool| -> Vec<f32> {
            (0..n)
                .map(|i| {
                    let x = i % w as usize;
                    if (x < w as usize / 2) == left {
                        1.0
                    } else {
                        0.0
                    }
                })
                .collect()
        };
        let out = blend_multiband(&[a, b], &[half(true), half(false)], 4);
        for i in 0..n {
            assert!((out.r[i] - 0.6).abs() < 1e-5, "px {i}: {} != 0.6", out.r[i]);
        }
        assert!(out.validity.all_valid());
    }

    /// A hard seam between two different flat values becomes a smooth,
    /// monotone-ish transition wider than one pixel, with the originals
    /// preserved far from the seam.
    #[test]
    fn seam_is_feathered_not_stepped() {
        let (w, h) = (128, 16);
        let a = flat(w, h, 0.2);
        let b = flat(w, h, 0.8);
        let n = (w * h) as usize;
        let mask_a: Vec<f32> = (0..n)
            .map(|i| if (i % w as usize) < 64 { 1.0 } else { 0.0 })
            .collect();
        let mask_b: Vec<f32> = mask_a.iter().map(|&v| 1.0 - v).collect();
        let out = blend_multiband(&[a, b], &[mask_a, mask_b], 5);
        let row = 8 * w as usize;
        assert!((out.r[row + 8] - 0.2).abs() < 1e-3, "far left preserved");
        assert!((out.r[row + 119] - 0.8).abs() < 1e-3, "far right preserved");
        // The 0.2 → 0.8 transition must span multiple pixels (no step):
        let max_jump = (1..w as usize)
            .map(|x| (out.r[row + x] - out.r[row + x - 1]).abs())
            .fold(0.0_f32, f32::max);
        assert!(
            max_jump < 0.3,
            "hard step survived the blend: max adjacent jump {max_jump}"
        );
    }

    /// Validity: a region covered by no weighted layer is invalid and
    /// zeroed; valid values never bleed from masked-out areas.
    #[test]
    fn uncovered_region_is_invalid() {
        let (w, h) = (32, 8);
        let n = (w * h) as usize;
        let mut v = ValidityMask::new_filled(w, h, true);
        for y in 0..h {
            for x in 16..w {
                v.set(x, y, false);
            }
        }
        let img = PlanarImage::from_planes(w, h, vec![0.7; n], vec![0.7; n], vec![0.7; n], v);
        let weights = vec![vec![1.0_f32; n]];
        let out = blend_multiband(&[img], &weights, 3);
        assert!(out.validity.get(2, 2));
        assert!(!out.validity.get(20, 4), "uncovered must stay invalid");
        let i = 4 * w as usize + 20;
        assert_eq!(out.r[i], 0.0, "invalid pixels are zeroed");
        let j = 2 * w as usize + 2;
        assert!((out.r[j] - 0.7).abs() < 1e-4, "valid side preserved");
    }

    /// Determinism: identical inputs → identical bytes.
    #[test]
    fn deterministic() {
        let (w, h) = (48, 24);
        let n = (w * h) as usize;
        let a = flat(w, h, 0.3);
        let b = flat(w, h, 0.9);
        let mask: Vec<f32> = (0..n)
            .map(|i| if (i % w as usize) < 24 { 1.0 } else { 0.0 })
            .collect();
        let inv: Vec<f32> = mask.iter().map(|&v| 1.0 - v).collect();
        let o1 = blend_multiband(&[a.clone(), b.clone()], &[mask.clone(), inv.clone()], 4);
        let o2 = blend_multiband(&[a, b], &[mask, inv], 4);
        assert_eq!(o1.r, o2.r);
        assert_eq!(o1.g, o2.g);
        assert_eq!(o1.b, o2.b);
    }
}
