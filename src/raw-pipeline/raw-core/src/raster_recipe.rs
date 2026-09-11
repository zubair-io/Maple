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
    Encoded,
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

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum Op {
    AutoOrient,
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
    RemoveAlpha,
    Composite {
        layers: Vec<Layer>,
    },
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(tag = "format", rename_all = "lowercase", deny_unknown_fields)]
pub enum Output {
    Jpeg {
        #[serde(default)]
        quality: u8,
    },
    Png,
    Webp,
    Avif {
        #[serde(default)]
        quality: u8,
        /// sharp's scale, 0 (fastest) ..= 9 (slowest). Mapped to rav1e speed
        /// `9 - effort + 1` by the executor.
        #[serde(default)]
        effort: u8,
    },
    Tiff,
    /// Native-size interleaved RGB8/RGBA8 straight out — no container.
    Raw,
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
mod tests {
    use super::*;

    #[test]
    fn parses_a_minimal_encoded_to_jpeg_recipe() {
        let r = parse_recipe(r#"{"v":1,"input":{"kind":"encoded"},"ops":[],"output":{"format":"jpeg","quality":82}}"#).unwrap();
        assert_eq!(r.v, 1);
        assert!(matches!(r.input, RecipeInput::Encoded));
        assert!(r.ops.is_empty());
        assert!(matches!(r.output, Output::Jpeg { quality: 82 }));
    }

    #[test]
    fn parses_raw_input_dimensions() {
        let r = parse_recipe(
            r#"{"v":1,"input":{"kind":"raw","width":4,"height":2,"channels":4},"ops":[],"output":{"format":"png"}}"#,
        )
        .unwrap();
        assert!(matches!(
            r.input,
            RecipeInput::Raw {
                width: 4,
                height: 2,
                channels: 4
            }
        ));
    }

    #[test]
    fn resize_defaults_match_sharp() {
        let r = parse_recipe(
            r#"{"v":1,"input":{"kind":"encoded"},"ops":[{"op":"resize","width":10,"height":10}],"output":{"format":"png"}}"#,
        )
        .unwrap();
        match &r.ops[0] {
            Op::Resize {
                fit,
                kernel,
                without_enlargement,
                ..
            } => {
                assert_eq!(fit, "cover");
                assert_eq!(kernel, "lanczos3");
                assert!(!without_enlargement);
            }
            other => panic!("expected a resize op, got {other:?}"),
        }
    }

    #[test]
    fn a_typo_d_field_is_named_in_the_error() {
        let err = parse_recipe(
            r#"{"v":1,"input":{"kind":"encoded"},"ops":[{"op":"resize","wdth":10}],"output":{"format":"png"}}"#,
        )
        .unwrap_err();
        assert!(format!("{err}").contains("wdth"), "got: {err}");
    }

    #[test]
    fn parses_a_composite_layer_with_an_aux_reference() {
        let r = parse_recipe(
            r#"{"v":1,"input":{"kind":"encoded"},"ops":[{"op":"composite","layers":[
                 {"aux":{"off":0,"len":16},"raw":{"width":2,"height":2,"channels":4},"left":3,"top":4,"blend":"multiply"}]}],
               "output":{"format":"png"}}"#,
        )
        .unwrap();
        let Op::Composite { layers } = &r.ops[0] else {
            panic!("expected a composite op");
        };
        assert_eq!(layers[0].aux.len, 16);
        assert_eq!(layers[0].left, Some(3));
        assert_eq!(layers[0].blend, "multiply");
        assert_eq!(layers[0].gravity, "centre");
        assert!(!layers[0].tile);
    }

    #[test]
    fn an_unknown_op_is_named_in_the_error() {
        let err = parse_recipe(
            r#"{"v":1,"input":{"kind":"encoded"},"ops":[{"op":"posterise"}],"output":{"format":"png"}}"#,
        )
        .unwrap_err();
        assert!(format!("{err}").contains("posterise"), "got: {err}");
    }

    #[test]
    fn a_future_schema_version_is_rejected() {
        let err = parse_recipe(
            r#"{"v":2,"input":{"kind":"encoded"},"ops":[],"output":{"format":"png"}}"#,
        )
        .unwrap_err();
        assert!(format!("{err}").contains("version 2"), "got: {err}");
    }
}
