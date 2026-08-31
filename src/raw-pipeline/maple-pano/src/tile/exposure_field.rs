//! Layer-B residual exposure fields: screened-Poisson solve on a coarse
//! canvas grid (#350). Split from `photometry.rs` for the file budget.
//!
//! After the gain+ramp model (layer A) is subtracted, each frame pair's
//! remaining per-cell log residual `d_ij(cell)` is explained by smooth
//! per-frame correction fields `f_i`:
//!
//! ```text
//! minimize  Σ_pairs Σ_cells  w · (f_i(c) − f_j(c) − d_ij(c))²     data
//!         + λ Σ_frames Σ_neighbors (f_i(c) − f_i(c'))²            smoothness
//!         + μ Σ f²                                                gauge anchor
//! ```
//!
//! The normal equations are symmetric positive definite; conjugate
//! gradients solves them matrix-free over explicit term lists, so the
//! cost and memory scale with the coarse grid (canvas/128 per side), not
//! the canvas. Term construction iterates `BTreeMap`s and the CG loop is
//! purely data-driven, so the result is deterministic.

use crate::ingest::PlanarImage;

use std::collections::BTreeMap;

use super::photometry::{CoarseField, PairMap, PhotometryOptions};
use super::placement::{TileCanvasSpec, TilePose};

/// Minimum samples for a per-cell residual to enter the data term.
const MIN_CELL_SAMPLES: f64 = 4.0;

/// Fields below this magnitude everywhere are dropped (no visible effect,
/// saves the per-pixel eval).
const NEGLIGIBLE_LOG: f32 = 1e-4;

