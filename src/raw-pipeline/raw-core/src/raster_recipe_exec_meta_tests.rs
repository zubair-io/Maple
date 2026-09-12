//! The metadata half of `raster_recipe_exec`'s tests (#3507): the recipe's
//! `metadata` block end to end — what `keep` sweeps up, what an explicit
//! `withExif`/`withIccProfile`/`withXmp`/`withMetadata` writes, which
//! containers refuse which field by name, and how `autoOrient` neutralises a
//! kept Orientation. Split out of `raster_recipe_exec_tests.rs` under the
//! 600-line hard file-size budget; `super` is `raster_recipe_exec`, same
//! `#[path]` sibling pattern that file already uses.

use super::*;
use crate::raster_recipe::parse_recipe;

fn run(json: &str, input: &[u8], aux: &[u8]) -> RecipeResult {
    run_recipe(&parse_recipe(json).unwrap(), input, aux).unwrap()
}

fn run_err(json: &str, input: &[u8], aux: &[u8]) -> crate::error::Error {
    run_recipe(&parse_recipe(json).unwrap(), input, aux).unwrap_err()
}

// ---- metadata (#3507) ----
//
// Every fixture below is a baseline JPEG from `crate::jpeg::encode` with an
// APP1 `Exif\0\0` and/or a single-chunk APP2 `ICC_PROFILE\0` segment
// hand-spliced in right after the SOI marker, mirroring the pattern
// `raster_meta_tests.rs`/`raster_recipe_meta.rs`'s own fixtures use.

const EXIF_TIFF: &[u8] = b"II\x2a\x00\x08\x00\x00\x00\x00\x00";

fn jpeg_source(icc: Option<&[u8]>, exif: Option<&[u8]>) -> Vec<u8> {
    let base = crate::jpeg::encode(4, 4, &vec![90u8; 4 * 4 * 3], 90).unwrap();
    let mut extra = Vec::new();
    if let Some(exif) = exif {
        let mut payload = b"Exif\0\0".to_vec();
        payload.extend_from_slice(exif);
        extra.push(0xFFu8);
        extra.push(0xE1);
        extra.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        extra.extend_from_slice(&payload);
    }
    if let Some(icc) = icc {
        let mut payload = b"ICC_PROFILE\0".to_vec();
        payload.push(1); // sequence
        payload.push(1); // count
        payload.extend_from_slice(icc);
        extra.push(0xFFu8);
        extra.push(0xE2);
        extra.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        extra.extend_from_slice(&payload);
    }
    let mut out = base[..2].to_vec();
    out.extend_from_slice(&extra);
    out.extend_from_slice(&base[2..]);
    out
}

fn p3_icc() -> Vec<u8> {
    crate::icc::profile_for(crate::view::encode::TargetPrimaries::P3)
}

#[test]
fn keep_metadata_copies_the_input_blocks_to_the_output() {
    let icc = p3_icc();
    let source = jpeg_source(Some(&icc), Some(EXIF_TIFF));
    let out = run(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[],
            "output":{"format":"jpeg","quality":85},
            "metadata":{"keep":true}}"#,
        &source,
        &[],
    );
    let found = crate::raster_meta::read_sidecars(&out.bytes);
    assert!(found.exif.is_some(), "EXIF was dropped");
    assert_eq!(found.icc.as_deref(), Some(icc.as_slice()));
}

#[test]
fn metadata_is_stripped_by_default() {
    let icc = p3_icc();
    let source = jpeg_source(Some(&icc), Some(EXIF_TIFF));
    let out = run(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[],"output":{"format":"jpeg","quality":85}}"#,
        &source,
        &[],
    );
    assert!(crate::raster_meta::read_sidecars(&out.bytes).exif.is_none());
}

