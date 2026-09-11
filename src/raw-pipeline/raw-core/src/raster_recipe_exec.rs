//! Execute a parsed [`crate::raster_recipe::Recipe`]: decode the input, apply
//! every op in order, encode the result. One function, one pass, no hidden
//! state — the ops list IS the pipeline.

use crate::error::Result;
use crate::raster::RasterImage;
/// Re-exported `pub(crate)` — `raster_recipe_geometry` and
/// `raster_recipe_resize` reach it as `raster_recipe_exec::bad`, while
/// `raster_recipe_colour` reaches the same function straight from
/// `raster_recipe`, where it now lives (shared by all three op families so
/// every validation error in the pipeline is reported the same way).
pub(crate) use crate::raster_recipe::bad;
use crate::raster_recipe::{Layer, Op, Output, Recipe, RecipeInput};
use crate::raster_recipe_colour::{apply_colour_op, output_primaries};

use crate::export::ExportFormat;
use crate::raster_composite::{composite, BlendMode, CompositeLayer, Gravity};
use crate::raster_encode::{container_supports_alpha, encode_raster_opts, RasterEncodeOptions};
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

fn apply_op(image: RasterImage, op: &Op, aux: &[u8]) -> Result<RasterImage> {
    match op {
        Op::AutoOrient {} => {
            let mut oriented = image;
            oriented.auto_orient();
            Ok(oriented)
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
        } => apply_resize_op(
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
        ),
        Op::Flatten { background } => {
            Ok(image.flatten([background[0], background[1], background[2]]))
        }
        Op::EnsureAlpha { alpha } => {
            Ok(image.ensure_alpha((alpha.clamp(0.0, 1.0) * 255.0).round() as u8))
        }
        Op::RemoveAlpha {} => Ok(image.remove_alpha()),
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
            composite(&image, &specs)
        }
        Op::Extract { .. }
        | Op::Extend { .. }
        | Op::Rotate { .. }
        | Op::Flip {}
        | Op::Flop {}
        | Op::Trim { .. } => apply_geometry_op(image, op),
        Op::Greyscale {}
        | Op::Gamma { .. }
        | Op::Linear { .. }
        | Op::Negate { .. }
        | Op::Normalise { .. }
        | Op::Modulate { .. }
        | Op::Tint { .. }
        | Op::ToColourspace { .. } => apply_colour_op(image, op),
    }
}

/// sharp's AVIF `effort` (0 fastest … 9 slowest) → rav1e speed
/// (10 fastest … 1 slowest).
fn avif_speed(effort: u8) -> u8 {
    10 - effort.min(9)
}

/// Encode `image` per `output`, returning the bytes AND the channel count
/// the container actually carries. `encode_raster_opts` silently flattens a
/// 4-channel source to 3 when the container can't hold alpha (JPEG, TIFF) —
/// `channels_written` mirrors that same decision so `RecipeResult::channels`
/// never disagrees with the bytes it describes (#3505 fix-round-1).
fn channels_written(image: &RasterImage, format: ExportFormat) -> u8 {
    if image.channels == 4 && container_supports_alpha(format) {
        4
    } else {
        3
    }
}

fn encode(
    image: &RasterImage,
    output: Output,
    primaries: TargetPrimaries,
) -> Result<(Vec<u8>, u8)> {
    let opts = |format, quality, speed| RasterEncodeOptions {
        format,
        quality,
        avif_speed: speed,
        primaries,
    };
    let encode_as = |format: ExportFormat, quality: u8, speed: u8| -> Result<(Vec<u8>, u8)> {
        let bytes = encode_raster_opts(image, &opts(format, quality, speed))?;
        Ok((bytes, channels_written(image, format)))
    };
    match output {
        Output::Raw {} => Ok((image.data.clone(), image.channels)),
        Output::Jpeg { quality } => encode_as(ExportFormat::Jpeg, quality, 6),
        Output::Png {} => encode_as(ExportFormat::Png, 100, 6),
        Output::Webp {} => encode_as(ExportFormat::Webp, 100, 6),
        Output::Tiff {} => encode_as(ExportFormat::Tiff16, 100, 6),
        Output::Avif { quality, effort } => {
            encode_as(ExportFormat::Avif, quality, avif_speed(effort))
        }
    }
}

