//! The photometric sampling pass: one strided canvas scan that feeds
//! both correction layers (#350). Split from `photometry.rs` for the
//! file-size budget. A coarser scan of the same shape collects raw
//! per-point correspondences for the blind vignette estimate (#4522),
//! whose falloff the main scan then divides out of every sample.
//!
//! Every canvas grid point is inverse-mapped into each frame that could
//! cover it (bbox-prefiltered), sampled with the same bicubic kernel the
//! warp uses, and every co-visible frame pair accumulates the log-ratio
//! of the two samples — globally, and per coarse field cell. Layer A
//! consumes the global sums, layer B the per-cell ones.
//!
//! ## Frame access (#3197, #5560)
//!
//! The canvas is split into [`super::TILE_PX`]-sided cells, run through
//! `source::scan_cells`: each cell reads, for every frame whose canvas
//! bbox reaches it, only the source window its samples touch, and drops
//! those windows when the cell is done. Per-cell results come back in
//! canonical cell order, so the fold is deterministic.

use crate::error::PanoError;
use crate::frame_store::FrameRows;
use crate::gain::vignette::{falloff_gain, Correspondence};
use crate::similarity::Similarity2d;

use super::photometry::{PairMap, PhotometryOptions, MIN_LUM};
use super::placement::{TileCanvasSpec, TilePose};
use super::source::{self, Cell, SourceWindow};
use super::warp::{inverse_similarity_with_offset, sample_bicubic};

/// Canvas grid points the vignette correspondence scan targets; its
/// stride grows with the canvas so the estimate stays bounded in memory.
const CORRESPONDENCE_POINTS: f64 = 250_000.0;

/// One frame's sample at a canvas grid point: luminance, RGB and the
/// frame-local position `(ξ − ½, η − ½)`.
#[derive(Clone, Copy)]
struct Hit {
    frame: usize,
    lum: f64,
    rgb: [f64; 3],
    xi: f64,
    eta: f64,
}

impl Hit {
    /// Elliptically normalised squared radius (`r² = 2` at a corner).
    fn r2(&self) -> f64 {
        4.0 * (self.xi * self.xi + self.eta * self.eta)
    }
}

/// Per-frame inverse maps and canvas bboxes shared by every scan.
struct ScanGeometry<'a> {
    poses: &'a [TilePose],
    inv_sims: Vec<Similarity2d>,
    frame_dims: Vec<(f64, f64)>,
    bboxes: Vec<(f64, f64, f64, f64)>,
}

impl<'a> ScanGeometry<'a> {
    fn new(full_dims: &[(u32, u32)], poses: &'a [TilePose], canvas: &TileCanvasSpec) -> Self {
        let inv_sims = poses
            .iter()
            .map(|p| inverse_similarity_with_offset(&p.sim, canvas.offset_x, canvas.offset_y))
            .collect();
        let frame_dims: Vec<(f64, f64)> = poses
            .iter()
            .map(|p| {
                let (w, h) = full_dims[p.frame_idx];
                (w as f64, h as f64)
            })
            .collect();
        // Canvas-space bboxes for the cheap per-sample prefilter AND for
        // deciding which frames each spatial cell reads (#3197).
        let bboxes = poses
            .iter()
            .zip(&frame_dims)
            .map(|(pose, &(fw, fh))| {
                [(0.0, 0.0), (fw, 0.0), (0.0, fh), (fw, fh)]
                    .iter()
                    .map(|&(x, y)| pose.sim.apply(x, y))
                    .map(|(x, y)| (x + canvas.offset_x, y + canvas.offset_y))
                    .fold(
                        (
                            f64::INFINITY,
                            f64::INFINITY,
                            f64::NEG_INFINITY,
                            f64::NEG_INFINITY,
                        ),
                        |(x0, y0, x1, y1), (x, y)| (x0.min(x), y0.min(y), x1.max(x), y1.max(y)),
                    )
            })
            .collect();
        Self {
            poses,
            inv_sims,
            frame_dims,
            bboxes,
        }
    }

