//! Memory-bounded tiled composite functions (M6-D, #1248).
//!
//! [`composite_tiled`] and [`composite_tiled_frames`] composite the canvas
//! strip by strip, decoding (or re-using) source frames one at a time so at
//! most one full-resolution frame is resident per strip pass. See the parent
//! module doc for the measured memory reality and the #1254 deferral.
//!
//! Both dispatch on [`SeamStrategy`] (#1179) and both multi-band blend
//! (#4524) through [`strips`]: Voronoi weights each frame by hard ownership
//! computed from camera geometry alone; `GraphCut` ([`graph_cut`]) samples a
//! downsampled seam solved once before the strip loop. Either way the result
//! equals the whole-canvas [`crate::blend::blend_multiband`] at the band count
//! [`crate::composite::composite`] would pick, independent of `tile_rows`.

mod graph_cut;
mod strips;

use rayon::prelude::*;

use crate::blend::levels_for_overlap_width;
use crate::camera::Camera;
use crate::canvas::CanvasSpec;
use crate::error::PanoError;
use crate::gain::FramePhotometry;
use crate::ingest::{ingest_file, PlanarImage};
use crate::local_align::LocalCorrection;
use crate::seam::SeamStrategy;
use crate::warp::warp_to_canvas_strip;

use super::CompositeReport;

/// Compute per-frame Voronoi depth scores over one canvas strip.
///
/// A pixel participates only if its projection lands **within** the source
/// frame bounds after the local correction (if any) is applied. This matches
/// the non-tiled `voronoi_masks`, which gates on `layer.validity` — a value
/// that is `false` for out-of-bounds projections from `warp_to_canvas`.
fn tile_depths(
    cameras: &[Camera],
    local_corrections: &[Option<LocalCorrection>],
    canvas: &CanvasSpec,
    tile_y0: u32,
    tile_y1: u32,
) -> Vec<Vec<f32>> {
    let cw = canvas.width as usize;
    let th = (tile_y1 - tile_y0) as usize;
    let tile_n = cw * th;
    cameras
        .par_iter()
        .enumerate()
        .map(|(fi, cam)| {
            let la = if local_corrections.is_empty() {
                None
            } else {
                local_corrections.get(fi).and_then(|o| o.as_ref())
            };
            let mut d = vec![-1.0_f32; tile_n];
            for sy in 0..th {
                let canvas_y = tile_y0 as usize + sy;
                for x in 0..cw {
                    let Some(dir) = canvas.pixel_to_dir(x as f64 + 0.5, canvas_y as f64 + 0.5)
                    else {
                        continue;
                    };
                    let Some((mut sx, mut sy_src)) = cam.world_dir_to_pixel(dir) else {
                        continue;
                    };
                    // Apply local correction before bounds test.
                    if let Some(la) = la {
                        (sx, sy_src) = la.apply(sx, sy_src);
                    }
                    // Require corrected projection to be within frame bounds.
                    if sx < 0.0
                        || sx > cam.width as f64
                        || sy_src < 0.0
                        || sy_src > cam.height as f64
                    {
                        continue;
                    }
                    let border = sx
                        .min(cam.width as f64 - sx)
                        .min(sy_src)
                        .min(cam.height as f64 - sy_src);
                    d[sy * cw + x] = border.max(0.0) as f32;
                }
            }
            d
        })
        .collect()
}

/// Assign Voronoi ownership (frame index, or `u16::MAX` = uncovered) and
/// accumulate pairwise overlap counts + distinct rows for the overlap-width
/// report.
fn assign_owners(
    depths: &[Vec<f32>],
    tile_y0: u32,
    cw: usize,
    tile_n: usize,
    k: usize,
    overlap_count: &mut [Vec<usize>],
    overlap_rows: &mut [Vec<std::collections::BTreeSet<usize>>],
) -> Vec<u16> {
    let mut owner = vec![u16::MAX; tile_n];
    for i in 0..tile_n {
        let mut best: Option<(usize, f32)> = None;
        for (f, depth) in depths.iter().enumerate() {
            let d = depth[i];
            if d < 0.0 {
                continue;
            }
            if best.is_none_or(|(_, bd)| d > bd) {
                best = Some((f, d));
            }
        }
        if let Some((f, _)) = best {
            owner[i] = f as u16;
        }
        let canvas_row = tile_y0 as usize + i / cw;
        for a in 0..k {
            if depths[a][i] < 0.0 {
                continue;
            }
            for b in (a + 1)..k {
                if depths[b][i] >= 0.0 {
                    overlap_count[a][b] += 1;
                    overlap_rows[a][b].insert(canvas_row);
                }
            }
        }
    }
    owner
}

