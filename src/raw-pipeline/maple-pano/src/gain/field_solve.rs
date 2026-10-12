//! Lattice sizing and term assembly for the rotation exposure field
//! ([`super::field`], #4521).

use std::collections::{BTreeMap, BTreeSet};

use crate::ingest::PlanarImage;
use crate::screened_cg::{DiffTerm, ScreenedSystem};

use super::field::{
    ExposureField, ExposureFieldSummary, NodeGrid, CORRIDOR_MARGIN_NODES, MAX_NODES_PER_VIEW,
};

/// Scene-linear luminance below which a log difference is noise.
const LUMA_FLOOR: f32 = 1e-4;
/// Samples a (pair, node) residual needs before its median is trusted.
const MIN_NODE_SAMPLES: usize = 8;
/// Lattice density aimed for on the largest view footprint; the hard cap
/// is [`MAX_NODES_PER_VIEW`], which leaves room for the corridor margin.
const NODE_TARGET_PER_VIEW: f64 = 1024.0;
/// Smoothness and shrinkage weights relative to the mean data weight.
const SMOOTHNESS: f64 = 1.0;
const SHRINKAGE: f64 = 1e-2;
/// ±1 EV: a residual larger than this is content, not exposure.
const MAX_LOG_CORRECTION: f64 = std::f64::consts::LN_2;
const NEGLIGIBLE_LOG: f32 = 1e-4;
const CG_ITERS: usize = 500;

/// One view's warped seam-canvas log-luminance, cropped to its usable
/// bounding box (`NaN` = invalid or below [`LUMA_FLOOR`]).
pub(super) struct LumaLayer {
    x0: usize,
    y0: usize,
    w: usize,
    h: usize,
    ln_luma: Vec<f32>,
}

impl LumaLayer {
    pub(super) fn from_warped(img: &PlanarImage) -> Self {
        let w = img.width() as usize;
        let ln_at = |i: usize| -> Option<f32> {
            let (x, y) = ((i % w) as u32, (i / w) as u32);
            let luma = (img.r[i] + img.g[i] + img.b[i]) / 3.0;
            (img.validity.get(x, y) && luma > LUMA_FLOOR).then(|| luma.ln())
        };
        let usable: Vec<usize> = (0..img.pixel_count())
            .filter(|&i| ln_at(i).is_some())
            .collect();
        let Some((x0, y0, x1, y1)) = usable.iter().fold(None, |bbox, &i| {
            let (x, y) = (i % w, i / w);
            Some(bbox.map_or(
                (x, y, x, y),
                |(a, b, c, d): (usize, usize, usize, usize)| {
                    (a.min(x), b.min(y), c.max(x), d.max(y))
                },
            ))
        }) else {
            return Self {
                x0: 0,
                y0: 0,
                w: 0,
                h: 0,
                ln_luma: Vec::new(),
            };
        };
        let (bw, bh) = (x1 - x0 + 1, y1 - y0 + 1);
        let ln_luma = (0..bw * bh)
            .map(|j| ln_at((y0 + j / bw) * w + x0 + j % bw).unwrap_or(f32::NAN))
            .collect();
        Self {
            x0,
            y0,
            w: bw,
            h: bh,
            ln_luma,
        }
    }

    fn at(&self, x: usize, y: usize) -> Option<f32> {
        let (lx, ly) = (x.checked_sub(self.x0)?, y.checked_sub(self.y0)?);
        (lx < self.w && ly < self.h)
            .then(|| self.ln_luma[ly * self.w + lx])
            .filter(|v| v.is_finite())
    }

    fn usable_px(&self) -> usize {
        self.ln_luma.iter().filter(|v| v.is_finite()).count()
    }
}

/// `(view a, view b, node)` → weight and median of `ln L_b − ln L_a`.
type Residuals = BTreeMap<(usize, usize, usize), (f64, f64)>;

/// Solve over warped layers on a `sw × sh` seam canvas whose `u` axis
/// wraps when `periodic_x`.
pub(super) fn solve_layers(
    layers: &[LumaLayer],
    (sw, sh): (usize, usize),
    periodic_x: bool,
) -> ExposureField {
    let largest = layers.iter().map(LumaLayer::usable_px).max().unwrap_or(0);
    let mut cell = (largest as f64 / NODE_TARGET_PER_VIEW).sqrt().max(1.0);
    loop {
        let grid = lattice(cell, sw, sh, periodic_x);
        let residuals = residuals(layers, grid, sw, sh);
        let corridors = corridors(&residuals, grid, layers.len());
        let widest = corridors.iter().map(BTreeSet::len).max().unwrap_or(0);
        if widest <= MAX_NODES_PER_VIEW {
            return solve(grid, &residuals, &corridors);
        }
        cell *= 1.25;
    }
}

fn lattice(cell: f64, sw: usize, sh: usize, periodic_x: bool) -> NodeGrid {
    let span = |px: usize| (px as f64 / cell).round() as usize;
    NodeGrid {
        nx: if periodic_x {
            span(sw).max(3)
        } else {
            (span(sw) + 1).max(2)
        },
        ny: (span(sh) + 1).max(2),
        periodic_x,
    }
}

