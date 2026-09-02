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
//! per-pixel decision from a hard geometric owner into a **weighted
//! accumulation** sampled from that precomputed result
//! ([`crate::seam::SeamMasks::weight`]). Peak memory adds only the seam
//! masks themselves (`O(k * seam_canvas_pixels)`, a few MB even at
//! `k` = 21) on top of the existing one-frame-at-a-time streaming.
//!
//! [`tile_depths`] (the parent module's purely-geometric footprint test)
//! is still reused here — not to decide ownership, but as a cheap
//! "does this frame touch this tile at all" skip test so a frame with no
//! footprint in a tile still isn't decoded, and to keep feeding the
//! existing overlap-width bookkeeping the report surfaces (a property of
//! the frame layout, not of which seam algorithm placed the boundary).

use crate::camera::Camera;
use crate::canvas::CanvasSpec;
use crate::error::PanoError;
use crate::ingest::{ingest_file, PlanarImage, ValidityMask};
use crate::local_align::LocalCorrection;
use crate::seam::{self, SeamMasks};
use crate::warp::warp_to_canvas_strip;

use super::super::CompositeReport;
use super::{assign_owners, min_overlap_width, tile_depths};

/// Below this accumulated weight a canvas pixel is treated as uncovered
/// (avoids a division blow-up on floating-point dust from feathering).
const MIN_COVERAGE_WEIGHT: f32 = 1e-4;

type OverlapStats = (Vec<Vec<usize>>, Vec<Vec<std::collections::BTreeSet<usize>>>);

pub(super) fn composite_tiled_graph_cut(
    paths: &[std::path::PathBuf],
    cameras: &[Camera],
    gains: &[[f32; 3]],
    local_corrections: &[Option<LocalCorrection>],
    canvas: &CanvasSpec,
    tile_rows: u32,
) -> Result<(PlanarImage, CompositeReport), PanoError> {
    if paths.len() != cameras.len() || paths.len() != gains.len() {
        return Err(PanoError::InvalidOptions(format!(
            "composite_tiled(graph_cut): {} paths, {} cameras, {} gains",
            paths.len(),
            cameras.len(),
            gains.len(),
        )));
    }
    if !local_corrections.is_empty() && local_corrections.len() != paths.len() {
        return Err(PanoError::InvalidOptions(format!(
            "composite_tiled(graph_cut): {} local corrections vs {} paths (pass an empty slice to skip alignment)",
            local_corrections.len(),
            paths.len()
        )));
    }
    if paths.is_empty() {
        return Err(PanoError::InvalidOptions(
            "composite_tiled(graph_cut): no frames".into(),
        ));
    }

    let seam = seam::masks::build_from_paths(paths, cameras, gains, local_corrections, canvas)?;

    let (out_r, out_g, out_b, out_weight, overlap) = run_tiles(
        cameras,
        canvas,
        tile_rows,
        local_corrections,
        &seam,
        |fi, tile_y0, tile_y1| {
            let frame = ingest_file(&paths[fi])?;
            let la = local_corrections.get(fi).and_then(|o| o.as_ref());
            Ok(warp_to_canvas_strip(
                &frame.image,
                &cameras[fi],
                canvas,
                gains[fi],
                la,
                tile_y0,
                tile_y1,
            ))
        },
    )?;

    Ok(finish(
        out_r,
        out_g,
        out_b,
        out_weight,
        canvas,
        gains,
        cameras.len(),
        overlap,
    ))
}

pub(super) fn composite_tiled_frames_graph_cut(
    frames: &[PlanarImage],
    cameras: &[Camera],
    gains: &[[f32; 3]],
    local_corrections: &[Option<LocalCorrection>],
    canvas: &CanvasSpec,
    tile_rows: u32,
) -> Result<(PlanarImage, CompositeReport), PanoError> {
    if frames.len() != cameras.len() || frames.len() != gains.len() {
        return Err(PanoError::InvalidOptions(format!(
            "composite_tiled_frames(graph_cut): {} frames, {} cameras, {} gains",
            frames.len(),
            cameras.len(),
            gains.len(),
        )));
    }
    if !local_corrections.is_empty() && local_corrections.len() != frames.len() {
        return Err(PanoError::InvalidOptions(format!(
            "composite_tiled_frames(graph_cut): {} local corrections vs {} frames (pass an empty slice to skip alignment)",
            local_corrections.len(),
            frames.len()
        )));
    }
    if frames.is_empty() {
        return Err(PanoError::InvalidOptions(
            "composite_tiled_frames(graph_cut): no frames".into(),
        ));
    }

    let seam = seam::masks::build_from_frames(frames, cameras, gains, local_corrections, canvas);

    let (out_r, out_g, out_b, out_weight, overlap) = run_tiles(
        cameras,
        canvas,
        tile_rows,
        local_corrections,
        &seam,
        |fi, tile_y0, tile_y1| {
            let la = local_corrections.get(fi).and_then(|o| o.as_ref());
            Ok(warp_to_canvas_strip(
                &frames[fi],
                &cameras[fi],
                canvas,
                gains[fi],
                la,
                tile_y0,
                tile_y1,
            ))
        },
    )?;

    Ok(finish(
        out_r,
        out_g,
        out_b,
        out_weight,
        canvas,
        gains,
        cameras.len(),
        overlap,
    ))
}

