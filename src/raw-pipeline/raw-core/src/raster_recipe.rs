//! The Maple raster recipe: a versioned JSON document describing one ordered
//! pipeline — where the pixels come from, which ops to run, what to encode.
//!
//! Why JSON and not a packed binary struct: `serde_json` is already a
//! raw-core dependency; a malformed recipe produces a readable parse error
//! instead of a misaligned struct read; and the recipe is built once per
//! image (a few hundred bytes), nowhere near a per-pixel path. Binary
//! payloads the recipe needs — composite overlay pixels, a supplied ICC or
//! EXIF block — travel in a separate flat `aux` buffer and are referenced by
//! `{ "off", "len" }`.
//!
//! `v` stays 1 for the whole of Tier 2. Adding an op variant is
//! backward-compatible (an old recipe still parses); the version only moves
//! if an existing field changes meaning.

use crate::error::{Error, Result};
use crate::raster_recipe_filter::{BlurOp, ConvolveOp, MedianOp, SharpenOp, ThresholdOp};
use serde::Deserialize;

/// Schema version this build understands. See the module doc.
pub const RECIPE_VERSION: u32 = 1;

/// A `{ off, len }` window into the flat `aux` buffer passed beside the recipe.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuxRef {
    pub off: usize,
    pub len: usize,
}

impl AuxRef {
    /// Borrow the window, or fail with a message naming the bounds — a
    /// hostile or buggy caller must not index past the buffer.
    pub fn slice<'a>(&self, aux: &'a [u8]) -> Result<&'a [u8]> {
        let end = self
            .off
            .checked_add(self.len)
            .ok_or_else(|| Error::Decode {
                path: "<memory>".into(),
                reason: format!("aux reference {}+{} overflows", self.off, self.len),
            })?;
        aux.get(self.off..end).ok_or_else(|| Error::Decode {
            path: "<memory>".into(),
            reason: format!(
                "aux reference {}..{end} is outside the {}-byte aux buffer",
                self.off,
                aux.len()
            ),
        })
    }
}

