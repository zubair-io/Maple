//! Sized display-encoded render entry + native-dims probe (#1101) — split
//! from `render/mod.rs` to keep it under the file-size budget; re-exported
//! there so `pipeline::{…}` keeps resolving both names.

use super::{render_display_from_raw, RawInput};
use crate::error::Result;
use crate::film;
use crate::image::RawImage;
use crate::pipeline::RenderQuality;
use crate::xmp::AdjustmentModel;

/// Sized variant of [`super::render_from_raw_with_quality_and_source`] — the
/// display-encoded counterpart of
/// [`super::render_scene_linear_sized_from_raw_with_quality`]. Develops
/// through the early-downsample chain (`develop_scene_linear_sized_…`,
/// downsample lands immediately after demosaic so every later stage runs on
/// the viewport-sized buffer), then runs the IDENTICAL view tail (AgX →
/// Rec.2020→sRGB → gamma → Auto Profile → Look → dither/quantize → EXIF
/// orient) — shared code path with the unsized entry
/// ([`render_display_from_raw`]), so the two can never drift.
///
/// `max_long_edge` caps the long edge of the (pre-orientation) render;
/// never upscales — a cap at or above the native long edge is functionally
/// identical to the unsized entry. The web fast/refine phases (#1101) call
/// this through `raw-wasm::render_bytes_sized`.
pub fn render_sized_from_raw_with_quality_and_source(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    raw_source: Option<RawInput<'_>>,
    max_long_edge: u32,
) -> Result<(u32, u32, Vec<u8>)> {
    render_display_from_raw(raw, model, quality, raw_source, Some(max_long_edge), None)
}

/// Sized + film-look variant — the intersection of
/// [`render_sized_from_raw_with_quality_and_source`] and
/// [`super::render_from_raw_with_quality_source_and_film`], both of which are
/// thin pins over the same private `render_display_from_raw`. Exists for the
/// web CPU fallback (`raw-wasm::render_bytes_with_film`), whose #2661 memory
/// clamp turns an unsized film develop of a large sensor into a sized one —
/// without this entry the fallback would have to choose between honoring the
/// film look and fitting the 4 GiB wasm32 heap.
///
/// `film_lut: None` is a hard skip, matching its unsized sibling.
pub fn render_sized_from_raw_with_quality_source_and_film(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    raw_source: Option<RawInput<'_>>,
    max_long_edge: u32,
    film_lut: Option<&film::FilmLut>,
) -> Result<(u32, u32, Vec<u8>)> {
    render_display_from_raw(
        raw,
        model,
        quality,
        raw_source,
        Some(max_long_edge),
        film_lut,
    )
}

/// The oriented output dimensions a `RenderQuality::Full` render of `raw`
/// would produce, WITHOUT developing: DefaultCrop rect (divisor 1 — Full
/// quality never halves), clamped to the sensor extent exactly like
/// `crop_to_default`, then the EXIF orientation's width/height swap.
///
/// Callers that decode at a reduced size (the sized entries) use this to
/// report the native dimensions alongside the sized buffer — e.g. the web
/// editor needs native dims for fit/100% zoom math while painting a
/// viewport-sized fast-phase render (#1101).
pub fn native_render_dims(raw: &RawImage) -> (u32, u32) {
    let (w, h) = match raw.crop_rect {
        Some(c) => {
            // Mirror `crop_to_default`'s clamp + degenerate/no-op handling at
            // divisor 1: clamp the rect to the buffer extent and fall back to
            // the full frame when the clamped rect is zero-sized.
            let cw = c.w.min(raw.width.saturating_sub(c.x));
            let ch = c.h.min(raw.height.saturating_sub(c.y));
            if cw == 0 || ch == 0 {
                (raw.width, raw.height)
            } else {
                (cw, ch)
            }
        }
        None => (raw.width, raw.height),
    };
    if raw.orientation.swaps_wh() {
        (h, w)
    } else {
        (w, h)
    }
}
