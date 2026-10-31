//! Source-frame windows for the tile path (#5560).
//!
//! Every tile stage that samples full-resolution pixels works one canvas
//! region at a time: a [`super::TILE_PX`] cell of the photometric and
//! overlap scans, or one haloed output tile of the composite. For each
//! frame that region can see, [`read_window`] reads from the frame store
//! only the source rectangle that the region's bicubic taps touch, so no
//! stage holds a whole 100 MP frame.
//!
//! A window keeps frame coordinates ([`SourceWindow`]), so a windowed
//! sample is bit-identical to sampling the whole frame.

use rayon::prelude::*;

use crate::boundary_warp::CanvasWarp;
use crate::error::PanoError;
use crate::frame_store::{FrameRect, FrameRows, WINDOW_BYTES_PER_PX};
pub(super) use crate::frame_store::{SourceView, SourceWindow};
use crate::similarity::Similarity2d;

/// Extra source pixels kept on every side of the computed tap range, so
/// float rounding in the inverse map can never put a tap outside the
/// window.
const SLACK_PX: i64 = 2;

/// Ceiling on the windows a scan's concurrently running cells hold.
const SCAN_WINDOW_BUDGET_BYTES: u64 = 512 << 20;

/// A half-open canvas pixel rectangle `[x0, x1) × [y0, y1)`.
#[derive(Clone, Copy, Debug)]
pub(super) struct Cell {
    pub x0: usize,
    pub y0: usize,
    pub x1: usize,
    pub y1: usize,
}

/// A continuous canvas box `(x0, y0, x1, y1)`.
pub(super) type CanvasBox = (f64, f64, f64, f64);

impl Cell {
    /// The box of the cell's pixel centres.
    pub fn centres(self) -> CanvasBox {
        (
            self.x0 as f64 + 0.5,
            self.y0 as f64 + 0.5,
            self.x1 as f64 - 0.5,
            self.y1 as f64 - 0.5,
        )
    }

    /// The canvas box output `cell`'s pixel centres sample through `warp`
    /// (#5572): the centres themselves without one.
    pub fn sampled_centres(self, warp: Option<CanvasWarp<'_>>) -> CanvasBox {
        let (x0, y0, x1, y1) = self.centres();
        warp.map_or((x0, y0, x1, y1), |w| w.unwarped_bounds(x0, y0, x1, y1))
    }

    /// The canvas box output `cell` samples through `warp`, edges included:
    /// the cell itself without one.
    pub fn sampled_extent(self, warp: Option<CanvasWarp<'_>>) -> CanvasBox {
        let (x0, y0, x1, y1) = (
            self.x0 as f64,
            self.y0 as f64,
            self.x1 as f64,
            self.y1 as f64,
        );
        warp.map_or((x0, y0, x1, y1), |w| w.unwarped_bounds(x0, y0, x1, y1))
    }
}

/// `window_px`-sided cells covering `[0, cw) × [0, ch)` in row-major
/// order — the canonical order the scans fold their per-cell results in.
pub(super) fn spatial_cells(cw: usize, ch: usize, window_px: usize) -> Vec<Cell> {
    (0..ch)
        .step_by(window_px)
        .flat_map(|y0| {
            (0..cw).step_by(window_px).map(move |x0| Cell {
                x0,
                y0,
                x1: (x0 + window_px).min(cw),
                y1: (y0 + window_px).min(ch),
            })
        })
        .collect()
}

/// Whether a canvas bbox `(x0, y0, x1, y1)` touches the canvas box `extent`
/// (inclusive, so a sample on the bbox edge still finds its frame's window).
pub(super) fn bbox_touches(bbox: CanvasBox, extent: CanvasBox) -> bool {
    let (bx0, by0, bx1, by1) = bbox;
    let (ex0, ey0, ex1, ey1) = extent;
    bx1 >= ex0 && bx0 <= ex1 && by1 >= ey0 && by0 <= ey1
}