#[test]
fn an_explicit_orientation_is_written_into_the_exif_block() {
    let source = jpeg_source(None, None);
    let out = run(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[],
            "output":{"format":"jpeg","quality":85},
            "metadata":{"orientation":6}}"#,
        &source,
        &[],
    );
    let found = crate::raster_meta::read_sidecars(&out.bytes);
    let orientation = found
        .exif
        .as_deref()
        .and_then(crate::raster::exif_orientation_from_block);
    assert_eq!(orientation, Some(6));
}

#[test]
fn a_supplied_icc_from_aux_is_embedded() {
    let icc = p3_icc();
    let recipe = format!(
        r#"{{"v":1,"input":{{"kind":"raw","width":8,"height":8,"channels":3}},"ops":[],
            "output":{{"format":"png"}},
            "metadata":{{"icc":{{"off":0,"len":{}}}}}}}"#,
        icc.len()
    );
    let out = run(&recipe, &vec![120u8; 8 * 8 * 3], &icc);
    assert_eq!(
        crate::raster_meta::read_sidecars(&out.bytes).icc.as_deref(),
        Some(icc.as_slice())
    );
}

#[test]
fn an_orientation_rewrite_survives_a_kept_exif_block() {
    let source = jpeg_source(None, Some(EXIF_TIFF));
    let out = run(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[],
            "output":{"format":"jpeg","quality":85},
            "metadata":{"keep":true,"orientation":8}}"#,
        &source,
        &[],
    );
    let found = crate::raster_meta::read_sidecars(&out.bytes);
    let orientation = found
        .exif
        .as_deref()
        .and_then(crate::raster::exif_orientation_from_block);
    assert_eq!(orientation, Some(8));
}

#[test]
fn metadata_survives_an_op_and_a_format_change() {
    // The input is a JPEG (can't carry alpha); the output is a resized
    // PNG. `keep` must still surface the JPEG's own EXIF/ICC in the PNG.
    let icc = p3_icc();
    let source = jpeg_source(Some(&icc), Some(EXIF_TIFF));
    let out = run(
        r#"{"v":1,"input":{"kind":"encoded"},
            "ops":[{"op":"resize","width":2,"height":2,"fit":"fill"}],
            "output":{"format":"png"},
            "metadata":{"keep":true}}"#,
        &source,
        &[],
    );
    let found = crate::raster_meta::read_sidecars(&out.bytes);
    assert!(found.exif.is_some(), "EXIF was dropped across the resize");
    assert_eq!(found.icc.as_deref(), Some(icc.as_slice()));
}

// ---- fix-round-1, item 1: unsupported-but-requested metadata errors ----

/// `avif`-gated: Maple's WebP encoder lives in the `raster_encode_avif`
/// module, so a WebP output is a named error without the feature (#3506 F6)
/// — the capability question this test is about only arises once there IS
/// an encoder to reach.
#[cfg(feature = "avif")]
#[test]
fn keep_with_no_xmp_in_the_input_is_fine_for_webp() {
    // "For keep: true, only fields that are actually PRESENT in the
    // input count as requested" — this JPEG source carries no XMP, so a
    // WebP output (which can't carry XMP at all) must still succeed.
    let icc = p3_icc();
    let source = jpeg_source(Some(&icc), Some(EXIF_TIFF));
    let out = run(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[],
            "output":{"format":"webp"},
            "metadata":{"keep":true}}"#,
        &source,
        &[],
    );
    assert_eq!(
        crate::raster_meta::read_sidecars(&out.bytes).icc.as_deref(),
        Some(icc.as_slice())
    );
}

#[test]
fn a_supplied_xmp_to_webp_is_a_named_error() {
    let xmp = b"<x:xmpmeta/>".to_vec();
    let err = run_err(
        &format!(
            r#"{{"v":1,"input":{{"kind":"encoded"}},"ops":[],
                "output":{{"format":"webp"}},
                "metadata":{{"xmp":{{"off":0,"len":{}}}}}}}"#,
            xmp.len()
        ),
        &jpeg_source(None, None),
        &xmp,
    );
    assert!(
        format!("{err}").contains("WebP cannot embed XMP"),
        "got: {err}"
    );
}

