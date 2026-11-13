//! #1472: reuse a limited set of row-tile workers instead of full-resolution
//! weight/radius planes. Input and the required output plane are excluded from
//! the 256 MiB scratch target. At least one worker is needed, so unusual public
//! patch sizes can exceed that target; ordinary 100MP RAWs do not.
use super::{
    radius::LocalRadiusPlane, shift::process_shift_region, NlmParams, RESEED_STRIDE, VSTRIP_ROWS,
};
use crate::cancel::CancelToken;
use rayon::prelude::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};

const SCRATCH_TARGET: usize = 256 * 1024 * 1024;
const TILE_COLS: usize = 512;

pub(super) fn use_bounded(n: usize, dynamic: bool, params: NlmParams) -> bool {
    n.saturating_mul(metadata_bytes(dynamic, params)) > SCRATCH_TARGET
}

fn metadata_bytes(dynamic: bool, params: NlmParams) -> usize {
    8 + if dynamic {
        4 + if params.search_radius <= u8::MAX as usize {
            1
        } else {
            std::mem::size_of::<isize>()
        }
    } else {
        0
    }
}

fn worker_bytes(w: usize, dynamic: bool, params: NlmParams) -> usize {
    let cols = w.min(TILE_COLS);
    cols * VSTRIP_ROWS * (metadata_bytes(dynamic, params) + 4)
        + 4 * ((VSTRIP_ROWS + 2 * params.patch_radius) * cols
            + cols
            + RESEED_STRIDE
            + 2 * params.patch_radius)
}

fn worker_count(w: usize, dynamic: bool, params: NlmParams) -> usize {
    (SCRATCH_TARGET / worker_bytes(w, dynamic, params).max(1))
        .max(1)
        .min(rayon::current_num_threads().max(1))
}

struct Worker {
    acc: Vec<f32>,
    wsum: Vec<f32>,
    max_w: Vec<f32>,
    radius: LocalRadiusPlane,
    inv_norm: Vec<f32>,
    hloc: Vec<f32>,
    colsum: Vec<f32>,
}

impl Worker {
    fn new(w: usize, dynamic: bool, params: NlmParams) -> Self {
        let cols = w.min(TILE_COLS);
        let n = VSTRIP_ROWS * cols;
        Self {
            acc: vec![0.0; n],
            wsum: vec![0.0; n],
            max_w: vec![0.0; n],
            radius: LocalRadiusPlane::new(if dynamic { n } else { 0 }, params.search_radius),
            inv_norm: vec![0.0; if dynamic { n } else { 0 }],
            hloc: vec![0.0; (VSTRIP_ROWS + 2 * params.patch_radius) * cols],
            colsum: vec![0.0; cols + RESEED_STRIDE + 2 * params.patch_radius],
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn run(
        &mut self,
        plane: &[f32],
        w: usize,
        h: usize,
        params: NlmParams,
        cancel: CancelToken<'_>,
        guide: &[f32],
        dynamic: bool,
        noise: (f32, f32),
        row_start: usize,
        col_start: usize,
        cols: usize,
        rows: usize,
    ) {
        let n = rows * cols;
        self.acc[..n].fill(0.0);
        self.wsum[..n].fill(0.0);
        self.max_w[..n].fill(0.0);
        if dynamic {
            self.radius.fill_tile(
                &mut self.inv_norm[..n],
                guide,
                w,
                row_start,
                col_start,
                cols,
                params,
                noise,
            );
        }
        let s = params.search_radius as isize;
        for dy in -s..=s {
            for dx in -s..=s {
                if dx == 0 && dy == 0 {
                    continue;
                }
                if cancel.is_cancelled() {
                    return;
                }
                process_shift_region(
                    plane,
                    w,
                    h,
                    params,
                    dx,
                    dy,
                    &self.radius,
                    &self.inv_norm,
                    dynamic,
                    row_start,
                    col_start,
                    cols,
                    &mut self.acc[..n],
                    &mut self.wsum[..n],
                    &mut self.max_w[..n],
                    &mut self.hloc,
                    &mut self.colsum,
                );
            }
        }
        // Same self-weight arithmetic and border normalization as the full path.
        for (i, dst) in self.acc[..n].iter_mut().enumerate() {
            let mw = self.max_w[i].max(1e-12);
            let total_w = self.wsum[i] + mw;
            let total_acc = *dst + mw * plane[(row_start + i / cols) * w + col_start + i % cols];
            *dst = total_acc / total_w;
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn denoise(
    plane: &[f32],
    w: usize,
    h: usize,
    params: NlmParams,
    cancel: CancelToken<'_>,
    guide: &[f32],
    dynamic: bool,
    noise: (f32, f32),
) -> Vec<f32> {
    if cancel.is_cancelled() {
        return plane.to_vec();
    }
    let count = worker_count(w, dynamic, params);
    // Allocate once. Only completed tiles acquire the output lock, to copy
    // their disjoint rows; expensive NLM work runs outside that short lock.
    let out = Mutex::new(vec![0.0; plane.len()]);
    let mut workers: Vec<_> = (0..count)
        .map(|_| Worker::new(w, dynamic, params))
        .collect();
    let row_anchor = (params.patch_radius + params.search_radius)
        .min(VSTRIP_ROWS)
        .min(h);
    let col_anchor = (params.patch_radius + params.search_radius)
        .min(TILE_COLS)
        .min(w);
    let col_tiles = 1 + (w - col_anchor).div_ceil(TILE_COLS);
    let row_tiles = 1 + (h - row_anchor).div_ceil(VSTRIP_ROWS);
    let next = AtomicUsize::new(0);
    workers.par_iter_mut().for_each(|worker| loop {
        if cancel.is_cancelled() {
            return;
        }
        let tile = next.fetch_add(1, Ordering::Relaxed);
        if tile >= row_tiles * col_tiles {
            return;
        }
        let row_tile = tile / col_tiles;
        let col_tile = tile % col_tiles;
        let (row_start, rows) = if row_tile == 0 {
            (0, row_anchor)
        } else {
            let start = row_anchor + (row_tile - 1) * VSTRIP_ROWS;
            (start, VSTRIP_ROWS.min(h - start))
        };
        let (col_start, cols) = if col_tile == 0 {
            (0, col_anchor)
        } else {
            let start = col_anchor + (col_tile - 1) * TILE_COLS;
            (start, TILE_COLS.min(w - start))
        };
        worker.run(
            plane, w, h, params, cancel, guide, dynamic, noise, row_start, col_start, cols, rows,
        );
        if cancel.is_cancelled() {
            return;
        }
        let mut output = out.lock().expect("NLM output lock poisoned");
        for row in 0..rows {
            let start = (row_start + row) * w + col_start;
            output[start..start + cols].copy_from_slice(&worker.acc[row * cols..(row + 1) * cols]);
        }
    });
    // Cancellation discards the entire partially filled output, even if other
    // workers finished some tiles before the signal arrived.
    if cancel.is_cancelled() {
        plane.to_vec()
    } else {
        out.into_inner().expect("NLM output lock poisoned")
    }
}

#[cfg(test)]
#[path = "nlm_tests_bounded.rs"]
mod tests;