/// Shared strip-by-strip loop: for each tile, warp every frame that has
/// *some* geometric footprint there and accumulate it weighted by
/// [`SeamMasks::weight`]. `warp_strip(frame_index, tile_y0, tile_y1)` is
/// the caller's decode-or-reuse closure, so the file-path and
/// pre-loaded-frames entry points share this loop.
fn run_tiles(
    cameras: &[Camera],
    canvas: &CanvasSpec,
    tile_rows: u32,
    local_corrections: &[Option<LocalCorrection>],
    seam: &SeamMasks,
    mut warp_strip: impl FnMut(usize, u32, u32) -> Result<PlanarImage, PanoError>,
) -> Result<(Vec<f32>, Vec<f32>, Vec<f32>, Vec<f32>, OverlapStats), PanoError> {
    let k = cameras.len();
    let tile_rows = tile_rows.max(1).min(canvas.height);
    let cw = canvas.width as usize;
    let ch = canvas.height as usize;

    let mut out_r = vec![0.0_f32; cw * ch];
    let mut out_g = vec![0.0_f32; cw * ch];
    let mut out_b = vec![0.0_f32; cw * ch];
    let mut out_weight = vec![0.0_f32; cw * ch];

    let mut overlap_count = vec![vec![0usize; k]; k];
    let mut overlap_rows: Vec<Vec<std::collections::BTreeSet<usize>>> =
        vec![vec![std::collections::BTreeSet::new(); k]; k];

    let mut tile_y0: u32 = 0;
    while tile_y0 < canvas.height {
        let tile_y1 = (tile_y0 + tile_rows).min(canvas.height);
        let tile_n = cw * (tile_y1 - tile_y0) as usize;
        let out_base = tile_y0 as usize * cw;

        let depths = tile_depths(cameras, local_corrections, canvas, tile_y0, tile_y1);
        // Reused only for the report's overlap-width bookkeeping; the
        // returned hard "owner" is discarded — weighting for this path
        // comes from `seam`, not geometric depth.
        let _owner = assign_owners(
            &depths,
            tile_y0,
            cw,
            tile_n,
            k,
            &mut overlap_count,
            &mut overlap_rows,
        );

        for fi in 0..k {
            if !depths[fi].iter().any(|&d| d >= 0.0) {
                continue; // no geometric footprint in this tile — skip decode
            }
            let strip = warp_strip(fi, tile_y0, tile_y1)?;
            accumulate_strip_weighted(
                &strip,
                seam,
                fi,
                tile_y0,
                cw,
                tile_n,
                &mut out_r,
                &mut out_g,
                &mut out_b,
                &mut out_weight,
                out_base,
            );
        }

        tile_y0 = tile_y1;
    }

    Ok((
        out_r,
        out_g,
        out_b,
        out_weight,
        (overlap_count, overlap_rows),
    ))
}

/// Accumulate one warped strip into the output planes, weighted by
/// `seam.weight(fi, ...)` at each covered pixel (a continuous [0, 1]
/// contribution, not a hard owner/not-owner decision).
#[allow(clippy::too_many_arguments)]
fn accumulate_strip_weighted(
    strip: &PlanarImage,
    seam: &SeamMasks,
    fi: usize,
    tile_y0: u32,
    cw: usize,
    tile_n: usize,
    out_r: &mut [f32],
    out_g: &mut [f32],
    out_b: &mut [f32],
    out_weight: &mut [f32],
    out_base: usize,
) {
    for i in 0..tile_n {
        let (sx, sy) = (i % cw, i / cw);
        if !strip.validity.get(sx as u32, sy as u32) {
            continue;
        }
        let canvas_y = tile_y0 as usize + sy;
        let w = seam.weight(fi, sx as f64 + 0.5, canvas_y as f64 + 0.5);
        if w <= 0.0 {
            continue;
        }
        out_r[out_base + i] += w * strip.r[i];
        out_g[out_base + i] += w * strip.g[i];
        out_b[out_base + i] += w * strip.b[i];
        out_weight[out_base + i] += w;
    }
}

/// Normalize the weighted accumulation (divide by the summed weight at
/// each covered pixel) and package the result + report.
fn finish(
    mut r: Vec<f32>,
    mut g: Vec<f32>,
    mut b: Vec<f32>,
    out_weight: Vec<f32>,
    canvas: &CanvasSpec,
    gains: &[[f32; 3]],
    k: usize,
    overlap: OverlapStats,
) -> (PlanarImage, CompositeReport) {
    let (overlap_count, overlap_rows) = overlap;
    let cw = canvas.width as usize;
    let mut mask = ValidityMask::new_filled(canvas.width, canvas.height, false);
    for (i, &w) in out_weight.iter().enumerate() {
        if w > MIN_COVERAGE_WEIGHT {
            let inv = 1.0 / w;
            r[i] *= inv;
            g[i] *= inv;
            b[i] *= inv;
            mask.set((i % cw) as u32, (i / cw) as u32, true);
        }
    }
    let blended = PlanarImage::from_planes(canvas.width, canvas.height, r, g, b, mask);
    let report = CompositeReport {
        canvas: canvas.clone(),
        projection: canvas.projection,
        gains: gains.to_vec(),
        blend_levels: 1,
        min_overlap_width_px: min_overlap_width(k, &overlap_count, &overlap_rows),
        seam_strategy: seam::SeamStrategy::GraphCut,
    };
    (blended, report)
}
