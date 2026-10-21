//! Refills a CFA frame's masked margins from its active area before any
//! spatial stage reads them (#4657).
//!
//! Outside the active area sit optical-black columns (Canon) or zero padding
//! (Fujifilm), which demosaic and the wide spatial stages would otherwise read
//! as scene content beside the image border. The DNG SDK builds its
//! interpolation stage at ActiveArea dimensions; Maple keeps the frame and its
//! coordinates, and instead replaces each masked sample with the nearest
//! active sample of the same CFA phase.
//!
//! A DNG's ActiveArea tag is the file's own statement and is always honoured.
//! A rectangle a decoder derived from its camera tables is not always the
//! physical one (rawler reports Panasonic's SensorBorder, which still holds
//! image data), so its strips are only refilled when their content is masked:
//! almost every sample at or below black.

use crate::image::CfaPattern;

/// The active rectangle in frame pixels; `declared` when the file itself
/// states it (DNG ActiveArea) rather than a decoder's camera table.
#[derive(Clone, Copy, Debug)]
pub struct ActiveArea {
    pub left: usize,
    pub top: usize,
    pub width: usize,
    pub height: usize,
    pub declared: bool,
}

/// A masked strip sits within this share of the signal range above black,
/// and may hold this share of samples above it (hot optical-black photosites).
const MASKED_TOLERANCE_PERCENT: usize = 1;

/// Refills masked strips and returns the frame with the effective white
/// `infer_white` finds on it. Inference sees masked strips as zeros, below
/// black, so neither their original padding nor the cloned edge samples that
/// replace them can pose as a clipping plateau.
#[allow(clippy::too_many_arguments)]
pub fn refill_masked_margins(
    mut data: Vec<u16>,
    width: usize,
    height: usize,
    cfa: &CfaPattern,
    area: Option<ActiveArea>,
    black: &[u32; 4],
    declared_white: u32,
    infer_white: impl FnOnce(&[u16]) -> u32,
) -> (Vec<u16>, u32) {
    let period = cfa_period(cfa);
    let usable = area.filter(|a| {
        !matches!(cfa, CfaPattern::LinearRgb)
            && data.len() == width * height
            && a.left + a.width <= width
            && a.top + a.height <= height
            && a.width >= period
            && a.height >= period
    });
    let Some(area) = usable else {
        let white = infer_white(&data);
        return (data, white);
    };
    let (right, bottom) = (area.left + area.width, area.top + area.height);
    let black_max = black.iter().copied().max().unwrap_or(0);
    let threshold = black_max
        + declared_white.saturating_sub(black_max) * MASKED_TOLERANCE_PERCENT as u32 / 100;
    let masked = |rows: std::ops::Range<usize>, cols: std::ops::Range<usize>| {
        let samples = rows.len() * cols.len();
        if area.declared {
            return samples > 0;
        }
        let bright = rows
            .flat_map(|y| cols.clone().map(move |x| (x, y)))
            .filter(|&(x, y)| u32::from(data[y * width + x]) > threshold)
            .count();
        samples > 0 && bright * 100 <= samples * MASKED_TOLERANCE_PERCENT
    };
    let strip = |on: bool, range: std::ops::Range<usize>| if on { range } else { 0..0 };
    let columns: Vec<usize> = strip(masked(area.top..bottom, 0..area.left), 0..area.left)
        .chain(strip(masked(area.top..bottom, right..width), right..width))
        .collect();
    let rows: Vec<usize> = strip(masked(0..area.top, 0..width), 0..area.top)
        .chain(strip(masked(bottom..height, 0..width), bottom..height))
        .collect();

    for y in area.top..bottom {
        for &x in &columns {
            data[y * width + x] = 0;
        }
    }
    for &y in &rows {
        data[y * width..(y + 1) * width].fill(0);
    }
    let white = infer_white(&data);

    let into_active = |v: usize, lo: usize, hi: usize| nearest_active(v, lo, hi, period);
    for y in area.top..bottom {
        for &x in &columns {
            data[y * width + x] = data[y * width + into_active(x, area.left, right)];
        }
    }
    for &y in &rows {
        let source = into_active(y, area.top, bottom) * width;
        data.copy_within(source..source + width, y * width);
    }
    (data, white)
}

/// Rows and columns between repeats of the CFA pattern; 1 for LinearRgb.
pub(crate) fn cfa_period(cfa: &CfaPattern) -> usize {
    match cfa {
        CfaPattern::LinearRgb => 1,
        CfaPattern::XTrans(_) => 6,
        _ => 2,
    }
}

/// The nearest index in `lo..hi` of the same phase modulo `period` as `v`;
/// `hi - lo` must be at least `period`.
pub(crate) fn nearest_active(v: usize, lo: usize, hi: usize, period: usize) -> usize {
    if v < lo {
        v + period * (lo - v).div_ceil(period)
    } else if v >= hi {
        v - period * ((v - hi) / period + 1)
    } else {
        v
    }
}

#[cfg(test)]
#[path = "masked_margin_tests.rs"]
mod tests;
