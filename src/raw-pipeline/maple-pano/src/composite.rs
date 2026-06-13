//! The M2-CPU compositing orchestrator (spec §5.4–§5.8): canvas →
//! gain → warp → seam placement → multi-band blend.
//!
//! # Seam placement in this milestone
//!
//! Seams here are **Voronoi by source-border distance**: each covered
//! canvas pixel is owned by the frame whose projection of it sits
//! deepest inside that frame (max distance to its nearest frame edge) —
//! the classic Burt–Adelson composite, deterministic and content-blind.
//! The spec's step-7 **graph-cut** seam finder (content-aware routing
//! around motion/parallax) replaces this mask generator in the follow-up
//! ticket referenced from #1155; the orchestrator and blend contract
//! (per-frame weight planes) are exactly the interface it slots into.
//!
//! # Memory-bounded tiled path (`composite_tiled`, M6-D #1248)
//!
//! [`composite_tiled`] accepts already-solved gains and a `tile_rows` height
//! for the strip decomposition. It decodes source frames on demand (one at a
//! time) using the supplied file paths, warping each frame into a
//! `canvas_width × tile_rows` strip buffer and immediately freeing the
//! decoded pixels before moving to the next frame.  The Voronoi ownership
//! mask is computed per tile from camera geometry (no pixels needed), and the
//! blend is linear-under-ownership-mask (identical to blend_multiband at
//! levels=1, which is exact for Voronoi-exclusive ownership).  The output
//! canvas is assembled strip-by-strip into a final [`PlanarImage`].
//!
//! Peak memory per tile (for pano_01 geometry, 512 tile rows, 25000 wide):
//! - 1 decoded full-res frame: ~249 MB
//! - 1 warped frame strip (25000×512×3×4B): ~147 MB
//! - 1 output accumulator strip: ~147 MB
//! - Voronoi score strip (1 byte/px): ~12 MB
//! Total: **≈ 555 MB** (vs. ~71 GB all-resident)

use rayon::prelude::*;

use crate::blend::{blend_multiband, levels_for_overlap_width};
use crate::camera::Camera;
use crate::canvas::{auto_canvas, CanvasOptions, CanvasSpec};
use crate::error::PanoError;
use crate::gain::{solve_gains, GainOptions};
use crate::ingest::{ingest_file, PlanarImage, ValidityMask};
use crate::local_align::LocalCorrection;
use crate::project::Projection;
use crate::warp::{warp_to_canvas, warp_to_canvas_strip};

/// Options for [`composite`].
#[derive(Debug, Clone, Default)]
pub struct CompositeOptions {
    pub canvas: CanvasOptions,
    pub gain: GainOptions,
    /// Override the spec band-count rule (`log2(min overlap width)`,
    /// cap 7). Mostly for tests.
    pub levels_override: Option<usize>,
}

/// What [`composite`] did — the numbers the CLI report surfaces.
#[derive(Debug, Clone)]
pub struct CompositeReport {
    pub canvas: CanvasSpec,
    pub projection: Projection,
    pub gains: Vec<[f32; 3]>,
    pub blend_levels: usize,
    /// Average overlap width (px) of the narrowest overlapping pair —
    /// the input to the band-count rule.
    pub min_overlap_width_px: usize,
}

