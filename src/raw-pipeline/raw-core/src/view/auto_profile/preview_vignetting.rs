//! How much of the bundled lens vignetting correction the embedded preview
//! carries (#5791).
//!
//! The Auto fit pairs a develop against the embedded preview pixel for pixel,
//! so both must share one illumination field. A bundled Lensfun calibration
//! is a full flat-field gain. The preview carries none of it (a converter's
//! DNG preview, a body with the correction off), part of it (a body's own
//! milder table) or all of it, and the file does not reliably say which. A
//! gain the preview lacks reads as scene tone, and the fitted tail then
//! darkens the whole frame to cancel the bright corners.
//!
//! So the share is measured. With `Y` the scene luminance a sensor cell
//! recorded and `g` the bundled gain there, a preview carrying share `s` is
//! `F(ln Y + ln(1 + s·(g − 1)))` for one tone response `F`: the develop
//! applies a share as that linear blend of the gain, so the share is weighed
//! the way it will be applied. The right `s` is the one for which preview
//! luma is most nearly a function of that sum: cells of equal scene
//! luminance at different radii then agree. `F` is the mean per quantile
//! bin, so no tone model is assumed.
//!
//! `Y` is read from linearized sensor samples, so the measurement needs no
//! develop and the fit develops once, at the measured scale. It shares
//! [`sample_display_pairs`]'s geometry with the fit itself.

use rayon::prelude::*;

use super::pairs::sample_display_pairs;
use super::preview::ExtractedPreview;
use crate::image::{CfaPattern, Image, RawImage};
use crate::lens_profile::{self, model::Vignette};
use crate::linearize;
use crate::pipeline::pano::opcodes::ActiveAreaRect;
use crate::xmp::AdjustmentModel;

/// Cells along the develop frame's long edge.
const GRID_LONG_EDGE: u32 = 192;
/// Side of the sensor block read per cell: even, and whole Bayer (2) and
/// X-Trans (6) periods, so every block mixes the CFA colours alike.
const BLOCK: u32 = 12;
/// A sensor sample at or above this is clipped: not the scene's luminance.
const CLIPPED: f32 = 0.98;
/// `ln Y` range the pair carrier encodes into `[0, 1]`.
const LN_LUMA: (f32, f32) = (-14.0, 3.0);
/// Shares are weighed in steps of `1 / STEPS`.
const STEPS: usize = 20;
/// Quantile bins of the tone response.
const BINS: usize = 64;
/// Fewer usable cells than this cannot weigh a share.
const MIN_CELLS: usize = 4096;
/// A log-gain spread below this (about 5%) moves no fit and is not weighed.
const MIN_LN_GAIN_SPREAD: f32 = 0.05;
/// The full correction stays the reading unless another share explains the
/// preview this much better (relative scatter).
const DECISIVE: f64 = 0.01;

/// What a preview says about the bundled gain.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Reading {
    /// The share of the gain (`0..=1`, in steps of 0.05) that explains the
    /// preview best.
    pub share: f32,
    /// Mean squared deviation of preview luma from the tone response at
    /// `share`, and at the full correction.
    pub scatter: f64,
    pub scatter_at_full: f64,
}

impl Reading {
    /// Whether `share` explains the preview decisively better than the full
    /// correction does. Until it does, the full correction stands.
    pub fn is_decisive(&self) -> bool {
        self.scatter_at_full > self.scatter * (1.0 + DECISIVE)
    }

    /// The lens vignetting scale (the model's `0..=100`, in steps of 5) this
    /// reading stands for, exact so it can equal a slider value.
    pub fn scale(&self) -> f32 {
        let authored = AdjustmentModel::default().lens_correction_vignetting;
        if self.is_decisive() {
            authored * (self.share * STEPS as f32).round() / STEPS as f32
        } else {
            authored
        }
    }
}

/// The lens vignetting scale (the model's `0..=100`) the RAW's embedded
/// preview carries.
///
/// The authored default when nothing external is weighed (embedded
/// `OpcodeList3` corrections are the vendor's own and in the vendor's
/// preview; no bundled vignetting calibration matches) or the reading is
/// not decisive.
pub fn scale(raw: &RawImage, preview: &ExtractedPreview) -> f32 {
    read(raw, preview).map_or_else(
        || AdjustmentModel::default().lens_correction_vignetting,
        |reading| reading.scale(),
    )
}

