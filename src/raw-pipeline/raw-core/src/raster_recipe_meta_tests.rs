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
    let recipe =
        parse_recipe(r#"{"v":1,"input":{"kind":"encoded"},"ops":[],"output":{"format":"jpeg"}}"#)
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
    assert!(!resolved.icc_requested);
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
    // fix-round-2: the default fill is a convenience, not a request —
    // an encoder that can't carry ICC (AVIF) must be allowed to skip it
    // silently rather than error, which `require_supported` only does
    // when this flag is false.
    assert!(
        !resolved.icc_requested,
        "keep's own default sRGB fill must not count as a caller request"
    );
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
    assert!(
        !resolved.icc_requested,
        "`keep`'s sweep of the input's own profile is not a named request \
         (#3507 final fix wave, item 6) — a container that can't carry it \
         drops it silently, as sharp does"
    );
}

#[test]
fn a_supplied_icc_is_requested() {
    let icc = crate::icc::profile_for(crate::view::encode::TargetPrimaries::P3);
    let metadata = RecipeMetadata {
        icc: Some(AuxRef {
            off: 0,
            len: icc.len(),
        }),
        ..Default::default()
    };
    let resolved = resolve_metadata(&metadata, &[], &icc, false).unwrap();
    assert_eq!(resolved.icc.as_deref(), Some(icc.as_slice()));
    assert!(resolved.icc_requested);
}

// ---- fix-round-1 item 2: named profiles (`iccName`, package `withIccProfile('srgb'|'p3')`) ----

#[test]
fn icc_name_srgb_resolves_to_the_built_in_srgb_profile() {
    let metadata = RecipeMetadata {
        icc_name: Some("srgb".into()),
        ..Default::default()
    };
    let resolved = resolve_metadata(&metadata, &[], &[], false).unwrap();
    assert_eq!(resolved.icc.as_deref(), Some(default_icc().as_slice()));
    assert!(
        resolved.icc_requested,
        "an explicit iccName IS a real request"
    );
}

#[test]
fn icc_name_p3_resolves_to_the_built_in_p3_profile() {
    let metadata = RecipeMetadata {
        icc_name: Some("p3".into()),
        ..Default::default()
    };
    let resolved = resolve_metadata(&metadata, &[], &[], false).unwrap();
    let p3 = crate::icc::profile_for(crate::view::encode::TargetPrimaries::P3);
    assert_eq!(resolved.icc.as_deref(), Some(p3.as_slice()));
}

#[test]
fn an_unknown_icc_name_is_a_named_error() {
    let metadata = RecipeMetadata {
        icc_name: Some("cmyk".into()),
        ..Default::default()
    };
    let err = resolve_metadata(&metadata, &[], &[], false).unwrap_err();
    assert!(format!("{err}").contains("metadata.iccName"), "got: {err}");
}

#[test]
fn a_supplied_icc_aux_ref_wins_over_icc_name() {
    let icc = crate::icc::profile_for(crate::view::encode::TargetPrimaries::P3);
    let metadata = RecipeMetadata {
        icc: Some(AuxRef {
            off: 0,
            len: icc.len(),
        }),
        icc_name: Some("srgb".into()),
        ..Default::default()
    };
    let resolved = resolve_metadata(&metadata, &[], &icc, false).unwrap();
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

// ---- final fix wave, item 6: named requests vs `keep`'s own sweep ----

#[test]
fn a_kept_exif_or_xmp_block_is_not_a_named_request() {
    // `keepMetadata()`/`withMetadata()` set `keep` for every block at once,
    // so a block the caller never mentioned must not hold the target
    // container to anything (#3507 final fix wave, item 6).
    let source = {
        let mut jpeg = crate::jpeg::encode(2, 2, &[90u8; 2 * 2 * 3], 85).unwrap();
        let exif = [
            b"Exif\0\0".as_slice(),
            b"II\x2a\x00\x08\x00\x00\x00\x00\x00",
        ]
        .concat();
        let mut segment = vec![0xFFu8, 0xE1];
        segment.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
        segment.extend_from_slice(&exif);
        jpeg.splice(2..2, segment);
        jpeg
    };
    let metadata = RecipeMetadata {
        keep: true,
        ..Default::default()
    };
    let resolved = resolve_metadata(&metadata, &source, &[], false).unwrap();
    assert!(resolved.exif.is_some(), "the block is still kept");
    assert!(!resolved.exif_requested);
    assert!(!resolved.xmp_requested);
}

#[test]
fn a_supplied_exif_block_is_a_named_request() {
    let exif = b"II\x2a\x00\x08\x00\x00\x00\x00\x00";
    let metadata = RecipeMetadata {
        exif: Some(AuxRef {
            off: 0,
            len: exif.len(),
        }),
        ..Default::default()
    };
    let resolved = resolve_metadata(&metadata, &[], exif, false).unwrap();
    assert_eq!(resolved.exif.as_deref(), Some(&exif[..]));
    assert!(resolved.exif_requested);
}

#[test]
fn a_supplied_xmp_packet_is_a_named_request() {
    let xmp = br#"<x:xmpmeta xmlns:x="adobe:ns:meta/"/>"#;
    let metadata = RecipeMetadata {
        xmp: Some(AuxRef {
            off: 0,
            len: xmp.len(),
        }),
        ..Default::default()
    };
    let resolved = resolve_metadata(&metadata, &[], xmp, false).unwrap();
    assert_eq!(resolved.xmp.as_deref(), Some(&xmp[..]));
    assert!(resolved.xmp_requested);
}

#[test]
fn an_orientation_synthesised_exif_block_is_not_a_named_request() {
    // `withMetadata({orientation:5})` on a source with no EXIF at all
    // still produces a block to carry the value; that block is the
    // library's own, not the caller's, so it must not error on a container
    // whose encoder has no EXIF setter.
    let metadata = RecipeMetadata {
        keep: true,
        orientation: Some(5),
        ..Default::default()
    };
    let resolved = resolve_metadata(&metadata, &[], &[], false).unwrap();
    assert!(resolved.exif.is_some());
    assert!(!resolved.exif_requested);
}

#[test]
fn a_supplied_introduced_exif_block_is_canonicalised() {
    // `withExif(sharpMetadata.exif)` is the obvious thing to write, and
    // sharp hands out an `Exif\0\0`-introduced block for JPEG, WebP and
    // AVIF sources (#3507 final fix wave, item 3).
    let tiff = b"II\x2a\x00\x08\x00\x00\x00\x00\x00";
    let introduced = [b"Exif\0\0".as_slice(), tiff].concat();
    let metadata = RecipeMetadata {
        exif: Some(AuxRef {
            off: 0,
            len: introduced.len(),
        }),
        ..Default::default()
    };
    let resolved = resolve_metadata(&metadata, &[], &introduced, false).unwrap();
    assert_eq!(resolved.exif.as_deref(), Some(&tiff[..]));
}