    fn scan<T: Send>(
        &self,
        frames: &dyn FrameRows,
        canvas: &TileCanvasSpec,
        per_cell: impl Fn(Cell, &[Option<SourceWindow>]) -> T + Sync,
    ) -> Result<Vec<T>, PanoError> {
        let scan = source::ScanFrames {
            frame_ids: self.poses.iter().map(|p| p.frame_idx).collect(),
            inv_sims: &self.inv_sims,
            bboxes: &self.bboxes,
        };
        source::scan_cells(
            frames,
            &scan,
            canvas.width as usize,
            canvas.height as usize,
            per_cell,
        )
    }

    /// Visit every strided grid point of `cell` covered by two or more
    /// frames, with each frame's sample divided by its falloff `q`
    /// (`falloff[frame] = 0` leaves the sample as recorded).
    fn visit_cell(
        &self,
        cell: Cell,
        stride: usize,
        windows: &[Option<SourceWindow>],
        falloff: &[f64],
        mut visit: impl FnMut(usize, usize, &[Hit]),
    ) {
        let k = self.poses.len();
        let mut hits: Vec<Hit> = Vec::with_capacity(k);
        let first_ry = cell.y0.div_ceil(stride) * stride;
        let first_rx = cell.x0.div_ceil(stride) * stride;

        for ry in (first_ry..cell.y1).step_by(stride) {
            let cy = ry as f64 + 0.5;
            for rx in (first_rx..cell.x1).step_by(stride) {
                let cx = rx as f64 + 0.5;
                hits.clear();
                for i in 0..k {
                    let (bx0, by0, bx1, by1) = self.bboxes[i];
                    if cx < bx0 || cx > bx1 || cy < by0 || cy > by1 {
                        continue;
                    }
                    let (fw, fh) = self.frame_dims[i];
                    let (fx, fy) = self.inv_sims[i].apply(cx, cy);
                    if fx < 0.0 || fx > fw || fy < 0.0 || fy > fh {
                        continue;
                    }
                    // No window: this frame is the only one reaching the
                    // cell, so no point here can pair it.
                    let Some(window) = &windows[i] else {
                        continue;
                    };
                    let Some(v) = sample_bicubic(window.view(), fx - 0.5, fy - 0.5) else {
                        continue;
                    };
                    let (xi, eta) = (fx / fw - 0.5, fy / fh - 0.5);
                    let q = falloff.get(i).copied().unwrap_or(0.0);
                    let gain = if q == 0.0 {
                        1.0
                    } else {
                        falloff_gain(q, 4.0 * (xi * xi + eta * eta))
                    };
                    let rgb = [
                        (v[0].max(0.0)) as f64 * gain,
                        (v[1].max(0.0)) as f64 * gain,
                        (v[2].max(0.0)) as f64 * gain,
                    ];
                    let lum = (rgb[0] + rgb[1] + rgb[2]) / 3.0;
                    if lum < MIN_LUM {
                        continue;
                    }
                    hits.push(Hit {
                        frame: i,
                        lum,
                        rgb,
                        xi,
                        eta,
                    });
                }
                if hits.len() >= 2 {
                    visit(rx, ry, &hits);
                }
            }
        }
    }
}

/// One strided canvas scan accumulating per-pair (and per-pair-per-cell)
/// log-ratio statistics, with each frame's falloff `q` (indexed like
/// `poses`) divided out first.
///
/// `full_dims` is indexed by the *original* input frame index (same
/// space as `frames` and `poses[i].frame_idx`).
pub(super) fn sample_pairs(
    frames: &dyn FrameRows,
    full_dims: &[(u32, u32)],
    poses: &[TilePose],
    canvas: &TileCanvasSpec,
    opts: &PhotometryOptions,
    falloff: &[f64],
) -> Result<PairMap, PanoError> {
    let geometry = ScanGeometry::new(full_dims, poses, canvas);
    let ncx = (canvas.width as usize).div_ceil(opts.field_cell_px);
    let cell_maps = geometry.scan(frames, canvas, |cell, windows| {
        let mut map = PairMap::new();
        geometry.visit_cell(cell, opts.stride, windows, falloff, |rx, ry, hits| {
            let cell_lin = ((ry / opts.field_cell_px) * ncx + (rx / opts.field_cell_px)) as u32;
            accumulate(&mut map, cell_lin, hits);
        });
        map
    })?;
    Ok(cell_maps
        .into_iter()
        .fold(PairMap::new(), |mut merged, map| {
            merge_into(&mut merged, map);
            merged
        }))
}

