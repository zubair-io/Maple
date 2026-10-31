//! Tiled multiband composite for the tile strategy. Split from
//! `tile/mod.rs` for the file-size budget (#3086).

use crate::blend::{blend_multiband, levels_for_overlap_width, MAX_LEVELS};
use crate::boundary_warp::{BoundaryWarp, BoundaryWarpReport};
use crate::composite::{CanvasSink, UncoveredCount};
use crate::error::PanoError;
use crate::gain::{GainOptions, LensFalloff, LensGroups};
use crate::ingest::PlanarImage;
use crate::local_align::planar::planar_residuals;
use crate::local_align::LocalCorrection;

use crate::frame_store::FrameRows;

use super::masks::{estimate_min_overlap_width, voronoi_masks_region};
use super::photometry::{solve_photometry, PhotometryOptions};
use super::placement::{TileCanvasSpec, TilePose};
use super::source::{read_window, Cell};
use super::warp::{inverse_similarity_with_offset, warp_to_tile_region};
use super::{TileEdge, TILE_PX};

/// Compute the halo width (pixels) that covers the full influence radius of
/// a `levels`-deep pyramid using the `[1,4,6,4,1]` binomial kernel (radius
/// 2 per level-downsample). The influence radius at full resolution is
/// `2 * (2^levels - 1)`. We round up to the next power of two for alignment,
/// then add a safety factor of 2 to ensure boundary accuracy.
///
/// ## Floor at 16 / 32 px
///
/// `influence.next_power_of_two()` is clamped to a minimum of 16 before the
/// ×2 safety factor, yielding a minimum halo of 32 px even when `levels` is
/// small (e.g. `levels = 1` → influence 2 → without the floor the halo would
/// be 4 px). The floor serves two purposes:
///
/// 1. **Rounding guard.** A 2 px halo offers almost no margin against
///    sub-pixel inverse-map rounding or integer-truncation in the interior
///    copy; 32 px gives comfortable headroom at zero cost on realistic tile
///    sizes.
/// 2. **Overhead avoidance.** Degenerate tiny halos (< one cache line wide)
///    produce more tile-boundary bookkeeping work than they save in warp area;
///    32 px keeps the per-tile overhead small relative to the 1024 px tile
///    body.
fn halo_for_levels(levels: usize) -> usize {
    let influence = 2 * ((1usize << levels).saturating_sub(1));
    let next_pow2 = influence.next_power_of_two().max(16);
    // Safety factor ×2 so boundary rows are well inside the valid halo zone.
    next_pow2 * 2
}

/// Report from the tile composite pass.
#[derive(Debug, Clone)]
pub struct TileCompositeReport {
    pub canvas: TileCanvasSpec,
    pub placements: Vec<TilePose>,
    pub gains: Vec<[f32; 3]>,
    pub blend_levels: usize,
    pub min_overlap_width_px: usize,
    /// Mean planar residual over all verified inlier pairs (px).
    pub mean_planar_residual_px: f64,
    /// Max planar residual over verified inlier pairs (px).
    pub max_planar_residual_px: f64,
    /// The planar residuals before the Stage-F mesh (#4577); equal to the
    /// two above when local alignment is off.
    pub mean_planar_before_local_px: f64,
    pub max_planar_before_local_px: f64,
    /// Per-frame Stage-F correction RMS (px), parallel to `placements`;
    /// 0 for frames left uncorrected.
    pub local_correction_rms_px: Vec<f64>,
    /// Halo width used in the tiled multiband blend (px).
    pub halo_px: usize,
    /// The boundary warp the output was composited through (#5572); `None`
    /// when none was requested.
    pub boundary_warp: Option<BoundaryWarpReport>,
    /// Output pixels no frame covered.
    pub uncovered_px: u64,
    /// Shared per-frame log-slope along frame-local x (#350 layer A).
    pub photometric_slope_x: f32,
    /// Shared per-frame log-slope along frame-local y (#350 layer A).
    pub photometric_slope_y: f32,
    /// Mean |residual exposure field| in EV (#350 layer B; 0 = no field).
    pub exposure_field_mean_abs_ev: f64,
    /// Max |residual exposure field| in EV (#350 layer B).
    pub exposure_field_max_abs_ev: f64,
    /// Blind lens falloff per lens group (#4522); frames are input
    /// indices. Empty when ingest corrected every placed frame.
    pub falloff: Vec<LensFalloff>,
}