#[test]
fn a_density_request_to_tiff_is_a_named_error() {
    let err = run_err(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[],
            "output":{"format":"tiff"},
            "metadata":{"density":300.0}}"#,
        &jpeg_source(None, None),
        &[],
    );
    assert!(
        format!("{err}").contains("TIFF cannot embed a pixel density"),
        "got: {err}"
    );
}

#[test]
fn a_kept_exif_block_sent_to_tiff_is_dropped_silently() {
    // `keep` sweeps up every block the input carries, so holding the target
    // container to one the caller never named turned a call sharp completes
    // into an error naming a field nobody mentioned (#3507 final fix wave,
    // item 6; measured: sharp's own `keepMetadata().tiff()` on this shape
    // of source succeeds, writing ICC and XMP and no EXIF). The TIFF
    // encoder here has no EXIF setter at all, so the block is dropped.
    let out = run(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[],
            "output":{"format":"tiff"},
            "metadata":{"keep":true}}"#,
        &jpeg_source(None, Some(EXIF_TIFF)),
        &[],
    );
    assert!(crate::raster_meta::read_sidecars(&out.bytes).exif.is_none());
}

#[test]
fn an_explicitly_supplied_exif_block_sent_to_tiff_is_still_a_named_error() {
    let recipe = format!(
        r#"{{"v":1,"input":{{"kind":"encoded"}},"ops":[],
            "output":{{"format":"tiff"}},
            "metadata":{{"exif":{{"off":0,"len":{}}}}}}}"#,
        EXIF_TIFF.len()
    );
    let err = run_err(&recipe, &jpeg_source(None, None), EXIF_TIFF);
    assert!(
        format!("{err}").contains("TIFF cannot embed EXIF"),
        "got: {err}"
    );
}

#[test]
fn an_orientation_only_metadata_block_reaches_tiff_without_erroring() {
    // `withMetadata({orientation:5})` synthesises an EXIF block to carry
    // the value, which is not a named EXIF request either — sharp writes
    // the orientation into the TIFF's own IFD and succeeds, so erroring
    // here would fail a call that works everywhere else.
    let out = run(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[],
            "output":{"format":"tiff"},
            "metadata":{"keep":true,"orientation":5}}"#,
        &jpeg_source(None, Some(EXIF_TIFF)),
        &[],
    );
    assert!(!out.bytes.is_empty());
}

// ---- fix-round-1, item 3: autoOrient neutralises a kept Orientation ----

/// A JPEG with `exif` spliced in, mirroring `jpeg_source` but with a
/// non-empty pixel grid so a 90-degree autoOrient rotation is visible.
fn oriented_jpeg_source(width: u32, height: u32, exif: &[u8]) -> Vec<u8> {
    let base = crate::jpeg::encode(
        width,
        height,
        &vec![90u8; (width * height * 3) as usize],
        90,
    )
    .unwrap();
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

/// A minimal IFD0 with a single Orientation entry set to `value`.
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
fn auto_orient_neutralises_a_kept_orientation_end_to_end() {
    // Measured against sharp: sharp(oriented6).rotate().withMetadata()
    // .jpeg() -> metadata().orientation === 1 (not undefined — the EXIF
    // block itself survives).
    let source = oriented_jpeg_source(8, 4, &exif_with_orientation(6));
    let out = run(
        r#"{"v":1,"input":{"kind":"encoded"},
            "ops":[{"op":"autoOrient"}],
            "output":{"format":"jpeg","quality":85},
            "metadata":{"keep":true}}"#,
        &source,
        &[],
    );
    let found = crate::raster_meta::read_sidecars(&out.bytes);
    assert!(found.exif.is_some(), "the EXIF block itself must survive");
    let orientation = found
        .exif
        .as_deref()
        .and_then(crate::raster::exif_orientation_from_block);
    assert_eq!(orientation, Some(1));
    // A 90-degree rotation (Orientation 6) really did run: the pixel
    // dimensions are swapped from the source's own 8x4.
    assert_eq!((out.width, out.height), (4, 8));
}