/// Raw (uncorrected) per-point correspondences between every co-visible
/// frame pair, for the blind vignette estimate. Frame indices are
/// positions in `poses`.
pub(super) fn sample_correspondences(
    frames: &dyn FrameRows,
    full_dims: &[(u32, u32)],
    poses: &[TilePose],
    canvas: &TileCanvasSpec,
    opts: &PhotometryOptions,
) -> Result<Vec<Correspondence>, PanoError> {
    let geometry = ScanGeometry::new(full_dims, poses, canvas);
    let area = canvas.width as f64 * canvas.height as f64;
    let stride = opts
        .stride
        .max((area / CORRESPONDENCE_POINTS).sqrt().ceil() as usize);
    let per_cell = geometry.scan(frames, canvas, |cell, windows| {
        let mut out = Vec::new();
        geometry.visit_cell(cell, stride, windows, &[], |_, _, hits| {
            for (a, ha) in hits.iter().enumerate() {
                for hb in &hits[a + 1..] {
                    out.push(Correspondence {
                        i: ha.frame,
                        j: hb.frame,
                        r2_i: ha.r2(),
                        r2_j: hb.r2(),
                        log_ratio: hb.lum.ln() - ha.lum.ln(),
                    });
                }
            }
        });
        out
    })?;
    Ok(per_cell.into_iter().flatten().collect())
}

fn accumulate(map: &mut PairMap, cell_lin: u32, hits: &[Hit]) {
    for (a, ha) in hits.iter().enumerate() {
        for hb in &hits[a + 1..] {
            let (i, lum_i, ch_i, xi_i, eta_i) = (ha.frame, ha.lum, ha.rgb, ha.xi, ha.eta);
            let (j, lum_j, ch_j, xi_j, eta_j) = (hb.frame, hb.lum, hb.rgb, hb.xi, hb.eta);
            let acc = map.entry((i, j)).or_default();
            let lnr = (lum_i).ln() - (lum_j).ln();
            acc.n += 1.0;
            acc.s_lnr_lum += lnr;
            acc.s_dxi += xi_i - xi_j;
            acc.s_deta += eta_i - eta_j;
            for c in 0..3 {
                if ch_i[c] > MIN_LUM && ch_j[c] > MIN_LUM {
                    acc.s_lnr_ch[c] += ch_i[c].ln() - ch_j[c].ln();
                    acc.n_ch[c] += 1.0;
                }
            }
            let cacc = acc.cells.entry(cell_lin).or_default();
            cacc.n += 1.0;
            cacc.s_lnr += lnr;
            cacc.s_dxi += xi_i - xi_j;
            cacc.s_deta += eta_i - eta_j;
        }
    }
}

/// Fold `src` into `dst`, field by field (deterministic — see module
/// docs on merge order).
fn merge_into(dst: &mut PairMap, src: PairMap) {
    for (key, acc) in src {
        let d = dst.entry(key).or_default();
        d.n += acc.n;
        d.s_lnr_lum += acc.s_lnr_lum;
        d.s_dxi += acc.s_dxi;
        d.s_deta += acc.s_deta;
        for c in 0..3 {
            d.s_lnr_ch[c] += acc.s_lnr_ch[c];
            d.n_ch[c] += acc.n_ch[c];
        }
        for (cell, cacc) in acc.cells {
            let dc = d.cells.entry(cell).or_default();
            dc.n += cacc.n;
            dc.s_lnr += cacc.s_lnr;
            dc.s_dxi += cacc.s_dxi;
            dc.s_deta += cacc.s_deta;
        }
    }
}
