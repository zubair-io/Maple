//! Memory-bounded tiled composite functions (M6-D, #1248).
//!
//! [`composite_tiled`] and [`composite_tiled_frames`] implement strip-by-strip
//! compositing that decodes (or re-uses) source frames one at a time,
//! keeping at most one full-resolution frame resident per tile pass. See the
//! parent module doc for the measured memory reality and the #1254 deferral.
//!
//! Both dispatch on [`SeamStrategy`] (#1179): the default Voronoi path
//! below is unchanged from M6-D — hard per-pixel ownership computed from
//! camera geometry alone. `GraphCut` delegates to [`graph_cut`], which
//! precomputes a cheap downsampled seam ([`crate::seam::masks::build_from_paths`])
//! once before the tile loop and then does a weighted accumulation per
//! strip instead of a hard-ownership copy — see that module's doc for why
//! the split (keeping this file's Voronoi path byte-for-byte unchanged
//! keeps every existing `pano-budgets.json` ratchet meaningful).

mod graph_cut;

use rayon::prelude::*;

use crate::camera::Camera;
use crate::canvas::CanvasSpec;
use crate::error::PanoError;
use crate::ingest::{ingest_file, PlanarImage, ValidityMask};
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
    overlap_count: &mut Vec<Vec<usize>>,
    overlap_rows: &mut Vec<Vec<std::collections::BTreeSet<usize>>>,
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
    overlap_count: &Vec<Vec<usize>>,
    overlap_rows: &Vec<Vec<std::collections::BTreeSet<usize>>>,
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

/// Accumulate a warp strip into the output planes for pixels owned by `fi`.
fn accumulate_strip(
    strip: &PlanarImage,
    fi: u16,
    owner: &[u16],
    out_r: &mut [f32],
    out_g: &mut [f32],
    out_b: &mut [f32],
    out_valid: &mut [bool],
    out_base: usize,
    cw: usize,
    tile_n: usize,
) {
    for i in 0..tile_n {
        if owner[i] != fi {
            continue;
        }
        let (sx, sy) = (i % cw, i / cw);
        if !strip.validity.get(sx as u32, sy as u32) {
            continue;
        }
        out_r[out_base + i] = strip.r[i];
        out_g[out_base + i] = strip.g[i];
        out_b[out_base + i] = strip.b[i];
        out_valid[out_base + i] = true;
    }
}

/// Build the output validity mask from the flat `out_valid` buffer.
fn build_validity_mask(out_valid: &[bool], canvas_width: u32, canvas_height: u32) -> ValidityMask {
    let cw = canvas_width as usize;
    let ch = canvas_height as usize;
    let mut mask = ValidityMask::new_filled(canvas_width, canvas_height, false);
    for y in 0..ch {
        for x in 0..cw {
            if out_valid[y * cw + x] {
                mask.set(x as u32, y as u32, true);
            }
        }
    }
    mask
}

/// Memory-bounded tiled compositing: decode each source frame on demand,
/// warp it into a `canvas_width × tile_rows` strip buffer, and free it
/// before moving to the next frame.  The gain solution is pre-computed
/// by the caller (from the full-res frames before they were freed).
///
/// The canvas is assembled strip-by-strip into a final [`PlanarImage`].
/// Dispatches on `seam_strategy` (#1179): [`SeamStrategy::Voronoi`]
/// (default) computes per-pixel ownership from camera geometry alone (no
/// pixels needed) via [`composite_tiled_voronoi`]; [`SeamStrategy::GraphCut`]
/// delegates to [`graph_cut::composite_tiled_graph_cut`].
///
/// # Errors
/// Returns `PanoError` if any frame fails to decode or if camera/path
/// slices are inconsistent.
#[allow(clippy::too_many_arguments)]
pub fn composite_tiled(
    paths: &[std::path::PathBuf],
    cameras: &[Camera],
    gains: &[[f32; 3]],
    local_corrections: &[Option<LocalCorrection>],
    canvas: &CanvasSpec,
    tile_rows: u32,
    seam_strategy: SeamStrategy,
) -> Result<(PlanarImage, CompositeReport), PanoError> {
    match seam_strategy {
        SeamStrategy::Voronoi => {
            composite_tiled_voronoi(paths, cameras, gains, local_corrections, canvas, tile_rows)
        }
        SeamStrategy::GraphCut => graph_cut::composite_tiled_graph_cut(
            paths,
            cameras,
            gains,
            local_corrections,
            canvas,
            tile_rows,
        ),
    }
}