/// Weigh every share of the bundled gain against the preview. `None` when
/// no bundled vignetting calibration applies to the RAW, or the frame has
/// too few usable cells or too flat a gain to weigh.
pub fn read(raw: &RawImage, preview: &ExtractedPreview) -> Option<Reading> {
    let vignette = lens_profile::resolve_auto(raw)
        .ok()??
        .calibration
        .vignette?;
    let field = Field::read(raw, vignette)?;
    let cells = field.pair(preview, raw);
    if cells.len() < MIN_CELLS {
        return None;
    }
    let (lo, hi) = cells.iter().fold((f32::MAX, f32::MIN), |(lo, hi), c| {
        (lo.min(c.gain), hi.max(c.gain))
    });
    if hi.ln() - lo.ln() < MIN_LN_GAIN_SPREAD {
        return None;
    }
    let mut order: Vec<u32> = (0..cells.len() as u32).collect();
    let mut keys = vec![0.0f32; cells.len()];
    let scatter: Vec<f64> = (0..=STEPS)
        .map(|step| scatter(&cells, step as f32 / STEPS as f32, &mut order, &mut keys))
        .collect();
    let best = (0..=STEPS).min_by(|a, b| scatter[*a].total_cmp(&scatter[*b]))?;
    Some(Reading {
        share: best as f32 / STEPS as f32,
        scatter: scatter[best],
        scatter_at_full: scatter[STEPS],
    })
}

/// One sensor cell paired with the preview pixel over it.
struct Cell {
    ln_luma: f32,
    gain: f32,
    preview_luma: f32,
}

/// Mean squared deviation of preview luma from its per-bin mean, the cells
/// ordered by `ln Y + ln(1 + share·(g − 1))`.
fn scatter(cells: &[Cell], share: f32, order: &mut [u32], keys: &mut [f32]) -> f64 {
    for (key, cell) in keys.iter_mut().zip(cells) {
        *key = cell.ln_luma + (1.0 + share * (cell.gain - 1.0)).ln();
    }
    order.sort_unstable_by(|a, b| {
        keys[*a as usize]
            .total_cmp(&keys[*b as usize])
            .then(a.cmp(b))
    });
    let n = order.len();
    let mut total = 0.0f64;
    for bin in 0..BINS {
        let members = &order[bin * n / BINS..(bin + 1) * n / BINS];
        let luma = |i: &u32| f64::from(cells[*i as usize].preview_luma);
        let mean = members.iter().map(luma).sum::<f64>() / members.len() as f64;
        total += members
            .iter()
            .map(|i| (luma(i) - mean).powi(2))
            .sum::<f64>();
    }
    total / n as f64
}

/// Scene log-luminance and bundled log-gain on a coarse grid over the
/// develop frame, sensor-oriented, encoded as the three-channel `[0, 1]`
/// buffer [`sample_display_pairs`] takes: `[ln Y, ln g, valid]`.
struct Field {
    width: usize,
    height: usize,
    carrier: Vec<f32>,
    ln_gain: (f32, f32),
}

impl Field {
    fn read(raw: &RawImage, vignette: Vignette) -> Option<Self> {
        let (left, top, frame_w, frame_h) = raw
            .crop_rect
            .map_or((0, 0, raw.width, raw.height), |c| (c.x, c.y, c.w, c.h));
        let step = frame_w.max(frame_h).div_ceil(GRID_LONG_EDGE).max(BLOCK);
        let block = if step >= 2 * BLOCK { 2 * BLOCK } else { BLOCK };
        let (width, height) = ((frame_w / step) as usize, (frame_h / step) as usize);
        if width * height < MIN_CELLS {
            return None;
        }
        let area = raw
            .lens_metadata
            .active_area
            .unwrap_or(ActiveAreaRect::full(raw.width, raw.height));
        // (ln Y, ln g) per cell; `None` where the block is clipped, dark or
        // outside the calibrated area.
        let cells: Vec<Option<(f32, f32)>> = (0..width * height)
            .into_par_iter()
            .map(|index| {
                let offset = (step - block) / 2;
                let x = (left + (index % width) as u32 * step + offset) & !1;
                let y = (top + (index / width) as u32 * step + offset) & !1;
                if x + block > raw.width || y + block > raw.height {
                    return None;
                }
                let means = if raw.cfa == CfaPattern::LinearRgb {
                    rgb_block(&linearize::linearraw_region(raw, x, y, block, block).ok()?)
                } else {
                    mosaic_block(raw, x, y, block)
                }?;
                let luma = luminance(means, raw.as_shot_neutral)?;
                let centre = [
                    f64::from(x + block / 2) - f64::from(area.left),
                    f64::from(y + block / 2) - f64::from(area.top),
                ];
                let gain = vignette.gain(f64::from(area.width), f64::from(area.height), centre)?;
                (gain.is_finite() && gain > 0.0).then(|| (luma.ln(), gain.ln() as f32))
            })
            .collect();
        let ln_gain = cells
            .iter()
            .flatten()
            .fold((f32::MAX, f32::MIN), |(lo, hi), c| {
                (lo.min(c.1), hi.max(c.1))
            });
        if ln_gain.1 - ln_gain.0 < MIN_LN_GAIN_SPREAD {
            return None;
        }
        let carrier = cells
            .iter()
            .flat_map(|cell| match cell {
                Some((ln_luma, gain)) => [
                    (ln_luma - LN_LUMA.0) / (LN_LUMA.1 - LN_LUMA.0),
                    (gain - ln_gain.0) / (ln_gain.1 - ln_gain.0),
                    1.0,
                ],
                None => [0.0; 3],
            })
            .collect();
        Some(Self {
            width,
            height,
            carrier,
            ln_gain,
        })
    }

