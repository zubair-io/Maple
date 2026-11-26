//! Window-streamed multi-band blending for the tiled rotation compositors
//! (#4524, #6057).
//!
//! The canvas is still produced `tile_rows` output rows at a time, but each
//! strip is blended as a row of *windows*: `tile_cols`-wide tiles widened by
//! [`halo_rows`] on every side and snapped to the coarsest pyramid level's
//! sample grid. Every frame touching a window is warped into that window
//! only, its Laplacian pyramid folded into a window-sized [`BandAccumulator`]
//! and dropped; the collapsed window then contributes only its tile. The
//! halo covers the pyramid's full reach, so the tiles are bit-identical to a
//! whole-canvas [`crate::blend::blend_multiband`] and the output depends on
//! neither `tile_rows` nor `tile_cols`. Peak blend memory is one window's
//! accumulator, one frame's warped window and the strip being assembled —
//! never anything canvas-wide but that one strip of output rows.
//!
//! [`survey`] runs before the blend because the band count is a property of
//! the whole canvas (`log2` of the narrowest pairwise overlap), so it must be
//! known before the first window is accumulated.

use std::ops::Range;

use rayon::prelude::*;

use crate::blend::BandAccumulator;
use crate::camera::Camera;
use crate::canvas::CanvasSpec;
use crate::composite::{CanvasSink, CompositePhase, CropAxes, CropRect, LargestRect, OwnerRuns};
use crate::error::PanoError;
use crate::ingest::{PlanarImage, ValidityMask};
use crate::local_align::{LocalCorrection, MAX_CORRECTION_PX};
use crate::warp::frame_output_bbox;

/// Canvas columns per blend window before its halo (#6057). The output does
/// not depend on it; it bounds the accumulator and each frame's warped
/// window independently of the canvas width.
pub(super) const TILE_COLS: u32 = 4096;

/// Rows (and columns) of context a tile needs on each side so its pixels
/// match a whole-canvas blend exactly. The measured reach of the
/// `levels`-band pyramid (taps + bilinear expands + collapse) is just under
/// `1.5 · 2^levels` pixels; `2 · 2^levels` leaves margin.
pub(super) fn halo_rows(levels: usize) -> usize {
    if levels <= 1 {
        0
    } else {
        2 << levels
    }
}

/// Canvas-wide geometry the blend needs before it starts: the band-count
/// input and, per frame, the canvas rows its footprint spans.
pub(super) struct Survey {
    /// Voronoi owner per canvas pixel; kept only when the caller weights by
    /// hard ownership.
    pub(super) owner: Option<OwnerRuns>,
    /// Auto Crop's rectangle (#5573), when one was asked for and exists.
    pub(super) crop_rect: Option<CropRect>,
    pub(super) footprint_rows: Vec<Option<(u32, u32)>>,
    pub(super) min_overlap_px: usize,
}

impl Survey {
    pub(super) fn footprint_touches(&self, fi: usize, y0: u32, y1: u32) -> bool {
        self.footprint_rows[fi].is_some_and(|(a, b)| a < y1 && y0 < b)
    }
}

/// Rows per survey pass: the unit of progress and of the parallel sweep.
const SURVEY_ROWS: u32 = 64;

/// The blend's seam weight of frame `fi` at output pixel `(x, y)`.
pub(super) type CropWeight<'a> = dyn Fn(usize, usize, usize) -> f32 + Sync + 'a;

/// Where a frame can land on the output canvas: its conservative output
/// bbox, the same one its warp visits (#6057).
struct Footprint {
    rows: Range<u32>,
    x_spans: Vec<(u32, u32)>,
}

impl Footprint {
    fn covers(&self, x: u32) -> bool {
        self.x_spans.iter().any(|&(a, b)| a <= x && x < b)
    }
}

/// One frame's projection of one canvas pixel: its Voronoi depth (distance
/// to the nearest frame edge), or `None` when it lands outside the frame.
fn depth_at(cam: &Camera, la: Option<&LocalCorrection>, dir: crate::math::Vec3) -> Option<f32> {
    let (mut sx, mut sy) = cam.world_dir_to_pixel(dir)?;
    if let Some(la) = la {
        (sx, sy) = la.sample_point(sx, sy);
    }
    let (w, h) = (cam.width as f64, cam.height as f64);
    if sx < 0.0 || sx > w || sy < 0.0 || sy > h {
        return None;
    }
    Some(sx.min(w - sx).min(sy).min(h - sy).max(0.0) as f32)
}

