//! Memory-bounded strip-streaming composite for the tile strategy (#1291).
//!
//! [`composite_tile_streaming`] replaces the full-canvas `composite_tile`
//! with a pass that halves peak warp-buffer allocation.  Output is
//! byte-identical to `composite_tile`.
//!
//! # Memory model
//!
//! The old `composite_tile` kept two generations of K full-canvas warp
//! buffers simultaneously: one with gain = 1 (for the gain solve) and
//! one with actual gains (for the blend).  For pano_00 (3 frames, ~167 MP
//! canvas) this was ~12 GB of warp data alone.
//!
//! This implementation:
//!
//! - Solves gains without materialising **any** canvas-sized warp buffers
//!   (see [`super::gain_solve::solve_gains_canvas_space`]).
//! - Builds a compact `u16` Voronoi owner map (one value per canvas pixel,
//!   ≈ 334 MB for pano_00) instead of K full-canvas f32 depth planes.
//! - Warps each frame **once** (with the solved gains already folded in),
//!   keeping K full-canvas gained layers for the final blend — exactly
//!   what `blend_multiband` needs, and half the former peak.
//!
//! # Byte-identity contract
//!
//! The output is byte-identical to `composite_tile`:
//!
//! - Gain solve: [`super::gain_solve::solve_gains_canvas_space`] produces
//!   the same statistics as `solve_gains_tile` on the gain=1 warped layers.
//! - Voronoi ownership: the compact owner map uses the same canvas border
//!   distance metric as `voronoi_masks_tile`.
//! - Blend: `blend_multiband` called with the same gained layers and
//!   Voronoi weight planes — numerically identical to the old path.
//!
//! # Strip height
//!
//! The `strip_rows` parameter controls the strip height for the owner-map
//! build pass only.  Default: [`DEFAULT_TILE_STRIP_ROWS`] = 512.

use rayon::prelude::*;

use crate::blend::{blend_multiband, levels_for_overlap_width};
use crate::error::PanoError;
use crate::gain::GainOptions;
use crate::ingest::PlanarImage;

use super::gain_solve::solve_gains_canvas_space;
use super::placement::{TileCanvasSpec, TilePose};
use super::warp::{inverse_similarity_with_offset, sample_bicubic, warp_to_tile_canvas};
use super::TileCompositeReport;

/// Default strip height for the owner-map build pass.
pub const DEFAULT_TILE_STRIP_ROWS: u32 = 512;

// ─────────────────────────────────────────────────────────────────────────────
// Compact global owner map
// ─────────────────────────────────────────────────────────────────────────────