/// Compute the min-overlap-width summary from accumulated pairwise data.
fn min_overlap_width(
    k: usize,
    overlap_count: &[Vec<usize>],
    overlap_rows: &[Vec<std::collections::BTreeSet<usize>>],
) -> usize {
    let mut min_overlap = usize::MAX;
    for a in 0..k {
        for b in (a + 1)..k {
            let rows = overlap_rows[a][b].len();
            if rows == 0 {
                continue;
            }
            min_overlap = min_overlap.min(overlap_count[a][b] / rows);
        }
    }
    if min_overlap == usize::MAX {
        0
    } else {
        min_overlap
    }
}

/// Memory-bounded tiled compositing: decode each source frame on demand,
/// warp it into one strip's blend window, fold it into that window's
/// multi-band accumulator, and free it before the next frame. The gain
/// solution is pre-computed by the caller.
///
/// Dispatches on `seam_strategy` (#1179): [`SeamStrategy::Voronoi`]
/// (default) weights by per-pixel ownership from camera geometry alone (no
/// pixels needed); [`SeamStrategy::GraphCut`] delegates to
/// [`graph_cut::composite_tiled_graph_cut`]. The band count follows the
/// same `log2(min overlap width)` rule as [`crate::composite::composite`]
/// and is reported in [`CompositeReport::blend_levels`].
///
/// # Errors
/// Returns `PanoError` if any frame fails to decode or if camera/path
/// slices are inconsistent.
#[allow(clippy::too_many_arguments)]
pub fn composite_tiled(
    paths: &[std::path::PathBuf],
    cameras: &[Camera],
    photometry: &[FramePhotometry],
    local_corrections: &[Option<LocalCorrection>],
    canvas: &CanvasSpec,
    tile_rows: u32,
    seam_strategy: SeamStrategy,
) -> Result<(PlanarImage, CompositeReport), PanoError> {
    match seam_strategy {
        SeamStrategy::Voronoi => composite_tiled_voronoi(
            paths,
            cameras,
            photometry,
            local_corrections,
            canvas,
            tile_rows,
        ),
        SeamStrategy::GraphCut => graph_cut::composite_tiled_graph_cut(
            paths,
            cameras,
            photometry,
            local_corrections,
            canvas,
            tile_rows,
        ),
    }
}

fn composite_tiled_voronoi(
    paths: &[std::path::PathBuf],
    cameras: &[Camera],
    photometry: &[FramePhotometry],
    local_corrections: &[Option<LocalCorrection>],
    canvas: &CanvasSpec,
    tile_rows: u32,
) -> Result<(PlanarImage, CompositeReport), PanoError> {
    check_inputs(
        "composite_tiled",
        "paths",
        paths.len(),
        cameras.len(),
        photometry.len(),
        local_corrections.len(),
    )?;
    voronoi_blend(
        cameras,
        photometry,
        local_corrections,
        canvas,
        tile_rows,
        |fi, y0, y1| {
            let frame = ingest_file(&paths[fi])?;
            let la = local_corrections.get(fi).and_then(|o| o.as_ref());
            Ok(warp_to_canvas_strip(
                &frame.image,
                &cameras[fi],
                canvas,
                photometry[fi],
                la,
                y0,
                y1,
            ))
        },
    )
}

