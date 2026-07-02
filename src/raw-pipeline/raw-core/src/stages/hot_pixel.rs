//! Hot/dead-pixel suppression (#1106, tone/zoom design spec § 10.6).
//!
//! Pre-demosaic, raw-domain — tier 0 of the § 3 noise story, in the same
//! position RawTherapee runs its preprocess block. For each CFA site the
//! value is compared against its same-color neighbors:
//!
//! - **hot:**  `v > K_HOT · max(neighbors) + TAU`
//! - **dead / stuck-low:** `v < K_DEAD · min(neighbors)`
//!
//! Flagged sites are replaced with the same-color neighborhood **median**.
//! Detection reads a snapshot of the original mosaic, so one defect can
//! never cascade into its neighbors' decisions, and the result is
//! deterministic across thread counts (each output site is a pure function
//! of the input neighborhood).
//!
//! Thresholds are deliberately conservative (`K_HOT = 2`, `TAU = 0.02` in
//! normalised [0, 1] sensor units, `K_DEAD = 0.25`): a true hot pixel sits
//! orders of magnitude above its neighborhood, while legitimate speculars
//! cover several same-color sites (so `max(neighbors)` tracks them) — and
//! a uniform field can mathematically never trip either predicate
//! (`v > 2v + 0.02` and `v < 0.25·v` are both impossible for `v ≥ 0`), so
//! the stage is **exactly identity on the synthetic grey card by
//! construction**, at any setting. Unflagged sites are never rewritten, so
//! identity is bit-exact, not within-tolerance.
//!
//! Works on both CFA families: same-color neighbors are enumerated through
//! [`CfaPattern::color_at`], precomputed per CFA-period phase cell — a
//! 5×5 window for 2×2 Bayer (8 same-color neighbors at every site) and a
//! 7×7 window for 6×6 X-Trans (≥ 8 for every phase). `LinearRgb` sources
//! have no mosaic and never reach this stage (callers dispatch before
//! linearize). `papp:HotPixelSuppression` Off (default) skips the stage
//! bit-identically.
//!
//! Tile-safety: translation-invariant with a ≤ 3 px stencil (≪
//! `TILE_OVERLAP_PX` 48), and the tile path's even-aligned padded origin
//! preserves Bayer phase, so per-tile output matches the full-frame path.

use rayon::prelude::*;

use crate::image::{CfaPattern, ColorSpace, Image};
use crate::types::adjustment::HotPixelSuppressionMode;

/// Hot threshold slope: a site must exceed `K_HOT ×` the brightest
/// same-color neighbor (plus [`TAU`]) to be flagged.
const K_HOT: f32 = 2.0;

/// Hot threshold intercept in normalised [0, 1] sensor units — keeps
/// shot noise around black from flagging (2 % of full scale ≈ well above
/// base-ISO read noise, far below any real hot pixel).
const TAU: f32 = 0.02;

/// Dead/stuck-low threshold: a site must read below `K_DEAD ×` the darkest
/// same-color neighbor. Zero neighborhoods (true black) can never flag.
const K_DEAD: f32 = 0.25;

/// Precompute, for every phase cell of the CFA period, the relative
/// offsets within the window that land on a same-color site. Bayer
/// (period 2) uses radius 2; X-Trans (period 6) uses radius 3 so every
/// phase still sees ≥ 8 same-color neighbors.
fn same_color_offsets(cfa: CfaPattern) -> (usize, i32, Vec<Vec<(i32, i32)>>) {
    let (period, radius) = if cfa.is_xtrans() {
        (6usize, 3i32)
    } else {
        (2usize, 2i32)
    };
    let mut table = Vec::with_capacity(period * period);
    for cy in 0..period {
        for cx in 0..period {
            // Offset the probe far enough into positive space that
            // `cx + dx` never underflows (color_at is periodic).
            let bx = (cx + 8 * period) as i32;
            let by = (cy + 8 * period) as i32;
            let center = cfa.color_at(bx as u32, by as u32);
            let mut offs = Vec::new();
            for dy in -radius..=radius {
                for dx in -radius..=radius {
                    if dx == 0 && dy == 0 {
                        continue;
                    }
                    if cfa.color_at((bx + dx) as u32, (by + dy) as u32) == center {
                        offs.push((dx, dy));
                    }
                }
            }
            debug_assert!(
                offs.len() >= 4,
                "phase ({cx},{cy}) has only {} same-color neighbors",
                offs.len()
            );
            table.push(offs);
        }
    }
    (period, radius, table)
}

/// Median of a small slice (midpoint average for even counts). The slice
/// is sorted in place — callers pass a scratch buffer.
fn median_in_place(v: &mut [f32]) -> f32 {
    v.sort_unstable_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        0.5 * (v[n / 2 - 1] + v[n / 2])
    }
}

/// Apply hot/dead-pixel suppression to a `CameraNativeMosaic` image.
/// `Off` (the default) is an exact bit-identical skip. Callers must not
/// pass `CfaPattern::LinearRgb` (no mosaic exists for it).
pub fn apply(mosaic: &mut Image, cfa: CfaPattern, mode: HotPixelSuppressionMode) {
    if mode == HotPixelSuppressionMode::Off {
        return;
    }
    mosaic.assert_space(ColorSpace::CameraNativeMosaic);
    debug_assert_ne!(
        cfa,
        CfaPattern::LinearRgb,
        "hot_pixel::apply must not run on LinearRgb sources (no mosaic)"
    );

    let w = mosaic.width as usize;
    let h = mosaic.height as usize;
    let (period, _radius, offsets) = same_color_offsets(cfa);

    // Single-channel snapshot of each site's CFA-channel value. Detection
    // and replacement both read THIS, never the partially-written output.
    let vals: Vec<f32> = (0..w * h)
        .into_par_iter()
        .map(|i| {
            let (x, y) = (i % w, i / w);
            let c = cfa.color_at(x as u32, y as u32) as usize;
            mosaic.pixels[i][c]
        })
        .collect();

    let vals_ref = &vals;
    let offsets_ref = &offsets;
    mosaic
        .pixels
        .par_chunks_mut(w)
        .enumerate()
        .for_each(|(y, row)| {
            // Scratch buffer reused across the row (no per-pixel alloc).
            let mut neigh: Vec<f32> = Vec::with_capacity(24);
            for (x, px) in row.iter_mut().enumerate() {
                let i = y * w + x;
                let v = vals_ref[i];
                let cell = (y % period) * period + (x % period);
                neigh.clear();
                for &(dx, dy) in &offsets_ref[cell] {
                    let nx = x as i32 + dx;
                    let ny = y as i32 + dy;
                    if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                        continue;
                    }
                    neigh.push(vals_ref[ny as usize * w + nx as usize]);
                }
                if neigh.is_empty() {
                    continue; // degenerate tiny image — keep the site
                }
                let mut nmax = f32::NEG_INFINITY;
                let mut nmin = f32::INFINITY;
                for &n in &neigh {
                    nmax = nmax.max(n);
                    nmin = nmin.min(n);
                }
                let hot = v > K_HOT * nmax + TAU;
                let dead = v < K_DEAD * nmin;
                if hot || dead {
                    let c = cfa.color_at(x as u32, y as u32) as usize;
                    px[c] = median_in_place(&mut neigh);
                }
            }
        });
}

#[cfg(test)]
mod tests;
