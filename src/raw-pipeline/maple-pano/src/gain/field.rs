//! Coarse screened residual exposure field for the rotation strategy
//! (#4521).
//!
//! [`super::FramePhotometry`] removes each frame's global gain and bias,
//! but smooth low-frequency differences can survive it — a sky gradient,
//! flare, residual vignetting. This module solves one scalar log-exposure
//! correction `δ_i` per view on a coarse node lattice over the canvas and
//! the tiled composite multiplies each warped strip by `exp(δ_i)`, so a
//! correction never changes a value's sign in scene-linear light.
//!
//! The solve runs on the downsampled seam canvas
//! ([`crate::seam::masks::SEAM_CANVAS_MAX_PX`]): every frame is warped
//! there once, with its photometry applied, one frame at a time and in
//! strips from the source rows each strip taps (#5566), and wherever two
//! views overlap their log-luminance difference is a data sample at the
//! nearest lattice node. Per (pair, node) the median sample
//! is the residual `d`, and
//!
//! ```text
//!   Σ w · (δ_i − δ_j − d)²  +  λ · smoothness  +  μ Σ δ²
//! ```
//!
//! is minimised by the shared [`crate::screened_cg`] solver. A view's
//! unknowns are only the nodes of its overlap corridor (nodes with
//! residual data, dilated by [`CORRIDOR_MARGIN_NODES`]); the field is held
//! at zero on the corridor's outer boundary, so a view's interior keeps
//! the exposure its photometry gave it. The lattice spacing is chosen so
//! no view has more than [`MAX_NODES_PER_VIEW`] unknowns.

use rayon::prelude::*;

use crate::camera::Camera;
use crate::canvas::CanvasSpec;
use crate::error::PanoError;
use crate::frame_store::{FrameRows, InMemory};
use crate::ingest::PlanarImage;
use crate::local_align::LocalCorrection;
use crate::seam::masks::SEAM_CANVAS_MAX_PX;
use crate::warp::warp_stored_to_canvas;

use super::field_solve::{solve_layers, LumaLayer};
use super::FramePhotometry;

/// Upper bound on one view's unknown count.
pub const MAX_NODES_PER_VIEW: usize = 2048;

/// Lattice rings added around a view's residual-bearing nodes before the
/// Dirichlet boundary, so the correction fades out over that distance
/// instead of stopping at the last overlap sample.
pub const CORRIDOR_MARGIN_NODES: usize = 2;

/// What the solve did, for the stitch report. Steps are weighted RMS
/// log-luminance differences between overlapping views over the
/// lattice's (pair, node) residuals — the low-frequency seam step.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ExposureFieldSummary {
    pub lattice: (usize, usize),
    pub unknowns: usize,
    pub max_unknowns_per_view: usize,
    pub max_abs_log: f32,
    pub step_rms_before: f64,
    pub step_rms_after: f64,
}

/// Node lattice over normalised canvas coordinates `(u, v) ∈ [0, 1]²`;
/// on a full-wrap canvas the periodic axis is `u` (columns), or `v`
/// (rows) for a transverse projection.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct NodeGrid {
    pub(super) nx: usize,
    pub(super) ny: usize,
    pub(super) periodic_x: bool,
    pub(super) periodic_y: bool,
}

fn axis_coord(t: f64, n: usize, periodic: bool) -> f64 {
    if periodic {
        t * n as f64
    } else {
        (t * (n - 1) as f64).clamp(0.0, (n - 1) as f64)
    }
}

fn axis_wrap(c: i64, n: usize, periodic: bool) -> usize {
    if periodic {
        c.rem_euclid(n as i64) as usize
    } else {
        c.clamp(0, n as i64 - 1) as usize
    }
}

fn axis_floor(g: f64, n: usize, periodic: bool) -> f64 {
    if periodic {
        g.floor()
    } else {
        g.floor().min((n - 2) as f64)
    }
}

fn axis_contains(c: i64, n: usize, periodic: bool) -> bool {
    periodic && n > 2 || (0..n as i64).contains(&c)
}

impl NodeGrid {
    pub(super) fn len(&self) -> usize {
        self.nx * self.ny
    }

    fn index(&self, x: i64, y: i64) -> usize {
        axis_wrap(y, self.ny, self.periodic_y) * self.nx + axis_wrap(x, self.nx, self.periodic_x)
    }

    pub(super) fn nearest(&self, u: f64, v: f64) -> usize {
        self.index(
            axis_coord(u, self.nx, self.periodic_x).round() as i64,
            axis_coord(v, self.ny, self.periodic_y).round() as i64,
        )
    }

    fn stencil(&self, u: f64, v: f64) -> [(usize, f32); 4] {
        let gx = axis_coord(u, self.nx, self.periodic_x);
        let gy = axis_coord(v, self.ny, self.periodic_y);
        let fx0 = axis_floor(gx, self.nx, self.periodic_x);
        let fy0 = axis_floor(gy, self.ny, self.periodic_y);
        let (tx, ty) = ((gx - fx0) as f32, (gy - fy0) as f32);
        let (x0, y0) = (fx0 as i64, fy0 as i64);
        [
            (self.index(x0, y0), (1.0 - tx) * (1.0 - ty)),
            (self.index(x0 + 1, y0), tx * (1.0 - ty)),
            (self.index(x0, y0 + 1), (1.0 - tx) * ty),
            (self.index(x0 + 1, y0 + 1), tx * ty),
        ]
    }