/// What one canvas row contributes to the survey.
struct SurveyRow {
    owner: Vec<u16>,
    /// Frames with at least one covered pixel in the row.
    covering: Vec<usize>,
    /// `(a, b, pixels)` for every pair `a < b` both covering some pixel.
    overlaps: Vec<(usize, usize, usize)>,
    crop: Option<Vec<bool>>,
}

/// Owner, coverage and pairwise overlap of canvas row `y`. Each pixel's
/// direction is computed once and projected only into the frames whose
/// footprint holds it; the deepest projection wins, ties to the lower index.
fn survey_row(
    cameras: &[Camera],
    local_corrections: &[Option<LocalCorrection>],
    footprints: &[Option<Footprint>],
    canvas: &CanvasSpec,
    y: u32,
    crop_weight: Option<&CropWeight<'_>>,
) -> SurveyRow {
    let k = cameras.len();
    let cw = canvas.width as usize;
    let active: Vec<usize> = footprints
        .iter()
        .enumerate()
        .filter(|(_, f)| f.as_ref().is_some_and(|f| f.rows.contains(&y)))
        .map(|(fi, _)| fi)
        .collect();
    let mut owner = vec![u16::MAX; cw];
    let mut crop = crop_weight.map(|_| vec![false; cw]);
    let mut pair_px = vec![0usize; k * k];
    let mut covers = vec![false; k];
    let mut here: Vec<(usize, f32)> = Vec::with_capacity(active.len());
    for x in 0..cw {
        here.clear();
        let candidates = active
            .iter()
            .copied()
            .filter(|&fi| footprints[fi].as_ref().is_some_and(|f| f.covers(x as u32)));
        let mut dir = None;
        for fi in candidates {
            let d = *dir.get_or_insert_with(|| {
                canvas.output_pixel_to_dir(x as f64 + 0.5, y as f64 + 0.5)
            });
            let Some(d) = d else { break };
            let la = local_corrections.get(fi).and_then(Option::as_ref);
            if let Some(depth) = depth_at(&cameras[fi], la, d) {
                here.push((fi, depth));
            }
        }
        let best = here
            .iter()
            .fold(None, |best: Option<(usize, f32)>, &(fi, d)| match best {
                Some((_, bd)) if d <= bd => best,
                _ => Some((fi, d)),
            });
        if let Some((fi, _)) = best {
            owner[x] = fi as u16;
        }
        for (i, &(a, _)) in here.iter().enumerate() {
            covers[a] = true;
            for &(b, _) in &here[i + 1..] {
                pair_px[a * k + b] += 1;
            }
        }
        if let (Some(crop), Some(weight)) = (crop.as_mut(), crop_weight) {
            crop[x] = here
                .iter()
                .any(|&(fi, _)| weight(fi, x, y as usize) > 0.0);
        }
    }
    let overlaps = pair_px
        .iter()
        .enumerate()
        .filter(|(_, &n)| n > 0)
        .map(|(i, &n)| (i / k, i % k, n))
        .collect();
    SurveyRow {
        owner,
        covering: (0..k).filter(|&fi| covers[fi]).collect(),
        overlaps,
        crop,
    }
}

