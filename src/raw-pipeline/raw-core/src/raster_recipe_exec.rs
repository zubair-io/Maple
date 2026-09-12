//! Execute a parsed [`crate::raster_recipe::Recipe`]: decode the input, apply
//! every op in order, encode the result. One function, one pass, no hidden
//! state — the ops list IS the pipeline.

use crate::error::Result;
use crate::icc;
use crate::raster::RasterImage;
/// Re-exported `pub(crate)` — `raster_recipe_geometry` and
/// `raster_recipe_resize` reach it as `raster_recipe_exec::bad`, while
/// `raster_recipe_colour` reaches the same function straight from
/// `raster_recipe`, where it now lives (shared by all three op families so
/// every validation error in the pipeline is reported the same way).
pub(crate) use crate::raster_recipe::bad;
use crate::raster_recipe::{Layer, Op, Recipe, RecipeInput};
use crate::raster_recipe_colour::{apply_colour_op, output_primaries};
use crate::raster_recipe_output::output_from_wire;

use crate::raster_composite::{composite, BlendMode, CompositeLayer, Gravity};
use crate::raster_encode::{encode_raster_output, EmbeddedMetadata, RasterOutput};
use crate::raster_recipe_filter::{apply_filter_run, is_filter_op};
use crate::raster_recipe_geometry::apply_geometry_op;
use crate::raster_recipe_resize::{apply_resize_op, ResizeOpArgs};
use crate::view::encode::TargetPrimaries;

/// What a recipe produced: the encoded bytes (or raw pixels for
/// `Output::Raw`) plus the dimensions actually written.
#[derive(Debug)]
pub struct RecipeResult {
    pub width: u32,
    pub height: u32,
    pub channels: u8,
    pub bytes: Vec<u8>,
}

fn decode_input(recipe: &Recipe, input: &[u8]) -> Result<RasterImage> {
    match recipe.input {
        RecipeInput::Encoded {} => crate::raster::decode_raster(input, None),
        RecipeInput::Raw {
            width,
            height,
            channels,
        } => RasterImage::from_raw(width, height, channels, input.to_vec()),
    }
}

/// Decode one composite layer: raw pixels from `aux` when the layer carries a
/// `raw` spec, otherwise an encoded file from `aux`.
fn decode_layer(layer: &Layer, aux: &[u8]) -> Result<RasterImage> {
    let bytes = layer.aux.slice(aux)?;
    match layer.raw {
        Some(spec) => RasterImage::from_raw(spec.width, spec.height, spec.channels, bytes.to_vec()),
        None => crate::raster::decode_raster(bytes, None),
    }
}