/// Tiled composite with pre-loaded frames (for tests and offline use
/// where frames are already in memory).
///
/// Same tiling logic as [`composite_tiled`] but takes `&[PlanarImage]`
/// instead of file paths — no I/O, no decode.  Useful for unit tests
/// and for callers that decoded frames for another purpose and kept them.
/// Dispatches on `seam_strategy` the same way [`composite_tiled`] does.
///
/// See [`composite_tiled`] for the memory model and blend contract.
#[allow(clippy::too_many_arguments)]
pub fn composite_tiled_frames(
    frames: &[PlanarImage],
    cameras: &[Camera],
    photometry: &[FramePhotometry],
    local_corrections: &[Option<LocalCorrection>],
    canvas: &CanvasSpec,
    tile_rows: u32,
    seam_strategy: SeamStrategy,
) -> Result<(PlanarImage, CompositeReport), PanoError> {
    match seam_strategy {
        SeamStrategy::Voronoi => composite_tiled_frames_voronoi(
            frames,
            cameras,
            photometry,
            local_corrections,
            canvas,
            tile_rows,
        ),
        SeamStrategy::GraphCut => graph_cut::composite_tiled_frames_graph_cut(
            frames,
            cameras,
            photometry,
            local_corrections,
            canvas,
            tile_rows,
        ),
    }
}

fn composite_tiled_frames_voronoi(
    frames: &[PlanarImage],
    cameras: &[Camera],
    photometry: &[FramePhotometry],
    local_corrections: &[Option<LocalCorrection>],
    canvas: &CanvasSpec,
    tile_rows: u32,
) -> Result<(PlanarImage, CompositeReport), PanoError> {
    check_inputs(
        "composite_tiled_frames",
        "frames",
        frames.len(),
        cameras.len(),
        photometry.len(),
        local_corrections.len(),
    )?;
    voronoi_blend(
        cameras,
        photometry,
        local_corrections,
        canvas,
        tile_rows,
        |fi, y0, y1| {
            let la = local_corrections.get(fi).and_then(|o| o.as_ref());
            Ok(warp_to_canvas_strip(
                &frames[fi],
                &cameras[fi],
                canvas,
                photometry[fi],
                la,
                y0,
                y1,
            ))
        },
    )
}

/// Voronoi weighting: each covered canvas pixel belongs wholly to the frame
/// whose projection of it sits deepest inside that frame.
fn voronoi_blend(
    cameras: &[Camera],
    photometry: &[FramePhotometry],
    local_corrections: &[Option<LocalCorrection>],
    canvas: &CanvasSpec,
    tile_rows: u32,
    warp_strip: impl FnMut(usize, u32, u32) -> Result<PlanarImage, PanoError>,
) -> Result<(PlanarImage, CompositeReport), PanoError> {
    let survey = strips::survey(cameras, local_corrections, canvas, tile_rows, true);
    let owner = survey.owner.as_deref().expect("survey kept the owner map");
    let cw = canvas.width as usize;
    let levels = levels_for_overlap_width(survey.min_overlap_px);
    let blended = strips::blend_strips(
        (canvas.width, canvas.height),
        cameras.len(),
        tile_rows,
        levels,
        |fi, y0, y1| owner[y0 as usize * cw..y1 as usize * cw].contains(&(fi as u16)),
        |fi, x, y| {
            if owner[y * cw + x] == fi as u16 {
                1.0
            } else {
                0.0
            }
        },
        warp_strip,
    )?;
    let report = CompositeReport {
        canvas: canvas.clone(),
        projection: canvas.projection,
        photometry: photometry.to_vec(),
        blend_levels: levels,
        min_overlap_width_px: survey.min_overlap_px,
        seam_strategy: SeamStrategy::Voronoi,
    };
    Ok((blended, report))
}

/// Shared shape validation for every tiled entry point.
fn check_inputs(
    entry: &str,
    noun: &str,
    sources: usize,
    cameras: usize,
    photometry: usize,
    local_corrections: usize,
) -> Result<(), PanoError> {
    if sources != cameras || sources != photometry {
        return Err(PanoError::InvalidOptions(format!(
            "{entry}: {sources} {noun}, {cameras} cameras, {photometry} photometry"
        )));
    }
    if local_corrections != 0 && local_corrections != sources {
        return Err(PanoError::InvalidOptions(format!(
            "{entry}: {local_corrections} local corrections vs {sources} {noun} (pass an empty slice to skip alignment)"
        )));
    }
    if sources == 0 {
        return Err(PanoError::InvalidOptions(format!("{entry}: no frames")));
    }
    Ok(())
}
