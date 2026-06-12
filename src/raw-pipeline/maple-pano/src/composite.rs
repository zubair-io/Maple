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

use rayon::prelude::*;

use crate::blend::{blend_multiband, levels_for_overlap_width};
use crate::camera::Camera;
use crate::canvas::{auto_canvas, CanvasOptions, CanvasSpec};
use crate::error::PanoError;
use crate::gain::{solve_gains, GainOptions};
use crate::ingest::PlanarImage;
use crate::local_align::LocalCorrection;
use crate::project::Projection;
use crate::warp::warp_to_canvas;

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