/// `crop_weight`, when given, asks for Auto Crop's rectangle: a pixel
/// counts as covered when some frame both covers it and carries positive
/// weight there, the same test the blend's validity makes.
pub(super) fn survey(
    cameras: &[Camera],
    local_corrections: &[Option<LocalCorrection>],
    canvas: &CanvasSpec,
    keep_owner: bool,
    crop_weight: Option<&CropWeight<'_>>,
    sink: &mut dyn CanvasSink,
) -> Result<Survey, PanoError> {
    let k = cameras.len();
    let local_corrections: Vec<Option<LocalCorrection>> = if local_corrections.is_empty() {
        vec![None; k]
    } else {
        local_corrections.to_vec()
    };
    let footprints: Vec<Option<Footprint>> = cameras
        .iter()
        .zip(&local_corrections)
        .map(|(cam, la)| {
            let margin = if la.is_some() { 4.0 + MAX_CORRECTION_PX } else { 4.0 };
            frame_output_bbox(cam, canvas, margin).map(|bbox| Footprint {
                rows: bbox.y0..bbox.y1,
                x_spans: bbox.x_spans,
            })
        })
        .collect();
    let pass_rows = SURVEY_ROWS.min(canvas.height).max(1);
    let mut owner = keep_owner.then(|| OwnerRuns::new(canvas.width));
    let mut footprint_rows: Vec<Option<(u32, u32)>> = vec![None; k];
    let mut overlap_px = vec![0usize; k * k];
    let mut overlap_rows = vec![0usize; k * k];
    let mut crop =
        crop_weight.map(|_| LargestRect::new(canvas.width, CropAxes::for_canvas(canvas)));

    for pass_y0 in (0..canvas.height).step_by(pass_rows as usize) {
        sink.advance(
            CompositePhase::Survey,
            pass_y0 as f32 / canvas.height as f32,
        )?;
        let pass_y1 = (pass_y0 + pass_rows).min(canvas.height);
        let rows: Vec<SurveyRow> = (pass_y0..pass_y1)
            .into_par_iter()
            .map(|y| survey_row(cameras, &local_corrections, &footprints, canvas, y, crop_weight))
            .collect();
        for (y, row) in (pass_y0..).zip(rows) {
            for &fi in &row.covering {
                let (a, b) = footprint_rows[fi].unwrap_or((y, y + 1));
                footprint_rows[fi] = Some((a.min(y), b.max(y + 1)));
            }
            for (a, b, n) in row.overlaps {
                overlap_px[a * k + b] += n;
                overlap_rows[a * k + b] += 1;
            }
            if let Some(owner) = owner.as_mut() {
                owner.push_row(&row.owner);
            }
            if let (Some(crop), Some(covered)) = (crop.as_mut(), row.crop) {
                crop.push_rows(&covered);
            }
        }
    }

    sink.advance(CompositePhase::Survey, 1.0)?;
    Ok(Survey {
        owner,
        crop_rect: crop.and_then(LargestRect::finish),
        footprint_rows,
        min_overlap_px: min_overlap_width(&overlap_px, &overlap_rows),
    })
}

/// The narrowest pairwise overlap, as mean overlapping pixels per shared
/// row, or 0 when no two frames overlap.
fn min_overlap_width(overlap_px: &[usize], overlap_rows: &[usize]) -> usize {
    overlap_px
        .iter()
        .zip(overlap_rows)
        .filter(|(_, &rows)| rows > 0)
        .map(|(&px, &rows)| px / rows)
        .min()
        .unwrap_or(0)
}

