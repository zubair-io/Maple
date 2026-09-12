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
/// `raster_recipe_encode`'s per-format `encode_*_with_metadata` functions,
/// and `raster_recipe_exec::encode`'s capability check ahead of them).
///
/// Every field is a plain "embed exactly this, or nothing" instruction now
/// (fix-round-1, item 2) — `icc: None` embeds NO profile at all, matching
/// sharp's own default (measured: `sharp(png).jpeg().toBuffer()` →
/// `metadata().hasProfile === false`). There is no more "leave the
/// container's own default tagging alone" special case: that used to mean
/// silently embedding a 6684-byte sRGB profile even with no `metadata` block
/// at all, which sharp does not do.
#[derive(Clone, Debug, Default)]
pub struct ResolvedMetadata {
    pub exif: Option<Vec<u8>>,
    pub icc: Option<Vec<u8>>,
    pub xmp: Option<Vec<u8>>,
    pub density: Option<f64>,
}

/// sRGB — the profile `keep: true` adds when the input carries none, mirroring
/// sharp's `withMetadata()` (measured: `sharp(pngWithNoIcc).withMetadata()
/// .png().toBuffer()` → `metadata().hasProfile === true`, a ~430-byte lcms
/// sRGB profile — sharp's default `.jpeg()`/`.png()`/etc with no
/// `withMetadata()` at all embeds nothing, per the same measurement).
///
/// Hardcodes sRGB rather than the recipe's actual output primaries because
/// this schema has no `toColourspace`/output-primaries concept yet (PR-D).
/// Once it does, this default should follow the output's real primaries
/// instead — the same call-site note already exists on the PR-F branch for
/// the equivalent hardcoded-sRGB decision there; this is that same TODO.
fn default_icc() -> Vec<u8> {
    crate::icc::profile_for(crate::view::encode::TargetPrimaries::Srgb)
}

