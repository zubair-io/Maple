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
use crate::frame_store::InMemory;
use crate::gain::{solve_exposure_field, solve_photometry, GainMode, GainOptions};
use crate::ingest::PlanarImage;
use crate::leveling;
use crate::local_align::LocalCorrection;
use crate::strategy::Strategy;

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
    /// Estimated `(width, height)` of the full stitch's canvas under the
    /// same options: the preview's natural proxy canvas scaled up by the
    /// proxies' mean full-resolution pixel ratio, then held to
    /// `max_canvas_px`. Lets a caller size its memory budget before
    /// committing to the full stitch.
    pub full_canvas_estimate: (u32, u32),
    /// Pixel count of the largest input frame at full resolution, the
    /// input to callers' memory models.
    pub largest_frame_px: u64,
    /// Bytes the full stitch reserves on the temp volume for its decoded
    /// frames ([`super::scratch_bytes`]), the input to callers' free-disk
    /// checks.
    pub scratch_bytes: u64,
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
            let t0 = Instant::now();
            let metas =
                super::decode_proxies(inputs, opts.proxy_long_edge, &mut progress, &is_cancelled)?;
            let head = super::solve_alignment(
                metas,
                t0.elapsed().as_secs_f64(),
                opts,
                key,
                &mut progress,
                &is_cancelled,
            )?;
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

    let largest_frame_px = alignment
        .frames
        .iter()
        .map(|f| {
            let (w, h) = f.proxy_dims;
            (w as f64 * f.proxy_scale.0 * h as f64 * f.proxy_scale.1).round() as u64
        })
        .max()
        .unwrap_or(0);
    let (image, full_canvas_estimate, solve_s, composite_s) = match &alignment.tile_graph {
        Some(tile_graph) => {
            let frames = InMemory(&proxies);
            let mut collector = CanvasCollector::default();
            let mut natural = (0, 0);
            let TilePlaced {
                solve_s,
                composite_s,
                ..
            } = place_and_composite(
                tile_graph,
                &alignment.proxy_dims(),
                &frames,
                &alignment.lenses,
                opts.local_align,
                |w, h| {
                    natural = (w, h);
                    long_edge_pixel_cap(w, h)
                },
                &mut collector,
                &mut progress,
                &is_cancelled,
            )?;
            // Tile placement fixes frame 0 at the identity, so canvas
            // pixels are the anchor frame's pixels.
            let anchor_scale = alignment.frames[0].proxy_scale;
            (
                collector.into_image(),
                tile_full_canvas_estimate(natural, anchor_scale, opts.max_canvas_px),
                solve_s,
                composite_s,
            )
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
        largest_frame_px,
        scratch_bytes: super::scratch_bytes(inputs)?,
        full_canvas_estimate,
    })
}