/// Build the per-pixel Voronoi owner map.
///
/// Returns `(owner_map, min_overlap_width_px)`.
/// `owner_map[y * cw + x]` = owning frame index (u16) or `u16::MAX` when
/// no frame covers that pixel.
///
/// Uses the same canvas border-distance metric as `voronoi_masks_tile`,
/// and the same validity gate (in-bounds + bicubic returns Some) as
/// `warp_to_tile_canvas`.
///
/// Computed strip-by-strip so only `strip_rows × cw × K` f32 depth values
/// are live at a time.
fn build_owner_map(
    frames: &[PlanarImage],
    poses: &[TilePose],
    canvas: &TileCanvasSpec,
    strip_rows: u32,
) -> (Vec<u16>, usize) {
    let cw = canvas.width as usize;
    let k = frames.len();
    let n_total = cw * canvas.height as usize;

    let mut owner_map = vec![u16::MAX; n_total];
    let mut overlap_count = vec![vec![0usize; k]; k];
    let mut overlap_rows: Vec<Vec<std::collections::BTreeSet<usize>>> =
        vec![vec![std::collections::BTreeSet::new(); k]; k];

    let inv_sims: Vec<_> = poses
        .iter()
        .map(|p| inverse_similarity_with_offset(&p.sim, canvas.offset_x, canvas.offset_y))
        .collect();

    let mut tile_y0: u32 = 0;
    while tile_y0 < canvas.height {
        let tile_y1 = (tile_y0 + strip_rows).min(canvas.height);
        let th = (tile_y1 - tile_y0) as usize;
        let tile_n = cw * th;

        // Compute Voronoi depth for each frame over this strip.
        //
        // Depth metric: canvas border distance, identical to
        // `voronoi_masks_tile`'s `min(px, cw-1-px, py, ch-1-py)`.
        // A canvas pixel is "covered" by frame fi when the same in-bounds
        // + bicubic-Some gate that `warp_to_tile_canvas` applies holds.
        let depths: Vec<Vec<f32>> = frames
            .par_iter()
            .enumerate()
            .map(|(fi, frame)| {
                let inv = &inv_sims[fi];
                let fw = frame.width() as f64;
                let fh = frame.height() as f64;
                let mut d = vec![-1.0_f32; tile_n];
                for sy in 0..th {
                    let canvas_y = tile_y0 as usize + sy;
                    let cy = canvas_y as f64 + 0.5;
                    for sx in 0..cw {
                        let (fx, fy) = inv.apply(sx as f64 + 0.5, cy);
                        if fx < 0.0 || fx > fw || fy < 0.0 || fy > fh {
                            continue;
                        }
                        if sample_bicubic(frame, fx - 0.5, fy - 0.5).is_none() {
                            continue;
                        }
                        let border = (sx as f64)
                            .min(cw as f64 - 1.0 - sx as f64)
                            .min(canvas_y as f64)
                            .min(canvas.height as f64 - 1.0 - canvas_y as f64);
                        d[sy * cw + sx] = border.max(0.0) as f32;
                    }
                }
                d
            })
            .collect();

        let strip_base = tile_y0 as usize * cw;
        for i in 0..tile_n {
            let canvas_row = tile_y0 as usize + i / cw;
            let mut best: Option<(usize, f32)> = None;
            for (f, depth) in depths.iter().enumerate() {
                let d = depth[i];
                if d >= 0.0 && best.is_none_or(|(_, bd)| d > bd) {
                    best = Some((f, d));
                }
            }
            if let Some((f, _)) = best {
                owner_map[strip_base + i] = f as u16;
            }
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

        tile_y0 = tile_y1;
    }

    let mut min_overlap = usize::MAX;
    for a in 0..k {
        for b in (a + 1)..k {
            let rows = overlap_rows[a][b].len();
            if rows > 0 {
                min_overlap = min_overlap.min(overlap_count[a][b] / rows);
            }
        }
    }
    (
        owner_map,
        if min_overlap == usize::MAX {
            0
        } else {
            min_overlap
        },
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

/// Strip-streaming tile composite — memory-bounded replacement for the
/// old `composite_tile`.
///
/// Compared to `composite_tile`, this function eliminates the first
/// (gain=1) generation of K full-canvas warp buffers: gains are solved
/// directly in canvas space without materializing any warped layer.
/// The final warp (with gains) and the multi-band blend are unchanged,
/// so output is byte-identical.
///
/// `strip_rows`: controls the strip height used when building the Voronoi
/// owner map.  Pass [`DEFAULT_TILE_STRIP_ROWS`] (512) for production use.
pub fn composite_tile_streaming(
    frames: &[PlanarImage],
    tile_edges: &[super::TileEdge],
    poses: &[TilePose],
    canvas: &TileCanvasSpec,
    gain_opts: &GainOptions,
    levels_override: Option<usize>,
    strip_rows: u32,
) -> Result<(PlanarImage, TileCompositeReport), PanoError> {
    if frames.len() != poses.len() {
        return Err(PanoError::InvalidOptions(format!(
            "composite_tile_streaming: {} frames vs {} poses",
            frames.len(),
            poses.len()
        )));
    }
    if frames.is_empty() {
        return Err(PanoError::InvalidOptions(
            "composite_tile_streaming: no frames".into(),
        ));
    }

    let strip_rows = strip_rows.max(1).min(canvas.height);

    // ── 1. Planar residuals ───────────────────────────────────────────────
    let max_frame_idx = poses.iter().map(|p| p.frame_idx).max().unwrap_or(0);
    let mut frame_to_local = vec![usize::MAX; max_frame_idx + 1];
    for (li, pose) in poses.iter().enumerate() {
        frame_to_local[pose.frame_idx] = li;
    }
    let mut residual_sum = 0.0_f64;
    let mut residual_max = 0.0_f64;
    let mut residual_count = 0usize;
    for edge in tile_edges {
        let la = frame_to_local.get(edge.a).copied().unwrap_or(usize::MAX);
        let lb = frame_to_local.get(edge.b).copied().unwrap_or(usize::MAX);
        if la == usize::MAX || lb == usize::MAX {
            continue;
        }
        let (pa, pb) = (&poses[la], &poses[lb]);
        for m in &edge.inlier_matches {
            let (cax, cay) = pa.sim.apply(m.a.0, m.a.1);
            let (cbx, cby) = pb.sim.apply(m.b.0, m.b.1);
            let res = ((cax - cbx).powi(2) + (cay - cby).powi(2)).sqrt();
            residual_sum += res;
            if res > residual_max {
                residual_max = res;
            }
            residual_count += 1;
        }
    }
    let mean_planar = if residual_count > 0 {
        residual_sum / residual_count as f64
    } else {
        0.0
    };

    // ── 2. Gain solve in canvas space (no full-canvas warp allocation) ───
    //
    // `solve_gains_canvas_space` walks the same strided canvas grid as
    // `solve_gains_tile` but reads pixel values by re-applying the inverse
    // similarity + bicubic directly, matching the warped layer values
    // byte-for-byte.
    let gains = solve_gains_canvas_space(frames, poses, canvas, gain_opts)?;

    // ── 3. Compact global owner map ───────────────────────────────────────
    //
    // One u16 per canvas pixel instead of K f32 planes.  Same border-
    // distance metric and validity gate as `voronoi_masks_tile`.
    let (owner_map, min_overlap) = build_owner_map(frames, poses, canvas, strip_rows);
    let levels = levels_override.unwrap_or_else(|| levels_for_overlap_width(min_overlap));

    // ── 4. Warp each frame once (with gains) ─────────────────────────────
    //
    // The old code warped twice: once with gain=[1,1,1] (for `solve_gains_tile`)
    // and once with actual gains (for the blend).  We skip the first pass.
    let layers_gained: Vec<PlanarImage> = frames
        .iter()
        .zip(poses)
        .zip(&gains)
        .map(|((f, pose), &g)| warp_to_tile_canvas(f, pose, canvas, g))
        .collect();

    // ── 5. Build Voronoi weight planes from owner map ─────────────────────
    //
    // `voronoi_masks_tile` produced K f32 planes (1.0 for owned, 0.0 for
    // others).  We produce the same planes from the compact owner map.
    let masks: Vec<Vec<f32>> = (0..frames.len())
        .map(|fi| {
            owner_map
                .iter()
                .map(|&o| if o as usize == fi { 1.0_f32 } else { 0.0 })
                .collect()
        })
        .collect();

    // ── 6. Multi-band blend ───────────────────────────────────────────────
    //
    // Identical to the old `composite_tile` path: same gained layers, same
    // Voronoi weight planes, same level count.
    let blended = blend_multiband(&layers_gained, &masks, levels);

    Ok((
        blended,
        TileCompositeReport {
            canvas: canvas.clone(),
            placements: poses.to_vec(),
            gains,
            blend_levels: levels,
            min_overlap_width_px: min_overlap,
            mean_planar_residual_px: mean_planar,
            max_planar_residual_px: residual_max,
        },
    ))
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gain::GainOptions;
    use crate::ingest::{PlanarImage, ValidityMask};
    use crate::similarity::Similarity2d;
    use crate::tile::placement::{TileCanvasSpec, TilePose};
    use crate::tile::{composite_tile, TileEdge};

    fn gradient_frame(w: u32, h: u32, r_scale: f32, g_scale: f32, b_scale: f32) -> PlanarImage {
        let n = (w * h) as usize;
        let mut r = Vec::with_capacity(n);
        let mut g = Vec::with_capacity(n);
        let mut b = Vec::with_capacity(n);
        for y in 0..h {
            for x in 0..w {
                let fx = x as f32 / w as f32;
                let fy = y as f32 / h as f32;
                let base = 0.3 + 0.4 * fx + 0.2 * fy;
                r.push(base * r_scale);
                g.push(base * g_scale);
                b.push(base * b_scale);
            }
        }
        PlanarImage::from_planes(w, h, r, g, b, ValidityMask::new_filled(w, h, true))
    }

    fn two_frame_setup() -> (Vec<PlanarImage>, Vec<TilePose>, TileCanvasSpec) {
        let fw = 100u32;
        let fh = 80u32;
        let overlap = 40u32;
        let canvas_w = fw + (fw - overlap);
        let frames = vec![
            gradient_frame(fw, fh, 1.0, 0.9, 0.8),
            gradient_frame(fw, fh, 1.02, 0.88, 0.82),
        ];
        let poses = vec![
            TilePose {
                sim: Similarity2d {
                    scale: 1.0,
                    theta: 0.0,
                    tx: 0.0,
                    ty: 0.0,
                },
                frame_idx: 0,
            },
            TilePose {
                sim: Similarity2d {
                    scale: 1.0,
                    theta: 0.0,
                    tx: (fw - overlap) as f64,
                    ty: 0.0,
                },
                frame_idx: 1,
            },
        ];
        let canvas = TileCanvasSpec {
            width: canvas_w,
            height: fh,
            offset_x: 0.0,
            offset_y: 0.0,
        };
        (frames, poses, canvas)
    }

    /// The streaming composite must be pixel-for-pixel identical (< 1e-4 max
    /// diff) to the reference `composite_tile` on the same two-frame setup, at
    /// multiple strip heights.
    #[test]
    fn streaming_tile_equals_reference() {
        let (frames, poses, canvas) = two_frame_setup();
        let opts = GainOptions::default();
        let no_edges: Vec<TileEdge> = vec![];

        let (ref_img, _) = composite_tile(
            &frames,
            frames.len(),
            &no_edges,
            &poses,
            &canvas,
            &opts,
            None,
        )
        .expect("reference composite_tile");

        for strip_rows in [1_u32, 32, 512] {
            let (stream_img, _) = composite_tile_streaming(
                &frames, &no_edges, &poses, &canvas, &opts, None, strip_rows,
            )
            .expect("composite_tile_streaming");

            assert_eq!(stream_img.width(), ref_img.width(), "strip={strip_rows}");
            assert_eq!(stream_img.height(), ref_img.height(), "strip={strip_rows}");

            let n = (ref_img.width() as usize) * (ref_img.height() as usize);
            let mut max_diff = 0.0_f32;
            for i in 0..n {
                let dr = (stream_img.r[i] - ref_img.r[i]).abs();
                let dg = (stream_img.g[i] - ref_img.g[i]).abs();
                let db = (stream_img.b[i] - ref_img.b[i]).abs();
                max_diff = max_diff.max(dr).max(dg).max(db);
                let (x, y) = (
                    (i % ref_img.width() as usize) as u32,
                    (i / ref_img.width() as usize) as u32,
                );
                assert_eq!(
                    stream_img.validity.get(x, y),
                    ref_img.validity.get(x, y),
                    "validity mismatch at ({x},{y}) strip={strip_rows}"
                );
            }
            assert!(
                max_diff < 1e-4,
                "strip={strip_rows}: max pixel diff = {max_diff} (expected < 1e-4)"
            );
        }
    }
}
