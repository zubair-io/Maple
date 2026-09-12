//! The recipe's output stage (#3506, Task F5): the wire `Output` schema —
//! JPEG/PNG/WebP/AVIF/TIFF encode options plus the alpha-only `Raw`
//! passthrough — and its translation into `raster_encode::RasterOutput`.
//! Split out of `raster_recipe.rs`/`raster_recipe_exec.rs` so those files
//! stay focused on decode/resize/composite — the same file-per-family split
//! the geometry and colour ops use (`raster_recipe_geometry.rs`,
//! `raster_recipe_colour.rs`), applied here even though those two files
//! haven't landed on this branch yet (#3502/#3503 are separate lanes still
//! in flight): the convention is repo-wide, not conditional on landing
//! order.
//!
//! `output_from_wire` is the one place that needs the `avif` feature: the
//! wire schema below (plain `u8`/`bool`/`String` fields) has no feature
//! dependency at all, but translating `Output::Avif` into a
//! `RasterOutput::Avif(AvifOptions)` does, because `AvifOptions` lives in
//! the feature-gated `raster_encode_avif` module (see `lib.rs` — wasm never
//! enables `avif`, and `cargo test -p raw-core --lib` / the Windows CI job
//! both build raw-core WITHOUT it). Requesting AVIF output on a build
//! without the feature fails with a named error instead of a missing type.

use serde::Deserialize;

use crate::error::Result;
use crate::raster_encode::RasterOutput;
use crate::raster_encode_jpeg::{ChromaSubsampling, JpegOptions};
use crate::raster_encode_png::PngOptions;
use crate::raster_encode_tiff::{TiffCompression, TiffOptions};
use crate::raster_recipe_exec::bad;

#[cfg(feature = "avif")]
use crate::raster_encode_avif::{AvifChroma, AvifOptions};

fn eighty() -> u16 {
    80
}
fn six() -> u16 {
    6
}
fn two_five_six() -> u16 {
    256
}
fn one() -> f64 {
    1.0
}
fn fifty() -> u16 {
    50
}
fn four() -> u16 {
    4
}
fn eight() -> u16 {
    8
}
fn yes() -> bool {
    true
}
fn horizontal() -> String {
    "horizontal".to_string()
}
fn chroma_420() -> String {
    "4:2:0".to_string()
}
fn chroma_444() -> String {
    "4:4:4".to_string()
}
fn lzw() -> String {
    "lzw".to_string()
}

/// Range-check one numeric option, naming the field rather than the wire
/// position.
///
/// Every numeric field on `Output` is deserialized as `u16`, wider than the
/// `u8` the encoders take, precisely so an out-of-range value reaches this
/// check instead of serde's — `quality: 500` into a `u8` field produces
/// "invalid value: integer 500, expected u8 at line 1 column 186", which
/// names neither the option nor a range. The message mirrors sharp's own
/// `is.invalidParameterError` shape ("Expected integer between 1 and 100 for
/// quality but received 500"), so a caller migrating off sharp sees the
/// wording they already know.
fn checked(field: &str, value: u16, lo: u16, hi: u16) -> Result<u16> {
    if (lo..=hi).contains(&value) {
        return Ok(value);
    }
    Err(bad(format!(
        "Expected integer between {lo} and {hi} for {field} but received {value}"
    )))
}

/// The recipe's output stage: what container to encode into, and that
/// container's own options. `deny_unknown_fields` on every struct variant —
/// `Raw` is an empty-struct variant rather than a bare unit for the same
/// reason `RecipeInput::Encoded {}` is (#3505 fix-round-2): serde only
/// enforces `deny_unknown_fields` on the struct-variant deserialization
/// path, so a bare unit here would silently accept
/// `{"format":"raw","zzzStray":1}`.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "format", rename_all = "lowercase", deny_unknown_fields)]
pub enum Output {
    #[serde(rename_all = "camelCase")]
    Jpeg {
        #[serde(default = "eighty")]
        quality: u16,
        #[serde(default)]
        progressive: bool,
        #[serde(default = "chroma_420")]
        chroma_subsampling: String,
        #[serde(default = "yes")]
        optimise_coding: bool,
    },
    #[serde(rename_all = "camelCase")]
    Png {
        #[serde(default = "six")]
        compression_level: u16,
        #[serde(default)]
        adaptive_filtering: bool,
        #[serde(default)]
        palette: bool,
        #[serde(default = "two_five_six")]
        colours: u16,
        #[serde(default = "one")]
        dither: f64,
    },
    Webp {
        /// Must be `true` — Maple's WebP encoder is lossless-only (D6).
        #[serde(default = "yes")]
        lossless: bool,
    },
    #[serde(rename_all = "camelCase")]
    Avif {
        #[serde(default = "fifty")]
        quality: u16,
        #[serde(default = "four")]
        effort: u16,
        #[serde(default)]
        lossless: bool,
        #[serde(default = "chroma_444")]
        chroma_subsampling: String,
        /// sharp's `heif()` `bitdepth`: 8 (the default, and the only depth
        /// libheif's prebuilt decoders read) or 10. 12 is a real sharp
        /// value `ravif` cannot produce and is rejected by name inside
        /// `encode_avif_opts`.
        #[serde(default = "eight")]
        bitdepth: u16,
    },
    #[serde(rename_all = "camelCase")]
    Tiff {
        #[serde(default = "lzw")]
        compression: String,
        #[serde(default = "eight")]
        bitdepth: u16,
        /// sharp's string form (F6, #3506): `"horizontal"` (default) or
        /// `"none"`. `"float"` is a real sharp value the `tiff` crate's
        /// encoder cannot produce and is rejected by name — see
        /// `predictor_from_wire`.
        #[serde(default = "horizontal")]
        predictor: String,
    },
    /// Native-size interleaved pixels, no container.
    Raw {},
}