/// Scale a tile canvas in the anchor frame's proxy pixels to full
/// resolution by that frame's `(sx, sy)` and hold it to `cap_px` the way
/// `apply_canvas_cap` does (uniform shrink to fit).
fn tile_full_canvas_estimate(proxy: (u32, u32), (sx, sy): (f64, f64), cap_px: usize) -> (u32, u32) {
    let (w, h) = (proxy.0 as f64 * sx.max(0.0), proxy.1 as f64 * sy.max(0.0));
    let fit = (cap_px as f64 / (w * h).max(1.0)).sqrt().min(1.0);
    ((w * fit).round() as u32, (h * fit).round() as u32)
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

/// The canvas the full stitch's `auto_canvas` picks for `cameras` once each
/// is scaled from proxy to full-resolution pixels by its own `(sx, sy)`.
/// `auto_canvas` samples at the densest frame, so with mixed input
/// resolutions the highest-resolution frame sets the size, not an average.
fn rotation_full_canvas_estimate(
    cameras: &[Camera],
    scales: &[(f64, f64)],
    cap_px: usize,
) -> Result<(u32, u32), StitchError> {
    let full: Vec<Camera> = cameras
        .iter()
        .zip(scales)
        .map(|(cam, &(sx, sy))| Camera {
            focal_px: cam.focal_px * sx,
            width: (cam.width as f64 * sx).round() as u32,
            height: (cam.height as f64 * sy).round() as u32,
            ..cam.clone()
        })
        .collect();
    let canvas = auto_canvas(
        &full,
        &CanvasOptions {
            projection: ProjectionMode::Auto,
            max_pixels: cap_px.max(1),
            ..Default::default()
        },
    )
    .map_err(|e| StitchError::Composite(e.to_string()))?;
    Ok((canvas.width, canvas.height))
}

/// A frame that survived the preview solve, with what the composite needs.
struct KeptProxy {
    input: usize,
    frame: PlanarImage,
    camera: Camera,
    local: Option<LocalCorrection>,
    /// `(sx, sy)` — full-resolution pixels per proxy pixel on each axis.
    scale: (f64, f64),
}

fn rotation_preview(
    alignment: &SolvedAlignment,
    proxies: Vec<PlanarImage>,
    opts: &StitchOptions,
    progress: &mut dyn FnMut(u32, f32),
    is_cancelled: &dyn Fn() -> bool,
) -> Result<(PlanarImage, (u32, u32), f64, f64), StitchError> {
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
                scale: f.proxy_scale,
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
    let mean_area_scale =
        kept.iter().map(|k| k.scale.0 * k.scale.1).sum::<f64>() / kept.len() as f64;
    let proxy_cap_px = ((opts.max_canvas_px as f64 / mean_area_scale) as usize).max(1);
    let natural_opts = CanvasOptions {
        projection: ProjectionMode::Auto,
        max_pixels: proxy_cap_px,
        ..Default::default()
    };
    reject_degenerate_canvas(&cameras, &natural_opts, &alignment.strategy_report, opts)?;
    let canvas = preview_canvas(&cameras, &natural_opts)?;
    let scales: Vec<(f64, f64)> = kept.iter().map(|k| k.scale).collect();
    let full_estimate = rotation_full_canvas_estimate(&cameras, &scales, opts.max_canvas_px)?;

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
    Ok((image, full_estimate, solve_s, t5.elapsed().as_secs_f64()))
}

/// The natural proxy canvas shrunk to the preview long edge.
fn preview_canvas(cameras: &[Camera], natural: &CanvasOptions) -> Result<CanvasSpec, StitchError> {
    let to_err = |e: crate::error::PanoError| StitchError::Composite(e.to_string());
    let natural_canvas = auto_canvas(cameras, natural).map_err(to_err)?;
    let cap = long_edge_pixel_cap(natural_canvas.width, natural_canvas.height);
    if cap >= natural_canvas.width as usize * natural_canvas.height as usize {
        return Ok(natural_canvas);
    }
    let canvas = auto_canvas(
        cameras,
        &CanvasOptions {
            max_pixels: cap,
            ..natural.clone()
        },
    )
    .map_err(to_err)?;
    Ok(canvas)
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

    #[test]
    fn tile_estimate_scales_by_the_anchor_frame_per_axis() {
        assert_eq!(
            tile_full_canvas_estimate((2_000, 700), (4.0, 3.0), usize::MAX),
            (8_000, 2_100)
        );
    }

    #[test]
    fn tile_estimate_shrinks_uniformly_to_the_cap() {
        let (w, h) = tile_full_canvas_estimate((2_000, 700), (4.0, 4.0), 5_600_000);
        assert_eq!((w, h), (4_000, 1_400));
    }

    fn proxy_row() -> Vec<Camera> {
        (0..3)
            .map(|i| {
                Camera::new(
                    [0.0, (i as f64 * 30.0).to_radians(), 0.0],
                    400.0,
                    0.0,
                    0.0,
                    480,
                    320,
                )
            })
            .collect()
    }

    fn rotation_width(scales: &[(f64, f64)]) -> u32 {
        rotation_full_canvas_estimate(&proxy_row(), scales, usize::MAX)
            .expect("estimate")
            .0
    }

    #[test]
    fn rotation_estimate_follows_the_highest_resolution_frame() {
        let all_high = rotation_width(&[(4.0, 4.0); 3]);
        let all_low = rotation_width(&[(2.0, 2.0); 3]);
        let mixed = rotation_width(&[(4.0, 4.0), (2.0, 2.0), (2.0, 2.0)]);
        assert!((all_high as f64 / all_low as f64 - 2.0).abs() < 0.02);
        // Averaging the frames' area ratios would land near 2.83×, not 4×.
        assert!(
            mixed as f64 >= 0.98 * all_high as f64,
            "{mixed} vs {all_high}"
        );
    }

    #[test]
    fn rotation_estimate_holds_to_the_cap() {
        let cap = 2_000_000;
        let (w, h) =
            rotation_full_canvas_estimate(&proxy_row(), &[(4.0, 4.0); 3], cap).expect("estimate");
        assert!(w as usize * h as usize <= cap);
        assert!(w as usize * h as usize >= cap * 9 / 10);
    }
}