#[test]
fn an_explicit_orientation_still_wins_after_auto_orient_end_to_end() {
    // Measured: sharp(oriented6).rotate().withMetadata({orientation:6})
    // .jpeg() -> metadata().orientation === 6.
    let source = oriented_jpeg_source(8, 4, &exif_with_orientation(6));
    let out = run(
        r#"{"v":1,"input":{"kind":"encoded"},
            "ops":[{"op":"autoOrient"}],
            "output":{"format":"jpeg","quality":85},
            "metadata":{"keep":true,"orientation":6}}"#,
        &source,
        &[],
    );
    let found = crate::raster_meta::read_sidecars(&out.bytes);
    let orientation = found
        .exif
        .as_deref()
        .and_then(crate::raster::exif_orientation_from_block);
    assert_eq!(orientation, Some(6));
}

// ---- fix-round-2: keep's default-fill ICC is not a "request" on AVIF ----

#[cfg(feature = "avif")]
#[test]
fn keep_with_no_input_icc_succeeds_on_avif_with_no_icc_embedded() {
    // Ruling: the sRGB default-fill `keep: true` adds when the input has no
    // ICC is a convenience, not a caller request — on AVIF (which this
    // crate's encoder can't tag with ICC at all, #3580) that default must be
    // skipped silently, matching sharp: keep-metadata on a no-ICC source
    // converted to AVIF still succeeds.
    let source = jpeg_source(None, None); // no ICC in the input at all
    let out = run(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[],
            "output":{"format":"avif","quality":60,"effort":8},
            "metadata":{"keep":true}}"#,
        &source,
        &[],
    );
    assert!(
        crate::raster_meta::read_sidecars(&out.bytes).icc.is_none(),
        "AVIF has no ICC box to read back — the default fill must not have \
         been forced in some other way"
    );
}

/// `avif`-gated: without the feature `output_from_wire` rejects an AVIF
/// output before the capability gate ever runs (#3506 F5), so the error
/// names the missing feature rather than the ICC box.
#[cfg(feature = "avif")]
#[test]
fn keep_with_a_real_input_icc_to_avif_drops_it_silently() {
    // Swept up by `keep`, not named by the caller — so on AVIF (which this
    // crate's encoder can't tag with ICC at all, #3580) it goes the same
    // way as the default fill above: dropped, not an error. sharp's own
    // `keepMetadata().avif()` on this source succeeds (#3507 final fix
    // wave, item 6).
    let icc = p3_icc();
    let source = jpeg_source(Some(&icc), None);
    let out = run(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[],
            "output":{"format":"avif","quality":60,"effort":8},
            "metadata":{"keep":true}}"#,
        &source,
        &[],
    );
    assert!(crate::raster_meta::read_sidecars(&out.bytes).icc.is_none());
}

/// `avif`-gated: without the feature `output_from_wire` rejects an AVIF
/// output before the capability gate ever runs (#3506 F5), so the error
/// names the missing feature rather than the ICC box.
#[cfg(feature = "avif")]
#[test]
fn an_explicit_icc_to_avif_is_a_named_error() {
    let icc = p3_icc();
    let source = jpeg_source(None, None);
    let recipe = format!(
        r#"{{"v":1,"input":{{"kind":"encoded"}},"ops":[],
            "output":{{"format":"avif","quality":60,"effort":8}},
            "metadata":{{"icc":{{"off":0,"len":{}}}}}}}"#,
        icc.len()
    );
    let err = run_err(&recipe, &source, &icc);
    assert!(
        format!("{err}").contains("AVIF cannot embed an ICC profile"),
        "got: {err}"
    );
}

// ---- the ICC precedence (#3507, ruled) ----

