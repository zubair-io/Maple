//! Quick low-resolution panorama preview (#4578).
//!
//! Runs the shared head (decode → proxy features → match graph → strategy)
//! — or reuses an offered alignment and only decodes the proxies — then
//! skips full-resolution refinement entirely: the solve and the composite
//! run on the proxies already in memory, in the proxies' own pixel plane,
//! onto a canvas whose long edge is about [`PREVIEW_LONG_EDGE_PX`]. No
//! full-resolution frame is ever decoded. The scene-linear composite is
//! developed through the same AgX → sRGB view tail the full stitch's
//! display PNG uses, and the solved alignment comes back with it so the
//! full stitch can start from it.
//!
//! The solve here consumes proxy-accuracy matches, so the residual budgets
//! apply in proxy pixels — a preview keeps frames a strict full stitch
//! might drop; the full stitch re-solves on refined matches regardless.
//! User seam constraints are drawn in full-stitch canvas pixels, which the
//! preview canvas does not share, so the preview seams are unconstrained.

use std::path::PathBuf;
use std::time::Instant;

use crate::ba::{self, BaOptions};
use crate::camera::Camera;
use crate::canvas::{auto_canvas, CanvasOptions, CanvasSpec, ProjectionMode};
use crate::composite::{composite_tiled_frames, CanvasCollector};
use crate::gain::{solve_exposure_field, solve_photometry, GainMode, GainOptions};
use crate::ingest::PlanarImage;
use crate::leveling;
use crate::local_align::LocalCorrection;
use crate::strategy::Strategy;
use crate::tile::frame_cache::TileFrameCache;

use super::alignment::{usable, AlignmentKey, AlignmentReuse, SolvedAlignment};
use super::degenerate::reject_degenerate_canvas;
use super::io::develop_for_display;
use super::tile_stitch::{place_and_composite, TilePlaced};
use super::types::{StitchError, StitchOptions};

/// Target long edge of the preview canvas (~2 MP for a 2:1 pano).
pub const PREVIEW_LONG_EDGE_PX: u32 = 2048;

pub struct PanoPreview {
    pub width: u32,
    pub height: u32,
    /// Display-encoded sRGB, 16-bit interleaved RGB — the same encode
    /// [`super::develop_for_display`] gives the full stitch's display PNG.
    pub display_rgb16: Vec<u16>,
    pub strategy: Strategy,
    pub alignment: SolvedAlignment,
    pub reuse: AlignmentReuse,
    /// `[decode, features, match_graph, refine, solve, composite]` seconds;
    /// refine is always 0 (skipped), features and match_graph are 0 when
    /// the alignment was reused.
    pub stage_timings_s: [f64; 6],
}

/// Build a preview of `inputs` under `opts`, reusing `offered` when its
/// fingerprint matches (see [`super::stitch_reusing`] for the rule).
/// Progress uses the stitch's stage ordinals; stage 3 is reported complete
/// immediately because the preview skips refinement.
pub fn preview(
    inputs: &[PathBuf],
    opts: &StitchOptions,
    offered: Option<&SolvedAlignment>,
    mut progress: impl FnMut(u32, f32),
    is_cancelled: impl Fn() -> bool,
) -> Result<PanoPreview, StitchError> {
    super::validate_request(inputs, opts)?;
    let key = AlignmentKey::for_run(inputs, opts)?;
    let (reusable, reuse) = usable(offered, &key);
    let (alignment, metas, head_timings) = match reusable {
        Some(stored) => {
            let t0 = Instant::now();
            let metas =
                super::decode_proxies(inputs, opts.proxy_long_edge, &mut progress, &is_cancelled)?;
            (1..=2).for_each(|stage| progress(stage, 1.0));
            (
                stored.clone(),
                metas,
                [t0.elapsed().as_secs_f64(), 0.0, 0.0],
            )
        }
        None => {
            let head = super::solve_alignment(inputs, opts, key, &mut progress, &is_cancelled)?;
            (head.alignment, head.metas, head.stage_timings_012)
        }
    };
    let proxies: Vec<PlanarImage> = metas.into_iter().map(|m| m.proxy).collect();
    if proxies
        .iter()
        .zip(&alignment.frames)
        .any(|(p, f)| (p.width(), p.height()) != f.proxy_dims)
    {
        return Err(StitchError::Composite(
            "preview: decoded proxy sizes disagree with the alignment's".into(),
        ));
    }
    progress(3, 1.0);

    let (image, solve_s, composite_s) = match &alignment.tile_graph {
        Some(tile_graph) => {
            let cache = TileFrameCache::from_frames(proxies);
            let mut collector = CanvasCollector::default();
            let TilePlaced {
                solve_s,
                composite_s,
                ..
            } = place_and_composite(
                tile_graph,
                &alignment.proxy_dims(),
                &cache,
                &alignment.lenses,
                opts.local_align,
                long_edge_pixel_cap,
                &mut collector,
                &mut progress,
                &is_cancelled,
            )?;
            (collector.into_image(), solve_s, composite_s)
        }
        None => rotation_preview(&alignment, proxies, opts, &mut progress, &is_cancelled)?,
    };

    Ok(PanoPreview {
        width: image.width(),
        height: image.height(),
        display_rgb16: develop_for_display(&image),
        strategy: alignment.strategy_report.selected,
        stage_timings_s: [
            head_timings[0],
            head_timings[1],
            head_timings[2],
            0.0,
            solve_s,
            composite_s,
        ],
        alignment,
        reuse,
    })
}

