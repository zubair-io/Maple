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
use crate::raster_encode::RasterOutput;
use crate::raster_recipe_encode::encode_raster_output;
use crate::raster_recipe_filter::{apply_filter_run, is_filter_op};
use crate::raster_recipe_geometry::apply_geometry_op;
use crate::raster_recipe_meta::{resolve_metadata, ResolvedMetadata};
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
        // TIFF belongs here: `encode_tiff_opts` writes RGB plus one
        // unassociated alpha sample (`ExtraSamples` = 2), the same file
        // `sharp().tiff()` produces for an RGBA input. The plan's decision
        // D2 grouped it with JPEG as alpha-free, which was wrong — measured,
        // `sharp(rgba).tiff()` reports 4 channels with `hasAlpha: true`.
        RasterOutput::Png(_) | RasterOutput::Webp { .. } | RasterOutput::Tiff(_) => true,
        #[cfg(feature = "avif")]
        RasterOutput::Avif(_) => true,
        RasterOutput::Jpeg(_) | RasterOutput::Raw => false,
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

/// The metadata the container is actually written with: the recipe's own
/// `metadata` block (#3507) resolved against the input, with one addition
/// only the output stage can supply — the ICC profile that follows the
/// primaries `toColourspace` rotated the pixels into (#3506/#3503).
///
/// ICC precedence, highest first:
///
/// 1. An explicit `withIccProfile` — `metadata.icc` bytes or
///    `metadata.iccName` ("srgb"/"p3"). The caller named a profile; it wins.
/// 2. `keep`'s sweep of the input's own profile, or the default fill `keep`
///    applies when the input carried none (sharp's `withMetadata()` adds one
///    there).
/// 3. The primaries profile, when `toColourspace('display-p3')` actually
///    rotated the pixels out of sRGB. Without this an explicitly-converted
///    P3 image would ship untagged and render as sRGB.
/// 4. Nothing. A default (no `toColourspace`, no `metadata`) recipe ships
///    UNTAGGED, which is what sharp does and what `test/oracle.test.ts`
///    pins: sharp colour-manages on decode as soon as any profile is
///    present, so an sRGB-tagged PNG came back with 12 008 of 12 288 bytes
///    changed rather than passed through.
fn resolve_output_metadata(
    recipe: &Recipe,
    input: &[u8],
    aux: &[u8],
    primaries: TargetPrimaries,
    auto_oriented: bool,
) -> Result<ResolvedMetadata> {
    let resolved = resolve_metadata(&recipe.metadata, input, aux, auto_oriented)?;
    let icc = match resolved.icc {
        Some(profile) => Some(profile),
        None => (primaries != TargetPrimaries::Srgb).then(|| icc::profile_for(primaries)),
    };
    Ok(ResolvedMetadata { icc, ..resolved })
}

pub fn run_recipe(recipe: &Recipe, input: &[u8], aux: &[u8]) -> Result<RecipeResult> {
    let decoded = decode_input(recipe, input)?;
    // `autoOrient` rotated the pixels to match whatever Orientation the
    // input declared, so a resolved EXIF block that still says otherwise
    // would tell the next reader to rotate them again — `resolve_metadata`
    // neutralises it to 1 (#3507 fix-round-1, item 3).
    let auto_oriented = recipe.ops.iter().any(|op| matches!(op, Op::AutoOrient {}));
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
    let primaries = output_primaries(recipe)?;
    // AVIF carries no ICC box at all (`ravif` 0.13 writes none), so a
    // Display P3 AVIF request is rejected by name here rather than silently
    // shipping untagged — and therefore mis-rendering — P3 samples. Same
    // gate `export::encode_raster_rgb` applies on the non-recipe path.
    if is_avif_output(&output) {
        crate::export::reject_untagged_avif_p3(crate::export::ExportFormat::Avif, primaries)?;
    }
    let metadata = resolve_output_metadata(recipe, input, aux, primaries, auto_oriented)?;
    let bytes = encode_raster_output(&processed, &output, &metadata)?;
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

#[cfg(test)]
#[path = "raster_recipe_exec_meta_tests.rs"]
mod meta_tests;