    /// Pair every cell with the preview pixel over it, through the fit's own
    /// orientation, aspect crop and border.
    fn pair(&self, preview: &ExtractedPreview, raw: &RawImage) -> Vec<Cell> {
        let long = self.width.max(self.height) as f64;
        let (w, h) = (preview.image.width(), preview.image.height());
        let ratio = (long / f64::from(w.max(h))).min(1.0);
        let small = preview.image.resize_exact(
            ((f64::from(w) * ratio).round() as u32).max(1),
            ((f64::from(h) * ratio).round() as u32).max(1),
            image::imageops::FilterType::Triangle,
        );
        sample_display_pairs(
            &self.carrier,
            self.width,
            self.height,
            small,
            preview.color_space,
            raw.orientation,
        )
        .into_iter()
        .filter_map(|pair| {
            let [r, g, b] = pair.jpeg;
            let preview_luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            // A footprint touching an unusable cell, or a preview pixel at
            // either rail, says nothing about the tone response.
            (pair.maple[2] > 0.999 && preview_luma > 0.02 && preview_luma < 0.98).then(|| Cell {
                ln_luma: LN_LUMA.0 + pair.maple[0] * (LN_LUMA.1 - LN_LUMA.0),
                gain: (self.ln_gain.0 + pair.maple[1] * (self.ln_gain.1 - self.ln_gain.0)).exp(),
                preview_luma,
            })
        })
        .collect()
    }
}

/// Per-colour means of a mosaic block; `None` when any sample is clipped.
fn mosaic_block(raw: &RawImage, x: u32, y: u32, block: u32) -> Option<[f32; 3]> {
    let samples = linearize::sensor_linearize_region(raw, x, y, block, block);
    let mut sum = [0.0f32; 3];
    let mut count = [0u32; 3];
    for (index, pixel) in samples.pixels.iter().enumerate() {
        let (dx, dy) = (index as u32 % block, index as u32 / block);
        let colour = raw.cfa.color_at(x + dx, y + dy) as usize;
        if pixel[colour] >= CLIPPED {
            return None;
        }
        sum[colour] += pixel[colour];
        count[colour] += 1;
    }
    means(sum, count)
}

/// Per-channel means of a demosaiced block; `None` when any sample is clipped.
fn rgb_block(block: &Image) -> Option<[f32; 3]> {
    let mut sum = [0.0f32; 3];
    for pixel in &block.pixels {
        if pixel.iter().any(|v| *v >= CLIPPED) {
            return None;
        }
        for (total, value) in sum.iter_mut().zip(pixel) {
            *total += value;
        }
    }
    means(sum, [block.pixels.len() as u32; 3])
}

fn means(sum: [f32; 3], count: [u32; 3]) -> Option<[f32; 3]> {
    count
        .iter()
        .all(|n| *n > 0)
        .then(|| std::array::from_fn(|c| sum[c] / count[c] as f32))
}

/// White-balanced luminance of camera-RGB means, inside the carrier's range.
fn luminance(rgb: [f32; 3], neutral: [f32; 3]) -> Option<f32> {
    if neutral.iter().any(|n| !n.is_finite() || *n <= 0.0) {
        return None;
    }
    let luma = 0.25 * rgb[0] / neutral[0] + 0.5 * rgb[1] / neutral[1] + 0.25 * rgb[2] / neutral[2];
    (luma.is_finite() && luma > LN_LUMA.0.exp() && luma < LN_LUMA.1.exp()).then_some(luma)
}

#[cfg(test)]
#[path = "preview_vignetting_tests.rs"]
pub(crate) mod tests;