/// Assemble the metadata blocks an encoder should embed. Caller-supplied
/// blocks (`aux`-referenced) win over `keep`; an explicit `orientation`
/// rewrites whichever EXIF block survives that resolution, creating a
/// minimal one when there is none to rewrite.
///
/// `auto_oriented` is `true` when the recipe ran `Op::AutoOrient` — the
/// pixels are already rotated to match whatever Orientation the input
/// declared, so a resolved EXIF block that still says otherwise would tell a
/// second reader to rotate again. Measured against sharp:
/// `sharp(oriented6).rotate().withMetadata().jpeg()` → `metadata().orientation
/// === 1` (the EXIF block survives — `hasExif` stays `true` — just
/// neutralised, not `undefined`; that only happens with no EXIF block at
/// all). An explicit `metadata.orientation` still wins over that
/// neutralisation exactly as it would without autoOrient — also measured:
/// `sharp(oriented6).rotate().withMetadata({orientation:6}).jpeg()` →
/// `metadata().orientation === 6`, sharp does NOT force 1 over an explicit
/// value. Neutralise-then-override (rather than "regardless of an explicit
/// value", read overly literally) is what matches sharp here.
pub fn resolve_metadata(
    metadata: &RecipeMetadata,
    input: &[u8],
    aux: &[u8],
    auto_oriented: bool,
) -> Result<ResolvedMetadata> {
    let kept = if metadata.keep {
        crate::raster_meta::read_sidecars(input)
    } else {
        RasterSidecars::default()
    };
    let supplied = |field: &str, reference: Option<AuxRef>| -> Result<Option<Vec<u8>>> {
        reference
            .map(|r| {
                r.slice(aux).map(|s| s.to_vec()).map_err(|e| match e {
                    crate::error::Error::Decode { reason, .. } => crate::error::Error::Decode {
                        path: "<recipe>".into(),
                        reason: format!("metadata.{field} {reason}"),
                    },
                    other => other,
                })
            })
            .transpose()
    };
    let exif_base = supplied("exif", metadata.exif)?.or(kept.exif);
    let neutralised = if auto_oriented {
        exif_base
            .as_deref()
            .map(|block| crate::raster_meta::set_exif_orientation(block, 1))
    } else {
        exif_base
    };
    let exif = match metadata.orientation {
        Some(orientation) => Some(crate::raster_meta::set_exif_orientation(
            neutralised.as_deref().unwrap_or(&[]),
            orientation,
        )),
        None => neutralised,
    };
    // `keep` mirrors sharp's `withMetadata()`: an ICC profile already
    // present is copied through as-is, and one that's absent gets a default
    // sRGB profile added (see `default_icc`'s doc) — `keep: false` with no
    // supplied override means no ICC at all, matching sharp's own default.
    let icc = supplied("icc", metadata.icc)?
        .or_else(|| kept.icc.clone().or_else(|| metadata.keep.then(default_icc)));
    let xmp = supplied("xmp", metadata.xmp)?.or(kept.xmp);
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
        let resolved = resolve_metadata(&metadata, &source, &aux, false).unwrap();
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
        let resolved = resolve_metadata(&metadata, &source, &[], false).unwrap();
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
        let resolved = resolve_metadata(&metadata, &[], &[], false).unwrap();
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
        let err = resolve_metadata(&metadata, &[], &[1, 2, 3], false).unwrap_err();
        let message = format!("{err}");
        assert!(message.contains("metadata.icc"), "got: {message}");
        assert!(message.contains("99"), "got: {message}");
        assert!(message.contains("3-byte"), "got: {message}");
    }

    #[test]
    fn an_out_of_range_exif_reference_names_that_field_too() {
        let metadata = RecipeMetadata {
            exif: Some(AuxRef { off: 0, len: 50 }),
            ..Default::default()
        };
        let err = resolve_metadata(&metadata, &[], &[1, 2, 3], false).unwrap_err();
        assert!(format!("{err}").contains("metadata.exif"), "got: {err}");
    }

    // ---- item 2: default ICC (fix-round-1) ----

    #[test]
    fn no_metadata_block_embeds_no_icc_at_all() {
        // Matches sharp's own default: sharp(png).jpeg().toBuffer() ->
        // metadata().hasProfile === false — measured in the fix round's
        // report.
        let resolved = resolve_metadata(&RecipeMetadata::default(), &[], &[], false).unwrap();
        assert!(resolved.icc.is_none());
    }

    #[test]
    fn keep_with_no_input_icc_adds_the_default_srgb_profile() {
        // Matches sharp's withMetadata(): sharp(pngWithNoIcc).withMetadata()
        // .png().toBuffer() -> metadata().hasProfile === true (measured).
        let source = crate::jpeg::encode(2, 2, &[90u8; 2 * 2 * 3], 85).unwrap();
        let metadata = RecipeMetadata {
            keep: true,
            ..Default::default()
        };
        let resolved = resolve_metadata(&metadata, &source, &[], false).unwrap();
        assert_eq!(resolved.icc.as_deref(), Some(default_icc().as_slice()));
    }

    #[test]
    fn keep_with_a_real_input_icc_copies_it_through_unchanged() {
        let icc = crate::icc::profile_for(crate::view::encode::TargetPrimaries::P3);
        let mut source = crate::jpeg::encode(2, 2, &[90u8; 2 * 2 * 3], 85).unwrap();
        // Splice a single-chunk APP2 ICC segment in after the SOI.
        let mut payload = b"ICC_PROFILE\0".to_vec();
        payload.push(1);
        payload.push(1);
        payload.extend_from_slice(&icc);
        let mut segment = vec![0xFFu8, 0xE2];
        segment.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        segment.extend_from_slice(&payload);
        source.splice(2..2, segment);
        let metadata = RecipeMetadata {
            keep: true,
            ..Default::default()
        };
        let resolved = resolve_metadata(&metadata, &source, &[], false).unwrap();
        assert_eq!(resolved.icc.as_deref(), Some(icc.as_slice()));
    }

    // ---- item 3: autoOrient neutralises a kept Orientation tag ----

    /// A minimal IFD0 with a single Orientation entry set to `value` — the
    /// same 26-byte shape `raster_meta_tests.rs`'s `exif_with_orientation`
    /// uses, duplicated locally for the same reason `jpeg_with_exif` is
    /// (that fixture is `pub(super)` to the `raster_meta` module tree).
    fn exif_with_orientation(value: u16) -> Vec<u8> {
        let mut tiff = vec![0u8; 26];
        tiff[..2].copy_from_slice(b"II");
        tiff[2..4].copy_from_slice(&42u16.to_le_bytes());
        tiff[4..8].copy_from_slice(&8u32.to_le_bytes());
        tiff[8..10].copy_from_slice(&1u16.to_le_bytes());
        tiff[10..12].copy_from_slice(&0x0112u16.to_le_bytes());
        tiff[12..14].copy_from_slice(&3u16.to_le_bytes());
        tiff[14..18].copy_from_slice(&1u32.to_le_bytes());
        tiff[18..20].copy_from_slice(&value.to_le_bytes());
        tiff
    }

    #[test]
    fn auto_oriented_neutralises_the_kept_orientation_to_one() {
        // Measured: sharp(oriented6).rotate().withMetadata().jpeg() ->
        // metadata().orientation === 1, hasExif still true.
        let source = jpeg_with_exif(&exif_with_orientation(6));
        let metadata = RecipeMetadata {
            keep: true,
            ..Default::default()
        };
        let resolved = resolve_metadata(&metadata, &source, &[], true).unwrap();
        assert!(
            resolved.exif.is_some(),
            "the EXIF block itself must survive"
        );
        let orientation = resolved
            .exif
            .as_deref()
            .and_then(crate::raster::exif_orientation_from_block);
        assert_eq!(orientation, Some(1));
    }

    #[test]
    fn an_explicit_orientation_still_wins_after_auto_orient() {
        // Measured: sharp(oriented6).rotate().withMetadata({orientation:6})
        // .jpeg() -> metadata().orientation === 6 — the explicit value beats
        // the neutralise-to-1 default.
        let source = jpeg_with_exif(&exif_with_orientation(6));
        let metadata = RecipeMetadata {
            keep: true,
            orientation: Some(6),
            ..Default::default()
        };
        let resolved = resolve_metadata(&metadata, &source, &[], true).unwrap();
        let orientation = resolved
            .exif
            .as_deref()
            .and_then(crate::raster::exif_orientation_from_block);
        assert_eq!(orientation, Some(6));
    }

    #[test]
    fn auto_orient_without_keep_leaves_no_exif_to_neutralise() {
        // Measured: sharp(oriented6).rotate().jpeg() (no withMetadata) ->
        // hasExif === false, orientation === undefined.
        let source = jpeg_with_exif(&exif_with_orientation(6));
        let resolved = resolve_metadata(&RecipeMetadata::default(), &source, &[], true).unwrap();
        assert!(resolved.exif.is_none());
    }
}