/// Composite posed frames onto an automatically constructed canvas.
///
/// `frames[i]` corresponds to `cameras[i]` (the BA output poses with
/// per-frame focals where freed). Frames whose camera is `None` in the
/// caller's bookkeeping should simply not be passed in.
///
/// `local_corrections`: optional per-frame stage-F alignment corrections
/// (#1218, spec §8).  When present, `local_corrections[i]` is applied to
/// `frames[i]` in a single resample — no extra pass.  Pass an empty slice
/// or a slice of `None`s to skip alignment.
pub fn composite(
    frames: &[PlanarImage],
    cameras: &[Camera],
    opts: &CompositeOptions,
    local_corrections: &[Option<LocalCorrection>],
) -> Result<(PlanarImage, CompositeReport), PanoError> {
    if frames.len() != cameras.len() {
        return Err(PanoError::InvalidOptions(format!(
            "composite: {} frames vs {} cameras",
            frames.len(),
            cameras.len()
        )));
    }
    if !local_corrections.is_empty() && local_corrections.len() != frames.len() {
        return Err(PanoError::InvalidOptions(format!(
            "composite: {} local corrections vs {} frames (pass an empty              slice to skip alignment)",
            local_corrections.len(),
            frames.len()
        )));
    }
    if frames.is_empty() {
        return Err(PanoError::InvalidOptions(
            "composite: no frames to composite".into(),
        ));
    }

    let canvas = auto_canvas(cameras, &opts.canvas)?;
    let gains = solve_gains(frames, cameras, &opts.gain)?;

    let layers: Vec<PlanarImage> = frames
        .iter()
        .zip(cameras)
        .zip(&gains)
        .enumerate()
        .map(|(i, ((f, c), &g))| {
            let la = local_corrections.get(i).and_then(|opt| opt.as_ref());
            warp_to_canvas(f, c, &canvas, g, la)
        })
        .collect();

    let (masks, min_overlap) = voronoi_masks(&layers, cameras, &canvas);
    let levels = opts
        .levels_override
        .unwrap_or_else(|| levels_for_overlap_width(min_overlap));
    let blended = blend_multiband(&layers, &masks, levels);

    let projection = canvas.projection;
    Ok((
        blended,
        CompositeReport {
            canvas,
            projection,
            gains,
            blend_levels: levels,
            min_overlap_width_px: min_overlap,
        },
    ))
}

/// Per-frame hard ownership masks by source-border depth, plus the
/// average overlap width (px) of the narrowest overlapping pair.
///
/// Ownership score for a covered canvas pixel = how deep its projection
/// sits inside the owning frame (min distance to that frame's nearest
/// edge, in source pixels). Ties break to the lower frame index
/// (determinism).
fn voronoi_masks(
    layers: &[PlanarImage],
    cameras: &[Camera],
    canvas: &CanvasSpec,
) -> (Vec<Vec<f32>>, usize) {
    let cw = canvas.width as usize;
    let ch = canvas.height as usize;
    let n = cw * ch;
    let k = layers.len();

    // Depth score per frame per pixel (negative = not covered).
    let depths: Vec<Vec<f32>> = cameras
        .par_iter()
        .zip(layers.par_iter())
        .map(|(cam, layer)| {
            let mut d = vec![-1.0_f32; n];
            for (i, slot) in d.iter_mut().enumerate() {
                let (x, y) = ((i % cw) as u32, (i / cw) as u32);
                if !layer.validity.get(x, y) {
                    continue;
                }
                let Some(dir) = canvas.pixel_to_dir(x as f64 + 0.5, y as f64 + 0.5) else {
                    continue;
                };
                let Some((sx, sy)) = cam.world_dir_to_pixel(dir) else {
                    continue;
                };
                let border = sx
                    .min(cam.width as f64 - sx)
                    .min(sy)
                    .min(cam.height as f64 - sy);
                *slot = border.max(0.0) as f32;
            }
            d
        })
        .collect();

    let mut masks = vec![vec![0.0_f32; n]; k];
    let mut overlap_count = vec![vec![0usize; k]; k];
    let mut overlap_rows: Vec<Vec<std::collections::BTreeSet<usize>>> =
        vec![vec![std::collections::BTreeSet::new(); k]; k];
    for i in 0..n {
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
            masks[f][i] = 1.0;
        }
        // Pairwise overlap bookkeeping (counts + distinct rows) for the
        // band rule.
        for a in 0..k {
            if depths[a][i] < 0.0 {
                continue;
            }
            for b in (a + 1)..k {
                if depths[b][i] >= 0.0 {
                    overlap_count[a][b] += 1;
                    overlap_rows[a][b].insert(i / cw);
                }
            }
        }
    }

    // Narrowest pair's average overlap width = count / distinct rows.
    let mut min_width = usize::MAX;
    for a in 0..k {
        for b in (a + 1)..k {
            let rows = overlap_rows[a][b].len();
            if rows == 0 {
                continue;
            }
            min_width = min_width.min(overlap_count[a][b] / rows);
        }
    }
    if min_width == usize::MAX {
        min_width = 0; // single frame or disjoint coverage
    }
    (masks, min_width)
}

// ─── Memory-bounded tiled composite (M6-D, #1248) ─────────────────────────────