/// Read the part of frame `frame_idx` that bicubic samples anywhere in the
/// canvas box `samples` need, where `inv` maps canvas to frame pixels and a
/// local mesh may move each sample point by up to `pad_px`.
pub(super) fn read_window(
    frames: &dyn FrameRows,
    frame_idx: usize,
    inv: &Similarity2d,
    samples: CanvasBox,
    pad_px: f64,
) -> Result<SourceWindow, PanoError> {
    plan_window(frames, frame_idx, inv, samples, pad_px)?.read(frames)
}

/// Which rectangle of a frame [`read_window`] would read, before reading.
struct WindowPlan {
    frame_idx: usize,
    rect: Option<FrameRect>,
    frame_w: u32,
    frame_h: u32,
}

impl WindowPlan {
    fn bytes(&self) -> u64 {
        self.rect.map_or(0, |r| {
            u64::from(r.width) * u64::from(r.height) * WINDOW_BYTES_PER_PX
        })
    }

    fn read(&self, frames: &dyn FrameRows) -> Result<SourceWindow, PanoError> {
        SourceWindow::read(
            frames,
            self.frame_idx,
            self.rect,
            (self.frame_w, self.frame_h),
        )
    }
}

/// `inv` is a similarity, so the frame-space image of the sample box is the
/// parallelogram spanned by its mapped corners and their bbox bounds every
/// sample point. A sample at `fx` reads columns `⌊fx − ½⌋ − 1 ..= ⌊fx − ½⌋ + 2`
/// (rows likewise); the window is that range plus [`SLACK_PX`], clipped to
/// the frame, and empty when nothing of the frame is in reach.
fn plan_window(
    frames: &dyn FrameRows,
    frame_idx: usize,
    inv: &Similarity2d,
    (sx0, sy0, sx1, sy1): CanvasBox,
    pad_px: f64,
) -> Result<WindowPlan, PanoError> {
    let (frame_w, frame_h) = frames.frame_dims(frame_idx)?;
    let corners =
        [(sx0, sy0), (sx1, sy0), (sx0, sy1), (sx1, sy1)].map(|(cx, cy)| inv.apply(cx, cy));
    let span = |coord: fn(&(f64, f64)) -> f64, len: u32| -> Option<(u32, u32)> {
        let lo = corners.iter().map(coord).fold(f64::INFINITY, f64::min);
        let hi = corners.iter().map(coord).fold(f64::NEG_INFINITY, f64::max);
        let first = ((lo - pad_px - 0.5).floor() as i64 - 1 - SLACK_PX).max(0);
        let last = ((hi + pad_px - 0.5).floor() as i64 + 2 + SLACK_PX).min(i64::from(len) - 1);
        (first <= last).then(|| (first as u32, (last - first + 1) as u32))
    };
    let rect =
        span(|c| c.0, frame_w)
            .zip(span(|c| c.1, frame_h))
            .map(|((x0, width), (y0, height))| FrameRect {
                x0,
                y0,
                width,
                height,
            });
    Ok(WindowPlan {
        frame_idx,
        rect,
        frame_w,
        frame_h,
    })
}

/// The frames one full-canvas scan samples: `frame_ids[i]` is pose `i`'s
/// original frame index, `inv_sims[i]` its canvas→frame map and
/// `bboxes[i]` its canvas bbox. Cells are output cells sampling the canvas
/// through `warp`, when there is one.
pub(super) struct ScanFrames<'a> {
    pub frame_ids: Vec<usize>,
    pub inv_sims: &'a [Similarity2d],
    pub bboxes: &'a [(f64, f64, f64, f64)],
    pub warp: Option<CanvasWarp<'a>>,
}

