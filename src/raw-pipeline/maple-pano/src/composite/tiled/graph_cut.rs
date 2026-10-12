//! Graph-cut variant of the memory-bounded tiled composite (#1179).
//!
//! `composite_tiled` and `composite_tiled_frames` (the parent module)
//! stream one full-resolution frame at a time and pick a per-pixel
//! *owner* geometrically — a decision that needs no pixel data, so it
//! fits the tiled architecture directly. Content-aware seam placement
//! isn't geometric: it needs actual overlapping frames' pixels together
//! to decide who wins, which the streaming loop's "one frame resident at
//! a time" discipline can't provide without breaking the memory bound
//! #1254 exists to guarantee.
//!
//! The fix used here: run the content-aware decision **once**, before
//! the tile loop, at a resolution cheap enough to hold every frame's
//! result at once (`seam::masks::build_from_paths` — the "downsampled
//! overlaps, <= ~2MP" the ticket describes), and turn the tile loop's
//! per-pixel decision from a hard geometric owner into a **weight**
//! sampled from that precomputed result ([`crate::seam::SeamMasks::weight`])
//! and multi-band blended through [`super::strips`] (#4524). Peak memory adds only the seam
//! masks themselves (`O(k * seam_canvas_pixels)`, a few MB even at
//! `k` = 21) on top of the existing one-frame-at-a-time streaming.
//!
//! The geometric [`super::strips::survey`] is still run — not to decide
//! ownership, but as a cheap "does this frame touch this window at all"
//! skip test so a frame with no footprint there isn't decoded, and for the
//! overlap width that sets the band count (a property of the frame layout,
//! not of which seam algorithm placed the boundary).

use crate::blend::levels_for_overlap_width;
use crate::camera::Camera;
use crate::canvas::CanvasSpec;
use crate::error::PanoError;
use crate::gain::FramePhotometry;
use crate::ingest::{ingest_file, PlanarImage};
use crate::local_align::LocalCorrection;
use crate::seam::{self, SeamConstraint, SeamMasks};
use crate::warp::warp_to_canvas_strip;

use super::super::CompositeReport;
use super::{check_inputs, strips};

pub(super) fn composite_tiled_graph_cut(
    paths: &[std::path::PathBuf],
    cameras: &[Camera],
    photometry: &[FramePhotometry],
    local_corrections: &[Option<LocalCorrection>],
    canvas: &CanvasSpec,
    tile_rows: u32,
    seam_constraints: &[SeamConstraint],
) -> Result<(PlanarImage, CompositeReport), PanoError> {
    check_inputs(
        "composite_tiled(graph_cut)",
        "paths",
        paths.len(),
        cameras.len(),
        photometry.len(),
        local_corrections.len(),
    )?;

    let seam = seam::masks::build_from_paths(
        paths,
        cameras,
        photometry,
        local_corrections,
        canvas,
        seam_constraints,
    )?;

    graph_cut_blend(
        cameras,
        photometry,
        local_corrections,
        canvas,
        tile_rows,
        &seam,
        |fi, tile_y0, tile_y1| {
            let frame = ingest_file(&paths[fi])?;
            let la = local_corrections.get(fi).and_then(|o| o.as_ref());
            Ok(warp_to_canvas_strip(
                &frame.image,
                &cameras[fi],
                canvas,
                photometry[fi],
                la,
                tile_y0,
                tile_y1,
            ))
        },
    )
}

pub(super) fn composite_tiled_frames_graph_cut(
    frames: &[PlanarImage],
    cameras: &[Camera],
    photometry: &[FramePhotometry],
    local_corrections: &[Option<LocalCorrection>],
    canvas: &CanvasSpec,
    tile_rows: u32,
    seam_constraints: &[SeamConstraint],
) -> Result<(PlanarImage, CompositeReport), PanoError> {
    check_inputs(
        "composite_tiled_frames(graph_cut)",
        "frames",
        frames.len(),
        cameras.len(),
        photometry.len(),
        local_corrections.len(),
    )?;

    let seam = seam::masks::build_from_frames(
        frames,
        cameras,
        photometry,
        local_corrections,
        canvas,
        seam_constraints,
    )?;

    graph_cut_blend(
        cameras,
        photometry,
        local_corrections,
        canvas,
        tile_rows,
        &seam,
        |fi, tile_y0, tile_y1| {
            let la = local_corrections.get(fi).and_then(|o| o.as_ref());
            Ok(warp_to_canvas_strip(
                &frames[fi],
                &cameras[fi],
                canvas,
                photometry[fi],
                la,
                tile_y0,
                tile_y1,
            ))
        },
    )
}

/// Multi-band blend every frame that has *some* geometric footprint in a
/// strip window, weighted by [`SeamMasks::weight`]. `warp_strip(frame_index,
/// y0, y1)` is the caller's decode-or-reuse closure, so the file-path and
/// pre-loaded-frames entry points share this loop.
fn graph_cut_blend(
    cameras: &[Camera],
    photometry: &[FramePhotometry],
    local_corrections: &[Option<LocalCorrection>],
    canvas: &CanvasSpec,
    tile_rows: u32,
    seam: &SeamMasks,
    warp_strip: impl FnMut(usize, u32, u32) -> Result<PlanarImage, PanoError>,
) -> Result<(PlanarImage, CompositeReport), PanoError> {
    let survey = strips::survey(cameras, local_corrections, canvas, tile_rows, false);
    let levels = levels_for_overlap_width(survey.min_overlap_px);
    let blended = strips::blend_strips(
        (canvas.width, canvas.height),
        cameras.len(),
        tile_rows,
        levels,
        |fi, y0, y1| survey.footprint_touches(fi, y0, y1),
        |fi, x, y| seam.weight(fi, x as f64 + 0.5, y as f64 + 0.5),
        warp_strip,
    )?;
    let report = CompositeReport {
        canvas: canvas.clone(),
        projection: canvas.projection,
        photometry: photometry.to_vec(),
        blend_levels: levels,
        min_overlap_width_px: survey.min_overlap_px,
        seam_strategy: seam::SeamStrategy::GraphCut,
    };
    Ok((blended, report))
}
