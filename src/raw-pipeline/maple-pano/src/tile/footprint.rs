//! The tile canvas's coverage from geometry alone: the footprint Boundary
//! Warp solves on (#5572) and Auto Crop's full-resolution rectangle (#5573).

use rayon::prelude::*;

use crate::boundary_warp::{CanvasWarp, Footprint};
use crate::composite::{CropAxes, CropRect, LargestRect};
use crate::local_align::LocalCorrection;
use crate::similarity::Similarity2d;

use super::placement::{TileCanvasSpec, TilePose};
use super::source::{bbox_touches, frame_canvas_box, CanvasBox, Cell};
use super::warp::inverse_similarity_with_offset;

/// Whether some frame covers a canvas position: a pose, after its Stage-F
/// correction, maps it inside the frame — the same test the tile warp
/// makes before it samples.
pub(crate) struct TileCoverage<'a> {
    frames: Vec<FrameCover<'a>>,
}

struct FrameCover<'a> {
    inv: Similarity2d,
    local: Option<&'a LocalCorrection>,
    dims: (f64, f64),
    /// The frame's canvas bounding box, Stage-F reach included.
    bbox: CanvasBox,
}

impl<'a> TileCoverage<'a> {
    /// `full_dims` is indexed by frame index, `corrections` parallel to
    /// `poses`.
    pub fn new(
        poses: &[TilePose],
        full_dims: &[(u32, u32)],
        corrections: Option<&'a [LocalCorrection]>,
        canvas: &TileCanvasSpec,
    ) -> Self {
        let frames = poses
            .iter()
            .enumerate()
            .map(|(i, pose)| {
                let (fw, fh) = full_dims[pose.frame_idx];
                let local = corrections.map(|c| &c[i]);
                let pad = local.map_or(0.0, |c| c.max_correction_px) * pose.sim.scale;
                let (x0, y0, x1, y1) = frame_canvas_box(pose, (fw as f64, fh as f64), canvas);
                FrameCover {
                    inv: inverse_similarity_with_offset(
                        &pose.sim,
                        canvas.offset_x,
                        canvas.offset_y,
                    ),
                    local,
                    dims: (fw as f64, fh as f64),
                    bbox: (x0 - pad, y0 - pad, x1 + pad, y1 + pad),
                }
            })
            .collect();
        Self { frames }
    }

    pub fn covers(&self, cx: f64, cy: f64) -> bool {
        self.frames.iter().any(|f| f.covers(cx, cy))
    }

    /// Only the frames whose bounding box meets the canvas box
    /// `(x0, y0, x1, y1)`.
    fn within(&self, (x0, y0, x1, y1): CanvasBox) -> Vec<&FrameCover<'a>> {
        let slack = (x0 - 1.0, y0 - 1.0, x1 + 1.0, y1 + 1.0);
        self.frames
            .iter()
            .filter(|f| bbox_touches(f.bbox, slack))
            .collect()
    }
}

impl FrameCover<'_> {
    fn covers(&self, cx: f64, cy: f64) -> bool {
        let (px, py) = self.inv.apply(cx, cy);
        let (fx, fy) = self.local.map_or((px, py), |c| c.apply(px, py));
        (0.0..=self.dims.0).contains(&fx) && (0.0..=self.dims.1).contains(&fy)
    }
}

/// Which pixels of a copy of `canvas` at most `max_px` pixels some frame
/// covers.
pub(crate) fn tile_footprint(
    coverage: &TileCoverage<'_>,
    canvas: &TileCanvasSpec,
    max_px: usize,
) -> Footprint {
    let (cw, ch) = (canvas.width as f64, canvas.height as f64);
    let scale = (max_px as f64 / (cw * ch)).sqrt().min(1.0);
    let (pw, ph) = (
        ((cw * scale).round() as u32).max(1),
        ((ch * scale).round() as u32).max(1),
    );
    Footprint::from_fn(pw, ph, false, |x, y| {
        coverage.covers(
            (x as f64 + 0.5) * cw / pw as f64,
            (y as f64 + 0.5) * ch / ph as f64,
        )
    })
}

/// Rows per pass of [`auto_crop_rect`]: its transient memory is this many
/// output rows of coverage.
const CROP_PASS_ROWS: usize = 64;

/// Auto Crop's rectangle (#5573) on the full-resolution output, each
/// output pixel tested at the canvas position `output` samples.
pub(crate) fn auto_crop_rect(
    coverage: &TileCoverage<'_>,
    canvas: &TileCanvasSpec,
    output: Option<CanvasWarp<'_>>,
) -> Option<CropRect> {
    let (cw, ch) = (canvas.width as usize, canvas.height as usize);
    let mut search = LargestRect::new(canvas.width, CropAxes::Both);
    for y0 in (0..ch).step_by(CROP_PASS_ROWS) {
        let y1 = (y0 + CROP_PASS_ROWS).min(ch);
        let pass = Cell {
            x0: 0,
            y0,
            x1: cw,
            y1,
        };
        let frames = coverage.within(pass.sampled_extent(output));
        let mut covered = vec![false; (y1 - y0) * cw];
        covered
            .par_chunks_mut(cw)
            .enumerate()
            .for_each(|(row, out)| {
                let oy = (y0 + row) as f64 + 0.5;
                for (x, slot) in out.iter_mut().enumerate() {
                    let ox = x as f64 + 0.5;
                    let (cx, cy) = output.map_or((ox, oy), |w| w.unwarp(ox, oy));
                    *slot = frames.iter().any(|f| f.covers(cx, cy));
                }
            });
        search.push_rows(&covered);
    }
    search.finish()
}
