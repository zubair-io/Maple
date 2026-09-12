//! The recipe's `metadata` block (#3507): what to keep from the input's own
//! EXIF/ICC/XMP, what to override with caller-supplied blocks, and what EXIF
//! Orientation value to (over)write.
//!
//! Kept apart from `raster_recipe.rs`'s other wire types and from
//! `raster_recipe_exec.rs`'s execution: this branch has not yet received the
//! PR-C/D/E per-family executor split, so isolating the metadata
//! parsing/resolution here (rather than folding it into either of those
//! files) keeps that later rebase from having to untangle it back out.
//!
//! Absent `metadata` block = strip everything, which is sharp's own default
//! (`keepMetadata()`/`withMetadata()` are both opt-in).

use crate::error::Result;
use crate::raster_meta::RasterSidecars;
use crate::raster_recipe::AuxRef;
use serde::Deserialize;

/// What to do with the input's metadata.
#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecipeMetadata {
    /// Copy EXIF, ICC and XMP from the input (sharp's `keepMetadata`).
    #[serde(default)]
    pub keep: bool,
    /// Write this EXIF Orientation value, creating an EXIF block if the
    /// resolved input carries none.
    #[serde(default)]
    pub orientation: Option<u16>,
    /// Pixels-per-inch to tag the output with. `None` leaves each output
    /// container's own default density tagging (or lack of one) alone.
    #[serde(default)]
    pub density: Option<f64>,
    /// Caller-supplied EXIF block, in the `aux` buffer. Wins over `keep`.
    #[serde(default)]
    pub exif: Option<AuxRef>,
    /// Caller-supplied ICC profile, in the `aux` buffer. Wins over `keep`.
    #[serde(default)]
    pub icc: Option<AuxRef>,
    /// Caller-supplied XMP packet, in the `aux` buffer. Wins over `keep`.
    #[serde(default)]
    pub xmp: Option<AuxRef>,
}

/// Metadata blocks resolved and ready to hand to an encoder (#3507; see
/// `raster_recipe_exec`'s per-format `encode_*_with_metadata` functions).
///
/// `exif`/`xmp`: `None` means embed nothing. `icc`: `None` means leave each
/// output container's own existing default profile tagging alone (every
/// format this crate encodes already tags an untagged output as sRGB except
/// WebP, which tags none by default — `metadata.icc`, when set, overrides
/// that default either way); `Some` means embed exactly these bytes instead.
#[derive(Clone, Debug, Default)]
pub struct ResolvedMetadata {
    pub exif: Option<Vec<u8>>,
    pub icc: Option<Vec<u8>>,
    pub xmp: Option<Vec<u8>>,
    pub density: Option<f64>,
}