/// Dimensions for a caller-decoded pixel buffer.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawSpec {
    pub width: u32,
    pub height: u32,
    pub channels: u8,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum RecipeInput {
    /// The input buffer is a JPEG/PNG/WebP/TIFF/AVIF file.
    ///
    /// An empty struct variant, not a unit variant: serde only honours
    /// `deny_unknown_fields` on the struct-variant deserialization path, so
    /// a bare unit variant here would silently accept
    /// `{"kind":"encoded","extra":true}` (#3505 fix-round-2). The wire form
    /// is unaffected — `{"kind":"encoded"}` still parses.
    Encoded {},
    /// The input buffer is interleaved 8-bit pixels.
    Raw {
        width: u32,
        height: u32,
        channels: u8,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Layer {
    pub aux: AuxRef,
    /// Present when the layer is raw pixels rather than an encoded file.
    #[serde(default)]
    pub raw: Option<RawSpec>,
    #[serde(default)]
    pub left: Option<i64>,
    #[serde(default)]
    pub top: Option<i64>,
    #[serde(default = "centre")]
    pub gravity: String,
    #[serde(default = "over")]
    pub blend: String,
    #[serde(default)]
    pub tile: bool,
}

fn centre() -> String {
    "centre".to_string()
}
fn over() -> String {
    "over".to_string()
}
fn cover() -> String {
    "cover".to_string()
}
fn lanczos3() -> String {
    "lanczos3".to_string()
}
fn opaque_black() -> [u8; 4] {
    [0, 0, 0, 255]
}
/// `one`, `ten` and `yes` are `pub(crate)` because
/// `raster_recipe_filter.rs`'s wire structs (moved out per #3504 task E5
/// controller ruling (d)) default `m1`, `y2` and `greyscale` to the same
/// three values `ensureAlpha`, `trim` and `negate` do here — one definition
/// each, not a second copy over there.
pub(crate) fn one() -> f64 {
    1.0
}
fn background_mode() -> String {
    "background".to_string()
}
pub(crate) fn ten() -> f64 {
    10.0
}
fn unit_gain() -> [f64; 3] {
    [1.0, 1.0, 1.0]
}
pub(crate) fn yes() -> bool {
    true
}
/// `normalise`'s default upper percentile. 99, not 100: sharp's own default
/// is 99, and 100 is not merely a different value but a different RULE —
/// `upper == 100` makes sharp take the band's true maximum instead of a
/// percentile, so nothing clips at the top (#3503 review I7).
fn ninety_nine() -> f64 {
    99.0
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum Op {
    /// Empty struct variant rather than unit — see `RecipeInput::Encoded`'s
    /// doc for why (#3505 fix-round-2).
    AutoOrient {},
    /// All five fits, all nine positions and the six kernels are wired up
    /// (see `raster_recipe_exec::apply_op`). sharp's `entropy`/`attention`
    /// position strategies and `mks2013`/`mks2021` kernels are not
    /// implemented — a recipe naming one of those fails by name at
    /// execution rather than silently falling back to something else.
    #[serde(rename_all = "camelCase")]
    Resize {
        #[serde(default)]
        width: u32,
        #[serde(default)]
        height: u32,
        #[serde(default = "cover")]
        fit: String,
        #[serde(default = "centre")]
        position: String,
        #[serde(default = "lanczos3")]
        kernel: String,
        #[serde(default)]
        without_enlargement: bool,
        #[serde(default)]
        without_reduction: bool,
        #[serde(default = "opaque_black")]
        background: [u8; 4],
    },
    Flatten {
        /// The alpha byte (index 3) is ignored: `flatten` always yields an
        /// opaque result (sharp does the same — `background` there is a
        /// 3-channel colour too; this schema keeps it 4-wide only so it
        /// shares a wire type with `Layer`/other `background` fields).
        #[serde(default = "opaque_black")]
        background: [u8; 4],
    },
    EnsureAlpha {
        #[serde(default = "one")]
        alpha: f64,
    },
    /// Empty struct variant rather than unit — see `RecipeInput::Encoded`'s
    /// doc for why (#3505 fix-round-2).
    RemoveAlpha {},
    Composite {
        layers: Vec<Layer>,
    },
    /// sharp's `extract({ left, top, width, height })`.
    Extract {
        left: u32,
        top: u32,
        width: u32,
        height: u32,
    },
    /// sharp's `extend`. Only `extendWith: "background"` is implemented
    /// (#3501) — the other modes (`copy`, `repeat`, `mirror`) are accepted by
    /// the schema so a typo-free recipe still parses, but rejected by name at
    /// execution rather than silently treated as `background`.
    #[serde(rename_all = "camelCase")]
    Extend {
        #[serde(default)]
        top: u32,
        #[serde(default)]
        bottom: u32,
        #[serde(default)]
        left: u32,
        #[serde(default)]
        right: u32,
        #[serde(default = "background_mode")]
        extend_with: String,
        #[serde(default = "opaque_black")]
        background: [u8; 4],
    },
    /// sharp's `rotate(angle, { background })`.
    Rotate {
        angle: f64,
        #[serde(default = "opaque_black")]
        background: [u8; 4],
    },
    /// Empty struct variant rather than unit — see `RecipeInput::Encoded`'s
    /// doc for why (#3505 fix-round-2).
    Flip {},
    /// Empty struct variant rather than unit — see `RecipeInput::Encoded`'s
    /// doc for why (#3505 fix-round-2).
    Flop {},
    /// sharp's `trim`, minus `lineArt` — a different libvips algorithm not in
    /// #3501. Accepted by the schema so a typo-free recipe still parses;
    /// `true` is rejected by name at execution rather than silently ignored.
    #[serde(rename_all = "camelCase")]
    Trim {
        #[serde(default)]
        background: Option<[u8; 4]>,
        #[serde(default = "ten")]
        threshold: f64,
        #[serde(default)]
        margin: u32,
        #[serde(default)]
        line_art: bool,
    },
    /// Empty struct variant rather than unit — see `RecipeInput::Encoded`'s
    /// doc for why (#3505 fix-round-2). Rec.709 luma taken in linear light
    /// (`RasterImage::greyscale` — #3503 controller ruling reverses the
    /// plan's D3 note for this one op; `gamma`/`linear` below genuinely do
    /// stay on the encoded samples).
    Greyscale {},
    /// `out = 255 * (in/255)^exponent` on the encoded samples — a PLAIN
    /// power law, unlike libvips' `vips_gamma(image, exponent)`, which
    /// computes `x ** (1/exponent)`. The builder emits this op twice around
    /// `resize` for sharp's `gamma(g, gammaOut)`: `exponent: g` before
    /// (nets to `x ** g` through `vips_gamma`'s reciprocal, matching
    /// sharp's own pre-resize `Gamma(image, 1/g)` call) and
    /// `exponent: 1/gammaOut` after (nets to `x ** (1/gammaOut)`, matching
    /// sharp's post-resize `Gamma(image, gammaOut)` call) — see
    /// `builder-colour.ts`'s `pushGamma` (#3503 fix-round-2). The schema
    /// only needs the one generic op either way.
    Gamma {
        exponent: f64,
    },
    /// `out = a*in + b` per channel on the encoded samples (libvips
    /// `vips_linear`, uchar cast).
    Linear {
        #[serde(default = "unit_gain")]
        a: [f64; 3],
        #[serde(default)]
        b: [f64; 3],
    },
    /// `out = 255 - in`. `alpha` is sharp's `negate({ alpha })`, default
    /// `true`.
    Negate {
        #[serde(default = "yes")]
        alpha: bool,
    },
    /// Stretch L* so the `lower`/`upper` percentiles land on 0/100
    /// (`RasterImage::normalise`, via CIELAB).
    Normalise {
        #[serde(default = "one")]
        lower: f64,
        #[serde(default = "ninety_nine")]
        upper: f64,
    },
    /// Scale L*/C* and rotate hue in CIELCh (`RasterImage::modulate`).
    Modulate {
        #[serde(default = "one")]
        brightness: f64,
        #[serde(default = "one")]
        saturation: f64,
        #[serde(default)]
        hue: f64,
        #[serde(default)]
        lightness: f64,
    },
    /// Keep each pixel's own lightness, take the chroma from `rgb`
    /// (`RasterImage::tint`). Alpha is not part of the wire colour — the
    /// builder resolves a `Colour`'s alpha field and drops it before
    /// pushing this op.
    Tint {
        rgb: [u8; 3],
    },
    /// Rotate the primaries to `space` and select the ICC profile the
    /// encoder tags the file with (`RasterImage::to_colourspace` +
    /// `RasterEncodeOptions::primaries`). Only `srgb`/`display-p3`/`p3` are
    /// accepted — anything else, including libvips interpretation names
    /// like `b-w`/`cmyk`/`lab`, is rejected by name
    /// (`raster_recipe_colour::primaries_from_wire`).
    #[serde(rename_all = "camelCase")]
    ToColourspace {
        space: String,
    },
    /// #3504 task E4; fields moved to `raster_recipe_filter::BlurOp` per
    /// task E5 controller ruling (d), to keep this file under budget — see
    /// that type for the wire semantics (sharp's fast 3x3 box vs. Gaussian,
    /// and why `precision` is deliberately not part of this schema).
    Blur(BlurOp),
    /// #3504 task E4; fields moved to `raster_recipe_filter::SharpenOp` —
    /// see that type for the wire semantics (the fast vs. mask-based path,
    /// and the `m1`/`m2`/`x1`/`y2`/`y3` defaults).
    Sharpen(SharpenOp),
    /// #3504 task E4; fields moved to `raster_recipe_filter::MedianOp`.
    Median(MedianOp),
    /// #3504 task E4; fields moved to `raster_recipe_filter::ThresholdOp` —
    /// see that type for why the American `grayscale` spelling is rejected
    /// on this wire rather than accepted as an alias.
    Threshold(ThresholdOp),
    /// #3504 task E4; fields moved to `raster_recipe_filter::ConvolveOp` —
    /// see that type for why `scale` is `Option<f64>` rather than a plain
    /// `f64` (the absent-vs-explicit-0 distinction sharp's own API needs).
    Convolve(ConvolveOp),
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(tag = "format", rename_all = "lowercase", deny_unknown_fields)]
pub enum Output {
    Jpeg {
        #[serde(default)]
        quality: u8,
    },
    /// Empty struct variant rather than unit — see `RecipeInput::Encoded`'s
    /// doc for why (#3505 fix-round-2).
    Png {},
    Webp {},
    Avif {
        #[serde(default)]
        quality: u8,
        /// sharp's scale, 0 (fastest) ..= 9 (slowest). Mapped to rav1e speed
        /// `9 - effort + 1` by the executor.
        #[serde(default)]
        effort: u8,
    },
    Tiff {},
    /// Native-size interleaved RGB8/RGBA8 straight out — no container.
    Raw {},
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Recipe {
    pub v: u32,
    pub input: RecipeInput,
    #[serde(default)]
    pub ops: Vec<Op>,
    pub output: Output,
}

/// A recipe-level error naming the offending option and value. Shared by
/// `raster_recipe_exec` and `raster_recipe_colour` so every validation error
/// in the pipeline is reported the same way.
pub(crate) fn bad(reason: String) -> Error {
    Error::Decode {
        path: "<recipe>".into(),
        reason,
    }
}

pub fn parse_recipe(json: &str) -> Result<Recipe> {
    let recipe: Recipe = serde_json::from_str(json).map_err(|e| Error::Decode {
        path: "<recipe>".into(),
        reason: format!("recipe parse failed: {e}"),
    })?;
    if recipe.v != RECIPE_VERSION {
        return Err(Error::Decode {
            path: "<recipe>".into(),
            reason: format!(
                "recipe version {} is not supported (this build speaks version {RECIPE_VERSION})",
                recipe.v
            ),
        });
    }
    Ok(recipe)
}

// Tests live in the sibling `raster_recipe_tests.rs`, and the filter
// variants' wire structs in `raster_recipe_filter.rs`, so this file stays
// under the 400-LOC budget now that #3503's eight colour `Op` variants and
// #3504's five filter ones have landed. Same `#[path]` split pattern as
// `view/encode.rs`.
#[cfg(test)]
#[path = "raster_recipe_tests.rs"]
mod tests;