/// **Blend algorithm**: linear Voronoi (each pixel is filled by exactly
/// one frame — the owner). This is identical to `blend_multiband(..., 1)`
/// when the Voronoi mask assigns exclusive ownership, which it always does.
fn composite_tiled_voronoi(
    paths: &[std::path::PathBuf],
    cameras: &[Camera],
    gains: &[[f32; 3]],
    local_corrections: &[Option<LocalCorrection>],
    canvas: &CanvasSpec,
    tile_rows: u32,
) -> Result<(PlanarImage, CompositeReport), PanoError> {
    if paths.len() != cameras.len() || paths.len() != gains.len() {
        return Err(PanoError::InvalidOptions(format!(
            "composite_tiled: {} paths, {} cameras, {} gains",
            paths.len(),
            cameras.len(),
            gains.len(),
        )));
    }
    if !local_corrections.is_empty() && local_corrections.len() != paths.len() {
        return Err(PanoError::InvalidOptions(format!(
            "composite_tiled: {} local corrections vs {} paths (pass an empty slice to skip alignment)",
            local_corrections.len(),
            paths.len()
        )));
    }
    if paths.is_empty() {
        return Err(PanoError::InvalidOptions(
            "composite_tiled: no frames".into(),
        ));
    }
    let tile_rows = tile_rows.max(1).min(canvas.height);
    let cw = canvas.width as usize;
    let ch = canvas.height as usize;
    let k = cameras.len();

    let mut out_r = vec![0.0_f32; cw * ch];
    let mut out_g = vec![0.0_f32; cw * ch];
    let mut out_b = vec![0.0_f32; cw * ch];
    let mut out_valid = vec![false; cw * ch];

    let mut overlap_count = vec![vec![0usize; k]; k];
    let mut overlap_rows: Vec<Vec<std::collections::BTreeSet<usize>>> =
        vec![vec![std::collections::BTreeSet::new(); k]; k];

    let mut tile_y0: u32 = 0;
    while tile_y0 < canvas.height {
        let tile_y1 = (tile_y0 + tile_rows).min(canvas.height);
        let tile_n = cw * (tile_y1 - tile_y0) as usize;

        let depths = tile_depths(cameras, local_corrections, canvas, tile_y0, tile_y1);
        let owner = assign_owners(
            &depths,
            tile_y0,
            cw,
            tile_n,
            k,
            &mut overlap_count,
            &mut overlap_rows,
        );
        drop(depths);

        // Stream each frame: decode → warp strip → accumulate → drop.
        for (fi, ((path, cam), gain)) in paths.iter().zip(cameras).zip(gains).enumerate() {
            if !owner.iter().any(|&o| o == fi as u16) {
                continue; // skip decode — frame doesn't own any tile pixel
            }
            let frame = ingest_file(path)?;
            let la = if local_corrections.is_empty() {
                None
            } else {
                local_corrections.get(fi).and_then(|o| o.as_ref())
            };
            let strip =
                warp_to_canvas_strip(&frame.image, cam, canvas, *gain, la, tile_y0, tile_y1);
            drop(frame);
            accumulate_strip(
                &strip,
                fi as u16,
                &owner,
                &mut out_r,
                &mut out_g,
                &mut out_b,
                &mut out_valid,
                tile_y0 as usize * cw,
                cw,
                tile_n,
            );
        }

        tile_y0 = tile_y1;
    }

    let mask = build_validity_mask(&out_valid, canvas.width, canvas.height);
    let blended = PlanarImage::from_planes(canvas.width, canvas.height, out_r, out_g, out_b, mask);
    let report = CompositeReport {
        canvas: canvas.clone(),
        projection: canvas.projection,
        gains: gains.to_vec(),
        blend_levels: 1,
        min_overlap_width_px: min_overlap_width(k, &overlap_count, &overlap_rows),
        seam_strategy: SeamStrategy::Voronoi,
    };
    Ok((blended, report))
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
    gains: &[[f32; 3]],
    local_corrections: &[Option<LocalCorrection>],
    canvas: &CanvasSpec,
    tile_rows: u32,
    seam_strategy: SeamStrategy,
) -> Result<(PlanarImage, CompositeReport), PanoError> {
    match seam_strategy {
        SeamStrategy::Voronoi => composite_tiled_frames_voronoi(
            frames,
            cameras,
            gains,
            local_corrections,
            canvas,
            tile_rows,
        ),
        SeamStrategy::GraphCut => graph_cut::composite_tiled_frames_graph_cut(
            frames,
            cameras,
            gains,
            local_corrections,
            canvas,
            tile_rows,
        ),
    }
}

