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
fn one() -> f64 {
    1.0
}
fn background_mode() -> String {
    "background".to_string()
}
fn ten() -> f64 {
    10.0
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum Op {
    /// Empty struct variant rather than unit — see `RecipeInput::Encoded`'s
    /// doc for why (#3505 fix-round-2).
    AutoOrient {},
    /// Only the three Tier-1 fits (`cover`/`fill`/`inside`) and the three
    /// Tier-1 kernels are wired up (see `raster_recipe_exec::apply_op`).
    /// sharp's `position`, `withoutReduction` and `background` fields are
    /// deliberately NOT part of this v1 schema — PR-C (#3502) re-adds them
    /// once `raster::ResizeOptions` can honour them; adding a field here is
    /// backward-compatible, so there is no version cost to waiting.
    #[serde(rename_all = "camelCase")]
    Resize {
        #[serde(default)]
        width: u32,
        #[serde(default)]
        height: u32,
        #[serde(default = "cover")]
        fit: String,
        #[serde(default = "lanczos3")]
        kernel: String,
        #[serde(default)]
        without_enlargement: bool,
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

#[cfg(test)]
#[path = "raster_recipe_tests.rs"]
mod tests;
