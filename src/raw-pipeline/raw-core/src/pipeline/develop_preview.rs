//! The developed-preview render behind the server's `display-preview`, thumbnail
//! and describe-preview fallbacks (`maple_render_develop_jpeg_to_file` and its
//! Node twin), for a RAW with no usable embedded preview.

use super::{
    render_from_raw_with_quality_and_source, render_sized_from_raw_with_quality_and_source,
    RawInput, RenderQuality,
};
use crate::error::Result;
use crate::image::RawImage;
use crate::xmp::AdjustmentModel;

/// Develop `raw` for a preview whose long edge is `max_long_edge`, returning the
/// display-oriented RGB888 buffer to downscale from.
///
/// An unedited photo develops through the sized chain, which downsamples right
/// after demosaic so every later stage runs on the preview-sized buffer. An
/// edited photo develops at full size with AMaZE: the sized chain crops after
/// developing at `max_long_edge` and never upscales, so a half-size crop would
/// come out at half the target and its detail stages would run at preview
/// density.
pub fn render_develop_preview(
    raw: &RawImage,
    model: &AdjustmentModel,
    raw_source: Option<RawInput<'_>>,
    max_long_edge: u32,
    edited: bool,
) -> Result<(u32, u32, Vec<u8>)> {
    if edited {
        render_from_raw_with_quality_and_source(raw, model, RenderQuality::Amaze, raw_source)
    } else {
        render_sized_from_raw_with_quality_and_source(
            raw,
            model,
            RenderQuality::Full,
            raw_source,
            max_long_edge,
        )
    }
}

#[cfg(test)]
#[path = "develop_preview_tests.rs"]
mod tests;
