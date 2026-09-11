//! Execute a parsed [`crate::raster_recipe::Recipe`]: decode the input, apply
//! every op in order, encode the result. One function, one pass, no hidden
//! state — the ops list IS the pipeline.

use crate::error::{Error, Result};
use crate::raster::RasterImage;
use crate::raster_recipe::{Layer, Op, Output, Recipe, RecipeInput};

use crate::export::ExportFormat;
use crate::raster::{resize_raster, FilterAlg, ResizeFit, ResizeOptions};
use crate::raster_composite::{composite, BlendMode, CompositeLayer, Gravity};
use crate::raster_encode::{encode_raster_opts, RasterEncodeOptions};

/// What a recipe produced: the encoded bytes (or raw pixels for
/// `Output::Raw`) plus the dimensions actually written.
#[derive(Debug)]
pub struct RecipeResult {
    pub width: u32,
    pub height: u32,
    pub channels: u8,
    pub bytes: Vec<u8>,
}

fn bad(reason: String) -> Error {
    Error::Decode {
        path: "<recipe>".into(),
        reason,
    }
}

fn decode_input(recipe: &Recipe, input: &[u8]) -> Result<RasterImage> {
    match recipe.input {
        RecipeInput::Encoded => crate::raster::decode_raster(input, None),
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

fn fit_from_wire(s: &str) -> Result<ResizeFit> {
    match s {
        "cover" => Ok(ResizeFit::Cover),
        "fill" => Ok(ResizeFit::Fill),
        "inside" => Ok(ResizeFit::Inside),
        other => Err(bad(format!("unsupported resize fit '{other}'"))),
    }
}

fn kernel_from_wire(s: &str) -> Result<FilterAlg> {
    match s {
        "lanczos3" => Ok(FilterAlg::Lanczos3),
        "linear" => Ok(FilterAlg::Bilinear),
        "nearest" => Ok(FilterAlg::Nearest),
        other => Err(bad(format!("unsupported resize kernel '{other}'"))),
    }
}

fn apply_op(image: RasterImage, op: &Op, aux: &[u8]) -> Result<RasterImage> {
    match op {
        Op::AutoOrient => {
            let mut oriented = image;
            oriented.auto_orient();
            Ok(oriented)
        }
        Op::Resize {
            width,
            height,
            fit,
            kernel,
            without_enlargement,
            ..
        } => resize_raster(
            &image,
            &ResizeOptions {
                width: if *width == 0 { image.width } else { *width },
                height: if *height == 0 { image.height } else { *height },
                fit: fit_from_wire(fit)?,
                filter: kernel_from_wire(kernel)?,
                without_enlargement: *without_enlargement,
            },
        ),
        Op::Flatten { background } => {
            Ok(image.flatten([background[0], background[1], background[2]]))
        }
        Op::EnsureAlpha { alpha } => {
            Ok(image.ensure_alpha((alpha.clamp(0.0, 1.0) * 255.0).round() as u8))
        }
        Op::RemoveAlpha => Ok(image.remove_alpha()),
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
    }
}

/// sharp's AVIF `effort` (0 fastest … 9 slowest) → rav1e speed
/// (10 fastest … 1 slowest).
fn avif_speed(effort: u8) -> u8 {
    10 - effort.min(9)
}

fn encode(image: &RasterImage, output: Output) -> Result<Vec<u8>> {
    let opts = |format, quality, speed| RasterEncodeOptions {
        format,
        quality,
        avif_speed: speed,
    };
    match output {
        Output::Raw => Ok(image.data.clone()),
        Output::Jpeg { quality } => {
            encode_raster_opts(image, &opts(ExportFormat::Jpeg, quality, 6))
        }
        Output::Png => encode_raster_opts(image, &opts(ExportFormat::Png, 100, 6)),
        Output::Webp => encode_raster_opts(image, &opts(ExportFormat::Webp, 100, 6)),
        Output::Tiff => encode_raster_opts(image, &opts(ExportFormat::Tiff16, 100, 6)),
        Output::Avif { quality, effort } => encode_raster_opts(
            image,
            &opts(ExportFormat::Avif, quality, avif_speed(effort)),
        ),
    }
}

pub fn run_recipe(recipe: &Recipe, input: &[u8], aux: &[u8]) -> Result<RecipeResult> {
    let decoded = decode_input(recipe, input)?;
    let processed = recipe
        .ops
        .iter()
        .try_fold(decoded, |image, op| apply_op(image, op, aux))?;
    let bytes = encode(&processed, recipe.output)?;
    Ok(RecipeResult {
        width: processed.width,
        height: processed.height,
        channels: processed.channels,
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
        assert!(run_recipe(&recipe, &[0, 0, 0, 255], &[1, 2, 3]).is_err());
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
}