pub(super) fn solve_fields(
    frames: &[PlanarImage],
    poses: &[TilePose],
    canvas: &TileCanvasSpec,
    opts: &PhotometryOptions,
    pairs: &PairMap,
    a_lum: &[f64],
    slope_x: f64,
    slope_y: f64,
) -> Vec<Option<CoarseField>> {
    let k = frames.len();
    let cell = opts.field_cell_px;
    let ncx = (canvas.width as usize).div_ceil(cell);
    let ncy = (canvas.height as usize).div_ceil(cell);

    // ── frame coverage: rectangle of cells intersecting the frame bbox ──
    // A similarity maps the frame rect to a convex quad; its cell-space
    // bbox is a solid rectangle, so per-frame windows have no holes and
    // smoothness terms connect every unknown of a frame.
    let windows: Vec<(usize, usize, usize, usize)> = frames
        .iter()
        .zip(poses)
        .map(|(f, pose)| {
            let (fw, fh) = (f.width() as f64, f.height() as f64);
            let (mut x0, mut y0, mut x1, mut y1) =
                (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
            for &(x, y) in &[(0.0, 0.0), (fw, 0.0), (0.0, fh), (fw, fh)] {
                let (cx, cy) = pose.sim.apply(x, y);
                let (cx, cy) = (cx + canvas.offset_x, cy + canvas.offset_y);
                x0 = x0.min(cx);
                y0 = y0.min(cy);
                x1 = x1.max(cx);
                y1 = y1.max(cy);
            }
            let cx0 = ((x0.max(0.0) as usize) / cell).min(ncx.saturating_sub(1));
            let cy0 = ((y0.max(0.0) as usize) / cell).min(ncy.saturating_sub(1));
            let cx1 = ((x1.max(0.0) as usize) / cell + 1).min(ncx);
            let cy1 = ((y1.max(0.0) as usize) / cell + 1).min(ncy);
            (cx0, cy0, cx1.max(cx0 + 1), cy1.max(cy0 + 1))
        })
        .collect();

    // ── unknown index: (frame, global cell) → k ──────────────────────────
    let mut index: BTreeMap<(usize, u32), usize> = BTreeMap::new();
    for (fi, &(cx0, cy0, cx1, cy1)) in windows.iter().enumerate() {
        for cy in cy0..cy1 {
            for cx in cx0..cx1 {
                let cell_lin = (cy * ncx + cx) as u32;
                let next = index.len();
                index.insert((fi, cell_lin), next);
            }
        }
    }
    let n_unknowns = index.len();
    if n_unknowns == 0 {
        return vec![None; k];
    }

    // ── data terms ───────────────────────────────────────────────────────
    struct DataTerm {
        ki: usize,
        kj: usize,
        w: f64,
        d: f64,
    }
    let mut data: Vec<DataTerm> = Vec::new();
    let mut w_sum = 0.0_f64;
    for (&(i, j), acc) in pairs.iter() {
        if (acc.n as usize) < opts.min_pair_samples {
            continue;
        }
        for (&cell_lin, cacc) in &acc.cells {
            if cacc.n < MIN_CELL_SAMPLES {
                continue;
            }
            let (Some(&ki), Some(&kj)) =
                (index.get(&(i, cell_lin)), index.get(&(j, cell_lin)))
            else {
                continue;
            };
            let d = cacc.s_lnr / cacc.n
                - (a_lum[i] - a_lum[j])
                - slope_x * (cacc.s_dxi / cacc.n)
                - slope_y * (cacc.s_deta / cacc.n);
            data.push(DataTerm {
                ki,
                kj,
                w: cacc.n,
                d,
            });
            w_sum += cacc.n;
        }
    }
    if data.is_empty() {
        return vec![None; k];
    }
    let w_mean = w_sum / data.len() as f64;
    let lambda = opts.field_lambda * w_mean;
    let anchor = 1e-3 * w_mean;

    // ── smoothness terms (4-neighbor within each frame window) ───────────
    let mut smooth: Vec<(usize, usize)> = Vec::new();
    for (fi, &(cx0, cy0, cx1, cy1)) in windows.iter().enumerate() {
        for cy in cy0..cy1 {
            for cx in cx0..cx1 {
                let a = index[&(fi, (cy * ncx + cx) as u32)];
                if cx + 1 < cx1 {
                    smooth.push((a, index[&(fi, (cy * ncx + cx + 1) as u32)]));
                }
                if cy + 1 < cy1 {
                    smooth.push((a, index[&(fi, ((cy + 1) * ncx + cx) as u32)]));
                }
            }
        }
    }

    // ── conjugate gradients on the normal equations ──────────────────────
    let apply = |x: &[f64], out: &mut [f64]| {
        for (o, xv) in out.iter_mut().zip(x) {
            *o = anchor * xv;
        }
        for t in &data {
            let diff = t.w * (x[t.ki] - x[t.kj]);
            out[t.ki] += diff;
            out[t.kj] -= diff;
        }
        for &(a, b) in &smooth {
            let diff = lambda * (x[a] - x[b]);
            out[a] += diff;
            out[b] -= diff;
        }
    };
    let mut rhs = vec![0.0_f64; n_unknowns];
    for t in &data {
        rhs[t.ki] += t.w * t.d;
        rhs[t.kj] -= t.w * t.d;
    }
    let rhs_norm2: f64 = rhs.iter().map(|v| v * v).sum();
    let mut x = vec![0.0_f64; n_unknowns];
    if rhs_norm2 > 0.0 {
        let mut r = rhs.clone();
        let mut p = rhs.clone();
        let mut ap = vec![0.0_f64; n_unknowns];
        let mut rs: f64 = rhs_norm2;
        for _ in 0..opts.field_cg_iters {
            apply(&p, &mut ap);
            let p_ap: f64 = p.iter().zip(&ap).map(|(a, b)| a * b).sum();
            if p_ap <= 0.0 {
                break;
            }
            let alpha = rs / p_ap;
            for i in 0..n_unknowns {
                x[i] += alpha * p[i];
                r[i] -= alpha * ap[i];
            }
            let rs_new: f64 = r.iter().map(|v| v * v).sum();
            if rs_new <= 1e-16 * rhs_norm2 {
                break;
            }
            let beta = rs_new / rs;
            for i in 0..n_unknowns {
                p[i] = r[i] + beta * p[i];
            }
            rs = rs_new;
        }
    }

    // ── extract per-frame coarse planes ──────────────────────────────────
    windows
        .iter()
        .enumerate()
        .map(|(fi, &(cx0, cy0, cx1, cy1))| {
            let (w, h) = (cx1 - cx0, cy1 - cy0);
            let mut values = vec![0.0_f32; w * h];
            let mut max_abs = 0.0_f32;
            for cy in cy0..cy1 {
                for cx in cx0..cx1 {
                    let v = x[index[&(fi, (cy * ncx + cx) as u32)]] as f32;
                    values[(cy - cy0) * w + (cx - cx0)] = v;
                    max_abs = max_abs.max(v.abs());
                }
            }
            (max_abs > NEGLIGIBLE_LOG).then_some(CoarseField {
                cell_px: cell as f64,
                cx0,
                cy0,
                w,
                h,
                values,
            })
        })
        .collect()
}