/// Blend the whole canvas strip by strip, each strip window by window,
/// handing each finished strip to `sink` as soon as its last window is
/// collapsed (#5452, #6057).
///
/// - `touches(fi, rows, cols)`: may frame `fi` carry weight in that canvas
///   rectangle? `false` skips its decode for that window.
/// - `weight(fi, x, y)`: seam weight of frame `fi` at canvas pixel `(x, y)`.
/// - `warp(fi, rows, cols)`: the frame warped into that canvas rectangle,
///   or `None` when it puts no sample there.
#[allow(clippy::too_many_arguments)]
pub(super) fn blend_strips(
    (width, height): (u32, u32),
    frame_count: usize,
    (tile_rows, tile_cols): (u32, u32),
    levels: usize,
    touches: impl Fn(usize, Range<u32>, Range<u32>) -> bool,
    weight: impl Fn(usize, usize, usize) -> f32 + Sync,
    mut warp: impl FnMut(usize, Range<u32>, Range<u32>) -> Result<Option<PlanarImage>, PanoError>,
    sink: &mut dyn CanvasSink,
) -> Result<(), PanoError> {
    let (cw, ch) = (width as usize, height as usize);
    let tile_rows = tile_rows.max(1).min(height) as usize;
    let tile_cols = tile_cols.max(1).min(width) as usize;
    let halo = halo_rows(levels);
    let grid = 1usize << (levels.max(1) - 1);
    let tiles_per_strip = cw.div_ceil(tile_cols);
    sink.begin(width, height)?;

    for ty0 in (0..ch).step_by(tile_rows) {
        let ty1 = (ty0 + tile_rows).min(ch);
        let wy0 = ty0.saturating_sub(halo) / grid * grid;
        let wy1 = (ty1 + halo).min(ch);
        let strip_n = (ty1 - ty0) * cw;
        let mut planes = [vec![0.0_f32; strip_n], vec![0.0; strip_n], vec![0.0; strip_n]];
        let mut covered = vec![false; strip_n];

        for (ti, tx0) in (0..cw).step_by(tile_cols).enumerate() {
            let tx1 = (tx0 + tile_cols).min(cw);
            let wx0 = tx0.saturating_sub(halo) / grid * grid;
            let wx1 = (tx1 + halo).min(cw);
            let ww = wx1 - wx0;
            let (rows, cols) = (wy0 as u32..wy1 as u32, wx0 as u32..wx1 as u32);
            let mut acc: Option<BandAccumulator> = None;
            let mut tile_covered = vec![false; (ty1 - ty0) * (tx1 - tx0)];
            let interior = |i: usize| {
                let (x, y) = (i % ww, i / ww);
                (y >= ty0 - wy0 && y < ty1 - wy0 && x >= tx0 - wx0 && x < tx1 - wx0)
                    .then(|| (y - (ty0 - wy0)) * (tx1 - tx0) + x - (tx0 - wx0))
            };

            for fi in 0..frame_count {
                let step = (ti * frame_count + fi) as f32 / (tiles_per_strip * frame_count) as f32;
                let done = ty0 as f32 + (ty1 - ty0) as f32 * step;
                sink.advance(CompositePhase::Strips, done / ch as f32)?;
                if !touches(fi, rows.clone(), cols.clone()) {
                    continue;
                }
                let Some(window) = warp(fi, rows.clone(), cols.clone())? else {
                    continue;
                };
                let wt = window_weights(&window, (wx0, wy0), |x, y| weight(fi, x, y));
                let Some((bx0, bx1)) = weighted_columns(&wt, ww) else {
                    continue;
                };
                for (i, &w) in wt.iter().enumerate() {
                    if let (true, Some(t)) = (w > 0.0, interior(i)) {
                        tile_covered[t] = true;
                    }
                }
                // A frame's pyramid only reaches `halo` past its weighted
                // columns, and the band's own clipped edge corrupts at most
                // `halo` inward — two halos keep the two apart.
                let band = (bx0.saturating_sub(2 * halo) / grid * grid)..(bx1 + 2 * halo).min(ww);
                acc.get_or_insert_with(|| BandAccumulator::new(ww, wy1 - wy0, levels))
                    .add(&window, &wt, band);
            }

            let Some(acc) = acc else {
                continue;
            };
            let collapsed = acc.collapse();
            for y in ty0..ty1 {
                let src = (y - wy0) * ww + (tx0 - wx0);
                let dst = (y - ty0) * cw + tx0;
                let tile = (y - ty0) * (tx1 - tx0);
                for (plane, window) in planes.iter_mut().zip(&collapsed) {
                    plane[dst..dst + tx1 - tx0].copy_from_slice(&window[src..src + tx1 - tx0]);
                }
                covered[dst..dst + tx1 - tx0].copy_from_slice(&tile_covered[tile..tile + tx1 - tx0]);
            }
        }

        let [r, g, b] = planes.map(|mut plane| {
            plane
                .iter_mut()
                .zip(&covered)
                .filter(|(_, &c)| !c)
                .for_each(|(v, _)| *v = 0.0);
            plane
        });
        let rows = (ty1 - ty0) as u32;
        let mut validity = ValidityMask::new_filled(width, rows, false);
        for (i, _) in covered.iter().enumerate().filter(|(_, &c)| c) {
            validity.set((i % cw) as u32, (i / cw) as u32, true);
        }
        sink.rows(&PlanarImage::from_planes(width, rows, r, g, b, validity))?;
        sink.advance(CompositePhase::Strips, ty1 as f32 / ch as f32)?;
    }
    Ok(())
}

/// Seam weight × validity over one warped window whose pixel `(0, 0)` is
/// canvas `(wx0, wy0)`, row-major.
fn window_weights(
    window: &PlanarImage,
    (wx0, wy0): (usize, usize),
    weight: impl Fn(usize, usize) -> f32 + Sync,
) -> Vec<f32> {
    let ww = window.width() as usize;
    let mut wt = vec![0.0_f32; window.r.len()];
    wt.par_chunks_mut(ww).enumerate().for_each(|(y, row)| {
        for (x, slot) in row.iter_mut().enumerate() {
            if window.validity.get(x as u32, y as u32) {
                *slot = weight(wx0 + x, wy0 + y).max(0.0);
            }
        }
    });
    wt
}