fn composite_tiled_frames_voronoi(
    frames: &[PlanarImage],
    cameras: &[Camera],
    gains: &[[f32; 3]],
    local_corrections: &[Option<LocalCorrection>],
    canvas: &CanvasSpec,
    tile_rows: u32,
) -> Result<(PlanarImage, CompositeReport), PanoError> {
    if frames.len() != cameras.len() || frames.len() != gains.len() {
        return Err(PanoError::InvalidOptions(format!(
            "composite_tiled_frames: {} frames, {} cameras, {} gains",
            frames.len(),
            cameras.len(),
            gains.len(),
        )));
    }
    if !local_corrections.is_empty() && local_corrections.len() != frames.len() {
        return Err(PanoError::InvalidOptions(format!(
            "composite_tiled_frames: {} local corrections vs {} frames (pass an empty slice to skip alignment)",
            local_corrections.len(),
            frames.len()
        )));
    }
    if frames.is_empty() {
        return Err(PanoError::InvalidOptions(
            "composite_tiled_frames: no frames".into(),
        ));
    }
    let tile_rows = tile_rows.max(1).min(canvas.height);
    let cw = canvas.width as usize;
    let ch = canvas.height as usize;
    let k = cameras.len();

    let mut out_r = vec![0.0_f32; cw * ch];
    let mut out_g = vec![0.0_f32; cw * ch];
    let mut out_b = vec![0.0_f32; cw * ch];
    let mut out_valid = vec![false; cw * ch];

    let mut overlap_count = vec![vec![0usize; k]; k];
    let mut overlap_rows: Vec<Vec<std::collections::BTreeSet<usize>>> =
        vec![vec![std::collections::BTreeSet::new(); k]; k];

    let mut tile_y0: u32 = 0;
    while tile_y0 < canvas.height {
        let tile_y1 = (tile_y0 + tile_rows).min(canvas.height);
        let tile_n = cw * (tile_y1 - tile_y0) as usize;

        let depths = tile_depths(cameras, local_corrections, canvas, tile_y0, tile_y1);
        let owner = assign_owners(
            &depths,
            tile_y0,
            cw,
            tile_n,
            k,
            &mut overlap_count,
            &mut overlap_rows,
        );
        drop(depths);

        for (fi, (frame, (cam, gain))) in frames.iter().zip(cameras.iter().zip(gains)).enumerate() {
            if !owner.iter().any(|&o| o == fi as u16) {
                continue;
            }
            let la = if local_corrections.is_empty() {
                None
            } else {
                local_corrections.get(fi).and_then(|o| o.as_ref())
            };
            let strip = warp_to_canvas_strip(frame, cam, canvas, *gain, la, tile_y0, tile_y1);
            accumulate_strip(
                &strip,
                fi as u16,
                &owner,
                &mut out_r,
                &mut out_g,
                &mut out_b,
                &mut out_valid,
                tile_y0 as usize * cw,
                cw,
                tile_n,
            );
        }

        tile_y0 = tile_y1;
    }

    let mask = build_validity_mask(&out_valid, canvas.width, canvas.height);
    let blended = PlanarImage::from_planes(canvas.width, canvas.height, out_r, out_g, out_b, mask);
    let report = CompositeReport {
        canvas: canvas.clone(),
        projection: canvas.projection,
        gains: gains.to_vec(),
        blend_levels: 1,
        min_overlap_width_px: min_overlap_width(k, &overlap_count, &overlap_rows),
        seam_strategy: SeamStrategy::Voronoi,
    };
    Ok((blended, report))
}