/// End-to-end tile composite with spatial tiling + multiband blend.
///
/// This is the memory-bounded replacement for the old full-canvas
/// `composite_tile` (#1291). Instead of warping all K frames to the
/// full canvas and running multiband over the full-canvas pyramids,
/// the canvas is processed as a grid of `TILE_PX × TILE_PX` spatial
/// tiles, each expanded by a `halo` wide enough to cover the pyramid's
/// influence radius. Peak memory scales with `(TILE + 2·HALO)² × K ×
/// pyramid_depth`, not with canvas area.
///
/// ## Algorithm
///
/// 1. **Gains (memory-light, once):** solved via canvas-space inverse-
///    similarity sampling — no full-canvas warp needed.
/// 2. **Pyramid level count:** determined from minimum overlap width,
///    same as the former code.
/// 3. **Halo width:** `halo_for_levels(levels)` — covers the binomial
///    kernel influence radius at full resolution, rounded up to the next
///    power of two with a ×2 safety factor.
/// 4. **Per output tile** `[tx0, ty0)–(tx1, ty1)`: expand by halo on
///    each side (clamped to canvas). Warp each frame into the haloed
///    region only (`warp_to_tile_region`), from the source window that
///    region's taps touch (`source::read_window`). Compute Voronoi masks for
///    the haloed region. Run `blend_multiband` on the haloed layers +
///    masks + gains. Copy only the interior (drop halo border) into the
///    output canvas. Drop tile buffers before the next tile.
///
/// ## Output
///
/// The result is **byte-identical** to the full-canvas `composite_tile` path
/// when the halo fully covers the multiband pyramid's influence radius —
/// which is always true when `halo >= halo_for_levels(levels)` (the default).
/// The halo ensures every interior pixel's pyramid taps land within the haloed
/// region, so no tile boundary introduces a different context than the
/// full-canvas computation would. The byte-identity breaks only if a caller
/// explicitly reduces the halo below `halo_for_levels(levels)`, which the
/// public API does not expose.
///
/// # Frame access (#3197, #5560)
///
/// `frames` is indexed by `poses[i].frame_idx` — the *original* input
/// frame index, not a position in `poses`. `full_dims` and
/// `lenses.of_frame` are indexed the same way; `full_dims` gives pixel
/// dimensions without reading pixels; `tile_edges` is filtered to the
/// reachable component. Each output tile reads, per frame it can see, only
/// the source window its haloed region needs, and drops it once that
/// frame's layer is warped — so peak residency is a few tile-sized
/// windows, not whole frames.
#[allow(clippy::too_many_arguments)]
pub(crate) fn composite_tile(
    frames: &dyn FrameRows,
    full_dims: &[(u32, u32)],
    tile_edges: &[TileEdge],
    poses: &[TilePose],
    corrections: Option<&[LocalCorrection]>,
    canvas: &TileCanvasSpec,
    boundary_warp: Option<&BoundaryWarp>,
    lenses: &LensGroups,
    gain_opts: &GainOptions,
    levels_override: Option<usize>,
    sink: &mut dyn CanvasSink,
) -> Result<TileCompositeReport, PanoError> {
    let output = boundary_warp.map(|map| map.on_canvas(canvas.width, canvas.height));
    let mut counted = UncoveredCount::new(sink);
    let sink = &mut counted;
    if poses.is_empty() {
        return Err(PanoError::InvalidOptions(
            "composite_tile: no frames".into(),
        ));
    }
    if let Some(pose) = poses.iter().find(|p| p.frame_idx >= full_dims.len()) {
        return Err(PanoError::InvalidOptions(format!(
            "composite_tile: pose frame_idx {} out of range for {} full_dims entries",
            pose.frame_idx,
            full_dims.len()
        )));
    }

    let (mean_before, max_before) = planar_residuals(poses, tile_edges, None);
    let (mean_planar, residual_max) = planar_residuals(poses, tile_edges, corrections);
    let max_correction_px = corrections.map_or(0.0, |cs| {
        cs.iter().map(|c| c.max_correction_px).fold(0.0, f64::max)
    });

    // ── photometric solve: gains + shared ramp + residual fields (#350) ──────
    let (photometry, phot_summary) = solve_photometry(
        frames,
        full_dims,
        poses,
        canvas,
        lenses,
        &PhotometryOptions::from_gain(gain_opts),
    )?;
    let gains: Vec<[f32; 3]> = photometry.iter().map(|p| p.gain).collect();

    // ── determine pyramid level count ────────────────────────────────────────
    // We need the min overlap width for level selection. Compute cheaply via
    // a canvas-space scan at a coarse stride (same approach as voronoi_masks_tile
    // but just for overlap width stats, no actual masking needed here).
    let min_overlap = estimate_min_overlap_width(frames, full_dims, poses, canvas, output)?;
    let levels = levels_override
        .unwrap_or_else(|| levels_for_overlap_width(min_overlap))
        .clamp(1, MAX_LEVELS);
    let halo = halo_for_levels(levels);

    // Output goes to `sink` one full-width band of tiles at a time (#5452).
    let cw = canvas.width as usize;
    let ch = canvas.height as usize;
    sink.begin(canvas.width, canvas.height)?;

    // Per-frame canvas-space bounding boxes for spatial culling (#3086).
    // A similarity maps the frame rectangle to a convex quad, so the
    // corner bbox is exact; frames whose bbox misses a haloed region can
    // only produce an all-invalid layer there — zero-weight in both the
    // Voronoi masks and the multiband blend — and are skipped outright.
    let frame_bboxes: Vec<(f64, f64, f64, f64)> = poses
        .iter()
        .map(|pose| {
            let (fw, fh) = full_dims[pose.frame_idx];
            let (fw, fh) = (fw as f64, fh as f64);
            let corners = [(0.0, 0.0), (fw, 0.0), (0.0, fh), (fw, fh)];
            let mapped = corners
                .iter()
                .map(|&(x, y)| pose.sim.apply(x, y))
                .map(|(x, y)| (x + canvas.offset_x, y + canvas.offset_y));
            let (x0, y0, x1, y1) = mapped.fold(
                (
                    f64::INFINITY,
                    f64::INFINITY,
                    f64::NEG_INFINITY,
                    f64::NEG_INFINITY,
                ),
                |(x0, y0, x1, y1), (x, y)| (x0.min(x), y0.min(y), x1.max(x), y1.max(y)),
            );
            let pad = max_correction_px * pose.sim.scale;
            (x0 - pad, y0 - pad, x1 + pad, y1 + pad)
        })
        .collect();

    let inv_sims: Vec<_> = poses
        .iter()
        .map(|p| inverse_similarity_with_offset(&p.sim, canvas.offset_x, canvas.offset_y))
        .collect();

    // ── spatial tile loop ────────────────────────────────────────────────────
    let mut ty0 = 0usize;
    while ty0 < ch {
        let ty1 = (ty0 + TILE_PX).min(ch);
        let band_n = cw * (ty1 - ty0);
        let mut out_r = vec![0.0_f32; band_n];
        let mut out_g = vec![0.0_f32; band_n];
        let mut out_b = vec![0.0_f32; band_n];
        let mut out_valid =
            crate::ingest::ValidityMask::new_filled(canvas.width, (ty1 - ty0) as u32, false);
        let mut tx0 = 0usize;
        while tx0 < cw {
            let tx1 = (tx0 + TILE_PX).min(cw);

            // Expand by halo on each side (clamp to canvas).
            let hx0 = tx0.saturating_sub(halo);
            let hy0 = ty0.saturating_sub(halo);
            let hx1 = (tx1 + halo).min(cw);
            let hy1 = (ty1 + halo).min(ch);

            let haloed = Cell {
                x0: hx0,
                y0: hy0,
                x1: hx1,
                y1: hy1,
            };
            // Cull frames whose canvas bbox misses what the haloed region
            // samples, then warp only the survivors (#3086). The 1 px pad
            // absorbs the +0.5 pixel-center sampling and float slop at the
            // boundary.
            let (sx0, sy0, sx1, sy1) = haloed.sampled_extent(output);
            let active: Vec<usize> = (0..poses.len())
                .filter(|&i| {
                    let (bx0, by0, bx1, by1) = frame_bboxes[i];
                    bx1 >= sx0 - 1.0 && bx0 <= sx1 + 1.0 && by1 >= sy0 - 1.0 && by0 <= sy1 + 1.0
                })
                .collect();
            if active.is_empty() {
                tx0 = tx1;
                continue;
            }
            let haloed_layers: Vec<PlanarImage> = active
                .iter()
                .map(|&i| -> Result<PlanarImage, PanoError> {
                    let window = read_window(
                        frames,
                        poses[i].frame_idx,
                        &inv_sims[i],
                        haloed.sampled_centres(output),
                        corrections.map_or(0.0, |c| c[i].max_correction_px),
                    )?;
                    Ok(warp_to_tile_region(
                        window.view(),
                        &poses[i],
                        corrections.map(|c| &c[i]),
                        canvas,
                        output,
                        &photometry[i],
                        hx0,
                        hy0,
                        hx1,
                        hy1,
                    ))
                })
                .collect::<Result<Vec<_>, PanoError>>()?;

            // Skip tile if no frame covers any pixel in the haloed region.
            let any_valid = haloed_layers.iter().any(|l| l.validity.any_valid());
            if !any_valid {
                tx0 = tx1;
                continue;
            }

            // Voronoi masks over the haloed region (source-space depth
            // needs the active frames' poses + dims).
            let active_poses: Vec<TilePose> = active.iter().map(|&i| poses[i].clone()).collect();
            let active_dims: Vec<(u32, u32)> = active
                .iter()
                .map(|&i| full_dims[poses[i].frame_idx])
                .collect();
            let (masks, _) = voronoi_masks_region(
                &haloed_layers,
                &active_poses,
                &active_dims,
                canvas,
                output,
                hx0,
                hy0,
            );

            // Multiband blend of haloed region.
            let blended = blend_multiband(&haloed_layers, &masks, levels);

            // Copy only the interior (drop halo border) into the output.
            // Interior in haloed-region coordinates:
            let ix0 = tx0 - hx0; // left interior offset inside blended
            let iy0 = ty0 - hy0; // top interior offset inside blended
            let bw = blended.width() as usize; // = hx1 - hx0

            for oy in ty0..ty1 {
                let by = iy0 + (oy - ty0);
                for ox in tx0..tx1 {
                    let bx = ix0 + (ox - tx0);
                    if !blended.validity.get(bx as u32, by as u32) {
                        continue;
                    }
                    let bi = by * bw + bx;
                    let oi = (oy - ty0) * cw + ox;
                    out_r[oi] = blended.r[bi];
                    out_g[oi] = blended.g[bi];
                    out_b[oi] = blended.b[bi];
                    out_valid.set(ox as u32, (oy - ty0) as u32, true);
                }
            }

            // haloed_layers, masks, blended drop here — freeing memory before
            // the next tile iteration.
            tx0 = tx1;
        }
        sink.rows(&PlanarImage::from_planes(
            canvas.width,
            (ty1 - ty0) as u32,
            out_r,
            out_g,
            out_b,
            out_valid,
        ))?;
        ty0 = ty1;
    }

    Ok(TileCompositeReport {
        canvas: canvas.clone(),
        placements: poses.to_vec(),
        gains,
        blend_levels: levels,
        min_overlap_width_px: min_overlap,
        mean_planar_residual_px: mean_planar,
        max_planar_residual_px: residual_max,
        mean_planar_before_local_px: mean_before,
        max_planar_before_local_px: max_before,
        local_correction_rms_px: corrections.map_or_else(
            || vec![0.0; poses.len()],
            |cs| cs.iter().map(|c| c.rms_px).collect(),
        ),
        halo_px: halo,
        boundary_warp: None,
        uncovered_px: counted.uncovered,
        photometric_slope_x: phot_summary.slope_x,
        photometric_slope_y: phot_summary.slope_y,
        exposure_field_mean_abs_ev: phot_summary.field_mean_abs_ev,
        exposure_field_max_abs_ev: phot_summary.field_max_abs_ev,
        falloff: phot_summary.falloff,
    })
}