/// `keep` carries the input's own profile — but only while the samples are
/// still in the space that profile describes. A `toColourspace` that moved
/// them outranks it, or a colour-managed reader renders Display P3 pixels
/// through the source's sRGB profile.
#[test]
fn a_to_colourspace_rotation_outranks_keeps_input_profile() {
    let srgb = crate::icc::profile_for(crate::view::encode::TargetPrimaries::Srgb);
    let p3 = crate::icc::profile_for(crate::view::encode::TargetPrimaries::P3);
    let source = jpeg_source(Some(&srgb), None);

    let rotated = run(
        r#"{"v":1,"input":{"kind":"encoded"},
            "ops":[{"op":"toColourspace","space":"display-p3"}],
            "output":{"format":"png"},
            "metadata":{"keep":true}}"#,
        &source,
        &[],
    );
    assert_eq!(
        crate::raster_meta::read_sidecars(&rotated.bytes)
            .icc
            .as_deref(),
        Some(p3.as_slice()),
        "a rotated output kept the INPUT's sRGB profile over its own P3 samples"
    );

    // No rotation: `keep` carries the input's profile through, as before.
    let plain = run(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[],
            "output":{"format":"png"},
            "metadata":{"keep":true}}"#,
        &source,
        &[],
    );
    assert_eq!(
        crate::raster_meta::read_sidecars(&plain.bytes)
            .icc
            .as_deref(),
        Some(srgb.as_slice())
    );
}

/// An explicit `withIccProfile` still outranks the rotation profile — it is
/// the caller's own instruction, and (for a named one) it rotates the pixels
/// itself. Here the named profile and the op disagree: `iccName` wins, and
/// the pixels end up in the space it names.
#[test]
fn an_explicit_profile_outranks_the_rotation_profile() {
    let srgb = crate::icc::profile_for(crate::view::encode::TargetPrimaries::Srgb);
    let out = run(
        r#"{"v":1,"input":{"kind":"encoded"},
            "ops":[{"op":"toColourspace","space":"display-p3"}],
            "output":{"format":"png"},
            "metadata":{"iccName":"srgb"}}"#,
        &jpeg_source(None, None),
        &[],
    );
    assert_eq!(
        crate::raster_meta::read_sidecars(&out.bytes).icc.as_deref(),
        Some(srgb.as_slice())
    );
}

// ---- reconciliation with #3503: keep's fill follows the output primaries ----

/// `keepMetadata()`/`withMetadata()` fill in a profile when the input
/// carried none. That fill has to follow the primaries the recipe actually
/// rotated into, or `.toColourspace('display-p3').withMetadata()` labels
/// Display P3 samples as sRGB — the exact mislabelling
/// `withIccProfile('p3')` used to be a named error to avoid.
#[test]
fn keeps_fill_profile_follows_a_to_colourspace_rotation() {
    let source = jpeg_source(None, None);
    let p3 = run(
        r#"{"v":1,"input":{"kind":"encoded"},
            "ops":[{"op":"toColourspace","space":"display-p3"}],
            "output":{"format":"png"},
            "metadata":{"keep":true}}"#,
        &source,
        &[],
    );
    let embedded = crate::raster_meta::read_sidecars(&p3.bytes).icc.unwrap();
    assert_eq!(
        embedded,
        crate::icc::profile_for(crate::view::encode::TargetPrimaries::P3),
        "keep's fill tagged the P3 output with something other than the P3 profile"
    );

    // No rotation: the fill is still sRGB, which is what sharp writes.
    let srgb = run(
        r#"{"v":1,"input":{"kind":"encoded"},"ops":[],
            "output":{"format":"png"},
            "metadata":{"keep":true}}"#,
        &source,
        &[],
    );
    assert_eq!(
        crate::raster_meta::read_sidecars(&srgb.bytes)
            .icc
            .as_deref(),
        Some(crate::icc::profile_for(crate::view::encode::TargetPrimaries::Srgb).as_slice())
    );
}