/// Assemble the metadata blocks an encoder should embed. Caller-supplied
/// blocks (`aux`-referenced) win over `keep`; an explicit `orientation`
/// rewrites whichever EXIF block survives that resolution, creating a
/// minimal one when there is none to rewrite.
pub fn resolve_metadata(
    metadata: &RecipeMetadata,
    input: &[u8],
    aux: &[u8],
) -> Result<ResolvedMetadata> {
    let kept = if metadata.keep {
        crate::raster_meta::read_sidecars(input)
    } else {
        RasterSidecars::default()
    };
    let supplied = |reference: Option<AuxRef>| -> Result<Option<Vec<u8>>> {
        reference
            .map(|r| r.slice(aux).map(|s| s.to_vec()))
            .transpose()
    };
    let exif_base = supplied(metadata.exif)?.or(kept.exif);
    let exif = match metadata.orientation {
        Some(orientation) => Some(crate::raster_meta::set_exif_orientation(
            exif_base.as_deref().unwrap_or(&[]),
            orientation,
        )),
        None => exif_base,
    };
    let icc = supplied(metadata.icc)?.or(kept.icc);
    let xmp = supplied(metadata.xmp)?.or(kept.xmp);
    Ok(ResolvedMetadata {
        exif,
        icc,
        xmp,
        density: metadata.density,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::raster_recipe::parse_recipe;

    /// A minimal IFD0 with a single Orientation entry set to 1 — the same
    /// shape `raster_meta_tests::EXIF_TIFF` uses, duplicated locally since
    /// that fixture is `pub(super)` to the `raster_meta` module tree, not
    /// reachable from here.
    const EXIF_TIFF: &[u8] = b"II\x2a\x00\x08\x00\x00\x00\x00\x00";

    /// A tiny baseline JPEG with `exif` spliced in as an APP1 `Exif\0\0`
    /// segment right after the SOI, mirroring `raster_meta_tests.rs`'s own
    /// `jpeg_segment` pattern.
    fn jpeg_with_exif(exif: &[u8]) -> Vec<u8> {
        let rgb = vec![90u8; 2 * 2 * 3];
        let base = crate::jpeg::encode(2, 2, &rgb, 85).unwrap();
        let mut payload = b"Exif\0\0".to_vec();
        payload.extend_from_slice(exif);
        let mut segment = vec![0xFFu8, 0xE1];
        segment.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        segment.extend_from_slice(&payload);
        let mut out = base[..2].to_vec();
        out.extend_from_slice(&segment);
        out.extend_from_slice(&base[2..]);
        out
    }

    fn parse_metadata(json_metadata: &str) -> RecipeMetadata {
        let recipe = parse_recipe(&format!(
            r#"{{"v":1,"input":{{"kind":"encoded"}},"ops":[],"output":{{"format":"jpeg"}},"metadata":{json_metadata}}}"#
        ))
        .unwrap();
        recipe.metadata
    }

    #[test]
    fn absent_metadata_defaults_to_strip_everything() {
        let recipe = parse_recipe(
            r#"{"v":1,"input":{"kind":"encoded"},"ops":[],"output":{"format":"jpeg"}}"#,
        )
        .unwrap();
        assert!(!recipe.metadata.keep);
        assert!(recipe.metadata.orientation.is_none());
        assert!(recipe.metadata.exif.is_none());
    }

    #[test]
    fn keep_and_orientation_parse() {
        let m = parse_metadata(r#"{"keep":true,"orientation":6,"density":72.0}"#);
        assert!(m.keep);
        assert_eq!(m.orientation, Some(6));
        assert_eq!(m.density, Some(72.0));
    }

    #[test]
    fn aux_references_parse() {
        let m = parse_metadata(r#"{"exif":{"off":0,"len":4},"icc":{"off":4,"len":8}}"#);
        assert_eq!(m.exif.unwrap().len, 4);
        assert_eq!(m.icc.unwrap().len, 8);
        assert!(m.xmp.is_none());
    }

    #[test]
    fn a_stray_key_is_named_in_the_error() {
        let err = parse_recipe(
            r#"{"v":1,"input":{"kind":"encoded"},"ops":[],"output":{"format":"jpeg"},
                "metadata":{"keep":true,"zzzStray":1}}"#,
        )
        .unwrap_err();
        assert!(format!("{err}").contains("zzzStray"), "got: {err}");
    }

    #[test]
    fn supplied_blocks_win_over_keep() {
        // A JPEG carrying its own EXIF, so `keep` alone would surface it.
        let source = jpeg_with_exif(EXIF_TIFF);
        let aux = b"supplied-exif-block".to_vec();
        let metadata = RecipeMetadata {
            keep: true,
            exif: Some(AuxRef {
                off: 0,
                len: aux.len(),
            }),
            ..Default::default()
        };
        let resolved = resolve_metadata(&metadata, &source, &aux).unwrap();
        assert_eq!(resolved.exif.as_deref(), Some(aux.as_slice()));
    }

    #[test]
    fn orientation_rewrites_a_kept_exif_block() {
        let source = jpeg_with_exif(EXIF_TIFF);
        let metadata = RecipeMetadata {
            keep: true,
            orientation: Some(6),
            ..Default::default()
        };
        let resolved = resolve_metadata(&metadata, &source, &[]).unwrap();
        let orientation = resolved
            .exif
            .as_deref()
            .and_then(crate::raster::exif_orientation_from_block);
        assert_eq!(orientation, Some(6));
    }

    #[test]
    fn orientation_creates_an_exif_block_when_there_is_none_to_rewrite() {
        let metadata = RecipeMetadata {
            orientation: Some(3),
            ..Default::default()
        };
        let resolved = resolve_metadata(&metadata, &[], &[]).unwrap();
        let orientation = resolved
            .exif
            .as_deref()
            .and_then(crate::raster::exif_orientation_from_block);
        assert_eq!(orientation, Some(3));
    }

    #[test]
    fn an_out_of_range_aux_reference_names_the_bounds() {
        let metadata = RecipeMetadata {
            icc: Some(AuxRef { off: 0, len: 99 }),
            ..Default::default()
        };
        let err = resolve_metadata(&metadata, &[], &[1, 2, 3]).unwrap_err();
        let message = format!("{err}");
        assert!(message.contains("99"), "got: {message}");
        assert!(message.contains("3-byte"), "got: {message}");
    }
}