    /// 4-neighbours of `node` (wrapping across the periodic seam).
    pub(super) fn neighbours(&self, node: usize) -> impl Iterator<Item = usize> + '_ {
        let (cx, cy) = ((node % self.nx) as i64, (node / self.nx) as i64);
        [(-1, 0), (1, 0), (0, -1), (0, 1)]
            .into_iter()
            .filter_map(move |(dx, dy)| {
                let (x, y) = (cx + dx, cy + dy);
                (axis_contains(x, self.nx, self.periodic_x)
                    && axis_contains(y, self.ny, self.periodic_y))
                .then(|| self.index(x, y))
            })
    }
}

/// `(periodic_x, periodic_y)` lattice axes for `canvas`.
pub(super) fn periodic_axes(canvas: &CanvasSpec) -> (bool, bool) {
    let wraps = canvas.is_full_wrap();
    let transverse = canvas.projection.is_transverse();
    (wraps && !transverse, wraps && transverse)
}

/// Per-view coarse log-exposure corrections over one [`NodeGrid`].
#[derive(Debug, Clone)]
pub struct ExposureField {
    pub(super) grid: NodeGrid,
    /// Dense lattice values per view; `None` where the correction is
    /// negligible everywhere.
    pub(super) views: Vec<Option<Vec<f32>>>,
    pub summary: ExposureFieldSummary,
}

impl ExposureField {
    /// View `fi`'s log correction at normalised canvas position `(u, v)`.
    pub fn log_correction(&self, fi: usize, u: f64, v: f64) -> f32 {
        self.views
            .get(fi)
            .and_then(Option::as_ref)
            .map_or(0.0, |values| {
                self.grid
                    .stencil(u, v)
                    .iter()
                    .map(|&(node, w)| w * values[node])
                    .sum()
            })
    }

    /// Multiply view `fi`'s warped strip (output rows from `y0`) by its
    /// correction `exp(δ)` at every valid pixel, read at the canvas position
    /// each output pixel samples.
    pub fn apply_to_strip(&self, fi: usize, strip: &mut PlanarImage, canvas: &CanvasSpec, y0: u32) {
        if self.views.get(fi).is_none_or(Option::is_none) {
            return;
        }
        let w = strip.width() as usize;
        let (cw, ch) = (canvas.width as f64, canvas.height as f64);
        let validity = &strip.validity;
        strip
            .r
            .par_chunks_mut(w)
            .zip(strip.g.par_chunks_mut(w))
            .zip(strip.b.par_chunks_mut(w))
            .enumerate()
            .for_each(|(y, ((row_r, row_g), row_b))| {
                let py = (y0 as usize + y) as f64 + 0.5;
                for x in (0..w).filter(|&x| validity.get(x as u32, y as u32)) {
                    let (ux, uy) = canvas.unwarp(x as f64 + 0.5, py);
                    let m = self.log_correction(fi, ux / cw, uy / ch).exp();
                    row_r[x] *= m;
                    row_g[x] *= m;
                    row_b[x] *= m;
                }
            });
    }
}

/// Solve the exposure field from resident frames.
pub fn solve_exposure_field(
    frames: &[PlanarImage],
    cameras: &[Camera],
    photometry: &[FramePhotometry],
    local_corrections: &[Option<LocalCorrection>],
    canvas: &CanvasSpec,
) -> Result<ExposureField, PanoError> {
    solve_exposure_field_streaming(
        &InMemory(frames),
        cameras,
        photometry,
        local_corrections,
        canvas,
    )
}

/// Solve the exposure field from `frames`, warping one frame at a time
/// from row windows (#5566) and keeping only its seam-canvas luminance.
pub fn solve_exposure_field_streaming(
    frames: &dyn FrameRows,
    cameras: &[Camera],
    photometry: &[FramePhotometry],
    local_corrections: &[Option<LocalCorrection>],
    canvas: &CanvasSpec,
) -> Result<ExposureField, PanoError> {
    check_lengths(
        frames.frame_count(),
        cameras.len(),
        photometry.len(),
        local_corrections.len(),
    )?;
    let seam_canvas = canvas.downscaled(SEAM_CANVAS_MAX_PX);
    let layers = (0..frames.frame_count())
        .map(|i| {
            let la = local_corrections.get(i).and_then(|o| o.as_ref());
            let warped =
                warp_stored_to_canvas(frames, i, &cameras[i], &seam_canvas, photometry[i], la)?;
            Ok(LumaLayer::from_warped(&warped))
        })
        .collect::<Result<Vec<_>, PanoError>>()?;
    Ok(solve_layers(
        &layers,
        (seam_canvas.width as usize, seam_canvas.height as usize),
        periodic_axes(&seam_canvas),
    ))
}

fn check_lengths(
    sources: usize,
    cameras: usize,
    photometry: usize,
    local_corrections: usize,
) -> Result<(), PanoError> {
    if sources != cameras || sources != photometry {
        return Err(PanoError::InvalidOptions(format!(
            "solve_exposure_field: {sources} frames, {cameras} cameras, {photometry} photometry"
        )));
    }
    if local_corrections != 0 && local_corrections != sources {
        return Err(PanoError::InvalidOptions(format!(
            "solve_exposure_field: {local_corrections} local corrections vs {sources} frames"
        )));
    }
    Ok(())
}
