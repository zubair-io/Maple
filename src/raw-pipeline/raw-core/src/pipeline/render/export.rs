//! Export render (#943): the display render, at a caller-chosen output depth
//! and primaries.
//!
//! This deliberately shares [`super::render_display_scene`] with the ordinary
//! display path instead of assembling its own chain. Everything that decides
//! colour — develop, AgX, split-tone, grain, the primaries rotation with its
//! gamut compression, the display encode, the Auto Profile tail — has already
//! run by the time that function returns, so an export and the canvas the user
//! approved are the same pixels by construction, not by two implementations
//! happening to agree. The only choices left here are how many bits to keep
//! and which primaries to say they are in.

use super::{finish, render_display_scene, stage, RawInput};
use crate::{
    error::Result,
    image::{ExifOrientation, Image, RawImage},
    pipeline::RenderQuality,
    types::Crop,
    view::{encode, encode::TargetPrimaries, quantize16::dither_and_quantize_u16},
    xmp::AdjustmentModel,
};

/// Bits per channel in the exported file.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ExportDepth {
    /// 8 bits — what JPEG and PNG carry, and what the canvas shows.
    Eight,
    /// 16 bits — the TIFF master, quantized straight off the f32 display
    /// buffer rather than promoted from 8-bit.
    Sixteen,
}

/// A rendered export buffer, at whichever depth was asked for.
pub enum ExportPixels {
    Eight(Vec<u8>),
    Sixteen(Vec<u16>),
}

/// Render `raw` for export at `depth` and `target` primaries.
///
/// `max_long_edge` caps the long edge through the early-downsample develop
/// chain (so every post-demosaic stage runs on the smaller buffer rather than
/// the full-res one being built and then thrown away); `None` renders native
/// full resolution. Never upscales.
///
/// `quality` should be [`RenderQuality::Amaze`] for anything a user keeps —
/// see #940. It is a parameter rather than a constant only so the tests can
/// run the cheap demosaic.
pub fn render_export_from_raw(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    raw_source: Option<RawInput<'_>>,
    max_long_edge: Option<u32>,
    target: TargetPrimaries,
    depth: ExportDepth,
) -> Result<(u32, u32, ExportPixels)> {
    let mut scene = render_display_scene(raw, model, quality, raw_source, max_long_edge, target)?;
    let (w, h, pixels) = match depth {
        ExportDepth::Eight => finish_eight(&mut scene, raw.orientation, &model.crop),
        ExportDepth::Sixteen => finish_sixteen(&mut scene, raw.orientation, &model.crop),
    };
    Ok((w, h, pixels))
}

/// 8-bit export terminal: dither/quantize, then the geometry tail.
///
/// One terminal per depth, each with exactly one quantize call, so
/// `dither_terminal_tests` can check the #441 invariant — nothing that touches
/// pixel VALUES may run after the quantize — on the export chains the same way
/// it checks it on the display chain.
fn finish_eight(
    scene: &mut Image,
    orientation: ExifOrientation,
    crop: &Crop,
) -> (u32, u32, ExportPixels) {
    let (width, height) = (scene.width, scene.height);
    let samples = stage("dither_and_quantize", || encode::dither_and_quantize(scene));
    let (w, h, out) = finish::apply_geometry(&samples, width, height, orientation, crop);
    (w, h, ExportPixels::Eight(out))
}

/// 16-bit export terminal: dither/quantize at 16 bits, then the geometry tail.
fn finish_sixteen(
    scene: &mut Image,
    orientation: ExifOrientation,
    crop: &Crop,
) -> (u32, u32, ExportPixels) {
    let (width, height) = (scene.width, scene.height);
    let samples = stage("dither_and_quantize_u16", || dither_and_quantize_u16(scene));
    let (w, h, out) = finish::apply_geometry(&samples, width, height, orientation, crop);
    (w, h, ExportPixels::Sixteen(out))
}