/// Translate the wire `Output` into the `RasterOutput` the encoder takes,
/// validating every string-typed field (`chromaSubsampling`, `compression`)
/// by name. Called once per recipe, from `raster_recipe_exec::run_recipe`.
pub(crate) fn output_from_wire(output: &Output) -> Result<RasterOutput> {
    Ok(match output {
        Output::Raw {} => RasterOutput::Raw,
        Output::Jpeg {
            quality,
            progressive,
            chroma_subsampling,
            optimise_coding,
        } => RasterOutput::Jpeg(JpegOptions {
            quality: checked("quality", *quality, 1, 100)? as u8,
            progressive: *progressive,
            chroma_subsampling: ChromaSubsampling::from_wire(chroma_subsampling).ok_or_else(
                || {
                    bad(format!(
                        "unsupported JPEG chromaSubsampling '{chroma_subsampling}'"
                    ))
                },
            )?,
            optimise_coding: *optimise_coding,
        }),
        Output::Png {
            compression_level,
            adaptive_filtering,
            palette,
            colours,
            dither,
        } => RasterOutput::Png(PngOptions {
            compression_level: checked("compressionLevel", *compression_level, 0, 9)? as u8,
            adaptive_filtering: *adaptive_filtering,
            palette: *palette,
            // Checked whether or not `palette` is set, as sharp does — it
            // validates `colours` before deciding whether the palette path
            // runs at all.
            colours: checked("colours", *colours, 2, 256)?,
            dither: *dither,
        }),
        Output::Webp { lossless } => RasterOutput::Webp {
            lossless: *lossless,
        },
        Output::Avif {
            quality,
            effort,
            lossless,
            chroma_subsampling,
            bitdepth,
        } => avif_from_wire(
            checked("quality", *quality, 1, 100)? as u8,
            checked("effort", *effort, 0, 9)? as u8,
            *lossless,
            chroma_subsampling,
            u8::try_from(*bitdepth).unwrap_or(u8::MAX),
        )?,
        Output::Tiff {
            compression,
            bitdepth,
            predictor,
        } => RasterOutput::Tiff(TiffOptions {
            compression: TiffCompression::from_wire(compression).ok_or_else(|| {
                bad(format!(
                    "unsupported TIFF compression '{compression}' (none, lzw, deflate, packbits)"
                ))
            })?,
            // 8 or 16, named by `encode_tiff_opts` — a range check would
            // have to allow the gap between them, so the encoder's
            // membership test is the honest one.
            bitdepth: u8::try_from(*bitdepth).unwrap_or(u8::MAX),
            predictor: predictor_from_wire(predictor).ok_or_else(|| {
                bad(format!(
                    "unsupported TIFF predictor '{predictor}' (horizontal, none)"
                ))
            })?,
        }),
    })
}

/// sharp's TIFF `predictor` is a string (`"horizontal"` | `"none"` |
/// `"float"`); Maple's encoder only ever toggles the `tiff` crate's
/// horizontal differencing predictor on or off (see `raster_encode_tiff.rs`),
/// so the wire string collapses to that bool here. `"float"` names a real
/// sharp value the `tiff` crate cannot produce and is rejected rather than
/// silently mapped to one of the other two.
fn predictor_from_wire(s: &str) -> Option<bool> {
    match s {
        "horizontal" => Some(true),
        "none" => Some(false),
        _ => None,
    }
}

/// Split out so the `avif`-feature/no-`avif` split is one pair of small
/// functions with matching signatures — the same dual-`#[cfg]` shape
/// `export::encode_avif_rgba_with_speed` already uses — rather than an
/// inline `#[cfg]` buried in `output_from_wire`'s match arm.
#[cfg(feature = "avif")]
fn avif_from_wire(
    quality: u8,
    effort: u8,
    lossless: bool,
    chroma_subsampling: &str,
    bitdepth: u8,
) -> Result<RasterOutput> {
    Ok(RasterOutput::Avif(AvifOptions {
        quality,
        effort,
        lossless,
        bitdepth,
        chroma_subsampling: AvifChroma::from_wire(chroma_subsampling).ok_or_else(|| {
            bad(format!(
                "unsupported AVIF chromaSubsampling '{chroma_subsampling}'"
            ))
        })?,
    }))
}
#[cfg(not(feature = "avif"))]
fn avif_from_wire(
    _quality: u8,
    _effort: u8,
    _lossless: bool,
    _chroma_subsampling: &str,
    _bitdepth: u8,
) -> Result<RasterOutput> {
    Err(bad(
        "AVIF output requires raw-core's 'avif' feature".to_string()
    ))
}

#[cfg(test)]
#[path = "raster_recipe_output_tests.rs"]
mod tests;