/// Run `per_cell` over every [`super::TILE_PX`] cell of a `cw × ch` canvas
/// with the windows of the frames that reach it, indexed like the poses.
///
/// A scan only ever uses points two or more frames cover, so a cell fewer
/// than two frames reach reads nothing and gets all `None`. Cells run in
/// parallel in consecutive groups whose windows total at most
/// [`SCAN_WINDOW_BUDGET_BYTES`] — a canvas cap that shrinks the canvas
/// grows every cell's source footprint, so the budget, not the thread
/// count, bounds residency. Results come back in canonical cell order.
pub(super) fn scan_cells<T: Send>(
    frames: &dyn FrameRows,
    scan: &ScanFrames<'_>,
    cw: usize,
    ch: usize,
    per_cell: impl Fn(Cell, &[Option<SourceWindow>]) -> T + Sync,
) -> Result<Vec<T>, PanoError> {
    let plans = spatial_cells(cw, ch, super::TILE_PX)
        .into_iter()
        .map(|cell| plan_cell(frames, scan, cell).map(|plan| (cell, plan)))
        .collect::<Result<Vec<_>, PanoError>>()?;
    budget_groups(&plans, |(_, plan)| {
        plan.iter().flatten().map(WindowPlan::bytes).sum()
    })
    .into_iter()
    .try_fold(Vec::with_capacity(plans.len()), |mut out, group| {
        let part = group
            .par_iter()
            .map(|(cell, plan)| {
                let windows = plan
                    .iter()
                    .map(|p| p.as_ref().map(|p| p.read(frames)).transpose())
                    .collect::<Result<Vec<_>, PanoError>>()?;
                Ok(per_cell(*cell, &windows))
            })
            .collect::<Result<Vec<T>, PanoError>>()?;
        out.extend(part);
        Ok(out)
    })
}

fn plan_cell(
    frames: &dyn FrameRows,
    scan: &ScanFrames<'_>,
    cell: Cell,
) -> Result<Vec<Option<WindowPlan>>, PanoError> {
    let extent = cell.sampled_extent(scan.warp);
    let centres = cell.sampled_centres(scan.warp);
    let reaching = scan
        .bboxes
        .iter()
        .filter(|&&b| bbox_touches(b, extent))
        .count();
    scan.bboxes
        .iter()
        .enumerate()
        .map(|(i, &bbox)| {
            (reaching >= 2 && bbox_touches(bbox, extent))
                .then(|| plan_window(frames, scan.frame_ids[i], &scan.inv_sims[i], centres, 0.0))
                .transpose()
        })
        .collect()
}

