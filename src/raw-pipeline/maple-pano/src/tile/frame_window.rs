//! Capacity-bounded spatial "wave" grouping shared by the tile path's
//! full-canvas scans (`sampling::sample_pairs`,
//! `masks::estimate_min_overlap_width`) — #3197.
//!
//! Both scans used to call `TileFrameCache::get` once **per sample
//! point**, which is what actually thrashed the cache (see
//! `frame_cache` module docs). The fix here is geometric, not just a
//! locking change: split the canvas into `TILE_PX`-sided square cells,
//! resolve each cell's active frame set once from its (already-computed)
//! canvas bbox, then group spatially-consecutive cells into "waves"
//! whose union of active frames never exceeds the cache's capacity. A
//! caller pins a wave's whole frame set once (via
//! `TileFrameCache::pin_many`, which decodes any misses concurrently),
//! processes that wave's cells (in parallel, against the pinned `Arc`s —
//! no further cache access), then moves to the next wave. Waves run
//! strictly one after another, so at most one wave's frame set is
//! resident at a time.
//!
//! ## Why 2D cells, not 1D row-bands
//!
//! An earlier design (mirroring `composite_tile`'s own tiling) grouped
//! by full-canvas-width row bands. That works when the strip's long axis
//! is the canvas's Y axis, but `pano_03` (the fixture this bug was
//! diagnosed on) is an *east-west* flight: successive frames are offset
//! almost entirely in canvas X, with only a small cross-track drift in Y
//! (measured from the fixture's own EXIF GPS: ~954 m east vs ~268 m
//! south over the 23-frame set — the strip runs along X). A full-width
//! row band there intersects nearly every frame's canvas bbox regardless
//! of which band it is (they all share almost the same vertical extent),
//! so row-banding would provide no useful locality at all on this
//! fixture — the exact case this cache exists to bound. A 2D bbox test
//! against a square cell degrades gracefully regardless of which axis
//! the strip actually runs along.
//!
//! ## Why row-major cell order still works for an X-running strip
//!
//! Cells are enumerated in row-major order (outer Y, inner X). For a
//! strip that's short in Y (typical — one flight line), that reduces to
//! very close to a left-to-right sweep along the strip, which is exactly
//! the locality the grouping wants: consecutive cells in this order
//! share most of their active frame set. The grouping algorithm itself
//! doesn't assume an axis — it just closes a wave whenever the running
//! union would exceed `capacity` — so it degrades gracefully for a
//! strip running the other way (or bending) too, at the cost of losing
//! some locality (more, smaller waves) rather than breaking correctness.

use super::frame_cache::TileFrameCache;
use crate::error::PanoError;
use crate::ingest::PlanarImage;
use std::sync::Arc;

#[derive(Clone, Copy, Debug)]
pub(super) struct Cell {
    pub x0: usize,
    pub y0: usize,
    pub x1: usize,
    pub y1: usize,
}

/// Enumerate `window_px`-sided cells covering `[0,cw) x [0,ch)` in
/// row-major order (see module docs for why this order matters).
pub(super) fn spatial_cells(cw: usize, ch: usize, window_px: usize) -> Vec<Cell> {
    let mut cells = Vec::new();
    let mut y0 = 0usize;
    while y0 < ch {
        let y1 = (y0 + window_px).min(ch);
        let mut x0 = 0usize;
        while x0 < cw {
            let x1 = (x0 + window_px).min(cw);
            cells.push(Cell { x0, y0, x1, y1 });
            x0 = x1;
        }
        y0 = y1;
    }
    cells
}

/// Which original frame indices' canvas bbox intersects `cell` — a 2D
/// test against both x and y, which is what makes this discriminate
/// frames on a strip running along either axis (see module docs).
/// `bboxes[i]` is `(x0, y0, x1, y1)` in canvas pixels, indexed the same
/// as `poses` (a *local* index, not necessarily the original frame
/// index — callers map back via `poses[i].frame_idx`).
fn active_locals_for_cell(bboxes: &[(f64, f64, f64, f64)], cell: Cell) -> Vec<usize> {
    let (cx0, cy0, cx1, cy1) = (
        cell.x0 as f64,
        cell.y0 as f64,
        cell.x1 as f64,
        cell.y1 as f64,
    );
    (0..bboxes.len())
        .filter(|&i| {
            let (bx0, by0, bx1, by1) = bboxes[i];
            bx1 >= cx0 && bx0 <= cx1 && by1 >= cy0 && by0 <= cy1
        })
        .collect()
}

/// A capacity-bounded group of spatially-consecutive cells, together
/// with the union of *original* frame indices (`poses[i].frame_idx`
/// space) any of its cells can touch.
pub(super) struct Wave {
    pub cells: Vec<Cell>,
    pub frames: Vec<usize>,
}

/// Group `cells` (already in a spatially-coherent enumeration order —
/// see [`spatial_cells`]) into waves whose union of active *original*
/// frame indices never exceeds `capacity`.
///
/// Greedy: extend the current wave while doing so keeps the running
/// union within `capacity`; otherwise close it and start a new one. A
/// single cell whose own active set already exceeds `capacity` (more
/// simultaneous overlapping frames than the capacity was sized for) is
/// still processed correctly — it just becomes its own wave with a
/// pinned set larger than `capacity`; this is a correctness-preserving
/// edge case, not a bug (see `TileFrameCache` docs: eviction only
/// affects hit rate, never correctness).
///
/// `local_to_frame` maps a local (bbox-array) index to the original
/// frame index the cache is keyed by.
pub(super) fn group_into_waves(
    cells: &[Cell],
    bboxes: &[(f64, f64, f64, f64)],
    local_to_frame: impl Fn(usize) -> usize,
    capacity: usize,
) -> Vec<Wave> {
    let mut waves = Vec::new();
    let mut current_cells: Vec<Cell> = Vec::new();
    let mut current_set: std::collections::BTreeSet<usize> = std::collections::BTreeSet::new();

    for &cell in cells {
        let locals = active_locals_for_cell(bboxes, cell);
        if locals.is_empty() {
            // No frame touches this cell at all — nothing to pin, but it
            // still needs to be visited by the caller's per-cell pass
            // (e.g. to correctly skip it), so keep it in whichever wave
            // is currently open (or start one) without affecting the
            // frame-set bound.
            current_cells.push(cell);
            continue;
        }
        let frame_ids: Vec<usize> = locals.iter().map(|&l| local_to_frame(l)).collect();
        let mut trial = current_set.clone();
        trial.extend(frame_ids.iter().copied());
        if !current_set.is_empty() && trial.len() > capacity {
            waves.push(Wave {
                cells: std::mem::take(&mut current_cells),
                frames: current_set.iter().copied().collect(),
            });
            current_set = frame_ids.into_iter().collect();
        } else {
            current_set = trial;
        }
        current_cells.push(cell);
    }
    if !current_cells.is_empty() {
        waves.push(Wave {
            cells: current_cells,
            frames: current_set.into_iter().collect(),
        });
    }
    waves
}

/// Pin a wave's frame set and return a lookup by *original* frame index.
/// Decodes any misses concurrently (`TileFrameCache::pin_many`).
pub(super) fn pin_wave(
    cache: &TileFrameCache,
    wave: &Wave,
) -> Result<std::collections::HashMap<usize, Arc<PlanarImage>>, PanoError> {
    Ok(cache.pin_many(&wave.frames)?.into_iter().collect())
}
