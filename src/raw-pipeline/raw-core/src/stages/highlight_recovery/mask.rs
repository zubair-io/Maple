//! Frozen clipping masks shared by full and tiled highlight recovery.
use super::{channels_at_or_above, lowest_channels, RIPPLE_RADIUS};
use crate::{image::Image, linearize::sensor_gains::SensorGains};

pub(super) fn any_clipped(
    img: &Image,
    thresholds: [f32; 3],
    calibration: Option<SensorGains<'_>>,
) -> bool {
    match calibration {
        None => img
            .pixels
            .iter()
            .any(|p| channels_at_or_above(p, thresholds) != 0),
        Some(g) => img.pixels.iter().enumerate().any(|(i, p)| {
            let limits = g.scale(thresholds, i as u32 % img.width, i as u32 / img.width);
            channels_at_or_above(p, limits) != 0
        }),
    }
}

/// Hard clips plus a lowest-channel demosaic ripple next to a hard clip of
/// that same channel. Only neighbors within the physical region participate.
pub(super) fn clip_mask_calibrated(
    img: &Image,
    thresholds: [f32; 3],
    floors: [f32; 3],
    region: (i32, i32, i32, i32),
    calibration: Option<SensorGains<'_>>,
) -> Vec<u8> {
    // Select once per frame. Keeping the constant-ceiling specialization free
    // of sensor coordinates lets the compiler vectorize the common scans.
    match calibration {
        None => clip_mask(img, thresholds, floors, region, |v, _| v),
        Some(g) => clip_mask(img, thresholds, floors, region, |v, i| {
            g.scale(v, i as u32 % img.width, i as u32 / img.width)
        }),
    }
}

fn clip_mask(
    img: &Image,
    thresholds: [f32; 3],
    floors: [f32; 3],
    (left, top, right, bottom): (i32, i32, i32, i32),
    levels: impl Fn([f32; 3], usize) -> [f32; 3],
) -> Vec<u8> {
    let w = img.width as i32;
    let hard: Vec<u8> = img
        .pixels
        .iter()
        .enumerate()
        .map(|(i, p)| channels_at_or_above(p, levels(thresholds, i)))
        .collect();
    let hard = hard.as_slice();
    let near_hard = |x: i32, y: i32| {
        let rows = (y - RIPPLE_RADIUS).max(top)..(y + RIPPLE_RADIUS + 1).min(bottom);
        let cols = (x - RIPPLE_RADIUS).max(left)..(x + RIPPLE_RADIUS + 1).min(right);
        rows.flat_map(|ny| cols.clone().map(move |nx| hard[(ny * w + nx) as usize]))
            .fold(0u8, |m, h| m | h)
    };
    img.pixels
        .iter()
        .zip(hard)
        .enumerate()
        .map(|(i, (p, &h))| {
            // Most pixels cannot acquire a ripple flag. Test that cheap
            // condition before comparing channel order or deriving x/y;
            // both are only needed for a possible new clipped channel.
            let above_floor = channels_at_or_above(p, levels(floors, i)) & !h;
            if above_floor == 0 {
                return h;
            }
            let band = above_floor & lowest_channels(p);
            if band == 0 {
                return h;
            }
            let (x, y) = (i as i32 % w, i as i32 / w);
            let inside = x >= left && x < right && y >= top && y < bottom;
            if !inside {
                h
            } else {
                h | (band & near_hard(x, y))
            }
        })
        .collect()
}
