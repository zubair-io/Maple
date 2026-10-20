//! AMaZE bounds reconstruction against one clip ceiling derived from the
//! sensor's [0, 1] range, but DNG OpcodeList2 gain maps lift sites past it
//! (#5000). Reconstruct with the spatial gain divided out, then re-apply it.
use crate::{
    image::{CfaPattern, Image},
    sensor_gain_maps::ClipGainContext,
};
use rayon::prelude::*;

pub(super) fn reconstruct_ungained(
    mosaic: &Image,
    cfa: CfaPattern,
    gains: ClipGainContext<'_>,
    reconstruct: impl FnOnce(&Image) -> Image,
) -> Image {
    let width = mosaic.width;
    let site = |index: usize| cfa.color_at(index as u32 % width, index as u32 / width) as usize;
    let mut ungained = mosaic.clone();
    ungained
        .pixels
        .par_iter_mut()
        .enumerate()
        .for_each(|(index, pixel)| {
            let channel = site(index);
            let gain = gains.scale(index, width)[channel];
            if gain > 0. {
                pixel[channel] /= gain;
            }
        });
    let mut out = reconstruct(&ungained);
    out.pixels
        .par_iter_mut()
        .enumerate()
        .for_each(|(index, pixel)| {
            let gain = gains.scale(index, width);
            for (value, gain) in pixel.iter_mut().zip(gain) {
                *value *= gain;
            }
            let channel = site(index);
            pixel[channel] = mosaic.pixels[index][channel];
        });
    out
}

#[cfg(test)]
#[path = "sensor_gain_tests.rs"]
mod tests;
