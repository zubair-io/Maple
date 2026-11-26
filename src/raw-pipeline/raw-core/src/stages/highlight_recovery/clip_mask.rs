use super::{channels_in_sensor_space, lowest_channels, RIPPLE_RADIUS};
use crate::{image::Image, sensor_gain_maps::ClipGainContext};

pub(super) fn clip_mask_in_sensor_space(
    img: &Image,
    thresholds: [f32; 3],
    floors: [f32; 3],
    (left, top, right, bottom): (i32, i32, i32, i32),
    gains: Option<ClipGainContext<'_>>,
) -> Vec<u8> {
    let w = img.width as i32;
    let hard: Vec<u8> = img
        .pixels
        .iter()
        .enumerate()
        .map(|(i, p)| channels_in_sensor_space(p, thresholds, gains, i, img.width))
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
            let band =
                channels_in_sensor_space(p, floors, gains, i, img.width) & lowest_channels(p) & !h;
            let (x, y) = (i as i32 % w, i as i32 / w);
            let inside = x >= left && x < right && y >= top && y < bottom;
            if band == 0 || !inside {
                h
            } else {
                h | (band & near_hard(x, y))
            }
        })
        .collect()
}

/// [`clip_mask_in_sensor_space`] at pixel `i` alone, reading only its
/// ripple neighbourhood: the same bits, for callers that need the mask at a
/// sparse set of pixels.
pub(super) fn clip_mask_at(
    img: &Image,
    thresholds: [f32; 3],
    floors: [f32; 3],
    (left, top, right, bottom): (i32, i32, i32, i32),
    gains: Option<ClipGainContext<'_>>,
    i: usize,
) -> u8 {
    let w = img.width as i32;
    let hard = |j: usize| channels_in_sensor_space(&img.pixels[j], thresholds, gains, j, img.width);
    let p = &img.pixels[i];
    let h = hard(i);
    let band = channels_in_sensor_space(p, floors, gains, i, img.width) & lowest_channels(p) & !h;
    let (x, y) = (i as i32 % w, i as i32 / w);
    let inside = x >= left && x < right && y >= top && y < bottom;
    if band == 0 || !inside {
        return h;
    }
    let rows = (y - RIPPLE_RADIUS).max(top)..(y + RIPPLE_RADIUS + 1).min(bottom);
    let cols = (x - RIPPLE_RADIUS).max(left)..(x + RIPPLE_RADIUS + 1).min(right);
    let near_hard = rows
        .flat_map(|ny| cols.clone().map(move |nx| (ny * w + nx) as usize))
        .fold(0u8, |m, j| m | hard(j));
    h | (band & near_hard)
}