/// Split `items` into consecutive groups whose `bytes` total at most
/// [`SCAN_WINDOW_BUDGET_BYTES`]; an item over budget on its own gets its
/// own group.
fn budget_groups<I>(items: &[I], bytes: impl Fn(&I) -> u64) -> Vec<&[I]> {
    let (mut groups, mut start, mut total) = (Vec::new(), 0, 0u64);
    for (i, item) in items.iter().enumerate() {
        let b = bytes(item);
        if i > start && total + b > SCAN_WINDOW_BUDGET_BYTES {
            groups.push(&items[start..i]);
            (start, total) = (i, 0);
        }
        total += b;
    }
    if start < items.len() {
        groups.push(&items[start..]);
    }
    groups
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame_store::InMemory;
    use crate::ingest::{PlanarImage, ValidityMask};

    fn textured(w: u32, h: u32) -> PlanarImage {
        let plane: Vec<f32> = (0..w * h)
            .map(|i| (i.wrapping_mul(2_654_435_761) >> 16) as f32 / 65536.0)
            .collect();
        let mut validity = ValidityMask::new_filled(w, h, true);
        validity.set(w / 2, h / 3, false);
        PlanarImage::from_planes(w, h, plane.clone(), plane.clone(), plane, validity)
    }

    /// Every bicubic sample over a region, through its window, equals the
    /// whole-frame sample — across rotations, scales, frame edges, and
    /// sample points a local mesh moves by up to the pad.
    #[test]
    fn windowed_samples_match_whole_frame_samples() {
        let frame = textured(97, 71);
        let frames = [frame.clone()];
        let sims = [
            (1.0, 0.0, 3.0, -2.0),
            (0.8, 0.4, 20.0, -15.0),
            (1.3, -1.2, 60.0, 40.0),
            (1.0, std::f64::consts::FRAC_PI_2, 80.0, 5.0),
        ];
        let regions = [
            Cell {
                x0: 0,
                y0: 0,
                x1: 40,
                y1: 30,
            },
            Cell {
                x0: 25,
                y0: 10,
                x1: 26,
                y1: 11,
            },
            Cell {
                x0: 50,
                y0: 40,
                x1: 130,
                y1: 120,
            },
        ];
        let pad = 3.5;
        let shifts = [
            (0.0, 0.0),
            (pad, 0.0),
            (-pad, 0.0),
            (0.0, pad),
            (0.0, -pad),
            (pad * 0.7, -pad * 0.7),
        ];
        for (scale, theta, tx, ty) in sims {
            let inv = Similarity2d {
                scale,
                theta,
                tx,
                ty,
            };
            for region in regions {
                let window =
                    read_window(&InMemory(&frames), 0, &inv, region.centres(), pad).unwrap();
                let (windowed, whole) = (window.view(), SourceView::whole(&frame));
                for cy in region.y0..region.y1 {
                    for cx in region.x0..region.x1 {
                        let (fx, fy) = inv.apply(cx as f64 + 0.5, cy as f64 + 0.5);
                        for (dx, dy) in shifts {
                            let (x, y) = (fx + dx - 0.5, fy + dy - 0.5);
                            assert_eq!(
                                super::super::warp::sample_bicubic(windowed, x, y),
                                super::super::warp::sample_bicubic(whole, x, y),
                                "sim {inv:?} canvas ({cx}, {cy}) shift ({dx}, {dy})"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn budget_groups_stay_under_the_budget_and_keep_order() {
        let half = SCAN_WINDOW_BUDGET_BYTES / 2;
        let items = [half, half, 1, SCAN_WINDOW_BUDGET_BYTES * 2, 3, 4];
        let groups = budget_groups(&items, |&b| b);
        assert_eq!(
            groups,
            [
                &[half, half][..],
                &[1],
                &[SCAN_WINDOW_BUDGET_BYTES * 2],
                &[3, 4]
            ]
        );
    }

    /// A cell only one frame reaches can't yield a pair, so it reads nothing.
    #[test]
    fn a_cell_one_frame_reaches_reads_nothing() {
        let frames = [textured(64, 64), textured(64, 64)];
        let near = Similarity2d {
            scale: 1.0,
            theta: 0.0,
            tx: 0.0,
            ty: 0.0,
        };
        let far = Similarity2d {
            scale: 1.0,
            theta: 0.0,
            tx: -5000.0,
            ty: 0.0,
        };
        let scan = ScanFrames {
            frame_ids: vec![0, 1],
            inv_sims: &[near, far],
            bboxes: &[(0.0, 0.0, 64.0, 64.0), (5000.0, 0.0, 5064.0, 64.0)],
            warp: None,
        };
        let reads = scan_cells(&InMemory(&frames), &scan, 64, 64, |_, windows| {
            windows.iter().filter(|w| w.is_some()).count()
        })
        .unwrap();
        assert_eq!(reads, [0]);
    }

    #[test]
    fn a_region_out_of_reach_reads_nothing() {
        let frames = [textured(16, 16)];
        let inv = Similarity2d {
            scale: 1.0,
            theta: 0.0,
            tx: 500.0,
            ty: 0.0,
        };
        let cell = Cell {
            x0: 0,
            y0: 0,
            x1: 8,
            y1: 8,
        };
        let window = read_window(&InMemory(&frames), 0, &inv, cell.centres(), 0.0).unwrap();
        assert_eq!(window.view().pixels().width(), 0);
    }

    #[test]
    fn cells_tile_the_canvas_row_major() {
        let cells = spatial_cells(5, 3, 2);
        let spans: Vec<_> = cells.iter().map(|c| (c.x0, c.y0, c.x1, c.y1)).collect();
        assert_eq!(
            spans,
            [
                (0, 0, 2, 2),
                (2, 0, 4, 2),
                (4, 0, 5, 2),
                (0, 2, 2, 3),
                (2, 2, 4, 3),
                (4, 2, 5, 3)
            ]
        );
    }
}