pub fn run_recipe(recipe: &Recipe, input: &[u8], aux: &[u8]) -> Result<RecipeResult> {
    let decoded = decode_input(recipe, input)?;
    let processed = recipe
        .ops
        .iter()
        .try_fold(decoded, |image, op| apply_op(image, op, aux))?;
    let (bytes, channels) = encode(&processed, recipe.output, output_primaries(recipe)?)?;
    Ok(RecipeResult {
        width: processed.width,
        height: processed.height,
        channels,
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::raster_recipe::parse_recipe;

    fn run(json: &str, input: &[u8], aux: &[u8]) -> RecipeResult {
        run_recipe(&parse_recipe(json).unwrap(), input, aux).unwrap()
    }

    /// 4x2 solid RGBA red, as a raw pixel buffer.
    fn red_rgba() -> Vec<u8> {
        (0..8).flat_map(|_| [255u8, 0, 0, 255]).collect()
    }

    /// sharp `effort` 0 (fastest) ..= 9 (slowest) → rav1e speed 10 ..= 1,
    /// i.e. `speed = 10 - effort`. Must equal Tier 1's `avif_speed_from` in
    /// `raw-ffi/src/raster_v2.rs` (its wire is one-based — `wire_effort =
    /// effort + 1`, mapped by `11 - wire_effort.min(10)` — which reduces to
    /// the same `10 - effort` for every sharp effort value 0..=9), so a
    /// recipe-driven AVIF encode and the direct FFI path pick the same
    /// rav1e speed for the same effort.
    #[test]
    fn avif_speed_maps_effort_0_through_9_to_speed_10_through_1() {
        let expected: [u8; 10] = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
        for (effort, &speed) in expected.iter().enumerate() {
            assert_eq!(avif_speed(effort as u8), speed, "effort {effort}");
        }
    }

    #[test]
    fn raw_in_raw_out_is_a_round_trip() {
        let out = run(
            r#"{"v":1,"input":{"kind":"raw","width":4,"height":2,"channels":4},"ops":[],"output":{"format":"raw"}}"#,
            &red_rgba(),
            &[],
        );
        assert_eq!((out.width, out.height, out.channels), (4, 2, 4));
        assert_eq!(out.bytes, red_rgba());
    }

    #[test]
    fn a_png_encode_keeps_the_alpha_channel() {
        let transparent: Vec<u8> = (0..4).flat_map(|_| [0u8, 255, 0, 0]).collect();
        let out = run(
            r#"{"v":1,"input":{"kind":"raw","width":2,"height":2,"channels":4},"ops":[],"output":{"format":"png"}}"#,
            &transparent,
            &[],
        );
        let decoded = crate::raster::decode_raster(&out.bytes, Some("png")).unwrap();
        assert_eq!(decoded.channels, 4);
        assert_eq!(decoded.data[3], 0);
    }

    #[test]
    fn reported_channels_reflect_what_the_container_actually_wrote() {
        // An opaque RGBA source encoded to JPEG (no alpha channel in the
        // container) must report 3, not the source's 4 — JPEG silently
        // flattened it. The same source to PNG (alpha-capable) reports 4.
        let rgba = red_rgba();
        let jpeg = run(
            r#"{"v":1,"input":{"kind":"raw","width":4,"height":2,"channels":4},"ops":[],"output":{"format":"jpeg","quality":90}}"#,
            &rgba,
            &[],
        );
        assert_eq!(jpeg.channels, 3);
        let png = run(
            r#"{"v":1,"input":{"kind":"raw","width":4,"height":2,"channels":4},"ops":[],"output":{"format":"png"}}"#,
            &rgba,
            &[],
        );
        assert_eq!(png.channels, 4);
    }

    #[test]
    fn ops_run_in_the_order_given() {
        // flatten-then-ensureAlpha leaves an OPAQUE alpha channel;
        // ensureAlpha-then-flatten would leave three channels.
        let src: Vec<u8> = (0..4).flat_map(|_| [200u8, 0, 0, 0]).collect();
        let out = run(
            r#"{"v":1,"input":{"kind":"raw","width":2,"height":2,"channels":4},
                "ops":[{"op":"flatten","background":[0,0,255,255]},{"op":"ensureAlpha","alpha":1.0}],
                "output":{"format":"raw"}}"#,
            &src,
            &[],
        );
        assert_eq!(out.channels, 4);
        assert_eq!(&out.bytes[..4], &[0, 0, 255, 255]);
    }

    #[test]
    fn extend_with_a_transparent_background_composites_over_black_for_jpeg() {
        // 2x2 opaque black source; extend left by 2 with a fully-transparent
        // red background. The padded pixel is [255,0,0,0] pre-encode; JPEG
        // has no alpha, so it must composite over black before encoding —
        // this recipe path (raster_recipe_exec::encode -> encode_raster_opts)
        // already did, but pins it alongside the raw-ffi regression fixed
        // for #3501 (raster_v2's render_into took a different, alpha-dropping
        // path to the same JPEG encoder).
        let src: Vec<u8> = (0..4).flat_map(|_| [0u8, 0, 0, 255]).collect();
        let out = run(
            r#"{"v":1,"input":{"kind":"raw","width":2,"height":2,"channels":4},
                "ops":[{"op":"extend","left":2,"background":[255,0,0,0]}],
                "output":{"format":"jpeg","quality":95}}"#,
            &src,
            &[],
        );
        let decoded = crate::raster::decode_raster(&out.bytes, Some("jpeg")).unwrap();
        let (r, g, b) = (decoded.data[0], decoded.data[1], decoded.data[2]);
        assert!(
            r < 24 && g < 24 && b < 24,
            "padded transparent-red pixel encoded as ({r},{g},{b}), expected near-black"
        );
    }

    #[test]
    fn resize_runs_through_the_recipe() {
        let out = run(
            r#"{"v":1,"input":{"kind":"raw","width":4,"height":2,"channels":4},
                "ops":[{"op":"resize","width":2,"height":1,"fit":"fill"}],
                "output":{"format":"raw"}}"#,
            &red_rgba(),
            &[],
        );
        assert_eq!((out.width, out.height), (2, 1));
    }

    #[test]
    fn a_composite_layer_reads_its_pixels_from_aux() {
        let overlay: Vec<u8> = vec![0, 0, 255, 255];
        let out = run(
            r#"{"v":1,"input":{"kind":"raw","width":2,"height":1,"channels":4},
                "ops":[{"op":"composite","layers":[{"aux":{"off":0,"len":4},
                        "raw":{"width":1,"height":1,"channels":4},"left":1,"top":0}]}],
                "output":{"format":"raw"}}"#,
            &[255, 0, 0, 255, 255, 0, 0, 255],
            &overlay,
        );
        assert_eq!(&out.bytes[..4], &[255, 0, 0, 255]);
        assert_eq!(&out.bytes[4..8], &[0, 0, 255, 255]);
    }

    #[test]
    fn an_out_of_range_aux_reference_is_rejected() {
        let recipe = parse_recipe(
            r#"{"v":1,"input":{"kind":"raw","width":1,"height":1,"channels":4},
                "ops":[{"op":"composite","layers":[{"aux":{"off":0,"len":99}}]}],
                "output":{"format":"raw"}}"#,
        )
        .unwrap();
        // Like `an_unknown_blend_mode_is_named` below, the error must name the
        // offending values, not just fail generically — here the requested
        // window and the actual aux buffer size.
        let err = run_recipe(&recipe, &[0, 0, 0, 255], &[1, 2, 3]).unwrap_err();
        let message = format!("{err}");
        assert!(message.contains("99"), "got: {message}");
        assert!(message.contains("3-byte"), "got: {message}");
    }

    #[test]
    fn an_unknown_blend_mode_is_named() {
        let recipe = parse_recipe(
            r#"{"v":1,"input":{"kind":"raw","width":1,"height":1,"channels":4},
                "ops":[{"op":"composite","layers":[{"aux":{"off":0,"len":4},
                        "raw":{"width":1,"height":1,"channels":4},"blend":"soft-light"}]}],
                "output":{"format":"raw"}}"#,
        )
        .unwrap();
        let err = run_recipe(&recipe, &[0, 0, 0, 255], &[9, 9, 9, 255]).unwrap_err();
        assert!(format!("{err}").contains("soft-light"), "got: {err}");
    }

    #[test]
    fn contain_letterboxes_through_the_recipe() {
        let out = run(
            r#"{"v":1,"input":{"kind":"raw","width":4,"height":2,"channels":4},
                "ops":[{"op":"resize","width":4,"height":4,"fit":"contain",
                        "background":[0,0,255,255],"kernel":"nearest"}],
                "output":{"format":"raw"}}"#,
            &red_rgba(),
            &[],
        );
        assert_eq!((out.width, out.height), (4, 4));
        assert_eq!(
            &out.bytes[..4],
            &[0, 0, 255, 255],
            "top row must be letterbox"
        );
    }

    #[test]
    fn position_moves_the_cover_crop() {
        // 4x2 where the left half is red and the right half is green; a 2x2
        // cover crop at 'west' keeps red, at 'east' keeps green.
        let src: Vec<u8> = (0..2u32)
            .flat_map(|_| {
                (0..4u32).flat_map(|x| {
                    if x < 2 {
                        [255u8, 0, 0, 255]
                    } else {
                        [0, 255, 0, 255]
                    }
                })
            })
            .collect();
        let recipe = |position: &str| {
            format!(
                r#"{{"v":1,"input":{{"kind":"raw","width":4,"height":2,"channels":4}},
                    "ops":[{{"op":"resize","width":2,"height":2,"fit":"cover",
                             "position":"{position}","kernel":"nearest"}}],
                    "output":{{"format":"raw"}}}}"#
            )
        };
        let west = run(&recipe("west"), &src, &[]);
        let east = run(&recipe("east"), &src, &[]);
        assert_eq!(&west.bytes[..4], &[255, 0, 0, 255]);
        assert_eq!(&east.bytes[..4], &[0, 255, 0, 255]);
    }

    #[test]
    fn an_unsupported_fit_or_kernel_is_named() {
        for (json, needle) in [
            (r#"{"op":"resize","width":2,"fit":"squash"}"#, "squash"),
            (r#"{"op":"resize","width":2,"kernel":"mks2013"}"#, "mks2013"),
            (
                r#"{"op":"resize","width":2,"fit":"cover","position":"entropy"}"#,
                "entropy",
            ),
        ] {
            let recipe = parse_recipe(&format!(
                r#"{{"v":1,"input":{{"kind":"raw","width":2,"height":2,"channels":3}},
                     "ops":[{json}],"output":{{"format":"raw"}}}}"#
            ))
            .unwrap();
            let err = run_recipe(&recipe, &[0u8; 12], &[]).unwrap_err();
            assert!(
                format!("{err}").contains(needle),
                "expected {needle}, got: {err}"
            );
        }
    }
}