/// Apply one op, threading the primaries the image is ACTUALLY in right
/// now alongside it. Every op but `ToColourspace` passes `primaries`
/// through unchanged — only `apply_colour_op`'s `ToColourspace` arm updates
/// it, using the incoming value as `from` rather than an assumed sRGB (see
/// its doc comment).
///
/// Handles every op except the five filter ops, which `apply_filter_run`
/// takes as whole runs rather than one at a time (see [`run_recipe`]).
fn apply_op(
    image: RasterImage,
    primaries: TargetPrimaries,
    op: &Op,
    aux: &[u8],
) -> Result<(RasterImage, TargetPrimaries)> {
    match op {
        Op::AutoOrient {} => {
            let mut oriented = image;
            oriented.auto_orient();
            Ok((oriented, primaries))
        }
        Op::Resize {
            width,
            height,
            fit,
            position,
            kernel,
            without_enlargement,
            without_reduction,
            background,
        } => Ok((
            apply_resize_op(
                &image,
                &ResizeOpArgs {
                    width: *width,
                    height: *height,
                    fit,
                    position,
                    kernel,
                    without_enlargement: *without_enlargement,
                    without_reduction: *without_reduction,
                    background: *background,
                },
            )?,
            primaries,
        )),
        Op::Flatten { background } => Ok((
            image.flatten([background[0], background[1], background[2]]),
            primaries,
        )),
        Op::EnsureAlpha { alpha } => Ok((
            image.ensure_alpha((alpha.clamp(0.0, 1.0) * 255.0).round() as u8),
            primaries,
        )),
        Op::RemoveAlpha {} => Ok((image.remove_alpha(), primaries)),
        Op::Composite { layers } => {
            let decoded = layers
                .iter()
                .map(|l| decode_layer(l, aux))
                .collect::<Result<Vec<_>>>()?;
            let specs = layers
                .iter()
                .zip(&decoded)
                .map(|(l, img)| {
                    Ok(CompositeLayer {
                        image: img,
                        left: l.left,
                        top: l.top,
                        gravity: Gravity::from_wire(&l.gravity)
                            .ok_or_else(|| bad(format!("unsupported gravity '{}'", l.gravity)))?,
                        blend: BlendMode::from_wire(&l.blend)
                            .ok_or_else(|| bad(format!("unsupported blend mode '{}'", l.blend)))?,
                        tile: l.tile,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            Ok((composite(&image, &specs)?, primaries))
        }
        Op::Extract { .. }
        | Op::Extend { .. }
        | Op::Rotate { .. }
        | Op::Flip {}
        | Op::Flop {}
        | Op::Trim { .. } => Ok((apply_geometry_op(image, op)?, primaries)),
        Op::Greyscale {}
        | Op::Gamma { .. }
        | Op::Linear { .. }
        | Op::Negate { .. }
        | Op::Normalise { .. }
        | Op::Modulate { .. }
        | Op::Tint { .. }
        | Op::ToColourspace { .. } => apply_colour_op(image, primaries, op),
        Op::Blur(_) | Op::Sharpen(_) | Op::Median(_) | Op::Threshold(_) | Op::Convolve(_) => {
            // `run_recipe` routes every filter op through `apply_filter_run`,
            // so reaching here means a new filter variant was added to
            // `is_filter_op`'s list without being wired into
            // `filter_op_from_wire`. An error beats a panic: this function
            // runs behind the C-FFI boundary, where unwinding is not the
            // caller's problem to catch.
            Err(bad(format!(
                "{op:?} is a filter op and must run through apply_filter_run"
            )))
        }
    }
}

/// `true` when the given output container can carry an alpha channel.
/// Mirrors `raster_encode::container_supports_alpha`'s decision, but keyed
/// on the per-format `RasterOutput` PR-F introduced rather than the flat
/// `ExportFormat` PR-A used, so `channels_written` never disagrees with what
/// `encode_raster_output` actually wrote (#3505 fix-round-1's invariant,
/// carried forward).
fn output_supports_alpha(output: &RasterOutput) -> bool {
    match output {
        RasterOutput::Png(_) | RasterOutput::Webp { .. } => true,
        #[cfg(feature = "avif")]
        RasterOutput::Avif(_) => true,
        RasterOutput::Jpeg(_) | RasterOutput::Tiff(_) | RasterOutput::Raw => false,
    }
}

/// The channel count the container actually carries. `Raw` always reports
/// the source's own channel count (there is no container to flatten for);
/// every other format flattens a 4-channel source to 3 unless
/// `output_supports_alpha` says otherwise (#3505 fix-round-1).
fn channels_written(image: &RasterImage, output: &RasterOutput) -> u8 {
    if matches!(output, RasterOutput::Raw) {
        return image.channels;
    }
    if image.channels == 4 && output_supports_alpha(output) {
        4
    } else {
        3
    }
}

/// `true` for `RasterOutput::Avif` — split out (rather than an inline
/// `matches!`) because that variant only exists under the `avif` feature
/// (see `raster_encode.rs`'s own `#[cfg]` on it); `run_recipe`'s AVIF+P3
/// gate below needs an answer that compiles either way, same dual-`#[cfg]`
/// shape `raster_recipe_output::avif_from_wire` already uses.
#[cfg(feature = "avif")]
fn is_avif_output(output: &RasterOutput) -> bool {
    matches!(output, RasterOutput::Avif(_))
}
#[cfg(not(feature = "avif"))]
fn is_avif_output(_output: &RasterOutput) -> bool {
    false
}

pub fn run_recipe(recipe: &Recipe, input: &[u8], aux: &[u8]) -> Result<RecipeResult> {
    let decoded = decode_input(recipe, input)?;
    // The decoder's output is sRGB; `apply_op` threads the ACTUAL current
    // primaries alongside the image so a `ToColourspace` op rotates from
    // where the pixels are, not from an assumed sRGB (#3503 fix-round-1).
    //
    // Consecutive filter ops run as ONE premultiply sandwich, matching
    // sharp's single `premultiply()` / `unpremultiply()` pair around its
    // whole filter stage — see `raster_filter_chain`. `chunk_by` groups a
    // maximal run of them; every other op comes back as a chunk of one. No
    // filter op rotates primaries, so a run threads the incoming value
    // straight back out.
    let (processed, _primaries) = recipe
        .ops
        .chunk_by(|a, b| is_filter_op(a) && is_filter_op(b))
        .try_fold(
            (decoded, TargetPrimaries::Srgb),
            |(image, primaries), chunk| {
                if is_filter_op(&chunk[0]) {
                    apply_filter_run(&image, chunk).map(|filtered| (filtered, primaries))
                } else {
                    apply_op(image, primaries, &chunk[0], aux)
                }
            },
        )?;
    let output = output_from_wire(&recipe.output)?;
    // The ICC profile the container is tagged with follows the primaries
    // `toColourspace` actually rotated the pixels into (`output_primaries`
    // walks the op list for the last such call, defaulting to sRGB — the
    // decoder's own output space, when none ran). AVIF has no ICC/CICP tag
    // yet (#3503), so a Display P3 AVIF request is rejected by name here,
    // matching `export::encode_raster_rgb`'s `reject_untagged_avif_p3` gate
    // on the non-recipe encode path, rather than silently shipping
    // untagged (and therefore mis-rendering) P3 samples.
    //
    // Only a NON-sRGB result gets a profile embedded at all. Tagging sRGB
    // unconditionally looked "more correct" on paper, but the cross-decoder
    // oracle (`test/oracle.test.ts`, which reads Maple's output back through
    // sharp/libpng/libtiff rather than Maple's own decoder) caught the real
    // consequence: sharp colour-manages on decode once ANY ICC profile is
    // present, so an sRGB-tagged PNG/TIFF/JPEG came back with every sample
    // renormalised through Maple's synthesised sRGB profile instead of
    // passed through byte for byte — a measured 12,008-of-12,288-byte
    // mismatch on a 64x64 RGB PNG, not a rounding-level difference. Every
    // default (no `toColourspace`) recipe must stay byte-exact through sharp
    // — that is what `raster_encode.rs`'s own alpha-path convention already
    // does for sRGB WebP ("stays untagged, matching pre-#3503 output"), and
    // this output stage now matches it for every format rather than just
    // WebP.
    let primaries = output_primaries(recipe)?;
    if is_avif_output(&output) {
        crate::export::reject_untagged_avif_p3(crate::export::ExportFormat::Avif, primaries)?;
    }
    let icc_profile = (primaries != TargetPrimaries::Srgb).then(|| icc::profile_for(primaries));
    let metadata = EmbeddedMetadata {
        icc: icc_profile.as_deref(),
        ..EmbeddedMetadata::default()
    };
    let bytes = encode_raster_output(&processed, &output, metadata)?;
    let channels = channels_written(&processed, &output);
    Ok(RecipeResult {
        width: processed.width,
        height: processed.height,
        channels,
        bytes,
    })
}

#[cfg(test)]
#[path = "raster_recipe_exec_tests.rs"]
mod tests;
