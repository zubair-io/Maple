//! Graph-cut variant of the memory-bounded tiled composite (#1179).
//!
//! `composite_tiled` (the parent module) streams each frame's strip
//! window and picks a per-pixel
//! *owner* geometrically — a decision that needs no pixel data, so it
//! fits the tiled architecture directly. Content-aware seam placement
//! isn't geometric: it needs actual overlapping frames' pixels together
//! to decide who wins, which the streaming loop's "one frame resident at
//! a time" discipline can't provide without breaking the memory bound
//! #1254 exists to guarantee.
//!
//! The fix used here: run the content-aware decision **once**, before
//! the tile loop, at a resolution cheap enough to hold every frame's
//! result at once (`seam::masks::build_from_rows` — the "downsampled
//! overlaps, <= ~2MP" the ticket describes), and turn the tile loop's
//! per-pixel decision from a hard geometric owner into a **weight**
//! sampled from that precomputed result ([`crate::seam::SeamMasks::weight`])
//! and multi-band blended through [`super::strips`] (#4524). Peak memory adds only the seam
//! masks themselves (`O(k * seam_canvas_pixels)`, a few MB even at
//! `k` = 21) on top of the existing one-frame-at-a-time streaming.
//!
//! The geometric [`super::strips::survey`] is still run — not to decide
//! ownership, but as a cheap "does this frame touch this window at all"
//! skip test so a frame with no footprint there isn't read, and for the
//! overlap width that sets the band count (a property of the frame layout,
//! not of which seam algorithm placed the boundary).

use crate::blend::levels_for_overlap_width;
use crate::camera::Camera;
use crate::canvas::CanvasSpec;
use crate::error::PanoError;
use crate::frame_store::FrameRows;
use crate::gain::{ExposureField, FramePhotometry};
use crate::ingest::PlanarImage;
use crate::local_align::LocalCorrection;
use crate::seam::{self, SeamConstraint, SeamMasks};

use super::super::{AutoCropReport, CanvasSink, CompositeReport, CropSink};
use super::{check_inputs, strips, warp_frame_strip};

#[allow(clippy::too_many_arguments)]
pub(super) fn composite_tiled_graph_cut(
    frames: &dyn FrameRows,
    cameras: &[Camera],
    photometry: &[FramePhotometry],
    local_corrections: &[Option<LocalCorrection>],
    exposure_field: Option<&ExposureField>,
    canvas: &CanvasSpec,
    tile_rows: u32,
    seam_constraints: &[SeamConstraint],
    auto_crop: bool,
    sink: &mut dyn CanvasSink,
) -> Result<CompositeReport, PanoError> {
    check_inputs(
        "composite_tiled(graph_cut)",
        "frames",
        frames.frame_count(),
        cameras.len(),
        photometry.len(),
        local_corrections.len(),
    )?;

    let Some(seam) = seam::masks::build_from_rows(
        frames,
        cameras,
        photometry,
        local_corrections,
        canvas,
        seam_constraints,
    )?
    else {
        return super::composite_tiled_voronoi(
            frames,
            cameras,
            photometry,
            local_corrections,
            exposure_field,
            canvas,
            tile_rows,
            auto_crop,
            sink,
        );
    };

    graph_cut_blend(
        cameras,
        photometry,
        local_corrections,
        canvas,
        tile_rows,
        &seam,
        auto_crop,
        |fi, tile_y0, tile_y1| {
            warp_frame_strip(
                frames,
                fi,
                cameras,
                photometry,
                local_corrections,
                exposure_field,
                canvas,
                (tile_y0, tile_y1),
            )
        },
        sink,
    )
}

/// Multi-band blend every frame that has *some* geometric footprint in a
/// strip window, weighted by [`SeamMasks::weight`]. `warp_strip(frame_index,
/// y0, y1)` is the caller's warp closure.
#[allow(clippy::too_many_arguments)]
fn graph_cut_blend(
    cameras: &[Camera],
    photometry: &[FramePhotometry],
    local_corrections: &[Option<LocalCorrection>],
    canvas: &CanvasSpec,
    tile_rows: u32,
    seam: &SeamMasks,
    auto_crop: bool,
    warp_strip: impl FnMut(usize, u32, u32) -> Result<PlanarImage, PanoError>,
    sink: &mut dyn CanvasSink,
) -> Result<CompositeReport, PanoError> {
    let weight = |fi: usize, x: usize, y: usize| {
        let (ux, uy) = canvas.unwarp(x as f64 + 0.5, y as f64 + 0.5);
        seam.weight(fi, ux, uy)
    };
    let crop_weight = auto_crop.then_some(&weight as &strips::CropWeight);
    let survey = strips::survey(cameras, local_corrections, canvas, false, crop_weight);
    let levels = levels_for_overlap_width(survey.min_overlap_px);
    strips::blend_strips(
        (canvas.width, canvas.height),
        cameras.len(),
        tile_rows,
        levels,
        |fi, y0, y1| survey.footprint_touches(fi, y0, y1),
        weight,
        warp_strip,
        &mut CropSink::new(sink, survey.crop_rect),
    )?;
    let report = CompositeReport {
        canvas: canvas.clone(),
        projection: canvas.projection,
        photometry: photometry.to_vec(),
        falloff: Vec::new(),
        blend_levels: levels,
        min_overlap_width_px: survey.min_overlap_px,
        seam_strategy: seam::SeamStrategy::GraphCut,
        exposure_field: None,
        owner: None,
        boundary_warp: None,
        uncovered_px: 0,
        auto_crop: auto_crop.then_some(AutoCropReport {
            rect: survey.crop_rect,
            invalid_px: 0,
        }),
    };
    Ok(report)
}