/// The pixel cap that brings a `width × height` canvas's long edge down to
/// [`PREVIEW_LONG_EDGE_PX`] (the canvas's own size when already smaller).
fn long_edge_pixel_cap(width: u32, height: u32) -> usize {
    let long_edge = width.max(height).max(1);
    let scale = (PREVIEW_LONG_EDGE_PX as f64 / long_edge as f64).min(1.0);
    ((width as f64 * scale) * (height as f64 * scale))
        .floor()
        .max(1.0) as usize
}

/// A frame that survived the preview solve, with what the composite needs.
struct KeptProxy {
    input: usize,
    frame: PlanarImage,
    camera: Camera,
    local: Option<LocalCorrection>,
    /// `sx · sy` — full-resolution pixels per proxy pixel.
    area_scale: f64,
}

fn rotation_preview(
    alignment: &SolvedAlignment,
    proxies: Vec<PlanarImage>,
    opts: &StitchOptions,
    progress: &mut dyn FnMut(u32, f32),
    is_cancelled: &dyn Fn() -> bool,
) -> Result<(PlanarImage, f64, f64), StitchError> {
    let t4 = Instant::now();
    progress(4, 0.0);
    if is_cancelled() {
        return Err(StitchError::Cancelled);
    }
    let mut solution = ba::solve(
        &alignment.proxy_images(),
        &alignment.graph,
        &BaOptions {
            mean_budget_px: opts.mean_budget_px,
            max_budget_px: opts.max_budget_px,
            retention: opts.retention,
            local_align: opts.local_align,
            ..Default::default()
        },
    )
    .map_err(|e| StitchError::BaSolve(e.to_string()))?;
    leveling::apply(&mut solution);
    let solve_s = t4.elapsed().as_secs_f64();
    progress(4, 1.0);

    let t5 = Instant::now();
    progress(5, 0.0);
    if is_cancelled() {
        return Err(StitchError::Cancelled);
    }
    let kept: Vec<KeptProxy> = proxies
        .into_iter()
        .zip(&solution.cameras)
        .zip(&solution.local_corrections)
        .zip(&alignment.frames)
        .enumerate()
        .filter_map(|(input, (((frame, cam), lc), f))| {
            cam.as_ref().map(|c| KeptProxy {
                input,
                frame,
                camera: c.clone(),
                local: lc.clone(),
                area_scale: f.proxy_scale.0 * f.proxy_scale.1,
            })
        })
        .collect();
    if kept.len() < 2 {
        return Err(StitchError::TooFewSurvivors {
            survived: kept.len(),
            dropped: solution.dropped.clone(),
        });
    }
    let cameras: Vec<Camera> = kept.iter().map(|k| k.camera.clone()).collect();

    // The cap is a full-resolution pixel count; a proxy canvas carries
    // 1 / (sx · sy) as many pixels for the same angular extent.
    let mean_area_scale = kept.iter().map(|k| k.area_scale).sum::<f64>() / kept.len() as f64;
    let proxy_cap_px = ((opts.max_canvas_px as f64 / mean_area_scale) as usize).max(1);
    let natural_opts = CanvasOptions {
        projection: ProjectionMode::Auto,
        max_pixels: proxy_cap_px,
        ..Default::default()
    };
    reject_degenerate_canvas(&cameras, &natural_opts, &alignment.strategy_report, opts)?;
    let canvas = preview_canvas(&cameras, &natural_opts)?;

    let kept_inputs: Vec<usize> = kept.iter().map(|k| k.input).collect();
    let (frames, local): (Vec<PlanarImage>, Vec<Option<LocalCorrection>>) =
        kept.into_iter().map(|k| (k.frame, k.local)).unzip();
    let to_err = |e: crate::error::PanoError| StitchError::Composite(e.to_string());
    let photometry = solve_photometry(
        &frames,
        &cameras,
        &alignment.lenses.for_frames(&kept_inputs),
        &GainOptions {
            mode: GainMode::PerChannel,
            ..GainOptions::default()
        },
    )
    .map_err(to_err)?
    .frames;
    let exposure_field =
        solve_exposure_field(&frames, &cameras, &photometry, &local, &canvas).map_err(to_err)?;
    let (image, _) = composite_tiled_frames(
        &frames,
        &cameras,
        &photometry,
        &local,
        Some(&exposure_field),
        &canvas,
        opts.canvas_tile_rows.unwrap_or(512),
        opts.seam_strategy,
        &[],
    )
    .map_err(to_err)?;
    progress(5, 1.0);
    Ok((image, solve_s, t5.elapsed().as_secs_f64()))
}

fn preview_canvas(cameras: &[Camera], natural: &CanvasOptions) -> Result<CanvasSpec, StitchError> {
    let to_err = |e: crate::error::PanoError| StitchError::Composite(e.to_string());
    let natural_canvas = auto_canvas(cameras, natural).map_err(to_err)?;
    let cap = long_edge_pixel_cap(natural_canvas.width, natural_canvas.height);
    if cap >= natural_canvas.width as usize * natural_canvas.height as usize {
        return Ok(natural_canvas);
    }
    auto_canvas(
        cameras,
        &CanvasOptions {
            max_pixels: cap,
            ..natural.clone()
        },
    )
    .map_err(to_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_edge_cap_brings_wide_canvas_to_the_preview_edge() {
        let cap = long_edge_pixel_cap(20_000, 5_000);
        assert_eq!(cap, 2048 * 512);
    }

    #[test]
    fn long_edge_cap_keeps_small_canvas_whole() {
        assert_eq!(long_edge_pixel_cap(1_000, 600), 600_000);
    }
}