/// Column extent `[x0, x1)` holding any positive weight, or `None`.
fn weighted_columns(wt: &[f32], cw: usize) -> Option<(usize, usize)> {
    wt.chunks_exact(cw)
        .filter_map(|row| {
            let first = row.iter().position(|&w| w > 0.0)?;
            let last = row.iter().rposition(|&w| w > 0.0)?;
            Some((first, last + 1))
        })
        .reduce(|a, b| (a.0.min(b.0), a.1.max(b.1)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blend::blend_multiband;
    use crate::composite::CanvasCollector;
    use crate::prng::SplitMix64;

    const W: usize = 400;
    const H: usize = 300;

    /// Three frames with ragged, partly overlapping column footprints in a
    /// canvas wide enough that low band counts crop each frame's pyramid to
    /// its own column band.
    fn scene() -> (Vec<PlanarImage>, Vec<Vec<f32>>) {
        let mut rng = SplitMix64::new(4524);
        [(0usize, 150usize), (120, 280), (250, 400)]
            .into_iter()
            .map(|(x0, x1)| {
                let mut validity = ValidityMask::new_filled(W as u32, H as u32, false);
                let mut planes = [vec![0.0_f32; W * H], vec![0.0; W * H], vec![0.0; W * H]];
                let mut weight = vec![0.0_f32; W * H];
                for y in 0..H {
                    let lo = x0 + (y * 7) % 11;
                    let hi = x1.saturating_sub((y * 5) % 13).max(lo + 1);
                    for x in lo..hi {
                        let i = y * W + x;
                        validity.set(x as u32, y as u32, true);
                        let v = rng.next_range(0.0, 4.0) as f32;
                        planes[0][i] = v;
                        planes[1][i] = 0.5 * v;
                        planes[2][i] = 0.25 * v + 0.01;
                        weight[i] = if (x - lo) < (hi - lo) / 2 { 1.0 } else { 0.5 };
                    }
                }
                let [r, g, b] = planes;
                (
                    PlanarImage::from_planes(W as u32, H as u32, r, g, b, validity),
                    weight,
                )
            })
            .unzip()
    }

    fn rect(layer: &PlanarImage, rows: Range<u32>, cols: Range<u32>) -> PlanarImage {
        let (w, h) = (cols.end - cols.start, rows.end - rows.start);
        let mut validity = ValidityMask::new_filled(w, h, false);
        let mut planes = [Vec::new(), Vec::new(), Vec::new()];
        for y in rows.clone() {
            for x in cols.clone() {
                let i = y as usize * W + x as usize;
                validity.set(x - cols.start, y - rows.start, layer.validity.get(x, y));
                planes[0].push(layer.r[i]);
                planes[1].push(layer.g[i]);
                planes[2].push(layer.b[i]);
            }
        }
        let [r, g, b] = planes;
        PlanarImage::from_planes(w, h, r, g, b, validity)
    }

    #[test]
    fn strips_reproduce_whole_canvas_blend_at_any_height() {
        let (layers, weights) = scene();
        for levels in [1, 3, 5, 7] {
            let whole = blend_multiband(&layers, &weights, levels);
            for (tile_rows, tile_cols) in [(23, 400), (96, 400), (23, 37), (96, 150), (300, 64)] {
                let mut collector = CanvasCollector::default();
                blend_strips(
                    (W as u32, H as u32),
                    layers.len(),
                    (tile_rows, tile_cols),
                    levels,
                    |_, _, _| true,
                    |fi, x, y| weights[fi][y * W + x],
                    |fi, r, c| Ok(Some(rect(&layers[fi], r, c))),
                    &mut collector,
                )
                .expect("blend");
                let strips = collector.into_image();
                let ctx = format!("levels={levels} tile={tile_rows}x{tile_cols}");
                for i in 0..W * H {
                    let (x, y) = ((i % W) as u32, (i / W) as u32);
                    assert_eq!(strips.validity.get(x, y), whole.validity.get(x, y), "{ctx}");
                    assert_eq!(strips.r[i], whole.r[i], "{ctx} r at ({x},{y})");
                    assert_eq!(strips.g[i], whole.g[i], "{ctx} g at ({x},{y})");
                    assert_eq!(strips.b[i], whole.b[i], "{ctx} b at ({x},{y})");
                }
            }
        }
    }
}