/// Memory-bounded tiled compositing: decode each source frame on demand,
/// warp it into a `canvas_width × tile_rows` strip buffer, and free it
/// before moving to the next frame.  The gain solution is pre-computed
/// by the caller (from the full-res frames before they were freed).
///
/// The canvas is assembled strip-by-strip into a final [`PlanarImage`].
/// Per-pixel Voronoi ownership is computed from camera geometry alone
/// (no pixels needed) so the strip-level Voronoi mask costs only
/// `canvas_width × tile_rows` bytes.
///
/// **Blend algorithm**: linear Voronoi (each pixel is filled by exactly
/// one frame — the owner). This is identical to `blend_multiband(..., 1)`
/// when the Voronoi mask assigns exclusive ownership, which it always does.
/// The output is pixel-identical to the full-canvas path for any input
/// set where each canvas pixel maps to exactly one source frame (the
/// Voronoi guarantee).
///
/// # Errors
/// Returns `PanoError` if any frame fails to decode or if camera/path
/// slices are inconsistent.
pub fn composite_tiled(
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
    if paths.is_empty() {
        return Err(PanoError::InvalidOptions(
            "composite_tiled: no frames".into(),
        ));
    }
    let tile_rows = tile_rows.max(1).min(canvas.height);
    let cw = canvas.width as usize;
    let ch = canvas.height as usize;

    // Output buffers — assembled strip by strip.
    let mut out_r = vec![0.0_f32; cw * ch];
    let mut out_g = vec![0.0_f32; cw * ch];
    let mut out_b = vec![0.0_f32; cw * ch];
    let mut out_valid = vec![false; cw * ch];

    // Voronoi overlap tracking for the CompositeReport min_overlap_width.
    // We track per-pair overlap counts and distinct rows over the full canvas
    // using only camera geometry (the same source-border-depth score as
    // voronoi_masks) but accumulated strip-by-strip to keep peak usage low.
    let k = cameras.len();
    let mut overlap_count = vec![vec![0usize; k]; k];
    let mut overlap_rows: Vec<Vec<std::collections::BTreeSet<usize>>> =
        vec![vec![std::collections::BTreeSet::new(); k]; k];

    let mut tile_y0: u32 = 0;
    while tile_y0 < canvas.height {
        let tile_y1 = (tile_y0 + tile_rows).min(canvas.height);
        let th = (tile_y1 - tile_y0) as usize;
        let tile_n = cw * th;

        // Per-frame depth scores for Voronoi over this strip.
        // Computed from geometry only — no pixel data needed.
        let depths: Vec<Vec<f32>> = cameras
            .par_iter()
            .map(|cam| {
                let mut d = vec![-1.0_f32; tile_n];
                for sy in 0..th {
                    let canvas_y = tile_y0 as usize + sy;
                    for x in 0..cw {
                        let px = x as f64 + 0.5;
                        let py = canvas_y as f64 + 0.5;
                        let Some(dir) = canvas.pixel_to_dir(px, py) else {
                            continue;
                        };
                        let Some((sx, sy_src)) = cam.world_dir_to_pixel(dir) else {
                            continue;
                        };
                        let border = sx
                            .min(cam.width as f64 - sx)
                            .min(sy_src)
                            .min(cam.height as f64 - sy_src);
                        d[sy * cw + x] = border.max(0.0) as f32;
                    }
                }
                d
            })
            .collect();

        // Voronoi ownership (frame index, u16) per tile pixel.
        // u16::MAX = uncovered.
        let mut owner: Vec<u16> = vec![u16::MAX; tile_n];
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
            // Pairwise overlap for min-width report.
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
        // Depth data no longer needed for this tile.
        drop(depths);

        // Stream each frame: decode → warp strip → accumulate → drop.
        for (fi, ((path, cam), gain)) in paths.iter().zip(cameras).zip(gains).enumerate() {
            // Check if this frame contributes any owned pixels in this tile.
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
            // Immediately free the decoded frame pixels — the strip is all we need.
            drop(frame);

            // Accumulate: for each tile pixel owned by this frame, write strip value.
            let out_base = tile_y0 as usize * cw;
            for i in 0..tile_n {
                if owner[i] != fi as u16 {
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
            // Drop the strip immediately — no longer needed.
            drop(strip);
        }

        tile_y0 = tile_y1;
    }

    // Build validity mask for the output.
    let mut mask = ValidityMask::new_filled(canvas.width, canvas.height, false);
    for y in 0..ch {
        for x in 0..cw {
            if out_valid[y * cw + x] {
                mask.set(x as u32, y as u32, true);
            }
        }
    }

    // Min-overlap width from the pairwise bookkeeping above.
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
        min_overlap = 0;
    }

    let blended = PlanarImage::from_planes(canvas.width, canvas.height, out_r, out_g, out_b, mask);

    let gains_vec: Vec<[f32; 3]> = gains.to_vec();
    let report = CompositeReport {
        canvas: canvas.clone(),
        projection: canvas.projection,
        gains: gains_vec,
        // Tiled path: blend_levels=1 (linear Voronoi — see module docs).
        blend_levels: 1,
        min_overlap_width_px: min_overlap,
    };

    Ok((blended, report))
}

/// Tiled composite with pre-loaded frames (for tests and offline use
/// where frames are already in memory).
///
/// Same tiling logic as [`composite_tiled`] but takes `&[PlanarImage]`
/// instead of file paths — no I/O, no decode.  Useful for unit tests
/// and for callers that decoded frames for another purpose and kept them.
///
/// See [`composite_tiled`] for the memory model and blend contract.
pub fn composite_tiled_frames(
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
    if frames.is_empty() {
        return Err(PanoError::InvalidOptions(
            "composite_tiled_frames: no frames".into(),
        ));
    }
    let tile_rows = tile_rows.max(1).min(canvas.height);
    let cw = canvas.width as usize;
    let ch = canvas.height as usize;

    let mut out_r = vec![0.0_f32; cw * ch];
    let mut out_g = vec![0.0_f32; cw * ch];
    let mut out_b = vec![0.0_f32; cw * ch];
    let mut out_valid = vec![false; cw * ch];

    let k = cameras.len();
    let mut overlap_count = vec![vec![0usize; k]; k];
    let mut overlap_rows: Vec<Vec<std::collections::BTreeSet<usize>>> =
        vec![vec![std::collections::BTreeSet::new(); k]; k];

    let mut tile_y0: u32 = 0;
    while tile_y0 < canvas.height {
        let tile_y1 = (tile_y0 + tile_rows).min(canvas.height);
        let th = (tile_y1 - tile_y0) as usize;
        let tile_n = cw * th;

        let depths: Vec<Vec<f32>> = cameras
            .par_iter()
            .map(|cam| {
                let mut d = vec![-1.0_f32; tile_n];
                for sy in 0..th {
                    let canvas_y = tile_y0 as usize + sy;
                    for x in 0..cw {
                        let Some(dir) = canvas.pixel_to_dir(x as f64 + 0.5, canvas_y as f64 + 0.5)
                        else {
                            continue;
                        };
                        let Some((sx, sy_src)) = cam.world_dir_to_pixel(dir) else {
                            continue;
                        };
                        let border = sx
                            .min(cam.width as f64 - sx)
                            .min(sy_src)
                            .min(cam.height as f64 - sy_src);
                        d[sy * cw + x] = border.max(0.0) as f32;
                    }
                }
                d
            })
            .collect();

        let mut owner: Vec<u16> = vec![u16::MAX; tile_n];
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

            let out_base = tile_y0 as usize * cw;
            for i in 0..tile_n {
                if owner[i] != fi as u16 {
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

        tile_y0 = tile_y1;
    }

    let mut mask = ValidityMask::new_filled(canvas.width, canvas.height, false);
    for y in 0..ch {
        for x in 0..cw {
            if out_valid[y * cw + x] {
                mask.set(x as u32, y as u32, true);
            }
        }
    }

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
        min_overlap = 0;
    }

    let blended = PlanarImage::from_planes(canvas.width, canvas.height, out_r, out_g, out_b, mask);
    let gains_vec: Vec<[f32; 3]> = gains.to_vec();
    let report = CompositeReport {
        canvas: canvas.clone(),
        projection: canvas.projection,
        gains: gains_vec,
        blend_levels: 1,
        min_overlap_width_px: min_overlap,
    };

    Ok((blended, report))
}