fn residuals(layers: &[LumaLayer], grid: NodeGrid, sw: usize, sh: usize) -> Residuals {
    let mut samples: BTreeMap<(usize, usize, usize), Vec<f32>> = BTreeMap::new();
    let mut present: Vec<(usize, f32)> = Vec::with_capacity(layers.len());
    for y in 0..sh {
        let v = (y as f64 + 0.5) / sh as f64;
        for x in 0..sw {
            present.clear();
            present.extend(
                layers
                    .iter()
                    .enumerate()
                    .filter_map(|(i, layer)| layer.at(x, y).map(|l| (i, l))),
            );
            if present.len() < 2 {
                continue;
            }
            let node = grid.nearest((x as f64 + 0.5) / sw as f64, v);
            for (n, &(a, la)) in present.iter().enumerate() {
                for &(b, lb) in &present[n + 1..] {
                    samples.entry((a, b, node)).or_default().push(lb - la);
                }
            }
        }
    }
    samples
        .into_iter()
        .filter(|(_, s)| s.len() >= MIN_NODE_SAMPLES)
        .map(|(key, mut s)| {
            let mid = s.len() / 2;
            let (_, median, _) = s.select_nth_unstable_by(mid, f32::total_cmp);
            let d = (*median as f64).clamp(-MAX_LOG_CORRECTION, MAX_LOG_CORRECTION);
            (key, (s.len() as f64, d))
        })
        .collect()
}

/// Each view's unknown nodes: those carrying residual data, dilated by
/// [`CORRIDOR_MARGIN_NODES`] lattice rings.
fn corridors(residuals: &Residuals, grid: NodeGrid, views: usize) -> Vec<BTreeSet<usize>> {
    let mut seeds = vec![BTreeSet::new(); views];
    for &(a, b, node) in residuals.keys() {
        seeds[a].insert(node);
        seeds[b].insert(node);
    }
    seeds
        .into_iter()
        .map(|seed| {
            (0..CORRIDOR_MARGIN_NODES).fold(seed, |set, _| {
                let ring: Vec<usize> = set.iter().flat_map(|&n| grid.neighbours(n)).collect();
                set.into_iter().chain(ring).collect()
            })
        })
        .collect()
}

fn solve(grid: NodeGrid, residuals: &Residuals, corridors: &[BTreeSet<usize>]) -> ExposureField {
    let index: BTreeMap<(usize, usize), usize> = corridors
        .iter()
        .enumerate()
        .flat_map(|(view, nodes)| nodes.iter().map(move |&node| (view, node)))
        .enumerate()
        .map(|(k, key)| (key, k))
        .collect();
    let data: Vec<DiffTerm> = residuals
        .iter()
        .map(|(&(a, b, node), &(w, d))| DiffTerm {
            a: index[&(a, node)],
            b: index[&(b, node)],
            w,
            d,
        })
        .collect();
    let mut smooth = Vec::new();
    let mut pinned = Vec::new();
    for (view, nodes) in corridors.iter().enumerate() {
        for &node in nodes {
            for next in grid.neighbours(node) {
                match index.get(&(view, next)) {
                    Some(&k) if next > node => smooth.push((index[&(view, node)], k)),
                    Some(_) => {}
                    None => pinned.push(index[&(view, node)]),
                }
            }
        }
    }
    let w_sum: f64 = data.iter().map(|t| t.w).sum();
    let w_mean = if data.is_empty() {
        1.0
    } else {
        w_sum / data.len() as f64
    };
    let x: Vec<f64> = ScreenedSystem {
        unknowns: index.len(),
        data: &data,
        smooth: &smooth,
        pinned: &pinned,
        lambda: SMOOTHNESS * w_mean,
        shrinkage: SHRINKAGE * w_mean,
    }
    .solve(CG_ITERS)
    .into_iter()
    .map(|v| v.clamp(-MAX_LOG_CORRECTION, MAX_LOG_CORRECTION))
    .collect();

    let weighted_rms = |step: &dyn Fn(&DiffTerm) -> f64| {
        if w_sum > 0.0 {
            (data.iter().map(|t| t.w * step(t).powi(2)).sum::<f64>() / w_sum).sqrt()
        } else {
            0.0
        }
    };
    let views: Vec<Option<Vec<f32>>> = corridors
        .iter()
        .enumerate()
        .map(|(view, nodes)| {
            let dense = nodes
                .iter()
                .fold(vec![0.0_f32; grid.len()], |mut dense, &node| {
                    dense[node] = x[index[&(view, node)]] as f32;
                    dense
                });
            dense
                .iter()
                .any(|v| v.abs() > NEGLIGIBLE_LOG)
                .then_some(dense)
        })
        .collect();
    ExposureField {
        grid,
        summary: ExposureFieldSummary {
            lattice: (grid.nx, grid.ny),
            unknowns: index.len(),
            max_unknowns_per_view: corridors.iter().map(BTreeSet::len).max().unwrap_or(0),
            max_abs_log: x.iter().fold(0.0_f32, |m, v| m.max(v.abs() as f32)),
            step_rms_before: weighted_rms(&|t| t.d),
            step_rms_after: weighted_rms(&|t| t.d - (x[t.a] - x[t.b])),
        },
        views,
    }
}
